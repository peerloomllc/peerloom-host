'use strict'

// "Update now": download the release artifact for this machine, prove it is the
// right file and install it.
//
// Shared by every PeerLoom desktop app. Everything app-specific comes in through the
// same config object update-check.js takes (see README.md). Node built-ins only, so
// an app can copy just these two files.
//
// THE TRUST BOUNDARY is HTTPS to the app's own releases repo plus the `.sha256`
// sidecar published beside every artifact. No sidecar, no apply. On macOS the
// Developer ID team of the .app inside the .dmg is checked as well. Signing the
// Windows and Linux artifacts is future hardening, and is required before any apply
// that does not start with a person clicking a button.
//
// Verification is by digest of the file actually on disk. A download that returned
// 200 proves nothing about the bytes.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

class VerifyError extends Error {
  constructor (msg) { super(msg); this.code = 'VERIFY_FAILED' }
}

// "This machine cannot apply it by itself": the UI offers the release page instead.
class NeedsManualError extends Error {
  constructor (why) { super(why); this.code = 'NEEDS_MANUAL' }
}

function checkConfig (config) {
  if (!config || typeof config !== 'object' || !config.slug || !config.assets) {
    throw new TypeError('update-apply needs an app config with at least slug and assets')
  }
  return config
}

// An asset matcher in the config is a RegExp or a function (name) => boolean.
function matches (matcher, name) {
  if (!matcher) return false
  if (typeof matcher === 'function') return !!matcher(name)
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0
    return matcher.test(name)
  }
  return false
}

// Pull the 64-hex digest out of a `<hex>  <filename>` shasum sidecar.
function parseSha256Sidecar (text) {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/\b([0-9a-f]{64})\b/i)
  return m ? m[1].toLowerCase() : null
}

function sha256File (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('error', reject)
    s.on('data', (d) => hash.update(d))
    s.on('end', () => resolve(hash.digest('hex')))
  })
}

// Which asset does THIS machine need? A release carries every platform's artifacts,
// often phone builds and server downloads too, so picking wrong means downloading a
// verified file that is useless here, or handing the wrong thing to an installer.
//
// On macOS the arm64 and x64 matchers must not overlap: a plain /\.dmg$/ would hand
// an arm64 build to an Intel Mac. That is why `darwinX64` may be a function.
//
// Linux asks instead of guessing: the same machine can run the AppImage or the .deb.
// $APPIMAGE is set by the AppImage's own runtime, so its presence answers "which one
// am I?". Guessing would offer a .deb to an AppImage user and install a second copy.
function selectAsset (assets, { config, platform = process.platform, arch = process.arch, appImage = process.env.APPIMAGE } = {}) {
  const want = checkConfig(config).assets
  const list = (assets || []).filter(a => a && typeof a.name === 'string' && !/\.sha256$/i.test(a.name))
  const by = (matcher) => list.find(a => matches(matcher, a.name))

  let asset = null
  if (platform === 'win32') asset = by(want.win32)
  else if (platform === 'darwin') asset = arch === 'arm64' ? by(want.darwinArm64) : by(want.darwinX64)
  else if (platform === 'linux') asset = appImage ? by(want.appImage) : by(want.deb)
  if (!asset) return null

  // The sidecar is a separate asset named "<artifact>.sha256".
  const sha = (assets || []).find(a => a && a.name === asset.name + '.sha256')
  return {
    name: asset.name,
    url: asset.browser_download_url || null,
    sha256Url: sha ? (sha.browser_download_url || null) : null
  }
}

// The X.Y.Z version in an artifact's filename, or null if there is none. Three parts
// exactly, so suffixes like `-arm64` or `x86_64` are never read as a version.
function versionInName (name) {
  const m = String(name || '').match(/(\d+\.\d+\.\d+)/)
  return m ? m[1] : null
}

