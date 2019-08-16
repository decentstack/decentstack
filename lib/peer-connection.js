const { EventEmitter } = require('events')
const assert = require('assert')
const protocol = require('hypercore-protocol')
const hypercore = require('hypercore')
const eos = require('end-of-stream')
const pump = require('pump')
const debugFactory = require('debug')
const { assertCore } = require('./util')
const { Exchange } = require('./messages')
const substream = require('hypercore-protocol-substream')

const {
  STATE_INIT,
  STATE_ACTIVE,
  STATE_DEAD,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT,
  EXCHANGE
} = require('./constants')

class PeerConnection extends EventEmitter {
  constructor (encryptionKey, opts) {
    super()
    this.state = STATE_INIT
    this.__mctr = 0
    this.opts = opts || {}
    this.useVirtual = !opts.noVirtual
    this.activeVirtual = []
    this.encryptionKey = encryptionKey
    this.stream = protocol(opts)
    this.virtualFeed = this.stream.feed(this.encryptionKey)
    this.debug = debugFactory(`replic8/${this.shortid}`)
    this.debug('Initializing new PeerConnection, live:', this.opts.live)

    // Pre-bind our listeners before registering them, to be able to safely remove them
    this._onRemoteFeedJoined = this._onRemoteFeedJoined.bind(this)
    this._onHandshake = this._onHandshake.bind(this)
    this._onExt = this._onExt.bind(this)
    this.kill = this.kill.bind(this)
    this._prefinalize = this._prefinalize.bind(this)

    this.stream.once('handshake', this._onHandshake)
    this.stream.on('feed', this._onRemoteFeedJoined)
    this.virtualFeed.on('extension', this._onExt)
    if (this.opts.live) this.stream.on('prefinalize', this._prefinalize)

    // namespaced arrays
    this.offeredKeys = {}
    this.requestedKeys = {}
    this.remoteOfferedKeys = {}

    eos(this.stream, this.kill)
  }

  get id () {
    return this.stream.id
  }
  get shortid () {
    return this.stream.id.hexSlice(0, 4)
  }

  /*
   * Used to detect if non-negotiated feeds enter the stream
   * Each peer allows offered-keys, requested-keys and the exchange-key
   * to be replicated on the stream
   */
  get allowedKeys () {
    return Object.keys(this.allowedKeysNS)
  }
  get allowedKeysNS () {
    const m = {}
    m[this.virtualFeed.key.hexSlice()] = null

    Object.keys(this.offeredKeys).forEach(ns => {
      this.offeredKeys[ns].forEach(k => { m[k] = ns })
    })
    Object.keys(this.requestedKeys).forEach(ns => {
      this.requestedKeys[ns].forEach(k => { m[k] = ns })
    })
    return m
  }

  _onHandshake () {
    const { remoteId, remoteUserData, remoteLive } = this.stream
    this.debug(`Handshake from ${remoteId.hexSlice(0, 6)}`)
    try {
      this.userData = JSON.parse(remoteUserData.toString('utf8'))
      const { dialect } = this.userData
      if (!dialect) throw new Error('Remote is not an exchange')

      const [, remoteScheme, remoteMajor] = dialect.match(/^([^:]+):(\d+)\./)
      const [, localScheme, localMajor] = PROTOCOL_VERSION.match(/^([^:]+):(\d+)\./)
      if (remoteScheme !== localScheme && remoteMajor === localMajor) {
        throw new Error(`Incompatible dialect ${dialect}`)
      }

      // I think if one end is not live then the other end should turn it off as well.
      // TODO: test this
      if (this.stream.live !== remoteLive) {
        console.warn(`'live' flag mismatch, local(${this.stream.live}) !== remote(${remoteLive})`)
        if (this.stream.live) this.stream.live = false // Turn off live; TODO: verify if this works
      }

      this._transition(STATE_ACTIVE)
    } catch (err) {
      this.debug('Handshake failed, closing connection', err)
      this.kill(err)
    }
  }

  _transition (newState, err = null) {
    // We only have 3 states, and none of the transitions
    // loop back on themselves
    if (newState === this.state) return console.warn('Connection already in state', newState, err)

    const prevState = this.state
    this.state = newState
    this.emit('state-change', newState, prevState, err, this)
    switch (this.state) {
      case STATE_DEAD:
        this.emit('end', err, this)
        break
      case STATE_ACTIVE:
        this.emit('connected', null, this)
        break
    }
  }

