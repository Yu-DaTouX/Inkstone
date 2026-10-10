import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export async function runCapabilityNegotiationTests() {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-capabilities-'))
  const outfile = join(root, 'capabilities.mjs')
  await build({ entryPoints: ['src/shared/capability-negotiation.ts'], outfile, bundle: true, platform: 'neutral', format: 'esm', logLevel: 'silent' })
  const { negotiateCapabilities, capabilityAllowed } = await import(pathToFileURL(outfile).href)
  const info = negotiateCapabilities(['read', 'write', 'browser', 'shell'], ['read', 'write', 'shell'], ['read', 'browser', 'shell'], ['shell'])
  assert.deepEqual(info.capabilities, ['read'])
  assert.equal(info.capabilityDetails.find(c => c.id === 'browser').configured, false)
  assert.equal(info.capabilityDetails.find(c => c.id === 'write').authorized, false)
  assert.equal(info.capabilityDetails.find(c => c.id === 'shell').available, false)
  assert.equal(capabilityAllowed(info, 'read'), true)
  assert.equal(capabilityAllowed(info, 'write'), false)
  assert.equal(capabilityAllowed({ capabilities: ['write'], capabilityDetails: info.capabilityDetails }, 'write'), false)
  assert.equal(capabilityAllowed({ capabilities: ['old-server'] }, 'old-server'), true)
  assert.equal(capabilityAllowed(null, 'read'), false)
  console.log('PASS: implemented/configured/available/authorized negotiation and legacy client fallback')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCapabilityNegotiationTests()
