// Deterministic id derivation, namespaced per app.
//
// Every id here MUST be reproducible from stable inputs, because a host restart
// that changed `libraryId` would orphan the ledger, and a rescan that changed
// `itemId` would orphan every resume position, favorite and play count.
//
// Domain separation is not decoration: these ids are all derived from 32 bytes
// of overlapping material, and an unnamespaced collision between two of them
// would leak one context into another. Every hash below is namespaced, and the
// namespace begins with the APP SLUG - so a PearCinema library id and a PearTune
// library id derived from the same host key are different values, and neither
// app's durable keys can ever collide with the other's.
//
// CHANGING AN APP SLUG IS A DATA MIGRATION, not a rename. It changes libraryId,
// which changes every itemId derived from it, which orphans every resume
// position on every paired phone.

const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const z32 = require('z32')

function toBuf (x) {
  if (b4a.isBuffer(x)) return x
  if (typeof x === 'string') return b4a.from(x)
  throw new Error('expected buffer or string')
}

// `app` is the slug, e.g. 'peartune' or 'pearcinema'. It reproduces the donor's
// namespaces exactly: createIds({ app: 'peartune' }) hashes 'peartune/library/1'
// and friends, byte for byte what PearTune shipped.
function createIds ({ app }) {
  if (!app || typeof app !== 'string') throw new Error('createIds needs an app slug')

  const NS_LIBRARY = hcrypto.hash(b4a.from(`${app}/library/1`))
  const NS_ITEM = hcrypto.hash(b4a.from(`${app}/track/1`))
  const NS_GROUP = hcrypto.hash(b4a.from(`${app}/group/1`))
  const NS_LEDGER_TOPIC = hcrypto.hash(b4a.from(`${app}/ledger-topic/1`))
  const NS_HOST_TOPIC = hcrypto.hash(b4a.from(`${app}/host-topic/1`))

  // The leaf namespace stays the literal string 'track' whatever the app calls
  // its leaves. PearCinema's leaf is a movie or an episode, not a track, and the
  // temptation is to namespace it `pearcinema/movie/1`. Resist it: the namespace
  // is an opaque domain separator, and having one name for it across the suite is
  // what lets the migration test below prove PearTune is unchanged. The wire never
  // sees this string.

  // The library's stable identity, derived from the host's public key. Survives a
  // host restart (same seed -> same keypair -> same libraryId); a NEW host
  // identity is deliberately a clean new library rather than a corrupted old one.
  function libraryId (hostKey) {
    return z32.encode(hcrypto.hash(b4a.concat([NS_LIBRARY, toBuf(hostKey)])))
  }

  // A LEAF id: one playable thing. A track in PearTune, a film or an episode in
  // PearCinema.
  //
  // Source-scoped by design: the same file reached via a Jellyfin server and via a
  // raw folder hashes differently, so switching sources orphans listening state.
  // That is an accepted, warned-about tradeoff - see PearTune DECISIONS 2026-07-13.
  // Do not "fix" this by dropping libraryId or sourceKind from the input without
  // reading that entry first.
  //
  // sourceKind: 'subsonic' | 'jellyfin' | 'folder'
  // sourceKey:  the server's item id, or the library-relative file path.
  function itemId (libId, sourceKind, sourceKey) {
    if (!libId || !sourceKind || !sourceKey) throw new Error('itemId needs libraryId, sourceKind, sourceKey')
    return z32.encode(hcrypto.hash(b4a.concat([
      NS_ITEM,
      z32.decode(libId),
      toBuf(sourceKind),
      toBuf(sourceKey)
    ])))
  }

  // A CONTAINER id, for a source that has none of its own: an album or artist in
  // PearTune, a series or season in PearCinema.
  //
  // Jellyfin and Navidrome hand us their own container ids and we pass them
  // through untouched. A FOLDER has no such thing: an album, or a season, is a
  // fact we infer, so we have to mint the id ourselves - and it has to be stable,
  // or every rescan would hand the phone a fresh set of ids and invalidate its art
  // cache for a library that did not change.
  //
  // Separate namespace from NS_ITEM on purpose. These ids travel the same wire and
  // end up in the same `id` fields; a container id that could collide with a leaf
  // id would be a lookup that silently answers the wrong object.
  //
  // UNLIKE itemId, these are NOT ledger keys - nothing durable is filed under a
  // container id - so their derivation may be changed without orphaning anyone's
  // resume positions. Changing itemId may not. Keep it that way.
  function groupId (libId, sourceKind, type, key) {
    if (!libId || !sourceKind || !type || !key) throw new Error('groupId needs libraryId, sourceKind, type, key')
    return z32.encode(hcrypto.hash(b4a.concat([
      NS_GROUP,
      z32.decode(libId),
      toBuf(sourceKind),
      toBuf(type),
      toBuf(key)
    ])))
  }

  // Steady-state swarm topic for the shared ledger (resume / favorites / counts).
  // Namespaced so it can never collide with any other topic the suite derives.
  function ledgerTopic (libId) {
    return hcrypto.hash(b4a.concat([NS_LEDGER_TOPIC, z32.decode(libId)]))
  }

  // The Hyperswarm discovery topic for a HOST, derived from its 32-byte public key
  // (the raw key buffer, exactly as libraryId takes it - NOT a z32 string). Both
  // ends derive it: the host from its own key, the phone from the hostKey it already
  // holds from pairing. The host announces it, the phone joins it and retries until
  // a hole-punch lands.
  //
  // This exposes NOTHING new. Anyone who knows the host key could already
  // dht.connect(hostKey) today; hashing it into a topic only lets the same peer
  // find the host by lookup instead of by key. Admission is unchanged: the host's
  // firewall still refuses any device without a grant, so finding the host on this
  // topic gets a stranger exactly as far as dialing it by key does - nowhere.
  function hostTopic (hostKey) {
    return hcrypto.hash(b4a.concat([NS_HOST_TOPIC, toBuf(hostKey)]))
  }

  // `trackId` is the donor's name for `itemId` and is kept as an alias so
  // PearTune's host and phone migrate without a rename sweep through code that is
  // not otherwise changing. New consumers should call itemId.
  return { libraryId, itemId, trackId: itemId, groupId, ledgerTopic, hostTopic, randomRv }
}

// One-time pairing token, presented by the phone to prove it saw the QR. Not a
// topic and not namespaced: pairing dials the host by key, and this is 32 random
// bytes with no derivation to separate. See src/pair.js.
function randomRv () {
  return hcrypto.randomBytes(32)
}

module.exports = { createIds, randomRv }
