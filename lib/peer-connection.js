const assert = require('assert')
const Protocol = require('hypercore-protocol')
const eos = require('end-of-stream')
const pump = require('pump')
const debugFactory = require('debug')
const { defer } = require('deferinfer')
const { assertCore, fastHash } = require('./util')
const substream = require('hypercore-protocol-substream')
const ph = require('pretty-hash')
const codecs = require('codecs')
const NanoQueue = require('nanoqueue')
const CoreExchangeExtension = require('./exchange')

const {
  STATE_INIT,
  STATE_ACTIVE,
  STATE_DEAD,
  PROTOCOL_VERSION,
  EXCHANGE_TIMEOUT
} = require('./constants')

class PeerConnection {
  constructor (initiator, exchangeKey, opts = {}) {
    assert(typeof initiator === 'boolean', 'First argument `initiator` must be a boolean!')
    assert(typeof exchangeKey === 'string' || Buffer.isBuffer(exchangeKey), 'Second arg `exchangeKey` must be a string or buffer')
    this._id = Buffer.from(Array.from(new Array(6)).map(() => Math.floor(256 * Math.random())))
    this.initiator = initiator
    this.state = STATE_INIT
    this.opts = opts || {}

    this.useVirtual = !!opts.useVirtual && false // Disabled for now.
    this.activeVirtual = []
    this.pendingReplications = new Map()
    this._extensions = {}

    // Lift off handlers from options.
    this.handlers = {
      onmanifest: opts.onmanifest,
      onrequest: opts.onrequest,
      onstatechange: opts.onstatechange,
      onreplicating: opts.onreplicating,
      onopen: opts.onopen,
      onclose: opts.onclose,
      onextension: opts.onextension
    }
    delete opts.onmanifest
    delete opts.onrequest
    delete opts.onstatechange
    delete opts.onreplicating
    delete opts.onopen
    delete opts.onclose
    delete opts.onextension

    // Initialize stats
    this.stats = {
      snapshotsSent: 0,
      snapshotsRecv: 0,
      requestsSent: 0,
      requestsRecv: 0,
      channelesOpened: 0,
      channelesClosed: 0
    }

    // Normalize exchange key
    if (typeof exchangeKey === 'string') exchangeKey = Buffer.from(exchangeKey, 'hex')
    this.exchangeKey = exchangeKey

    // Initialize individual debug handle
    this.debug = debugFactory(`decentstack/repl/${this.shortid}`)

    // Pre-bind kill
    this.kill = this.kill.bind(this)

    // Create our stream
    this.stream = new Protocol(initiator, {
      onhandshake: this._onHandshake.bind(this),
      ondiscoverykey: this._onChannelOpened.bind(this),
      onchannelclose: this._onChannelClosed.bind(this)
    })

    this.queue = new NanoQueue(opts.activeLimit || 50, {
      process: this._processQueue.bind(this),
      oncomplete: () => this.debug('ReplicationQueue flushed')
    })

    // Register the core-exchange protocol
    this.exchangeExt = this.registerExtension(new CoreExchangeExtension({
      onmanifest: (snapshot, peer) => {
        this.stats.snapshotsRecv++
        this.debug(`Received manifest #${snapshot.id}`)
        // Forward upwards
        if (typeof this.handlers.onmanifest === 'function') this.handlers.onmanifest(snapshot, peer)
      },
      onrequest: (req, peer) => {
        peer.debug(`Received replication request for ${req.keys.length} feeds`)
        // Forward upwards
        if (typeof this.handlers.onrequest === 'function') this.handlers.onrequest(req, peer)
      }
    }))

    // Versioncheck part #1, TODO: clean up! it's effective but not pretty.
    let resolveRemoteVersion = null
    const remoteVersionPromise = defer(d => { resolveRemoteVersion = d })

    // Create the channel that we're going to use for exchange signaling.
    this.exchangeChannel = this.stream.open(this.exchangeKey, {
      onextension: this._onExtension.bind(this),
      onoptions: (opts) => {
        // Hack, remote version is packed into first element of extensions array
        resolveRemoteVersion(null, opts.extensions.shift())
      },
      onopen: async () => {
        this.debug('Exchange Channel opened', ph(this.exchangeKey))
        if (!this.stream.remoteVerified(this.exchangeKey)) throw new Error('open and unverified')
        this.exchangeChannel.options({
          extensions: [PROTOCOL_VERSION]
        })

        // TODO: versioncheck part #2
        const [lNameVer] = PROTOCOL_VERSION.split('.')
        const remoteVersion = await remoteVersionPromise
        const [rNameVer] = remoteVersion.split('.')
        if (lNameVer !== rNameVer) {
          this.kill(new Error(`Version mismatch! local: ${PROTOCOL_VERSION}, remote: ${remoteVersion}`))
        } else {
          this._transition(STATE_ACTIVE)
        }
      },
      onclose: () => {
        this.debug('Exchange Channel closed')
      }
    })

    this.debug(`Initializing new PeerConnection(${this.initiator}) extensions:`, Object.values(this._extensions).map(i => i.name))

    // Register end-of-stream handler
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
    if (!impl && typeof name.name === 'string') return this.registerExtension(name.name, name)
    Object.assign(impl, {
      _id: fastHash(name),
      _codec: codecs(impl.encoding)
    })
    if (impl.name !== name) {
      impl.name = name
    }

    impl.send = message => {
      const buff = impl.encoding ? impl._codec.encode(message) : message
      this.exchangeChannel.extension(impl._id, buff)
    }

    impl.broadcast = impl.send

    impl.destroy = () => {
      this.debug('Unregister extension', name, impl._id.toString(16))
      delete this._extensions[impl._id]
    }

    this._extensions[impl._id] = impl
    this.debug('Register extension', name, impl._id.toString(16))
    return impl
  }

