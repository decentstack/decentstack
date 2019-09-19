Decentstack
=================


## Welcome to Decentstack docs!
This documentation is being worked on and we're currently
looking for [help to improve this documentation](https://github.com/decentpass/decentpass/issues).

Just as the title states, decentstack aims to be a small application framework that
should abstract a little bit of the hurdles you have to have to pass through
when building an decentralized app.

Decentstack is written out of the motivation to unify the current `kappa-core` & `dat` ecosystem, not by force
but rather with an attempt to find the common denominator between the
two patterns and make a logical clean cut between infrastructure and
application.

So if you're already familiar the technology
then please take a look at [the middleware
interface](/middleware_interface.md)
and [let us hear your thoughts!](https://github.com/decentpass/decentpass/issues/middleware_interface_design)

Else if you're new to the community you might appreciate the [Getting
started guide](./getting_started.md).

Happy to have you!

### What to expect

This project is only a couple of months old and what we have so far is:

__Replication Manager__
- [x] Feed & Metadata exchange protocol
- [x] Replicate anything that talks `hypercore-protocol`
- [x] Keep track of which peers know of which feeds
- [x] Dynamic live feed forwarding
- [ ] Replication Queue & Feed hotswapping
- [ ] hypercore-protocol v7 support

__Middleware Interface__ (functional draft)
- [x] Control feed announcement
- [x] Control metadata
- [x] Multifeed support
- [x] Corestore support (via [wrapper](./examples/replic8-corestore.js))
- [ ] Control replication queue priority


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

