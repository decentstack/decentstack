const { EventEmitter } = require('events')
const assert = require('assert')
const protocol = require('hypercore-protocol')
const hypercore = require('hypercore')
const eos = require('end-of-stream')
const debugFactory = require('debug')
const { Exchange } = require('./messages')

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
    this.opts = opts
    this.encryptionKey = encryptionKey
    this.stream = protocol(opts)
    this.virtualFeed = this.stream.feed(this.encryptionKey)
    this.debug = debugFactory(`replic8/${this.shortid}`)

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

    this.offeredKeys = []
    this.requestedKeys = []
    this.remoteOfferedKeys = []

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
   * Each peer allows offered-keys, requested-kes and the exchange-key
   */
  get allowedKeys () {
    const m = {}
    m[this.virtualFeed.key.hexSlice()] = true
    this.offeredKeys.forEach(k => { m[k] = true })
    this.requestedKeys.forEach(k => { m[k] = true })
    return Object.keys(m)
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
      if (this.stream.live === !this.remoteLive) {
        console.warn(`'live' flag mismatch, local(${this.stream.live}) !== remote(${remoteLive})`)
        if (this.stream.live) this.stream.live = false // Turn off live
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
    if (newState === this.state) return

    const prevState = this.state
    this.state = newState
    this.emit('state-change', newState, prevState, err, this)
  }

  /*
   * this is our errorHandler + peer-cleanup
   * calling it without an error implies a natural disconnection.
   */
  kill (err = null) {
    // TODO: CLEAN UP ALL LISTENERS
    this.stream.off('feed', this._onRemoteFeedJoined)
    this.virtualFeed.off('extension', this._onExt)
    this.stream.off('prefinalize', this._prefinalize)
    this.lastError = err
    // Notify the manager that this PeerConnection died.
    this._transition(STATE_DEAD, err)
  }

  _onRemoteFeedJoined (discoveryKey) {
    this.debug('remote replicates discKey', discoveryKey.hexSlice(0, 6))

    // standard swedish debate strategy
    setTimeout(() => {
      const feed = this.allowedKeys.map(k => hypercore.discoveryKey(Buffer.from(k, 'hex'))).find(d => d.equals(discoveryKey))
      if (!feed) {
        // debugger // TODO: this is a bug no need for timeout, 'requested' keys is a list of accepted topics
        this.kill(new Error(`UnknownFeedError, identification timed out`))
      }
    }, REQUEST_TIMEOUT)
  }

  sendManifest (namespace, manifest, cb) {
    const mid = ++this.__mctr

    // Save which keys were offered on this connection
    manifest.keys.forEach(k => {
      if (this.offeredKeys.indexOf(k) === -1) {
        this.offeredKeys.push(k)
      }
    })

    const bin = Exchange.encode({
      manifest: {
        namespace,
        id: mid,
        feeds: manifest.keys.map(key => {
          const meta = manifest.meta[key]
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
        race(new Error('RequestTimedOut'))
      }, REQUEST_TIMEOUT)
    }

    this.debug(`manifest#${mid} sent with ${manifest.keys.length} keys`)
    this.virtualFeed.extension(EXCHANGE, bin)
  }

  sendRequest (namespace, keys, manifestId, cb) {
    keys.forEach(k => {
      if (this.requestedKeys.indexOf(k) === -1) {
        this.requestedKeys.push(k)
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
        msg.manifest.feeds.forEach(f => {
          const key = f.key.hexSlice()

          if (this.remoteOfferedKeys.indexOf(key) === -1) {
            this.remoteOfferedKeys.push(key)
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
    return this.stream.feeds
  }

  get activeKeys () {
    return this.activeFeeds.map(f => f.key.hexSlice())
  }

  // Expects feeds to be 'ready' when invoked
  joinFeed (feed, cb) {
    assertReplicatable(feed)
    if (this.activeFeeds.find(f => f.key.equals(feed.key))) {
      return cb(new Error('Feed is already being replicated'))
    }
    var fstream = feed.replicate(Object.assign({}, {
      live: this.stream.live,
      encrypt: this.stream.encrypted,
      stream: this.stream
      // TODO: how do these opts work?
      // download: self._opts.download
      // upload: self._opts.upload,
    }))
    this.stream.expectedFeeds++
    this.debug('replicating feed:', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))

    eos(fstream, err => {
      if (err) return this.kill(err) // disconnects the peer not the feed-stream
      this.debug('feed finished', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))
    })
  }

  // TODO: support unweave/splicing a feed from the stream
  // without closing it.

  // Prevents the exchange-channel from being closed
  // when feeds finish during live. I think... TODO: verify
  _prefinalize (cb) {
    this.debug('prefinalize received: ', this.stream.expectedFeeds)
    debugger
    cb()
  }
}

module.exports = PeerConnection

// Since this entire project relies on ducktyping,
// assert that the functionality necessary for replication managment is available
// and that the core 'looks' ready.
function assertReplicatable (f) {
  // Conditions (SUBJECT TO CHANGE)
  if (!f) debugger
  assert.ok(f, `This is not a core`)
  assert.strict.equal(typeof f.ready, 'function', `A core must respond to '.ready()'`)
  assert.strict.equal(typeof f.replicate, 'function', `A core must respond to '.replicate()'`)
  assert.ok(Buffer.isBuffer(f.key), `Core is not ready or does not have a '.key'`)
  assert.ok(Buffer.isBuffer(f.discoveryKey), `Core is not ready or does not have a '.discoveryKey'`)
  return f
}
module.exports.assertReplicatable = assertReplicatable
