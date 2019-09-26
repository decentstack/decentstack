# API

!> All public methods that involve an asynchroneous operation
support both callback and promise invocation through [deferinfer]()
Having said that, try to avoid using both the promise and the callback at the
same time when invoking a method.


## class `Decentstack`

### Constructor
```
// Factory style
const decentstack = require('decentstack')
const stack = decentstack(key, opts)

// ES6 Class style
const { Decentstack } = require('decentstack')
const stack = new Decentstack(key, opts)
```

### Function: snapshot

`snapshot (namespace = 'default', [keys], [callback])`

**Arguments**

- *optional* `{string} namespace` default: `'default'`
- *optional* `{Array} keys` limits snapshot to specified keys
- *optional* `{Function} callback` node style callback `(error, snapshot)`

**Returns**
- `{Promise<Object>} snapshot`
  - `{Array} keys` shared keys as hex-strings
  - `{Array} meta` decorated metadata, array is same length as `keys` and mapped
    by index.

**Description**

Generates a snapshot of current shares by
iterates through the stack invoking `share`, `decorate` and `hold`
methods on middleware returns a promise of a snapshot

```js
// Promise style
const snapshot = await stack.snapshot()
console.log('My stack currently shares', snapshot)

// Callback style
stack.snapshot('media', (error, {keys, meta}) => {
  if (error) throw error
  for (const i = 0; i < keys.length; i++) {
    console.log('Im sharing key:', keys[i], 'meta:', JSON.stringify(meta[i]))
  }
})
```

### Function: collectMeta

`collectMeta (keyOrFeed, namespace = 'default',  [callback])`

**Arguments**

- `{Object} keyOrFeed` Accepts either a key as a hexstring or `Buffer`, or
  a core
- *optional* `{string} namespace` default: `'default'`
- _optional_ `{Function} callback` node style callback `(error, metadata)`

**Returns**
- `{Promise<Object>} metadata` the merged properties

**Description**

Queries the stack for a given namespace iterating through all middleware
implementing the `describe` method, and returns the final merged properties.

### Function: accept
`accept (namespace = 'default', snapshot, [callback])`

**Arguments**

- *optional* `{string} namespace` default: `'default'`
- `{Object} snapshot` a snapshot containing following keys:
  - `{Array} keys` list of shared keys
  - `{Array} meta` list of shared metadata, same length as `keys`
- *optional* `{Function} callback` node style callback `(error, acceptedKeys)`

**Returns**
- `{Promise<Array>} acceptedKeys` list of hex-string keys that were accepted and
  initialized on local peer

**Description**

Initiates the _Accept_ process, runs the list of keys through all middleware
by invoking the `reject`, `store` methods.

old
---

#### `const stack = decentstack(encryptionKey, opts)`

`encryptionKey` pre-shared-key Buffer(32), used for exchange & meta message encryption
`opts` hypercore-protocol opts

`opts.noforward` the manager keeps track of which
keys have been exchanged to which peers, if a new key is
encountered then by default the manager initiates a new announce
exchange with all active peers that have not been offered that
key yet. This flags turns off that behaviour.

#### `stack.use(namespace, middleware)`

Assembles an application stack where each middleware will be invoked in order of
registration.

`namespace` (optional) creates a virtual sub-exchange channel that helps
prevent a core ending up in the wrong store or being instantiated with wrong
class.

`middleware` should be an object that optionally implements at least one of the
methods defined in [middleware interface](./middleware_interface.md)

#### `stack.key`

Exchange channel encryption key

#### `stack.replicate(initiator, opts)`
Creates a PeerConnection returns it's stream
(compatibility)

returns `stream`

#### `stack.handleConnection(initiator, stream, opts)`
The preffered way to add peer-connections to the manager
as opposite to `stack.replicate()`.

returns `PeerConnection`

#### `stack.close([err,] cb)`

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
