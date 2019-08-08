const test = require('tape')
const hypercore = require('hypercore')
const hyperdrive = require('hyperdrive')
const ram = require('random-access-memory')
const ReplicationManager = require('..')
const ArrayStore = require('../examples/array-store.js')
const corestore = require('../examples/replic8-corestore.js')

test('The replic8 interface', t => {
  t.plan(59)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')
  const mgr = ReplicationManager(encryptionKey)
  mgr.once('error', t.error)

  // register test middleware first
  let announceInvokes = 0
  let acceptInvokes = 0
  let resolveInvokes = 0
  const timestamp = new Date().getTime()
  mgr.use({
    share (next) {
      announceInvokes++
      t.equal(typeof next, 'function', 'next is a function')
      next()
    },
    describe ({ key, meta, resolve }, next) {
      t.equal(typeof key, 'string', 'key is a hexstring')
      t.equal(typeof meta, 'object', 'meta is object')
      t.equal(typeof resolve, 'function', 'resolve is a function')
      resolve((err, feed) => {
        t.error(err)
        t.ok(feed, 'Core resolved')
        t.equal(feed.key.hexSlice(), key, 'Resolve function provides the core')
        next(null, { timestamp })
      })
    },
    accept ({ key, meta, resolve }, next) {
      acceptInvokes++
      t.equal(typeof key, 'string', 'key is a hexstring')
      t.equal(typeof meta, 'object', 'meta is object')
      t.equal(meta.origin, 'ArrayStore')
      t.equal(typeof resolve, 'function', 'resolve is a function')
      t.equal(typeof next, 'function', 'next is a function')
      resolve((err, feed) => {
        t.error(err)
        t.ok(!feed, 'Resolve returns falsy on not yet available feeds')
        next()
      })
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
  remoteMgr.use({
    accept ({ meta }, next) {
      t.equal(meta.origin, 'ArrayStore', 'Remote sees from ArrayStore')
      t.equal(meta.timestamp, timestamp, 'Remote sees timestamp')
      next()
    }
  })
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
    t.equal(resolveInvokes, 6, 'Resolve invoked 6 times')
    t.end()
  }
})

// Current hyperdrive is broken when it comes to reporting
// the sub-core, i should experiment with the prerelease.
// Update! Prelease using core-store has even less compatible replication.
// I'll try and submit a PR to andrewosh/corestore rewriting the .replicate()
// function into a non stream hogging version.
test.skip('Composite-core replication', t => {
  t.plan(11)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')

  const mgr1 = ReplicationManager(encryptionKey)
  mgr1.once('error', t.error)
  const store1 = new ArrayStore(ram, hyperdrive, 3)
  mgr1.use(store1)

  const mgr2 = ReplicationManager(encryptionKey)
  mgr2.once('error', t.error)
  const store2 = new ArrayStore(ram, hyperdrive, 1)
  mgr2.use(store2)

  store1.readyFeeds(snapshot => {
    const [ drive ] = snapshot
    const message = Buffer.from('Cats are everywhere')
    drive.writeFile('README.md', message, err => {
      t.error(err)
      t.equal(drive.version, 1, 'Version 1')
      // console.log('Drive metadata:', drive.metadata.discoveryKey.hexSlice(0, 6))
      // console.log('Drive content:', drive.content.discoveryKey.hexSlice(0, 6))
      mgr2.once('disconnect', (err, conn) => {
        t.error(err)
        t.ok(conn)
        t.error(conn.lastError)
      })
      mgr1.once('disconnect', (err, conn) => {
        t.error(err)
        t.error(conn.lastError)
        const replDrive = store2.feeds.find(f => f.key.equals(drive.key))
        t.ok(replDrive, 'drive should have been replicated')
        t.ok(replDrive.content, 'content should have been replicated')

        t.equal(replDrive.version, 1, 'should also be on version 1')
        replDrive.readFile('README.md', (err, res) => {
          t.error(err)
          // message
          t.end()
        })
      })
      mgr1.handleConnection(mgr2.replicate())
    })
  })
})

test('Corestore wrapper', t => {
  t.plan(13)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')

  const mgr1 = ReplicationManager(encryptionKey)
  mgr1.once('error', t.error)

  // init second core store and register with the first replication manager
  const store1 = corestore(ram)
  mgr1.use(store1)

  const mgr2 = ReplicationManager(encryptionKey)
  mgr2.once('error', t.error)

  // init second core store and register with the second replication manager
  const store2 = corestore(ram)
  mgr2.use(store2)

  const defCore = store1.default()
  const otherCore = store1.get()

  const msg1 = Buffer.from('This is the default core')
  const msg2 = Buffer.from('This is another core')

  mgr2.once('disconnect', (err, conn) => {
    t.error(err)
    t.ok(conn, 'mgr2 disconnected')
    t.error(conn.lastError)

    const replicatedDefCore = store2.get({ key: defCore.key })
    t.ok(replicatedDefCore)
    replicatedDefCore.get(0, (err, data) => {
      t.error(err)
      t.equals(msg1.toString(), data.toString(), 'Core1 and msg1 was replicated')

      const replicatedOther = store2.get({ key: otherCore.key })
      t.ok(replicatedOther)
      replicatedOther.get(0, (err, data) => {
        t.error(err)
        t.equals(msg2.toString(), data.toString(), 'Core2 and msg2 was replicated')

        mgr2.resolveFeed(otherCore.key, (err, alternativeCore) => {
          t.error(err)
          t.same(replicatedOther, alternativeCore)
          t.end()
        })
      })
    })
  })

  defCore.ready(() => {
    defCore.append(msg1, err => {
      t.error(err)
      otherCore.ready(() => {
        store1.get(otherCore.key)
        otherCore.append(msg2, err => {
          t.error(err)
          mgr1.handleConnection(mgr2.replicate())
        })
      })
    })
  })
})