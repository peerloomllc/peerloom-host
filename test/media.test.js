// The media channel seam.
//
// The package owns the channel and the guarantees; the app owns the method table.
// These tests pin the guarantees, because they are the ones a consumer cannot see
// itself getting wrong: the readonly chokepoint fires ahead of every handler, an
// unknown method degrades instead of wedging the channel, a thrown handler does
// not leak its message to a peer, and the stream loop stops the instant the
// channel closes under it.
//
// Run over a REAL Protomux pair on a duplex, not a fake channel. Registration
// order is the failure this layer exists to prevent and a fake would not have any.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Duplex } = require('streamx')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const z32 = require('z32')

const { serveMedia, ownerOf, MethodError } = require('../src/media')
const { createProtocol } = require('../src/protocol')
const { Presence } = require('../src/presence')
const { ERR, SCOPE } = require('../src/protocol/constants')

const protocol = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })

// A duplex pair, wired to each other. Standing in for the Noise connection the
// firewall admitted - everything above the socket is real from here up.
function pair () {
  const a = new Duplex({ write (data, cb) { b.push(data); cb() } })
  const b = new Duplex({ write (data, cb) { a.push(data); cb() } })
  return [a, b]
}

function fakeGrant (over = {}) {
  return {
    deviceKey: z32.encode(hcrypto.keyPair().publicKey),
    personId: null,
    label: 'test device',
    scope: SCOPE.FULL,
    ...over
  }
}

// Build a host side plus a client side that can call methods and await answers.
function harness (t, opts = {}) {
  const [hostConn, clientConn] = pair()
  const libraryId = protocol.ids.libraryId(hcrypto.keyPair().publicKey)
  const grant = opts.grant || fakeGrant()

  const served = serveMedia({
    protocol,
    conn: hostConn,
    libraryId,
    grant,
    ...opts
  })
  const channel = served?.channel || null

  // The client half, registered through the same factory so the message order
  // cannot drift.
  const Protomux = require('protomux')
  const mux = Protomux.from(clientConn)
  const pending = new Map()
  const chunks = new Map()
  const pushes = []
  let nextId = 1

  const built = protocol.channels.mediaChannel(mux, {
    id: b4a.from(libraryId),
    onres: (m) => { pending.get(m.id)?.resolve({ kind: 'res', body: m.body }) },
    onerr: (m) => { pending.get(m.id)?.resolve({ kind: 'err', code: m.code, message: m.message }) },
    onchunk: (m) => {
      if (!chunks.has(m.id)) chunks.set(m.id, [])
      chunks.get(m.id).push(b4a.from(m.data))
    },
    onend: (m) => { pending.get(m.id)?.resolve({ kind: 'end', total: m.total, data: b4a.concat(chunks.get(m.id) || []) }) },
    onpush: (m) => pushes.push(m)
  })
  built.channel.open()

  t.after(() => {
    try { built.channel.close() } catch {}
    try { channel?.close() } catch {}
    hostConn.destroy()
    clientConn.destroy()
  })

  function call (method, params = {}) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 3000)
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) } })
      built.messages.req.send({ id, method, params })
    })
  }

  // `raw` exposes the client-side messages (req, cancel) and the chunk piles for
  // the cancel tests, which need to speak below the request/response sugar.
  return { call, channel, served, grant, libraryId, pushes, hostConn, raw: built, chunksFor: (id) => chunks.get(id) || [], pending }
}

test('ping is built in, so a probe works before an app registers anything', async (t) => {
  const h = harness(t, { methods: {} })
  const res = await h.call('ping')
  assert.equal(res.kind, 'res')
  assert.equal(res.body.protocol, 1)
  assert.equal(res.body.libraryId, h.libraryId)
  assert.equal(res.body.app, 'pearcinema')
})

test('a handler returning a value has it sent as the response body', async (t) => {
  const h = harness(t, {
    methods: { 'library.list': async (ctx) => ({ items: ['a', 'b'], asked: ctx.params.q }) }
  })
  const res = await h.call('library.list', { q: 'metropolis' })
  assert.equal(res.kind, 'res')
  assert.deepEqual(res.body, { items: ['a', 'b'], asked: 'metropolis' })
})

test('a handler returning undefined has answered for itself', async (t) => {
  const h = harness(t, {
    methods: { 'custom': async (ctx) => { ctx.reply({ mine: true }) } }
  })
  const res = await h.call('custom')
  assert.deepEqual(res.body, { mine: true })
})

