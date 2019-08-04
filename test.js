const test = require('tape')
const hypercore = require('hypercore')
const ram = require('random-access-memory')
const ReplicationManager = require('./index')

// Define a simple core-manager that uses
// an array to keep track of cores
class ArrayStore {
  constructor (storage, factory, generateNFeeds) {
    this.storage = storage
    this.factory = factory
    this.feeds = []
    if (generateNFeeds) {
      for (let i = 0; i < generateNFeeds; i++) {
        const feed = this.factory(this.storage)
        this.feeds.push(feed)
        feed.ready(() => {
          feed.append(`Generated #${i}`, err => {
            if (err) throw err
          })
        })
      }
    }
  }

  readyFeeds (cb) {
    const s = [...this.feeds]
    const p = n => !s[n] ? cb(s) : s[n].ready(() => p(++n))
    p(0)
  }

  announce ({ keys, meta }, next) {
    this.readyFeeds(snapshot => {
      snapshot.forEach(feed => {
        const key = feed.key.hexSlice()
        keys.push(key)
        meta[key] = { from: 'ArrayStore' }
      })
      next(null, keys, meta)
    })
  }

  accept ({ key, meta }, next) {
    next(null, true)
  }

  resolve (key, next) {
    let feed = this.feeds.find(f => f.key.hexSlice() === key)
    if (!feed) {
      feed = this.factory(this.storage, key)
      this.feeds.push(feed)
    }
    next(null, feed)
  }
}

test.only('The replic8 interface', t => {
  t.plan(31)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')
  const mgr = ReplicationManager(encryptionKey)
  mgr.once('error', t.error)

  // register test middleware first
  let announceInvokes = 0
  let acceptInvokes = 0
  let resolveInvokes = 0
  mgr.use({
    announce ({ keys, meta, resolve }, next) {
      announceInvokes++
      t.ok(Array.isArray(keys), 'keys is array')
      t.equal(typeof meta, 'object', 'meta is object')
      t.equal(typeof resolve, 'function', 'resolve is a function')
      t.equal(typeof next, 'function', 'next is a function')
      keys.forEach(k => {
        meta[k].timestamp = new Date()
      })
      next(null, keys, meta) // Test append timestamps
    },
    accept ({ key, meta, resolve }, next) {
      acceptInvokes++
      t.equal(typeof key, 'string', 'key is a hexstring')
      t.equal(typeof meta, 'object', 'meta is object')
      t.equal(typeof resolve, 'function', 'resolve is a function')
      t.equal(typeof next, 'function', 'next is a function')
      next() // Test dosen't accept anything
    },
    resolve (key, next) {
      resolveInvokes++
      t.equal(typeof key, 'string', 'key is a hexstring')
      t.equal(typeof next, 'function', 'next is a function')
      next() // test store dosen't resolve anything
    }
  })

  // Register corestore as middleware
  // local has 3 feeds
  const localStore = new ArrayStore(ram, hypercore, 3)
  mgr.use(localStore)

  t.equal(mgr._middleware.default.length, 2, 'Stack contains two layers')
  const remoteMgr = ReplicationManager(encryptionKey)
  remoteMgr.once('error', t.error)

  // Remote has 1 feed
  const remoteStore = new ArrayStore(ram, hypercore, 1)
  remoteMgr.use(remoteStore)

  let imLast = false
  remoteMgr.once('connection', conn => t.ok(conn, '"connection" event fired on remote'))
  remoteMgr.once('disconnect', (err, conn) => {
    t.error(err)
    t.ok(conn, '"disconnect" event fired on remote')
    t.equal(conn.state, 'dead', 'Connection marked as dead')
    t.error(conn.lastError, 'No errors on remote conn state')

    if (imLast) finishUp()
    else imLast = true
  })

  mgr.once('connection', conn => t.ok(conn, '"connection" event fired on local'))
  mgr.once('disconnect', (err, conn) => {
    t.error(err)
    t.ok(conn, '"disconnect" event fired on local')
    t.equal(conn.state, 'dead', 'Connection marked as dead')
    t.error(conn.lastError, 'No errors on local conn state')

    if (imLast) finishUp()
    else imLast = true
  })

  // Initialize a resverse stream
  const stream = remoteMgr.replicate()

  // Preferred connection handler
  const connection = mgr.handleConnection(stream)
  t.ok(connection)
  // Also supported but not explored patterns includes:
  // mgr.replicate({ stream })
  // stream.pipe(mgr.replicate()).pipe(stream)

  const finishUp = () => {
    t.equal(localStore.feeds.length, 4, 'All feeds available on local')
    t.equal(remoteStore.feeds.length, 4, 'All feeds available on remote')

    t.equal(announceInvokes, 1, 'Announce was invoked once')
    t.equal(acceptInvokes, 1, 'Accept invoked once')
    t.equal(resolveInvokes, 4, 'Resolve invoked 4 times')
    t.end()
  }
})
