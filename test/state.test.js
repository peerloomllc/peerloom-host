// Per-person state: what somebody watched, where they stopped, what they starred.
//
// MOVED FROM PEARTUNE rather than written here, so most of these pin behaviour that
// already shipped. The ones worth reading are the two the extraction introduced - the
// kind vocabulary and the row's id field - and the watched flag, which is new.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')

const { UserState, FAV_KINDS } = require('../src/state')

async function store (t, opts) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pl-state-'))
  const cs = new Corestore(dir)
  const bee = new Hyperbee(cs.get({ name: 's' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  t.after(async () => {
    await bee.close()
    await cs.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return new UserState(bee, opts)
}

const VIDEO = { kinds: ['movie', 'episode', 'series', 'season'], idField: 'itemId' }

// --- what the extraction parameterised, and nothing else ----------------------

test("CONSTRUCTED THE DONOR'S WAY IT IS THE DONOR'S STORE, byte for byte", async (t) => {
  // The move must not change what PearTune writes. `new UserState(bee)` still means
  // the music vocabulary and still names its row field `trackId`, so its phones read
  // exactly what they always read and nothing migrates.
  const s = await store(t)
  assert.deepEqual(s.kinds, FAV_KINDS)

  const row = await s.setResume('p:ben', 'track-1', 42_000, 200_000)
  assert.equal(row.trackId, 'track-1')
  assert.equal(row.itemId, undefined)

  await s.bumpCount('p:ben', 'track-1')
  assert.deepEqual((await s.topCounts('p:ben')), [{ trackId: 'track-1', count: 1 }])
})

test('a video host names its own kinds and its own id field', async (t) => {
  const s = await store(t, VIDEO)

  const row = await s.setResume('p:tim', 'film-1', 60_000, 7_200_000)
  assert.equal(row.itemId, 'film-1')
  assert.equal(row.trackId, undefined)

  await s.setFav('p:tim', 'series', 'show-1', true)
  assert.deepEqual(await s.listFavs('p:tim'), { movie: [], episode: [], series: ['show-1'], season: [] })

  // And a kind from the OTHER app is refused rather than quietly stored, which is what
  // stops a typo becoming a row nothing ever lists.
  await assert.rejects(() => s.setFav('p:tim', 'album', 'x', true), /bad favorite kind/)
})

test('THE KEYS DO NOT CARRY THE FIELD NAME, so the two shapes are the same rows', async (t) => {
  // This is why naming the field is safe: an app that switched from one to the other
  // would read its own old rows, just under a different property. Proven by writing
  // with one store and reading the key with another.
  const s = await store(t, VIDEO)
  await s.setResume('p:tim', 'film-1', 5_000, 100_000)

  const raw = await s.bee.get('resume:p:tim:film-1', { valueEncoding: 'json' })
  assert.ok(raw, 'the key is built from the id, never from its name')
  assert.equal(raw.value.positionMs, 5_000)
})

// --- resume, inherited ---------------------------------------------------------

test('a position of zero is a DELETE, so a finished film starts fresh', async (t) => {
  const s = await store(t, VIDEO)
  await s.setResume('p:tim', 'film-1', 60_000, 7_200_000)
  assert.equal(await s.setResume('p:tim', 'film-1', 0, 7_200_000), null)
  assert.equal(await s.getResume('p:tim', 'film-1'), null)
})

test('CONTINUE WATCHING IS ORDERED BY WHEN THE DEVICE WATCHED, not when the write landed', async (t) => {
  // The bug this exists for: a phone reconnecting after a flight flushes an offline
  // outbox, and its hours-old positions land NOW. Ordering by the write time puts them
  // in front of the device playing this minute.
  const s = await store(t, VIDEO)
  const old = Date.now() - 6 * 60 * 60 * 1000

  await s.setResume('p:tim', 'watched-now', 30_000, 100_000, { playedAt: Date.now() })
  await s.setResume('p:tim', 'stale-outbox', 40_000, 100_000, { playedAt: old })

  const rows = await s.listResume('p:tim')
  assert.deepEqual(rows.map(r => r.itemId), ['watched-now', 'stale-outbox'])
})

test('the continue-watching list holds only things actually part-watched', async (t) => {
  const s = await store(t, VIDEO)
  await s.setResume('p:tim', 'film-1', 60_000, 7_200_000)
  await s.setResume('p:tim', 'film-2', 0, 7_200_000)
  assert.deepEqual((await s.listResume('p:tim')).map(r => r.itemId), ['film-1'])
})

test('two people watching the same film keep two positions', async (t) => {
  const s = await store(t, VIDEO)
  await s.setResume('p:tim', 'film-1', 60_000, 7_200_000)
  await s.setResume('p:ben', 'film-1', 3_600_000, 7_200_000)

  assert.equal((await s.getResume('p:tim', 'film-1')).positionMs, 60_000)
  assert.equal((await s.getResume('p:ben', 'film-1')).positionMs, 3_600_000)
})

test("ONE PERSON'S TWO DEVICES SHARE ONE POSITION, which is the whole point", async (t) => {
  // Host-as-hub: put the phone down, pick the laptop up, same film same place. The
  // device key is recorded as attribution, not as part of the key.
  const s = await store(t, VIDEO)
  await s.setResume('p:tim', 'film-1', 60_000, 7_200_000, { deviceKey: 'phone' })
  await s.setResume('p:tim', 'film-1', 90_000, 7_200_000, { deviceKey: 'laptop' })

  const row = await s.getResume('p:tim', 'film-1')
  assert.equal(row.positionMs, 90_000)
  assert.equal(row.deviceKey, 'laptop')
  assert.equal((await s.listResume('p:tim')).length, 1, 'one row, not one per device')
})

// --- watched, new ---------------------------------------------------------------

test('WATCHED IS A FLAG A PERSON CAN TAKE BACK, which is why it is not a count', async (t) => {
  // The affordance everybody reaches for when a housemate watched an episode. A play
  // count cannot honestly be un-incremented.
  const s = await store(t, VIDEO)
  await s.setWatched('p:tim', 'film-1', true, { auto: true })
  assert.deepEqual([...await s.watchedSet('p:tim')], ['film-1'])

  await s.setWatched('p:tim', 'film-1', false)
  assert.deepEqual([...await s.watchedSet('p:tim')], [])

  // OFF IS A ROW, not an absence. An explicit no has to be durable, or a later stale
  // write resurrects the yes.
  const row = await s.getWatched('p:tim', 'film-1')
  assert.equal(row.on, false)
  assert.equal(row.auto, false, 'a hand mark is not an automatic one')
})

test('who marked it is recorded, so a future rule cannot overrule a person quietly', async (t) => {
  const s = await store(t, VIDEO)
  assert.equal((await s.setWatched('p:tim', 'a', true, { auto: true })).auto, true)
  assert.equal((await s.setWatched('p:tim', 'b', true)).auto, false)
})

test('watched is per person, like everything else here', async (t) => {
  const s = await store(t, VIDEO)
  await s.setWatched('p:tim', 'film-1', true)
  assert.deepEqual([...await s.watchedSet('p:ben')], [])
})

test('the watched set answers a whole grid in one scan', async (t) => {
  // A library page asks "which of these 200 posters get a tick". Two hundred point
  // reads to draw one screen only hurts on somebody else's library.
  const s = await store(t, VIDEO)
  for (let i = 0; i < 50; i++) await s.setWatched('p:tim', 'film-' + i, i % 2 === 0)
  const set = await s.watchedSet('p:tim')
  assert.equal(set.size, 25)
  assert.equal(set.has('film-0'), true)
  assert.equal(set.has('film-1'), false)
})

test('one owner cannot reach another, even by guessing an id', async (t) => {
  // The prefix bound is the mechanism: owner `p:abc` must never reach `p:abcd`,
  // because 'd' sorts above ';'. The same trick the grant store uses.
  const s = await store(t, VIDEO)
  await s.setWatched('p:abcd', 'film-1', true)
  await s.setResume('p:abcd', 'film-1', 60_000, 100_000)

  assert.deepEqual([...await s.watchedSet('p:abc')], [])
  assert.deepEqual(await s.listResume('p:abc'), [])
})

// --- deleting a person -----------------------------------------------------------

test('DELETING A PERSON TAKES WHAT THEY WATCHED WITH THEM', async (t) => {
  // The button says delete. Leaving their viewing history behind, unreachable but
  // present, is both a slow leak and a privacy wart - and `watched` is the newest row
  // that has to be in that sweep.
  const s = await store(t, VIDEO)
  await s.setWatched('p:tim', 'film-1', true)
  await s.setResume('p:tim', 'film-2', 60_000, 100_000)
  await s.setFav('p:tim', 'movie', 'film-3', true)
  await s.bumpCount('p:tim', 'film-4')

  const gone = await s.deleteOwner('p:tim')
  assert.equal(gone, 4)
  assert.deepEqual([...await s.watchedSet('p:tim')], [])
  assert.deepEqual(await s.listResume('p:tim'), [])
  assert.deepEqual((await s.listFavs('p:tim')).movie, [])
})

test('WHAT THEY FINISHED MOST RECENTLY, which a Set cannot answer', async (t) => {
  // The question a next-episode shelf is built from: which show did they just finish
  // an episode of. Walking every series in a library to work that out is free on a
  // folder source and one HTTP call per show on a server one.
  const s = await store(t, VIDEO)
  await s.setWatched('p:tim', 'first', true)
  await new Promise(r => setTimeout(r, 5))
  await s.setWatched('p:tim', 'second', true)
  await new Promise(r => setTimeout(r, 5))
  await s.setWatched('p:tim', 'third', true)

  assert.deepEqual((await s.recentWatched('p:tim')).map(r => r.itemId), ['third', 'second', 'first'])
  assert.deepEqual((await s.recentWatched('p:tim', 1)).map(r => r.itemId), ['third'])
})

test('something marked UNwatched is not recent, it is absent', async (t) => {
  const s = await store(t, VIDEO)
  await s.setWatched('p:tim', 'a', true)
  await s.setWatched('p:tim', 'a', false)
  assert.deepEqual(await s.recentWatched('p:tim'), [])
})
