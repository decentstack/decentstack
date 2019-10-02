## Installation

A pre-release is now available on npm.

```sh
npm i decentstack
# --OR--
yarn add decentstack
```

## Quickstart
!>This guide is work in progress, the example below works but is not
very descriptive. apologies..

Define your application in `app.js`
```js
const RAM = require('random-access-memory')
const multifeed = require('multifeed')
const kappa = require('kappa-core')

class MyApp {

  mounted (stack) {
    this.storage = multifeed(RAM, stack.key)

    this.kappa = kappa(null, { multifeed: this.storage }) // this workaround will be fixed.
    // register our storage
    stack.use(this.storage)
  }

  // Expose feed lengths
  async describe ({ resolve }, next) {
    try {
      const feed = await resolve()
      next(null, { seq: feed.length }) // expose length as 'seq'
    } catch(err) {
      next(err)
    }
  }

  // prevent zero-length feeds from being shared
  hold ({ meta }, next) {
    next(null, !!meta.seq)
  }

  // prevent zero-length feeds from being accepted
  reject ({ meta }, next) {
    next(null, !!meta.seq)
  }
}

module.exports = MyApp
```

In your entrypoint `index.js`, compose your stack

```js
const { Decentstack } = require('decentstack')

// Setup an exchange-key.
// This key will be used to securly detect
// if a peer has access to your exchangeKey
// and to safely encrypt your entire communication.
const exchangeKey = Buffer.alloc(32)
exchangeKey.write('communication-encryption-key')

// Create stack and register our application
const stack = new Decentstack(exchangeKey, { live: true })
stack.use(new MyApplication())

// Replicate as usual
const stream = stack.replicate(true)
stream.pipe(remoteStream).pipe(stream)
```

