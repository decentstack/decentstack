const test = require('tape')
const RAM = require('random-access-memory')
const hypercore = require('hypercore')
const decentstack = require('..')
const sos = require('save-our-sanity')

const key = Buffer.alloc(32)
key.write('hello')

test('mounted', t => {
  t.plan(4)
  const stack = decentstack(key)
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
  const stack = decentstack(key)
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
  const stack = decentstack(key)
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

test('hold')
test('reject')
test('store')
test('resolve')


