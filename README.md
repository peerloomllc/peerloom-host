# @peerloom/host

Shared library-host substrate for PeerLoom apps. Extracted from PearTune so
PearCinema consumes it instead of copy-forking it.

Approved 2026-08-12. Design and rationale live in
`../proposals/2026-08-12-shared-host.md`.

## Why this exists

The suite has copy-forked shared code three times and each copy drifted:
`scripts/release.sh` four ways, the seeder from PearCircle into PearCal, and the
release library that has sat unextracted since 2026-07-23.

PearTune's host is roughly ten times the size of any of those, and it is the
piece where drift is not cosmetic. Two divergent copies of a firewall gate and a
revoke path is a security problem, not a tidiness problem.

## What is in, and the test for it

One question decides every file: **would a second app need this essentially
unchanged?**

| Module | What it is |
| --- | --- |
| `createProtocol` | Brands the whole wire for one app: topics, link scheme, id namespaces, relay key. |
| `gate` | `decide()` says who may OPEN a connection. `Connections` says who may KEEP one. |
| `grants` | The host-local, never-replicated allow-list: people, per-person grants, revoke. |
| `identity` | The 32-byte host seed and the keypair derived from it. |
| `pair` | The `<app>/pair/1` window, QR and link pairing, one-shot tokens. |
| `presence` | Live push senders per device, so the host can speak first. |
| `logprune` | Operator daemon plumbing. |
| `framing` | compact-encoding message shapes. |

A method table does **not** pass the test. The method table IS the app: audio
methods are not video methods. Adapters, browse, cast drivers and source probes
stay app-local for the same reason.

## Branding the wire

```js
const { createProtocol, Grants, PairSession, decide, Connections } = require('@peerloom/host')

const protocol = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })
// protocol.PAIR_PROTOCOL  -> 'pearcinema/pair/1'
// protocol.MEDIA_PROTOCOL -> 'pearcinema/media/1'
// protocol.LINK_SCHEME    -> 'pear://pearcinema/pair'
```

Everything app-specific about the protocol is decided in that one call, and
downstream modules take the returned object rather than reaching for a constant.
That is what makes cross-app isolation structural: a PearTune phone dialing a
PearCinema host completes Noise, opens a mux, asks for `peartune/media/1`, gets
no channel, and goes away. Quiet and total, with no half-connected state.

**The app slug is a data identifier, not a display name.** It seeds the id
namespaces, so `libraryId` and every item id derived from it change if the slug
changes - which orphans every resume position in the field. Pick it once.
`displayName` only reaches error text and may change freely.

## Two rules that are security bugs if broken

1. **The grant store is host-local and never replicated.** If the allow-list
   lived in a shared ledger, a revoked device would still hold a writer key and
   could append a row putting itself back on the list.
2. **Revoke must kill live connections, not just future ones.** The firewall hook
   runs once, at connect time, and never again. Revoking a phone mid-stream would
   otherwise do nothing until it happened to reconnect. `Connections.kill()` is
   the teeth, and `destroy()` rather than `end()` is deliberate: a graceful
   half-close would let a revoked device finish the film.

The acceptance test is on hardware, not in this suite: pair a phone, play,
revoke mid-playback from the dashboard. Within a second, reconnect is denied and
browse, next-item and art all fail. **A green unit suite does not substitute for
it**, because the failure mode is a live socket that does not die.

## No relay key lives here

`relayThroughFor` returns null the moment `relayKey` is null, so "no relay" is a
config value rather than an architectural change. PearTune passes its key;
PearCinema passes none, because video at 8 Mbps is 3.6 GB per hour. Keeping the
key out of the package is what makes that true for every consumer instead of true
by accident for one - and there is a test asserting the package exports no baked
constants at all.

## Consuming it

```json
"@peerloom/host": "file:../peerloom-host"
```

Matching how `@peerloom/core` and `@peerloom/device-link` are already consumed.

**Do not copy `@peerloom/core`'s `overrides` block.** That block pins native
addons because iOS links them by exact framework version and any drift is
`ADDON_NOT_FOUND` at launch. This package runs in Node on a server, not in a Bare
worklet on a phone. No iOS, no trap.

## Status

Phase 1 of the extraction. In the package and tested:

- `createProtocol` and the whole `protocol/` layer
- `gate`, `grants`, `identity`, `presence`, `pair`, `logprune`

Still in PearTune, to follow:

- `server.js` - the HyperDHT server, firewall wiring and connection lifecycle
- the `serveMedia` seam - channel and backpressure shared, method table injected
- `update-check`, `update-apply`
- the Preact dashboard, which may or may not belong here at all (open question 3
  in the proposal)

**PearTune has not migrated yet, by design.** Option C in the proposal: the
package is proven by a real second consumer before the shipped app moves onto it,
and PearTune's migration merges only after the iOS 1.0.0 App Review outcome is
known. `test/brand-compat.test.js` is the standing guarantee that the migration
stays mechanical - it pins PearTune's protocol strings and id preimages as
literals, because a refactor that broke them would throw nothing, start fine, and
simply orphan every phone in the field.

## Testing

```
npm test
```

MIT.
