/*
 * The tests done in this suite, tests objects that implement the middleware
 * interface against the spec.
 * No need to do a full replication test because we have a separate
 * middleware-interface spec test.
 */

const test = require('tape')
const RAM = require('random-access-memory')
const hypercore = require('hypercore')
const hyperdrive = require('hypercore')
const hypertrie = require('hypercore')
const { Decentstack } = require('..')
const { defer } = require('deferinfer')

// examples
const ArrayStore = require('../examples/array-store')
const Corestore = require('corestore')
const wrapCorestore = require('../examples/corestore-wrapper')
const typedecorator = require('../examples/type-decorator')
const { encodeHeader } = typedecorator

test.skip('Corestore wrapper', async t => {
  t.plan(13)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')

  const stack = new Decentstack(encryptionKey)
  stack.once('error', t.error)

  // init second core store and register with the first replication manager
  const store = new Corestore(RAM)
  stack.use(wrapCorestore(store))

  // need to let corestore initialize before using
  await defer(d => store.ready(d)).catch(t.error)

  const defCore = store.default()
  const otherCore = store.get()

  const { keys, meta } = await stack.snapshot().catch(t.error)
  t.equals(keys[0], defCore.key.hexSlice())
  t.equals(keys[1], otherCore.key.hexSlice())
  t.equals(meta[0].origin, 'corestore')
  t.end()
})

test('Core type decorator', t => {
  t.plan(3)
  const core = hypercore(RAM)
  const store1 = new ArrayStore(RAM, hypercore, [
    core,
    hypertrie(RAM),
    hyperdrive(RAM)
  ])

  const expectedTypes = [
    'CabalFeed:7.0.0',
    undefined, // 'hypertrie',
    undefined
  ]

  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('types are useful')

  const stack = new Decentstack(encryptionKey)
  stack.once('error', t.error)

  stack.use(typedecorator)
  stack.use(store1)

  core.ready(() => {
    const coreMeta = Buffer.from(JSON.stringify({
      passportId: '045B4203EDF92',
      signature: '92FDe3024B540'
    }))
    const binhdr = encodeHeader('CabalFeed:7.0.0', coreMeta)
    core.append(binhdr, err => {
      t.error(err)
      stack.snapshot((err, snapshot) => {
        t.error(err)
        t.deepEqual(snapshot.meta.map(m => m.headerType), expectedTypes)
      })
    })
  })
})
