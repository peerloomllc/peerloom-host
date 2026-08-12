// THE MIGRATION TEST. Everything PearTune already shipped must come back out of
// this package byte-identical.
//
// The shared-host proposal's load-bearing compat claim is that "a PearTune host
// built on @peerloom/host speaks byte-identical peartune/pair/1 and
// peartune/media/1, so every paired phone in the field is unaffected", and that
// no host requires re-pairing. Those are claims about exact strings and exact
// hash preimages, which is exactly the kind of thing a refactor breaks silently:
// nothing throws, the host starts, and every phone in the field simply stops
// finding its library.
//
// So the strings are pinned as LITERALS here rather than derived from the
// factory, and the id namespaces are recomputed from first principles the way the
// donor wrote them. A test that asked the factory what it produces and then
// checked the factory produced it would pass through any rename.
//
// If you are changing a value in this file, you are changing data in the field.

const test = require('node:test')
const assert = require('node:assert/strict')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const z32 = require('z32')

const { createProtocol } = require('../src/protocol')

const tune = createProtocol({ app: 'peartune', displayName: 'PearTune' })
const cinema = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })

test('PearTune protocol strings are exactly what shipped', () => {
  assert.equal(tune.PAIR_PROTOCOL, 'peartune/pair/1')
  assert.equal(tune.MEDIA_PROTOCOL, 'peartune/media/1')
  assert.equal(tune.LINK_SCHEME, 'pear://peartune/pair')
  assert.equal(tune.LINK_VERSION, 1)
})

test('PearCinema takes its own topics, so the two never collide on the DHT', () => {
  assert.equal(cinema.PAIR_PROTOCOL, 'pearcinema/pair/1')
  assert.equal(cinema.MEDIA_PROTOCOL, 'pearcinema/media/1')
  assert.equal(cinema.LINK_SCHEME, 'pear://pearcinema/pair')

  assert.notEqual(cinema.PAIR_PROTOCOL, tune.PAIR_PROTOCOL)
  assert.notEqual(cinema.MEDIA_PROTOCOL, tune.MEDIA_PROTOCOL)
  assert.notEqual(cinema.LINK_SCHEME, tune.LINK_SCHEME)
})

test('PearTune id namespaces hash the exact preimages the donor used', () => {
  // Recomputed here rather than asked of the factory. These five strings are the
  // hash preimages that make every libraryId, itemId and topic in the field what
  // it is; change one and the field is orphaned.
  const hostKey = hcrypto.keyPair().publicKey

  const NS_LIBRARY = hcrypto.hash(b4a.from('peartune/library/1'))
  const NS_TRACK = hcrypto.hash(b4a.from('peartune/track/1'))
  const NS_GROUP = hcrypto.hash(b4a.from('peartune/group/1'))
  const NS_LEDGER_TOPIC = hcrypto.hash(b4a.from('peartune/ledger-topic/1'))
  const NS_HOST_TOPIC = hcrypto.hash(b4a.from('peartune/host-topic/1'))

  const expectedLib = z32.encode(hcrypto.hash(b4a.concat([NS_LIBRARY, hostKey])))
  assert.equal(tune.ids.libraryId(hostKey), expectedLib)

  const lib = expectedLib
  const expectedTrack = z32.encode(hcrypto.hash(b4a.concat([
    NS_TRACK, z32.decode(lib), b4a.from('folder'), b4a.from('a/b.flac')
  ])))
  assert.equal(tune.ids.trackId(lib, 'folder', 'a/b.flac'), expectedTrack)

  const expectedGroup = z32.encode(hcrypto.hash(b4a.concat([
    NS_GROUP, z32.decode(lib), b4a.from('folder'), b4a.from('album'), b4a.from('meddle')
  ])))
  assert.equal(tune.ids.groupId(lib, 'folder', 'album', 'meddle'), expectedGroup)

  assert.ok(b4a.equals(
    tune.ids.ledgerTopic(lib),
    hcrypto.hash(b4a.concat([NS_LEDGER_TOPIC, z32.decode(lib)]))
  ))
  assert.ok(b4a.equals(
    tune.ids.hostTopic(hostKey),
    hcrypto.hash(b4a.concat([NS_HOST_TOPIC, hostKey]))
  ))
})

test('a PearTune pairing link encodes exactly as it did', () => {
  const rv = hcrypto.randomBytes(32)
  const hostKey = hcrypto.keyPair().publicKey
  assert.equal(
    tune.link.encodeLink({ rv, hostKey }),
    `pear://peartune/pair?v=1&rv=${z32.encode(rv)}&host=${z32.encode(hostKey)}`
  )
  assert.equal(
    tune.link.encodeLink({ rv, hostKey, name: 'Home', owner: true }),
    `pear://peartune/pair?v=1&rv=${z32.encode(rv)}&host=${z32.encode(hostKey)}&name=Home&owner=1`
  )
})

test('the brand-free constants are shared, not per-app', () => {
  // SCOPE values end up in the grant store on disk. If these ever differed per
  // app, a migration would be reading grants written under other values.
  assert.deepEqual(tune.SCOPE, cinema.SCOPE)
  assert.deepEqual(tune.SCOPE, { FULL: 'full', READONLY: 'readonly', OWNER: 'owner' })
  assert.deepEqual(tune.ERR, cinema.ERR)
  assert.equal(tune.CHUNK_SIZE, 64 * 1024)
  assert.equal(tune.PAIR_TTL_MS, 5 * 60 * 1000)
})

test('an app slug is mandatory and must be a plain slug', () => {
  assert.throws(() => createProtocol(), /needs an app slug/)
  assert.throws(() => createProtocol({ app: '' }), /needs an app slug/)
  assert.throws(() => createProtocol({ app: 'PearCinema' }), /lowercase/)
  assert.throws(() => createProtocol({ app: 'pear cinema' }), /lowercase/)
  assert.throws(() => createProtocol({ app: 'pear/cinema' }), /lowercase/)
})

test('displayName is cosmetic and never reaches the wire', () => {
  const a = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })
  const b = createProtocol({ app: 'pearcinema', displayName: 'Something Else' })
  assert.equal(a.PAIR_PROTOCOL, b.PAIR_PROTOCOL)
  assert.equal(a.MEDIA_PROTOCOL, b.MEDIA_PROTOCOL)
  assert.equal(a.LINK_SCHEME, b.LINK_SCHEME)

  const hostKey = hcrypto.keyPair().publicKey
  assert.equal(a.ids.libraryId(hostKey), b.ids.libraryId(hostKey))
})
