const { EventEmitter } = require('events')

// Define a simple core-manager that uses
// an array to keep track of cores

class ArrayStore extends EventEmitter {
  constructor (storage, factory, generateNFeeds) {
    super()
    this.storage = storage
    this.factory = factory
    this.feeds = []

    // Generate some test-feeds
    if (generateNFeeds) {
      for (let i = 0; i < generateNFeeds; i++) {
        const feed = this.factory(this.storage)
        this.feeds.push(feed)
        this.emit('feed', feed)
        feed.ready(() => {
          feed.append(`Generated #${i}`, err => {
            if (err) throw err
          })
        })
      }
    }
  }

  // Respond to announces with all feeds available
  announce ({ keys, meta }, next) {
    this.readyFeeds(snapshot => {
      snapshot.forEach(feed => {
        const key = feed.key.hexSlice()
        keys.push(key)
        meta[key] = { from: 'ArrayStore' }
      })
      next(null, keys, meta)
    })
  }

  // Blindly accept all feeds
  // in a real world scenario, 'GeneralPurpose' stores should be last
  // in the middleware stack and not implement the accept
  // method relying on other applications to handle the filtering.
  // calling `next()` without arguments is also a valid "don't care" operation.
  accept ({ key, meta }, next) {
    next(null, true)
  }

  // Find feed by key in store or create it.
  resolve (key, next) {
    let feed = this.feeds.find(f => f.key.hexSlice() === key)
    if (!feed) {
      feed = this.factory(this.storage, key)
      this.feeds.push(feed)
      this.emit('feed', feed)
    }
    next(null, feed)
  }

  // waits for all feeds to be ready (sorry for awesomesauce)
  readyFeeds (cb) {
    const s = [...this.feeds]
    const p = n => !s[n] ? cb(s) : s[n].ready(() => p(++n))
    p(0)
  }
}

module.exports = ArrayStore
