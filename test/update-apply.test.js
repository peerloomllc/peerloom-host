'use strict'

// "Update now". Most of these are about picking wrong and about refusing, because
// the module decides whether we are about to execute the right file.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const {
  selectAsset, versionInName, planApply, downloadAndVerify, sha256File, parseSha256Sidecar,
  parseCodesignTeam, macAppRoot, detectSupervisor, applyUpdate, UpdateApplier, defaultExec,
  VerifyError, NeedsManualError, APPLIERS
} = require('../src/update-apply')
const { PEAROFFICE, PEARTUNE } = require('./update-configs')

const config = PEARTUNE

// A release shaped like PearTune's: every desktop artifact, both phone builds and a
// .sha256 beside each.
const NAMES = [
  'PearTune-1.1.0.AppImage',
  'peartune-desktop_1.1.0_amd64.deb',
  'PearTune-Setup-1.1.0.exe',
  'PearTune-1.1.0.dmg',
  'PearTune-1.1.0-arm64.dmg',
  'peartune-v1.1.0.apk',
  'peartune-v1.1.0.aab'
]
const withSidecars = (names, host = 'https://example.test') => names.flatMap(name => ([
  { name, browser_download_url: `${host}/${name}` },
  { name: name + '.sha256', browser_download_url: `${host}/${name}.sha256` }
]))
const ASSETS = withSidecars(NAMES)

const UPDATE = { available: true, latest: '1.1.0', current: '1.0.0' }

test('each platform gets its own artifact, and never a phone build', () => {
  assert.equal(selectAsset(ASSETS, { config, platform: 'win32' }).name, 'PearTune-Setup-1.1.0.exe')
  assert.equal(selectAsset(ASSETS, { config, platform: 'linux', appImage: '/home/x/PearTune.AppImage' }).name, 'PearTune-1.1.0.AppImage')
  assert.equal(selectAsset(ASSETS, { config, platform: 'linux', appImage: '' }).name, 'peartune-desktop_1.1.0_amd64.deb')
  for (const p of ['win32', 'linux', 'darwin']) {
    const picked = selectAsset(ASSETS, { config, platform: p, arch: 'x64', appImage: '' })
    assert.ok(!/\.(apk|aab)$/.test(picked.name), `${p} must never be handed a phone build`)
  }
})

test('an Intel Mac does not get the arm64 build (darwinX64 as a function)', () => {
  // /\.dmg$/ matches "PearTune-1.1.0-arm64.dmg" too, so a naive find can hand an
  // Apple Silicon build to an Intel Mac, which fails at launch.
  assert.equal(typeof config.assets.darwinX64, 'function')
  assert.equal(selectAsset(ASSETS, { config, platform: 'darwin', arch: 'x64' }).name, 'PearTune-1.1.0.dmg')
  assert.equal(selectAsset(ASSETS, { config, platform: 'darwin', arch: 'arm64' }).name, 'PearTune-1.1.0-arm64.dmg')
})

test('Linux picks by what is running, never by a guess', () => {
  assert.match(selectAsset(ASSETS, { config, platform: 'linux', appImage: '/opt/PearTune.AppImage' }).name, /\.AppImage$/)
  assert.match(selectAsset(ASSETS, { config, platform: 'linux', appImage: undefined }).name, /\.deb$/)
})

test('no sidecar means no apply', () => {
  const noSidecar = ASSETS.filter(a => !a.name.endsWith('.sha256'))
  assert.throws(() => planApply(UPDATE, noSidecar, { config, platform: 'win32' }),
    (e) => e instanceof VerifyError && /sha256 sidecar/.test(e.message))
})

test('planning refuses rather than half answering', () => {
  assert.throws(() => planApply({ available: false }, ASSETS, { config }), /no update available/)
  assert.throws(() => planApply(UPDATE, [], { config, platform: 'win32' }), /no asset for this platform/)
  assert.throws(() => planApply(UPDATE, ASSETS, { config, platform: 'sunos' }), /no asset for this platform/)
  assert.throws(() => planApply(UPDATE, ASSETS, { platform: 'win32' }), TypeError, 'a missing config is a programming error')
})

test('the plan names the applier the artifact implies', () => {
  assert.equal(planApply(UPDATE, ASSETS, { config, platform: 'win32' }).applier, 'windows')
  assert.equal(planApply(UPDATE, ASSETS, { config, platform: 'darwin', arch: 'arm64' }).applier, 'macapp')
  assert.equal(planApply(UPDATE, ASSETS, { config, platform: 'linux', appImage: '/x.AppImage' }).applier, 'appimage')
  assert.equal(planApply(UPDATE, ASSETS, { config, platform: 'linux', appImage: '' }).applier, 'deb')
})

test('sidecar parsing takes the digest out of a real shasum line', () => {
  const d = 'a'.repeat(64)
  assert.equal(parseSha256Sidecar(`${d}  PearTune-1.1.0.AppImage\n`), d)
  assert.equal(parseSha256Sidecar('not a digest'), null)
  assert.equal(parseSha256Sidecar(null), null)
})

// --- download and verify, against a stubbed fetch -------------------------------

function stubFetch (bodyByUrl, seen = []) {
  return async (url, opts) => {
    seen.push({ url, ua: opts && opts.headers && opts.headers['user-agent'] })
    const v = bodyByUrl[url]
    if (v === undefined) return { ok: false, status: 404 }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(v),
      text: async () => String(v)
    }
  }
}

