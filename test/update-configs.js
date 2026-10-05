'use strict'

// The two app configs the update tests run against. PEARTUNE mirrors what PearTune
// hard-coded before it moved here, to prove it can migrate without behaviour change.
// PEARSHEET is the first app written against the shared version.

const PEARSHEET = {
  name: 'PearSheet',
  slug: 'pearsheet',
  repo: 'peerloomllc/pearsheet-releases',
  envPrefix: 'PEARSHEET',
  assets: {
    win32: /^PearSheet-Setup-.*\.exe$/i,
    darwinArm64: /-mac-arm64\.dmg$/i,
    darwinX64: /-mac-x64\.dmg$/i,
    appImage: /\.AppImage$/i,
    deb: /\.deb$/i
  },
  mac: { appBundle: 'PearSheet.app', teamId: 'G79ALD29NA', daemonPlist: null, hostArgv: null },
  linux: { unit: null, debHelper: null },
  windows: { service: null, installerArgs: ['/S', '--force-run'] }
}

const PEARTUNE = {
  name: 'PearTune',
  slug: 'peartune-host',
  repo: 'peerloomllc/peartune',
  envPrefix: 'PEARTUNE',
  assets: {
    win32: /^PearTune-Setup-.*\.exe$/i,
    darwinArm64: /-arm64\.dmg$/i,
    // The Intel build is the bare .dmg, so "a .dmg that is not -arm64".
    darwinX64: (name) => /\.dmg$/i.test(name) && !/-arm64\.dmg$/i.test(name),
    appImage: /\.AppImage$/i,
    deb: /\.deb$/i
  },
  mac: {
    appBundle: 'PearTune.app',
    teamId: 'G79ALD29NA',
    daemonPlist: '/Library/LaunchDaemons/com.peerloom.peartune.plist',
    hostArgv: 'PearTune.app/Contents/Resources/app.asar/vendor/host'
  },
  linux: { unit: 'peartune-host.service', debHelper: '/opt/PearTune/updater-helper.sh' },
  windows: { service: 'PearTuneHost', installerArgs: ['/S'] }
}

module.exports = { PEARSHEET, PEARTUNE }
