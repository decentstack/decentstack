const { EventEmitter } = require('events')
const assert = require('assert')
const Protocol = require('hypercore-protocol')
const eos = require('end-of-stream')
const pump = require('pump')
const debugFactory = require('debug')
const { assertCore } = require('./util')
const { Exchange } = require('./messages')
const substream = require('hypercore-protocol-substream')
const { h32 } = require('xxhashjs')
const {
  STATE_INIT,
  STATE_ACTIVE,
  STATE_DEAD,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT,
  EXCHANGE
} = require('./constants')

class PeerConnection extends EventEmitter {
  constructor (initiator, exchangeKey, opts = {}) {
    super()
    assert(typeof initiator === 'boolean', 'First argument `initiator` must be a boolean!')
    assert(typeof exchangeKey === 'string' || Buffer.isBuffer(exchangeKey), 'Second arg `exchangeKey` must be a string or buffer')
    this._id = Buffer.from(Array.from(new Array(6)).map(() => Math.floor(256 * Math.random())))
    this.initiator = initiator
    this.state = STATE_INIT
    this.__mctr = 0
    this.opts = opts || {}
    this.useVirtual = !opts.noVirtual && false // Disabled for now.
    this.activeVirtual = []
    this._rextlut = {}
    if (typeof exchangeKey === 'string') exchangeKey = Buffer.from(exchangeKey, 'hex')

    // TODO: this.exchangeKey = hash(inputKey + 'ex:v1' + PROTOCOL_VERSION)
    this.exchangeKey = exchangeKey

    // Pre-bind our listeners before registering them, to be able to safely remove them
    this.kill = this.kill.bind(this)

    this.stream = new Protocol(initiator, {
      onhandshake: this._onHandshake.bind(this),
      ondiscoverykey: this._onChannelOpened.bind(this),
      onchannelclose: this._onChannelClosed.bind(this)
    })

    /*
    const emit = this.stream.emit
    this.stream.emit = (...args) => {
      this.debug('STREAM EVENT:', ...args)
      emit.apply(this.stream, args)
    }*/

    this.exchangeChannel = this.stream.open(this.exchangeKey, {
      onextension: this._onExtension.bind(this),
      onopen: () => {
        this.debug('Exchange Channel opened')
        if (!this.stream.remoteVerified(this.exchangeKey)) throw new Error('open and unverified')
        this._transition(STATE_ACTIVE)
      },
      onclose: () => {
        this.debug('Exchange Channel closed')
      }
    })

    this.debug = debugFactory(`replic8/${this.shortid}`)

    // Register pre-announced extensions in the
    // reverse extension lookup table.
    this.opts.extensions.forEach(e => {
      this._rextlut[fastHash(e)] = e
    })

    delete this.opts.extensions
    this.debug(`Initializing new PeerConnection(${this.initiator}) extensions:`, this._rextlut)

    // namespaced arrays
    this.offeredKeys = {}
    this.requestedKeys = {}
    this.remoteOfferedKeys = {}
    eos(this.stream, this.kill)
  }

  get id () {
    return this._id
  }

  get shortid () {
    return this._id.hexSlice(0, 4)
  }

  /* TODO: Shouldn't be needed anymore
   * Used to detect if non-negotiated feeds enter the stream
   * Each peer allows offered-keys, requested-keys and the exchange-key
   * to be replicated on the stream
   */
  get allowedKeys () {
    return Object.keys(this.allowedKeysNS)
  }
  get allowedKeysNS () {
    const m = {}
    m[this.exchangeChannel.key.hexSlice()] = null

    Object.keys(this.offeredKeys).forEach(ns => {
      this.offeredKeys[ns].forEach(k => { m[k] = ns })
    })
    Object.keys(this.requestedKeys).forEach(ns => {
      this.requestedKeys[ns].forEach(k => { m[k] = ns })
    })
    return m
  }

  // Forward extension to virtual feed.
  extension (name, ...args) {
    const id = fastHash(name)
    // Register new extensions dynamically
    if (!this._rextlut[id]) this._rextlut[id] = name
    this.exchangeChannel.extension(id, ...args)
  }

