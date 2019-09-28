const { EventEmitter } = require('events')

// Define a simple core-manager that uses
// an array to keep track of cores

class ArrayStore extends EventEmitter {
  constructor (storage, factory, feeds) {
    super()
    this.storage = storage
    this.factory = factory
    this.feeds = []

    if (typeof feeds === 'number') {
      feeds = Array.from(new Array(feeds))
        .map(i => this.factory(this.storage))
    }

    // Generate some test-feeds
    if (Array.isArray(feeds)) {
      for (let feed of feeds) {
        this.feeds.push(feed)
        this.emit('feed', feed)
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

  store ({ key, meta }, next) {
    this.resolve(key, (err, feed) => {
      if (err) return next(err)
      if (!feed) {
        feed = this.factory(this.storage, key)
        this.feeds.push(feed)
        this.emit('feed', feed)
      }
      next(null, feed)
    })
  }

  // Find feed by key in store if exists
  resolve (key, next) {
    this.readyFeeds(snapshot => {
      const feed = snapshot.find(f => f.key.hexSlice() === key)
      next(null, feed)
    })
  }

  // waits for all feeds to be ready (sorry for awesomesauce)
  readyFeeds (cb) {
    const snapshot = [...this.feeds]
    let pending = snapshot.length
    snapshot.forEach(feed => {
      if (typeof feed.ready === 'function') {
        feed.ready(() => {
          if (!--pending) cb(snapshot)
        })
      } else if (!--pending) cb(snapshot)
    })
  }
}

module.exports = ArrayStore
