'use strict'

// "A new version is out". The properties that matter are the negative ones: a banner
// that appears when it should not stops being believed, and a container install that
// offers a download tells the person to do the wrong thing.

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  UpdateChecker, evaluateRelease, isNewer, compareVersions, parseVersion, updatesDisabled,
  appVersion, createUpdateChecker, DEFAULT_INTERVAL_MS
} = require('../src/update-check')
const { PEARSHEET, PEARTUNE } = require('./update-configs')

const config = PEARTUNE
const noFs = { existsSync: () => false }

test('version compare handles the tag shapes releases actually use', () => {
  assert.equal(isNewer('v1.0.1', '1.0.0'), true, 'a v prefix is the normal tag form')
  assert.equal(isNewer('1.0.0', '1.0.0'), false, 'the same version is not an update')
  assert.equal(isNewer('0.9.9', '1.0.0'), false, 'older is not newer')
  assert.equal(isNewer('1.0.1-rc2', '1.0.0'), true, 'a pre-release suffix compares on its numeric core')
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1, 'minor versions compare as numbers')
  assert.deepEqual(parseVersion('v2.3'), [2, 3, 0])
  assert.equal(DEFAULT_INTERVAL_MS, 60 * 60 * 1000)
})

test('an unreadable version never claims an update', () => {
  assert.equal(isNewer('not-a-version', '1.0.0'), false)
  assert.equal(isNewer('1.0.1', 'not-a-version'), false)
  assert.equal(isNewer(undefined, '1.0.0'), false)
})

test('drafts and pre-releases are not offered', () => {
  const r = evaluateRelease({ tag_name: 'v2.0.0', prerelease: true }, '1.0.0', { config })
  assert.equal(r.available, false)
  assert.equal(r.reason, 'prerelease')
  assert.equal(evaluateRelease({ tag_name: 'v2.0.0', draft: true }, '1.0.0', { config }).available, false)
})

test('a real newer release reports the version and where to get it', () => {
  const r = evaluateRelease({ tag_name: 'v1.1.0', html_url: 'https://github.com/peerloomllc/peartune/releases/tag/v1.1.0', published_at: '2026-08-01T00:00:00Z' }, '1.0.0', { config })
  assert.equal(r.available, true)
  assert.equal(r.latest, '1.1.0', 'the v is stripped for display')
  assert.match(r.htmlUrl, /releases\/tag\/v1\.1\.0$/)
})

test('the release assets are carried through, trimmed, for "Update now" to plan from', () => {
  const r = evaluateRelease({
    tag_name: 'v1.1.0',
    assets: [
      { name: 'PearTune-Setup-1.1.0.exe', browser_download_url: 'https://x/exe', size: 1, id: 9 },
      { name: 'PearTune-Setup-1.1.0.exe.sha256', browser_download_url: 'https://x/sha' },
      null
    ]
  }, '1.0.0', { config, platform: 'win32' })
  assert.deepEqual(r.assets, [
    { name: 'PearTune-Setup-1.1.0.exe', browser_download_url: 'https://x/exe' },
    { name: 'PearTune-Setup-1.1.0.exe.sha256', browser_download_url: 'https://x/sha' }
  ])
  // No assets must give an empty list, because the applier iterates it.
  assert.deepEqual(evaluateRelease({ tag_name: 'v1.1.0' }, '1.0.0', { config }).assets, [])
})

// A release that skips a desktop platform may carry the previous installer forward.
// That installer is older than the tag and "Update now" refuses it, so it must not be
// offered. (PearTune v1.0.11, 2026-09-22.)
test('an installer older than the tag is not offered as an update', () => {
  const release = (v) => ({
    tag_name: 'v1.0.12',
    assets: [
      { name: 'peartune-v1.0.12.apk' },
      { name: `PearTune-Setup-${v}.exe` }, { name: `PearTune-Setup-${v}.exe.sha256` },
      { name: `PearTune-${v}.AppImage` }, { name: `peartune-desktop_${v}_amd64.deb` },
      { name: `PearTune-${v}.dmg` }, { name: `PearTune-${v}-arm64.dmg` }
    ]
  })
  for (const opts of [{ platform: 'win32' }, { platform: 'linux', appImage: '/x.AppImage' }, { platform: 'linux', appImage: '' }, { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }]) {
    const stale = evaluateRelease(release('1.0.11'), '1.0.11', { config, ...opts })
    assert.equal(stale.available, false, `carried-forward installer offered on ${JSON.stringify(opts)}`)
    assert.equal(stale.reason, 'no-build-for-platform')
    assert.equal(evaluateRelease(release('1.0.12'), '1.0.11', { config, ...opts }).available, true, `real build not offered on ${JSON.stringify(opts)}`)
  }
})

