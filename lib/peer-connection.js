const { EventEmitter } = require('events')
const assert = require('assert')
const Protocol = require('hypercore-protocol')
const eos = require('end-of-stream')
const pump = require('pump')
const debugFactory = require('debug')
const { defer } = require('deferinfer')
const { assertCore } = require('./util')
const { Exchange } = require('./messages')
const substream = require('hypercore-protocol-substream')
const ph = require('pretty-hash')
const codecs = require('codecs')

const {
  STATE_INIT,
  STATE_ACTIVE,
  STATE_DEAD,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT,
  EXCHANGE
} = require('./constants')

const _exchange = {
  coding: Exchange,
  onmessage (decodedMessage, peer) {
    debugger
  }
}

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
    this.useVirtual = !!opts.useVirtual && false // Disabled for now.
    this.activeVirtual = []
    this.extensions = []
    this.remoteExtensionNames = []
    this.exchangeExt = this.registerExtension(EXCHANGE, _exchange)
    debugger
    this._rextlut = {}
    // namespaced arrays
    this.offeredKeys = {}
    this.requestedKeys = {}
    this.remoteOfferedKeys = {}

    this.stats = {
      snapshotsSent: 0,
      snapshotsRecv: 0,
      requestsSent: 0,
      requestsRecv: 0,
      channelesOpened: 0,
      channelesClosed: 0
    }

    if (typeof exchangeKey === 'string') exchangeKey = Buffer.from(exchangeKey, 'hex')

    // TODO: this.exchangeKey = hash(inputKey + 'ex:v1' + PROTOCOL_VERSION)
    this.exchangeKey = exchangeKey
    this.debug = debugFactory(`decentstack/repl/${this.shortid}`)

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
    }
    */

    // Clean up theese two as well
    let resolveRemoteVersion = null
    const remoteVersionPromise = defer(d => { resolveRemoteVersion = d })

    this.exchangeChannel = this.stream.open(this.exchangeKey, {
      onextension: this._onExtension.bind(this),
      onoptions: (opts) => {
        // Hack, remote version is packed into first element of extensions array
        resolveRemoteVersion(null, opts.extensions.shift())
        this.remoteExtensions = opts.extensions
      },
      onopen: async () => {
        this.debug('Exchange Channel opened', ph(this.exchangeKey))
        if (!this.stream.remoteVerified(this.exchangeKey)) throw new Error('open and unverified')
        this._sendOptions()

        // TODO: clean up, it's not pretty.
        const [lNameVer] = PROTOCOL_VERSION.split('.')
        const remoteVersion = await remoteVersionPromise
        const [rNameVer] = remoteVersion.split('.')
        if (lNameVer !== rNameVer) {
          this.kill(new Error(`Version mismatch! local: ${PROTOCOL_VERSION}, remote: ${remoteVersion}`))
        } else this._transition(STATE_ACTIVE)
      },
      onclose: () => {
        this.debug('Exchange Channel closed')
      }
    })

    this.debug(`Initializing new PeerConnection(${this.initiator}) extensions:`, this._rextlut)

    eos(this.stream, err => {
      this.kill(err, true)
    })
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
    this.debug('Handshake received')
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
        // our exchangeChannel already works as a wedge.
        // if (this.opts.live) this.stream.prefinalize.wait()
        // if (this.opts.live) this.stream.prefinalize.continue() // this dosen't make sense. stream is already marked for death.
        this.emit('connected', null, this)
        break
    }
  }

  /*
   * this is our errorHandler + peer-cleanup
   * calling it without an error implies a natural disconnection.
   */
  kill (err = null, eosDetected = false) {
    this.debug(`kill invoked, by eos: ${eosDetected}:`, err)
    // Report other post-mortem on console as the manager
    // will already have removed it's listeners from this connection,
    // logging is better than silent failure
    if (this.state === STATE_DEAD) {
      if (err) console.warning('Warning kill() invoked on dead peer-connection\n', this.shortid, err)
      return
    }

    const cleanup = () => {
      this.debug('cleanup:', err)
      this.exchangeChannel.close()
      // Save error for post mortem debugging
      this.lastError = err
      // Notify the manager that this PeerConnection died.
      this._transition(STATE_DEAD, err)
    }

    // If stream is alive, destroy it and wait for eos to invoke kill(err) again
    // this prevents some post-mortem error reports.
    if (!this.stream.destroyed && !eosDetected) {
      if (err) {
        // Destroy with error
        this.stream.destroy(err)
      } else {
        this.end()
      }
    } else cleanup() // Perform cleanup now.
  }

  end () {
    // wait for stream to flush before cleanup
    this.debug('invoke end & schedule cleanup')
    for (const chan of this.activeChannels) {
      chan.close()
    }
  }

  registerExtension (name, impl) {
    impl._codec = impl.coding === 'json' ? codecs('jsonp') : codecs(impl.coding)

    Object.defineProperty(impl, 'name', {
      get () { return name }
    })

    impl.send = message => {
      debugger
      // TODO: use this.encoder if encoder
      this.exchangeChannel.extension(name, message)
    }

    impl.destroy = () => {
      delete this.extensions[name]
    }

    this.extensions.push(impl)
    debugger
    this._sendOptions()
    return impl
  }

  _sendOptions () {
    debugger
    this.exchangeChannel.options({
      extensions: [PROTOCOL_VERSION, ...this.extensions.map(i => i.name)]
    })
  }

  _onChannelOpened (discoveryKey) {
    // console.log('_onChannelOpened', arguments)
    this.debug('remote replicates discKey', ph(discoveryKey))
    if (this.state === STATE_INIT) {
      const verified = this.stream.remoteVerified(discoveryKey)
      if (!verified) return this.kill(new Error('Remote uses a different exchangeKey'))
    }

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
        // this.debug('Unknown feed encountered in stream, dkey:', ph(discoveryKey))
        this.kill(new Error(`UnknownFeedError, identification timed out: ${discoveryKey.hexSlice()}`))
      }
    }, REQUEST_TIMEOUT)
  }

  _onChannelClosed (dk, pk) {
    this.stats.channelesClosed++
    this._c = this._c || 0
    this.debug('closing channel', ++this._c, ph(dk), pk && ph(pk))

    // If live is not set, then we do only one single exchange roundtrip.
    if (!this.opts.live) {
      const localExchanged = this.stats.snapshotsRecv && this.stats.requestsSent
      const remoteExchanged = this.stats.snapshotsSent && this.stats.requestsRecv
      const isLast = !this.activeChannels.filter(c => {
        return c && !dk.equals(c.discoveryKey) && !this.exchangeKey.equals(c.key)
      }).length

      if (localExchanged && remoteExchanged) this.exchangeChannel.close()
      else if (isLast) {
        // If we're last, setup a timed trigger to close the connection anyway.
        // there's no guarantee that the remote going to offer us anything.
        setTimeout(() => {
          // TODO: avoid closing exchange channel in mid-communication.
          // Close the exchange channel
          this.debug('post-close timeout triggered')
          this.exchangeChannel.close()
        }, REQUEST_TIMEOUT) // maybe use a different timeout here.
      }
      // this.exchangeChannel.close() // <-- politely let nanoguard do it's job
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
    this.stats.snapshotsSent++
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
    this.debug(`Replication request sent for mid#${manifestId} with ${keys.length} keys`)
    this.stats.requestsSent++
    this.extension(EXCHANGE, bin)
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
        this.stats.snapshotsRecv++
        const m = {
          id: msg.manifest.id,
          namespace: msg.manifest.namespace,
          keys: msg.manifest.feeds.map(f => f.key.hexSlice()),
          meta: msg.manifest.feeds.map(f => {
            const meta = {}
            f.headers.forEach(kv => {
              meta[kv.key] = JSON.parse(kv.value)
            })
            return meta
          })
        }

        // Register what remote offered.
        this.remoteOfferedKeys[m.namespace] = this.remoteOfferedKeys[m.namespace] || []
        m.keys.forEach(key => {
          if (this.remoteOfferedKeys[m.namespace].indexOf(key) === -1) {
            this.remoteOfferedKeys[m.namespace].push(key)
          }
        })

        this.debug(`Received manifest #${m.id}`)
        process.nextTick(() => this.emit('manifest', m, this))
      } else if (msg.req) {
        this.stats.requestsRecv++
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
    return [...this.activeVirtual, ...this.stream.channelizer.local.filter(c => !!c)]
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

    this.stats.channelesOpened++
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

        this.debug('replicating feed:', this.stream.expectedFeeds, ph(feed.discoveryKey), ph(feed.key))

        // connect the streams and attach error/finalization handler.
        pump(coreStream, virtualStream, coreStream, err => {
          // if (err) this.kill(err) // Kills the peer if a substream fails
          if (err) console.error(err)
          this.debug('feed finished', this.stream.expectedFeeds, ph(feed.discoveryKey), ph(feed.key))
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
      this.debug('replicating feed:', ph(feed.discoveryKey), ph(feed.key))
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

