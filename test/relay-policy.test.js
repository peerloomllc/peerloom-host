// The relay policy: direct-first escalation, the privacy toggle, and the
// "no key configured = inert" behaviour PearCinema's whole no-relay decision
// rests on.
//
// Moved from PearTune's test/relay-policy.test.js. The donor's last test asserted
// that a key IS baked in; that assertion moves to PearTune, because the package
// deliberately bakes in none. Its replacement here is the opposite claim, and it
// is the one PearCinema needs to be true.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const z32 = require('z32')

const { relayThroughFor, relayStreamDecision, relayAudioDecision, decodeRelayKey } = require('../src/protocol/relay')
const { createProtocol } = require('../src/protocol')

const KEY = b4a.alloc(32, 7) // a stand-in relay key

test('direct-first: no relay on the first attempt (not forced, not randomized)', () => {
  assert.equal(relayThroughFor({ force: false, randomized: false, useRelay: true, relayKey: KEY }), null)
})

test('escalates to the relay once forced (a HOLEPUNCH_ABORTED set force=true)', () => {
  assert.equal(relayThroughFor({ force: true, randomized: false, useRelay: true, relayKey: KEY }), KEY)
})

test('a double-randomized NAT relays from the first attempt (direct can never work)', () => {
  assert.equal(relayThroughFor({ force: false, randomized: true, useRelay: true, relayKey: KEY }), KEY)
})

test('the privacy toggle wins: useRelay=false never relays, even when forced', () => {
  assert.equal(relayThroughFor({ force: true, randomized: true, useRelay: false, relayKey: KEY }), null)
})

test('no key configured = inert: never relays regardless of force/NAT/toggle', () => {
  assert.equal(relayThroughFor({ force: true, randomized: true, useRelay: true, relayKey: null }), null)
})

test('THE PACKAGE BAKES IN NO RELAY KEY', () => {
  // PearCinema's no-relay decision is "a null key kills the path with no
  // architectural change". That is only true while the package holds no key of
  // its own for someone to default to. If this test ever fails because a key was
  // added here "so PearTune can find it", move the key to PearTune instead.
  const relay = require('../src/protocol/relay')
  for (const [name, value] of Object.entries(relay)) {
    assert.equal(typeof value, 'function', `${name} should be a function, not a baked constant`)
  }
})

test('a protocol with no relayKey relays nothing', () => {
  const cinema = createProtocol({ app: 'pearcinema' })
  assert.equal(cinema.relayKey, null)
  assert.equal(cinema.relayKeyBuffer, null)
  assert.equal(
    relayThroughFor({ force: true, randomized: true, useRelay: true, relayKey: cinema.relayKeyBuffer }),
    null
  )
})

test('an app that DOES configure a relay gets its key decoded to 32 bytes', () => {
  const z = z32.encode(KEY)
  const tune = createProtocol({ app: 'peartune', relayKey: z })
  assert.equal(tune.relayKey, z)
  assert.ok(b4a.equals(tune.relayKeyBuffer, KEY))
  assert.equal(decodeRelayKey(null), null)
})

test('the stream-consent decision is unchanged from the donor', () => {
  assert.equal(relayStreamDecision({ relayed: false, consent: 'ask' }), 'play')
  assert.equal(relayStreamDecision({ relayed: true, consent: 'allow' }), 'play')
  assert.equal(relayStreamDecision({ relayed: true, consent: 'deny' }), 'refuse')
  assert.equal(relayStreamDecision({ relayed: true, consent: 'ask' }), 'ask')
  // The donor's name still resolves, so PearTune migrates without a rename sweep.
  assert.equal(relayAudioDecision, relayStreamDecision)
})
