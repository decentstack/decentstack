/*
  Decenststack - A decent application framework for decentralized services
  Copyright (C) 2019  <Tony Ivanov>

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as published
  by the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.

  This license is a security measure to protect your service against malfunction,
  if you belive that it is in conflict with your use-cases then please voice your concerns.
*/

const { EventEmitter } = require('events')
const assert = require('assert')
const debug = require('debug')('decentstack')
const { isCore, isKey, canReady, assertCore, hexkey, fastHash } = require('./lib/util')
const PeerConnection = require('./lib/peer-connection.js')
const { defer, infer } = require('deferinfer')
const codecs = require('codecs')

const {
  STATE_ACTIVE,
  STATE_DEAD
} = require('./lib/constants')

class Decentstack extends EventEmitter {
  constructor (encryptionKey, opts = {}) {
    super()
    if (typeof encryptionKey === 'string') encryptionKey = Buffer.from(encryptionKey, 'hex')
    this.encryptionKey = encryptionKey
    this.protocolOpts = opts || {}
    // lift our own opts
    this.opts = {
      noTalk: opts.noTalk
    }
    // don't pollute hypercore-protocol opts
    delete this.protocolOpts.noTalk

    this._middleware = {}
    this.connections = []
    this._extensions = {}
    this._onConnectionStateChanged = this._onConnectionStateChanged.bind(this)
    this._onManifestReceived = this._onManifestReceived.bind(this)
    this._onReplicateRequest = this._onReplicateRequest.bind(this)
    this._onFeedReplicated = this._onFeedReplicated.bind(this)
    this._onUnhandeledExtension = this._onUnhandeledExtension.bind(this)
  }

  get key () {
    return this.encryptionKey
  }

  prepend (namespace, app) {
    return this.use(namespace, app, true)
  }

  use (namespace, app, prepend = false) {
    if (typeof namespace !== 'string') return this.use('default', namespace)
    if (!this._middleware[namespace]) this._middleware[namespace] = []
    if (prepend) this._middleware[namespace].unshift(app)
    else this._middleware[namespace].push(app)
    // hook, let applications know when they we're added to a manager,
    // give them a chance to register sub-middleware if needed
    if (typeof app.mounted === 'function') app.mounted(this, namespace)

    // TODO: This is a complicated mechanism, attempting to manipulate the stack after the
    // first connection was established should throw errors.
    // Because it's not only a new manifest that has to be regerenated, we also
    // need to re-run all remote-offers through our new stack, which would force us
    // to keep the last-remote-manifest cached on each connection..
    // leaving this sourcecode here for future references.
    /*
     *
    // Our stack changed, resend manifest to existing peers if any
    if (this.connections.length) {
      this.connections.forEach(conn => {
        this.startConversation(conn, err => {
          // Error indicates faulty middleware
          if (err && err.type !== 'ManifestResponseTimedOutError') return conn.kill(err)
        })
      })
    }
    */
  }

  // handleConnection is an alternative to using replicate()
  // Except it returns the PeerConnection instance instead of
  // just the stream.
  handleConnection (initiator, stream, opts = {}) {
    assert(typeof initiator === 'boolean', 'Initiator must be a boolean')
    if (stream && typeof stream.pipe !== 'function') return this.handleConnection(initiator, null, stream)
    const conn = this._newExchangeStream(initiator, opts)
    stream = stream || opts.stream
    if (stream) stream.pipe(conn.stream).pipe(stream)
    return conn
  }

  replicate (initiator, opts = {}) {
    assert(typeof initiator === 'boolean', 'Initiator must be a boolean')
    return this.handleConnection(initiator, opts).stream
  }

  get namespaces () {
    return Object.keys(this._middleware)
  }

  resolveFeed (namespace = 'default', key, cb) {
    if (typeof key === 'function') return this.resolveFeed(undefined, namespace, key)
    if (!key) return this.resolveFeed(undefined, namespace, cb) // this can cause string, 'default' to end up in 'key'
    key = hexkey(key)
    assert.strict(key, 'resolveFeed requires a "key" argument')
    const p = defer(done => {
      this.iterateStack(namespace, 'resolve', (err, app, next) => {
        if (err) return done(err)
        app.resolve(key, (err, feed) => {
          if (err) return next(err) // Abort search
          if (!feed) return next()
          if (!canReady(feed)) return next() // dosen't quack like a datastructure.
          // Feed is found
          try {
            feed.ready(() => {
              assertCore(feed)
              // TODO: It's not necessarily important that resolved 'key' matches feed
              // key. You could in theory resolve a feed using a virtual name.
              // Important part is that feed.discoveryKey matches one of the
              // 'onRemoteReplicates' events.
              // Which actually enables some interesting middleware patterns.
              // assert.strict.equal(feed.key.hexSlice(), key, 'Resolved feed key mismatch!')
              next(null, feed, true)
            })
          } catch (err) {
            next(err)
          }
        })
      }, (err, res) => {
        if (err) return done(err)
        // else if (!res.length) return cb(new Error('FeedNotResolvedError,  ' + key))
        else return done(null, res[0])
      })
    })
    return infer(p, cb)
  }

