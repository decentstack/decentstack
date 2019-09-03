kappa-db/replic8
=================


> Replication manager for [hypercore](mafintosh/hypercore) & [hypercoreprotocol](mafintosh/hypercore-protocol) compatible data-structures.

##### API Poposal 0.7.0
Request For Comment! [open an issue](https://github.com/telamon/replic8/issues)

This is an working alpha, feedback and testing is highly appreciated!


- [x] Dynamic feed exchange (live + oneshot)
- [x] Track peer-connections and feeds
- [x] Implement middleware interface
- [x] Realtime feed forwards
- [x] Provide backwards compatibility with multifeed ([patch available!](https://github.com/telamon/multifeed/tree/feature/replic8-compat))
- [x] Provide corestore support through [middleware wrapper](./examples/replic8-corestore.js)
- [x] Solve expectedFeeds issue to renable composite-core support. ([substreams!](https://github.com/telamon/hypercore-protocol-substream))
- [ ] Test and document `unshare` operation
- [ ] Update <a href="#api">API-docs</a> outdated!
- [ ] Provide connection statistics (transfer rate / transfered bytes / latency)
- [ ] Expose peer-substreams through API to applications/middleware.

## Installation

A pre-release is now available on npm.

```sh
npm i replic8
```

## Usage
```js
const middleware1 = require('...')
const replic8 = require('replic8')
const hyperswarm = require('hyperswarm')

// Communication and exchange encryption
const swarmKey = Buffer.alloc(32)
swarmKey.write('passwords and secrets')

// Initialize a new manger
const mgr = replic8(swarmKey, { live: true })

mgr.on('error', console.error) // Subscribe to all errors

// register some filters or decorators
mgr.use(middleware1)

// lastly register your core storage
mgr.use(aCoreStorage)

const swarm = hyperswarm.join('hash the swarmkey')
swarm.on('connection', mgr.handleConnection)
```

## Middleware Interface
Is up to date `v0.7.0` !

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

## A note on stack-order

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

> ``last `accept` callback in the stack instantiates the feed locally if desired and missing.''

```asciiart
      ( TRANSMITTER )                                ( RECEIVER )
    -----------------------> ---------------> -------------> ------->  FIFO
   ^   _____________                                 _____________   |
0  |  [ FilterA     ]  <- DESCRIBE  |    ACCEPT ->  [ Filter B    ]  |  0
   |   -------------                |                -------------   v
1  |  [ Application ]  <- (any)     |    ACCEPT ->  [ Filter A    ]  |  1
   ^   -------------                                 -------------   |
2  |  [ Decorator   ]  <- DESCRIBE  |    ACCEPT ->  [ Store       ]  |  2
   |   -------------                |                -------------   |
3  |  [ Store       ]  <- SHARE     |                                v
   |   -------------
  LIFO
```

## API

#### `const mgr = replic8(encryptionKey, opts)`

`encryptionKey` pre-shared-key Buffer(32), used for exchange & meta message encryption
`opts` hypercore-protocol opts

`opts.noforward` the manager keeps track of which
keys have been exchanged to which peers, if a new key is
encountered then by default the manager initiates a new announce
exchange with all active peers that have not been offered that
key yet. This flags turns off that behaviour.

#### `mgr.use(namespace, middleware)`

Assembles an application stack where each middleware will be invoked in order of
registration.

`namespace` (optional) creates a virtual sub-exchange channel that helps
prevent a core ending up in the wrong store or being instantiated with wrong
class.

`middleware` should be an object that optionally implements methods:

`share`, `describe`, `accept`, `resolve`, `mounted`, `close`

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

#### `mgr.key`

Exchange channel encryption key

#### `mgr.replicate(opts)`
Creates a PeerConnection returns it's stream
(compatibility)

returns `stream`

#### `mgr.handleConnection(stream)`
The preffered way to add peer-connections to the manager
as opposite to `mgr.replicate()`.

returns `PeerConnection`

#### `mgr.close([err,] cb)`

Closes all active connections and invokes `close`
on all middleware.

#### event `'connected', PeerConnection`

Emitted when a new peer connection is added to manager

#### event `'disconnect', err, PeerConnection`

Emitted whenever a peer connection is dropped

#### event `'error'`

### `PeerConnection`

#### getter `conn.state`

returns current connection state: `init|active|dead`

> There's alot missing from this section, please see
> [source](./lib/peer-connection.js)

## License

This project is based on the research from [kappa-db](https://github.com/kappa-db)
and is licensed accordingly under ISC.

---

<a name="1"></a>
<sup>1.</sup> _exchange swarm_ - A forum where public keys are published and exchanged -
as opposite to a _resource swarm_ where only pre-shared keys are trusted and
replicated.

<a name="2"></a>
<sup>2.</sup> This pattern comes with a drawback that it potentially reduces
the availability & amount of peers on the conventional `resource.discoveryKey` topic.

<a name="3"></a>
<sup>3.</sup> `opts` object already supports `{extensions: []}` key. I'm unsure if
it's worth designing yet another layer of abstraction on top of
that. multifeed/replic8 is in itself built on extension, maybe it's worth
reducing the extension use to a single `exchange` type message that we can apply
for a dat-dep recognition.

<a name="4"></a>
<sup>4.</sup> The reason for mercilessly disconnecting a peer if a core
is not resolved is because
once `announce` and `select` messages have been exchanged
both peers are trusted to replicate the negotiated set of cores;

Unless I'm mistaken, if only one of the two peers replicate a core
then that peer gets a dangling counter that never gets cleared and
the events `end` and `finish` will not be fired properly on the stream.

Therefore it's nicer to drop the connection instead of leaving the other peer
"hanging".