test('a good download verifies and is kept', async () => {
  const body = 'pretend installer bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const plan = { name: 'PearTune-Setup-1.1.0.exe', url: 'u://a', sha256Url: 'u://a.sha256' }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dl-'))
  const r = await downloadAndVerify(plan, {
    config,
    workDir,
    fetchImpl: stubFetch({ 'u://a': body, 'u://a.sha256': `${digest}  ${plan.name}\n` })
  })
  assert.equal(r.digest, digest)
  assert.ok(fs.existsSync(r.file))
  assert.equal(await sha256File(r.file), digest)
  fs.rmSync(workDir, { recursive: true, force: true })
})

test('a tampered download is rejected and deleted', async () => {
  // Reporting the problem is not enough: nothing may be left on disk for something
  // later to run.
  const plan = { name: 'PearTune-Setup-1.1.0.exe', url: 'u://a', sha256Url: 'u://a.sha256' }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dl-'))
  const wrong = crypto.createHash('sha256').update('what we EXPECTED').digest('hex')
  await assert.rejects(
    () => downloadAndVerify(plan, {
      config,
      workDir,
      fetchImpl: stubFetch({ 'u://a': 'TAMPERED BYTES', 'u://a.sha256': `${wrong}  ${plan.name}\n` })
    }),
    (e) => e.code === 'VERIFY_FAILED' && /mismatch/.test(e.message))
  assert.ok(!fs.existsSync(path.join(workDir, plan.name)), 'a rejected artifact must not be left on disk')
  fs.rmSync(workDir, { recursive: true, force: true })
})

test('a missing or unreadable sidecar refuses, it does not skip verification', async () => {
  const plan = { name: 'x.exe', url: 'u://a', sha256Url: 'u://missing' }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dl-'))
  await assert.rejects(
    () => downloadAndVerify(plan, { config, workDir, fetchImpl: stubFetch({ 'u://a': 'bytes' }) }),
    (e) => e.code === 'VERIFY_FAILED' && /sidecar http 404/.test(e.message))

  await assert.rejects(
    () => downloadAndVerify(plan, {
      config,
      workDir,
      fetchImpl: stubFetch({ 'u://a': 'bytes', 'u://missing': 'this is not a digest' })
    }),
    (e) => e.code === 'VERIFY_FAILED' && /unparseable/.test(e.message))
  fs.rmSync(workDir, { recursive: true, force: true })
})

test('downloads name the app, and the temp folder is named after it', async () => {
  const body = 'bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const plan = { name: 'PearOffice-Setup-0.2.0.exe', url: 'u://a', sha256Url: 'u://a.sha256' }
  const seen = []
  const r = await downloadAndVerify(plan, { config: PEAROFFICE, fetchImpl: stubFetch({ 'u://a': body, 'u://a.sha256': digest }, seen) })
  assert.match(path.basename(r.dir), /^pearoffice-update-/)
  assert.deepEqual(seen.map(s => s.ua), ['pearoffice', 'pearoffice'])
  fs.rmSync(r.dir, { recursive: true, force: true })
})

// --- appliers ---------------------------------------------------------------------

// Records every command instead of running it, so the sequence can be asserted.
function recorder (answers = {}) {
  const calls = []
  const exec = async (argv) => {
    calls.push(argv.join(' '))
    for (const [match, out] of Object.entries(answers)) {
      if (argv.join(' ').includes(match)) return out
    }
    return ''
  }
  return { calls, exec }
}

test('a supervisor is detected, never assumed: the same AppImage runs both ways', async () => {
  const active = recorder({ 'systemctl --user is-active': 'active\n' })
  assert.equal(await detectSupervisor({ config, platform: 'linux', exec: active.exec }), 'systemd')
  assert.deepEqual(active.calls, ['systemctl --user is-active peartune-host.service'])

  const inactive = recorder({ 'systemctl --user is-active': 'inactive\n' })
  assert.equal(await detectSupervisor({ config, platform: 'linux', exec: inactive.exec }), null)

  const win = recorder({ 'sc.exe query': 'STATE : 4  RUNNING' })
  assert.equal(await detectSupervisor({ config, platform: 'win32', exec: win.exec }), 'windows-service')
  assert.deepEqual(win.calls, ['sc.exe query PearTuneHost'])

  // A throwing exec means "no service", never a crash.
  const boom = { exec: async () => { throw new Error('no systemctl') } }
  assert.equal(await detectSupervisor({ config, platform: 'linux', exec: boom.exec }), null)
})

// A LaunchDaemon with KeepAlive restarts the old code from the old bundle unless it is
// found and ended after the swap. (PearTune, 2026-08-18.)
test('macOS detects the LaunchDaemon, so an update does not leave the old one running', async () => {
  const r = recorder()
  let asked = null
  const yes = { existsSync: (p) => { asked = p; return true } }
  assert.equal(await detectSupervisor({ config, platform: 'darwin', exec: r.exec, fsImpl: yes }), 'launchd')
  assert.equal(asked, '/Library/LaunchDaemons/com.peerloom.peartune.plist')
  assert.equal(await detectSupervisor({ config, platform: 'darwin', exec: r.exec, fsImpl: { existsSync: () => false } }), null,
    'a plain tray install has no daemon and must still relaunch itself')
})