  /*
   * this is our errorHandler + peer-cleanup
   * calling it without an error implies a natural disconnection.
   */
  kill (err = null) {
    // If stream is alive, destroy it and wait for eos to invoke kill(err) again
    // this prevents some post-mortem error reports.
    if (!this.stream.destroyed) return this.stream.destroy(err)

    // Report other post-mortem on console as the manager
    // will already have removed it's listeners from this connection,
    // it's better than loosing them.
    if (this.state === STATE_DEAD) {
      if (err) console.error('Dead peer-connection received error:\n', this.shortid, err)
      return
    }

    this.debug('Killed:', err)
    // TODO: CLEAN UP ALL LISTENERS
    this.stream.off('feed', this._onRemoteFeedJoined)
    this.virtualFeed.off('extension', this._onExt)
    this.stream.off('prefinalize', this._prefinalize)

    // Save error for post mortem debugging
    this.lastError = err

    // Notify the manager that this PeerConnection died.
    this._transition(STATE_DEAD, err)
  }

  _onRemoteFeedJoined (discoveryKey) {
    this.debug('remote replicates discKey', discoveryKey.hexSlice(0, 6))
    // Give both ends to some time to finish feed negotiations,
    // if feed is not accepted by the time the timeout triggers
    // then we have an 'unwanted feed' in our stream.
    setTimeout(() => {
      const feedKey = this.allowedKeys.find(feedKey => {
        return hypercore.discoveryKey(Buffer.from(feedKey, 'hex'))
          .equals(discoveryKey)
      })
      if (feedKey && !this.encryptionKey.equals(Buffer.from(feedKey, 'hex'))) {
        // don't emit the exchange key as a feed event
        this.emit('feed', feedKey, this)
      } else if (!feedKey) {
        // I'd like to keep track of all feeds, but truth is that there is no
        // way to link sub-cores to their original composite cores.
        // So until we get some changes in hypercore/protocol we're not going
        // to be able to drop peers that share unknown feeds.
        // this.debug('Unknown feed encountered in stream, dkey:', discoveryKey.hexSlice(0, 6))
        this.kill(new Error(`UnknownFeedError, identification timed out: ${discoveryKey.hexSlice()}`))
      }
    }, REQUEST_TIMEOUT)
  }

  sendManifest (namespace, manifest, cb) {
    const mid = ++this.__mctr
    // Save which keys were offered on this connection
    this.offeredKeys[namespace] = this.offeredKeys[namespace] || []
    manifest.keys.forEach(k => {
      if (this.offeredKeys[namespace].indexOf(k) === -1) {
        this.offeredKeys[namespace].push(k)
      }
    })

    const bin = Exchange.encode({
      manifest: {
        namespace,
        id: mid,
        feeds: manifest.keys.map((key, n) => {
          const meta = manifest.meta[n]
          return {
            key: Buffer.from(key, 'hex'),
            headers: Object.keys(meta).map(k => {
              return {
                key: k,
                value: JSON.stringify(meta[k])
              }
            })
          }
        })
      }
    })

    if (typeof cb === 'function') {
      const evName = `manifest-${mid}`
      // TODO: using a promise here might be cleaner
      let triggered = false
      const race = (err, f) => {
        if (!triggered) {
          triggered = true
          cb(err, f)
        }
      }
      this.once(evName, race)
      setTimeout(() => {
        this.off(evName, race)
        race(new ManifestResponseTimedOutError())
      }, REQUEST_TIMEOUT)
    }

    this.debug(`manifest#${mid} sent with ${manifest.keys.length} keys`)
    this.virtualFeed.extension(EXCHANGE, bin)
  }

  sendRequest (namespace, keys, manifestId, cb) {
    this.requestedKeys[namespace] = this.requestedKeys[namespace] || []
    keys.forEach(k => {
      if (this.requestedKeys[namespace].indexOf(k) === -1) {
        this.requestedKeys[namespace].push(k)
      }
    })

    const bin = Exchange.encode({
      req: {
        namespace,
        manifest_id: manifestId,
        keys: keys.map(k => Buffer.from(k, 'hex'))
      }
    })
    this.virtualFeed.extension(EXCHANGE, bin)
    // TODO: start replicating
  }