// Turn an update (from update-check.js) plus the release's assets into "what will
// happen". Pure, and it throws rather than returning something half usable.
function planApply (update, assets, { config, platform = process.platform, arch = process.arch, appImage = process.env.APPIMAGE } = {}) {
  checkConfig(config)
  if (!update || !update.available) throw new Error('no update available to apply')
  const picked = selectAsset(assets, { config, platform, arch, appImage })
  if (!picked) throw new Error(`no asset for this platform (${platform}/${arch})`)
  if (!picked.url) throw new Error(`asset ${picked.name} has no download url`)
  if (!picked.sha256Url) throw new VerifyError(`asset ${picked.name} has no .sha256 sidecar - refusing to apply an unverifiable download`)

  // Does the artifact carry the version we claim to install? selectAsset matches on
  // the shape of the name, not the version, so a release that tags a new version but
  // carries the old desktop artifacts forward would hand back the build already
  // running. It would verify perfectly, report success and be offered again forever.
  // (PearTune v1.0.1, 2026-08-17.) So refuse, and say why.
  const assetVersion = versionInName(picked.name)
  if (update.latest && assetVersion && assetVersion !== update.latest) {
    throw new NeedsManualError(
      `release ${update.latest} has no build for this platform - its ${picked.name} is still ${assetVersion}. ` +
      'Applying it would reinstall the version you are already running.'
    )
  }

  const applier = platform === 'win32' ? 'windows'
    : platform === 'darwin' ? 'macapp'
      : matches(config.assets.appImage, picked.name) ? 'appimage' : 'deb'

  return { applier, version: update.latest, ...picked }
}

async function download (url, dest, { fetchImpl, userAgent = 'peerloom-update' } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  const res = await doFetch(url, { redirect: 'follow', headers: { 'user-agent': userAgent } })
  if (!res.ok) throw new Error(`download http ${res.status}`)
  await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

// Download the artifact and its sidecar and prove the bytes on disk match. On a
// mismatch the file is deleted, so nothing later can pick up a rejected artifact.
async function downloadAndVerify (plan, { config, workDir, fetchImpl } = {}) {
  checkConfig(config)
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), `${config.slug}-update-`))
  const file = path.join(dir, plan.name)
  const userAgent = config.slug

  await download(plan.url, file, { fetchImpl, userAgent })

  const doFetch = fetchImpl || globalThis.fetch
  const res = await doFetch(plan.sha256Url, { redirect: 'follow', headers: { 'user-agent': userAgent } })
  if (!res.ok) throw new VerifyError(`sha256 sidecar http ${res.status}`)
  const expected = parseSha256Sidecar(await res.text())
  if (!expected) throw new VerifyError('unparseable sha256 sidecar')

  const actual = await sha256File(file)
  if (actual !== expected) {
    try { await fs.promises.unlink(file) } catch {}
    throw new VerifyError(`sha256 mismatch (expected ${expected.slice(0, 12)}..., got ${actual.slice(0, 12)}...)`)
  }
  return { file, digest: actual, dir }
}

// Pull the Team Identifier out of `codesign -dv --verbose=4` output, which prints
// `TeamIdentifier=XXXXXXXXXX`, or `TeamIdentifier=not set` for an ad-hoc or unsigned
// bundle. "not set" must never read as a match. Pure.
function parseCodesignTeam (output) {
  if (typeof output !== 'string') return null
  const m = output.match(/TeamIdentifier=([A-Z0-9]{10})\b/i)
  return m ? m[1].toUpperCase() : null
}

// Where is the running .app? Inside one, process.execPath is
// /Applications/<Name>.app/Contents/MacOS/<Name>, so the bundle is three levels up.
// Null when that shape does not hold (an unpackaged dev run), because we are about
// to `rm -rf` around this path and must not guess it.
function macAppRoot (execPath) {
  const m = String(execPath || '').match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)
  return m ? m[1] : null
}

// The launchd label for a daemon plist path, for the "restart it yourself" message.
function launchdLabel (plist) {
  return path.basename(String(plist || ''), '.plist')
}

