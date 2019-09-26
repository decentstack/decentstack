const test = require('tape')
const RAM = require('random-access-memory')
const hypercore = require('hypercore')
const { Decentstack } = require('..')
const { defer } = require('deferinfer')

const exchangeKey = Buffer.alloc(32)
exchangeKey.write('hello')

test('mounted', t => {
  t.plan(4)
  const stack = new Decentstack(exchangeKey)
  stack.use('files', {
    mounted (ostack, namespace) {
      t.equal(stack, ostack, 'Outer mounted() invoked')
      t.equal(namespace, 'files')
      stack.use({
        mounted (istack, namespace) {
          t.equal(stack, istack, 'Inner mounted() invoked')
          t.equal(namespace, 'default')
          t.end()
        }
      })
    }
  })
})

test('share', async t => {
  t.plan(7)
  const stack = new Decentstack(exchangeKey)
  const feed1 = hypercore(RAM)
  const feed2 = hypercore(RAM)
  let order = 0
  stack.use({
    share (next) {
      t.equal(++order, 2, 'Middleware A share() invoked second')
      next(null, [feed1])
    }
  })
  stack.use({
    share (next) {
      t.equal(++order, 1, 'Middleware B share() invoked first')
      feed2.ready(() => next(null, feed2.key))
    }
  })
  const snapshot = await stack.snapshot().catch(t.error)
  t.ok(Array.isArray(snapshot.keys), 'snapshot.keys array')
  t.ok(Array.isArray(snapshot.meta), 'snapshot.meta array')
  t.equal(snapshot.keys.length, snapshot.meta.length, 'Same length')
  t.equals(snapshot.keys[0], feed2.key.hexSlice())
  t.equals(snapshot.keys[1], feed1.key.hexSlice())
  t.end()
})

test('decorate', async t => {
  t.plan(11)
  const stack = new Decentstack(exchangeKey)
  const feed = hypercore(RAM)
  let order = 0
  stack.use({
    share (next) {
      next(null, [feed])
    },
    async describe ({ meta, resolve }, next) {
      t.equal(++order, 2)
      t.equal(meta.seq, 0)
      resolve((err, rf) => {
        t.error(err)
        t.equal(rf, feed)
        meta.foo = 'bar'
        next(null, { hello: 'world' })
      })
    }
  })
  stack.use({
    async describe ({ key, resolve }, next) {
      t.equal(++order, 1)
      t.equal(key, feed.key.hexSlice(), 'Key from other stack')
      const rf = await resolve().catch(t.error)
      t.equal(rf, feed, 'Feed is resolvable')
      next(null, { seq: feed.length })
    }
  })
  const { meta } = await stack.snapshot().catch(t.error)
  t.equal(meta.length, 1)
  t.equal(meta[0].seq, 0, 'meta from first decorator set')
  t.equal(meta[0].foo, 'bar', 'Modifying meta works')
  t.equal(meta[0].hello, 'world', 'Merging new object works')
  t.end()
})

test('hold', async t => {
  t.plan(9)
  const stack = new Decentstack(exchangeKey)
  const feed = hypercore(RAM)
  let order = 0

  stack.use({
    hold ({ key, meta }, next) {
      t.equal(++order, 2)
      t.equal(key, feed.key.hexSlice(), 'Key from other stack')
      next(null, meta.seq === 0)
    },

    describe ({ meta }, next) {
      t.pass('decorate()')
      meta.seq = 0
      next()
    }
  })

  stack.use({
    hold ({ meta }, next) {
      t.pass('hold()')
      t.equal(++order, 1)
      t.equal(meta.seq, 0)
      next()
    },

    share (next) {
      t.pass('share()')
      next(null, feed)
    }
  })

  const { keys, meta } = await stack.snapshot().catch(t.error)
  t.equal(keys.length, 0, 'Core unshared')
  t.equal(meta.length, 0, 'meta also empty')
  t.end()
})

const makeTestStack = feeds => {
  const stack = new Decentstack(exchangeKey)
  let n = 0
  stack.use({
    share: next => next(null, feeds),
    describe: (ctx, next) => next(null, { n: n++ })
  })
  return stack
}

test('reject', async t => {
  t.plan(6)
  const feed1 = hypercore(RAM)
  const feed2 = hypercore(RAM)
  const stack = makeTestStack([feed1, feed2])
  let order = 0
  stack.use({
    reject ({ key, meta }, next) {
      t.equal(order++ % 2, 0, 'First reject invoked')
      next(null, meta.n)
    }
  })
  stack.use({
    reject ({ key, meta }, next) {
      t.equal(order++, 1, 'Second reject invoked once')
      t.notEqual(key, feed2.key.hexSlice(), 'Second feed should already have been filtered')
      next()
    }
  })
  const snapshot = await stack.snapshot().catch(t.error)
  const accepted = await stack.accept(snapshot)
  t.equal(accepted.keys.length, 1, 'One core accepted')
  t.equal(accepted.keys[0], feed1.key.hexSlice(), 'Its the correct core')
  t.end()
})

test('store', async t => {
  t.plan(4)
  const feed = hypercore(RAM)
  const stack = makeTestStack([feed])
  let order = 0
  stack.use({
    store (_, next) {
      t.equal(++order, 1, 'First store called first')
      next()
    }
  })

  stack.use({
    store ({ key, meta }, next) {
      t.equal(++order, 2, 'Deepest store called last')
      next(null, hypercore(RAM, key))
    }
  })
  const snapshot = await stack.snapshot().catch(t.error)
  const accepted = await stack.accept(snapshot).catch(t.error)
  const stored = await stack.store(accepted).catch(t.error)

  t.equal(stored.length, 1, 'One core stored')
  t.equal(stored[0], feed.key.hexSlice(), 'Its the correct core')
  t.end()
})

test('resolve', async t => {
  t.plan(6)
  const feed = hypercore(RAM)
  const stack = new Decentstack(exchangeKey)
  stack.use({
    share: next => next(null, feed),
    resolve (key, next) {
      t.pass('Resolve called')
      t.equal(typeof key, 'string', 'Key is a string')
      // t.equal(key, feed.key.hexSlice(), 'Expeceted key')
      const r = key === feed.key.hexSlice() ? feed : null
      next(null, r)
    }
  })
  // const snapshot = await stack.snapshot().catch(t.error)
  await defer(done => feed.ready(done))
  const r = await stack.resolveFeed(feed.key).catch(t.error)
  t.equal(r, feed, 'Feed resolved')
  // Test not finding something.
  const notFound = await stack.resolveFeed(feed.discoveryKey).catch(t.error)
  // This is subject to change.
  t.equal(typeof notFound, 'undefined', 'Not found is undefind')
  t.end()
})

test('close', t => {
  t.plan(2)
  const stack = new Decentstack(exchangeKey)

  stack.use({
    close () {
      t.pass('close() 1 invoked')
    }
  })

  stack.use({
    close () {
      t.pass('close() 2 invoked')
    }
  })

  stack.close(t.end)
})
