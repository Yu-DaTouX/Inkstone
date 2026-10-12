import { runSettingsStoreTests } from './test-settings-store.mjs'
let passed = 0
const failures = []
const ok = (condition, message, detail) => {
  if (condition) { passed++; console.log(`✓ ${message}`) }
  else { failures.push(`${message}${detail ? `: ${detail}` : ''}`); console.error(`✗ ${failures.at(-1)}`) }
}
await runSettingsStoreTests(ok)
if (failures.length) process.exitCode = 1
else console.log(`settings review tests passed: ${passed}`)
