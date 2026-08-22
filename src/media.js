// Host side of <app>/media/1 - the CHANNEL, not the methods.
//
// THIS FILE IS THE SEAM THE WHOLE EXTRACTION TURNS ON.
//
// PearTune's `serveMedia` owned two things at once: the channel lifecycle, which
// every app needs unchanged, and a fifty-case method table, which IS the app.
// Audio methods are not video methods, and pretending otherwise would have meant
// PearCinema inheriting `speaker.volume` and PearTune inheriting `subtitle.list`.
//
// So the split is: the package owns the channel, the registration order, the
// presence registration, the scope chokepoint, backpressure, chunking, and the
// typed-error contract. The consumer hands in a method table and a stream opener.
//
// WHY `media.stream` STAYS HERE. Gating a byte stream on a live grant is
// security-critical and must not be reimplemented per app - it is the one method
// where a mistake hands out the library rather than an error message. What the
// adapter RETURNS is the app's business; what has to be true before a single byte
// moves is not.
//
// We do NOT tunnel a raw port (PearTune DECISIONS 2026-07-13). A tunnel would hand
// a guest the media server's entire surface plus its credentials, make per-request
// scope enforcement impossible, and teach the app to speak someone else's protocol
// - which would quietly demote the raw-folder adapter to a second-class citizen.
// The host answers a normalized API and the adapters sit behind it.

const Protomux = require('protomux')
const b4a = require('b4a')

const { CHUNK_SIZE, ERR, SCOPE } = require('./protocol/constants')

// A handler's way of refusing with a TYPED code instead of a 500. Anything else a
// handler throws is logged and answered EINTERNAL, because an unexpected exception
// is not a message we want to hand a peer.
class MethodError extends Error {
  constructor (code, message) {
    super(message || code)
    this.code = code
    this.name = 'MethodError'
  }
}

const badParams = (m) => new MethodError(ERR.BAD_PARAMS, m || 'bad params')
const notFound = (m) => new MethodError(ERR.NOT_FOUND, m || 'not found')
const forbidden = (m) => new MethodError(ERR.FORBIDDEN, m || 'forbidden')

// WHO owns the user state on this connection. Derived from the grant the firewall
// looked up from the Noise-authenticated remote key - NEVER from a client parameter,
// which is the whole reason host-as-hub is safe (there is nothing to forge). A device
// assigned to a person owns state as that person (so their phone and tablet share it);
// an unclaimed device is its own owner until the operator confirms a claim.
function ownerOf (grant) {
  return grant.personId ? 'p:' + grant.personId : 'd:' + grant.deviceKey
}

// The methods the package itself enforces as mutating. Consumers add their own via
// `mutating`; they never REPLACE this set, so a new app cannot ship having quietly
// dropped one.
const BASE_MUTATING = new Set(['media.stream.write'])

