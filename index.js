const { EventEmitter } = require('events')
const assert = require('assert')
const protocol = require('hypercore-protocol')
const hypercore = require('hypercore')
const eos = require('end-of-stream')
const debug = require('debug')('replic8')
const { Exchange } = require('./messages')

const VERSION = '0.0.1'
const EXCHANGE = 'EXCHANGE'
const PROTOCOL_VERSION = 'exchange:0.0.1'

class Replic8 extends EventEmitter {
  constructor (encryptionKey, opts = {}) {
    super()
    this.encryptionKey = encryptionKey
    this.protocolOpts = opts || {}
    this._middleware = {}
    this.connections = []
    this.extensions = [EXCHANGE]
    if (Array.isArray(opts.extensions)) opts.extensions.forEach(e => this.extensions.push(e))

    this._onConnectionStateChanged = this._onConnectionStateChanged.bind(this)
    this._onManifestReceived = this._onManifestReceived.bind(this)
    this._onReplicateRequest = this._onReplicateRequest.bind(this)
  }

  get key () {
    return this.encryptionKey
  }

  use (namespace, app) {
    if (typeof namespace !== 'string') return this.use('default', namespace)
    if (!this._middleware[namespace]) this._middleware[namespace] = []
    this._middleware[namespace].push(app)
  }

  // TODO:
  // handlePeer (peerInfo) {
  //    debugger
  //    const sess = handleConnection(net.createTcpStream(peer.addres, peer.port), peerInfo)
  // }

  handleConnection (stream, peerInfo = null) {
    const conn = this._newExchangeStream()
    conn.peerInfo = peerInfo
    stream.pipe(conn.stream).pipe(stream)

    return conn
  }

  replicate (opts = {}) {
    if (opts.stream) return this.handleConnection(opts.stream)
    else return this._newExchangeStream(opts).stream
  }

  get namespaces () {
    return Object.keys(this._middleware)
  }

  resolveFeed (key, namespace = 'default', cb) {
    if (typeof namespace === 'function') return this.resolveFeed(key, undefined, namespace)

    if (Buffer.isBuffer(key)) key = key.hexSlice()

    this.iterateStack(namespace, 'resolve', (app, next) => {
      app.resolve(key, (err, feed) => {
        if (err) return next(err) // Abort search
        if (!feed) return next()

        // Feed is found
        try {
          if (typeof feed.ready !== 'function') return assertReplicatable(feed)
          feed.ready(() => {
            assertReplicatable(feed)
            // TODO: It's not necessarily important that resolved 'key' matches feed
            // key. You could in theory resolve a feed using a virtual name.
            // Important part is that feed.discoveryKey matches one of the
            // 'onRemoteReplicates' events.
            // Which actually enables some interesting middleware patterns.
            assert.strict.equal(feed.key.hexSlice(), key, 'Resolved feed key mismatch!')
            next(null, feed, true)
          })
        } catch (err) {
          next(err)
        }
      })
    }, (err, res) => {
      if (err) return cb(err)
      else if (!res.length) { debugger; return cb(new Error('FeedNotResolvedError,  ' + key))}
      else return cb(null, res[0])
    })
  }

  collectManifest (cb) {
    const res = {}
    this.namespaces.forEach(ns => {
      const stack = this._middleware[ns].filter(m => typeof m.announce === 'function')
      res[ns] = { keys: [], meta: {} }
      const next = (i) => {
        const app = stack[i]
        if (!app) return cb(null, res)

        const ctx = Object.assign({
          resolve: keys => this.resolveFeeds(keys)
        }, res[ns])

        app.announce(ctx, (err, keys, meta) => {
          if (err) return cb(err)
          keys.forEach(key => {
            assert(typeof key === 'string', 'Expected key to be a hex-string')
            let nres = res[ns]

            if (nres.keys.indexOf(key) === -1) nres.keys.push(key)
            if (meta[key]) Object.assign(nres.meta[key], meta[key])
          })
          next(++i)
        })
      }
      next(0)
    })
  }
  // ----------- Internal API --------------

  // Create an exchange stream
  _newExchangeStream (opts = {}) {
    if (!opts.extensions) opts.extensions = []
    const extensions = [...this.extensions, ...opts.extensions]

    // userdata intentionally serialized as plain json so that any client
    // can read it without depending on our protobuf schema
    // Only gotcha is that the string MUST be utf-8 encoded.
    const userData = Buffer.from(JSON.stringify({
      client: 'REPLIC8',
      dialect: PROTOCOL_VERSION,
      version: VERSION
    }), 'utf8')

    const mergedOpts = Object.assign(
      {},
      this.protocolOpts,
      opts,
      { extensions, userData }
    )
    // TODO:  filter mergedOpts to only allow
    // live
    // download
    // upload
    // encrypt
    // stream
    const conn = new PeerConnection(this.encryptionKey, mergedOpts)
    this.connections.push(conn)
    conn.on('state-change', this._onConnectionStateChanged)
    conn.on('manifest', this._onManifestReceived)
    conn.on('replicate', this._onReplicateRequest)
    return conn
  }

