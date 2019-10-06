const { Exchange } = require('./messages')
const { REQUEST_TIMEOUT } = require('./constants')

class CoreExchangeExtension {
  constructor (handlers) {
    this.name = 'exchange'
    this.encoding = Exchange
    this.handlers = {
      onmanifest (snapshot) {
        throw new Error('Unhandeled Manifest message')
      },
      onrequest (keys) {
        throw new Error('Unhandeled ReplicationRequest message')
      },
      ...handlers
    }

    // Manifest id counter
    this.__mctr = 0

    // namespaced arrays
    this.offeredKeys = {}
    this.requestedKeys = {}
    this.remoteOfferedKeys = {}

    this.pendingRequests = {
    }
  }

  onmessage (msg, peer) {
    try {
      if (msg.manifest) {
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
        process.nextTick(() => this.handlers.onmanifest(m, peer))
      } else if (msg.req) {
        peer.stats.requestsRecv++
        const req = msg.req

        // Fullfill any internal promises
        if (this.pendingRequests[req.manifest_id]) {
          this.pendingRequests[req.manifest_id](null, req.keys)
        }
        process.nextTick(() => this.handlers.onrequest(req, peer))
      } else {
        throw new Error(`Unhandled Exchange message: ${Object.keys(msg).join(',')}`)
      }
    } catch (err) {
      peer.kill(err)
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

    const message = {
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
    }

    if (typeof cb === 'function') {
      let triggered = false
      const race = (err, f) => {
        if (!triggered) {
          triggered = true
          delete this.pendingRequests[mid]
          cb(err, f)
        }
      }

      this.pendingRequests[mid] = race

      setTimeout(() => {
        race(new ManifestResponseTimedOutError())
      }, REQUEST_TIMEOUT)
    }

    this.send(message)
    return mid
  }

  sendRequest (namespace, keys, manifestId) {
    this.requestedKeys[namespace] = this.requestedKeys[namespace] || []
    keys.forEach(k => {
      if (this.requestedKeys[namespace].indexOf(k) === -1) {
        this.requestedKeys[namespace].push(k)
      }
    })

    const message = {
      req: {
        namespace,
        manifest_id: manifestId,
        keys: keys.map(k => Buffer.from(k, 'hex'))
      }
    }
    this.send(message)
  }

  /*
   * Same as negotiatedKeysNS except returns a flat array of keys
   */
  get negotiatedKeys () {
    return Object.keys(this.negotiatedKeysNS)
  }

  /*
   * Each peer allows offered-keys, requested-keys and the ~~exchange-key~~
   * to be replicated on the stream
   * negotiated = offered - requested for each namespace
   * as key value, { feedKey: namespace, ... }
   */
  get negotiatedKeysNS () {
    const m = {}
    // Presumably not needed anymore after proto:v7 upgrade,
    // the exchangeKey is implicitly allowed otherwise we wouldn't
    // be exchanging any messages to begin with.
    // m[this.exchangeChannel.key.hexSlice()] = null

    Object.keys(this.offeredKeys).forEach(ns => {
      this.offeredKeys[ns].forEach(k => { m[k] = ns })
    })
    Object.keys(this.requestedKeys).forEach(ns => {
      this.requestedKeys[ns].forEach(k => { m[k] = ns })
    })
    return m
  }
}

module.exports = CoreExchangeExtension

class ManifestResponseTimedOutError extends Error {
  constructor (msg = 'timeout while waiting for request after manifest', ...params) {
    super(msg, ...params)
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) Error.captureStackTrace(this, ManifestResponseTimedOutError)

    this.name = this.type = 'ManifestResponseTimedOutError'
  }
}
