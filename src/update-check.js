'use strict'

// "A new version is out": asks GitHub for the app's latest release and says whether
// this install is behind. It never installs anything; update-apply.js does that when
// the person asks.
//
// Shared by every PeerLoom desktop app. Everything app-specific (name, repo, env var
// prefix, asset names) comes in through a config object, documented in README.md.
// Node built-ins only, plus the sibling update-apply.js, so an app can copy just
// these two files if it does not want the whole package.
//
// FAIL OPEN, ALWAYS. GitHub rate-limits unauthenticated callers to 60 requests an
// hour and goes down like anything else. Every failure is recorded and returned as
// `error`. Nothing here may stop the app doing its real job.

const path = require('path')
const { selectAsset, versionInName } = require('./update-apply')

// Hourly. Unauthenticated GitHub allows 60 requests an hour per IP and a machine may
// sit behind a NAT shared with others, so this stays far below the limit.
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000

function checkConfig (config) {
  if (!config || typeof config !== 'object' || !config.slug || !config.repo || !config.assets) {
    throw new TypeError('update-check needs an app config with at least slug, repo and assets')
  }
  return config
}

function envName (config, suffix) {
  return `${config.envPrefix || String(config.slug).toUpperCase()}_${suffix}`
}

// `vX.Y.Z` or `X.Y.Z`, with any pre-release suffix ignored for ordering: `1.0.1-rc2`
// compares as 1.0.1. Good enough for "is there a newer release", the only question
// being asked.
function parseVersion (v) {
  if (typeof v !== 'string') return null
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return null
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)]
}

