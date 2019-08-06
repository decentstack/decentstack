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
        /* not hyperdrive compatible
        feed.ready(() => {
          feed.append(`Generated #${i}`, err => {
            if (err) throw err
          })
        })*/
      }
    }
  }

  // Respond to share() with all feeds available
  share (next) {
    this.readyFeeds(snapshot => {
      next(null, snapshot)
    })
  }

  describe ({ key }, next) {
    this.readyFeeds(snapshot => {
      // Add add origin: 'ArrayStore' if feed is ours.
      if (snapshot.find(f => f.key.hexSlice() === key)) {
        next(null, { origin: 'ArrayStore' })
      } else next() // else ignore
    })
  }

  // accept() call for stores is a bit different.
  // It means that a core/feed has passed the entire stack
  // and been approved for storage, thus if it reaches
  // the store, it means that the store must initialize
  // a new feed if it dosen't exist.
  accept ({ key, meta, resolve }, next) {
    resolve((err, feed) => {
      if (err) return next(err)
      if (!feed) {
        feed = this.factory(this.storage, key)
        this.feeds.push(feed)
        this.emit('feed', feed)
      }
      next(null, true)
    })
  }

  // Find feed by key in store if exists
  resolve (key, next) {
    this.readyFeeds(snapshot => {
      let feed = snapshot.find(f => f.key.hexSlice() === key)
      next(null, feed)
    })
  }

  // waits for all feeds to be ready (sorry for awesomesauce)
  readyFeeds (cb) {
    const s = [...this.feeds]
    const p = n => !s[n] ? cb(s) : s[n].ready(() => p(++n))
    p(0)
  }
}

module.exports = ArrayStore
