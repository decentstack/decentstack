const _debug = require('debug')
const assert = require('assert')
const { Duplex } = require('stream')
const { nextTick } = process
const eos = require('end-of-stream')
const { SubstreamOp } = require('./messages')
const EXTENSION = 'substream'
// const thunky = require('thunky')
const INIT = 'INIT'
const ESTABLISHED = 'ESTABLISHED'
const CLOSING = 'CLOSING'
const END = 'END'

const OP_START_STREAM = 1
const OP_DATA = 2
const OP_CLOSE_STREAM = 3

const RETRY_INTERVAL = 500

const randbytes = () => Buffer.from(Math.floor((1 << 24) * Math.random()).toString(16), 'hex')

class SubStream extends Duplex {
  constructor (feed, key, opts = {}) {
    super(Object.assign({}, opts, { allowHalfOpen: false }))
    this.pause()
    this.cork()

    this.id = key || randbytes()
    this.state = INIT
    this.lastError = null

    this.feed = feed
    this._onRemoteMessage = this._onRemoteMessage.bind(this)
    feed.on('extension', this._onRemoteMessage)

    //eos(this, err => {
    //  debugger
    //  if (this.state !== END && this.state !== CLOSING) this._transition(CLOSING, err)
    //})

    feed.__subChannels = feed.__subChannels || []
    feed.__subChannels.push(this)
    this.debug = _debug(`substream/${randbytes().hexSlice()}`)
    this.debug('Initializing new substream')
  }

  _write (chunk, enc, done) {
    // this.debug('DATA sub => remote', chunk.toString())
    const bin = SubstreamOp.encode({
      id: this.id,
      op: OP_DATA,
      data: chunk
    })
    this.feed.extension(EXTENSION, bin)
    nextTick(done)
  }

  _final (cb) {
    if (this.state !== END) this._transition(CLOSING, null, cb)
  }

  _read (size) {
    this.debug('sub read req')
  }

  _sendHandshake () {
    this.debug('Sending handshake')
    this.feed.extension(EXTENSION, SubstreamOp.encode({ id: this.id, op: OP_START_STREAM }))
  }

  _sendClosing () {
    this.debug('Sending close stream op')
    this.feed.extension(EXTENSION, SubstreamOp.encode({
      id: this.id,
      op: OP_CLOSE_STREAM
    }))
  }

  _transition (nstate, err, finalize) {
    const prev = this.state
    this.debug('STATE CHANGED', prev, '=>', nstate)
    switch (prev) {
      case INIT:
        switch (nstate) {
          case ESTABLISHED:
            // send 1 last handshake incase previous weren't received
            this._sendHandshake()
            this.uncork()
            this.resume()
            this.state = nstate
            this.emit('connected')
            this.feed.stream.emit('substream-connected', this)
            this.debug('Received hanshake from remote, INITIALIZED!')
            break
          case CLOSING:
            this.state = nstate
            return this._transition(END, err, finalize)
          default:
            throw new Error('IllegalTransitionError' + nstate)
        }
        break

      case ESTABLISHED:
        switch (nstate) {
          case CLOSING:
            this.state = nstate
            this._sendClosing()
            this.push(null) // end readstream
            return nextTick(() => this._transition(END, err, finalize))
          default:
            throw new Error('IllegalTransitionError' + nstate)
        }

      case CLOSING:
        switch (nstate) {
          case END:
            // TODO: proper end/destroy handling?
            if (err && !this.destroyed) this.destroy(err)
            else if (!this.destroyed) {
              this.push(null) // end readable
              this.end() // end writable
            }
            this.feed.off('extension', this._onRemoteMessage)
            this.state = nstate
            this.feed.__subChannels.splice(this.feed.__subChannels.indexOf(this), 1)
            if (typeof finalize === 'function') finalize()
            this.feed.stream.emit('substream-disconnected', this)
            break
          default:
            throw new Error('IllegalTransitionError' + nstate)
        }
        break
      default:
        throw new Error('IllegalTransitionError' + nstate)
    }
  }

  _onRemoteMessage (ext, chunk) {
    if (ext !== EXTENSION) return
    const msg = SubstreamOp.decode(chunk)
    if (!this.id.equals(msg.id)) return // not our channel.

    switch (this.state) {
      case INIT:
        if (msg.op === OP_DATA) return this._transition(CLOSING, new Error('Channel recieved data before handshake'))
        if (msg.op === OP_CLOSE_STREAM) return this._transition(CLOSING)
        // this.remoteData = msg.data
        this._transition(ESTABLISHED)
        break
      case ESTABLISHED:
        switch (msg.op) {
          case OP_DATA:
            // this.debug('DATA remote => sub', msg.data.toString())
            this.push(msg.data)
            break
          case OP_CLOSE_STREAM:
            this.debug('Received close from remote')
            this.end()
            break
        }
        break
      case END:
        throw new Error('Impossible state, BUG!')
    }
  }
}

const substream = (feed, key, opts = {}, cb) => {
  if (typeof key === 'function') return substream(feed, undefined, undefined, key)
  if (typeof opts === 'function') return substream(feed, key, undefined, opts)
  assert(typeof feed.extension === 'function')
  assert(feed.stream)
  const sub = new SubStream(feed, key, opts, cb)

  if (typeof cb === 'function') {
    let invkd = false
    sub.once('connected', () => {
      if (invkd) return
      cb(null, sub)
      invkd = true
    })
    sub.once('error', err => {
      if (invkd) return
      cb(err)
      invkd = true
    })
  }

  const handshakeTimeout = opts.timeout || 5000 // default 5 sec
  let timeWaited = 0
  const broadcast = () => {
    setTimeout(() => {
      if (sub.state !== INIT) return
      timeWaited += RETRY_INTERVAL
      if (timeWaited > handshakeTimeout) return sub._transition(CLOSING, new Error('Handshake timeout'))
      sub._sendHandshake()
      broadcast()
    }, RETRY_INTERVAL)
  }
  broadcast()

  return sub
}

module.exports = substream
module.exports.EXTENSION = 'substream'

