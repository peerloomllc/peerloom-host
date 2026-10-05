// dashboard-auth must load without identity.js or hyperdht: PearSheet's seeder
// dashboard ships it on its own in a small image.
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

test('dashboard-auth loads without identity.js or hyperdht', () => {
  const file = path.join(__dirname, '..', 'src', 'dashboard-auth.js')
  const loaded = JSON.parse(execFileSync(process.execPath, ['-e', 'require(' + JSON.stringify(file) + '); console.log(JSON.stringify(Object.keys(require.cache)))']))
  assert.deepEqual(loaded.filter((f) => /identity\.js$|[\\/]hyperdht[\\/]/.test(f)), [])
})
