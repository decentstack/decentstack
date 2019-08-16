const { EventEmitter } = require('events')
const assert = require('assert')
const debug = require('debug')('replic8')
const { isCore, isKey, assertCore, hexkey } = require('./lib/util')
const PeerConnection = require('./lib/peer-connection.js')
const substream = require('hypercore-protocol-substream')
const {
  EXCHANGE,
  PROTOCOL_VERSION,
  VERSION,
  STATE_ACTIVE,
  STATE_DEAD
} = require('./lib/constants')

const UNSHARED = '__UNSHARED__'

class Replic8 extends EventEmitter {
  constructor (encryptionKey, opts = {}) {
    super()
    this.encryptionKey = encryptionKey
    this.protocolOpts = opts || {}
    this._middleware = {}
    this.connections = []
    this.extensions = [EXCHANGE, substream.EXTENSION]
    if (Array.isArray(opts.extensions)) this.extensions = [this.extensions, opts.extensions].sort()

    this._onConnectionStateChanged = this._onConnectionStateChanged.bind(this)
    this._onManifestReceived = this._onManifestReceived.bind(this)
    this._onReplicateRequest = this._onReplicateRequest.bind(this)
    this._onFeedReplicated = this._onFeedReplicated.bind(this)
  }

  get key () {
    return this.encryptionKey
  }

  use (namespace, app) {
    if (typeof namespace !== 'string') return this.use('default', namespace)
    if (!this._middleware[namespace]) this._middleware[namespace] = []
    this._middleware[namespace].push(app)
    // hook, let applications know when they we're added to a manager,
    // give them a chance to register sub-middleware if needed
    if (typeof app._on_use === 'function') app._on_use(this, namespace)
  }

  // TODO:
  // handlePeer (peerInfo) {
  //    debugger
  //    const sess = handleConnection(net.createTcpStream(peer.addres, peer.port), peerInfo)
  // }

  handleConnection (stream, opts = {}, peerInfo = null) {
    const conn = this._newExchangeStream(opts)
    conn.peerInfo = peerInfo
    stream.pipe(conn.stream).pipe(stream)
    return conn
  }

  replicate (opts = {}) {
    if (opts.stream) return this.handleConnection(opts.stream, opts)
    else return this._newExchangeStream(opts).stream
  }

  get namespaces () {
    return Object.keys(this._middleware)
  }

