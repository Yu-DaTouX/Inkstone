import { build } from '../../node_modules/esbuild/lib/main.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'yan-pi-package-smoke-probe-'))
const oldSecret = process.env.YAN_PI_PACKAGE_SMOKE_PROBE_SECRET
process.env.YAN_PI_PACKAGE_SMOKE_PROBE_SECRET = 'must-not-cross-into-pi'

try {
  await build({
    entryPoints: ['src/main/capabilities/pi-package-smoke.ts'],
    outfile: 'out/test/pi-package-smoke-probe.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['tar'],
    logLevel: 'silent'
  })
  await build({
    entryPoints: ['src/main/capabilities/acquisition-service.ts'],
    outfile: 'out/test/acquisition-service-smoke.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['tar'],
    logLevel: 'silent'
  })
  const { smokeStagedPiPackage } = await import('../../out/test/pi-package-smoke-probe.mjs')
  const { AcquisitionService } = await import('../../out/test/acquisition-service-smoke.mjs')
  const service = new AcquisitionService({ root })
  const tx = await service.begin({
    planId: 'internal-smoke-fixture',
    planRevision: 1,
    candidateId: 'npm:yan-internal-smoke-fixture@1.0.0',
    digest: 'internal-fixture-only',
    projectId: 'internal-project'
  })
  await service.stage({
    operationId: tx.operationId,
    files: [
      {
        path: 'package/package.json',
        content: JSON.stringify({
          name: 'yan-internal-smoke-fixture',
          version: '1.0.0',
          pi: { extensions: ['./extensions/*.mjs', '!./extensions/ignored.mjs'] }
        })
      },
      {
        path: 'package/extensions/fixture.mjs',
        content: [
          'export default function (pi) {',
          "  pi.on('session_start', () => {",
          "    if (process.env.YAN_PI_PACKAGE_SMOKE_PROBE_SECRET) throw new Error('smoke environment leaked');",
          '  });',
          '}',
          ''
        ].join('\n')
      },
      {
        path: 'package/extensions/ignored.mjs',
        content: "throw new Error('Pi package exclusion was not applied');\n"
      }
    ]
  })
  const result = await smokeStagedPiPackage({ root, operationId: tx.operationId, timeoutMs: 15_000 })
  if (!result.ok) throw new Error(`内部 fixture 冒烟失败：${result.problems.join('；')}`)
  process.stdout.write('内部自写 fixture：Pi 离线 RPC 启动、资源加载、session_start 与环境隔离通过。\n')
} finally {
  if (oldSecret === undefined) delete process.env.YAN_PI_PACKAGE_SMOKE_PROBE_SECRET
  else process.env.YAN_PI_PACKAGE_SMOKE_PROBE_SECRET = oldSecret
  await rm(root, { recursive: true, force: true })
}
