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

