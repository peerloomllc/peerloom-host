// The pairing window.
//
// NEW in the package. PearTune only ever exercised PairSession through its
// 68 KB integration suite, over a real DHT testnet. That test is worth having and
// it is not this one: it proves the whole path works, and it proves nothing about
// which branch refused a bad hello, because a rejection and a hang look identical
// from the far end.
//
// Pairing is where a stranger first touches the grant store, so each refusal gets
// its own case here, driven straight at _onhello with a fake channel. No DHT, no
// clock, no sockets - just "this hello arrived, what landed on disk".

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const hcrypto = require('hypercore-crypto')

const { Grants } = require('../src/grants')
const { PairSession, tokenEquals } = require('../src/pair')
const { createProtocol } = require('../src/protocol')
const { SCOPE } = require('../src/protocol/constants')

const protocol = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })

async function store (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plh-pair-'))
  const cs = new Corestore(dir)
  const bee = new Hyperbee(cs.get({ name: 'g' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  t.after(async () => {
    await bee.close()
    await cs.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return bee
}

function fakeIdentity () {
  const keyPair = hcrypto.keyPair()
  return {
    keyPair,
    publicKey: keyPair.publicKey,
    libraryId: protocol.ids.libraryId(keyPair.publicKey)
  }
}

// A stand-in for the connection and the built channel. Records rather than sends,
// so a test can ask what the host DID instead of watching what a socket carried.
function fakeWire () {
  const sent = []
  let destroyed = 0
  return {
    conn: { destroy () { destroyed++ } },
    built: { messages: { paired: { send (msg) { sent.push(msg) } } } },
    sent,
    get destroyed () { return destroyed }
  }
}

async function session (t, opts = {}) {
  const grants = new Grants(await store(t))
  const identity = fakeIdentity()
  const s = new PairSession({
    protocol,
    identity,
    grants,
    libraryName: 'Test Library',
    ...opts
  })
  t.after(() => s.close())
  return { s, grants, identity }
}

test('a hello with the right token mints a grant and tells the phone where to go', async (t) => {
  const { s, grants, identity } = await session(t)
  const dev = hcrypto.keyPair().publicKey
  const w = fakeWire()

  await s._onhello({ rv: s.rv, deviceKey: dev, label: 'Pixel 9', platform: 'android' }, w.conn, dev, w.built)

  const grant = await grants.get(dev)
  assert.ok(grant, 'a grant was written')
  assert.equal(grant.label, 'Pixel 9')
  assert.equal(grant.scope, SCOPE.FULL)
  assert.equal(grant.grantedBy, 'qr-pair')
  assert.equal(grant.expiresAt, null)

  assert.equal(w.sent.length, 1)
  assert.equal(w.sent[0].libraryId, identity.libraryId)
  assert.equal(w.sent[0].libraryName, 'Test Library')
  assert.equal(w.destroyed, 0)

  // One-shot: the window is spent.
  assert.equal(s.closed, true)
})

test('a WRONG token grants nothing and kills the connection', async (t) => {
  const { s, grants } = await session(t)
  const dev = hcrypto.keyPair().publicKey
  const w = fakeWire()

  await s._onhello({ rv: hcrypto.randomBytes(32), deviceKey: dev, label: 'attacker' }, w.conn, dev, w.built)

  assert.equal(await grants.get(dev), null)
  assert.equal(w.sent.length, 0)
  assert.equal(w.destroyed, 1)
  // Still open: a bad hello must not let anyone burn the operator's window.
  assert.equal(s.closed, false)
})

test('a hello CLAIMING another device\'s key grants nothing', async (t) => {
  // Noise has already proven who the remote is. The hello says who it claims to
  // be. If they disagree, a device is trying to mint a grant for someone else's key.
  const { s, grants } = await session(t)
  const realKey = hcrypto.keyPair().publicKey
  const victimKey = hcrypto.keyPair().publicKey
  const w = fakeWire()

  await s._onhello({ rv: s.rv, deviceKey: victimKey, label: 'liar' }, w.conn, realKey, w.built)

  assert.equal(await grants.get(realKey), null)
  assert.equal(await grants.get(victimKey), null)
  assert.equal(w.destroyed, 1)
})

test('a hello arriving after the window closed grants nothing', async (t) => {
  const { s, grants } = await session(t)
  const dev = hcrypto.keyPair().publicKey
  const w = fakeWire()

  s.close('expired')
  await s._onhello({ rv: s.rv, deviceKey: dev, label: 'late' }, w.conn, dev, w.built)

  assert.equal(await grants.get(dev), null)
  assert.equal(w.destroyed, 1)
})

test('re-scanning on an already-paired phone is idempotent, but honours a new name', async (t) => {
  const { s, grants } = await session(t)
  const dev = hcrypto.keyPair().publicKey
  await grants.grant({ deviceKey: dev, label: 'Old Name' })
  const before = await grants.get(dev)

  const w = fakeWire()
  await s._onhello({ rv: s.rv, deviceKey: dev, label: 'New Name' }, w.conn, dev, w.built)

  const after = await grants.get(dev)
  assert.equal(after.label, 'New Name')
  // The grant itself is untouched - that is the point of idempotence.
  assert.equal(after.grantedAt, before.grantedAt)
  assert.equal(after.revokedAt, before.revokedAt)
  assert.equal(w.sent.length, 1, 'the phone is still told where to go')
})

test('a GUEST window time-limits the grant, and the phone cannot pick its own expiry', async (t) => {
  const { s, grants } = await session(t, { expiresMs: 60_000 })
  const dev = hcrypto.keyPair().publicKey
  const w = fakeWire()

  // The hello asks for a decade. It is not read.
  await s._onhello(
    { rv: s.rv, deviceKey: dev, label: 'guest', expiresAt: Date.now() + 315_360_000_000 },
    w.conn, dev, w.built
  )

  const grant = await grants.get(dev)
  assert.equal(grant.grantedBy, 'qr-guest')
  assert.ok(grant.expiresAt > Date.now())
  assert.ok(grant.expiresAt <= Date.now() + 60_000, 'the operator set the window, not the device')
})

test('an OWNER window mints owner scope, and a phone can never assert it for itself', async (t) => {
  const { s, grants } = await session(t, { owner: true })
  const dev = hcrypto.keyPair().publicKey
  const w = fakeWire()

  await s._onhello({ rv: s.rv, deviceKey: dev, label: 'my phone', scope: SCOPE.OWNER }, w.conn, dev, w.built)
  assert.equal((await grants.get(dev)).scope, SCOPE.OWNER)
  assert.equal((await grants.get(dev)).grantedBy, 'qr-owner')

  // The same hello through a NORMAL window gets FULL, whatever it asked for.
  const plain = await session(t)
  const dev2 = hcrypto.keyPair().publicKey
  const w2 = fakeWire()
  await plain.s._onhello({ rv: plain.s.rv, deviceKey: dev2, label: 'x', scope: SCOPE.OWNER }, w2.conn, dev2, w2.built)
  assert.equal((await plain.grants.get(dev2)).scope, SCOPE.FULL)
})

test('an owner window promotes an already-paired device, a normal window never demotes one', async (t) => {
  const owner = await session(t, { owner: true })
  const dev = hcrypto.keyPair().publicKey
  await owner.grants.grant({ deviceKey: dev, label: 'phone' })

  const w = fakeWire()
  await owner.s._onhello({ rv: owner.s.rv, deviceKey: dev, label: 'phone' }, w.conn, dev, w.built)
  assert.equal((await owner.grants.get(dev)).scope, SCOPE.OWNER)

  // A later normal scan on the same store leaves owner scope alone.
  const s2 = new PairSession({
    protocol,
    identity: owner.identity,
    grants: owner.grants,
    libraryName: 'Test Library'
  })
  t.after(() => s2.close())
  const w2 = fakeWire()
  await s2._onhello({ rv: s2.rv, deviceKey: dev, label: 'phone' }, w2.conn, dev, w2.built)
  assert.equal((await owner.grants.get(dev)).scope, SCOPE.OWNER)
})

test('a device that LEFT BY ITSELF comes home to its person; an operator revoke does not', async (t) => {
  const left = await session(t)
  const devA = hcrypto.keyPair().publicKey
  const person = await left.grants.addPerson('Sam')
  await left.grants.grant({ deviceKey: devA, personId: person.id, label: 'Sam phone' })
  await left.grants.revoke(devA, { by: 'self' })

  const wA = fakeWire()
  await left.s._onhello({ rv: left.s.rv, deviceKey: devA, label: 'Sam phone' }, wA.conn, devA, wA.built)
  assert.equal((await left.grants.get(devA)).personId, person.id, 'self-departure is restored')

  // An OPERATOR revoke is a checkpoint, and re-pairing starts as a stranger.
  const kicked = await session(t)
  const devB = hcrypto.keyPair().publicKey
  const p2 = await kicked.grants.addPerson('Jo')
  await kicked.grants.grant({ deviceKey: devB, personId: p2.id, label: 'Jo phone' })
  await kicked.grants.revoke(devB, { by: 'operator' })

  const wB = fakeWire()
  await kicked.s._onhello({ rv: kicked.s.rv, deviceKey: devB, label: 'Jo phone' }, wB.conn, devB, wB.built)
  assert.equal((await kicked.grants.get(devB)).personId, null, 'an operator revoke is not undone by re-pairing')
})

test('the link is this app\'s scheme and parses back to this session\'s token', () => {
  const identity = fakeIdentity()
  const s = new PairSession({ protocol, identity, grants: null, libraryName: 'Home' })
  const parsed = protocol.link.parseLink(s.link)
  assert.ok(protocol.link.isPairLink(s.link))
  assert.equal(parsed.name, 'Home')
  assert.ok(tokenEquals(parsed.rv, s.rv))
  s.close()
})

test('a PairSession refuses to be built without a protocol', () => {
  assert.throws(
    () => new PairSession({ identity: fakeIdentity(), grants: null, libraryName: 'x' }),
    /needs a protocol/
  )
})

test('tokenEquals is length-checked and rejects non-32-byte input', () => {
  const a = hcrypto.randomBytes(32)
  assert.equal(tokenEquals(a, a), true)
  assert.equal(tokenEquals(a, hcrypto.randomBytes(32)), false)
  assert.equal(tokenEquals(a, hcrypto.randomBytes(16)), false)
  assert.equal(tokenEquals(null, a), false)
  assert.equal(tokenEquals(a, null), false)
})

test('A WINDOW CAN NAME WHAT THE DEVICE MAY SEE, so somebody is let in narrowly rather than narrowed after', async (t) => {
  // PearCinema proposals/2026-08-30-per-person-folders.md, open question 1. Until now a
  // person was let in with the whole library and narrowed on the People page afterwards,
  // which is a window - however short - where they could see everything.
  const paths = [{ root: '/srv/films', rel: 'kids' }]
  const { s, grants } = await session(t, { paths })
  const dev = hcrypto.keyPair().publicKey
  const w = fakeWire()

  await s._onhello({ rv: s.rv, deviceKey: dev, label: 'Kid phone', platform: 'android' }, w.conn, dev, w.built)

  const grant = await grants.get(dev)
  assert.deepEqual(grant.paths, paths, 'the grant is narrowed from its first second')
  assert.equal(grant.scope, SCOPE.FULL, 'and is an ordinary grant in every other way')
})

test('a window that says nothing about folders leaves an existing narrowing alone', async (t) => {
  const dev = hcrypto.keyPair().publicKey
  const { s, grants } = await session(t)
  const w = fakeWire()
  await s._onhello({ rv: s.rv, deviceKey: dev, label: 'phone', platform: 'android' }, w.conn, dev, w.built)
  await grants.setPaths(dev, [{ root: '/srv/films', rel: 'kids' }])

  // Re-scanning an ordinary QR is how somebody re-pairs; it must not quietly widen them.
  // The same store throughout, which is what one host has.
  const again = await session(t, { grants })
  const w2 = fakeWire()
  await again.s._onhello({ rv: again.s.rv, deviceKey: dev, label: 'phone', platform: 'android' }, w2.conn, dev, w2.built)
  assert.deepEqual((await grants.get(dev)).paths, [{ root: '/srv/films', rel: 'kids' }], 'still narrowed')

  // And a window that DOES name folders re-narrows a device that already paired.
  const wide = await session(t, { grants, paths: null })
  const w3 = fakeWire()
  await wide.s._onhello({ rv: wide.s.rv, deviceKey: dev, label: 'phone', platform: 'android' }, w3.conn, dev, w3.built)
  assert.equal((await grants.get(dev)).paths, null, 'a window naming "everything" widens it')
})