  _onConnectionStateChanged (state, prev, err, conn) {
    switch (state) {
      case STATE_ACTIVE:
        this.collectManifest((err, manifests) => {
          // this is an indicator of faulty middleware
          // maybe even kill the process?
          if (err) return conn.kill(err)
          this.namespaces.forEach(ns => {
            const manifest = manifests[ns]
            if (!manifest) return
            const reqTime = (new Date()).getTime()
            conn.sendManifest(ns, manifest, (err, selectedFeeds) => {
              if (err) return conn.kill(err)
              const resTime = (new Date()).getTime() - reqTime
              debug(`Remote response (${resTime}ms) selected:`, selectedFeeds.map(key => key.hexSlice(0, 6)))
            })
          })
        })
        break
      case STATE_DEAD:
        // cleanup up
        conn.off('state-changed', this._onConnectionStateChanged)
        conn.off('manifest', this._onManifestReceived)
        conn.off('replicate', this._onReplicateRequest)
        this.connections.splice(this.connections.indexOf(conn), 1)
        this.emit('disconnect', err, conn)
        break
    }
  }

  /*
   * traverses the middleware stack yielding aps
   * that support given function on given namespace,
   * cb((app, next) => {})
   * done((err, collectedResults) => {})
   */
  iterateStack (namespace, fname, cb, done) {
    if (typeof done !== 'function') done = (err) => { if (err) throw err }

    if (!this._middleware[namespace]) {
      cb(new Error(`No middleware#${fname} registered for namespace: ${namespace}`))
    }
    const stack = this._middleware[namespace].filter(m => typeof m[fname] === 'function')

    const results = []
    const next = (i, err) => {
      if (err) return done(err)
      const app = stack[i]
      if (!app) return done(err, results)
      cb(app, (err, res, abort) => {
        if (err) return next(err)
        if (typeof res !== 'undefined') results.push(res)
        if (abort) done(err, results)
        else next(++i)
      })
    }
    next(0, null)
  }

  _onManifestReceived ({ id, namespace, keys, headers }, conn) {
    let left = keys.length
    const selected = []
    // TODO: operates on single accept(key) at a time for the sake
    // of simplicity, but might not be optimal.
    keys.forEach(key => {
      this.iterateStack(namespace, 'accept', (app, next) => {
        const ctx = {
          key,
          meta: headers[key], // TODO: Object.freeze() maybe?
          resolve: (key, cb) => this.resolveFeed(key, namespace, cb)
        }

        app.accept(ctx, (err, accepted) => {
          if (err) return next(err)
          next(null, accepted && key, accepted)
        })
      }, (err, accepted) => {
        if (err) conn.kill(err)
        if (accepted[0]) selected.push(key)
        if (--left === 0) {
          conn.sendRequest(namespace, selected, id)
          this._onReplicateRequest({ keys: selected, namespace }, conn)
        }
      })
    })
  }

  // Resolve and replicate
  _onReplicateRequest ({ keys, namespace }, conn) {
    keys.forEach(key => {
      this.resolveFeed(key, namespace, (err, feed) => {
        if (err) return conn.kill(err)
        conn.joinFeed(feed, err => {
          if (err) return conn.kill(err)
        })
      })
    })
  }
}

const STATE_INIT = 'init'
const STATE_ACTIVE = 'active'
const STATE_DEAD = 'dead'
const REQUEST_TIMEOUT = 500 // TODO: 30 sec is a more realistic value?
class PeerConnection extends EventEmitter {
  constructor (encryptionKey, opts) {
    super()
    this.state = STATE_INIT
    this.__mctr = 0
    this.opts = opts
    this.encryptionKey = encryptionKey
    this.stream = protocol(opts)
    this.virtualFeed = this.stream.feed(this.encryptionKey)

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
    return this.stream.id.hexSlice(0, 6)
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
    debug(this.shortid, `Handshake from ${remoteId.hexSlice(0, 6)}`)
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
      debug('Handshake failed, closing connection', err)
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
    debug(this.shortid, 'remote replicates discKey', discoveryKey.hexSlice(0, 6))

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

    debug(this.shortid, `manifest#${mid} sent with ${manifest.keys.length} keys`)
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
        debug(this.shortid, `Received manifest #${m.id}`)
        this.emit('manifest', m, this)
      } else if (msg.req) {
        const req = msg.req

        // Fullfill any internal promises
        const evName = `manifest-${req.manifest_id}`
        if (req.manifest_id && this.listeners(evName).length) {
          this.emit(evName, null, req.keys)
        }
        debug(this.shortid, `Received replication request for ${req.keys.length} feeds`)
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
    debug(this.shortid, 'replicating feed:', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))

    eos(fstream, err => {
      if (err) return this.kill(err) // disconnects the peer not the feed-stream
      debug(this.shortid, 'feed finished', this.stream.expectedFeeds, feed.discoveryKey.hexSlice(0, 6), feed.key.hexSlice(0, 6))
    })
  }

  // TODO: support unweave/splicing a feed from the stream
  // without closing it.
  //
  _prefinalize (cb) {
    debug(this.shortid, 'prefinalize received: ', this.stream.expectedFeeds)
    debugger
    cb()
  }
}

module.exports = function (...args) {
  return new Replic8(...args)
}
module.exports.Replic8 = Replic8

// Starting to believe that .ready() is an popular anti-pattern
// in this community.
function readyAll (s, cb) {
  const p = n => !s[n] ? cb(s) : s[n].ready(() => p(++n))
  p(0)
}

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