test('in a container the check is off, because the image owns updates there', () => {
  const fakeFs = { existsSync: (p) => p === '/.dockerenv' }
  assert.deepEqual(updatesDisabled({ config, env: {}, fs: fakeFs }), { disabled: true, reason: 'container' })
  assert.deepEqual(updatesDisabled({ config, env: { PEARTUNE_NO_UPDATE_CHECK: '1' }, fs: noFs }), { disabled: true, reason: 'PEARTUNE_NO_UPDATE_CHECK' })
  assert.deepEqual(updatesDisabled({ config, env: {}, fs: noFs }), { disabled: false, reason: null })
})

test('GitHub being down does not throw, and does not take back what we knew', async () => {
  let call = 0
  const c = new UpdateChecker({
    config,
    currentVersion: '1.0.0',
    url: 'https://example.invalid/latest',
    fetchImpl: async () => {
      call++
      if (call === 1) return { ok: true, json: async () => ({ tag_name: 'v1.2.0', html_url: 'u' }) }
      throw new Error('network down')
    }
  })
  await c.check()
  assert.equal(c.get().available, true)

  await c.check()
  const s = c.get()
  assert.equal(s.error, 'network down')
  assert.equal(s.available, true, 'a transient failure must not take back a banner that was right')
})

test('the app finds its own version in every layout it ships in', () => {
  const only = (want) => (p) => { if (p === want) return { version: '1.0.0' }; throw new Error('nope') }
  assert.equal(appVersion({ config, env: { PEARTUNE_VERSION: '2.3.4' } }), '2.3.4', 'an explicit version wins')
  assert.equal(appVersion({ config, env: {}, load: only('../package.json') }), '1.0.0', 'a source checkout')
  assert.equal(appVersion({ config, env: {}, load: only('./package.json') }), '1.0.0', 'a manifest copied beside the code')
  assert.equal(appVersion({ config, env: {}, load: only('../../package.json') }), '1.0.0', 'a packaged app.asar')
  assert.equal(appVersion({ config, env: {}, load: () => { throw new Error('no such file') } }), null, 'nothing to read, and it must not throw')
})

test('the default version lookup is relative to the app, not to this package', () => {
  // From inside node_modules/@peerloom/host, `..` is this package's own manifest.
  // Reading that would report the library's version as the app's.
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-ver-'))
  fs.mkdirSync(path.join(root, 'app', 'main'), { recursive: true })
  fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ version: '7.8.9' }))
  assert.equal(appVersion({ config: PEARSHEET, env: {}, baseDir: path.join(root, 'app', 'main') }), '7.8.9')
  fs.rmSync(root, { recursive: true, force: true })
})

test('every refusal to check returns null and a reason, and starts nothing', () => {
  const cases = [
    [{ config, env: { PEARTUNE_NO_UPDATE_CHECK: '1' } }, 'PEARTUNE_NO_UPDATE_CHECK'],
    [{ config, env: {}, versionOf: () => null }, 'unknown version']
  ]
  for (const [opts, reason] of cases) {
    const r = createUpdateChecker(opts)
    assert.equal(r.checker, null, reason)
    assert.equal(r.reason, reason)
  }
})

test('a rate-limited or 404 response is an error, not an update', async () => {
  const c = new UpdateChecker({ config, currentVersion: '1.0.0', url: 'x', fetchImpl: async () => ({ ok: false, status: 403 }) })
  await c.check()
  assert.match(c.get().error, /403/)
  assert.equal(c.get().available, false)
})

test('a missing config is a programming error, thrown at once', () => {
  assert.throws(() => new UpdateChecker({ currentVersion: '1.0.0' }), TypeError)
  assert.throws(() => createUpdateChecker({ env: {} }), TypeError)
  assert.throws(() => evaluateRelease({ tag_name: 'v1.0.0' }, '1.0.0'), TypeError)
})

// --- PearSheet ------------------------------------------------------------------