// IS SOMETHING SUPERVISING THE APP? This changes how an update ends. Supervised, the
// process that swapped the payload exits and the service manager starts a fresh one
// from the new file. Unsupervised, the app relaunches itself (or quits, on Windows).
//
// Detected, never assumed, because the same AppImage can run as a systemd user
// service or as a tray app someone double-clicked. An app with no service configured
// returns null without running anything.
async function detectSupervisor ({ config, platform = process.platform, exec, fsImpl } = {}) {
  checkConfig(config)
  if (!exec) return null
  const mac = config.mac || {}
  const linux = config.linux || {}
  const windows = config.windows || {}
  try {
    if (platform === 'darwin') {
      // A LaunchDaemon with KeepAlive restarts the old code from the old bundle the
      // moment it dies, so it must be found. (PearTune, 2026-08-18: the UI reported
      // the new version while the daemon ran the old one.)
      if (!mac.daemonPlist) return null
      const ffs = fsImpl || fs
      return ffs.existsSync(mac.daemonPlist) ? 'launchd' : null
    }
    if (platform === 'linux') {
      if (!linux.unit) return null
      const out = await exec(['systemctl', '--user', 'is-active', linux.unit])
      return String(out || '').trim() === 'active' ? 'systemd' : null
    }
    if (platform === 'win32') {
      if (!windows.service) return null
      const out = await exec(['sc.exe', 'query', windows.service])
      return /RUNNING/i.test(String(out || '')) ? 'windows-service' : null
    }
  } catch {
    // A non-zero exit means "no service". Never fatal.
  }
  return null
}

