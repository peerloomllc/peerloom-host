// The library host.
//
// Runs on the machine that holds the media. ONE HyperDHT server, listening on the
// host keypair. Granted devices get the media API; a device with no grant is
// refused outright, unless a pairing window is open, in which case it gets the
// pairing channel and nothing else.
//
// One server, one identity. An earlier PearTune cut also ran a Hyperswarm for a
// pairing rendezvous, which quietly created a SECOND dht server on the same
// keypair and deadlocked. See src/pair.js for why the rendezvous was unnecessary.
//
// PERSISTENT-HYPERSWARM TRANSPORT. On top of the server, the host ANNOUNCES a
// discovery topic derived from its key so a phone can find it by DHT lookup and
// keep retrying until a hole-punch lands (the off-LAN fix). Announce is discovery
// ONLY: the connection still arrives at this same server and is gated by the same
// async firewall, so admission and the revoke guarantee are byte-for-byte
// unchanged, and a raw dht.connect(hostKey) from an un-upgraded phone keeps
// working.
//
// We announce with the RAW DHT rather than standing up a Hyperswarm here, for two
// measured reasons: (1) a Hyperswarm would run its OWN dht server on this keypair
// - the two-servers-on-one-keypair deadlock above; and (2) Hyperswarm's firewall
// wrapper is synchronous and cannot carry our async grant lookup - it bans a peer
// on the first (Promise-truthy) return, so a GRANTED phone's every reconnect is
// then refused (measured 2026-07-22). So the host stays on createServer; only the
// PHONE gets Hyperswarm's ConnectionManager.
//
// WHAT IS APP-SPECIFIC lives behind hooks, and the list is deliberately short: the
// media method table, the stream opener, whatever else the app wants killed when a
// device is cut off (a cast target is not a HyperDHT connection, so
// connections.kill() cannot reach it), and the per-device decoration the dashboard
// wants. Everything else here is the same for a music library and a film library.

const path = require('path')
const HyperDHT = require('hyperdht')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Protomux = require('protomux')
const b4a = require('b4a')
const z32 = require('z32')

const { createIdentity } = require('./identity')
const { Grants } = require('./grants')
const { decide, sweepKills, Connections } = require('./gate')
const { Presence, notifyOwners } = require('./presence')
const { PairSession } = require('./pair')
const { serveMedia } = require('./media')
const { pruneRocksLogs } = require('./logprune')

// How often to sweep live connections for an expired guest grant. `decide()` covers
// connect; this covers a guest that expires WHILE connected. 30s is fine for a
// scheduled expiry - unlike revoke's instant, event-driven kill, nobody is racing a
// lost phone here.
const EXPIRY_SWEEP_MS = 30_000

// How often to re-announce the discovery topic. A HyperDHT announce record lives
// ~20 min on the nodes holding it (defaultMaxAge), so we refresh well inside that -
// 10 min matches Hyperswarm's own announcer interval.
const TOPIC_REANNOUNCE_MS = 10 * 60 * 1000

// A single announce right after startup can silently fail to propagate against a
// cold DHT routing table (the record resolves but does not reach the topic's
// keyspace nodes), and the steady re-announce above is 10 min away - long enough
// that a freshly-started host looks unreachable in the meantime. Observed once
// after a PearTune host wipe (2026-07-23); a controlled wipe the next day recovered
// in under a second, so this is belt-and-braces for the rare cold-announce case,
// not a fix for a reproduced bug.
const TOPIC_EARLY_REANNOUNCE_MS = [20 * 1000, 60 * 1000, 120 * 1000]

// Keep this many of RocksDB's rotated info logs (store/db/LOG.old.*) for debugging;
// prune the rest. RocksDB rotates them only on reopen, so pruning at startup keeps
// the count bounded; the 12h re-prune is cheap insurance. NOT data - the
// .sst/.log/MANIFEST are never touched.
const ROCKS_LOG_KEEP = 3
const ROCKS_LOG_PRUNE_MS = 12 * 60 * 60_000