test('AN UNKNOWN METHOD DEGRADES: typed error, and the channel survives it', async (t) => {
  const h = harness(t, { methods: { known: async () => ({ ok: true }) } })

  const bad = await h.call('subtitle.burnIn')
  assert.equal(bad.kind, 'err')
  assert.equal(bad.code, ERR.NO_METHOD)

  // The point of the typed error: an old host must degrade in front of a newer
  // client rather than wedge it. The next call still works.
  const good = await h.call('known')
  assert.deepEqual(good.body, { ok: true })
})

test('THE READONLY CHOKEPOINT fires ahead of the handler, not inside it', async (t) => {
  let handlerRan = false
  const h = harness(t, {
    grant: fakeGrant({ scope: SCOPE.READONLY }),
    mutating: ['resume.set'],
    methods: {
      'resume.set': async () => { handlerRan = true; return { ok: true } },
      'resume.get': async () => ({ position: 42 })
    }
  })

  const res = await h.call('resume.set', { position: 10 })
  assert.equal(res.kind, 'err')
  assert.equal(res.code, ERR.FORBIDDEN)
  assert.equal(handlerRan, false, 'the handler must never have been entered')

  // Reading is untouched.
  assert.deepEqual((await h.call('resume.get')).body, { position: 42 })
})

test('DEMOTING A LIVE DEVICE TAKES ITS WRITES AWAY AT ONCE, not at its next connect', async (t) => {
  // The chokepoint read the CONNECT-TIME grant while every other read in media.js
  // follows `liveGrant`, which `setGrant` swaps in place. Nothing exercised the
  // difference because the only caller promotes a device to owner - so a demotion
  // would have shipped as "the phone kept writing for as long as it stayed connected",
  // which is the same shape as revoke not killing live connections.
  const h = harness(t, {
    mutating: ['resume.set'],
    methods: {
      'resume.set': async () => ({ ok: true }),
      'resume.get': async () => ({ position: 42 })
    }
  })

  assert.deepEqual((await h.call('resume.set')).body, { ok: true }, 'full access to begin with')

  assert.equal(h.served.setGrant({ ...h.grant, scope: SCOPE.READONLY }), true)

  const res = await h.call('resume.set')
  assert.equal(res.kind, 'err')
  assert.equal(res.code, ERR.FORBIDDEN, 'the same connection is read-only now')
  // And it is a demotion, not a disconnection: reading still works.
  assert.deepEqual((await h.call('resume.get')).body, { position: 42 })

  // Back the other way, since setGrant is what promotes a device to owner today.
  h.served.setGrant({ ...h.grant, scope: SCOPE.FULL })
  assert.deepEqual((await h.call('resume.set')).body, { ok: true })
})

test('a FULL grant passes the same chokepoint', async (t) => {
  const h = harness(t, {
    mutating: ['resume.set'],
    methods: { 'resume.set': async () => ({ ok: true }) }
  })
  assert.deepEqual((await h.call('resume.set')).body, { ok: true })
})

test('a thrown MethodError becomes its typed code; anything else becomes EINTERNAL', async (t) => {
  const h = harness(t, {
    methods: {
      missing: async (ctx) => { throw ctx.notFound('no such film') },
      nope: async (ctx) => { throw ctx.forbidden('owner only') },
      junk: async (ctx) => { throw ctx.badParams('itemId required') },
      boom: async () => { throw new Error('SELECT * FROM secrets WHERE id=1') }
    },
    log: () => {}
  })

  assert.equal((await h.call('missing')).code, ERR.NOT_FOUND)
  assert.equal((await h.call('nope')).code, ERR.FORBIDDEN)
  assert.equal((await h.call('junk')).code, ERR.BAD_PARAMS)

  const internal = await h.call('boom')
  assert.equal(internal.code, ERR.INTERNAL)
  // An unexpected exception must not hand a peer its message. Telling a caller
  // WHY the host broke is free intelligence.
  assert.equal(internal.message, 'internal error')
  assert.ok(!internal.message.includes('secrets'))
})

test('media.stream pipes bytes and ends with the exact total', async (t) => {
  const { Readable } = require('streamx')
  const payload = b4a.alloc(200 * 1024, 9) // bigger than one 64 KiB frame
  const h = harness(t, {
    openStream: async (params) => {
      if (!params.itemId) throw new MethodError(ERR.BAD_PARAMS, 'itemId required')
      return Readable.from([payload])
    }
  })

  const res = await h.call('media.stream', { itemId: 'abc' })
  assert.equal(res.kind, 'end')
  assert.equal(res.total, payload.length)
  assert.ok(b4a.equals(res.data, payload), 'the bytes arrive intact across frames')
})

