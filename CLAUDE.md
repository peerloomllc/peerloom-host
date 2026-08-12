# CLAUDE.md

Guidance for Claude Code working in `@peerloom/host`.

Constitution applies. See `/home/tim/peerloomllc/CONSTITUTION.md` for risk tiers,
the proposal gate, the DECISIONS convention and the verify gate.

## What this is

The shared library-host substrate, extracted from PearTune's `host/` and
`protocol/` so PearCinema consumes it instead of copy-forking it. Approved
2026-08-12. Design lives in `../proposals/2026-08-12-shared-host.md`.

Read the README first. It has the module table and the branding API.

## This package is T3 by default

The extracted surface is the firewall gate, the grant store, pairing and the
revoke path - the exact code the Constitution calls security-critical. Assume a
change here is T3 unless you can argue otherwise, and write the proposal.

Two rules that are security bugs if broken:

1. **The grant store is host-local and NEVER replicated.**
2. **Revoke must kill live connections, not just future ones.** `Connections.kill()`
   calls `destroy()` and not `end()`, deliberately. A graceful half-close lets a
   revoked device finish the film.

## The one thing that will break the field silently

`test/brand-compat.test.js` pins PearTune's protocol strings and id hash
preimages as **literals**. Those values are what every paired phone in the field
already holds.

A refactor that changes them throws nothing, starts fine, and orphans every
device - the host is simply not on the topic they look for any more, and every
resume position is filed under an id nobody derives. Never "tidy up" a namespace
string, and never make that test derive its expectations from the factory. A test
that asks the factory what it produces and then checks the factory produced it
passes through any rename.

## What belongs here and what does not

One question: **would a second app need this file essentially unchanged?**

In: admission, grants, identity, pairing, presence, wire mechanics.

Out, and staying app-local: the media method table (the method table IS the app),
adapters, browse, source probes and cast drivers. `media.stream` itself is
destined for this package when the seam lands, because gating a byte stream on a
live grant must not be reimplemented per app. What the adapter returns is the
app's business.

## The app slug is a data identifier

`createProtocol({ app })` seeds the id namespaces. Changing a slug after a
release is a data migration, not a rename: it changes `libraryId`, which changes
every item id derived from it, which orphans every resume position on every
paired phone. `displayName` is the free one - it only reaches error text.

## Do not copy core's overrides block

`@peerloom/core` and `@peerloom/device-link` pin `rocksdb-native`, `bare-fs` and
`bare-path` because iOS links native addons by exact framework version and any
drift is `ADDON_NOT_FOUND` at launch.

**This package runs in Node on a server, not in a Bare worklet on a phone.** No
iOS, no trap. Stated in `package.json` too, so nobody cargo-cults it in - and so
nobody assumes it is safe when a future phone-side extraction happens.

## PearTune has not migrated

Option C from the proposal, deliberately: PearCinema proves the package as a real
second consumer first, and PearTune's migration merges only after the iOS 1.0.0
App Review outcome is known. So `peartune/host/` and `peartune/protocol/` still
hold the originals and are still what ships.

That means a fix made here is **not** a fix made in PearTune. Until the migration
lands, a security fix has to be applied in both places, and the drift window is
bounded and written down rather than pretended away.

## Verify

```
npm test
```

The unit suite is not the acceptance test. Revoke is proved on hardware: pair a
phone, play, revoke mid-playback from the dashboard, and within a second
reconnect is denied and browse, next-item and art all fail. Look at whether the
bytes stop, not at the dashboard reporting the device revoked - the dashboard is
repeating what it was told.

## Branch strategy

Always create a branch before starting work. Never commit directly to master.
Merge via PR.
