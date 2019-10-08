const test = require('tape')
const hypercore = require('hypercore')
const hyperdrive = require('hyperdrive')
const ram = require('random-access-memory')
// const { defer } = require('deferinfer')
const { Decentstack, PeerConnection } = require('..')

const ArrayStore = require('../examples/array-store')

test('basic replication', async t => {
  t.plan(12)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')
  const stack = new Decentstack(encryptionKey)
  stack.once('error', t.error)

  // Register corestore as middleware
  // local has 3 feeds
  const localStore = new ArrayStore(ram, hypercore, 3)
  stack.use(localStore)

  const remoteStack = new Decentstack(encryptionKey)
  remoteStack.once('error', t.error)

  // Remote has 1 feed
  const remoteStore = new ArrayStore(ram, hypercore, 1)
  remoteStack.use(remoteStore)

  let imLast = false
  remoteStack.once('connection', conn => t.ok(conn, '"connection" event fired on remote'))
  remoteStack.once('disconnect', (err, conn) => {
    t.error(err)
    t.ok(conn, '"disconnect" event fired on remote')
    t.equal(conn.state, 'dead', 'Connection marked as dead')
    t.error(conn.lastError, 'No errors on remote conn state')

    if (imLast) finishUp()
    else imLast = 'local'
  })

  stack.once('connection', conn => t.ok(conn, '"connection" event fired on local'))
  stack.once('disconnect', (err, conn) => {
    t.error(err)
    t.ok(conn, '"disconnect" event fired on local')
    t.equal(conn.state, 'dead', 'Connection marked as dead')
    t.error(conn.lastError, 'No errors on local conn state')

    if (imLast) finishUp()
    else imLast = 'remote'
  })

  // Initialize a resverse stream
  const stream = remoteStack.replicate(true)

  // Preferred connection handler
  const connection = stack.handleConnection(false, { stream })
  // stream.pipe(connection.stream).pipe(stream)
  t.ok(connection)
  // Also supported but not explored patterns includes:
  // stack.replicate({ stream })
  // stream.pipe(stack.replicate()).pipe(stream)

  const finishUp = () => {
    t.equal(localStore.feeds.length, 4, 'All feeds available on local')
    t.equal(remoteStore.feeds.length, 4, 'All feeds available on remote')
    t.equal(connection.queue.remaining, 0)
    stack.close(t.end)
  }
})

test('Basic: Live feed forwarding', t => {
  t.plan(13)
  setup('one', p1 => {
    setup('two', p2 => {
      setup('three', p3 => {
        let feedsReplicated = 0
        p1.store.on('feed', feed => {
          feed.get(0, (err, data) => {
            t.error(err)
            switch (feedsReplicated++) {
              case 0: {
                const f2 = p2.store.feeds[0]
                t.equal(feed.key.toString('hex'), f2.key.toString('hex'), 'should see m2\'s writer')
                t.equals(data.toString(), 'two', 'm2\'s writer should have been replicated')
                break
              }
              case 1: {
                const f3 = p3.store.feeds[0]
                t.equal(feed.key.toString('hex'), f3.key.toString('hex'), 'should see m3\'s writer')
                t.equals(data.toString(), 'three', 'm3\'s writer should have been forwarded via m2')
                p1.stack.close()
                p2.stack.close()
                p3.stack.close()
                break
              }
              default:
                t.ok(false, 'Only expected to see 2 feed events, got: ' + feedsReplicated)
            }
          })
        })
        let pending = 3

        const finishUp = err => {
          t.error(err, `Stack gracefully closed #${pending}`)
          if (--pending) return
          t.pass('All 3 stacks closed')
          t.end()
        }

        p1.stack.once('close', finishUp)
        p2.stack.once('close', finishUp)
        p3.stack.once('close', finishUp)
        // stack1 and stack2 are now live connected.
        p1.stack.handleConnection(true, p2.stack.replicate(false))

        // When m3 is attached to m2, m2 should forward m3's writer to m1.
        p3.stack.handleConnection(false, p2.stack.replicate(true))
      })
    })
  })

  function setup (msg, cb) {
    const encryptionKey = Buffer.alloc(32)
    encryptionKey.write('forwarding is good')
    const stack = new Decentstack(encryptionKey, { live: true })
    stack.once('error', t.error)
    const store = new ArrayStore(ram, hypercore, 1)
    stack.use(store, 'ArrayStore')
    const feed = store.feeds[0]
    const ret = { stack, store, feed }
    feed.ready(() => {
      feed.append(msg, err => {
        t.error(err)
        cb(ret)
      })
    })
    return ret
  }
})

// Hyperdrive V10 does not support proto:v7 yet
test.skip('Composite-core replication', t => {
  t.plan(12)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')

  const stack1 = new Decentstack(encryptionKey)
  stack1.once('error', t.error)
  const store1 = new ArrayStore(ram, hyperdrive, 3)
  stack1.use(store1)

  const stack2 = new Decentstack(encryptionKey)
  stack2.once('error', t.error)
  const store2 = new ArrayStore(ram, hyperdrive, 1)
  stack2.use(store2)

  store1.readyFeeds(snapshot => {
    const [drive] = snapshot
    const message = Buffer.from('Cats are everywhere')
    t.equal(drive.version, 1, 'Version 1')
    drive.writeFile('README.md', message, err => {
      t.error(err)
      t.equal(drive.version, 2, 'Version 2')
      // console.log('Drive metadata:', drive.metadata.discoveryKey.hexSlice(0, 6))
      // console.log('Drive content:', drive.content.discoveryKey.hexSlice(0, 6))
      stack2.once('disconnect', (err, conn) => {
        t.error(err)
        t.ok(conn)
        t.error(conn.lastError)
      })
      stack1.once('disconnect', (err, conn) => {
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
      stack1.handleConnection(true, stack2.replicate(false))
    })
  })
})

test('Hypercore extensions support (local|global)', async t => {
  t.plan(10)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')

  const stack = new Decentstack(encryptionKey)
  stack.once('error', t.error)

  const conn = new PeerConnection(true, encryptionKey, {
    live: true,
    onclose: err => t.error(err, 'Close Handler invoked w/o error')
  })

  const peerExt = conn.registerExtension('hello', {
    encoding: 'json',
    onmessage (decodedMessage, peer) {
      t.equal(peer, conn, 'PeerConnection should be presented')
      t.equal(decodedMessage.world, 'greetings!')
      peerExt.send({ dead: 'feed' }, peer)
    }
  })
  t.equal(conn._extensions[peerExt._id], peerExt)

  const globalExt = stack.registerExtension('hello', {
    encoding: 'json',
    onmessage (decodedMessage, peer) {
      t.ok(peer, 'PeerConnection should be presented')
      t.equal(decodedMessage.dead, 'feed', 'message decoded correctly')

      globalExt.destroy() // unregisters the extension
      t.notOk(stack._extensions[globalExt._id], 'Global ext successfully destroyed')
      peerExt.destroy() // unregisters peer specific ext
      t.notOk(conn._extensions[peerExt._id], 'Peer extension successfully destroyed')
      conn.kill()
    }
  })
  t.equal(stack._extensions[globalExt._id], globalExt)

  t.equal(globalExt.name, 'hello')
  stack.handleConnection(false, conn.stream, { live: true })
  conn.stream.once('end', t.end)

  globalExt.broadcast({ world: 'greetings!' })
})