class LibraryHost {
  constructor ({
    protocol,
    dataDir,
    libraryName = 'My Library',

    dht = null,
    bootstrap = null,
    dhtPort = null,
    log = () => {},

    // --- the app seam ---------------------------------------------------

    // (host) => ({ methods, mutating, openStream, onStream }). A function, not an
    // object, because a method table needs the host it is serving and the host does
    // not exist until the constructor finishes.
    media = null,

    // Extra device keys to sweep for expiry alongside the live connections. A phone
    // can start a cast and close the app: the connection goes, the TV keeps playing,
    // and a connection-only sweep would never look at that device again - so an
    // expiring guest grant would leave a film running indefinitely.
    extraLiveKeys = () => [],

    // async (deviceKey) => number. Stop whatever this device started that is NOT a
    // HyperDHT connection. THE REVOKE PATH DEPENDS ON THIS: `connections.kill()`
    // cannot reach a Chromecast, because the bytes reach it from this process rather
    // than from the revoked phone. Without it the film keeps playing in the room.
    silence = null,

    // async (row, { online }) => row. Per-device decoration for the dashboard.
    decorateDevice = null,

    // async (deviceKey) => void, after a device row is deleted. For app-owned files
    // keyed by device, so a delete does not orphan them.
    onDeviceDeleted = null,

    // async (personId) => any, after a person row is deleted. Their state is
    // unreachable the moment the row goes, because a personId is minted fresh and
    // never reused - so leaving it is a slow leak and a privacy wart.
    onPersonDeleted = null
  } = {}) {
    if (!protocol || !protocol.ids) throw new Error('LibraryHost needs a protocol from createProtocol()')
    if (!dataDir) throw new Error('LibraryHost needs a dataDir')

    this.protocol = protocol
    this.dataDir = path.resolve(dataDir)
    this.libraryName = libraryName
    this.log = log

    this.identity = createIdentity(this.dataDir, protocol)
    this.libraryId = this.identity.libraryId

    this._ownDht = !dht
    // dhtPort pins the DHT's UDP socket. Unset keeps the default behaviour, which is
    // a RANDOM port per process - note that is despite `opts.port || 49737` in
    // hyperdht/index.js, which is only a preference and does not survive.
    //
    // A pinned port only matters where something outside the process has to forward
    // to it: a router port-forward, or StartOS 0.4's `bindPortRange`, which cannot
    // forward a port that changes every restart.
    this.dht = dht || new HyperDHT({
      ...(bootstrap ? { bootstrap } : {}),
      ...(dhtPort ? { port: Number(dhtPort) } : {})
    })

    this.store = new Corestore(path.join(this.dataDir, 'store'))
    this.bee = new Hyperbee(this.store.get({ name: 'grants' }), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    this.grants = new Grants(this.bee)

    this.connections = new Connections()

    // The registry that lets a request on one device's connection push to another
    // device's connection. Only ever holds channels the firewall already admitted; a
    // revoke destroys the connection, which unregisters here.
    this.presence = new Presence()

    this.server = null
    this.pairSession = null

    // Discovery topic and its re-announce timers. Derived from the host key, so the
    // phone derives the same one from the hostKey it holds. Set in ready().
    this._topic = null
    this._reannounce = null
    this._earlyReannounce = null
    this._sweep = null
    this._logPrune = null
    this._closed = false
    this._closing = null

    this._media = media
    this._extraLiveKeys = extraLiveKeys
    this._silence = silence
    this._decorateDevice = decorateDevice
    this._onDeviceDeleted = onDeviceDeleted
    this._onPersonDeleted = onPersonDeleted
  }

  get publicKey () {
    return this.identity.publicKey
  }

  get pairing () {
    return !!(this.pairSession && !this.pairSession.closed)
  }

  async ready () {
    await this.bee.ready()

    this.server = this.dht.createServer({
      firewall: (remotePublicKey) => this._firewall(remotePublicKey)
    }, (conn) => this._onconnection(conn))

    await this.server.listen(this.identity.keyPair)

    // Announce the discovery topic so a topic-joining phone finds the host by
    // lookup. Best-effort and awaited-but-swallowed: a slow or failing announce must
    // NOT stop the host from starting - the raw dht.connect(hostKey) path still works
    // without it, and the re-announce below will retry.
    this._topic = this.protocol.ids.hostTopic(this.identity.publicKey)
    await this._announceTopic()
    this._reannounce = setInterval(() => { this._announceTopic() }, TOPIC_REANNOUNCE_MS)
    if (this._reannounce.unref) this._reannounce.unref()
    this._earlyReannounce = TOPIC_EARLY_REANNOUNCE_MS.map((ms) => {
      const t = setTimeout(() => { this._announceTopic() }, ms)
      if (t.unref) t.unref()
      return t
    })

    // Cut guest connections whose grant expired since they dialed in.
    this._sweep = setInterval(() => { this._sweepExpired().catch(() => {}) }, EXPIRY_SWEEP_MS)
    if (this._sweep.unref) this._sweep.unref()

    this._pruneRocksLogs()
    this._logPrune = setInterval(() => this._pruneRocksLogs(), ROCKS_LOG_PRUNE_MS)
    if (this._logPrune.unref) this._logPrune.unref()

    this.log('host:listening', {
      app: this.protocol.app,
      hostKey: z32.encode(this.identity.publicKey),
      libraryId: this.libraryId
    })

    return this
  }

  // (Re-)announce the discovery topic on the DHT. Signed with the host keypair, so
  // the record authentically points a topic-lookup at THIS host. Never throws: a
  // failed announce only means new topic-clients cannot find us yet (the raw
  // dht.connect path and already-connected phones are unaffected), and the timer
  // retries.
  async _announceTopic () {
    if (!this._topic || this._closed) return
    try {
      await this.dht.announce(this._topic, this.identity.keyPair).finished()
      this.log('host:announced', { topic: z32.encode(this._topic).slice(0, 8) })
    } catch (e) {
      this.log('host:announce-failed', { err: e.message })
    }
  }

  // Delete all but the most-recent RocksDB info logs so they do not grow without
  // bound. Safe: only LOG.old.* is ever touched - no data, no WAL, no MANIFEST.
  _pruneRocksLogs () {
    const deleted = pruneRocksLogs(path.join(this.dataDir, 'store', 'db'), ROCKS_LOG_KEEP)
    if (deleted) this.log('host:log-pruned', { deleted, kept: ROCKS_LOG_KEEP })
  }

  // Walk the live devices and kill any whose grant decide() now refuses - an expired
  // guest, mostly (a revoke already killed on its own event). Loads each lookup, then
  // delegates the selection to the pure gate.sweepKills.
  async _sweepExpired () {
    const extra = (await this._extraLiveKeys()) || []
    const keys = [...new Set([...this.connections.deviceKeys(), ...extra])]
    if (!keys.length) return
    const lookups = new Map()
    for (const key of keys) lookups.set(key, await this.grants.lookup(key))
    for (const key of sweepKills(keys, lookups)) {
      const killed = this.connections.kill(key)
      const silenced = await this._silenceFor(key)
      this.log('host:expired', { device: key.slice(0, 8), killed, silenced })
    }
  }

  // Stop whatever this device started that a socket teardown cannot reach.
  // Swallowed, because a failing cast driver must never stop a revoke from
  // completing - the grant tombstone and the connection kill have already landed by
  // the time this runs.
  async _silenceFor (deviceKey) {
    if (!this._silence) return 0
    try {
      return (await this._silence(Grants.keyOf(deviceKey))) || 0
    } catch (e) {
      this.log('host:silence-failed', { device: Grants.keyOf(deviceKey).slice(0, 8), err: e?.message })
      return 0
    }
  }

  // HyperDHT awaits this hook, so touching the Hyperbee here is fine. It also
  // initialises `firewalled: true` and SWALLOWS a throw, so any error in this path
  // fails CLOSED (denied). test/gate.test.js pins that behaviour, because a future
  // hyperdht bump that flipped it to fail-open would silently expose every library
  // in the wild.
  //
  // Returns TRUE to DENY.
  async _firewall (remotePublicKey) {
    const short = z32.encode(remotePublicKey).slice(0, 8)

    const lookup = await this.grants.lookup(remotePublicKey)
    const { allow, reason } = decide(lookup)

    if (allow) {
      this.log('gate:allow', { device: short, reason })
      return false
    }

    // Chicken-and-egg: a device that has never paired HAS no grant, so the gate must
    // let it in far enough to pair. It is admitted only while the operator has a
    // window open, and _onconnection gives it the pairing channel ONLY - never the
    // media API. It still has to present the QR token to get a grant.
    if (this.pairing) {
      this.log('gate:allow-for-pairing', { device: short })
      return false
    }

    this.log('gate:deny', { device: short, reason })
    return true
  }

  // SYNCHRONOUS on purpose, and it registers Protomux `pair` handlers rather than
  // creating channels directly.
  //
  // This is the second time this exact bug has bitten the suite (see the
  // @peerloom/core writer-admission fix). Protomux REJECTS a channel the remote opens
  // if we have not created our side yet AND no `mux.pair` notify handler is
  // registered for that (protocol, id) - see `_requestSession` in protomux/index.js.
  // The client dials and opens its channel immediately, so any `await` before we set
  // our side up (a Hyperbee grant lookup, say) loses the race and the connection dies
  // for no visible reason.
  //
  // `mux.pair` is the supported way to say "I will build my side when you ask for
  // it". Protomux awaits the callback, so the async grant lookup is fine INSIDE it -
  // just not before it.
  _onconnection (conn) {
    const remoteKey = conn.remotePublicKey
    const short = z32.encode(remoteKey).slice(0, 8)
    const id = b4a.from(this.libraryId)

    conn.on('error', () => {}) // a peer vanishing is normal, not an event

    // Registered even while unpaired, so a revoke landing mid-pair can still find and
    // kill the connection.
    this.connections.add(remoteKey, conn)

    const mux = Protomux.from(conn)

    mux.pair({ protocol: this.protocol.PAIR_PROTOCOL, id }, () => {
      // The window may have closed between the firewall admitting this device and it
      // asking to pair. A race must never become an admission.
      if (!this.pairing) {
        this.log('host:pair-window-closed', { device: short })
        conn.destroy()
        return
      }
      this.log('host:pairing-connection', { device: short })
      this.pairSession.serve(conn)
    })

    mux.pair({ protocol: this.protocol.MEDIA_PROTOCOL, id }, async () => {
      const lookup = await this.grants.lookup(remoteKey)
      const { allow, reason } = decide(lookup)

      // The firewall let this device through, but that may have been the pairing
      // exemption. Reaching the MEDIA api requires a real grant.
      if (!allow) {
        this.log('host:media-denied', { device: short, reason })
        conn.destroy()
        return
      }

      await this.grants.touch(remoteKey)
      this.log('host:connected', { device: short, live: this.connections.size })

      const app = this._media ? this._media(this) : {}

      serveMedia({
        protocol: this.protocol,
        conn,
        libraryId: this.libraryId,
        grant: lookup.grant,
        presence: this.presence,
        methods: app.methods || {},
        mutating: app.mutating || [],
        openStream: app.openStream || null,
        onStream: app.onStream || null,
        log: (msg, data) => this.log(msg, { device: short, ...data })
      })
    })
  }

  // --- operator actions ------------------------------------------------

  // expiresMs > 0 opens a GUEST window: devices that pair through it get access that
  // expires that many ms after pairing. owner:true opens an OWNER window - mutually
  // exclusive with guest, so an owner is never time-limited. Omitted = a normal
  // permanent window.
  // Returns the LINK STRING, matching the donor, so PearTune's dashboard and its
  // owner.pairStart method migrate without a call-site change.
  startPairing ({ expiresMs = null, owner = false } = {}) {
    // Owner XOR guest: an owner window ignores any expiry (an owner is permanent by
    // definition; a time-limited owner would be a footgun).
    if (owner) expiresMs = null

    // A window is already open. Reuse it only if its KIND (guest-ness AND
    // owner-ness) matches what was asked; otherwise close it and open the requested
    // kind, so the three window types never silently hand back the wrong one.
    if (this.pairing) {
      const openMs = this.pairSession.expiresMs || null
      const sameKind = (openMs ? 1 : 0) === (expiresMs ? 1 : 0) && !!this.pairSession.owner === !!owner
      if (sameKind) return this.pairSession.link
      this.pairSession.close('operator')
    }

    this.pairSession = new PairSession({
      protocol: this.protocol,
      identity: this.identity,
      grants: this.grants,
      libraryName: this.libraryName,
      expiresMs: expiresMs && expiresMs > 0 ? expiresMs : null,
      owner: !!owner,
      log: this.log,
      // A device pairing in changes the roster every owner sees, so refresh their
      // live view.
      onpaired: () => this.notifyOwnersDevicesChanged()
    })

    this.log('pair:open', { ttlMs: this.pairSession.ttl, guest: !!this.pairSession.expiresMs, owner: !!owner })
    return this.pairSession.link
  }

  stopPairing () {
    if (!this.pairSession) return { ok: true }
    this.pairSession.close('operator')
    this.pairSession = null
    this.log('host:pairing-closed')
    return { ok: true }
  }

  // Tell every CONNECTED owner that the device roster changed - a pair, a revoke, a
  // delete, a promotion - so their in-app list refreshes live instead of only when
  // reopened. Rides the presence rail, keyed to each owner's device; a revoked or
  // offline owner is simply not in the registry. Best-effort, and carries libraryId
  // so the app reloads the RIGHT library's list in a blended view.
  notifyOwnersDevicesChanged () {
    return notifyOwners(this.presence, this.grants, 'devices:changed', { libraryId: this.libraryId })
      .catch(() => 0)
  }

  async revokeDevice (deviceKey) {
    const row = await this.grants.revoke(deviceKey, { by: 'operator' })
    const killed = this.connections.kill(deviceKey)
    const silenced = await this._silenceFor(deviceKey)
    this.log('host:revoked', {
      device: Grants.keyOf(deviceKey).slice(0, 8),
      killedConnections: killed,
      silenced
    })
    this.notifyOwnersDevicesChanged()
    return { grant: row, killed, silenced }
  }

  // A device dropping its OWN access - the phone removed this library. Same teeth as
  // an operator revoke (tombstone plus cut every live connection it holds) so
  // "remove" on the phone actually ends access here instead of leaving a live grant,
  // but logged as a self-initiated leave.
  //
  // 'self': the DEVICE ended this, not the operator - so pairing again may bring it
  // back to the person it held (gate.carryOverPerson). An operator revoke never does.
  async leaveDevice (deviceKey) {
    const row = await this.grants.revoke(deviceKey, { by: 'self' })
    const killed = this.connections.kill(deviceKey)
    const silenced = await this._silenceFor(deviceKey)
    this.log('host:device-left', {
      device: Grants.keyOf(deviceKey).slice(0, 8),
      killedConnections: killed
    })
    this.notifyOwnersDevicesChanged()
    return { grant: row, killed, silenced }
  }

  // Edit a device's guest expiry: a timestamp to (re)limit it, or null to promote it
  // to permanent. The sweep enforces a future expiry; if the operator sets one
  // already in the past we cut the connection now rather than waiting up to 30s.
  async setDeviceExpiry (deviceKey, expiresAt) {
    const row = await this.grants.setExpiry(deviceKey, expiresAt)
    if (!row) return { grant: null, killed: 0, silenced: 0 }
    const past = !!(expiresAt && Date.now() > expiresAt)
    const killed = past ? this.connections.kill(deviceKey) : 0
    const silenced = past ? await this._silenceFor(deviceKey) : 0
    this.log('host:expiry-set', { device: Grants.keyOf(deviceKey).slice(0, 8), expiresAt, killed, silenced })
    this.notifyOwnersDevicesChanged()
    return { grant: row, killed, silenced }
  }

  async revokePerson (personId) {
    const revoked = await this.grants.revokePerson(personId)
    const killed = this.connections.killAll(revoked.map(r => r.deviceKey))
    let silenced = 0
    for (const r of revoked) silenced += await this._silenceFor(r.deviceKey)
    this.log('host:revoked-person', {
      personId, devices: revoked.length, killedConnections: killed, silenced
    })
    this.notifyOwnersDevicesChanged()
    return { revoked, killed, silenced }
  }

  // Cleanup, not revocation. Removes a REVOKED device's tombstone so the device list
  // stops growing forever; grants.deleteGrant refuses a live grant, so the operator
  // has to revoke first. We kill any lingering connection here too, belt and braces:
  // a revoked device should have none, but a delete must never leave one half-alive,
  // and it can never re-admit - with the row gone the gate denies by default.
  async deleteDevice (deviceKey) {
    const row = await this.grants.deleteGrant(deviceKey)
    if (!row) return { deleted: null, killed: 0 }
    if (this._onDeviceDeleted) await this._onDeviceDeleted(Grants.keyOf(deviceKey))
    const killed = this.connections.kill(deviceKey)
    const silenced = await this._silenceFor(deviceKey)
    this.log('host:device-deleted', { device: Grants.keyOf(deviceKey).slice(0, 8), killed, silenced })
    this.notifyOwnersDevicesChanged()
    return { deleted: row, killed, silenced }
  }

  // Remove an empty person (grants.deletePerson refuses one that still holds a live
  // device). Nothing to kill: their live devices, if any, are what would have blocked
  // the delete. Order matters - the person row goes FIRST, since that is the guarded
  // step that can refuse.
  async deletePerson (personId) {
    const person = await this.grants.deletePerson(personId)
    if (!person) return { deleted: null }
    const purged = this._onPersonDeleted ? await this._onPersonDeleted(personId) : 0
    this.log('host:person-deleted', { personId, purged })
    return { deleted: person, purged }
  }

  // Every grant row, with whether the device is online right now and who it belongs
  // to - disambiguated where two people share a name, so a revoke button names the
  // same Sam everywhere. `claimedUser` stays raw: it is only what the device SAID.
  async listDevices () {
    const rows = await this.grants.list()
    const personLabel = await this.grants.personLabels()
    return Promise.all(rows.map(async r => {
      const online = this.connections.count(r.deviceKey) > 0
      const row = {
        ...r,
        online,
        belongsTo: r.personId ? (personLabel.get(r.personId) || null) : null
      }
      return this._decorateDevice ? await this._decorateDevice(row, { online }) : row
    }))
  }

  // Idempotent, and that is not tidiness. A daemon gets SIGINT and SIGTERM in quick
  // succession often enough, and a second close that re-entered the teardown would
  // call bee.close() on a store already closing - which resolves fine, or hangs,
  // depending on timing. Return the FIRST close's promise so a second caller waits
  // for the same shutdown instead of starting a rival one.
  close () {
    if (this._closing) return this._closing
    this._closing = this._close()
    return this._closing
  }

  async _close () {
    this._closed = true
    if (this.pairSession) this.pairSession.close('shutdown')
    if (this._reannounce) clearInterval(this._reannounce)
    if (this._earlyReannounce) for (const t of this._earlyReannounce) clearTimeout(t)
    if (this._sweep) clearInterval(this._sweep)
    if (this._logPrune) clearInterval(this._logPrune)

    if (this.server) await this.server.close().catch(() => {})
    await this.bee.close().catch(() => {})
    await this.store.close().catch(() => {})
    // Only destroy a DHT we made. A caller that handed one in (a testnet, a shared
    // node) still owns it.
    if (this._ownDht) await this.dht.destroy().catch(() => {})
    this.log('host:closed')
  }
}

module.exports = {
  LibraryHost,
  EXPIRY_SWEEP_MS,
  TOPIC_REANNOUNCE_MS,
  ROCKS_LOG_KEEP
}