test('media.stream: a null opener answers ENOTFOUND, no opener at all answers ENOMETHOD', async (t) => {
  const h = harness(t, { openStream: async () => null })
  assert.equal((await h.call('media.stream', { itemId: 'nope' })).code, ERR.NOT_FOUND)

  const bare = harness(t, { methods: {} })
  assert.equal((await bare.call('media.stream', { itemId: 'x' })).code, ERR.NO_METHOD)
})

test('media.stream validation is the app\'s, and its typed code reaches the peer', async (t) => {
  const h = harness(t, {
    openStream: async (params) => {
      if (!params.itemId) throw new MethodError(ERR.BAD_PARAMS, 'itemId required')
      return null
    }
  })
  const res = await h.call('media.stream', {})
  assert.equal(res.code, ERR.BAD_PARAMS)
  assert.equal(res.message, 'itemId required')
})

test('onStream is told what this host is actually serving', async (t) => {
  const { Readable } = require('streamx')
  const seen = []
  const h = harness(t, {
    openStream: async () => Readable.from([b4a.from('x')]),
    onStream: (params) => seen.push(params.itemId)
  })
  await h.call('media.stream', { itemId: 'metropolis' })
  assert.deepEqual(seen, ['metropolis'])
})

test('THE STREAM LOOP STOPS WHEN THE CHANNEL CLOSES UNDER IT', async (t) => {
  // This is the revoke path seen from inside the byte loop. A revoke destroys the
  // connection; the loop must notice and stop reading the file, rather than
  // grinding through a two-hour film into a socket nobody is holding.
  let framesRead = 0
  // A long film: 400 frames, a tick apart so the cut lands mid-stream rather than
  // racing a synchronous loop. Reading is counted at the SOURCE, which is the
  // question - not "did the socket stop", but "did we stop pulling off the disk".
  async function * longFilm () {
    for (let i = 0; i < 400; i++) {
      framesRead++
      yield b4a.alloc(64 * 1024, 1)
      await new Promise(r => setImmediate(r))
    }
  }

  const h = harness(t, { openStream: async () => longFilm() })
  const done = h.call('media.stream', { itemId: 'long-film' }).catch(() => 'aborted')

  // Let some bytes move, then cut the connection the way a revoke does.
  await new Promise(r => setTimeout(r, 40))
  const readBefore = framesRead
  assert.ok(readBefore > 0, 'bytes were flowing before the cut')
  assert.ok(readBefore < 400, 'the film had not finished on its own')

  h.hostConn.destroy()
  await new Promise(r => setTimeout(r, 150))

  assert.ok(
    framesRead - readBefore <= 2,
    `the loop stopped reading after the cut (read ${framesRead - readBefore} more frames)`
  )
  assert.ok(framesRead < 400, 'the film was abandoned, not finished')
  await Promise.race([done, new Promise(r => setTimeout(() => r('no-answer'), 200))])
})

test('presence: the channel registers on open and unregisters on close', async (t) => {
  const presence = new Presence()
  const grant = fakeGrant()
  const h = harness(t, { presence, grant, methods: {} })

  await h.call('ping')
  assert.equal(presence.count(grant.deviceKey), 1)

  h.channel.close()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(presence.count(grant.deviceKey), 0, 'a dead channel must not stay pushable')
})

test('ctx.push reaches this device; ctx.pushToOwner skips the device that asked', async (t) => {
  const presence = new Presence()
  const grant = fakeGrant({ personId: 'p1' })
  const otherDevice = []
  const h = harness(t, {
    presence,
    grant,
    methods: {
      shout: async (ctx) => { ctx.push('hi', { n: 1 }); return { ok: true } },
      tell: async (ctx) => { ctx.pushToOwner('changed', { n: 2 }); return { ok: true } }
    }
  })
  await h.call('ping')

  // A second device belonging to the same person.
  presence.register('other-device', (evt) => otherDevice.push(evt), ownerOf(grant))

  await h.call('shout')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(h.pushes.length, 1)
  assert.equal(h.pushes[0].kind, 'hi')
  assert.equal(otherDevice.length, 0, 'a device push does not reach the person\'s other devices')

  await h.call('tell')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(otherDevice.length, 1, 'the person\'s other device heard it')
  assert.equal(otherDevice[0].kind, 'changed')
  assert.equal(h.pushes.length, 1, 'the device that made the change did not hear its own news')
})

test('ownerOf reads the grant and never a parameter', () => {
  assert.equal(ownerOf({ personId: 'p1', deviceKey: 'd1' }), 'p:p1')
  assert.equal(ownerOf({ personId: null, deviceKey: 'd1' }), 'd:d1')
})

