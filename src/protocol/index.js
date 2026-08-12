// One call that brands the whole wire for one app.
//
// Everything app-specific about the protocol - the two Protomux protocol strings,
// the pairing link scheme, the id namespaces, the relay key - is decided here and
// nowhere else. Modules downstream take the returned object rather than reaching
// for a constant, which is what makes two apps on this package structurally unable
// to talk to each other's hosts:
//
//   PearTune    -> peartune/pair/1,    peartune/media/1,    pear://peartune/pair
//   PearCinema  -> pearcinema/pair/1,  pearcinema/media/1,  pear://pearcinema/pair
//
// A PearTune phone dialing a PearCinema host completes Noise, opens a mux, asks for
// `peartune/media/1`, gets no channel, and goes away. That is the intended failure:
// quiet and total, with no half-connected state to reason about.
//
// THE APP SLUG IS A DATA IDENTIFIER, not a display name. It seeds the id namespaces,
// so changing it after a release orphans every resume position in the field. Pick it
// once. `displayName` is the one that may change freely - it only reaches error text.

const constants = require('./constants')
const framing = require('./framing')
const relay = require('./relay')
const { createIds, randomRv } = require('./ids')
const { createLink } = require('./link')
const { createChannels } = require('./channels')

function createProtocol ({
  app,
  displayName = null,
  // Defaulted from `app` so a consumer states the slug once. Override only to
  // reproduce something already in the field.
  pairProtocol = null,
  mediaProtocol = null,
  linkScheme = null,
  linkVersion = constants.LINK_VERSION,
  // z32 string, or null for an app that ships no relay. Null is a first-class
  // value here: see src/protocol/relay.js.
  relayKey = null
} = {}) {
  if (!app || typeof app !== 'string') throw new Error('createProtocol needs an app slug')
  if (!/^[a-z][a-z0-9-]*$/.test(app)) throw new Error('app slug must be lowercase letters, digits and hyphens')

  const name = displayName || app

  const pair = pairProtocol || `${app}/pair/1`
  const media = mediaProtocol || `${app}/media/1`
  const scheme = linkScheme || `pear://${app}/pair`

  const ids = createIds({ app })
  const link = createLink({ scheme, displayName: name, version: linkVersion })
  const channels = createChannels({ pairProtocol: pair, mediaProtocol: media })

  return {
    app,
    displayName: name,

    PAIR_PROTOCOL: pair,
    MEDIA_PROTOCOL: media,
    LINK_SCHEME: scheme,
    LINK_VERSION: linkVersion,

    // Brand-free constants, re-exported so a consumer needs one import rather
    // than two and can never end up with a protocol object from one app beside
    // constants from another.
    PAIR_TTL_MS: constants.PAIR_TTL_MS,
    CHUNK_SIZE: constants.CHUNK_SIZE,
    ERR: constants.ERR,
    SCOPE: constants.SCOPE,

    relayKey,
    relayKeyBuffer: relay.decodeRelayKey(relayKey),

    ids,
    link,
    channels,
    framing,
    relay,

    randomRv
  }
}

module.exports = { createProtocol, constants, framing, relay }
