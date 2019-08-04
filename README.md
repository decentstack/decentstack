kappa-db/replic8
=================


> Replication manager for [hypercore](mafintosh/hypercore) & [hypercoreprotocol](mafintosh/hypercore-protocol) compatible data-structures.

##### API Poposal 0.5.0
Request For Comment! [open an issue](https://github.com/telamon/replic8/issues)

This is an working alpha, feedback and testing is highly appreciated!


- [x] Dynamic feed exchange (live + oneshot)
- [x] Track peer-connections and feeds
- [x] Implement middleware interface
- [ ] Realtime feed forwards
- [ ] Provide backwards compatibility with multifeed
- [ ] Update <a href="#api">API-docs</a> outdated!


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
Is up to date `v0.5.0` !
```js
const app = {
  // Collect and share feeds and metadata
  announce({ keys, meta }, next) {
    next(null, keys, meta)
  },

  // Filter incoming shares
  accept({key, meta}, next) {
    const select = meta.type === 'hyperdrive'
    next(null, select)
  },

  // provide instance via key to other
  // middleware and replication
  resolve(key, next) {
    const feed = findFeedByKeySomehow(key)
    next(null, feed)
  }
}

mgr.use(app)
```

## Examples


**Replication filter**
```js
// Given an application that attaches `lastActivity` during announce().
// Filter stale feeds from replication.
const timeFilter = {
  accept ({key, meta}, next) {
    if (new Date().getTime() - data.lastActivity < 60*60*24*30) {
      next(null, key)
    } else {
      next()
    }
  }
}

multifeed.use(timeFilter)
```

**Define a store that uses multifeed as a replication manager**

```js
const ram = require('random-access-memory')
const hypercore = require('hypercore')
const hyperswarm = require('hyperswarm')
const { replicate } = require('multifeed')

// A very optimistic core store
const store = [ hypercore(ram), hypercore(ram), hypercore(ram) ]

// Initialize a new manager
const mgr = replic8(encryptionKey) , opts)

mgr.use({
  announce (manifest, share) {
    // Share all available feeds
    share(store)
  },

  accept (offer, select) {
    // Accept all offered keys
    select(offer.keys)
  },

  resolve (keys, next) {
    const cores = offer.keys.map(key, n) => {
      // fetch core from store
      let core = store.find(c => c.key === key)

      // initialize if not exists
      if (core) return core
        core = hypercore(ram, key) // initialize it using provided key
        store.push(core) // register new core with storage
        selected.push(core) // select it for replication
      }
    })
    next(cores)
  }
})

// Setup swarm
const swarm = hyperswarm.join('some topic')
swarm.on('connection', mgr.connect)
```

**A core type decorator**
```js
const ram = require('random-access-memory')
const multifeed = require('multifeed')
const { replicate } = multifeed

const TypeDecorator = {
  announce: ({keys, meta}, next) {
  keys.forEach(key => {
      this.resolve(key).get(0, (err, data) => {
          // attempt decoding DEP-0007 header
          try {
            const hdr = parseHeader(data)
            // decorate replicated data with core-type
            meta[keys].type = hdr.type
          } catch (err) {
            console.warn('Failed decoding header', key, err)
          }
          next(keys, meta)
      })
    })
  })
}

const mgr = replicate()
// Register 3 instances of multifeed, each hosting different cores
mgr.use(multifeed(ram, (...args) => hypercore(...args)))
mgr.use(multifeed(ram, (...args) => hyperdrive(...args)))
mgr.use(multifeed(ram, (...args) => hypertrie(...args)))
// watch core-type metadata be transmitted to other peers
mgr.use(TypeDecorator)
```

**Backwards compatibility**

If we extend `multifeed` with a new option, it would enable us to mount
multifeed onto an external replication manager.

When option is omitted, multifeed instantiates it's own manager instance
internally.

```js
const multifeed = require('multifeed')
const multi = multifeed(ram, aKey, { replicate: mgr})

// or  mgr.use(multi) pattern better?
```

The `replicate` option can be passed through by both `kappa-core` and higher
level applications

```js
const kappa = require('kappa-core')
const core =  kappa('./log', { valueEncoding: 'json', replicate: mgr })

const Cabal = require('cabal-core')
const cabl = Cabal(ram, null, {replicate: mgr})

// or mgr.use(cabl)
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

`middleware` should be an object that responds to `announce`, `accept` and
optionally `resolve`

#### middleware `announce: function(context, next)`
Invoked during connection initialization directly after a successful handshake.

`manifest` - Object, contains previous middleware results as `{keys:[], headers:[]}`

`share(keys, headers)` - function, takes two arrays, where `keys`
is required to contain only feed-keys and `headers` is expected to contain
serializable Objects.
The length of both arrays is expected to be equal.


#### middleware `accept: function(context, next)`
Invoked when remote end has advertised a list of cores

`offer` - Object supports keys: `keys` and `headers`  representing
the same object that was announced by remote or selected by
the previous middleware.

`select` - Function `function(err, selectedKeys)`
If error is encountered, peer will be dropped?

#### middleware `resolve: function(key, next)`
(*optional*)

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

