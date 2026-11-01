import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import extension from '../resources/pi-extensions/user-address.js'

const root = resolve(tmpdir())
const dir = mkdtempSync(join(root, 'inkstone-user-address-'))
const previous = process.env.YAN_DATA_DIR
process.env.YAN_DATA_DIR = dir
try {
  const handlers = {}
  extension({ on: (name, fn) => { handlers[name] = fn } })
  const start = (event = { systemPrompt: 'BASE' }) => handlers.before_agent_start(event)
  const save = (profile) => writeFileSync(join(dir, 'desktop.json'), JSON.stringify({ profile }))
  assert.equal(start(), undefined)
  save({ name: '  小砚  ' })
  assert.match(start().systemPrompt, /^BASE\n\n.*"小砚"/u)
  const sections = { native: 'keep' }
  assert.equal(start({ systemPrompt: 'BASE', systemPromptOptions: { sections } }), undefined)
  assert.equal(sections.native, 'keep')
  assert.match(sections.inkstone_user_address, /"小砚"/u)
  save({ name: 'Alice' })
  start({ systemPromptOptions: { sections } })
  assert.match(sections.inkstone_user_address, /"Alice"/u)
  assert.doesNotMatch(sections.inkstone_user_address, /小砚/u)
  save({ name: '' })
  start({ systemPromptOptions: { sections } })
  assert.equal(sections.inkstone_user_address, undefined)
  assert.equal(start(), undefined)
  for (const name of [' \n\t\u0000\u200b', null, {}, 42]) {
    save({ name })
    assert.equal(start(), undefined)
  }
  save({ name: 'A"\nB\\C' })
  assert.ok(start().systemPrompt.includes(JSON.stringify('A" B\\C')))
  save({ name: 'a'.repeat(100) })
  assert.ok(start().systemPrompt.includes(JSON.stringify('a'.repeat(32))))
  writeFileSync(join(dir, 'desktop.json'), '{broken')
  assert.equal(start(), undefined)
  assert.deepEqual(Object.keys(handlers), ['before_agent_start'])
  console.log('PASS user address: live rename/clear, native sections, fallback, malformed settings, quoted names, length bound; no message rewrites')
} finally {
  if (previous === undefined) delete process.env.YAN_DATA_DIR
  else process.env.YAN_DATA_DIR = previous
  if (!resolve(dir).startsWith(root + sep)) throw new Error('Unexpected fixture path')
  rmSync(dir, { recursive: true, force: true })
}
