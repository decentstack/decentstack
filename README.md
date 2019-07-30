replic8
=======
##### API Draft 0.2.0

Replication manager for [hypercore-protocol](mafintosh/hypercore-protocol) based data-structures.

### Preface
In a near future where decentralized applications are-aware-of/interact with each other
we can assume that on some swarm topics (_exchange-swarms <sup>[1](#1)</sup>_) - peer connections
might want to replicate multiple applications using a single peer connection.
(_mixed core type replication_)

The goal is not to create one mega-topic where all available data is
transferred to all available peers - but rather provide the ability to side-load secondary resources that are directly referenced.

**use case:** let cabal-chat users offer an optional dat-archive containing shared images/files

It's likely that the target audience for referenced assets is the peer on the other end of the socket.
Thus it makes sense to replicate assets on demand using the already established connection.


**In order to:**
* Replicate multiple stores on the same stream.
* Let apps and stores dynamically exchange keys
* Selective replication by allowing metadata during key exchange
* Provide an intuitive API for core-stores and applications
* Be backwards compatible with existing multifeed & kappa-db applications

**I want to:**
* expose multifeed's superpowers (multiplexer + connection manager) as a standalone library.
* define a straightforward middleware API
* Safely expose hypercore-protocol extensions for middleware

### Examples

Assume the following environment for all examples:

```js
const ram = require('random-access-memory')
const hypercore = require('hypercore')
const replic8 = require('replic8')

// A very optimistic core store
const coreStore = [ hypercore(ram), hypercore(ram), hypercore(ram) ]
```


**Bare minimum**

```js
// Initialize a new manager
const replication = replicate8(encryptionKey) , opts)

replication.use({
  advertise function (peerInfo, share) {
    // Share all known cores, each with an 'isEmpty' header
    share(coreStore, coreStore.map(c => {
      return { isEmpty: !!c.length }
    })
  },

  accept (offer, select) {
    const selectedCores = []

    offer.keys.forEach((key, n) => {
      let core = coreStore.find(c => c.key === key)
      if (core) {
        selected.push(core)
      } else {
        core = hypercore(ram, key) // initialize it using provided key
        coreStore.push(core) // register new core with storage
        selected.push(core) // select it for replication
      }
    })

    select(selected, {forward: true})
  }
})

```


#### `replicate(encryptionKey, opts)`

**encryptionKey** - pre-shared-key Buffer(32)
**opts** - hypercore-protocol opts

#### `mgr.use(namespace, middleware)`
Assembles an application stack where each middleware will be invoked in order of
registration.

`namespace` (optional) 


// We only accept non-empty cores
 if (!offer.headers[n].isEmpty)


// A live peer session
function onPeerConnection (remote) {

  const session = repl(ENCRYPTION_KEY, opts)

  // share( namespace, coreList, headers )
  // namespace  - optional String
  // coreList   - Array<C> where C responds to C.key and
  //              C.replicate()
  // headers    - optional Array<H> where H is a plain
  //              serializable Object '{}'

  // Share all known cores, each with an 'isEmpty' header
  session.share(coreStore, coreStore.map(c => {
    return { isEmpty: !!c.length }
  }))

  // Share a hyperdrive on the same stream
  session.share(MY_APP_NAME, [binaryAssets], [{ type: 'hyperdrive', contentSize: 5432154 }])

  // Define our acceptHandler
  const acceptHandler = (offer, accept) => {
    // offer: { keys: [...], headers: [...] }
    // accept: function(err, [core, core, ...])

    const selected = []

    offer.keys.forEach((key, n) => {
      // find core in our store
      let core = coreStore.find(c => c.key === key)

      if (core) {
        selected.push(core)
      } else if (!offer.headers[n].isEmpty) { // We only accept non-empty cores
        core = hypercore(ram, key) // initialize it using provided key

        coreStore.push(core) // add the new core to our storage
        selected.push(core) // select it for replication

        // Forward core to other connected peers
        otherPeers.forEach(sess => sess.share([core]))
      }
    })

    accept(null, selected)
    // Passing an error should kill the stream and terminate the session?
  }

  // Register our accept handler
  session.on('advertise', acceptHandler)

  // Register a namespaced theoretical accept-handler
  // session.on(MY_APP_NAME, 'advertise', acceptHandler2)
  // Need nicer api for namespacing...

  // OK! Replication is bootstrapped time to connect the pipe
  let p = session.pipe(stream)

  // at the end of stream via 'end' or 'error' event
  eos(p, err => {
    session.off('advertise', acceptHandler) // clean up listener

    if (!err) {
      console.log('Replication completed successfully')
    } else {
      console.log('Replication failed', err)
    }
  })
}

<a name="1"></a>
<sup>1.</sup> _exchange swarm_ - A forum where new public keys are published and exchanged.
