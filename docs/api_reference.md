# API

!> All public methods that involve an asynchroneous operation
support both callback and promise invocation through [deferinfer]()
Having said that, try to avoid using both promises and the callbacks at the
same time.


## class `Decentstack`

### Constructor
`new Decentstack (exchangeKey, options = {})`

**Arguments**
- `{Buffer|string} exchangeKey` The public key that will be used to encrypt
  echange the exchange channel
- _optional_ `{Object} options` valid props are:
  - `{boolean} live = false` stay open after first exchange finished and continue streaming
    data

  - `{boolean} noTalk = false` turn off automatic exchange initiation on
    connect. When off, you have to initiate it manually with
    `stack.startConversation`
  - `{boolean} useVirtual = false` Force all replication streams to be tunneled through virtual substreams (Use this only if you want to replicate non hypercore-protocol:v7 compatible datastructures)
  - TODO:

**Description**

Initializes a new stack:

```js
// Factory style
const decentstack = require('decentstack')
const stack = decentstack(key, opts)

// ES6 Class style
const { Decentstack } = require('decentstack')
const stack = new Decentstack(key, opts)
```
### Function: use
`use (namespace = 'default', app)`

**Argumments**

- `{string} namespace = 'default'` Registers app in specified namespace
- `{Object} app` An object implementing at least one [middleware
  interface](/middleware_interface) method

**Description**

Appends middleware to the stack denoted by `namespace`.
Decentstack can handle multiple stacks in parallell, if
a single stack for some reason is unfeasible, then sort your
middleware into separate namespaces.


```js
stack.use(myApp)  // Append 'myApp' using namespace 'default'
stack.use('media', { ... }) // Append object to namespace 'media'
stack.prepend(authFilter) // prepend an filter into `default` namespace

stack.snapshot(console.log) // log your stack shares.
```
### Function: prepend
`prepend (namespace = 'default', app)`

**Argumments**

- `{string} namespace = 'default'` Registers app in specified namespace
- `{Object} app` An object implementing at least one [middleware
  interface](/middleware_interface) method

**Description**

Same as `Decentstack#use()` except prepends your app to the beginning of the
stack instead of appending it to the end.

### Function: snapshot

`snapshot ([keys], namespace = 'default', [callback])`

**Arguments**

- *optional* `{Array} keys` limits snapshot to specified keys
- `{string} namespace = 'default'`
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
`accept (snapshot, namespace = 'default', [callback])`

**Arguments**

- `{Object} snapshot` a snapshot containing following keys:
  - `{Array} keys` list of shared keys
  - `{Array} meta` list of shared metadata, same length as `keys`
- `{string} namespace = 'default'`
- *optional* `{Function} callback` node style callback `(error, acceptedKeys)`

**Returns**
- `{Promise<Object>} accepted` snapshot after reject filters

**Description**

Runs the list of keys through all middleware implementing the `reject` method.
Useful to for unit-testing middleware, usually invoked when initiating the
_Accept_ process

### Function: store

`store (snapshot, namespace = 'default', [callback])`

**Arguments**

- `{Object} snapshot` a snapshot containing following keys:
  - `{Array} keys` list of shared keys
  - `{Array} meta` list of shared metadata, same length as `keys`
- `{string} namespace = 'default'`
- *optional* `{Function} callback` node style callback `(error, storedKeys)`

**Returns**
- `{Promise<Array>} storedKeys` keys in hex-string format referencing cores that
  are locally stored and are guaranteed to be ready and `resolve`-able

**Description**

Runs the snapshot through all middleware implementing the `store` method.
Useful to for unit-testing middleware, usually used internally during `Accept` phase


# old docs

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
