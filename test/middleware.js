const test = require('tape')
const RAM = require('random-access-memory')
const hypercore = require('hypercore')
const { Decentstack } = require('..')

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
  t.equal(accepted.length, 1, 'One core accepted')
  t.equal(accepted[0], feed1.key.hexSlice(), 'Its the correct core')
  t.end()
})

test('store')
test('resolve')