function compareVersions (a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

// An unreadable version on either side means "no update". A banner that announces a
// release that does not exist is worse than none, because the next real one is not
// believed.
function isNewer (latest, current) {
  if (!parseVersion(latest) || !parseVersion(current)) return false
  return compareVersions(latest, current) > 0
}

// Should this install check at all? Inside a container the image and the store that
// pins it own updates (Umbrel shows its own "update available"), so a banner telling
// the person to download an installer would be wrong there. /.dockerenv is present in
// Docker and Podman alike. <PREFIX>_NO_UPDATE_CHECK turns it off anywhere else, for
// packagers and distro builds.
function updatesDisabled ({ config, env = process.env, fs = require('fs') } = {}) {
  checkConfig(config)
  const name = envName(config, 'NO_UPDATE_CHECK')
  if (env[name]) return { disabled: true, reason: name }
  try {
    if (fs.existsSync('/.dockerenv')) return { disabled: true, reason: 'container' }
  } catch {}
  return { disabled: false, reason: null }
}

// The app's own version, for a process that has no Electron `app.getVersion()` to
// ask (a daemon or a systemd service). <PREFIX>_VERSION wins. Otherwise try the
// package.json one up, beside and two up from `baseDir`, which defaults to the
// directory of the program's entry script. That covers a source checkout, a Docker
// image that copies the manifest beside the code and a packaged app.asar where the
// entry sits two levels down. (PearTune, 2026-08: a serviced host found no version
// and so never checked.)
//
// Relative to the entry script and not to this file, because this file usually sits
// in node_modules/@peerloom/host, where `..` is this package's manifest.
//
// A missing manifest must not throw: null means "unknown", and the caller then runs
// no check at all instead of comparing against an invented version.
function appVersion ({ config, env = process.env, baseDir, load } = {}) {
  checkConfig(config)
  const fromEnv = env[envName(config, 'VERSION')]
  if (fromEnv) return fromEnv
  const dir = baseDir || (require.main && require.main.filename ? path.dirname(require.main.filename) : process.cwd())
  const read = load || ((p) => require(path.resolve(dir, p)))
  for (const p of ['../package.json', './package.json', '../../package.json']) {
    try {
      const v = read(p).version
      if (v) return v
    } catch {}
  }
  return null
}

// Shape the GitHub release JSON into what the UI needs. `htmlUrl` is the release page,
// which is always a correct fallback for "download it yourself".
function evaluateRelease (release, currentVersion, { config, platform, arch, appImage } = {}) {
  checkConfig(config)
  if (!release || typeof release !== 'object') return { error: 'no release data' }
  if (release.draft || release.prerelease) return { available: false, current: currentVersion, reason: 'prerelease' }
  const latest = String(release.tag_name || release.name || '').trim()
  if (!latest) return { error: 'release has no tag' }
  const bare = latest.replace(/^v/i, '')
  const assets = (Array.isArray(release.assets) ? release.assets : [])
    .filter(a => a && typeof a.name === 'string')
    .map(a => ({ name: a.name, browser_download_url: a.browser_download_url || null }))
  // A release that did not rebuild this platform may carry the previous installer
  // forward. Offering it would announce a version that "Update now" then refuses to
  // install, so an installer older than the tag means nothing new for this machine.
  // No installer at all falls through unchanged.
  const picked = selectAsset(assets, { config, platform, arch, appImage })
  const builtFor = picked && versionInName(picked.name)
  if (builtFor && builtFor !== bare) {
    return { available: false, current: currentVersion, latest: bare, reason: 'no-build-for-platform' }
  }
  return {
    available: isNewer(latest, currentVersion),
    current: currentVersion,
    latest: bare,
    htmlUrl: typeof release.html_url === 'string' ? release.html_url : null,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    // Carried so "Update now" can plan without a second request to GitHub. Trimmed to
    // the two fields update-apply.js uses, because the full asset objects are large
    // and this state is polled by the UI.
    assets
  }
}

class UpdateChecker {
  constructor ({ config, currentVersion, log = () => {}, intervalMs = DEFAULT_INTERVAL_MS, firstDelayMs = 0, fetchImpl = null, url = null, env = process.env } = {}) {
    this.config = checkConfig(config)
    this.currentVersion = currentVersion
    this.log = log
    this.intervalMs = intervalMs
    this.firstDelayMs = firstDelayMs
    this.url = url || env[envName(config, 'UPDATE_LATEST_URL')] || `https://api.github.com/repos/${config.repo}/releases/latest`
    this.fetch = fetchImpl || globalThis.fetch
    this.state = { checkedAt: null, available: false, current: currentVersion }
    this.timer = null
    this.firstTimer = null
  }

  get () { return { ...this.state } }

  async check () {
    try {
      const res = await this.fetch(this.url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `${this.config.slug}/${this.currentVersion}` }
      })
      if (!res.ok) throw new Error(`github ${res.status}`)
      this.state = { ...evaluateRelease(await res.json(), this.currentVersion, { config: this.config }), checkedAt: Date.now() }
      if (this.state.available) this.log('update:available', { current: this.currentVersion, latest: this.state.latest })
    } catch (e) {
      // Keep what we last knew. A transient failure must not take back a banner that
      // was right ten minutes ago.
      this.state = { ...this.state, error: e.message, checkedAt: Date.now() }
    }
    return this.get()
  }

  start () {
    const run = () => this.check().catch(() => {})
    if (this.firstDelayMs > 0) {
      this.firstTimer = setTimeout(run, this.firstDelayMs)
      if (this.firstTimer.unref) this.firstTimer.unref()
    } else {
      run()
    }
    this.timer = setInterval(run, this.intervalMs)
    // A release check is not a reason to keep a process alive.
    if (this.timer.unref) this.timer.unref()
    return this
  }

  stop () {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.timer) clearInterval(this.timer)
    this.firstTimer = null
    this.timer = null
  }
}

// The one call every front end makes: "give me a running checker, or null and the
// reason". The refusals (container, opted out, no version) live here so a tray app
// and a daemon cannot drift into different answers.
function createUpdateChecker ({ config, currentVersion = null, log = () => {}, env = process.env, versionOf = appVersion, intervalMs, firstDelayMs } = {}) {
  checkConfig(config)
  const off = updatesDisabled({ config, env })
  if (off.disabled) return { checker: null, reason: off.reason, version: currentVersion }
  const version = currentVersion || versionOf({ config, env })
  if (!version) return { checker: null, reason: 'unknown version', version: null }
  const checker = new UpdateChecker({ config, currentVersion: version, log, intervalMs, firstDelayMs, env }).start()
  return { checker, reason: null, version }
}

module.exports = {
  parseVersion,
  compareVersions,
  isNewer,
  updatesDisabled,
  appVersion,
  evaluateRelease,
  UpdateChecker,
  createUpdateChecker,
  DEFAULT_INTERVAL_MS
}
