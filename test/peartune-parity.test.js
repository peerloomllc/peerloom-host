// What PearTune's own host already did that this package did not, found by the
// 2026-09-17 drift audit before PearTune moved onto the package
// (../proposals/2026-09-17-peartune-host-migration-plan.md).
//
// The first group matters most. Each of those gaps WROTE WIDER ACCESS INTO THE GRANT
// STORE: a device of a narrowed person ended up seeing the whole library, and
// reverting the code afterwards would not have narrowed it back.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const hcrypto = require('hypercore-crypto')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const Protomux = require('protomux')
const b4a = require('b4a')
const z32 = require('z32')
const { Duplex } = require('streamx')

const { Grants, normalisePaths } = require('../src/grants')
const { PairSession } = require('../src/pair')
const { UserState } = require('../src/state')
const { loadOrCreateSeed, SEED_FILE } = require('../src/identity')
const { resolveDashboardPassword, PASSWORD_FILE } = require('../src/dashboard-auth')
const { serveMedia } = require('../src/media')
const { LibraryHost } = require('../src/server')
const { createProtocol } = require('../src/protocol')
const { SCOPE } = require('../src/protocol/constants')

const protocol = createProtocol({ app: 'peartune', displayName: 'PearTune' })

async function bee (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plh-parity-'))
  const cs = new Corestore(dir)
  const b = new Hyperbee(cs.get({ name: 'x' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await b.ready()
  t.after(async () => {
    await b.close()
    await cs.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return b
}

const key = () => z32.encode(hcrypto.keyPair().publicKey)
const KIDS = [{ root: '/music', rel: 'kids' }]

// --- access that must never widen ----------------------------------------------

test('A DEVICE ASSIGNED TO A NARROWED PERSON SEES WHAT THEY SEE, not everything', async (t) => {
  const g = new Grants(await bee(t))
  const sam = await g.addPerson('Sam')
  const phone = await g.grant({ deviceKey: key(), personId: sam.id })
  await g.setPersonPaths(sam.id, KIDS)

  const tablet = await g.grant({ deviceKey: key() })
  assert.equal(tablet.paths, null)
  const assigned = await g.assign(tablet.deviceKey, sam.id)
  assert.deepEqual(assigned.paths, KIDS, 'the new device took the person\'s narrowing')
  assert.deepEqual((await g.get(phone.deviceKey)).paths, KIDS)

  // A person with no other live device has nothing to copy: the device keeps its own.
  const jo = await g.addPerson('Jo')
  const own = await g.grant({ deviceKey: key(), paths: KIDS })
  assert.deepEqual((await g.assign(own.deviceKey, jo.id)).paths, KIDS)
})

test('A NARROWED DEVICE THAT LEFT AND PAIRS BACK is narrowed to what its person sees NOW', async (t) => {
  const grants = new Grants(await bee(t))
  const kp = hcrypto.keyPair()
  const s = new PairSession({ protocol, identity: { keyPair: kp, publicKey: kp.publicKey, libraryId: protocol.ids.libraryId(kp.publicKey) }, grants, libraryName: 'L' })
  t.after(() => s.close())

  const sam = await grants.addPerson('Sam')
  const leaver = hcrypto.keyPair().publicKey
  await grants.grant({ deviceKey: leaver, personId: sam.id, paths: [{ root: '/music', rel: '' }] })
  const row = await grants.get(leaver)
  row.confirmedUser = 'Sam'
  await grants.bee.put('grant:' + Grants.keyOf(leaver), row, { valueEncoding: 'json' })
  await grants.revoke(leaver, { by: 'self' })

  // Narrowed further while the device was away. setPersonPaths skips revoked rows, so
  // only the live sibling holds the current answer.
  const other = await grants.grant({ deviceKey: key(), personId: sam.id })
  await grants.setPersonPaths(sam.id, KIDS)
  assert.deepEqual(other && (await grants.get(other.deviceKey)).paths, KIDS)

  const sent = []
  await s._onhello({ rv: s.rv, deviceKey: leaver, label: 'phone' }, { destroy () {} }, leaver, { messages: { paired: { send: (m) => sent.push(m) } } })
  const back = await grants.get(leaver)
  assert.equal(back.personId, sam.id)
  assert.deepEqual(back.paths, KIDS, 'the returning device is not handed everything')
  assert.equal(back.confirmedUser, 'Sam', 'and it does not come back reading as unconfirmed')
})

test('AN OWNER WINDOW NAMES NO PATHS, so scanning it cannot narrow or widen anybody', async (t) => {
  const { h } = await host(t)
  h.startPairing({ owner: true, paths: KIDS })
  assert.equal(h.pairSession.paths, undefined)
})

test('a malformed narrowing fails when the window opens, not when a phone scans it', async (t) => {
  const { h } = await host(t)
  assert.throws(() => h.startPairing({ paths: [{ rel: 'kids' }] }), /root/)
  assert.equal(h.pairing, false, 'no QR was shown for it')
  h.startPairing({ paths: [{ root: ' /music ', rel: '/kids/' }] })
  assert.deepEqual(h.pairSession.paths, KIDS, 'stored normalised')
})

test('a window that says nothing and a window that says "everything" are different kinds', async (t) => {
  const { h } = await host(t)
  const silent = h.startPairing()
  assert.notEqual(h.startPairing({ paths: null }), silent, 'null rewrites paired devices, undefined does not')
})

test('paths normalise the way PearTune stored them: trimmed root, forward slashes, no edge separators', () => {
  assert.deepEqual(normalisePaths([{ root: ' /music ', rel: '\\kids\\Lullabies\\' }]), [{ root: '/music', rel: 'kids/Lullabies' }])
  assert.deepEqual(normalisePaths([{ root: '/music', rel: '/' }]), [{ root: '/music', rel: '' }])
  assert.throws(() => normalisePaths([]), /non-empty/)
})

test('setPersonPaths on a person who does not exist is an error, not "0 changed"', async (t) => {
  const g = new Grants(await bee(t))
  await assert.rejects(g.setPersonPaths('nobody', KIDS), /no such person/)
})

// --- the daemon ----------------------------------------------------------------

async function host (t, opts = {}) {
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plh-parity-host-'))
  const h = new LibraryHost({
    protocol,
    dataDir: dir,
    libraryName: 'Test Library',
    bootstrap: testnet.bootstrap,
    media: () => ({ methods: { 'library.list': async () => ({ items: [] }) } }),
    ...opts
  })
  await h.ready()
  t.after(async () => {
    await h.close()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return { h, testnet, dir }
}

function pairOver (testnet, h, link) {
  const dht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const keyPair = HyperDHT.keyPair()
  const conn = dht.connect(h.publicKey, { keyPair })
  conn.on('error', () => {})
  const mux = Protomux.from(conn)
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pairing timed out')), 8000)
    const built = protocol.channels.pairChannel(mux, { id: b4a.from(h.libraryId), onpaired: (m) => { clearTimeout(timer); resolve(m) } })
    built.channel.open()
    built.messages.hello.send({ rv: protocol.link.parseLink(link).rv, deviceKey: keyPair.publicKey, label: 'Phone', platform: 'android' })
  })
  return { dht, keyPair, conn, done }
}

test('A THROWING onDeviceDeleted CANNOT SKIP THE CONNECTION KILL', async (t) => {
  const { h, testnet } = await host(t, { onDeviceDeleted: async () => { throw new Error('disk full') } })
  const dev = pairOver(testnet, h, h.startPairing())
  t.after(() => dev.dht.destroy())
  await dev.done
  await h.revokeDevice(dev.keyPair.publicKey)

  let killed = 0
  const realKill = h.connections.kill.bind(h.connections)
  h.connections.kill = (k) => { killed++; return realKill(k) }
  const res = await h.deleteDevice(dev.keyPair.publicKey)
  assert.ok(res.deleted, 'the delete still landed')
  assert.equal(killed, 1, 'and the kill ran despite the hook throwing')
})

test('claimOwner promotes the device that proves the owner code, once, and refreshes its live grant', async (t) => {
  const { h, testnet } = await host(t)
  const dev = pairOver(testnet, h, h.startPairing())
  t.after(() => dev.dht.destroy())
  await dev.done

  assert.equal((await h.claimOwner(dev.keyPair.publicKey, 'x')).reason, 'no owner window open')
  h.startPairing({ owner: true })
  assert.equal((await h.claimOwner(dev.keyPair.publicKey, z32.encode(b4a.alloc(32)))).reason, 'code mismatch')

  let refreshedWith = null
  h.refreshGrant = (row) => { refreshedWith = row; return 1 }
  const ok = await h.claimOwner(dev.keyPair.publicKey, z32.encode(h.pairSession.rv))
  assert.equal(ok.ok, true)
  assert.equal((await h.grants.get(dev.keyPair.publicKey)).scope, SCOPE.OWNER)
  assert.equal(refreshedWith?.scope, SCOPE.OWNER, 'open connections learn it now, not at reconnect')
  assert.equal(h.pairing, false, 'the window is consumed')
})

test('CLOSING WITHDRAWS THE DISCOVERY RECORD, so lookups stop handing out a dead host', async (t) => {
  const { h } = await host(t)
  const calls = []
  const real = h.dht.unannounce.bind(h.dht)
  h.dht.unannounce = (topic, kp) => { calls.push(topic); return real(topic, kp) }
  await h.close()
  assert.equal(calls.length, 1)
  assert.ok(b4a.equals(calls[0], protocol.ids.hostTopic(h.identity.publicKey)))
})

// --- per-person state ----------------------------------------------------------

test('bookmarks: the key and row PearTune hosts already hold, listed in position order', async (t) => {
  const b = await bee(t)
  const s = new UserState(b)
  await s.addBookmark('p:1', { id: 'b2', trackId: 't1', positionMs: 9000.4, note: 'later' }, { deviceKey: 'dk' })
  await s.addBookmark('p:1', { id: 'b1', trackId: 't1', positionMs: 1000 })
  await s.addBookmark('p:2', { id: 'b3', trackId: 't1', positionMs: 5 })

  const raw = await b.get('bookmark:p:1:t1:b2', { valueEncoding: 'json' })
  assert.deepEqual(Object.keys(raw.value), ['id', 'trackId', 'positionMs', 'note', 'createdAt', 'deviceKey'])
  assert.equal(raw.value.positionMs, 9000)

  assert.deepEqual((await s.listBookmarks('p:1', ['t1'])).map(r => r.id), ['b1', 'b2'])
  await s.removeBookmark('p:1', 't1', 'b1')
  assert.deepEqual((await s.listBookmarks('p:1', ['t1'])).map(r => r.id), ['b2'])

  const video = new UserState(b, { kinds: ['movie'], idField: 'itemId' })
  const row = await video.addBookmark('p:3', { id: 'v', itemId: 'm1', positionMs: 1 })
  assert.equal(row.itemId, 'm1')
})

test('DELETING A PERSON TAKES THEIR BOOKMARKS TOO', async (t) => {
  const s = new UserState(await bee(t))
  await s.addBookmark('p:1', { id: 'b', trackId: 't', positionMs: 1 })
  await s.deleteOwner('p:1')
  assert.deepEqual(await s.listBookmarks('p:1', ['t']), [])
})

test('listResumes keeps PearTune\'s 200-row default; listResume keeps 50', async (t) => {
  const s = new UserState(await bee(t))
  for (let i = 0; i < 60; i++) await s.setResume('p:1', 't' + i, 10 + i, 1000, { playedAt: i + 1 })
  assert.equal((await s.listResumes('p:1')).length, 60)
  assert.equal((await s.listResume('p:1')).length, 50)
})

// --- secrets on disk -----------------------------------------------------------

test('A RESTORED SEED OR PASSWORD FILE IS TIGHTENED TO 0600 ON READ', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-tighten-'))
  const seed = path.join(dir, SEED_FILE)
  fs.writeFileSync(seed, 'ab'.repeat(32), { mode: 0o644 })
  fs.chmodSync(seed, 0o644)
  loadOrCreateSeed(dir)
  assert.equal(fs.statSync(seed).mode & 0o777, 0o600)

  const pw = path.join(dir, PASSWORD_FILE)
  fs.writeFileSync(pw, 'hunter2\n')
  fs.chmodSync(pw, 0o664)
  assert.equal(resolveDashboardPassword({ password: '', bind: '0.0.0.0', dataDir: dir }).source, 'file')
  assert.equal(fs.statSync(pw).mode & 0o777, 0o600)
  fs.rmSync(dir, { recursive: true, force: true })
})

// --- the wire ------------------------------------------------------------------

test('AN APP CAN ANSWER PING ITSELF, so PearTune phones keep reading caps', async (t) => {
  const a = new Duplex({ write (data, cb) { b.push(data); cb() } })
  const b = new Duplex({ write (data, cb) { a.push(data); cb() } })
  const libraryId = protocol.ids.libraryId(hcrypto.keyPair().publicKey)
  const grant = { deviceKey: key(), personId: null, scope: SCOPE.FULL }
  const served = serveMedia({
    protocol, conn: a, libraryId, grant,
    ping: async () => ({ protocol: 1, libraryId, caps: { timeOffset: true } })
  })
  const got = new Promise((resolve) => {
    const built = protocol.channels.mediaChannel(Protomux.from(b), { id: b4a.from(libraryId), onres: (m) => resolve(m.body) })
    built.channel.open()
    built.messages.req.send({ id: 1, method: 'ping', params: {} })
  })
  t.after(() => { try { served.channel.close() } catch {} a.destroy(); b.destroy() })
  const body = await got
  assert.deepEqual(body.caps, { timeOffset: true })
  assert.equal(body.app, undefined, 'the app decides the whole body')
})