const APPLIERS = {
  // Swap the AppImage in place, then let the supervisor restart us.
  //
  // `install -m 0755` keeps the executable bit, which a plain write would drop,
  // leaving an AppImage that will not launch.
  appimage: async ({ config, file, target, supervisor, exec }) => {
    if (!target) throw new NeedsManualError('no AppImage path to replace ($APPIMAGE is unset)')
    await exec(['install', '-m', '0755', file, target])
    const unit = (config.linux || {}).unit
    if (supervisor === 'systemd' && unit) {
      // --no-block is required. A plain restart tears down this service's cgroup,
      // which kills the `systemctl` child (and us) before it returns 0, so a
      // successful update would surface as an error.
      await exec(['systemctl', '--user', 'restart', '--no-block', unit])
      return { restarted: true, via: 'systemd' }
    }
    // Unsupervised: the app relaunches itself from the file it just replaced.
    return { restarted: false, needsRelaunch: true }
  },

  // Run the verified NSIS installer silently.
  //
  // It is launched through WMI (Win32_Process.Create) so it is not our child. With a
  // Windows service, NSSM kills the service's whole process tree when the installer
  // stops it, which would take the installer down half way. Without a service, the
  // app is a tray process the installer must replace, so the app has to quit and a
  // child of it would go with it.
  windows: async ({ config, file, exec }) => {
    const windows = config.windows || {}
    const args = Array.isArray(windows.installerArgs) ? windows.installerArgs : ['/S']
    const cmd = [`"${file}"`, ...args].join(' ')
    await exec(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmd}'} | Out-Null`])
    // With a service, the installer stops it, replaces the files and starts it again.
    if (windows.service) return { restarted: true, via: 'installer' }
    // Without one, the app must exit so its files are free to replace.
    return { restarted: false, needsQuit: true, via: 'installer' }
  },

  // Mount the verified .dmg, check who signed the .app inside, and swap it into
  // place. If a LaunchDaemon supervises the app, end it so KeepAlive starts a fresh
  // one from the new bundle.
  //
  // The team check works whether or not the app is notarized, so it covers apps that
  // cannot be notarized as well as those that are. Gating on `spctl` instead would
  // reject every legitimate update of an app that is not notarized.
  macapp: async ({ config, file, target, supervisor, exec, mountDir }) => {
    const mac = config.mac || {}
    const bundle = mac.appBundle
    if (!bundle || !mac.teamId) throw new NeedsManualError('this app has no macOS bundle name or signing team configured')
    if (!target) throw new NeedsManualError(`could not work out where ${bundle} is installed`)
    const mount = mountDir || `/tmp/${config.slug}-update-${Date.now()}`
    await exec(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', mount, file])
    try {
      const src = `${mount}/${bundle}`
      // --deep --strict, because a bundle whose nested code was swapped still passes
      // a shallow check.
      await exec(['codesign', '--verify', '--deep', '--strict', src])
      const team = parseCodesignTeam(await exec(['codesign', '-dv', '--verbose=4', src]))
      if (team !== String(mac.teamId).toUpperCase()) {
        throw new VerifyError(`the .app is signed by team ${team || 'nobody'}, expected ${mac.teamId}`)
      }
      // Stage beside the target and swap. Deleting first would leave no app at all
      // if anything failed half way.
      await exec(['ditto', src, `${target}.new`])
      await exec(['rm', '-rf', `${target}.old`])
      await exec(['mv', target, `${target}.old`])
      await exec(['mv', `${target}.new`, target])
      await exec(['rm', '-rf', `${target}.old`])
    } finally {
      // Always unmount, including after a rejected signature.
      await exec(['hdiutil', 'detach', mount, '-quiet']).catch(() => {})
    }

    // The swap is not the whole update while a daemon still runs the old bundle by
    // inode. A plain kill: `launchctl kickstart` on a system job needs root, and a
    // daemon that runs as the console user can be signalled by that user. pkill
    // exits 1 when nothing matched, which just means no daemon was running.
    if (supervisor === 'launchd' && mac.daemonPlist && mac.hostArgv) {
      let killed = true
      await exec(['pkill', '-f', mac.hostArgv]).catch(() => { killed = false })
      if (killed) return { restarted: true, needsRelaunch: true, via: 'launchd' }
      // A root-owned daemon refuses the kill. Say so instead of claiming success.
      return { restarted: false, needsRelaunch: true, via: 'dmg-swap', staleDaemon: true }
    }
    return { restarted: false, needsRelaunch: true, via: 'dmg-swap' }
  },

  // Installing a .deb needs root.
  //
  // With a helper configured, the package installed a root-owned helper and a polkit
  // rule letting this user run exactly that program with no password. The digest is
  // passed across and re-checked by the helper as root, because pkexec authorises
  // running the program and says nothing about its arguments. A missing helper is an
  // older build: NEEDS_MANUAL, and the person gets the verified download instead. The
  // helper restarts the service itself, last, so a cgroup teardown cannot interrupt
  // dpkg.
  //
  // Without a helper, `pkexec dpkg -i` asks for the person's password through the
  // desktop's polkit agent, then the app relaunches itself.
  deb: async ({ config, file, digest, user, helperPath, exec, fsImpl }) => {
    const helper = helperPath || (config.linux || {}).debHelper
    if (helper) {
      const ffs = fsImpl || fs
      if (!ffs.existsSync(helper)) {
        throw new NeedsManualError('this install has no privileged updater helper - update from the download instead')
      }
      await exec(['pkexec', helper, file, digest, user || os.userInfo().username, ''])
      return { restarted: true, via: 'pkexec' }
    }
    await exec(['pkexec', 'dpkg', '-i', file])
    return { restarted: false, needsRelaunch: true, via: 'pkexec-dpkg' }
  }
}

async function applyUpdate (plan, { config, file, digest, supervisor, target = process.env.APPIMAGE, exec, user, helperPath, mountDir, fsImpl, log = () => {} } = {}) {
  checkConfig(config)
  const applier = APPLIERS[plan.applier]
  if (!applier) throw new NeedsManualError(`no applier for ${plan.applier}`)
  log('update:applying', { version: plan.version, via: plan.applier })
  const r = await applier({ config, file, digest, target, supervisor, exec, user, helperPath, mountDir, fsImpl })
  return { ...r, applier: plan.applier, version: plan.version }
}

// Run one command and resolve its stdout AND stderr as one string. Rejects on a
// non-zero exit, which detectSupervisor reads as "no service" and an applier reads as
// a failure.
//
// Stderr is required: `codesign -dv --verbose=4` writes its whole report, including
// the TeamIdentifier line, to stderr. (PearTune, 2026-08-29: stdout alone made every
// real Mac refuse a correctly signed update.)
function defaultExec (argv) {
  const { execFile } = require('child_process')
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve(`${stdout || ''}${stderr || ''}`)
    })
  })
}

