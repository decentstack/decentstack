const assert = require('assert')

const util = {
  // Since this entire project relies on ducktyping,
  // assert that the functionality necessary for replication managment is available
  // and that the core 'looks' ready.
  assertCore (f) {
    // Conditions (SUBJECT TO CHANGE)
    assert.ok(f, 'This is not a core')
    assert.strict.equal(typeof f.ready, 'function', 'A core must respond to ".ready()"')
    assert.strict.equal(typeof f.replicate, 'function', 'A core must respond to ".replicate()"')
    assert.ok(Buffer.isBuffer(f.key), 'Core is not ready or does not have a ".key"')
    assert.ok(Buffer.isBuffer(f.discoveryKey), 'Core is not ready or does not have a ".discoveryKey"')
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

  canReady (c) {
    return c && typeof c.ready === 'function'
  },

  // Returns a key in hex-string format.
  // accepts Buffer, Core and String
  hexkey (o) {
    if (util.isCore(o)) return o.key.hexSlice()
    if (!util.isKey(o)) return
    if (Buffer.isBuffer(o)) return o.hexSlice()
    return o
  },

  // readyAll([things that implement ready(cb)], callback)
  // Synchroneous, waits for one thing to become ready until it invokes
  // the next.
  // callback(error, listOfReadyables)
  readyAll (s, cb) {
    const p = n => !s[n] ? cb(null, s) : s[n].ready(() => p(++n))
    p(0)
  }
}

module.exports = util