test('with no service configured, detectSupervisor answers null and runs nothing', async () => {
  const r = recorder({ 'systemctl --user is-active': 'active\n', 'sc.exe query': 'RUNNING' })
  const fsImpl = { existsSync: () => { throw new Error('must not be asked') } }
  for (const platform of ['linux', 'win32', 'darwin']) {
    assert.equal(await detectSupervisor({ config: PEAROFFICE, platform, exec: r.exec, fsImpl }), null, platform)
  }
  assert.deepEqual(r.calls, [], 'no command may run for a service the app does not have')
})

const TEAM_OK = 'TeamIdentifier=G79ALD29NA'

test('the .dmg swap ends the old daemon, so KeepAlive starts a fresh one from the new bundle', async () => {
  const r = recorder({ 'codesign -dv': TEAM_OK })
  const out = await applyUpdate({ applier: 'macapp', version: '1.1.0' }, {
    config,
    file: '/tmp/PearTune-1.1.0-arm64.dmg',
    target: '/Applications/PearTune.app',
    supervisor: 'launchd',
    mountDir: '/tmp/mnt',
    exec: r.exec
  })

  const swap = r.calls.findIndex((c) => c.startsWith('mv /Applications/PearTune.app.new'))
  const kill = r.calls.findIndex((c) => c.startsWith('pkill -f'))
  assert.ok(swap !== -1, 'the app should have been swapped into place')
  assert.ok(kill !== -1, 'nothing ended the running daemon, so it keeps serving the old bundle')
  assert.ok(swap < kill, 'the daemon must be ended after the swap, or KeepAlive restarts the old bundle')
  assert.equal(r.calls[kill], 'pkill -f PearTune.app/Contents/Resources/app.asar/vendor/host',
    'match the daemon by its host argv, which the tray does not have')
  assert.equal(out.restarted, true)
  assert.equal(out.via, 'launchd')
})

test('a daemon that refuses to die is reported, not papered over', async () => {
  const calls = []
  const exec = async (argv) => {
    calls.push(argv.join(' '))
    if (argv[0] === 'pkill') throw new Error('Operation not permitted')
    if (argv.join(' ').includes('codesign -dv')) return TEAM_OK
    return ''
  }
  const out = await applyUpdate({ applier: 'macapp', version: '1.1.0' }, {
    config, file: '/tmp/x.dmg', target: '/Applications/PearTune.app', supervisor: 'launchd', mountDir: '/tmp/mnt', exec
  })
  assert.equal(out.restarted, false, 'must not claim a restart that did not happen')
  assert.equal(out.staleDaemon, true, 'and must say why, so the UI can tell the person')
})

test('with no daemon installed, the .dmg swap still just relaunches the tray', async () => {
  const r = recorder({ 'codesign -dv': TEAM_OK })
  const out = await applyUpdate({ applier: 'macapp', version: '1.1.0' }, {
    config, file: '/tmp/x.dmg', target: '/Applications/PearTune.app', supervisor: null, mountDir: '/tmp/mnt', exec: r.exec
  })
  assert.ok(!r.calls.some((c) => c.startsWith('pkill')), 'nothing to kill on a plain tray install')
  assert.equal(out.needsRelaunch, true)
})

test('an app with no daemon configured never kills anything, even if told launchd', async () => {
  const r = recorder({ 'codesign -dv': TEAM_OK })
  const out = await applyUpdate({ applier: 'macapp', version: '0.2.0' }, {
    config: PEAROFFICE, file: '/tmp/x.dmg', target: '/Applications/PearOffice.app', supervisor: 'launchd', mountDir: '/tmp/mnt', exec: r.exec
  })
  assert.ok(!r.calls.some((c) => c.startsWith('pkill')))
  assert.ok(r.calls.includes('codesign --verify --deep --strict /tmp/mnt/PearOffice.app'), 'the bundle name comes from the config')
  assert.deepEqual(out, { restarted: false, needsRelaunch: true, via: 'dmg-swap', applier: 'macapp', version: '0.2.0' })
})

test('the AppImage swap keeps the executable bit, then hands off to systemd', async () => {
  const r = recorder()
  const out = await applyUpdate({ applier: 'appimage', version: '1.1.0' },
    { config, file: '/tmp/new.AppImage', target: '/home/tim/PearTune.AppImage', supervisor: 'systemd', exec: r.exec })

  assert.match(r.calls[0], /^install -m 0755 \/tmp\/new\.AppImage \/home\/tim\/PearTune\.AppImage$/,
    'a plain copy would drop the executable bit')
  // Without --no-block the restart kills our own systemctl child and reports an
  // error on a successful update.
  assert.equal(r.calls[1], 'systemctl --user restart --no-block peartune-host.service')
  assert.equal(out.restarted, true)
  assert.equal(out.via, 'systemd')
})

test('unsupervised, the swap happens but the relaunch is left to the app', async () => {
  const r = recorder()
  const out = await applyUpdate({ applier: 'appimage', version: '1.1.0' },
    { config, file: '/tmp/new.AppImage', target: '/home/tim/PearTune.AppImage', supervisor: null, exec: r.exec })
  assert.equal(r.calls.length, 1, 'no restart command when nothing is supervising')
  assert.equal(out.needsRelaunch, true)
  assert.equal(out.restarted, false)
})

test('no AppImage path means refuse, never swap something else', async () => {
  await assert.rejects(
    () => applyUpdate({ applier: 'appimage', version: '1.1.0' }, { config, file: '/tmp/new', target: '', exec: async () => '' }),
    (e) => e.code === 'NEEDS_MANUAL')
})

