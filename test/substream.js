const test = require('tape')
const protocol = require('hypercore-protocol')
const substream = require('../lib/hypercore-protocol-substream')
const pump = require('pump')
const eos = require('end-of-stream')

test.only('virtual channels', t => {
  t.plan(14)
  const key = Buffer.alloc(32)
  key.write('encryption secret')

  const stream1 = protocol({
    extensions: [substream.EXTENSION]
  })
  const vfeed1 = stream1.feed(key)
  const stream2 = protocol({
    extensions: [substream.EXTENSION]
  })
  const vfeed2 = stream2.feed(key)

  // Initialize virtual substreams
  const subA1 = substream(vfeed1, Buffer.from('beef'), (err, sub) => {
    t.error(err)
    t.ok(sub, 'Callback invoked')
  })

  const subA2 = substream(vfeed2, Buffer.from('beef'))

  eos(subA1, err => { t.error(err, 'Subchannel subA1 ended peacefully'); finish() })
  eos(subA2, err => { t.error(err, 'Subchannel subA2 ended peacefully'); finish() })

  const msg1 = Buffer.from('Hello from localhost')
  const msg2 = Buffer.from('Hello from remotehost')
  const msg3 = Buffer.from('SubA1 end')
  const msg4 = Buffer.from('SubA2 end')

  pump(stream1, stream2, stream1, err => {
    t.error(err, 'replication stream ended')
    t.ok(true, 'Async flow complete')

    t.end()
  })

  let pending = 4
  const finish = () => {
    if (--pending) return
    t.equal(stream1.destroyed, false)
    t.equal(stream2.destroyed, false)
    stream1.once('drain', () => {
      debugger
      stream1.end()
    })
  }

  subA1.once('data', chunk => {
    t.equal(chunk.toString('utf8'), msg2.toString('utf8'), 'Message 1 transmitted')

    subA1.once('data', chunk => {
      t.equal(chunk.toString('utf8'), msg4.toString('utf8'), 'Message 4 transmitted')
      finish()
    })
    subA1.end(msg3, err => {
      t.error(err)
      t.ok(true, 'SubA1 local - Finish()')
    })
  })
  subA2.once('data', chunk => {
    t.equal(chunk.toString('utf8'), msg1.toString('utf8'), 'Message 2 transmited')
    subA2.once('data', chunk => {
      t.equal(chunk.toString('utf8'), msg3.toString('utf8'), 'Message 3 transmitted')
      finish()
    })
    subA2.end(msg4, err => {
      t.error(err)
      t.ok(true, 'SubA2 local - Finish()')
    })
  })

  subA1.write(msg1)
  subA2.write(msg2)
})