test('the context exposes authenticated facts, not client-supplied ones', async (t) => {
  let seen = null
  const grant = fakeGrant({ scope: SCOPE.OWNER, personId: 'p9' })
  const h = harness(t, {
    grant,
    methods: { peek: async (ctx) => { seen = ctx; return { ok: true } } }
  })

  // The client claims to be an owner of somebody else. None of it is read.
  await h.call('peek', { scope: SCOPE.OWNER, owner: 'p:someone-else', deviceKey: 'not-mine' })

  assert.equal(seen.scope, SCOPE.OWNER)
  assert.equal(seen.isOwner, true)
  assert.equal(seen.owner, 'p:p9')
  assert.equal(seen.deviceKey, grant.deviceKey)
  assert.equal(seen.grant, grant)
})

test('serveMedia refuses to run without a protocol or a grant', () => {
  const [conn] = pair()
  assert.throws(() => serveMedia({ conn, libraryId: 'x', grant: fakeGrant() }), /needs a protocol/)
  assert.throws(() => serveMedia({ protocol, conn, libraryId: 'x' }), /needs the grant/)
  conn.destroy()
})

// --- stream cancel (proposals/2026-08-14-stream-cancel.md) -------------------
//
// The client's one way to say "stop answering" without destroying the whole
// connection. The guarantees pinned here: the source is destroyed (which is
// what frees the file handle or EPIPEs a transcode's ffmpeg), nothing further
// is sent for the id - not even an end frame - the channel survives, and both
// race orders are legal.

const { Readable } = require('streamx')

// A source that never ends on its own - the shape of a 2 GB film behind an
// abandoned probe. Paced by setImmediate so an endless producer over a fake
// zero-backpressure duplex cannot monopolize the event loop.
function endlessSource () {
  return new Readable({
    read (cb) {
      setImmediate(() => {
        if (!this.destroyed) this.push(b4a.alloc(4096, 7))
        cb(null)
      })
    }
  })
}

test('CANCEL STOPS THE PIPE: source destroyed, no end frame, channel survives', async (t) => {
  let source = null
  const h = harness(t, {
    openStream: async () => { source = endlessSource(); return source }
  })

  // Ask for the stream below the sugar, so the pending map does not time out on
  // a response that is deliberately never coming.
  const id = 999
  h.raw.messages.req.send({ id, method: 'media.stream', params: { trackId: 'x' } })

  // Let some bytes flow, then hang up.
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(h.chunksFor(id).length > 0, 'bytes were flowing before the cancel')
  h.raw.messages.cancel.send({ id })

  // The source dies - that is the whole point: the host stops READING, not just
  // sending, so the file handle or the ffmpeg behind it is freed.
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(source.destroyed, 'the host destroyed the source')

  // Nothing further arrives for the id, and the count settles.
  const at = h.chunksFor(id).length
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(h.chunksFor(id).length, at, 'no chunks after the cancel settled')

  // The channel is alive and well.
  const res = await h.call('ping')
  assert.equal(res.kind, 'res')
})

test('a cancel that races the open kills the stream at birth', async (t) => {
  let source = null
  const h = harness(t, {
    openStream: async () => {
      // The window the pre-cancel set exists for: the cancel lands while the
      // host is still opening - for a segment, still spawning ffmpeg.
      await new Promise((r) => setTimeout(r, 60))
      source = endlessSource()
      return source
    }
  })

  const id = 1000
  h.raw.messages.req.send({ id, method: 'media.stream', params: { trackId: 'x' } })
  await new Promise((r) => setTimeout(r, 10))
  h.raw.messages.cancel.send({ id })

  await new Promise((r) => setTimeout(r, 150))
  assert.ok(source, 'the stream did open')
  assert.ok(source.destroyed, 'and died at birth')
  assert.equal(h.chunksFor(id).length, 0, 'not one chunk was sent')

  const res = await h.call('ping')
  assert.equal(res.kind, 'res')
})

test('a cancel for an unknown id is harmless in both orders', async (t) => {
  const h = harness(t, {
    openStream: async () => Readable.from([b4a.from('abc')])
  })

  // Cancel for an id that never existed.
  h.raw.messages.cancel.send({ id: 424242 })

  // Cancel AFTER a stream finished naturally - the client raced the end frame.
  const done = await h.call('media.stream', { trackId: 'x' })
  assert.equal(done.kind, 'end')
  assert.equal(b4a.toString(done.data), 'abc')
  h.raw.messages.cancel.send({ id: done.id ?? 1 })

  const res = await h.call('ping')
  assert.equal(res.kind, 'res')
})