  _onExt (type, message) {
    if (type !== EXCHANGE) return // Message is not meant for us.
    try {
      const msg = Exchange.decode(message)

      if (msg.manifest) {
        const m = {
          id: msg.manifest.id,
          namespace: msg.manifest.namespace,
          keys: msg.manifest.feeds.map(f => f.key.hexSlice()),
          headers: {}
        }
        this.remoteOfferedKeys[m.namespace] = this.remoteOfferedKeys[m.namespace] || []
        msg.manifest.feeds.forEach(f => {
          const key = f.key.hexSlice()

          if (this.remoteOfferedKeys[m.namespace].indexOf(key) === -1) {
            this.remoteOfferedKeys[m.namespace].push(key)
          }

          const meta = {}
          f.headers.forEach(kv => {
            meta[kv.key] = JSON.parse(kv.value)
          })
          m.headers[key] = meta
        })
        this.debug(`Received manifest #${m.id}`)
        this.emit('manifest', m, this)
      } else if (msg.req) {
        const req = msg.req

        // Fullfill any internal promises
        const evName = `manifest-${req.manifest_id}`
        if (req.manifest_id && this.listeners(evName).length) {
          this.emit(evName, null, req.keys)
        }
        this.debug(`Received replication request for ${req.keys.length} feeds`)
        // Forward event upwards
        this.emit('replicate', req, this)
      } else {
        throw new Error(`Unhandled Exchange message: ${Object.keys(msg).join(',')}`)
      }
    } catch (err) {
      this.kill(err)
    }
  }

  get activeFeeds () {
    return [...this.stream.feeds, ...this.activeVirtual]
  }

  get activeKeys () {
    return this.activeFeeds.map(f => f.key.hexSlice())
  }

  isActive (key) {
    if (typeof key === 'string') key = Buffer.from(key, 'hex')
    assert(Buffer.isBuffer(key), 'Key must be a string or a buffer')
    return !!this.activeFeeds.find(f => f.key.equals(key))
  }
  // Expects feeds to be 'ready' when invoked
  joinFeed (feed, cb) {
    assertCore(feed)
    if (this.isActive(feed.key)) {
      debugger
      return cb(new Error('Feed is already being replicated'))
    }

    // Expected feeds do not work as expected, it's a buggy business without a
    // solution to properly detecting when a 'composite-core' has finished
    // replicating it's sub-feeds.
    // Hyperdrive v10 w/ Corestore seems to corrupt the main stream (needs
    // inspection)
    // So as a generic workaround we're implementing virtual-streams
    // to let each feed have it's entierly own stream and boostrap it's own encryption.
    if (this.useVirtual) {
      const virtualStream = substream(this.virtualFeed, feed.key, (err, vs) => {
        if (err) return cb(err)
        this.emit('feed', feed.key.hexSlice(), this) // forward feed to other connections
        cb(null, vs)
      })
      // Absence of virtualStream indicates that error was thrown and
      // it failed to establish.
      if (!virtualStream) return
      this.activeVirtual.push(feed)

      const coreStream = feed.replicate(Object.assign({}, {
        live: this.stream.live
        // encrypt: this.stream.encrypted
        // TODO: how do these opts work?
        // download: self._opts.download
        // upload: self._opts.upload,
      }))

      this.stream.expectedFeeds++
      this.debug('replicating feed:', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))

      pump(coreStream, virtualStream, coreStream, err => {
        // if (err) this.kill(err) // Kills the peer if a substream fails
        if (err) console.error(err)
        this.debug('feed finished', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))
        this.activeVirtual.splice(this.activeVirtual.indexOf(feed), 1) // remove from virtual active
        // If not live, close peer connection when all subsstreams are destroyed
        if (!this.stream.live && !this.activeVirtual.length) this.stream.finalize()
      })
    } else {
      let subFeeds = 1

      const stream = this.stream
      feed.replicate(Object.assign({}, {
        live: this.stream.live,
        encrypt: this.stream.encrypted,
        stream
        // TODO: how do these opts work?
        // download: self._opts.download
        // upload: self._opts.upload,
      }))

      this.stream.expectedFeeds += subFeeds
      this.debug('replicating feed:', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))
    }
  }

  // Prevents the exchange-channel from being closed
  // when feeds finish during live. I think... TODO: verify
  _prefinalize (cb) {
    this.debug('prefinalize received: ', this.stream.expectedFeeds)
    cb()
  }
}

module.exports = PeerConnection

class ManifestResponseTimedOutError extends Error {
  constructor (msg = 'timeout while waiting for request after manifest', ...params) {
    super(msg, ...params)
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) Error.captureStackTrace(this, ManifestResponseTimedOutError)

    this.name = this.type = 'ManifestResponseTimedOutError'
  }
}