test('the Windows installer is launched detached through WMI', async () => {
  // NSSM kills its service's whole process tree on stop, and the installer stops the
  // service. A child would die part way through replacing files.
  const r = recorder()
  const out = await applyUpdate({ applier: 'windows', version: '1.1.0' },
    { config, file: 'C:\\tmp\\PearTune-Setup-1.1.0.exe', exec: r.exec })
  assert.match(r.calls[0], /Win32_Process/, 'a plain spawn would be killed when the installer stops the service')
  assert.match(r.calls[0], /CommandLine='"C:\\tmp\\PearTune-Setup-1\.1\.0\.exe" \/S'/, 'silent, or the update waits on a wizard')
  assert.equal(out.restarted, true)
  assert.equal(out.needsQuit, undefined)
})

test('the unwired paths throw instead of reporting a success they did not have', async () => {
  await assert.rejects(
    () => applyUpdate({ applier: 'deb', version: '1.1.0' }, { config, file: '/tmp/x', exec: async () => '', fsImpl: { existsSync: () => false } }),
    (e) => e.code === 'NEEDS_MANUAL', 'deb without its helper must refuse')
  await assert.rejects(
    () => applyUpdate({ applier: 'macapp', version: '1.1.0' }, { config, file: '/tmp/x', exec: async () => '' }),
    (e) => e.code === 'NEEDS_MANUAL', 'macapp without a target must refuse')
  await assert.rejects(
    () => applyUpdate({ applier: 'flatpak', version: '1.1.0' }, { config, file: '/tmp/x', exec: async () => '' }),
    (e) => e.code === 'NEEDS_MANUAL', 'an unknown applier must refuse')
  assert.deepEqual(Object.keys(APPLIERS).sort(), ['appimage', 'deb', 'macapp', 'windows'])
})

// --- the UpdateApplier driver --------------------------------------------------------

const RELEASE = { available: true, latest: '1.1.0', current: '1.0.0', htmlUrl: 'https://gh/releases/v1.1.0', assets: ASSETS }

function urlsFor (assets, body, digest) {
  const urls = {}
  for (const a of assets) urls[a.browser_download_url] = a.name.endsWith('.sha256') ? `${digest}  x\n` : body
  return urls
}

function applierFor (over = {}, { release = RELEASE, answers = { 'systemctl --user is-active': 'active\n' } } = {}) {
  const body = 'installer bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const r = recorder(answers)
  return {
    calls: r.calls,
    applier: new UpdateApplier({
      config,
      getUpdate: () => release,
      platform: 'linux',
      target: '/home/tim/PearTune.AppImage',
      exec: r.exec,
      fetchImpl: stubFetch(urlsFor(release.assets, body, digest)),
      ...over
    })
  }
}

test('a full apply verifies, swaps and reports restarting', async () => {
  const { applier, calls } = applierFor()
  assert.equal(applier.getState().status, 'idle')
  const s = await applier.apply()
  assert.equal(s.status, 'restarting')
  assert.equal(s.version, '1.1.0')
  assert.equal(s.via, 'systemd')
  assert.ok(calls.some(c => c.startsWith('install -m 0755')))
})

test('nothing happening must never look like it worked', async () => {
  // An unpackaged run has no .app to swap. It must land on needs-manual with the
  // release page, the same thing the banner offered before "Update now" existed.
  const { applier } = applierFor({ platform: 'darwin', arch: 'arm64', execPath: '/usr/local/bin/node', fsImpl: { existsSync: () => false } })
  const s = await applier.apply()
  assert.equal(s.status, 'needs-manual')
  assert.equal(s.htmlUrl, RELEASE.htmlUrl, 'the person is always offered the download')
})

test('a tampered download reports error, distinctly from needs-manual', async () => {
  const urls = {}
  for (const a of ASSETS) urls[a.browser_download_url] = a.name.endsWith('.sha256') ? `${'b'.repeat(64)}  x\n` : 'TAMPERED'
  const r = recorder({ 'systemctl --user is-active': 'active\n' })
  const applier = new UpdateApplier({
    config, getUpdate: () => RELEASE, platform: 'linux', target: '/home/tim/PearTune.AppImage', exec: r.exec, fetchImpl: stubFetch(urls)
  })
  const s = await applier.apply()
  assert.equal(s.status, 'error')
  assert.match(s.error, /mismatch/)
  assert.ok(!r.calls.some(c => c.startsWith('install ')), 'nothing may be installed after a failed verify')
})

test('with no update there is nothing to apply', async () => {
  const applier = new UpdateApplier({ config, getUpdate: () => ({ available: false }) })
  assert.equal((await applier.apply()).status, 'no-update')
})

test('a second click does not start a second download', async () => {
  const { applier } = applierFor()
  applier._state = { status: 'running', version: '1.1.0' }
  assert.equal((await applier.apply()).status, 'running')
})

test('a stale daemon warning names the daemon from the config', async () => {
  const exec = async (argv) => {
    if (argv[0] === 'pkill') throw new Error('Operation not permitted')
    if (argv.join(' ').includes('codesign -dv')) return TEAM_OK
    return ''
  }
  let relaunched = 0
  const body = 'installer bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const applier = new UpdateApplier({
    config,
    getUpdate: () => RELEASE,
    platform: 'darwin',
    arch: 'arm64',
    execPath: '/Applications/PearTune.app/Contents/MacOS/PearTune',
    exec,
    fsImpl: { existsSync: () => true },
    fetchImpl: stubFetch(urlsFor(ASSETS, body, digest)),
    onRelaunch: () => { relaunched++ }
  })
  const s = await applier.apply()
  assert.equal(s.staleDaemon, true)
  assert.match(s.warning, /sudo launchctl kickstart -k system\/com\.peerloom\.peartune$/)
  assert.equal(relaunched, 1)
})

