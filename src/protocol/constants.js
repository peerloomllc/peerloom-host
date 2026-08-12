// Wire constants that carry NO app branding.
//
// Shared by the host (Node) and the phone worklet (Bare), so this file must stay
// dependency-light and free of any Node-only API.
//
// The branded strings - the Protomux protocol names, the link scheme, the id
// namespaces - are NOT here. They live in `createProtocol()` because each app
// needs its own set and two apps sharing them would let a PearTune phone
// half-connect to a PearCinema host. Everything in this file is genuinely the
// same value for every consumer, so it is a plain module rather than a factory.
//
// Protocol version lives in the Protomux protocol STRING, not in a field. A v2
// is a new string, and a host can serve both at once.

module.exports = {
  // The pairing link's format version. Bumped only when the QUERY SHAPE of a
  // pairing link changes; it is not an app version and not a protocol version.
  LINK_VERSION: 1,

  // A pairing session is open only while the operator has the dashboard open,
  // and never for more than this. Same posture as the PearCircle seeder: the
  // trust for a FIRST pair is "a session is open on a topic the operator just
  // minted", so the window has to be short.
  PAIR_TTL_MS: 5 * 60 * 1000,

  // Byte-stream chunk size for media.stream. 64 KiB is a compromise: big enough
  // that per-frame overhead is noise, small enough that a seek does not have to
  // wait on a fat in-flight frame.
  CHUNK_SIZE: 64 * 1024,

  // Error codes. Typed, because an unknown method must degrade rather than drop
  // the channel.
  ERR: {
    NO_METHOD: 'ENOMETHOD',
    NOT_FOUND: 'ENOTFOUND',
    BAD_PARAMS: 'EBADPARAMS',
    FORBIDDEN: 'EFORBIDDEN',
    INTERNAL: 'EINTERNAL'
  },

  SCOPE: {
    FULL: 'full',
    READONLY: 'readonly',
    // The OWNER of the library, from the app. A strict SUPERSET of FULL -
    // browses/streams/favorites like any device, PLUS the owner.* maintenance
    // methods. Minted ONLY by pairing through the dashboard's "pair as owner"
    // window (host-side; a phone can never assert it), so it stays as
    // forgery-proof as every other grant value.
    OWNER: 'owner'
  }
}
