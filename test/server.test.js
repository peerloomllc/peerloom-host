// The host, end to end, over a real DHT testnet.
//
// THE ACCEPTANCE TEST LIVES HERE, in the sense that a unit suite can hold it:
// pair a device, call a method, revoke it, and watch the connection die. The
// hardware version - pair a phone, play, revoke mid-film, look at the screen -
// still has to be run, because the failure mode this guards is a live socket that
// does not die and a screen that keeps playing. But everything below the screen is
// provable here, and the donor only ever proved it by hand.
//
// Nothing is faked below the method table: real HyperDHT, real Noise, real
// Protomux, real Hyperbee. The firewall's fail-closed behaviour and the pairing
// exemption are the two places where a mistake hands out the library, so they get
// the most cases.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const Protomux = require('protomux')
const b4a = require('b4a')
const z32 = require('z32')

const { LibraryHost } = require('../src/server')
const { createProtocol } = require('../src/protocol')
const { ERR, SCOPE } = require('../src/protocol/constants')

const protocol = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })

const FILMS = {
  'library.list': async () => ({ items: [{ id: 'metropolis', title: 'Metropolis', year: 1927 }] }),
  'resume.set': async (ctx) => ({ saved: ctx.params.position })
}

async function host (t, opts = {}) {
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plh-server-'))

  const h = new LibraryHost({
    protocol,
    dataDir: dir,
    libraryName: 'Test Cinema',
    bootstrap: testnet.bootstrap,
    media: () => ({
      methods: FILMS,
      mutating: ['resume.set'],
      openStream: async (params) => {
        if (params.itemId !== 'metropolis') return null
        const { Readable } = require('streamx')
        return Readable.from([b4a.from('FILMBYTES')])
      }
    }),
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

// A minimal device. Dials the host by key exactly as a phone does, then opens
// whichever channel the test is about.
function device (testnet) {
  const dht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const keyPair = HyperDHT.keyPair()
  return {
    dht,
    keyPair,
    publicKey: keyPair.publicKey,
    connect (hostKey) {
      const conn = dht.connect(hostKey, { keyPair })
      conn.on('error', () => {})
      return conn
    },
    destroy () { return dht.destroy() }
  }
}

function openMedia (conn, libraryId, extra = {}) {
  const mux = Protomux.from(conn)
  const pending = new Map()
  let nextId = 1
  const built = protocol.channels.mediaChannel(mux, {
    id: b4a.from(libraryId),
    onres: (m) => pending.get(m.id)?.({ kind: 'res', body: m.body }),
    onerr: (m) => pending.get(m.id)?.({ kind: 'err', code: m.code, message: m.message }),
    onend: (m) => pending.get(m.id)?.({ kind: 'end', total: m.total }),
    ...extra
  })
  built.channel.open()
  return {
    built,
    call (method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 8000)
        pending.set(id, (v) => { clearTimeout(timer); resolve(v) })
        built.messages.req.send({ id, method, params })
      })
    }
  }
}

// Pair a device through an open window and resolve once the host says paired.
function pairDevice (conn, libraryId, rvLink, dev) {
  const mux = Protomux.from(conn)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pairing timed out')), 8000)
    const built = protocol.channels.pairChannel(mux, {
      id: b4a.from(libraryId),
      onpaired: (m) => { clearTimeout(timer); resolve(m) }
    })
    built.channel.open()
    const parsed = protocol.link.parseLink(rvLink)
    built.messages.hello.send({
      rv: parsed.rv,
      deviceKey: dev.publicKey,
      label: 'Test Phone',
      platform: 'android'
    })
  })
}

const settle = (ms = 300) => new Promise(r => setTimeout(r, ms))

