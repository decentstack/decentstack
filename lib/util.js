const assert = require('assert')

const util = {
  // Sorry.. i'm tired of writing new promises by hand
  // and also tired of uncaught promise rejections
  defer (task) {
    assert(typeof task === 'function')
    return new Promise((resolve, reject) => {
      const r = task((err, res) => {
        if (err) reject(err)
        else resolve(res)
      })

      // If the task is an AsyncFunction
      // then that generates a promise in itself,
      // let it race
      if (r && r.then && r.catch) {
        r.catch(reject) // Race the errors occuring in AsyncFunction
          .then(res => {
            if (res) throw new Error(`Do not return values within defer(done => {...}), use the supplied 'done'; result: ${res}`)
          }) // forward the result
      }
    })
  },

  infer (p, cb) {
    return (typeof cb === 'function') ? p.then(r => cb(null, r)).catch(cb) : p
  },

  // Since this entire project relies on ducktyping,
  // assert that the functionality necessary for replication managment is available
  // and that the core 'looks' ready.
  assertCore (f) {
    // Conditions (SUBJECT TO CHANGE)
    assert.ok(f, `This is not a core`)
    assert.strict.equal(typeof f.ready, 'function', `A core must respond to '.ready()'`)
    assert.strict.equal(typeof f.replicate, 'function', `A core must respond to '.replicate()'`)
    assert.ok(Buffer.isBuffer(f.key), `Core is not ready or does not have a '.key'`)
    assert.ok(Buffer.isBuffer(f.discoveryKey), `Core is not ready or does not have a '.discoveryKey'`)
    return f
  },
  // Same as assertCore, except returns a boolean instead of throwing errors
  isCore (c) {
    if (!c) return false
    if (typeof c.ready !== 'function') return false
    if (typeof c.replicate !== 'function') return false
    if (!Buffer.isBuffer(c.key)) return false
    if (!Buffer.isBuffer(c.discoveryKey)) return false
    return true
  },
  isKey (k) {
    if (!k) return false
    // must be a buffer or a string
    if (!Buffer.isBuffer(k) && typeof k !== 'string') return false
    // Assert hexstring if string
    if (typeof k === 'string' && Number.isNaN(parseInt(k, 16))) return false
    return true
  },

  // Returns a key in hex-string format.
  // accepts Buffer, Core and String
  hexkey (o) {
    if (util.isCore(o)) return o.key.hexSlice()
    if (!util.isKey(o)) return
    if (Buffer.isBuffer(o)) return o.hexSlice()
    return o
  },

  // Starting to believe that .ready() is an popular anti-pattern
  // in this community.
  readyAll (s, cb) {
    const p = n => !s[n] ? cb(s) : s[n].ready(() => p(++n))
    p(0)
  }
}

module.exports = util
