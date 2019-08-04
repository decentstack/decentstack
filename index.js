const { EventEmitter } = require('events')
const assert = require('assert')
const debug = require('debug')('replic8')
const PeerConnection = require('./lib/peer-connection.js')
const { assertReplicatable } = PeerConnection
const {
  EXCHANGE,
  PROTOCOL_VERSION,
  VERSION,
  STATE_ACTIVE,
  STATE_DEAD
} = require('./lib/constants')

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