  collectMeta (keyOrFeed, namespace = 'default', cb) {
    debug('middleware#describe() starting')
    const p = defer(done => {
      let core = isCore(keyOrFeed) ? keyOrFeed : null
      const key = hexkey(keyOrFeed)
      if (!key) return done(new Error('Unsupported object encountered during collectMeta'))
      const meta = {}
      const ctx = {
        resolve (resolveCallback) {
          const p = defer(done => {
            if (core) return done(null, core) // Shortcircuit
            else {
              return this.resolveFeed(namespace, key, (err, res) => {
                if (err) return done(err)
                core = res // Save for later
                done(null, core)
              })
            }
          })
          return infer(p, resolveCallback)
        },
        key,
        meta
      }
      ctx.resolve = ctx.resolve.bind(this)

      this.iterateStack(namespace, 'describe', true, (err, app, next) => {
        if (err) return done(err)
        app.describe(ctx, (err, m) => {
          if (err) return next(err)
          Object.assign(meta, m)
          next()
        })
      }, (err, r, f) => {
        debug('middleware#describe() complete')
        if (err) return done(err)
        else return done(null, meta)
      })
    })
    return infer(p, cb)
  }

  /** Queries middleware for keys and meta data
   * and combines it into a transferable manifest.
   * optionally you can provide the `keys` argument
   * to skip the gathering key's step and create a manifest
   * based on the provides subset of keys.
   */
  snapshot (shares, namespace = 'default', cb) {
    if (typeof shares === 'function') return this.snapshot(undefined, undefined, shares)
    if (typeof namespace === 'function') return this.snapshot(shares, undefined, namespace)

    if (!this._middleware[namespace]) throw new Error(`Unknown namespace "${namespace}"`)

    const p = defer(async done => {
      if (!Array.isArray(shares) || !shares.length) {
        shares = await defer(d => this._collectShares(namespace, d))
      }
      const keys = []
      const meta = []
      for (const fk of shares) {
        try {
          const res = await this.collectMeta(fk, namespace)
          keys.push(hexkey(fk))
          meta.push(res)
        } catch (err) {
          return done(err)
        }
      }
      if (!keys.length) return done() // manifest is empty
      else done(null, { keys, meta })
    })
    // Invoke HOLD ware
      .then(snapshot => {
        debug('middleware#hold() starting')
        return defer(done => {
          const filterIdx = []
          this.iterateStack(namespace, 'hold', true, (err, app, next) => {
            if (err) return cb(err)

            let pending = snapshot.keys.length

            for (let i = 0; i < snapshot.keys.length; i++) {
              // Wait wat, this needs to be run sequential or parallell?
              const key = snapshot.keys[i]
              const meta = Object.freeze(snapshot.meta[i])

              app.hold({ key, meta }, (err, unshare) => {
                if (err) return next(err)

                if (unshare) filterIdx.push(i)

                if (!--pending) next()
              })
            }
          }, (err, res) => {
            if (err) return done(err)
            // Filter out all unshared cores
            const keys = snapshot.keys.filter((_, i) => filterIdx.indexOf(i) === -1)
            const meta = snapshot.meta.filter((_, i) => filterIdx.indexOf(i) === -1)
            debug('middleware#hold() complete')
            done(err, { keys, meta })
          })
        })
      })
    return infer(p, cb)
  }

  /**
   * send a manifest containing available feeds to provided
   * peer connection.
   * cb(error, selectedFeeds),
   * error - either an application error or 'ManifestResponseTimedOutError'
   * which indicates that the peer did not respond or was not interested
   * in our offer.
   */
  startConversation (conn, cb) {
    const p = defer(async done => {
      const selected = {}
      let pending = this.namespaces.length
      for (const ns of this.namespaces) {
        this.snapshot(ns)
          .then(manifest => {
            if (!manifest) return // empty manifest, return
            return defer(sent => conn.sendManifest(ns, manifest, sent))
          })
          .then(selectedFeeds => {
            if (selectedFeeds) selected[ns] = selectedFeeds
            if (!--pending) done(null, selected)
          })
          .catch(done)
      }
    })
    return infer(p, cb)
  }

