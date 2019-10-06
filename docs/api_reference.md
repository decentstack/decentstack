# API

!> All public methods that involve an asynchroneous operation
support both callback and promise invocation through [deferinfer](https://github.com/telamon/deferinfer)
Having said that, try to avoid using both promises and the callbacks at the
same time.


## class `Decentstack`
extends `EventEmitter`

### Properties

- _ro_ **key** `{Buffer}` The key used by the exchange channel
- _ro_ **closed** `{boolean}` Flag indicating if the stack is closed, a closed stack should not be reused.

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

### Function: replicate
`replicate (initiator, [opts])`

**Arguments**

- `{boolean} initiator` indicates which end should initiate the Noise handshake
  (set to false if connection was initated remotely, or true if initiated
  locally)
- _optional_ `{Object} opts` hypercore-protocol options

**Returns**

- `{Object} stream` An instance of hypercore-protocol's class `Protocol`

**Description**

Compatibility function, same as `handleConnection` but returns only the stream
from the `PeerConnection` instance.

```js
const stream = stack.handleConnection(true).stream
```

### Function: handleConnection

`stack.handleConnection(initiator, [remoteStream], [opts])`

**Arguments**

- `{boolean} initiator` indicates which end should initiate the Noise handshake
  (set to false if connection was initated remotely, or true if initiated
  locally)
- _optional_ `{Object} remoteStream` Nodejs#Stream compatible instance that will be
  automatically piped into the local connection stream if provided
- _optional_ `{Object} opts` hypercore-protocol options

**Returns**

- `{Object} connection` An instance of class `PeerConnection`

**Description**

Instantiates a new instance of `PeerConnection` and registers it with the
replication manager.

### Function: close

`close ([error], [callback])`

**Arguments**

- _optional_ `{Object} error` Shut down the stack with an error.
- optional `{Function} callback` invoked when stack is closed.

**Description**

Tells the manager to close all peer connections and
notifies all middleware that the stack is destined for the garbage collector.

### Function: registerExtension

`registerExtension ([name], impl)`

**Arguments**

- optional `{String} name` If `impl.name` is defined, then `name` argument can be omitted
- `{Object}` An implementation of hypercore extension
 - `{Function} onmessage (message, peer)` Message handler
 - `{String} name` Name of your extension.
 - `{String|Object} encoding` Message encoding

**Returns**
- `{Object} handle` The same `impl` object provided as input but extended with:
  - `{String} name` Set to `name` argument used during `registerExtension()` if provided
  - `{Function} broadcast(message)` Broadcast message to all peers
  - `{Function} send(message, peer)` Send message to specific peer
  - `{Function} destroy` Unregister the extension.

**Description**

Registers an stack-wide hypercore extension that will be available all connected Peers

```js
const ext = stack.registerExtension('hello', {
  onmessage(message, peer) {
    console.log('Received:', message)
    ext.send('Right back at you', peer)
  }
})
ext.broadcast('Greetings!')
```

!> All extensions registered through this interface use `PeerConnection#exchangeChannel` as transport medium.

### Event: connect

Name: `"connect"`

**Emits**

- `{Object} connection` Instance of PeerConnection

**Description**

Emitted when a registered `PeerConnection` becomes `active`.

(The peer has finished the protocol-handshake and is about start the
feed exchange unless `noTalk` option was set.)

### Event: disconnect

Name: `"disconnect"`

**Emits**

- `{Object} error` presence indicates that connection was dropped due to exception.
- `{Object} connection` Instance of PeerConnection

**Description**

Emitted when a registered `PeerConnection` becomes `dead` and is about to be
unregistered from the manager. (References to the PeerConnection are thrown away
after this point)

`conn.lastError` holds a copy of `error` for future lookups.

## class `PeerConnection`

A peer connection holds the state of a connected peer, keeping track of
what the peer has offered and requested.

Can be thought of as a highlevel wrapper around
the hypercore-protocol `Protocol` class.

### Properties

- _ro_ **initiator** `{boolean}` copy of `initiator` flag during instantiation.
- _ro_ **state** `{string}` current connection state: `init|active|dead`
- _ro_ **stream** `{Object}` hypercore-protocol instance
- _ro_ **activeChannels** `{Array<Channel|Substream>}` list of currently active replication streams via hypercore-protocol Channel or virtual substreams.
- _ro_ **activeKeys** `{Array<string>}` list of actively replicating core keys
- _ro_ **exchangeExt** See `lib/exchange.js` for more info
  - _ro_ **offeredKeys** `{Object<NS:Array<String>>}` list of core keys that have been
    offered on this connection
  - _ro_ **requestedKeys** `{Object<NS:Array<String>>}` list of core keys that were requested
    by us.
  - _ro_ **remoteOfferedKeys** `{Object<NS:Array<String>>}` list of core keys that remote at some point offered to us.
- _ro_ **stats** `{Object}` an object containing exchange-stats:
 - ```{ snapshotsSent: 0,
      snapshotsRecv: 0,
      requestsSent: 0,
      requestsRecv: 0,
      channelesOpened: 0,
      channelesClosed: 0
    }```

### Constructor
`new PeerConnection (initiator, exchangeKey, opts = {})`

**Arguments**

- `{boolean} initiator` indicates which end should initiate the Noise handshake
  (set to false if connection was initated remotely, or true if initiated
  locally)
- `{Buffer|string} exchangeKey` The key that should be used when opening the exchange channel
- `{Object} opts` Same options as hypercore-protocol plus the following extra:
  - ~~`{boolean} useVirtual` use substreams instead of hypercore protocol channels~~ redesign in progress
  - `{Function} onmanifest (snapshot, self)` Manifest received handler
  - `{Function} onrequest (request, self)` ReplicationRequest handler
  - `{Function} onstatechange (newState, prevState, error, peer)` PeerConnection state handler
  - `{Function} onreplicating (key, self)` Core replication start handler
  - `{Function} onopen (self)` When PeerConnection enters state `ESTABLISHED`
  - `{Function} onclose (error, self)` When PeerConnection enters state `DEAD`
  - `{Function} onextension (id, msg, self)` Unregistered extensions are forwarded to this handler

**Description**

Initializes a new `PeerConnection` instance, can be used stand-alone without the
replication manager for unit-tests or a single-connection IPC client.

```js
const key = Buffer.alloc(32)
key.write('hack the planet')

const c1 = new PeerConnection(true, key)
const c2 = new PeerConnection(false, key)

// don't forget to remove attached listeners
c1.on('state-change', console.log.bind(null, 'Conn1 changed state:'))
c2.on('state-change', console.log.bind(null, 'Conn2 changed state:'))

c1.stream.pipe(c2.stream).pipe(c1.stream)
```

### Function: registerExtension

`registerExtension ([name], impl)`

**Arguments**

- optional `{String} name` If `impl.name` is defined, then `name` argument can be omitted
- `{Object}` An implementation of hypercore extension
 - `{Function} onmessage (message, peer)` Message handler
 - `{String} name` Name of your extension.
 - `{String|Object} encoding` Message encoding

**Returns**
- `{Object} handle` The same `impl` object provided as input but extended with:
  - `{String} name` Set to `name` argument used during `registerExtension()` if provided
  - `{Function} broadcast(message)` identical to function `send`
  - `{Function} send(message)` Transmits the message to the remote end of this PeerConnection
  - `{Function} destroy` Unregister the extension.

**Description**

Registers an **Peer Specific** hypercore extension that will be available only to this
peer.

```js
const peer = new PeerConnection(true)
const ext = peer.registerExtension('hello', {
  onmessage(message, peer) {
    console.log('Received:', message)
    ext.send('Right back at you')
  }
})
ext.broadcast('Greetings!')
```

!> All extensions registered through this interface use `PeerConnection#exchangeChannel` as transport medium.

!> When stack-wide and peer-specific extensions with the same `name` are registered. Then the peer-specific extension has priority.

### Function: joinFeed
`TODO: document once api stabilized`

### Function: sendManifest
`TODO: document once api stabilized`

### Function: sendRequest
`TODO: document once api stabilized`

### Function: isActive
`TODO: document once api stabilized`

### Function: kill
`kill ([error])`

**Arguments**

- _optional_ `{Object} error` cause of death

**Description**

Drops the peer gracefully when invoked **without** the `error`.
If `error` was passed, then the connection will be destroyed and an `"error"`
 event will be emitted.

Regardless of error, a `"state-change"` event will be emitted on the
`PeerConnection` instance as this is the function that causes the
state to transition from `init|active` to `dead`.
