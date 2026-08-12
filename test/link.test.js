// Pairing-link parsing.
//
// The cross-rejection tests are the point of this file. A loose parser here
// means a scanned QR from another app could aim a device at the wrong topic,
// and PearCircle already shipped a test like this for the same reason.
//
// Moved from PearTune's test/link.test.js. Now that the scheme is a constructor
// argument, PearTune's own link is just one more foreign link a PearCinema
// parser has to reject - so it is in the cross-reject list below, which the
// donor could not test at all.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const z32 = require('z32')
const hcrypto = require('hypercore-crypto')

const { createLink } = require('../src/protocol/link')

const { encodeLink, parseLink, isPairLink } = createLink({
  scheme: 'pear://pearcinema/pair',
  displayName: 'PearCinema'
})

const rv = hcrypto.randomBytes(32)
const hostKey = hcrypto.keyPair().publicKey

test('encode -> parse round-trips', () => {
  const link = encodeLink({ rv, hostKey, name: 'Tim\'s Library' })
  const parsed = parseLink(link)

  assert.equal(parsed.version, 1)
  assert.ok(b4a.equals(parsed.rv, rv))
  assert.ok(b4a.equals(parsed.hostKey, hostKey))
  assert.equal(parsed.name, 'Tim\'s Library')
})

test('name is optional', () => {
  const parsed = parseLink(encodeLink({ rv, hostKey }))
  assert.equal(parsed.name, null)
})

test('owner hint round-trips and defaults to false', () => {
  // A normal code has no owner flag.
  assert.equal(parseLink(encodeLink({ rv, hostKey })).owner, false)
  assert.equal(parseLink(encodeLink({ rv, hostKey, owner: false })).owner, false)
  // An owner window's code carries owner=1.
  const link = encodeLink({ rv, hostKey, name: 'Tim', owner: true })
  assert.match(link, /(^|&)owner=1(&|$)/)
  const parsed = parseLink(link)
  assert.equal(parsed.owner, true)
  // The rest still round-trips alongside it.
  assert.ok(b4a.equals(parsed.rv, rv))
  assert.equal(parsed.name, 'Tim')
})

test('a pre-owner-hint link (no owner param) still parses, as a normal code', () => {
  const old = `pear://pearcinema/pair?v=1&rv=${z32.encode(rv)}&host=${z32.encode(hostKey)}`
  assert.equal(parseLink(old).owner, false)
})

test('a name with & and = survives (url-encoded)', () => {
  const nasty = 'Fire & Fury = Fun'
  const parsed = parseLink(encodeLink({ rv, hostKey, name: nasty }))
  assert.equal(parsed.name, nasty)
})

test('carries no secret material: only rv and a public key', () => {
  const link = encodeLink({ rv, hostKey, name: 'x' })
  // The seed must never appear in a link. This is a canary: if someone ever adds
  // it "for convenience", this fails.
  assert.ok(!link.includes('seed'))
  assert.ok(!link.includes('secret'))
  const parsed = parseLink(link)
  assert.deepEqual(Object.keys(parsed).sort(), ['hostKey', 'name', 'owner', 'rv', 'version'])
})

test('CROSS-REJECT: other apps\' links must not parse as PearCinema pairing links', () => {
  const foreign = [
    // The one the donor could not test: a sibling app on this very package.
    'pear://peartune/pair?v=1&rv=' + z32.encode(rv) + '&host=' + z32.encode(hostKey),
    'pear://pearcircle/join?circle=abc&key=def',
    'pear://pearcircle/seeder-pair?rv=' + z32.encode(rv),
    'pear://pearcal/join?cal=abc',
    'https://peerloomllc.com/circle/join?circle=abc',
    'pear://pearcinema/join?rv=' + z32.encode(rv), // right app, WRONG path
    'pear://pearcinemas/pair?rv=' + z32.encode(rv), // lookalike host
    'https://peerloomllc.com/pearcinema/pair?rv=' + z32.encode(rv)
  ]

  for (const link of foreign) {
    assert.throws(() => parseLink(link), /invalid PearCinema pairing link/, `should reject: ${link}`)
    assert.equal(isPairLink(link), false, `isPairLink should be false: ${link}`)
  }
})

test('CROSS-REJECT is symmetric: a PearTune parser refuses a PearCinema link', () => {
  const tune = createLink({ scheme: 'pear://peartune/pair', displayName: 'PearTune' })
  const cinemaLink = encodeLink({ rv, hostKey })
  assert.throws(() => tune.parseLink(cinemaLink), /invalid PearTune pairing link/)
  assert.equal(tune.isPairLink(cinemaLink), false)
})

test('rejects an unsupported version', () => {
  const link = encodeLink({ rv, hostKey }).replace('v=1', 'v=2')
  assert.throws(() => parseLink(link), /unsupported pairing link version/)
})

test('rejects malformed or wrong-length keys', () => {
  assert.throws(() => parseLink('pear://pearcinema/pair?v=1&rv=notz32!!&host=' + z32.encode(hostKey)), /malformed z32/)

  const shortRv = z32.encode(hcrypto.randomBytes(16))
  assert.throws(
    () => parseLink(`pear://pearcinema/pair?v=1&rv=${shortRv}&host=${z32.encode(hostKey)}`),
    /rv must be 32 bytes/
  )

  const shortHost = z32.encode(hcrypto.randomBytes(16))
  assert.throws(
    () => parseLink(`pear://pearcinema/pair?v=1&rv=${z32.encode(rv)}&host=${shortHost}`),
    /host key must be 32 bytes/
  )
})

test('rejects a link missing rv or host', () => {
  assert.throws(() => parseLink('pear://pearcinema/pair?v=1'), /missing rv or host/)
  assert.throws(() => parseLink(`pear://pearcinema/pair?v=1&rv=${z32.encode(rv)}`), /missing rv or host/)
})

test('rejects non-strings and junk', () => {
  assert.throws(() => parseLink(null), /must be a string/)
  assert.throws(() => parseLink(''), /invalid PearCinema pairing link/)
  assert.throws(() => parseLink('pear://pearcinema/pair'), /invalid PearCinema pairing link/)
})

test('a scheme is required', () => {
  assert.throws(() => createLink({}), /needs a scheme/)
})