function serveMedia ({
  protocol,
  conn,
  libraryId,
  grant,

  // name -> async (ctx) => body | undefined.
  //
  // Returning undefined means "I already answered" (via ctx.reply, ctx.stream or
  // deliberate silence). Returning anything else sends it as the response body,
  // which is what makes the common handler a one-liner.
  methods = {},

  // Method names a READONLY grant may not call. Refused at this chokepoint rather
  // than at the adapter, so a new mutating method cannot accidentally ship without
  // a scope check.
  mutating = [],

  // async (params, ctx) => Readable | null. Serves media.stream. Returning null is
  // ENOTFOUND; throwing a MethodError is that code; the package does the rest.
  // Absent means this host serves no byte streams at all, and media.stream is
  // ENOMETHOD rather than a crash.
  openStream = null,

  // Called with the streamed item's params after the stream opens. THIS host is the
  // one serving these bytes, which is the only thing it knows for certain about what
  // a device is playing.
  onStream = null,

  presence = null,
  log = () => {}
}) {
  if (!protocol || !protocol.channels) throw new Error('serveMedia needs a protocol from createProtocol()')
  if (!grant) throw new Error('serveMedia needs the grant the firewall authenticated')

  const mutatingSet = new Set([...BASE_MUTATING, ...mutating])
  const mux = Protomux.from(conn)

  // Set once the channel is open (below). Called on close to drop this connection's push
  // sender from the presence registry, so a dead channel is never pushed to.
  let unregisterPresence = () => {}

  // The streamed responses currently in flight, request id -> { source, cancelled }.
  // This is what a cancel frame reaches for: destroy the source, flag the pipe.
  const liveStreams = new Map()

  // Cancels that arrived BEFORE their stream started piping. The window is real:
  // an abandoned probe cancels milliseconds after requesting, and the request may
  // still be inside openStream - for a transcoded segment that is an ffmpeg spawn.
  // Bounded, because a peer could send cancels for ids that will never exist.
  const preCancelled = new Set()
  const PRE_CANCELLED_MAX = 128

  // Registration order is fixed in protocol/channels.js and MUST match the client's.
  // Do not hand-roll addMessage here - see the note in that file.
  const built = protocol.channels.mediaChannel(mux, {
    id: b4a.from(libraryId),
    onclose: () => { unregisterPresence(); log('media:channel-closed') },
    onreq: async (m) => {
      try {
        await dispatch(m)
      } catch (e) {
        if (e instanceof MethodError) return safeErr(m?.id ?? 0, e.code, e.message)
        log('media:dispatch-failed', { method: m?.method, err: e?.message })
        safeErr(m?.id ?? 0, ERR.INTERNAL, 'internal error')
      }
    },
    // The client no longer wants this response - an abandoned probe, a closed
    // player, a scrub past a transcoding segment. Destroying the source is what
    // frees the real work behind it: a file read closes, and a transcode's pipe
    // teardown EPIPEs its ffmpeg, which exits and frees the pool slot. An id we
    // no longer hold (already finished, never streamed) is silently fine - the
    // race against a natural end is legal in both orders by design.
    oncancel: (m) => {
      const live = liveStreams.get(m.id)
      if (!live) {
        // Not piping yet - remember the id so a stream still opening dies at
        // birth instead of streaming to a client that already hung up.
        preCancelled.add(m.id)
        if (preCancelled.size > PRE_CANCELLED_MAX) {
          const oldest = preCancelled.values().next().value
          preCancelled.delete(oldest)
        }
        return
      }
      live.cancelled = true
      try { live.source.destroy?.() } catch {}
      log('media:cancelled', { id: m.id })
    }
  })

  if (!built) return null

  const { channel } = built
  const send = built.messages

  channel.open()

  // `let`, both of them: a grant is a row in a store the operator can change
  // while this connection is live, and setGrant below swaps the snapshot. In-
  // flight requests keep the context they started with; every request after
  // the swap reads the new one (contextFor runs per message).
  let liveGrant = grant
  let owner = ownerOf(liveGrant)

  const pushToDevice = (evt) => { try { send.push.send(evt) } catch {} }

  // This connection is now reachable by an unsolicited push. Keyed by the grant's device -
  // the one the firewall authenticated - so a session claim on ANOTHER connection can reach it.
  if (presence) {
    unregisterPresence = presence.register(liveGrant.deviceKey, pushToDevice, owner)
  }

  function safeErr (id, code, message) {
    try {
      send.err.send({ id, code, message })
    } catch {}
  }

  // Backpressure. Protomux `send()` returns false when the underlying stream is
  // full; pushing a whole film through regardless would balloon memory on a
  // Pi-class host. Wait for drain before the next frame.
  function drain () {
    return new Promise(resolve => conn.once('drain', resolve))
  }

  async function pipeStream (id, stream) {
    // The cancel already arrived while the stream was opening. Kill it at birth.
    if (preCancelled.delete(id)) {
      try { stream.destroy?.() } catch {}
      log('media:cancelled', { id, at: 'open' })
      return
    }
    let seq = 0
    let total = 0
    const live = { source: stream, cancelled: false }
    liveStreams.set(id, live)
    try {
      for await (const buf of stream) {
        // Frames are capped so a seek is never stuck behind one fat in-flight
        // chunk, regardless of what the source hands us.
        for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
          // Cancelled by the client - it has already forgotten this id, so send
          // nothing further, not even an end frame.
          if (live.cancelled) return
          const slice = buf.subarray(off, Math.min(off + CHUNK_SIZE, buf.length))
          const ok = send.chunk.send({ id, seq: seq++, data: slice })
          total += slice.length
          if (!ok) await drain()
          // The channel closed under us - a revoke destroyed the connection. Stop
          // reading the file, do not send an end frame, and let the socket's own
          // teardown finish the job. This is the loop that must not keep pushing
          // bytes at a device that was just cut off.
          if (channel.closed || live.cancelled) return
        }
      }
      if (!live.cancelled) send.end.send({ id, total })
    } catch (e) {
      // Destroying the source mid-iteration throws (premature close) - for a
      // cancelled stream that is the expected teardown, not a failure.
      if (live.cancelled) return
      log('media:stream-failed', { id, err: e?.message })
      safeErr(id, ERR.INTERNAL, 'stream failed')
    } finally {
      liveStreams.delete(id)
    }
  }

  function contextFor (m) {
    const { id, method, params } = m
    return {
      id,
      method,
      params: params || {},
      libraryId,
      protocol,
      log,

      // The authenticated facts about this connection. Read these; never read an
      // identity out of params.
      grant: liveGrant,
      scope: liveGrant.scope,
      owner,
      deviceKey: liveGrant.deviceKey,
      isOwner: liveGrant.scope === SCOPE.OWNER,

      reply (body) { send.res.send({ id, body }) },
      fail (code, message) { safeErr(id, code, message) },
      stream (readable) { return pipeStream(id, readable) },

      // Push to THIS device's other live connections.
      push (kind, data = null) {
        return presence ? presence.notify(liveGrant.deviceKey, kind, data) : 0
      },

      // Push to this PERSON across all their devices. `exceptSelf` skips the device
      // that made the change - it already re-rendered optimistically, and a push
      // would fight its own update.
      pushToOwner (kind, data = null, { exceptSelf = true } = {}) {
        if (!presence) return 0
        return presence.notifyOwner(owner, kind, data,
          { exceptDevice: exceptSelf ? liveGrant.deviceKey : null })
      },

      presence,
      badParams,
      notFound,
      forbidden,
      MethodError
    }
  }

  async function dispatch (m) {
    const { id, method } = m

    // The scope chokepoint. One place, ahead of every handler, so a new mutating
    // method cannot ship without it.
    if (mutatingSet.has(method) && grant?.scope === SCOPE.READONLY) {
      return safeErr(id, ERR.FORBIDDEN, 'read-only grant')
    }

    const ctx = contextFor(m)

    // Built in, because both ends need a liveness probe that exists before any app
    // has registered anything.
    if (method === 'ping') {
      return ctx.reply({ protocol: 1, libraryId, app: protocol.app })
    }

    if (method === 'media.stream') {
      if (!openStream) return safeErr(id, ERR.NO_METHOD, 'this host serves no streams')
      const stream = await openStream(ctx.params, ctx)
      if (!stream) return safeErr(id, ERR.NOT_FOUND, 'no such item')
      if (onStream) onStream(ctx.params, ctx)
      return pipeStream(id, stream)
    }

    const handler = methods[method]
    if (!handler) {
      // Typed, and the channel survives. An old host must degrade in front of a
      // newer client rather than wedge it.
      return safeErr(id, ERR.NO_METHOD, `unknown method: ${method}`)
    }

    const body = await handler(ctx)
    // undefined means the handler answered for itself - it replied, streamed, or
    // deliberately said nothing. Anything else is the response body.
    if (body !== undefined) ctx.reply(body)
  }

  return {
    channel,

    // A GRANT TRAVELS AT CONNECT TIME - unless the server calls this. The
    // operator assigning a device to a person used to apply on the device's
    // NEXT reconnect only, so a phone watching mid-assignment kept filing its
    // positions under the old owner. The server calls this on every live
    // connection of the device it just reassigned; the presence registration
    // moves to the new owner in the same breath, so person-wide pushes reach
    // the right shelves immediately too.
    //
    // The device key never changes here by construction - it is the Noise-
    // authenticated remote key, and a row for a DIFFERENT device is refused
    // rather than half-applied.
    setGrant (row) {
      if (!row || row.deviceKey !== liveGrant.deviceKey) return false
      liveGrant = row
      owner = ownerOf(liveGrant)
      if (presence) {
        unregisterPresence()
        unregisterPresence = presence.register(liveGrant.deviceKey, pushToDevice, owner)
      }
      return true
    }
  }
}

