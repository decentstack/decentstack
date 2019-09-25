const test = require('tape')
const RAM = require('random-access-memory')
const hypercore = require('hypercore')
const decentstack = require('..')

const key = Buffer.alloc(32)
key.write('hello')

test('mounted')

test.only('share', async t => {
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
      next(null, feed2.key)
    }
  })
  const manifest = await stack.collectManifest().catch(t.error)
  debugger
  t.end()
})
test('decorate')
test('hold')
test('reject')
test('store')
test('resolve')


