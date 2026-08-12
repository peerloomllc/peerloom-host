// Id derivation.
//
// These ids are load-bearing in a way that is easy to underrate: `libraryId`
// must survive a host restart or the ledger is orphaned, and `itemId` must
// survive a rescan or every resume position, favorite and play count is
// orphaned. A careless refactor of ids.js is a data-loss bug, so it gets pinned.
//
// Moved from PearTune's test/ids.test.js unrewritten except for the factory call
// and the trackId -> itemId rename. Two apps now share this code, which makes the
// cross-app separation tests at the bottom new and necessary.

const test = require('node:test')
const assert = require('node:assert/strict')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')

const { createIds } = require('../src/protocol/ids')

const { libraryId, itemId, ledgerTopic, hostTopic, randomRv } = createIds({ app: 'pearcinema' })

const hostKey = hcrypto.keyPair().publicKey
const lib = libraryId(hostKey)

test('libraryId is deterministic from the host key (survives a restart)', () => {
  assert.equal(libraryId(hostKey), lib)
  assert.equal(libraryId(hostKey), libraryId(hostKey))
})

test('a different host is a different library', () => {
  const other = libraryId(hcrypto.keyPair().publicKey)
  assert.notEqual(other, lib)
})

test('itemId is deterministic and stable across rescans', () => {
  const a = itemId(lib, 'folder', 'Films/Metropolis (1927)/Metropolis.mkv')
  const b = itemId(lib, 'folder', 'Films/Metropolis (1927)/Metropolis.mkv')
  assert.equal(a, b)
})

test('itemId is SOURCE-SCOPED: the same file via folder vs jellyfin differs', () => {
  // Deliberate, and it is why switching sources orphans watch state. See PearTune
  // DECISIONS 2026-07-13. If this test ever "fails" because someone made ids
  // source-agnostic, that is a protocol change, not a bug fix - read the entry.
  const viaFolder = itemId(lib, 'folder', 'abc.mkv')
  const viaJellyfin = itemId(lib, 'jellyfin', 'abc.mkv')
  assert.notEqual(viaFolder, viaJellyfin)
})

test('itemId is scoped to the library: the same path on two hosts differs', () => {
  const otherLib = libraryId(hcrypto.keyPair().publicKey)
  assert.notEqual(itemId(lib, 'folder', 'abc.mkv'), itemId(otherLib, 'folder', 'abc.mkv'))
})

test('itemId rejects missing inputs rather than hashing undefined', () => {
  assert.throws(() => itemId(lib, 'folder', ''), /needs libraryId/)
  assert.throws(() => itemId(lib, '', 'a.mkv'), /needs libraryId/)
  assert.throws(() => itemId('', 'folder', 'a.mkv'), /needs libraryId/)
})

test('ledgerTopic is deterministic per library and namespaced', () => {
  const lt = ledgerTopic(lib)
  assert.equal(lt.byteLength, 32)
  assert.ok(b4a.equals(ledgerTopic(lib), lt))
  // A different library is a different topic.
  assert.ok(!b4a.equals(ledgerTopic(libraryId(hcrypto.keyPair().publicKey)), lt))
})

test('hostTopic is a deterministic 32-byte topic from the host key, both ends agree', () => {
  const topic = hostTopic(hostKey)
  assert.equal(topic.byteLength, 32)
  // Host and phone derive it from the SAME host key -> the same topic.
  assert.ok(b4a.equals(hostTopic(hostKey), topic))
  // A different host is a different topic.
  assert.ok(!b4a.equals(hostTopic(hcrypto.keyPair().publicKey), topic))
  // Namespaced away from the other key-derived ids, so it can never collide with
  // the library id or the ledger topic derived from the same material.
  assert.ok(!b4a.equals(hostTopic(hostKey), ledgerTopic(lib)))
})

test('randomRv yields 32 unguessable bytes', () => {
  const a = randomRv()
  assert.equal(a.byteLength, 32)
  assert.ok(!b4a.equals(a, randomRv()))
})

// --- New: the separation two apps sharing this file now depend on. ---

test('the SAME host key yields a DIFFERENT library id per app', () => {
  // A box running both a PearTune host and a PearCinema host must hold two
  // libraries, not one library reachable by two protocols. The app slug seeds the
  // namespace, so this is structural rather than a convention to remember.
  const tune = createIds({ app: 'peartune' })
  const cinema = createIds({ app: 'pearcinema' })
  assert.notEqual(tune.libraryId(hostKey), cinema.libraryId(hostKey))
  assert.ok(!b4a.equals(tune.hostTopic(hostKey), cinema.hostTopic(hostKey)))
})

test('an app slug is required and must be a plain slug', () => {
  assert.throws(() => createIds({}), /needs an app slug/)
  assert.throws(() => createIds({ app: '' }), /needs an app slug/)
})

test('trackId is kept as an alias of itemId for the PearTune migration', () => {
  const ids = createIds({ app: 'peartune' })
  assert.equal(
    ids.trackId(lib, 'folder', 'a.flac'),
    ids.itemId(lib, 'folder', 'a.flac')
  )
})