  _onHandshake () {
    this.debug(`Handshake from`)
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
        // wedge the stream. released in kill()#cleanup()
        if (this.opts.live) this.stream.prefinalize.wait()
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
      this.debug('cleanup:', err)
      if (this.opts.live) this.stream.prefinalize.continue()
      this.exchangeChannel.close()

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
        this.stream.once('finish', cleanup)
        this.debug('invoke end & schedule cleanup')
        this.stream.end(null)
      }
    } else cleanup() // Perform cleanup now.
  }

  _onChannelOpened (discoveryKey) {
    // console.log('_onChannelOpened', arguments)
    // const verified = this.stream.remoteVerified(discoveryKey)
    this.debug('remote replicates discKey', discoveryKey.hexSlice(0, 6))

    return // don't below code is needed anymore. It's built into hypercore-proto now.
    // Give both ends to some time to finish feed negotiations,
    // if feed is not accepted by the time the timeout triggers
    // then we have an 'unwanted feed' in our stream.
    setTimeout(() => {
      const feedKey = this.allowedKeys.find(feedKey => {
        return discoveryKey(Buffer.from(feedKey, 'hex'))
          .equals(discoveryKey)
      })
      if (feedKey && !this.exchangeKey.equals(Buffer.from(feedKey, 'hex'))) {
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

  _onChannelClosed (dk, pk) {
    this._c = this._c || 0
    this.debug('closing channel', ++this._c, dk.hexSlice(0, 6), pk && pk.hexSlice(0, 6))
    // INFO: this is not entierly rational, but should be somewhat safe.
    // If live is not set, then we do only one single exchange roundtrip,
    // as soon as _ANY_ channel/feed closes, we close the exchangeChannel as
    // well to avoid having it blocking the stream. (exchangeChannel.close() actually gets called
    // several times but that dosen't really matter)
    if (!this.opts.live) {
      this.exchangeChannel.close() // <-- politely let nanoguard do it's job
      // this.stream.finalize() // <-- force everything to close.
    }
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
        this.removeListener(evName, race)
        race(new ManifestResponseTimedOutError())
      }, REQUEST_TIMEOUT)
    }

    this.debug(`manifest#${mid} sent with ${manifest.keys.length} keys`)

    this.extension(EXCHANGE, bin)
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
    this.extension(EXCHANGE, bin)
    // TODO: start replicating
  }

  _onExtension (id, message) {
    const type = this._rextlut[id]
    if (typeof type === 'undefined') return console.warn('Unrecognized extension', id)

    // Ignore message if not meant for us.
    if (type !== EXCHANGE) {
      this.emit('extension', type, message) // old emitter behaviour.
      return
    }

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

  get activeChannels () {
    return [...this.activeVirtual, ...this.stream.channelizer.local]
  }

  get activeKeys () {
    return this.activeChannels.map(f => f.key.hexSlice())
  }

  isActive (key) {
    if (typeof key === 'string') key = Buffer.from(key, 'hex')
    assert(Buffer.isBuffer(key), 'Key must be a string or a buffer')
    return !!this.activeChannels.find(f => f.key.equals(key))
  }

  // Expects feeds to be 'ready' when invoked
  joinFeed (feed, cb) {
    assertCore(feed)
    if (this.isActive(feed.key)) {
      return cb(new Error('Feed is already being replicated'))
    }

    // Substream dosen't support proto v7 yet
    if (this.useVirtual) {
      // Immediately register feed as active
      this.activeVirtual.push(feed)
      const cleanUp = () => {
        this.activeVirtual.splice(this.activeVirtual.indexOf(feed), 1) // remove from virtual active
        this._onChannelClosed(feed.discoveryKey, feed.key)
      }

      // initialize substream
      substream(this.exchangeChannel, feed.key, (err, virtualStream) => {
        if (err) {
          cleanUp()
          return cb(err)
        }

        const coreStream = feed.replicate(Object.assign({}, {
          live: this.opts.live
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
    } else {
      const stream = this.stream
      feed.replicate(this.initiator, Object.assign({}, {
        live: this.opts.live,
        encrypt: this.stream.encrypted,
        stream
      }))
      this.debug('replicating feed:', feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))
      // notify manager that a new feed is replicated here,
      // The manager will forward this event other connections that not
      // yet have this feed listed in their knownFeeds
      this.emit('feed', feed.key.hexSlice(), this)
      return cb(null, stream)
    }
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

function fastHash (name) {
  return h32(name, 0xfeed).toNumber()
}