test('THE FIREWALL DENIES A STRANGER when no pairing window is open', async (t) => {
  const { h, testnet } = await host(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const conn = dev.connect(h.publicKey)
  const outcome = await Promise.race([
    new Promise(r => conn.on('open', () => r('opened'))),
    new Promise(r => conn.on('close', () => r('refused'))),
    settle(4000).then(() => 'refused')
  ])
  assert.equal(outcome, 'refused', 'a device with no grant must not get a connection')
})

test('a device pairs through an open window, then reaches the media API', async (t) => {
  const { h, testnet } = await host(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing()
  assert.ok(link.startsWith('pear://pearcinema/pair?'), 'the link carries this app\'s scheme')

  const pairConn = dev.connect(h.publicKey)
  const paired = await pairDevice(pairConn, h.libraryId, link, dev)
  assert.equal(paired.libraryId, h.libraryId)
  assert.equal(paired.libraryName, 'Test Cinema')
  pairConn.destroy()

  // A grant now exists for this device's Noise key, and nothing else.
  const grant = await h.grants.get(dev.publicKey)
  assert.ok(grant)
  assert.equal(grant.label, 'Test Phone')
  assert.equal(grant.scope, SCOPE.FULL)

  // The window is spent, so the exemption is gone - and this device no longer needs it.
  assert.equal(h.pairing, false)

  const conn = dev.connect(h.publicKey)
  const m = openMedia(conn, h.libraryId)

  const pong = await m.call('ping')
  assert.equal(pong.body.libraryId, h.libraryId)
  assert.equal(pong.body.app, 'pearcinema')

  const list = await m.call('library.list')
  assert.equal(list.body.items[0].title, 'Metropolis')

  const stream = await m.call('media.stream', { itemId: 'metropolis' })
  assert.equal(stream.kind, 'end')
  assert.equal(stream.total, 9)

  conn.destroy()
})

test('THE PAIRING EXEMPTION IS PAIRING ONLY: an admitted stranger gets no media channel', async (t) => {
  // The firewall lets an ungranted device in while a window is open, because a
  // device that has never paired HAS no grant. That admission must reach the pairing
  // channel and nothing else - otherwise "open the window" would mean "hand the
  // library to anyone who dials in during the next five minutes".
  const { h, testnet } = await host(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  h.startPairing()

  const conn = dev.connect(h.publicKey)
  const m = openMedia(conn, h.libraryId)

  const outcome = await Promise.race([
    m.call('library.list').then(() => 'answered').catch(() => 'no-answer'),
    new Promise(r => conn.on('close', () => r('cut'))),
    settle(4000).then(() => 'no-answer')
  ])
  assert.notEqual(outcome, 'answered', 'an unpaired device must never be served the library')
  assert.equal(await h.grants.get(dev.publicKey), null, 'and it minted no grant on the way')
})

test('REVOKE CUTS A LIVE CONNECTION, not just the next one', async (t) => {
  const { h, testnet } = await host(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing()
  const pairConn = dev.connect(h.publicKey)
  await pairDevice(pairConn, h.libraryId, link, dev)
  pairConn.destroy()

  const conn = dev.connect(h.publicKey)
  const m = openMedia(conn, h.libraryId)
  await m.call('ping')

  const closed = new Promise(r => conn.on('close', () => r('closed')))
  assert.equal(h.connections.count(z32.encode(dev.publicKey)), 1)

  const { killed } = await h.revokeDevice(dev.publicKey)
  assert.ok(killed >= 1, 'the revoke destroyed a live connection')

  const outcome = await Promise.race([closed, settle(3000).then(() => 'still-alive')])
  assert.equal(outcome, 'closed', 'the socket must die, not merely be marked revoked')

  // And it cannot come back.
  const again = dev.connect(h.publicKey)
  const back = await Promise.race([
    new Promise(r => again.on('open', () => r('readmitted'))),
    new Promise(r => again.on('close', () => r('refused'))),
    settle(4000).then(() => 'refused')
  ])
  assert.equal(back, 'refused')
  again.destroy()
})

test('revoke calls silence(), because a cast target is not a HyperDHT connection', async (t) => {
  // connections.kill() cannot reach a Chromecast: the bytes arrive from this process,
  // not from the revoked phone. Without an active stop the film keeps playing in the
  // room. The hardware test is to look at the TV; this one just proves the host asks.
  const silenced = []
  const { h, testnet } = await host(t, {
    silence: async (deviceKey) => { silenced.push(deviceKey); return 1 }
  })
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing()
  const pairConn = dev.connect(h.publicKey)
  await pairDevice(pairConn, h.libraryId, link, dev)
  pairConn.destroy()

  const res = await h.revokeDevice(dev.publicKey)
  assert.deepEqual(silenced, [z32.encode(dev.publicKey)])
  assert.equal(res.silenced, 1)
})

test('a failing silence() does not stop the revoke landing', async (t) => {
  const { h, testnet } = await host(t, {
    silence: async () => { throw new Error('the TV is unplugged') }
  })
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing()
  const pairConn = dev.connect(h.publicKey)
  await pairDevice(pairConn, h.libraryId, link, dev)
  pairConn.destroy()

  const res = await h.revokeDevice(dev.publicKey)
  assert.ok(res.grant.revokedAt, 'the tombstone was still written')
  assert.equal(res.silenced, 0)
  assert.equal((await h.grants.get(dev.publicKey)).revokedAt > 0, true)
})

test('an expired guest is swept off a live connection', async (t) => {
  const { h, testnet } = await host(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  // A guest window with a window so short it has already lapsed by the time we sweep.
  const link = h.startPairing({ expiresMs: 50 })
  const pairConn = dev.connect(h.publicKey)
  await pairDevice(pairConn, h.libraryId, link, dev)
  pairConn.destroy()

  const conn = dev.connect(h.publicKey)
  const m = openMedia(conn, h.libraryId)
  await m.call('ping')
  const closed = new Promise(r => conn.on('close', () => r('closed')))

  await settle(100) // let the grant lapse
  await h._sweepExpired()

  const outcome = await Promise.race([closed, settle(3000).then(() => 'still-alive')])
  assert.equal(outcome, 'closed', 'a guest that expires WHILE connected is cut')
})

test('the sweep also looks at devices with no live connection', async (t) => {
  // A phone can start a cast and close the app. A connection-only sweep would never
  // look at that device again, so an expiring guest grant would leave a film running.
  const stopped = []
  const dev = { key: null }
  const { h, testnet } = await host(t, {
    extraLiveKeys: () => (dev.key ? [dev.key] : []),
    silence: async (k) => { stopped.push(k); return 1 }
  })
  const d = device(testnet)
  t.after(() => d.destroy())

  const link = h.startPairing({ expiresMs: 50 })
  const pairConn = d.connect(h.publicKey)
  await pairDevice(pairConn, h.libraryId, link, d)
  pairConn.destroy()
  dev.key = z32.encode(d.publicKey)

  await settle(100)
  assert.equal(h.connections.count(dev.key), 0, 'no live connection at all')
  await h._sweepExpired()
  assert.deepEqual(stopped, [dev.key], 'the cast target was still stopped')
})

test('a READONLY grant is refused at the chokepoint over the real wire', async (t) => {
  const { h, testnet } = await host(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing()
  const pairConn = dev.connect(h.publicKey)
  await pairDevice(pairConn, h.libraryId, link, dev)
  pairConn.destroy()

  await h.grants.setScope(dev.publicKey, SCOPE.READONLY)

  const conn = dev.connect(h.publicKey)
  const m = openMedia(conn, h.libraryId)
  const res = await m.call('resume.set', { position: 12 })
  assert.equal(res.kind, 'err')
  assert.equal(res.code, ERR.FORBIDDEN)

  // Reading is untouched.
  assert.equal((await m.call('library.list')).kind, 'res')
  conn.destroy()
})

test('an owner window mints owner scope over the real wire', async (t) => {
  const { h, testnet } = await host(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing({ owner: true })
  assert.match(link, /owner=1/)
  const conn = dev.connect(h.publicKey)
  await pairDevice(conn, h.libraryId, link, dev)
  conn.destroy()

  assert.equal((await h.grants.get(dev.publicKey)).scope, SCOPE.OWNER)
})

test('startPairing reuses a window of the same kind and replaces one of another', async (t) => {
  const { h } = await host(t)

  const normal = h.startPairing()
  assert.equal(h.startPairing(), normal, 'the same kind is reused')

  const guest = h.startPairing({ expiresMs: 60_000 })
  assert.notEqual(guest, normal, 'a guest window replaces a permanent one')

  const owner = h.startPairing({ owner: true })
  assert.notEqual(owner, guest)
  assert.match(owner, /owner=1/)
  // An owner window is never time-limited, whatever it was asked for.
  assert.equal(h.pairSession.expiresMs, null)

  h.stopPairing()
  assert.equal(h.pairing, false)
})

test('listDevices reports who is online and who each device belongs to', async (t) => {
  const { h, testnet } = await host(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing()
  const pairConn = dev.connect(h.publicKey)
  await pairDevice(pairConn, h.libraryId, link, dev)
  pairConn.destroy()
  await settle(200)

  const person = await h.grants.addPerson('Tim')
  await h.grants.assign(dev.publicKey, person.id)

  const conn = dev.connect(h.publicKey)
  openMedia(conn, h.libraryId)
  await settle(500)

  const rows = await h.listDevices()
  const row = rows.find(r => r.deviceKey === z32.encode(dev.publicKey))
  assert.ok(row)
  assert.equal(row.online, true)
  assert.equal(row.belongsTo, 'Tim')
  conn.destroy()
})

test('ASSIGNMENT REACHES A LIVE CONNECTION - the owner changes under an open channel', async (t) => {
  // The gap this pins: a grant used to travel at connect time only, so a phone
  // watching mid-assignment kept filing positions under the old owner until it
  // reconnected. assignDevice must swap the snapshot in place, move the
  // presence registration to the new owner and tell the device.
  const { h, testnet } = await host(t, {
    media: () => ({
      methods: {
        whoami: async (ctx) => ({ owner: ctx.owner, personId: ctx.grant.personId || null })
      }
    })
  })
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing()
  const pairConn = dev.connect(h.publicKey)
  await pairDevice(pairConn, h.libraryId, link, dev)
  pairConn.destroy()
  await settle(200)

  const pushes = []
  const conn = dev.connect(h.publicKey)
  const media = openMedia(conn, h.libraryId, { onpush: (m) => pushes.push(m) })
  t.after(() => conn.destroy())
  await settle(500)

  // Unassigned: its own owner, keyed by its device.
  const dk = z32.encode(dev.publicKey)
  const before = await media.call('whoami')
  assert.equal(before.body.owner, 'd:' + dk)

  // Assign WHILE CONNECTED. The same channel now answers as the person.
  const ada = await h.grants.addPerson('Ada')
  const out = await h.assignDevice(dev.publicKey, ada.id)
  assert.equal(out.refreshed, 1, 'the live connection was refreshed in place')
  assert.equal(out.notified, 1, 'the device was told')

  const after = await media.call('whoami')
  assert.equal(after.body.owner, 'p:' + ada.id)
  assert.equal(after.body.personId, ada.id)

  // The nudge arrived over the wire, typed.
  await settle(200)
  const nudge = pushes.find((p) => p.kind === 'grant:changed')
  assert.ok(nudge, 'grant:changed reached the device')
  assert.equal(nudge.data.personId, ada.id)

  // Presence moved with the assignment: a push to the PERSON now reaches this
  // device, and a push to the old owner key reaches nobody.
  assert.equal(h.presence.notifyOwner('p:' + ada.id, 'ping'), 1)
  assert.equal(h.presence.notifyOwner('d:' + dk, 'ping'), 0)

  // Detaching applies live the same way, back to its own owner.
  await h.assignDevice(dev.publicKey, null)
  const detached = await media.call('whoami')
  assert.equal(detached.body.owner, 'd:' + dk)
})

test('the host refuses to be built without a protocol or a dataDir', () => {
  assert.throws(() => new LibraryHost({ dataDir: '/tmp/x' }), /needs a protocol/)
  assert.throws(() => new LibraryHost({ protocol }), /needs a dataDir/)
})
