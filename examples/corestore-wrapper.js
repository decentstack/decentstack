/* corestore-replic8.js
 *
 * Creates corestore instances that
 * implements the middleware interface
 *
 * Usage:
 * // Initialize corestore through wrapper
 * const corestore = require('corestore-replic8')
 *
 * const store = corestore(randomAccess)
 * // Register it with the manager
 * mgr.use(store)
 *
 * // operate as usual
 * const core1 = store.default()
 * const core2 = store.get()
 *
 * // but replicate through manager instead of store.
 * const stream = mgr.replicate()
 */

const corestore = require('corestore')
module.exports = (...args) => {
  const store = corestore(...args)

  // Share all available cores
  // Rely on other middleware down the line to 'unshare'
  // using application logic.
  store.share = function (next) {
    if (!this.isDefaultSet()) return next()
    const info = this.getInfo()
    const shared = [info.defaultKey]
    for (const core of info.cores.values()) {
      if (shared.indexOf(core.key) === -1) shared.push(core.key)
    }
    next(null, shared)
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
