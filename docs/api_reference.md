## class `Decentstack`

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

## class `PeerConnection`

#### getter `conn.state`

returns current connection state: `init|active|dead`

> There's alot missing from this section, please see
> [source](./lib/peer-connection.js)