// A GOODBYE, AND NOTHING ELSE.
//
// The media channel, opened with no dispatch on it at all: one push frame saying the
// grant is gone, then the connection is destroyed. A device that reaches this cannot
// browse, cannot stream and cannot call a method, because the method table was never
// wired to this channel - which is the property that keeps revoke's guarantee intact
// (proposal 2026-08-22-say-goodbye-to-a-revoked-device).
//
// IT IS NOT serveMedia WITH A FLAG, and that is deliberate. A flag on a function that
// builds the whole API is one `if` away from admitting a revoked device to all of it;
// a separate function with no `methods` in scope cannot make that mistake.
//
// `linger` is how long the frame gets to leave before the socket dies. Protomux writes
// synchronously, but the socket flush is not, and a goodbye that is destroyed before it
// lands is worse than no goodbye - it looks exactly like the bug it fixes.
function serveFarewell ({ protocol, conn, libraryId, reason = 'device-revoked', linger = 250, log = () => {} }) {
  let sent = false
  try {
    const mux = Protomux.from(conn)
    const built = protocol.channels.mediaChannel(mux, { id: b4a.from(libraryId) })
    if (built) {
      built.channel.open()
      built.messages.push.send({ kind: 'access:revoked', data: { libraryId, reason } })
      sent = true
    }
  } catch (e) {
    log('media:farewell-failed', { err: e?.message })
  }
  const timer = setTimeout(() => { try { conn.destroy() } catch {} }, linger)
  if (timer.unref) timer.unref()
  log('media:farewell', { reason, sent })
  return sent
}

module.exports = {
  serveMedia,
  serveFarewell,
  ownerOf,
  MethodError,
  badParams,
  notFound,
  forbidden,
  BASE_MUTATING
}
