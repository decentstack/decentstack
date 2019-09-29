module.exports = (store, opts = {}) => {
  if (!store) throw new Error('First argument must be a valid corestore')
  const originHeader = opts.originHeader || 'corestore'

  return {
    share (next) {
      if (!store.isDefaultSet()) return next()
      const info = store.getInfo()
      const shared = [info.defaultKey]
      for (const core of info.cores.values()) {
        if (shared.indexOf(core.key) === -1) shared.push(core.key)
      }
      next(null, shared)
    },

    describe ({ key }, next) {
      if (!store.isDefaultSet()) return next()
      // Attach our origin header if core belongs to this store.
      this.resolve(key, (err, core) => {
        
        debugger
      })
    },

    resolve (key, next) {
      const list = store.list()
      if (!list.has(key)) return next() // We don't recognize this core.
      // Fetch the core and resolve when ready.
      const core = store.get({ key })
      core.ready(() => next(null, core))
    }
  }

  // Share all available cores
  // Rely on other middleware down the line to 'unshare'
  // using application logic.
  store.share = function (next) {
  }.bind(store)

  // Tag each core with this specific corestore's default key
  // that way we'll prevent wrong core ending up in the wrong store.
  store.describe = function ({ key, meta }, next) {
    if (this.isDefaultSet()) {
      const def = this.default()
      def.ready(() => next(null, { origin: `corestore!${def.key.hexSlice()}` }))
    } else next()
  }.bind(store)

  // Accept cores destined for this store.
  store.accept = function ({ key, meta }, next) {
    if (!meta.origin) return next()

    const [appName, defKey] = meta.origin.split('!')
    if (appName !== 'corestore') return next() // ignore non corestore feeds.

    // If uninitialized, accept and bind this store to the first 'default'
    // key that was encountered.
    if (!this.isDefaultSet()) {
      if (key === defKey) {
        const core = this.default({ key })
        core.ready(() => next(null, core))
      } else return next() // no the default key, leaving corestore in uninitialized state
    } else if (this.default().key.equals(Buffer.from(defKey, 'hex'))) {
      // yep it's one of our sub-cores
      const core = this.get({ key })
      core.ready(() => next(null, core))
    } else {
      // ignore the core it's not ours,
      // maybe it belongs to another corestore further down the stack.
      next()
    }
  }.bind(store)

  // Resolve core keys that we are aware of.
  store.resolve = function (key, next) {
    const list = this.list()
    if (!list.has(key)) return next() // We don't recognize this core.

    // Fetch the core and resolve when ready.
    const core = this.get({ key })
    core.ready(() => next(null, core))
  }.bind(store)

  return store
}
