module.exports = Object.freeze({
  EXCHANGE: 'EXCHANGE',
  PROTOCOL_VERSION: 'exchange:1.0.0',
  STATE_INIT: 'init',
  STATE_ACTIVE: 'active',
  STATE_DEAD: 'dead',
  // Default value for how much time the remote peer
  // has to reply to a 'Manifest' before the peer is considered
  // inactive
  REQUEST_TIMEOUT: 500, // TODO: 30 sec is a more realistic value?,
  // Default value for how long we wait
  // before performing strict feed identification
  FEED_IDENTIFICATION_TIMEOUT: 1000
})