// --- macOS signing ------------------------------------------------------------------

const SIGNED = `Executable=/Volumes/x/PearTune.app/Contents/MacOS/PearTune
Identifier=com.peartune.desktop
TeamIdentifier=G79ALD29NA
Sealed Resources version=2`

test('the signing team is read, and "not set" is not a match', () => {
  assert.equal(parseCodesignTeam(SIGNED), 'G79ALD29NA')
  assert.equal(parseCodesignTeam('TeamIdentifier=not set'), null)
  assert.equal(parseCodesignTeam(''), null)
  assert.equal(parseCodesignTeam(null), null)
})

test('the .app root is derived, never guessed', () => {
  // We mv and rm -rf around this path, so a shape that does not match is null.
  assert.equal(macAppRoot('/Applications/PearTune.app/Contents/MacOS/PearTune'), '/Applications/PearTune.app')
  assert.equal(macAppRoot('/Users/tim/Desktop/PearOffice.app/Contents/MacOS/PearOffice'), '/Users/tim/Desktop/PearOffice.app')
  assert.equal(macAppRoot('/usr/local/bin/node'), null, 'an unpackaged dev run must not resolve to a path we would delete')
  assert.equal(macAppRoot(''), null)
})

test('macOS mounts, verifies the signer, swaps and always unmounts', async () => {
  const r = recorder({ 'codesign -dv': SIGNED })
  const out = await applyUpdate({ applier: 'macapp', version: '1.1.0' },
    { config, file: '/tmp/PearTune-1.1.0.dmg', target: '/Applications/PearTune.app', exec: r.exec, mountDir: '/tmp/mnt' })

  const seq = r.calls.join('\n')
  assert.match(seq, /hdiutil attach -nobrowse -readonly/)
  // A bundle whose nested code was swapped still passes a shallow check.
  assert.match(seq, /codesign --verify --deep --strict/)
  assert.match(seq, /codesign -dv --verbose=4/)
  // Staged beside the target and swapped, never deleted first.
  const ditto = r.calls.findIndex(c => c.startsWith('ditto'))
  const mv = r.calls.findIndex(c => c.startsWith('mv /Applications/PearTune.app '))
  assert.ok(ditto >= 0 && mv > ditto, 'the new bundle must be staged before the old one moves')
  assert.match(r.calls[r.calls.length - 1], /hdiutil detach/)
  assert.equal(out.needsRelaunch, true)
})

test('a bundle signed by someone else is refused, and still unmounted', async () => {
  // A real Team ID is exactly 10 characters. A wrong 10-character one and "not set"
  // must both be refused.
  const r = recorder({ 'codesign -dv': 'TeamIdentifier=EVILTEAM99' })
  await assert.rejects(
    () => applyUpdate({ applier: 'macapp', version: '1.1.0' },
      { config, file: '/tmp/x.dmg', target: '/Applications/PearTune.app', exec: r.exec, mountDir: '/tmp/mnt' }),
    (e) => e.code === 'VERIFY_FAILED' && /EVILTEAM99/.test(e.message))

  const unsigned = recorder({ 'codesign -dv': 'TeamIdentifier=not set' })
  await assert.rejects(
    () => applyUpdate({ applier: 'macapp', version: '1.1.0' },
      { config, file: '/tmp/x.dmg', target: '/Applications/PearTune.app', exec: unsigned.exec, mountDir: '/tmp/mnt' }),
    (e) => e.code === 'VERIFY_FAILED' && /nobody/.test(e.message))
  assert.ok(!r.calls.some(c => c.startsWith('ditto')), 'nothing may be copied over the installed app')
  assert.match(r.calls[r.calls.length - 1], /hdiutil detach/, 'a rejected image must still be unmounted')
})

test('macOS refuses when it cannot work out where the app lives', async () => {
  await assert.rejects(
    () => applyUpdate({ applier: 'macapp', version: '1.1.0' }, { config, file: '/tmp/x.dmg', target: null, exec: async () => '' }),
    (e) => e.code === 'NEEDS_MANUAL')
})

// --- the .deb, which needs root ---------------------------------------------------

test('with a helper configured, the .deb applier hands the digest to it', async () => {
  // pkexec authorises running the helper and says nothing about its arguments, so
  // root re-checks the digest.
  const r = recorder()
  let asked = null
  const out = await applyUpdate({ applier: 'deb', version: '1.1.0' }, {
    config,
    file: '/tmp/peartune-desktop_1.1.0_amd64.deb',
    digest: 'c'.repeat(64),
    user: 'tim',
    exec: r.exec,
    fsImpl: { existsSync: (p) => { asked = p; return true } }
  })
  assert.equal(asked, '/opt/PearTune/updater-helper.sh')
  assert.equal(r.calls[0], `pkexec /opt/PearTune/updater-helper.sh /tmp/peartune-desktop_1.1.0_amd64.deb ${'c'.repeat(64)} tim `)
  assert.equal(out.restarted, true)
  assert.equal(out.via, 'pkexec')
})

test('a configured helper that is missing is an older build: needs-manual', async () => {
  await assert.rejects(
    () => applyUpdate({ applier: 'deb', version: '1.1.0' }, {
      config, file: '/tmp/x.deb', digest: 'd'.repeat(64), exec: async () => '', fsImpl: { existsSync: () => false }
    }),
    (e) => e instanceof NeedsManualError)
})

