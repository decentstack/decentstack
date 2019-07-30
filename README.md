replic8
=======

multiplexing replication manager for hypercore-protocol based data-structures.


In order to:
* Provide replication for multiple stores on the same stream.
* Let apps and stores dynamically exchange feeds
* Selective replication by allowing metadata during key exchange
* Provide a standard API for core-stores

I want to expose multifeed's superpowers as a standalone library.


API Draft 0.1.0

```js
const ram = require('random-access-memory')
const hypercore = require('hypercore')
const hyperdrive = require('hyperdrive')
const eos = require('end-of-stream')
const repl = require('replic8')

const MY_APP_NAME = 'p2pftw'

// A very optimistic core store
const coreStore = [ hypercore(ram), hypercore(ram), hypercore(ram) ]
const binaryAssets = [ hypedrive(ram) ]

// A live peer session
function onPeerConnection (remote) {

  // encryptionKey - a pre-shared-known 32byte Buffer
  // opts - all hypercore-protocol opts + extensions
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

```

