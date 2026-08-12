// Blind-relay policy. Pure decisions, no baked-in key.
//
// THE KEY IS NOT IN THIS PACKAGE, deliberately. PearTune bakes one in; PearCinema
// bakes in none, because video at 8 Mbps is 3.6 GB per hour and one person
// watching two hours a day would carry 216 GB/month by themselves against a
// 500 GB/month tier. `relayThroughFor` already returns null the moment `relayKey`
// is null, so "no relay" is a config value rather than an architectural change -
// and keeping the key out of the shared package is what makes that true for every
// consumer instead of true by accident for one.
//
// Each app passes its own key (or null) through `createProtocol({ relayKey })`.

const z32 = require('z32')

// The direct-first relay policy - the function Hyperswarm calls per outbound connect
// (it accepts `relayThrough` as either a key or a `(force, swarm) => key|null` fn).
// Returns the relay key to route through, or null for a direct-only attempt.
//
//   force      - Hyperswarm sets forceRelaying=true after a HOLEPUNCH_ABORTED (the
//                direct punch failed for this peer this session). This is what makes
//                us direct-FIRST: null on the normal attempt, the key only after a fail.
//   randomized - the phone's own NAT is double-randomized, i.e. a direct punch can
//                never work; relay from the first attempt (matches Hyperswarm's own
//                default gate `force || swarm.dht.randomized`).
//   useRelay   - the user's privacy toggle (Settings -> Connection, default true). Off
//                means pure peer-to-peer: never touch a relay, accept that a 0%-punch
//                network simply will not connect.
//   relayKey   - the app's relay key, or null when no relay is configured.
//
// Order matters: the toggle and the "is a relay even configured" check gate first, so
// a user who opted out (or a build with no key at all) never relays regardless of NAT.
function relayThroughFor ({ force, randomized, useRelay, relayKey }) {
  if (!useRelay || !relayKey) return null
  return (force || randomized) ? relayKey : null
}

// Whether a library reachable only THROUGH the relay may stream MEDIA right now
// (PearTune proposal 2026-07-29-relay-audio-consent). Pure, so the decision is
// testable away from the transport.
//
//   relayed - we OFFERED the relay for this library's connection. Recorded by us at the
//             relayThrough call site, not read off the socket: the phone's own
//             dht.stats.relaying reads 0 while actually relaying, and hyperdht keeps the
//             real flag private. Offering is not using, so this can be true of a
//             connection that ended up direct. It errs towards asking.
//   consent - the per-library 'ask' | 'allow' | 'deny', default 'ask'.
//
// Returns what to DO, not a boolean, because "cannot play" has two very different
// shapes: one asks the user, the other is a standing no they already gave.
//
//   'play'   - stream it
//   'ask'    - prompt once, then remember
//   'refuse' - a sticky deny; do not prompt again, the library's settings row is where
//              it gets reversed
//
// NOTE this gates the BYTE STREAM ONLY. Browse, search and artwork cross the relay with
// no prompt (Tim, 2026-07-29): they are kilobytes against media's megabytes, and gating
// them would mean a hard-NAT user opens a library to an empty screen and a dialog - the
// pairing-prompt problem moved one step later rather than solved. That is a DISCLOSED
// trade, not a silent one; the privacy page says so. Do not "tighten this up" by routing
// art or metadata through here without changing the privacy page too.
function relayStreamDecision ({ relayed, consent }) {
  if (!relayed) return 'play'
  if (consent === 'allow') return 'play'
  if (consent === 'deny') return 'refuse'
  return 'ask'
}

// Decode an app's z32 relay key to the raw buffer Hyperswarm wants. null in, null out,
// which is the PearCinema case and must stay a supported value rather than a throw.
function decodeRelayKey (z) {
  return z ? z32.decode(z) : null
}

module.exports = {
  relayThroughFor,
  relayStreamDecision,
  // The donor's name for relayStreamDecision, kept so PearTune's phone migrates
  // without a rename sweep. New consumers should call relayStreamDecision.
  relayAudioDecision: relayStreamDecision,
  decodeRelayKey
}
