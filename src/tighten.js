// Make a secret file owner-only if it is not already. Best-effort by design: a
// filesystem that cannot express the mode (a Windows volume, a FAT-formatted USB
// drive, some container bind mounts) must not stop the host from starting. Logged
// where a caller supplies a log, so a failure is visible rather than silent.
//
// Its own file so dashboard-auth.js does not pull in identity.js (and hyperdht)
// for it: PearSheet's seeder dashboard uses dashboard-auth alone.
const fs = require('fs')
const path = require('path')

function tighten (file, log = null) {
  try {
    const mode = fs.statSync(file).mode & 0o777
    if (mode === 0o600) return true
    fs.chmodSync(file, 0o600)
    if (log) log('identity:tightened', { file: path.basename(file), was: mode.toString(8) })
    return true
  } catch (e) {
    if (log) log('identity:tighten-failed', { file: path.basename(file), err: e.message })
    return false
  }
}

module.exports = { tighten }
