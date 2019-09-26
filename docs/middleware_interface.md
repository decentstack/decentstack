Middleware Interface
========================

> This document is an early draft, and contains inaccuracies
> right now.

##  Abstract

The application stacks we use today have limited vertical interaction between
components, this becomes painfully evident if you attempt to add any kind of
conditional logic to replication.

The application is aware of feed-content and is able to define higher level
selection rules but lacks the mandate apply them.

Corestores like [corestore](https://github.com/andrewosh/corestore) and [multifeed](https://github.com/kappa-db/multifeed/) ensure that appended cores get stored and replicated.
They have the power to control what should be shared and accepted, but they lack the application
context and therefore cannot define any sensible selection rules.

_Without power, knowledge is useless_

The middleware interface is intended to complement the standard [Dat SDK](https://github.com/datproject/sdk) toolset, defining a datastructure agnostic approach to Application Defined Replication control.

It separates core storage from replication management, allowing the
top-level application to define the _what_, _when_ and _how_ something is stored
and replicated.

## Introduction

The interface describes a set of methods that should be
straightforward to implement.

Once implemented, your software can be included in a stack and
  communicate with other stack-denizents without prior knowledge of the stack configuration.

This opens up some new and exciting patterns for modularity.
You can for instance create a core storage manager that dosen't care about
replication.

Or a general purpose replication filter that is reusable across multiple applications.

You can even use multiple core-stores at the same time hosting
completely different data-structures and let them all replicate over a single
peer connection.

> But more importantly, the abstraction should make it easier to develop
> decentralized services and applications, and make life a bit easier for those who enjoy hacking on the decentralized infrastructure.

The interface is not intended as a lock-in or a replacement for existing
standards, if you for any reason don't want to
use Decentstack as a middleware host, it should be an easy task to implement
your own middleware host using the specification below.


## Callbacks
All callbacks are optional, an `Object` is considered **usable**
 as long as it implements at least one of the methods listed below.


| Core API              | Stack traversal    | Purpose                                                           |
| :----------           | -----------------: | ---------                                                         |
| `share`               | reverse            | Assemble list of cores                                            |
| `describe`            | reverse            | Append metadata to outgoing advertisement                         |
| `hold`                | reverse            | "Unshare" / prevent cores to be advertised to remote              |
| `reject`              | forward            | Filter incoming advertisements & store cores                      |
| `store`               | forward            | Provide `RandomAccess` storage for an accepted core               |
| `resolve`             | reverse            | Find and return core by key                                       |  |
| **Lifecycle Helpers** |                    |                                                                   |
| `mounted`             | --                 | Notify application that it was included & let it bootstrap itself |
| `close`               | reverse            | Notify application that the stack is being torn down              |

### share
`share (next)`

**Callback parameters**

- `{Function} next (error, coresOrKeys)`
  - `{Object} error` If passed, aborts stack iteration and causes
    `PeerConnection` to be dropped
  - `{Array} coresOrKeys` A list of shared `Buffer` keys or `Object` cores

**Description**

Offers cores for replication, typically implemented by storages
that that hold cores.
Cores shared at this point can be "unshared" using the
`hold` callback.

```js
const coreA = hypercore(storage)
const coreB = hypercore(storage)
stack.use({
  share (next) {
    next(null, [coreA, coreB])
  }
})
```

### decorate
`decorate (context, next)`

**Callback parameters**
- `{Object} context` contains helper properties:
  - `{String} key` hex-string representation of the core-key
  - `{Object} meta` Metadata from previous middleware or empty hash
  - `{Function} resolve` Get the core described identified `key` (Promise|Callback)
- `{Function} next (error, meta)`
  - `{Object} error` If passed, aborts stack iteration and causes
    `PeerConnection` to be dropped
  - `{Object} meta` If passed, will be merged into current metadata.

**Description**

Second step of the _Share_ process, allows your middleware to attach metadata to the feed denoted by `key`

The keys and values exposed here will be transmitted to the remote peer
in order to let him apply pre-replicate selection logic.

```js
stack.use({
  async decorate({ key, meta, resolve }, next) {
    const feed = await resolve().catch(next) // Always handle errors

    // choose wichever pattern you prefer
    meta.foo = 'bar' // Either directly mutate the previous hash
    next(null, { seq: feed.length }) // or let decentstack perform a merge
  }
})
```

### hold
`hold (context, next)`

**Callback parameters**
- `{Object} context` contains helper properties:
  - `{String} key` hex-string representation of the core-key
  - `{Object} meta` __immutable__ Metadata, the sum of all decorations.
- `{Function} next (error, unshare)`
  - `{Object} error` If passed, aborts stack iteration and causes
    `PeerConnection` to be dropped
  - `{boolean} unshare` If the value is `truthy` then this core will be removed from the offer.

**Description**

The third and last phase of the _Share_ process,
allows middleware to remove a previously shared core from the offer.

During the `describe` phase - `meta` should be populated with the properties you require to make a `hold` decision.

```js
stack.use({
  decorate({ key, meta }, next) {
    if (meta.seq < 1) {
      next(null, true) // hold empty feeds
    } else {
      next() // otherwise let the feed through
    }
  })
})
```

### mouted
`mounted (stack, namespace)`

**Callback parameters**
- `{Object} stack` The stack to which this middleware was added
- `{String} namespace` The namespace this middleware was assigned

**Description**

Invoked when your middleware is added to a stack, use this hook to either
lazily initialize your app or register internal submodules.

```js
stack.use({
  mounted(stack, namespace) {
    console.log('I was mounted on namespace:', namespace)
    stack.use(namespace, new AwesomeDecorator())
  }
})
```

## Lifecycle

The diagram below illustrates the typical flow of callback invocation

![Middleware Lifecycle Diagram](./middleware_lifecycle.svg)

**Note 1** share & accept processes might be repeated multiple times if the
replication session was initiated with option `live` set to `true`.

**Note 2** The `resolve` callback might be invoked multiple times throughout the
lifecycle by other middleware, but the middleware-host will only invoke the
callback when it needs resolve a core in order to `.replicate()`

## Stack iteration order

![Stack iteration order diagram](./stack_iteration_order.svg)

!>In order to make it eaiser to write useful selfcontained middleware,
the stack iteration order has been **reversed** during the share process.

As an example, the following stack configuration:
```js
stack.use(filterA)
stack.use(filterB)
stack.use({ // App1
  mounted (stack) {
    stack.use(filterC)
    stack.use(decorator)
    stack.use(store1)
  }
})
stack.use(store2)
stack.use(store3)
```
Will result in the following linear stack:

```js
[filterA, filterB, App1, filterC, decorator1, store1, store2, store3]
```

`reject()` and `store()` callbacks on middleware will logically be invoked in
the same order that they were registered

```js
[filterA, filterB, FilterC].forEach(w => w.reject(listOfCores))
[store1, store2, store3].forEach(w => w.store(listOfCores))
```

But `share`, `describe`, `hold` and `resolve` callbacks will be invoked in
**reverse** order of registration:

```js
[store3, store2, store1].forEach(w => w.share())
[filterC, filterB, filterA].forEach(w => w.hold())
```
**Practical experiment:**

1. Place two glass jars side by side,
2. Drop some grains into the jar _A_.
3. Put a mesh-filter with big holes ontop of each jar
4. Put a mesh-filter with small holes mesh ontop of each jar
5. Hold jar _A_ **upside down** over jar _B_
6. Observe the order that the grains pass through the filters.
7. Reverse positions of _A_ and _B_ and observe grains travel into the reverse
   direction
8. Repeat until satisfied.

!> This ensures that **middleware priority is identical** regardless if your
peer is sending or receiving feeds.

OLD DOCS
========
**TLDR;**
> `resolve` and `accept` = First to Last
>
> `share` and `decorate` = Last to First



Middleware traversal order depends on the direction of communication.

When sending data from local to remote, middleware stack is traversed in LIFO
order.

And when receiving data from remote to local, middleware stack is traversed in
FIFO order.

This is to make it easier writing useful middleware,
Filters should have their `share` invoked last to process a complete list of
locally available feeds, and should receive first priority on `accept`.

Stores should have their `share` invoked first since they provide the lists of
available feeds, and their `accept` last so that any feeds that reach it must have passed the filters, also they must honor the rule:

> ~~``last `accept` callback in the stack instantiates the feed locally if desired and missing.''~~

### Implementation example
All callbacks are optional, a middleware can for instance implement only the `describe` callback.
```js
const app = {

  // Share available cores
  share (next) {
    next(null, [feed1, feed2, key4]) // Accepts cores or keys (buffer/hexstring)
  },

  // Attach custom meta-data that will be transmitted
  // during core exchange
  describe({ key, meta, resolve }, next) {

    // resolve provides the feed if your middleware requires it.
    resolve((err, feed) => {
      if (err) return next(err) // recover from middleware errors

      next(null, { length: feed.length, timestamp: new Date() })
    })
  },

  // Custom application logic to filter what to accept.
  accept({ key, meta, resolve }, next) {
    const select = meta.type === 'hyperdrive'
    next(null, select)
  },

  // provide core instance via key to other
  // middleware and replication
  resolve(key, next) {
    const feed = findFeedByKeySomehow(key)
    next(null, feed)
  },

  // hook that will be invoked when
  // this middleware gets appended to a replication stack
  mounted(manager, namespace) {
    // exposes possiblity to attach
    // internal/nested middleware
    manager.use(namespace, this.multifeed)
    manager.use(namespace, MyStaleFeedsFilter)

    // Initiate a side-channel replicating bulk resources
    manager.use(namespace + '/attachments', this.drivesMultifeed)
    manager.use(namespace + '/attachments', require('./examples/type-decorator'))
  },

  // Invoked when replication manager is closing
  close () {
    this.multifeed.close()
  }
}

mgr.use(app)
```

## Examples


**Replication filter**

```js
// Given an application that decorates announcement with `lastActivity` timestamp
// Filter stale feeds from replication.
const aWeek = 60*60*24*7*1000
const timeFilter = {
  accept ({key, meta}, next) {
    if (new Date().getTime() - meta.lastActivity < aWeek) {
      next(null, key)
    } else {
      next()
    }
  }
}

mgr.use(timeFilter)
```
**More examples**

* [Array storage](./examples/array-store.js)
* [CoreType decorator](./examples/type-decorator.js)
* [corestore-replic8 adapter](./examples/replic8-corestore.js)

**Backwards compatibility**

Replic8 is my continued work from [multifeed's](https://github.com/kappa-db/multifeed) internal
replication management.

Any application currently using multifeed should have access to the middleware api.

```js
// Multifeed accept an external replic8 instance
const multi = multifeed(ram, aKey, { replicate: mgr})

// -- or --

const multi = multifeed(ram, aKey)
multi.use(mgr)

// Multifeed initializes a new replic8 instance internally if no
// replication manager is present when multi.replicate() or multi.use() is invoked.
```

#### middleware `share: function(next)`

Share a list of cores: `next(null, [...])`

#### middleware `describe: function(context, next)`

TODO: inaccurate

Invoked during connection initialization directly after a successful handshake.

const { key, meta, resolve } = context


`share(key, headers)` - function, takes two arrays, where `keys`
is required to contain only feed-keys and `headers` is expected to contain
serializable Objects.
The length of both arrays is expected to be equal.


#### middleware `accept: function(context, next)`
Invoked when remote end has advertised a list of cores
```js
// Reject/filter a core
next(null, false)

// Let a core pass through to next middleware
next()

// Accept core by returning an instance (ends stack traversal)
const core = hypercore(storage, context.key)
core.ready(() => {
  next(null, core)
})
```


#### middleware `resolve: function(key, next)`

`key` - hex-string

`next` - Function `function(err, core)`

If `middleware.resolve` callback is present, it will be invoked right before replication starts.
It expects you to map any of the requested `keys` to cores
and then invoke the `next` function either with an error or with an array
of cores _"Objects that respond to `key` and `replicate()`"_

If a key has not been resolved by the time all middleware in the stack
has been queried. An `error` event containing a `UnresolvedCoreError`
will be emitted on the manager instance and the peer-connection will be
dropped.<sup>[4](#4)</sup>

#### middleware `mounted: function(manager, namespace)`

Invoked when middleware is added to stack.
Can be used to initialize and add additional middleware.

#### middleware `close: function()`

Invoked when replication manager is closing

#### `mgr.connections`

List of active PeerConnections

#### `mgr.middleware`

The current middleware stack