  resolveFeed (key, namespace = 'default', cb) {
    if (typeof namespace === 'function') return this.resolveFeed(key, undefined, namespace)
    assert.strict.equal(typeof cb, 'function', 'Callback missing!')

    if (Buffer.isBuffer(key)) key = key.hexSlice()

    this.iterateStack(namespace, 'resolve', (err, app, next) => {
      if (err) return cb(err)
      app.resolve(key, (err, feed) => {
        if (err) return next(err) // Abort search
        if (!feed) return next()

        // Feed is found
        try {
          if (typeof feed.ready !== 'function') return assertCore(feed)
          feed.ready(() => {
            assertCore(feed)
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
      // else if (!res.length) return cb(new Error('FeedNotResolvedError,  ' + key))
      else return cb(null, res[0])
    })
  }

  collectShares (namespace, cb) {
    const result = []
    this.iterateStack(namespace, 'share', true, (err, app, next) => {
      if (err) return cb(err)
      app.share((err, keysOrFeeds) => {
        if (err) return next(err)
        if (Array.isArray(keysOrFeeds)) {
          keysOrFeeds.forEach(kf => {
            if (isCore(kf) || isKey(kf)) result.push(kf)
          })
        }
        next()
      })
    }, err => {
      if (err) cb(err)
      else cb(null, result)
    })
  }

  collectMeta (namespace, keyOrFeed, cb) {
    let core = isCore(keyOrFeed) ? keyOrFeed : null
    const key = hexkey(keyOrFeed)
    if (!key) return cb(new Error(`Unsupported object encountered during collectMeta`))

    const meta = {}

    const ctx = {
      resolve (cb) {
        if (core) return cb(null, core) // Shortcircuit
        else {
          return this.resolveFeed(key, namespace, (err, res) => {
            if (err) return cb(err)
            core = res // Save for later
            cb(null, core)
          })
        }
      },
      key,
      meta
    }
    ctx.resolve = ctx.resolve.bind(this)

    this.iterateStack(namespace, 'describe', true, (err, app, next) => {
      if (err) return cb(err)
      app.describe(ctx, (err, m) => {
        if (err) return next(err)
        // TODO: calling `next(null, false)` for unsharing is
        // not very intuitive, redesign this criteria
        if (m === false) {
          meta[UNSHARED] = true
          return next(null, null, true) // abort loop, feed was unshared.
        }
        Object.assign(meta, m)
        next()
      })
    }, (err, r, f) => {
      if (err) return cb(err)
      else return cb(null, meta)
    })
  }

  /** Queries middleware for keys and meta data
   * and combines it into a transferable manifest.
   * optionally you can provide the `keys` argument
   * to skip the gathering key's step and create a manifest
   * based on the provides subset of keys.
   */
  collectManifest (namespace, keys, cb) {
    if (typeof keys === 'function') return this.collectManifest(namespace, null, keys)
    // Shared keys should be possible to unshared given meta
    // Keys might need to be gathered, but gathering them might result
    // smaller in a subset
    // Meta needs to be gathered for each key as soon as key is available.
    // Gathering keys and metadata in 1 sweep is highly problematic
    // (the hen & egg & dinosaur -problem)
    // Doing it as 3 different operations would've been optimal
    // but that pollutes the middleware-api's simplicity
    // 1. gather all shared keys
    // 2. gather all metadata
    // 3. unshare keys
    // Let's try and combine metadata-gather + unshare.
    const assembleManifest = (err, shares) => {
      if (err) return cb(err)
      const keys = []
      const meta = []
      let pending = shares.length
      shares.forEach(fk => {
        this.collectMeta(namespace, fk, (err, res) => {
          if (err) return cb(err)
          if (!res[UNSHARED]) {
            keys.push(hexkey(fk))
            meta.push(res)
          }

          if (!--pending) {
            if (!keys.length) return cb() // manifest is empty
            else cb(null, { keys, meta })
          }
        })
      })
    }

    if (keys) {
      assembleManifest(null, keys)
    } else {
      this.collectShares(namespace, assembleManifest)
    }
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
    conn.on('feed', this._onFeedReplicated)
    return conn
  }

  _onConnectionStateChanged (state, prev, err, conn) {
    switch (state) {
      case STATE_ACTIVE:
        this.namespaces.forEach(ns => {
          this.collectManifest(ns, (err, manifest) => {
            // this is an indicator of faulty middleware
            // maybe even kill the process?
            if (err) return conn.kill(err)
            if (!manifest) return

            const reqTime = (new Date()).getTime()
            conn.sendManifest(ns, manifest, (err, selectedFeeds) => {
              // Getting requests for all automatically sent manifests is not
              // mandatory in this stage, we're only using this callback for statistics.
              if (err && err.type !== 'ManifestResponseTimedOutError') return conn.kill(err)
              else if (!err) {
                const resTime = (new Date()).getTime() - reqTime
                debug(`Remote response (${resTime}ms) selected:`, selectedFeeds.map(key => key.hexSlice(0, 6)))
              } else {
                console.warn(`Remote ignored our manifest for namespace "${ns}"`)
              }
            })
          })
        })
        break
      case STATE_DEAD:
        // cleanup up
        conn.off('state-changed', this._onConnectionStateChanged)
        conn.off('manifest', this._onManifestReceived)
        conn.off('replicate', this._onReplicateRequest)
        conn.off('feed', this._onFeedReplicated)
        this.connections.splice(this.connections.indexOf(conn), 1)
        this.emit('disconnect', err, conn)
        if (conn.lastError) this.emit('error', conn.lastError)
        break
    }
  }

  /*
   * traverses the middleware stack yielding aps
   * that support given function on given namespace,
   * reverse (optional) default: false, traverses reverse stack order.
   * cb((app, next) => {})
   * done((err, collectedResults) => {})
   */
  iterateStack (namespace, fname, reverse = false, cb, done) {
    if (typeof reverse === 'function') return this.iterateStack(namespace, fname, false, reverse, cb)

    if (typeof done !== 'function') done = (err) => { if (err) throw err }

    if (!this._middleware[namespace]) {
      cb(new Error(`No middleware#${fname} registered for namespace: ${namespace}`))
    }
    let stack = this._middleware[namespace].filter(m => typeof m[fname] === 'function')
    if (reverse) stack = stack.reverse()

    const results = []
    const next = (i, err) => {
      if (err) return done(err)
      const app = stack[i]
      if (!app) return done(err, results)
      cb(null, app, (err, res, abort) => {
        if (err) return next(i, err)
        if (typeof res !== 'undefined') results.push(res)
        if (abort) done(err, results)
        else next(++i)
      })
    }
    next(0, null)
  }

  _onManifestReceived ({ id, namespace, keys, headers }, conn) {
    if (!this._middleware[namespace]) {

      return console.warn(`Received manifest for unknown namespace "${namespace}"`)
    }

    let pending = keys.length
    const selected = []
    // TODO: operates on single accept(key) at a time for the sake
    // of simplicity, but might not be optimal.
    keys.forEach(key => {
      let core = null
      const resolveFun = (cb) => {
        if (core) return cb(null, core) // Shortcircuit
        else {
          return this.resolveFeed(key, namespace, (err, res) => {
            if (err) return cb(err)
            core = res // Save for later
            cb(null, core)
          })
        }
      }

      this.iterateStack(namespace, 'accept', (err, app, next) => {
        if (err) return conn.kill(err)
        const ctx = {
          key,
          meta: headers[key], // TODO: Object.freeze() maybe?
          resolve: resolveFun
        }

        app.accept(ctx, (err, accepted) => {
          if (err) return next(err)
          if (accepted === false) next(null, false, true) // tristate..
          else next(null, accepted && key, accepted)      // tristate..
        })
      }, (err, accepted) => {
        if (err) conn.kill(err)
        if (accepted[0]) selected.push(key)
        if (!--pending) {
          conn.sendRequest(namespace, selected, id)
          this._onReplicateRequest({ keys: selected, namespace }, conn)
        }
      })
    })
  }

  // Resolve and replicate
  _onReplicateRequest ({ keys, namespace }, conn) {
    keys.forEach(key => {
      if (conn.isActive(key)) return
      this.resolveFeed(key, namespace, (err, feed) => {
        if (err) return conn.kill(err)
        // Both local initiative and remote request race
        // to saturate the stream with desired feeds.
        // Thus check one more time if the feed is already
        // joined to avoid killing the stream in vain.
        if (conn.isActive(key)) return
        conn.joinFeed(feed, err => {
          if (err) return conn.kill(err)
        })
      })
    })
  }

  _onFeedReplicated (key, conn) {
    // Forward feed to other active connections
    // that have not seen this feed yet.
    //
    // TODO: here's a bit of a pickle.
    // We have two natural spots for doing this operation
    // 1. Whenever a middleware `accept()` return true.
    // Thats a potential new feed, and the original feed's
    // metadata is also available at that point.
    //
    // 2. On this event when a feed successfully started replicating.
    // But here we only have the namespace and not the original remoteManifest.
    // Which is not necessarily a bad thing because we can just force local
    // middleware produce a new manifest for the feed which is probably even a better
    // solution from a security perspective.
    //
    // Consider the following metaphor:
    // Someone offers you replicatable banana, saying:
    // "it's the best banana in the world, it's yellow and sweet"
    // You accept it, once it is in your posession it is your responsibility
    // to assert that the contents matches the description.
    //
    // Let's say that the banana actually was green and bitter and then
    // you pass it along to your friend having repeated the original
    // advertisement.
    // What you've done is effectively forwarded false-marketing
    // and forced the assertion responsibility on your peer.
    //
    // so in order to avoid that both you and your friend ends up with a crappy banana due
    // to some third malicious party.
    // Each peer should be expected to always build up their own manifests an be responsible
    // for their own words to avoid wasting bandwidth and processing power on inaccurate advertisement.
    const namespace = conn.allowedKeysNS[key]
    this.collectManifest(namespace, [key], (err, manifest) => {
      // this is an indicator of faulty middleware
      // maybe even kill the process?
      if (err) return conn.kill(err)

      if (!manifest) return

      this.connections.forEach(peer => {
        if (peer === conn) return // Skip self
        // Use "allowed keys" (offered + accepted).
        if (peer.allowedKeys.indexOf(key) === -1) {
          const reqTime = (new Date()).getTime()
          debug(`Forwarding ${hexkey(key).slice(0, 6)} feed to ${peer.shortid}`)
          peer.sendManifest(namespace, manifest, (err, selectedFeeds) => {
            if (err) return peer.kill(err)
            const resTime = (new Date()).getTime() - reqTime
            debug(`Remote response (${resTime}ms) selected:`, selectedFeeds.map(key => key.hexSlice(0, 6)))
          })
        }
      })
    })
  }
}

module.exports = function (...args) {
  return new Replic8(...args)
}
module.exports.Replic8 = Replic8
