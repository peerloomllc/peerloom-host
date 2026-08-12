// Channel construction, shared by host and client.
//
// WHY THIS FILE EXISTS. Protomux assigns each message a type id by REGISTRATION
// ORDER: the first addMessage() on a channel is type 0, the next is type 1, and
// so on. Both ends must therefore register the same encodings in the same order,
// or every message is decoded as the wrong type. It fails silently - the frames
// arrive, decode into garbage, and the handler you expected simply never fires.
//
// That bug cost real time during PearTune's milestone 1: the host registered
// `paired` then `deviceHello` while the client did the reverse, so the hello was
// decoded as a `paired` and pairing just hung with no error on either side.
//
// So the order lives HERE, once, and both sides call these factories. Never call
// mux.createChannel + addMessage for one of these channels by hand; if you add a
// message type, add it to the END of the list (appending preserves every
// existing type id; inserting in the middle silently renumbers the wire).

const framing = require('./framing')

// pairProtocol / mediaProtocol are the app's Protomux protocol strings, e.g.
// 'pearcinema/pair/1'. Different strings are what stop a PearTune phone from
// half-connecting to a PearCinema host: Protomux simply never opens the channel.
function createChannels ({ pairProtocol, mediaProtocol }) {
  if (!pairProtocol || !mediaProtocol) throw new Error('createChannels needs pairProtocol and mediaProtocol')

  // Message order for <app>/pair/1: hello(0), paired(1).
  function pairChannel (mux, { id, onhello = null, onpaired = null, onopen = null, onclose = null } = {}) {
    const channel = mux.createChannel({
      protocol: pairProtocol,
      id,
      onopen: onopen || undefined,
      onclose: onclose || undefined
    })
    if (!channel) return null

    const messages = {
      hello: channel.addMessage({ encoding: framing.deviceHello, onmessage: onhello || undefined }),
      paired: channel.addMessage({ encoding: framing.paired, onmessage: onpaired || undefined })
    }

    return { channel, messages }
  }

  // Message order for <app>/media/1: req(0), res(1), chunk(2), end(3), err(4), push(5).
  // `push` is the host's one unsolicited server->client event (session handoff). It is LAST
  // so every existing type id is unchanged - an old peer that never registers it just drops
  // the frame (Protomux ignores an unknown type), which is exactly the backward-compat this
  // file exists to guarantee.
  function mediaChannel (mux, {
    id,
    onreq = null,
    onres = null,
    onchunk = null,
    onend = null,
    onerr = null,
    onpush = null,
    onopen = null,
    onclose = null
  } = {}) {
    const channel = mux.createChannel({
      protocol: mediaProtocol,
      id,
      onopen: onopen || undefined,
      onclose: onclose || undefined
    })
    if (!channel) return null

    const messages = {
      req: channel.addMessage({ encoding: framing.req, onmessage: onreq || undefined }),
      res: channel.addMessage({ encoding: framing.res, onmessage: onres || undefined }),
      chunk: channel.addMessage({ encoding: framing.chunk, onmessage: onchunk || undefined }),
      end: channel.addMessage({ encoding: framing.end, onmessage: onend || undefined }),
      err: channel.addMessage({ encoding: framing.err, onmessage: onerr || undefined }),
      push: channel.addMessage({ encoding: framing.push, onmessage: onpush || undefined })
    }

    return { channel, messages }
  }

  return { pairChannel, mediaChannel, pairProtocol, mediaProtocol }
}

module.exports = { createChannels }