// The stateful driver behind an "Update now" button. One apply at a time, and every
// outcome is a state the UI can show, including the ones where nothing happened,
// because "nothing happened" must never look like "it worked".
//
// onRelaunch: called when the app must restart itself from the new files.
// onQuit: called when the app must exit so a Windows installer can replace it.
class UpdateApplier {
  constructor ({ config, getUpdate, platform = process.platform, arch = process.arch, target = process.env.APPIMAGE, execPath = process.execPath, exec = defaultExec, fetchImpl, fsImpl = fs, onRelaunch = null, onQuit = null, log = () => {} } = {}) {
    this._config = checkConfig(config)
    this._getUpdate = getUpdate
    this._platform = platform
    this._arch = arch
    this._target = target
    this._execPath = execPath
    this._exec = exec
    this._fetchImpl = fetchImpl
    this._fs = fsImpl
    this._onRelaunch = onRelaunch
    this._onQuit = onQuit
    this._log = log
    this._state = { status: 'idle' }
  }

  getState () { return { ...this._state } }

  async apply () {
    const update = typeof this._getUpdate === 'function' ? this._getUpdate() : null
    if (!update || !update.available) {
      this._state = { status: 'no-update' }
      return this.getState()
    }
    // One at a time. A second click during a large download must not start another.
    if (this._state.status === 'running') return this.getState()
    this._state = { status: 'running', version: update.latest }

    // Every failure lands on a state that offers the release page. "Download it
    // yourself" is always available and never wrong.
    const manual = { status: 'needs-manual', version: update.latest, htmlUrl: update.htmlUrl || null }
    const config = this._config

    try {
      const plan = planApply(update, update.assets, { config, platform: this._platform, arch: this._arch, appImage: this._target })
      const { file, digest } = await downloadAndVerify(plan, { config, fetchImpl: this._fetchImpl })
      this._log('update:verified', { version: plan.version, digest: digest.slice(0, 12) })

      const supervisor = await detectSupervisor({ config, platform: this._platform, exec: this._exec, fsImpl: this._fs })
      // The target is the AppImage file on Linux, the .app bundle on macOS and
      // nothing on Windows (the installer knows where it lives).
      const target = this._platform === 'darwin' ? macAppRoot(this._execPath) : this._target
      const r = await applyUpdate(plan, { config, file, digest, supervisor, target, exec: this._exec, log: this._log })

      if (r.needsQuit) {
        this._state = { status: 'restarting', version: plan.version, via: 'installer' }
        if (this._onQuit) this._onQuit()
      } else if (r.needsRelaunch) {
        // staleDaemon: the swap worked but the old daemon is still running and we
        // could not end it. Say so, or the person believes an update that is not
        // actually running.
        const label = launchdLabel((config.mac || {}).daemonPlist)
        this._state = r.staleDaemon
          ? {
              status: 'restarting',
              version: plan.version,
              via: 'self',
              staleDaemon: true,
              warning: 'The update is installed, but the background service is still ' +
                'running the old version. Restart this Mac, or run: ' +
                `sudo launchctl kickstart -k system/${label}`
            }
          : { status: 'restarting', version: plan.version, via: 'self' }
        if (this._onRelaunch) this._onRelaunch()
      } else {
        this._state = { status: 'restarting', version: plan.version, via: r.via || 'supervisor' }
      }
    } catch (e) {
      // "Not possible here" (needs-manual) and "something is wrong with the download"
      // (error) are different problems, and the UI says which.
      this._state = e.code === 'NEEDS_MANUAL'
        ? { ...manual, reason: e.message }
        : { status: 'error', version: update.latest, error: e.message, htmlUrl: update.htmlUrl || null }
      this._log('update:apply-failed', { error: e.message })
    }
    return this.getState()
  }
}

module.exports = {
  selectAsset,
  versionInName,
  planApply,
  download,
  downloadAndVerify,
  sha256File,
  parseSha256Sidecar,
  parseCodesignTeam,
  macAppRoot,
  detectSupervisor,
  APPLIERS,
  applyUpdate,
  UpdateApplier,
  defaultExec,
  VerifyError,
  NeedsManualError
}
