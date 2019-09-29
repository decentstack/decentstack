[![Build Status](https://travis-ci.org/decentstack/decentstack.svg?branch=master)](https://travis-ci.org/decentstack/decentstack)

decentstack
=================

[1.0 Announcement](https://github.com/decentstack/decentstack/issues/2)

### Welcome!

Decentstack is a framework for building decentralized
applications

(primarily those that utilize [kappa-architecture](https://github.com/kappa-db/) )

If you're brave enough you there are some pre-release docs available:

[Documentation](https://decentstack.org) (Still being written & revised)

The quickstart instructions are not available yet, but I would recommend you to
start with the excellent [kappa-workshop](https://noffle.github.io/kappa-arch-workshop/build/01.html). It's a great introduction to building decentralized applications that
naievly exchange trust and a "must see" prequel to the issues which Decentstack attempts
to address.

### Updates
- 2019-10-27 Still being written, thanks for checking in
- 2019-10-28 Tests pass, docs still being written..
- 2019-10-29 docs preview [published](https://decentstack.org). chunks of public-API docs still missing


### Usage

```js
const RAM = require('random-access-memory')
const multifeed = require('multifeed')
const kappa = require('kappa-core')
const { Decentstack } = require('decentstack')

class MyApplication {
  mounted (stack) {
    this.storage = multifeed(RAM, stack.key)

    // TODO: get rid of this workaround
    this.kappa = kappa(null, { multifeed: this.multi })

    stack.use(this.storage)
  }

  // Expose feed lengths
  async describe ({ resolve }, next) {
    try {
      const feed = await resolve()
      next(null, { seq: feed.length })
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

// Setup an exchange-key
const exchangeKey = Buffer.alloc(32)
exchangeKey.write('communication-encryption-key')

// Create stack and register our application
const stack = new Decentstack(exchangeKey, { live: true })
stack.use(new MyApplication())

// Replicate as usual
const stream = stack.replicate(true)
stream.pipe(remoteStream).pipe(stream)

```

## License

This project is licensed under GNU AGPLv3

<sup>If you have any concerns or conflicts with this license please open an issue and
state your case.</sup>
