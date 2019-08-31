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
  VERSION,
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

    // userdata intentionally serialized as plain json so that any client
    // can read it without depending on our protobuf schema
    // Only gotcha is that the string MUST be utf-8 encoded.
    const udata = Object.assign({
      client: 'REPLIC8',
      dialect: PROTOCOL_VERSION,
      version: VERSION
    }, opts.userData)
    this.opts.userData = Buffer.from(JSON.stringify(udata), 'utf8')

    this.stream = protocol(this.opts)
    this.virtualFeed = this.stream.feed(Buffer.from(this.encryptionKey))
    this.debug = debugFactory(`replic8/${this.shortid}`)
    this.debug('Initializing new PeerConnection, live:', this.opts.live, '\nextensions:', this.opts.extensions)

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

  // Forward extension to virtual feed.
  extension (...args) {
    this.virtualFeed.extension(...args)
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

    // Log error if no 'state-change' listeners available to handle it.
    if (err && !this.listeners('state-change').length) {
      console.error('PeerConnection received error during `state-change` event, but no there are no registered handlers for it!\n', err)
    }

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
    // Report other post-mortem on console as the manager
    // will already have removed it's listeners from this connection,
    // logging is better than silent failure
    if (this.state === STATE_DEAD) {
      if (err) console.warning('Warning kill() invoked on dead peer-connection\n', this.shortid, err)
      return
    }

    const cleanup = () => {
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

    // If stream is alive, destroy it and wait for eos to invoke kill(err) again
    // this prevents some post-mortem error reports.
    if (!this.stream.destroyed) {
      if (err) {
        // Destroy with error
        this.stream.destroy(err)
      } else {
        // wait for stream to flush before cleanup
        this.stream.end(null, cleanup)
      }
    } else cleanup() // Perform cleanup now.
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
    // Ignore message if not meant for us.
    if (type !== EXCHANGE) return

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
      // Immediately register feed as active
      this.activeVirtual.push(feed)
      this.stream.expectedFeeds++

      const cleanUp = () => {
        this.activeVirtual.splice(this.activeVirtual.indexOf(feed), 1) // remove from virtual active
        // Detect if peer connection should be finalized.
        // If not live, close peer connection when all subsstreams are destroyed
        if (!this.stream.live && !this.activeVirtual.length) {
          this.debug('Replication complete detected, dropping peer')
          this.stream.finalize()
        }
      }

      // initialize substream
      substream(this.virtualFeed, feed.key, (err, virtualStream) => {
        if (err) {
          cleanUp()
          return cb(err)
        }

        const coreStream = feed.replicate(Object.assign({}, {
          live: this.stream.live
          // encrypt: this.stream.encrypted
          // TODO: forward more opts.
        }))

        this.debug('replicating feed:', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))

        // connect the streams and attach error/finalization handler.
        pump(coreStream, virtualStream, coreStream, err => {
          // if (err) this.kill(err) // Kills the peer if a substream fails
          if (err) console.error(err)
          this.debug('feed finished', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))
          cleanUp()
        })

        // notify manager that a new feed is replicated here,
        // The manager will forward this event other connections that not
        // yet have this feed listed in their knownFeeds
        this.emit('feed', feed.key.hexSlice(), this)
        return cb(null, virtualStream)
      })
    } else { // Leaving the old non virtual implementation here just in case.
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
      return cb(null, stream)
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