// --- names from real releases ---------------------------------------------------------
//
// Copied off PearTune's real v1.0.0 release (2026-08-11), so this suite notices if a
// rename ever leaves the picker matching nothing. That failure is silent: the person
// just sees an update that will not install.
const REAL_ASSETS = withSidecars([
  'PearTune-1.0.0-arm64.dmg',
  'PearTune-1.0.0.AppImage',
  'PearTune-1.0.0.dmg',
  'peartune-desktop_1.0.0_amd64.deb',
  'PearTune-Setup-1.0.0.exe',
  'peartune-v1.0.0.apk'
], 'https://github.test')

test('the picker handles the real PearTune release names', () => {
  const update = { available: true, latest: '1.0.0', current: '0.9.9' }
  const cases = [
    [{ platform: 'linux', arch: 'x64', appImage: '' }, 'deb', 'peartune-desktop_1.0.0_amd64.deb'],
    [{ platform: 'linux', arch: 'x64', appImage: '/opt/PearTune.AppImage' }, 'appimage', 'PearTune-1.0.0.AppImage'],
    [{ platform: 'win32', arch: 'x64' }, 'windows', 'PearTune-Setup-1.0.0.exe'],
    [{ platform: 'darwin', arch: 'arm64' }, 'macapp', 'PearTune-1.0.0-arm64.dmg'],
    [{ platform: 'darwin', arch: 'x64' }, 'macapp', 'PearTune-1.0.0.dmg']
  ]
  for (const [opts, applier, name] of cases) {
    const plan = planApply(update, REAL_ASSETS, { config, ...opts })
    assert.equal(plan.name, name, `${opts.platform}/${opts.arch}`)
    assert.equal(plan.applier, applier)
    assert.ok(plan.sha256Url)
  }
})

test('a release that carries stale desktop artifacts is refused, not silently reinstalled', () => {
  // PearTune v1.0.1 (2026-08-17): the tag moved, the desktop files stayed 1.0.0.
  const update = { available: true, latest: '1.0.1', current: '1.0.0' }
  const stale = REAL_ASSETS.filter(a => !/\.(apk|aab)(\.sha256)?$/i.test(a.name))
  const cases = [
    { platform: 'linux', arch: 'x64', appImage: '' },
    { platform: 'linux', arch: 'x64', appImage: '/opt/PearTune.AppImage' },
    { platform: 'win32', arch: 'x64' },
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' }
  ]
  for (const opts of cases) {
    assert.throws(
      () => planApply(update, stale, { config, ...opts }),
      (e) => e.code === 'NEEDS_MANUAL' && /still 1\.0\.0/.test(e.message),
      `${opts.platform}/${opts.arch} must refuse a 1.0.0 artifact offered as 1.0.1`
    )
  }
})

test('a release whose artifacts do carry the new version still applies', () => {
  const update = { available: true, latest: '1.0.1', current: '1.0.0' }
  const plan = planApply(update, withSidecars(['PearTune-1.0.1.AppImage'], 'https://x'), { config, platform: 'linux', arch: 'x64', appImage: '/opt/PearTune.AppImage' })
  assert.equal(plan.name, 'PearTune-1.0.1.AppImage')
  assert.equal(plan.version, '1.0.1')
  assert.equal(plan.applier, 'appimage')
})

test('an artifact with no version in its name is allowed through', () => {
  // An unreadable name is not evidence of staleness.
  const update = { available: true, latest: '1.0.1', current: '1.0.0' }
  const plan = planApply(update, withSidecars(['PearTune.AppImage'], 'https://x'), { config, platform: 'linux', arch: 'x64', appImage: '/opt/PearTune.AppImage' })
  assert.equal(plan.name, 'PearTune.AppImage')
})

test('no real desktop artifact is ever a phone build', () => {
  const update = { available: true, latest: '1.0.0', current: '0.9.9' }
  for (const p of ['win32', 'linux', 'darwin']) {
    const plan = planApply(update, REAL_ASSETS, { config, platform: p, arch: 'x64', appImage: '' })
    assert.ok(!/\.(apk|aab)$/i.test(plan.name), `${p} was handed ${plan.name}`)
  }
})

// --- PearOffice ------------------------------------------------------------------------

const SHEET_ASSETS = withSidecars([
  'PearOffice-Setup-0.2.0.exe',
  'PearOffice-0.2.0-mac-arm64.dmg',
  'PearOffice-0.2.0-mac-x64.dmg',
  'pearoffice-0.2.0-linux-x86_64.AppImage',
  'pearoffice-0.2.0-linux-amd64.deb',
  // Real assets on a PearOffice release that no desktop update may ever pick.
  'PearOffice-0.2.0-mac-arm64.zip',
  'pearoffice-seeder-0.2.0-linux-x64.tar.gz'
], 'https://github.test')
const SHEET_UPDATE = { available: true, latest: '0.2.0', current: '0.1.0', htmlUrl: 'https://gh/pearoffice/v0.2.0', assets: SHEET_ASSETS }