  /**
   * Tell the manager to drop all connections and
   * notify all middleware in the stack this manager is
   * destined for the garbage collector.
   * Might want to add an optional callback to properly
   * notify invoker
   */
  close (err, cb = null) {
    if (typeof err === 'function') this.close(null, err)
    const p = defer(done => {
      for (const conn of this.connections) {
        conn.end(err)
      }

      for (const ns of this.namespaces) {
        const snapshot = [...this._middleware[ns]]
        for (const ware of snapshot) {
          // notify subscribing middleware
          if (typeof ware.close === 'function') {
            ware.close()
          }
          // remove middlware from the stack
          this._middleware[ns].splice(this._middleware[ns].indexOf(ware), 1)
        }
      }
      this.emit('close', err)
      done()
    })
    return infer(p, cb)
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

  accept (snapshot, namespace = 'default', cb = null) {
    if (typeof namespace === 'function') return this.accept(snapshot, undefined, namespace)

    if (!this._middleware[namespace]) throw new Error(`Unknown namespace "${namespace}"`)

    debug('middlware#accept_process start, nkeys:', snapshot.keys.length)
    const p = defer(done => {
      const rejectedIdx = []
      let pending = snapshot.keys.length

      for (let i = 0; i < snapshot.keys.length; i++) {
        debug('middleware#accept() start')
        const key = snapshot.keys[i]
        const meta = Object.freeze(snapshot.meta[i])

        // Core resolve fn
        let core = null
        const resolveFun = (cb) => {
          const resolvePromise = defer(resolveDone => {
            if (core) return done(null, core) // Shortcircuit
            else {
              return this.resolveFeed(namespace, key, (err, res) => {
                if (err) return cb(err)
                core = res // Save for later
                cb(null, core)
              })
            }
          })
          return infer(resolvePromise, cb)
        }

        this.iterateStack(namespace, 'reject', (err, app, next) => {
          if (err) return done(err)
          const ctx = {
            key,
            meta,
            resolve: resolveFun
          }

          app.reject(ctx, (err, rejected) => {
            if (err) return next(err)
            if (rejected) next(null, true, true)
            else next(null, false)
          })
        }, (err, wasRejected) => {
          debug('middleware#accept() complete')
          if (err) done(err)
          if (wasRejected[0]) rejectedIdx.push(i)
          if (!--pending) done(null, { rejectedIdx, snapshot })
        })
      }
    })
      .then(({ rejectedIdx, snapshot }) => {
        const keys = snapshot.keys.filter((_, i) => rejectedIdx.indexOf(i) === -1)
        const meta = snapshot.meta.filter((_, i) => rejectedIdx.indexOf(i) === -1)
        return { keys, meta }
      })
    return infer(p, cb)
  }

  // Invoke `store` on middleware, exposed for easier unit testing of middleware.
  store (accepted, namespace = 'default', callback) {
    if (typeof namespace === 'function') return this.store(accepted, undefined, namespace)

    if (!this._middleware[namespace]) throw new Error(`Unknown namespace "${namespace}"`)

    debug('middlware#store start')
    const p = defer(done => {
      const stored = []
      let pending = accepted.keys.length
      for (let i = 0; i < accepted.keys.length; i++) {
        const key = accepted.keys[i]
        const meta = accepted.meta[i]

        this.iterateStack(namespace, 'store', (err, app, next) => {
          if (err) return next(err)
          app.store({ key, meta }, (err, core) => {
            if (err) return next(err)
            // Ready up if posssible
            if (canReady(core)) { // TODO: maybe remove the key asserting in isCore
              core.ready(() => {
                // Assert core, and correct key
                if (isCore(core) && core.key.toString('hex') === key) {
                  next(null, core, true) // Accept
                }
              })
            } else next()
          })
        }, (err, res) => {
          if (err) return done(err)

          const core = res[0]
          if (core) stored.push(key)

          debug('middlware#store stop')
          if (!--pending) done(null, stored)
        })
      }
    })
    return infer(p, callback)
  }

  /**
   * Global extensions registration
   * */
  registerExtension (name, impl) {
    if (!impl && typeof name.name === 'string') return this.registerExtension(name.name, name)

    Object.assign(impl, {
      _id: fastHash(name),
      _codec: codecs(impl.encoding)
    })
    if (impl.name !== name) {
      impl.name = name
    }

    impl.send = (message, peer) => {
      const buff = impl.encoding ? impl._codec.encode(message) : message
      peer.exchangeChannel.extension(impl._id, buff)
    }

    impl.broadcast = (message) => {
      for (const peer of this.connections) {
        impl.send(message, peer)
      }
    }

    impl.destroy = () => {
      debug('Unregister global extension', name, impl._id.toString(16))
      delete this._extensions[impl._id]
    }

    this._extensions[impl._id] = impl
    debug('Register global extension', name, impl._id.toString(16))
    return impl
  }

  // ----------- Internal API --------------

  _collectShares (namespace, cb) {
    debug('middleware#share() starting')
    const result = []
    this.iterateStack(namespace, 'share', true, (err, app, next) => {
      if (err) return cb(err)
      app.share((err, keysOrFeeds) => {
        if (err) return next(err)
        const p = defer(async done => {
          // Wait for ready if single readyable was passed
          if (canReady(keysOrFeeds)) await defer(d => keysOrFeeds.ready(d))

          // Also accept single core or key
          if (isCore(keysOrFeeds) || isKey(keysOrFeeds)) keysOrFeeds = [keysOrFeeds]

          if (Array.isArray(keysOrFeeds)) {
            for (const kf of keysOrFeeds) {
              if (canReady(kf)) await defer(d => kf.ready(d))
              if (isKey(kf) || isCore(kf)) result.push(kf)
            }
          }
          done()
        })
        infer(p, next)
      })
    }, err => {
      debug('middleware#share() complete')
      if (err) cb(err)
      else cb(null, result)
    })
  }

  // Create an exchange stream
  _newExchangeStream (initiator, opts = {}) {
    const mergedOpts = Object.assign(
      {},
      this.protocolOpts, // Global live flag.

      opts, // Local overrides

      // Handlers
      {
        onmanifest: this._onManifestReceived,
        onrequest: this._onReplicateRequest,
        onstatechange: this._onConnectionStateChanged,
        onreplicating: this._onFeedReplicated,
        onextension: this._onUnhandeledExtension
      }
    )
    const conn = new PeerConnection(initiator, this.encryptionKey, mergedOpts)
    this.connections.push(conn)
    return conn
  }

  _onUnhandeledExtension (id, message, peer) {
    const ext = this._extensions[id]
    if (!ext) return
    if (ext._codec) message = ext._codec.decode(message)
    ext.onmessage(message, peer)
  }

  _onConnectionStateChanged (state, prev, err, conn) {
    switch (state) {
      case STATE_ACTIVE:
        // Check if manual conversation initiation requested
        if (!this.opts.noTalk) {
          const reqTime = (new Date()).getTime()
          this.startConversation(conn, (err, selectedFeeds) => {
            // Getting requests for all automatically sent manifests is not
            // mandatory in this stage, we're only using this callback for local statistics.
            if (err && err.type !== 'ManifestResponseTimedOutError') return conn.kill(err)
            else if (!err) {
              const resTime = (new Date()).getTime() - reqTime
              debug(`Remote response (${resTime}ms)`)
            } else {
              console.warn('Remote ignored our manifest')
            }
          })
        }
        this.emit('connect', conn)
        break
      case STATE_DEAD:
        // cleanup up
        this.connections.splice(this.connections.indexOf(conn), 1)
        this.emit('disconnect', err, conn)
        if (conn.lastError) {
          this.emit('error', conn.lastError, conn)
        }
        break
    }
  }

  _onManifestReceived ({ id, namespace, keys, meta }, conn) {
    if (!this._middleware[namespace]) {
      return console.warn(`Received manifest for unknown namespace "${namespace}"`)
    }
    return this.accept({ keys, meta }, namespace)
      .then(accepted => this.store(accepted, namespace))
      .then(stored => {
        // TODO: throw an error here
        // Request remote to start replicating accepted cores
        conn.sendRequest(namespace, stored, id)
        // Start local replication of accepted cores
        this._onReplicateRequest({ keys: stored, namespace }, conn)
      })
      .catch(err => conn.kill(err))
  }

  // Resolve and replicate
  _onReplicateRequest ({ keys, namespace }, conn) {
    keys.forEach(key => {
      if (conn.isActive(key)) return
      this.resolveFeed(namespace, key, (err, feed) => {
        if (err) return conn.kill(err)
        // Both local initiative and remote request race
        // to saturate the stream with desired feeds.
        // Thus check one more time if the feed is already
        // joined
        if (conn.isActive(key)) return
        conn.replicateCore(feed)
      })
    })
  }

  _onFeedReplicated (key, conn) {
    // Forward feed to other active connections
    // that have not seen this feed yet.
    //
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

    if (Buffer.isBuffer(key)) key = key.toString('hex')
    const namespace = conn.exchangeExt.negotiatedKeysNS[key]
    this.snapshot([key], namespace, (err, manifest) => {
      // this is an indicator of faulty middleware
      // maybe even kill the process?
      if (err) return conn.kill(err)

      if (!manifest) return

      this.connections.forEach(peer => {
        if (peer === conn) return // Skip self
        // Use "allowed keys" (offered + accepted).
        if (peer.exchangeExt.negotiatedKeys.indexOf(key) === -1) {
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
  return new Decentstack(...args)
}

module.exports.Decentstack = Decentstack
module.exports.PeerConnection = PeerConnection