test('PearSheet reads its own env prefix and ignores another app\'s', () => {
  assert.deepEqual(updatesDisabled({ config: PEARSHEET, env: { PEARSHEET_NO_UPDATE_CHECK: '1' }, fs: noFs }), { disabled: true, reason: 'PEARSHEET_NO_UPDATE_CHECK' })
  assert.deepEqual(updatesDisabled({ config: PEARSHEET, env: { PEARTUNE_NO_UPDATE_CHECK: '1' }, fs: noFs }), { disabled: false, reason: null })
  assert.equal(appVersion({ config: PEARSHEET, env: { PEARSHEET_VERSION: '0.2.0', PEARTUNE_VERSION: '9.9.9' } }), '0.2.0')
  assert.equal(appVersion({ config: PEARSHEET, env: { PEARTUNE_VERSION: '9.9.9' }, load: () => { throw new Error('none') } }), null)
  const r = createUpdateChecker({ config: PEARSHEET, env: { PEARSHEET_NO_UPDATE_CHECK: '1' } })
  assert.equal(r.checker, null)
  assert.equal(r.reason, 'PEARSHEET_NO_UPDATE_CHECK')
})

test('PearSheet asks its own releases repo, or the URL its env var names', async () => {
  const seen = []
  const fetchImpl = async (url, opts) => { seen.push([url, opts.headers['user-agent']]); return { ok: true, json: async () => ({ tag_name: 'v0.2.0' }) } }
  await new UpdateChecker({ config: PEARSHEET, currentVersion: '0.1.0', env: {}, fetchImpl }).check()
  await new UpdateChecker({ config: PEARSHEET, currentVersion: '0.1.0', env: { PEARSHEET_UPDATE_LATEST_URL: 'http://127.0.0.1:1/latest' }, fetchImpl }).check()
  await new UpdateChecker({ config: PEARSHEET, currentVersion: '0.1.0', env: { PEARTUNE_UPDATE_LATEST_URL: 'http://wrong/' }, fetchImpl }).check()
  assert.deepEqual(seen, [
    ['https://api.github.com/repos/peerloomllc/pearsheet-releases/releases/latest', 'pearsheet/0.1.0'],
    ['http://127.0.0.1:1/latest', 'pearsheet/0.1.0'],
    ['https://api.github.com/repos/peerloomllc/pearsheet-releases/releases/latest', 'pearsheet/0.1.0']
  ])
})

test('PearSheet releases are judged against PearSheet asset names', () => {
  const release = (v) => ({
    tag_name: 'v0.2.0',
    assets: [
      `PearSheet-Setup-${v}.exe`, `PearSheet-${v}-mac-arm64.dmg`, `PearSheet-${v}-mac-x64.dmg`,
      `pearsheet-${v}-linux-x86_64.AppImage`, `pearsheet-${v}-linux-amd64.deb`,
      // Always the new version, so a stale desktop build cannot hide behind them.
      'PearSheet-0.2.0-mac-arm64.zip', 'pearsheet-seeder-0.2.0-linux-x64.tar.gz'
    ].map(name => ({ name }))
  })
  const platforms = [{ platform: 'win32' }, { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }, { platform: 'linux', appImage: '/x.AppImage' }, { platform: 'linux', appImage: '' }]
  for (const opts of platforms) {
    assert.equal(evaluateRelease(release('0.2.0'), '0.1.0', { config: PEARSHEET, ...opts }).available, true, JSON.stringify(opts))
    assert.equal(evaluateRelease(release('0.1.0'), '0.1.0', { config: PEARSHEET, ...opts }).reason, 'no-build-for-platform', JSON.stringify(opts))
  }
})

test('firstDelayMs holds the first check back, and 0 checks at once', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ tag_name: 'v0.1.0' }) } }
  const now = new UpdateChecker({ config: PEARSHEET, currentVersion: '0.1.0', env: {}, fetchImpl }).start()
  assert.equal(calls, 1, 'no delay means the first check starts during start()')
  now.stop()

  calls = 0
  const later = new UpdateChecker({ config: PEARSHEET, currentVersion: '0.1.0', env: {}, fetchImpl, firstDelayMs: 30 }).start()
  assert.equal(calls, 0, 'nothing may be fetched before the delay')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(calls, 1)
  later.stop()

  calls = 0
  const stopped = new UpdateChecker({ config: PEARSHEET, currentVersion: '0.1.0', env: {}, fetchImpl, firstDelayMs: 30 }).start()
  stopped.stop()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(calls, 0, 'stop() before the delay cancels the first check')
})