  sendManifest (namespace, manifest, cb) {
    const mid = this.exchangeExt.sendManifest(namespace, manifest, cb)
    this.stats.snapshotsSent++
    this.debug(`manifest#${mid} sent with ${manifest.keys.length} keys`)
  }

  sendRequest (namespace, keys, manifestId) {
    this.exchangeExt.sendRequest(namespace, keys, manifestId)
    this.debug(`Replication request sent for mid#${manifestId} with ${keys.length} keys`)
    this.stats.requestsSent++
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

  // --------- internal api

  _onExtension (id, message) {
    const ext = this._extensions[id]

    // bubble the message if it's not registered on this peer connection.
    if (typeof ext === 'undefined') {
      if (typeof this.handlers.onextension === 'function') {
        this.handlers.onextension(id, message, this)
      }
      return // Do not process further
    }

    if (ext._codec) message = ext._codec.decode(message)
    ext.onmessage(message, this)
  }

  _onChannelOpened (discoveryKey) {
    // console.log('_onChannelOpened', arguments)
    this.debug('remote replicates discKey', ph(discoveryKey))
    if (this.state === STATE_INIT) {
      const verified = this.stream.remoteVerified(discoveryKey)
      if (!verified) return this.kill(new Error('Remote uses a different exchangeKey'))
    }
  }

  _onChannelClosed (dk, pk) {
    this.stats.channelesClosed++

    const freeSlot = this.pendingReplications.get(pk)
    if (typeof freeSlot === 'function') freeSlot()
    else if (!this.exchangeKey.equals(pk)) console.warn('Failed to free up slot for channel', dk, pk)

    this._c = this._c || 0
    this.debug('closing channel', ++this._c, ph(dk), pk && ph(pk))

    // If live is not set, then we only do one single exchange roundtrip.
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
        }, EXCHANGE_TIMEOUT) // maybe use a different timeout here.
      }
    }
  }

  _onHandshake () {
    this.debug('Handshake received')
    // Currently there's nothing to do at this stage.
  }

  _transition (newState, err = null) {
    // We only have 3 states, and none of the transitions
    // loop back on themselves
    if (newState === this.state) return console.warn('Connection already in state', newState, err)

    const prevState = this.state
    this.state = newState

    if (typeof this.handlers.onstatechange === 'function') {
      this.handlers.onstatechange(newState, prevState, err, this)
    } else if (err) {
      // Log error if no 'state-change' listeners available to handle it.
      console.error('PeerConnection received error during `state-change` event, but no there are no registered handlers for it!\n', err)
    }

    switch (this.state) {
      case STATE_DEAD:
        if (typeof this.handlers.onclose === 'function') {
          this.handlers.onclose(err, this)
        }
        break
      case STATE_ACTIVE:
        if (typeof this.handlers.onopen === 'function') {
          this.handlers.onopen(this)
        }
        break
    }
  }

  // Expects feeds to be 'ready' when invoked
  replicateCore (feed) {
    assertCore(feed)
    this.queue.push(feed)
  }

  _processQueue (feed, done) {
    this._joinCore(feed, (err, stream) => {
      // stop this peer , queue.clear()
      if (err && err.type !== 'AlreadyActive') return this.kill(err)
      this.pendingReplications.set(feed.key, done)
    })
  }

  _joinCore (feed, cb) {
    if (this.isActive(feed.key)) {
      const err = new Error(`Feed ${feed.key} is already being replicated`)
      err.type = 'AlreadyActive'
      return cb(err)
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

        // notify above about new feed being replicated
        if (typeof this.handlers.onreplicating === 'function') {
          this.handlers.onreplicating(feed.key, this)
        }
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
      // The manager will forward this event to other connections that not
      // yet have this feed listed in their knownFeeds
      if (typeof this.handlers.onreplicating === 'function') {
        this.handlers.onreplicating(feed.key, this)
      }
      return cb(null, stream)
    }
  }
}

module.exports = PeerConnection
