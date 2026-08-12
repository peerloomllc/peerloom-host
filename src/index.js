// @peerloom/host - the shared library-host substrate.
//
// Extracted from PearTune so PearCinema consumes it instead of copy-forking it.
// The suite has copy-forked shared code three times (release.sh four ways, the
// seeder into PearCal, the unextracted release library) and each time the copies
// drifted. Here drift is not cosmetic: two divergent copies of a firewall gate
// and a revoke path is a security problem.
//
// WHAT IS IN HERE is decided by one test: "would a second app need this file
// essentially unchanged?" The auth gate, the grant store, pairing and the wire
// mechanics pass it. A method table does not - the method table IS the app, and
// audio methods are not video methods.
//
// See ../proposals/2026-08-12-shared-host.md.

const { createProtocol, constants, framing, relay } = require('./protocol')

const gate = require('./gate')
const grants = require('./grants')
const identity = require('./identity')
const presence = require('./presence')
const pair = require('./pair')
const logprune = require('./logprune')

module.exports = {
  // The one call that brands the wire for an app.
  createProtocol,

  // Admission. decide() says who may OPEN a connection; Connections says who may
  // KEEP one. Shipping only the first is the bug gate.js exists to prevent.
  decide: gate.decide,
  sweepKills: gate.sweepKills,
  carryOverPerson: gate.carryOverPerson,
  Connections: gate.Connections,

  // The host-local, NEVER-REPLICATED allow-list. If this lived in a shared
  // ledger, a revoked device would hold a writer key and could append itself
  // back onto the list.
  Grants: grants.Grants,
  personLabels: grants.personLabels,

  createIdentity: identity.createIdentity,
  loadOrCreateSeed: identity.loadOrCreateSeed,
  SEED_FILE: identity.SEED_FILE,

  Presence: presence.Presence,
  notifyOwners: presence.notifyOwners,

  PairSession: pair.PairSession,
  tokenEquals: pair.tokenEquals,

  pruneRocksLogs: logprune.pruneRocksLogs,

  // Brand-free wire pieces, for consumers that want them without a protocol
  // object in hand.
  constants,
  framing,
  relay
}