test('PearOffice: each platform picks its own artifact, never the zip or the seeder', () => {
  const cases = [
    [{ platform: 'win32', arch: 'x64' }, 'windows', 'PearOffice-Setup-0.2.0.exe'],
    [{ platform: 'darwin', arch: 'arm64' }, 'macapp', 'PearOffice-0.2.0-mac-arm64.dmg'],
    [{ platform: 'darwin', arch: 'x64' }, 'macapp', 'PearOffice-0.2.0-mac-x64.dmg'],
    [{ platform: 'linux', arch: 'x64', appImage: '/home/tim/pearoffice.AppImage' }, 'appimage', 'pearoffice-0.2.0-linux-x86_64.AppImage'],
    [{ platform: 'linux', arch: 'x64', appImage: '' }, 'deb', 'pearoffice-0.2.0-linux-amd64.deb']
  ]
  for (const [opts, applier, name] of cases) {
    const plan = planApply(SHEET_UPDATE, SHEET_ASSETS, { config: PEAROFFICE, ...opts })
    assert.equal(plan.name, name, `${opts.platform}/${opts.arch}`)
    assert.equal(plan.applier, applier)
    assert.equal(plan.sha256Url, `https://github.test/${name}.sha256`)
    assert.equal(plan.version, '0.2.0')
  }
  assert.equal(versionInName('pearoffice-0.2.0-linux-x86_64.AppImage'), '0.2.0', 'x86_64 is not a version')
})

test('PearOffice: with only the zip and the seeder left, nothing is picked', () => {
  const leftovers = SHEET_ASSETS.filter(a => /\.(zip|tar\.gz)(\.sha256)?$/.test(a.name))
  for (const opts of [{ platform: 'win32' }, { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }, { platform: 'linux', appImage: '/x.AppImage' }, { platform: 'linux', appImage: '' }]) {
    assert.equal(selectAsset(leftovers, { config: PEAROFFICE, ...opts }), null, JSON.stringify(opts))
  }
})

test('PearOffice: a PearTune release is never picked up by PearOffice', () => {
  for (const opts of [{ platform: 'win32' }, { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }]) {
    assert.equal(selectAsset(REAL_ASSETS, { config: PEAROFFICE, ...opts }), null, JSON.stringify(opts))
  }
})

test('PearOffice: with no helper, the .deb goes through pkexec dpkg -i and the app relaunches', async () => {
  const r = recorder()
  const out = await applyUpdate({ applier: 'deb', version: '0.2.0' }, {
    config: PEAROFFICE, file: '/tmp/pearoffice-0.2.0-linux-amd64.deb', digest: 'e'.repeat(64), exec: r.exec,
    fsImpl: { existsSync: () => { throw new Error('there is no helper to look for') } }
  })
  assert.deepEqual(r.calls, ['pkexec dpkg -i /tmp/pearoffice-0.2.0-linux-amd64.deb'])
  assert.deepEqual(out, { restarted: false, needsRelaunch: true, via: 'pkexec-dpkg', applier: 'deb', version: '0.2.0' })
})

test('PearOffice: a cancelled password prompt is an error, not an update', async () => {
  const body = 'deb bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  let relaunched = 0
  const applier = new UpdateApplier({
    config: PEAROFFICE,
    getUpdate: () => SHEET_UPDATE,
    platform: 'linux',
    target: '',
    exec: async (argv) => { if (argv[0] === 'pkexec') throw new Error('pkexec: Not authorized'); return '' },
    fetchImpl: stubFetch(urlsFor(SHEET_ASSETS, body, digest)),
    onRelaunch: () => { relaunched++ }
  })
  const s = await applier.apply()
  assert.equal(s.status, 'error')
  assert.match(s.error, /Not authorized/)
  assert.equal(relaunched, 0)
})

test('PearOffice: the full .deb apply ends in a relaunch', async () => {
  const body = 'deb bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const r = recorder()
  let relaunched = 0
  const applier = new UpdateApplier({
    config: PEAROFFICE,
    getUpdate: () => SHEET_UPDATE,
    platform: 'linux',
    target: '',
    exec: r.exec,
    fetchImpl: stubFetch(urlsFor(SHEET_ASSETS, body, digest)),
    onRelaunch: () => { relaunched++ }
  })
  const s = await applier.apply()
  assert.deepEqual(s, { status: 'restarting', version: '0.2.0', via: 'self' })
  assert.equal(r.calls.length, 1, 'no supervisor query: PearOffice has no unit')
  assert.match(r.calls[0], /^pkexec dpkg -i .*pearoffice-0\.2\.0-linux-amd64\.deb$/)
  assert.equal(relaunched, 1)
})

test('PearOffice: on Windows with no service the installer runs detached and the app quits', async () => {
  const r = recorder()
  const out = await applyUpdate({ applier: 'windows', version: '0.2.0' },
    { config: PEAROFFICE, file: 'C:\\tmp\\PearOffice-Setup-0.2.0.exe', exec: r.exec })
  assert.equal(r.calls.length, 1)
  assert.match(r.calls[0], /Win32_Process/, 'detached, or it dies with the app when the app quits')
  assert.match(r.calls[0], /CommandLine='"C:\\tmp\\PearOffice-Setup-0\.2\.0\.exe" \/S --force-run'/)
  assert.deepEqual(out, { restarted: false, needsQuit: true, via: 'installer', applier: 'windows', version: '0.2.0' })
})

