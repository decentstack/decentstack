const { HypercoreHeader } = require('./header')
module.exports = {
  describe ({ meta, resolve }, next) {
    resolve((err, core) => {
      if (err) return next(err)
      if (core.metadata) core = core.metadata // bad hyperdrive workaround.
      if (typeof core.get !== 'function' || !core.length) return next()
      core.get(0, (err, data) => {
        if (err) return next(err)
        try {
          const { type, metadata } = HypercoreHeader.decode(data)
          meta.headerType = type
          // meta.headerData = metadata // TODO: Buffers do not serialize well over JSON
          next(null, meta)
        } catch (err) {
          console.warn('Failed to decode core header', err)
          next()
        }
      })
    })
  }
}

module.exports.encodeHeader = (type, metadata) => {
  return HypercoreHeader.encode({ type, metadata })
}

module.exports.decodeHeader = (buffer) => {
  return HypercoreHeader.decode(buffer)
}
