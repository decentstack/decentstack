const debug = require('debug')('substream')
const assert = require('assert')
const { Writable, Readable } = require('stream')
const duplexify = require('duplexify')
const eos = require('end-of-stream')
const { SubstreamOp } = require('./messages')
const EXTENSION = 'substream'

const INIT = 'INIT'
const ESTABLISHED = 'ESTABLISHED'
const CLOSING = 'CLOSING'
const END = 'END'

const OP_START_STREAM = 1
const OP_DATA = 2
const OP_CLOSE_STREAM = 3

const RETRY_INTERVAL = 500

const randbytes = () => Buffer.from(Math.floor((1 << 24) * Math.random()).toString(16), 'hex')

const substream = (feed, key, opts = {}, cb) => {
  if (typeof key === 'function') return substream(feed, undefined, undefined, key)
  if (typeof opts === 'function') return substream(feed, key, undefined, opts)
  assert(typeof feed.extension === 'function')
  assert(feed.stream)
  const did = randbytes()
  const id = key || randbytes()
  debug(did.toString('hex'), 'Initializing new substream')
  const ctx = {
    id,
    state: INIT,
    lastError: null,
    payload: null
  }

  feed.__subChannels = feed.__subChannels || []
  feed.__subChannels.push(ctx)

  let handshakeTimeout = opts.timeout || 5000 // default 5 sec

  // Receives data from virtual.write()
  const fromSub = new Writable({
    write (chunk, enc, done) {
      debug(did.toString('hex'), 'Send to remote', chunk.toString())
      const bin = SubstreamOp.encode({
        id,
        op: OP_DATA,
        data: chunk
      })
      feed.extension(EXTENSION, bin)
      done()
    }
  })
  // Yields data to virtual stream
  const toSub = new Readable({ read (size) {} })

  fromSub.cork()
  toSub.pause()
  const sub = duplexify(fromSub, toSub)
  ctx.sub = sub

  const killSub = (err) => {
    debug(did.toString('hex'), 'killSub [', ctx.state, ']', err)
    if (err) ctx.lastError = err
    switch (ctx.state) {
      case ESTABLISHED:
        ctx.state = CLOSING
        // Reply that we're closing as well.
        feed.extension(EXTENSION, SubstreamOp.encode({
          id,
          op: OP_CLOSE_STREAM
        }))
        toSub.push(null) // end readstream
        if (ctx.lastError) killSub()
        break

      case INIT:
        ctx.state = CLOSING
        ctx.lastError = new Error('Substream received end() before it was established')
        // sub.destroy(ctx.lastError)
        killSub()
        if (typeof cb === 'function') cb(ctx.lastError)
        break

      case CLOSING:
        feed.off('extension', onRemoteMessage)
        feed.__subChannels.splice(feed.__subChannels.indexOf(ctx), 1)
        feed.stream.emit('substream-disconnected', ctx)
        if (!sub.destroyed) {
          if (ctx.lastError) sub.destroy(ctx.lastError)
          sub.end()
        }

        if (opts.stream) { // clean up for GC
          sub.unpipe(opts.stream)
          opts.stream.unpipe(sub)
        }
        ctx.state = END
        break
    }
  }

  const onRemoteMessage = (ext, chunk) => {
    if (ext !== EXTENSION) return
    const msg = SubstreamOp.decode(chunk)
    if (!id.equals(msg.id)) return // not our channel.

    switch (ctx.state) {
      case INIT:
        if (msg.op !== OP_START_STREAM) return killSub(new Error('Channel recieved data before handshake'))
        debug(did.toString('hex'), 'Received hanshake from remote, INITIALIZED!')
        ctx.remoteData = msg.data
        ctx.state = ESTABLISHED

        feed.extension(EXTENSION, SubstreamOp.encode({ id, op: OP_START_STREAM })) // send 1 last handshake
        fromSub.uncork()
        toSub.resume()
        if (typeof cb === 'function') cb(null, sub)
        feed.stream.emit('substream-connected', ctx)
        break

      case ESTABLISHED:
        switch (msg.op) {
          case OP_DATA:
            debug(did.toString('hex'), 'Received data from remote', msg.data.toString())
            toSub.push(msg.data)
            break
          case OP_CLOSE_STREAM:
            debug(did.toString('hex'), 'Received close from remote')
            killSub() // Ended by remote
            break
        }
        break
      case END:
        throw new Error('Impossible state, BUG!')
    }
  }

  feed.on('extension', onRemoteMessage)
  eos(fromSub, killSub)

  // Loop handshake until opts.timeout has been reached.
  let timeWaited = 0
  const sendHandshake = () => {
    setTimeout(() => {
      if (ctx.state !== INIT) return
      timeWaited += RETRY_INTERVAL
      if (timeWaited > handshakeTimeout) {
        return killSub(new Error('Handshake timeout'))
      }
      debug(did.toString('hex'), 'Sending handshake')

      feed.extension(EXTENSION, SubstreamOp.encode({ id, op: OP_START_STREAM }))
      sendHandshake()
    }, RETRY_INTERVAL)
  }
  sendHandshake()

  if (opts.stream) {
    sub.pipe(opts.stream).pipe(sub)
  }
  return sub
}
module.exports = substream
module.exports.EXTENSION = 'substream'

