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

If you're already familiar [kappa-architecture](https://github.com/kappa-db/)
then please take a look at [the middleware
interface](/middleware_interface.md)
and [let us hear your thoughts!](https://github.com/decentpass/decentpass/issues/middleware_interface_design)

Else if you're new to the community you might appreciate the [Getting
started guide](getting_started.md).

Happy to have you!

## What to expect

This project is only a couple of months old and what we have so far is:

__Replication Manager__
- [x] Feed & Metadata exchange protocol
- [x] Replicate anything that talks `hypercore-protocol`
- [x] Keep track of which peers know of which feeds
- [x] Dynamic live feed forwarding
- [ ] Replication Queue & Feed hotswapping
- [x] hypercore-protocol v7 support

__Middleware Interface__ (functional draft)
- [x] Control feed announcement
- [x] Control metadata
- [ ] Multifeed support
- [ ] Corestore support (via [wrapper](./examples/replic8-corestore.js))
- [ ] Control replication queue priority

