// The pairing link, encoded into the QR the host dashboard shows.
//
// It carries NO secret material. `rv` only names a rendezvous token that is
// valid for five minutes, and `host` is a public key. A photographed QR is
// useless once the window closes, and even inside the window it does not by
// itself let anyone reach the library: the phone still has to be admitted by the
// operator's open session, and the host still writes a grant keyed to the
// phone's real, Noise-proven public key.
//
// The `hostKey` in the link exists so the PHONE can verify it is talking to the
// right host (guard 1 from PearCircle's seeder review): topic knowledge alone
// must never be enough to impersonate the host and harvest a device.
//
// PER-APP SCHEME, and this is the whole reason the file is a factory. Each app's
// parser must CROSS-REJECT every other app's links: a PearCircle circle invite, a
// PearCal join URL and a PearTune pairing link must all fail to parse as a
// PearCinema pairing link, and vice versa. A parser that is loose here is a
// vector for pointing a user's device at the wrong app's topic. Because the
// scheme is baked into the closure at construction, that cross-rejection is
// structural rather than a check someone has to remember to write.

const z32 = require('z32')
const b4a = require('b4a')
const { LINK_VERSION } = require('./constants')

// scheme:      e.g. 'pear://pearcinema/pair'
// displayName: e.g. 'PearCinema', used only in error messages
function createLink ({ scheme, displayName = 'pairing', version = LINK_VERSION }) {
  if (!scheme || typeof scheme !== 'string') throw new Error('createLink needs a scheme')

  function encodeLink ({ rv, hostKey, name, owner = false }) {
    const rvStr = typeof rv === 'string' ? rv : z32.encode(rv)
    const hostStr = typeof hostKey === 'string' ? hostKey : z32.encode(hostKey)
    const q = [
      `v=${version}`,
      `rv=${rvStr}`,
      `host=${hostStr}`
    ]
    if (name) q.push(`name=${encodeURIComponent(name)}`)
    // A hint, NOT authority: it tells the phone this code is meant to grant ownership, so the app can
    // say so and can flag a promotion that did not take instead of pairing as a normal device in
    // silence. The host still decides scope on its side (an owner window) - the flag alone grants
    // nothing, and a photographed QR learning "this was an owner code" costs nothing.
    if (owner) q.push('owner=1')
    return `${scheme}?${q.join('&')}`
  }

  // Strict. Anything that is not exactly this app's v1 pairing link throws.
  function parseLink (link) {
    if (typeof link !== 'string') throw new Error('link must be a string')

    const trimmed = link.trim()
    const qIndex = trimmed.indexOf('?')
    if (qIndex === -1) throw new Error(`invalid ${displayName} pairing link`)

    const base = trimmed.slice(0, qIndex)
    if (base !== scheme) throw new Error(`invalid ${displayName} pairing link`)

    const params = new Map()
    for (const pair of trimmed.slice(qIndex + 1).split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      params.set(pair.slice(0, eq), pair.slice(eq + 1))
    }

    const v = Number(params.get('v'))
    if (v !== version) throw new Error(`unsupported pairing link version: ${params.get('v')}`)

    const rvStr = params.get('rv')
    const hostStr = params.get('host')
    if (!rvStr || !hostStr) throw new Error('pairing link missing rv or host')

    let rv, hostKey
    try {
      rv = z32.decode(rvStr)
      hostKey = z32.decode(hostStr)
    } catch {
      throw new Error('pairing link has malformed z32')
    }

    if (rv.byteLength !== 32) throw new Error('rv must be 32 bytes')
    if (hostKey.byteLength !== 32) throw new Error('host key must be 32 bytes')

    const name = params.has('name') ? decodeURIComponent(params.get('name')) : null
    // Owner hint (optional, additive - an old link without it parses as a normal code).
    const owner = params.get('owner') === '1'

    return { version: v, rv, hostKey, name, owner }
  }

  // Convenience for the phone: does this look like ours at all? Used to route a
  // scanned QR to the right handler without throwing.
  function isPairLink (link) {
    return typeof link === 'string' && link.trim().startsWith(scheme + '?')
  }

  return { encodeLink, parseLink, isPairLink, scheme, version }
}

module.exports = { createLink, b4a }