test('PearOffice: the driver turns needsQuit into restarting and calls onQuit', async () => {
  const body = 'exe bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const r = recorder({ 'sc.exe': 'RUNNING' })
  let quit = 0
  let relaunched = 0
  const applier = new UpdateApplier({
    config: PEAROFFICE,
    getUpdate: () => SHEET_UPDATE,
    platform: 'win32',
    arch: 'x64',
    exec: r.exec,
    fetchImpl: stubFetch(urlsFor(SHEET_ASSETS, body, digest)),
    onQuit: () => { quit++ },
    onRelaunch: () => { relaunched++ }
  })
  const s = await applier.apply()
  assert.deepEqual(s, { status: 'restarting', version: '0.2.0', via: 'installer' })
  assert.equal(quit, 1)
  assert.equal(relaunched, 0)
  assert.ok(!r.calls.some(c => c.startsWith('sc.exe')), 'no service query for an app with no service')
})

test('PearOffice: the macOS swap checks the PearOffice bundle against the team', async () => {
  const body = 'dmg bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const r = recorder({ 'codesign -dv': TEAM_OK })
  let relaunched = 0
  const applier = new UpdateApplier({
    config: PEAROFFICE,
    getUpdate: () => SHEET_UPDATE,
    platform: 'darwin',
    arch: 'x64',
    execPath: '/Applications/PearOffice.app/Contents/MacOS/PearOffice',
    exec: r.exec,
    fsImpl: { existsSync: () => { throw new Error('no daemon to look for') } },
    fetchImpl: stubFetch(urlsFor(SHEET_ASSETS, body, digest)),
    onRelaunch: () => { relaunched++ }
  })
  const s = await applier.apply()
  assert.deepEqual(s, { status: 'restarting', version: '0.2.0', via: 'self' })
  assert.match(r.calls[0], /^hdiutil attach .*\/tmp\/pearoffice-update-\d+ .*PearOffice-0\.2\.0-mac-x64\.dmg$/)
  assert.ok(r.calls.some(c => /^ditto \/tmp\/pearoffice-update-\d+\/PearOffice\.app \/Applications\/PearOffice\.app\.new$/.test(c)), 'staged from the mounted PearOffice.app')
  assert.ok(r.calls.includes('mv /Applications/PearOffice.app.new /Applications/PearOffice.app'))
  assert.equal(relaunched, 1)
})

// --- the real exec ---------------------------------------------------------------------
//
// The recorder hands parseCodesignTeam captured text directly, which is how a
// stdout-only defaultExec once passed every test while every real Mac refused the
// update: codesign reports on stderr. (PearTune, 2026-08-29.)
test('defaultExec carries stderr, where codesign reports', async () => {
  const out = await defaultExec([process.execPath, '-e', "console.error('Identifier=com.example\\nTeamIdentifier=G79ALD29NA')"])
  assert.equal(parseCodesignTeam(out), 'G79ALD29NA', 'a team printed on stderr must reach the parser')
})

test('defaultExec still carries stdout, which is where systemctl answers', async () => {
  const out = await defaultExec([process.execPath, '-e', "console.log('active')"])
  assert.equal(String(out).trim(), 'active')
})

test('defaultExec rejects on a non-zero exit, which is what "no service" and a failed verify look like', async () => {
  await assert.rejects(defaultExec([process.execPath, '-e', 'process.exit(3)']))
})

// --- the download folder is not left behind -----------------------------------------

const { clearUpdateDownloads } = require('../src/update-apply')
const downloads = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith(`${config.slug}-update-`))

test('the download folder is removed once the update is installed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-dl-'))
  const { applier } = applierFor({ tmpDir })
  assert.equal((await applier.apply()).status, 'restarting')
  assert.deepEqual(downloads(tmpDir), [])
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('the download folder is removed after a failed verify too', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-dl-'))
  const urls = {}
  for (const a of ASSETS) urls[a.browser_download_url] = a.name.endsWith('.sha256') ? `${'b'.repeat(64)}  x\n` : 'TAMPERED'
  const r = recorder({ 'systemctl --user is-active': 'active\n' })
  const applier = new UpdateApplier({ config, getUpdate: () => RELEASE, platform: 'linux', target: '/home/tim/PearTune.AppImage', exec: r.exec, fetchImpl: stubFetch(urls), tmpDir })
  assert.equal((await applier.apply()).status, 'error')
  assert.deepEqual(downloads(tmpDir), [])
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('a Windows installer keeps its file: the app quits while it still runs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-dl-'))
  const { applier } = applierFor({ config: PEAROFFICE, platform: 'win32', tmpDir }, { release: SHEET_UPDATE })
  const s = await applier.apply()
  assert.equal(s.via, 'installer')
  assert.equal(downloads(tmpDir).length, 0, 'other slugs untouched')
  assert.equal(fs.readdirSync(tmpDir).filter((n) => n.startsWith('pearoffice-update-')).length, 1)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('old download folders are cleared on the next start, young ones kept', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-dl-'))
  const old = path.join(tmpDir, `${config.slug}-update-old`)
  const young = path.join(tmpDir, `${config.slug}-update-young`)
  const other = path.join(tmpDir, 'something-else-update-x')
  for (const d of [old, young, other]) fs.mkdirSync(d)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo)
  fs.utimesSync(other, twoHoursAgo, twoHoursAgo)
  assert.equal(clearUpdateDownloads({ config, tmpDir }), 1)
  assert.deepEqual(fs.readdirSync(tmpDir).sort(), [path.basename(other), path.basename(young)].sort())
  // Starting an applier does the same.
  fs.utimesSync(young, twoHoursAgo, twoHoursAgo)
  new UpdateApplier({ config, getUpdate: () => null, tmpDir }) // eslint-disable-line no-new
  assert.deepEqual(fs.readdirSync(tmpDir), [path.basename(other)])
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
