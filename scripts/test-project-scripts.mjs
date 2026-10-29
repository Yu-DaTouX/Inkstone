import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

async function bundle(entry, outfile) {
  await build({
    entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(pathToFileURL(fileURLToPath(new URL(`../${outfile}`, import.meta.url))).href + `?t=${Date.now()}`)
}

async function runShared() {
  const shared = await bundle('src/shared/project-scripts.ts', 'out/test/project-scripts-shared.mjs')

  assert.equal(shared.isProjectScriptIcon('play'), true)
  assert.equal(shared.isProjectScriptIcon('rocket'), false)
  assert.equal(shared.isProjectScriptIcon(7), false)

  const valid = shared.sanitizeProjectScript({
    id: 'a1',
    name: '  开发  服务器 ',
    command: 'npm   run dev',
    icon: 'server',
    previewUrl: 'http://localhost:5173'
  })
  assert.deepEqual(valid, {
    id: 'a1',
    name: '开发 服务器',
    command: 'npm   run dev',
    icon: 'server',
    previewUrl: 'http://localhost:5173'
  })

  const noIcon = shared.sanitizeProjectScript({ id: 'a2', name: 'lint', command: 'npm run lint', icon: 'rocket' })
  assert.deepEqual(noIcon, { id: 'a2', name: 'lint', command: 'npm run lint' })

  assert.equal(shared.sanitizeProjectScript({ id: '', name: 'x', command: 'y' }), null)
  assert.equal(shared.sanitizeProjectScript({ id: 'a3', name: '   ', command: 'y' }), null)
  assert.equal(shared.sanitizeProjectScript({ id: 'a4', name: 'x', command: '   ' }), null)
  assert.equal(shared.sanitizeProjectScript(null), null)
  assert.equal(shared.sanitizeProjectScript(['x']), null)
  assert.equal(shared.sanitizeProjectScript({ id: 'a5', name: 'x', command: 'y', previewUrl: 'ftp://x' }).previewUrl, undefined)
  assert.equal(shared.sanitizeProjectScript({ id: 'a6', name: 'x', command: 'y', previewUrl: ' localhost:3000 ' }).previewUrl, 'http://localhost:3000')
  assert.equal(shared.sanitizeProjectScript({ id: 'a7', name: 'x', command: 'y', previewUrl: 'https://a.dev/p' }).previewUrl, 'https://a.dev/p')
  assert.equal(shared.sanitizeProjectScript({ id: 'a8', name: 'x', command: 'y', previewUrl: 'javascript:alert(1)' }).previewUrl, undefined)

  const map = shared.sanitizeProjectScripts({
    p1: [
      { id: 's1', name: 'dev', command: 'npm run dev', icon: 'play' },
      { id: 's1', name: 'dup', command: 'npm run dup' },
      { id: 's2', name: '', command: 'bad' }
    ],
    p2: [],
    __proto__: [{ id: 'evil', name: 'x', command: 'y' }],
    p3: 'nope'
  })
  assert.deepEqual(Object.keys(map), ['p1'])
  assert.deepEqual(map.p1, [{ id: 's1', name: 'dev', command: 'npm run dev', icon: 'play' }])
  assert.deepEqual(shared.sanitizeProjectScripts(null), {})
  assert.deepEqual(shared.sanitizeProjectScripts([]), {})

  const many = Array.from({ length: shared.MAX_PROJECT_SCRIPTS + 5 }, (_, index) => ({
    id: `s${index}`,
    name: `n${index}`,
    command: `c${index}`
  }))
  assert.equal(shared.sanitizeProjectScripts({ p: many }).p.length, shared.MAX_PROJECT_SCRIPTS)

  assert.equal(shared.packageManagerOf([]), 'npm')
  assert.equal(shared.packageManagerOf(['package-lock.json']), 'npm')
  assert.equal(shared.packageManagerOf(['package-lock.json', 'pnpm-lock.yaml']), 'pnpm')
  assert.equal(shared.packageManagerOf(['yarn.lock']), 'yarn')
  assert.equal(shared.packageManagerOf(['bun.lockb']), 'bun')
  assert.equal(shared.packageManagerOf(['bun.lock']), 'bun')
  assert.equal(shared.packageManagerOf(['YARN.LOCK']), 'yarn')

  assert.equal(shared.packageScriptCommand('npm', 'dev'), 'npm run dev')
  assert.equal(shared.packageScriptCommand('pnpm', 'dev'), 'pnpm run dev')
  assert.equal(shared.packageScriptCommand('yarn', 'dev'), 'yarn run dev')
  assert.equal(shared.packageScriptCommand('bun', 'dev'), 'bun run dev')

  assert.deepEqual(shared.packageScriptsFromManifest({ scripts: { dev: 'vite', test: 'vitest' } }, 'pnpm'), [
    { name: 'dev', command: 'pnpm run dev' },
    { name: 'test', command: 'pnpm run test' }
  ])
  assert.deepEqual(shared.packageScriptsFromManifest({ scripts: { dev: '  ', '': 'x' } }, 'npm'), [])
  assert.deepEqual(shared.packageScriptsFromManifest({}, 'npm'), [])
  assert.deepEqual(shared.packageScriptsFromManifest({ scripts: [] }, 'npm'), [])
  assert.deepEqual(shared.packageScriptsFromManifest(null, 'npm'), [])
  assert.deepEqual(shared.packageScriptsFromManifest({ scripts: { build: 3 } }, 'npm'), [])
}

async function runRenderer() {
  const mod = await bundle(
    'src/renderer/src/features/scripts/project-scripts.ts',
    'out/test/project-scripts.mjs'
  )

  assert.deepEqual(mod.scriptsOfProject(undefined, 'p1'), [])
  assert.deepEqual(mod.scriptsOfProject({ p1: [] }, null), [])
  assert.deepEqual(mod.scriptsOfProject({ p1: [{ id: 'a', name: 'dev', command: 'npm run dev' }] }, 'p1'), [
    { id: 'a', name: 'dev', command: 'npm run dev' }
  ])
  assert.deepEqual(mod.scriptsOfProject({ p1: [] }, 'p2'), [])

  assert.equal(mod.primaryProjectScript([]), null)
  assert.deepEqual(mod.primaryProjectScript([{ id: 'a', name: 'dev', command: 'npm run dev' }]), {
    id: 'a',
    name: 'dev',
    command: 'npm run dev'
  })

  const existing = [{ id: 'a', name: 'dev', command: 'npm run dev' }]
  const available = [
    { name: 'dev', command: 'pnpm run dev' },
    { name: 'DEV', command: 'yarn run dev' },
    { name: 'build', command: 'pnpm run build' },
    { name: 'test', command: 'pnpm   run   test' }
  ]
  assert.deepEqual(mod.importablePackageScripts(existing, available), [
    { name: 'build', command: 'pnpm run build' },
    { name: 'test', command: 'pnpm   run   test' }
  ])
  assert.deepEqual(mod.importablePackageScripts([], []), [])

  let seq = 0
  const added = mod.addProjectScripts(existing, available, () => `id-${(seq += 1)}`)
  assert.deepEqual(added, [
    { id: 'a', name: 'dev', command: 'npm run dev' },
    { id: 'id-1', name: 'build', command: 'pnpm run build', icon: 'play' },
    { id: 'id-2', name: 'test', command: 'pnpm   run   test', icon: 'play' }
  ])

  const capped = mod.addProjectScripts(
    Array.from({ length: 24 }, (_, index) => ({ id: `s${index}`, name: `n${index}`, command: `c${index}` })),
    [{ name: 'extra', command: 'pnpm run extra' }],
    () => 'new'
  )
  assert.equal(capped.length, 24)
  assert.equal(capped.some((script) => script.id === 'new'), false)

  const three = [
    { id: 'a', name: 'a', command: 'a' },
    { id: 'b', name: 'b', command: 'b' },
    { id: 'c', name: 'c', command: 'c' }
  ]
  assert.deepEqual(mod.moveProjectScript(three, 'b', -1).map((script) => script.id), ['b', 'a', 'c'])
  assert.deepEqual(mod.moveProjectScript(three, 'b', 1).map((script) => script.id), ['a', 'c', 'b'])
  assert.deepEqual(mod.moveProjectScript(three, 'a', -1).map((script) => script.id), ['a', 'b', 'c'])
  assert.deepEqual(mod.moveProjectScript(three, 'c', 1).map((script) => script.id), ['a', 'b', 'c'])
  assert.deepEqual(mod.moveProjectScript(three, 'missing', 1).map((script) => script.id), ['a', 'b', 'c'])
  assert.deepEqual(three.map((script) => script.id), ['a', 'b', 'c'])

  assert.deepEqual(mod.replaceProjectScript(three, 'b', { name: 'B' })[1], { id: 'b', name: 'B', command: 'b' })
  assert.deepEqual(mod.replaceProjectScript(three, 'x', { name: 'B' }), three)
  assert.deepEqual(mod.removeProjectScript(three, 'b').map((script) => script.id), ['a', 'c'])
  assert.deepEqual(mod.normalizeProjectScripts([{ id: 'a', name: ' dev ', command: 'npm run dev' }, { id: 'b', name: '', command: '' }]), [
    { id: 'a', name: 'dev', command: 'npm run dev' }
  ])

  const projects = [
    { id: 'p1', cwd: 'E:\\work\\app', name: '', archived: false, createdAt: 0, updatedAt: 0 },
    { id: 'p2', cwd: '/home/me/api', name: 'api', archived: false, createdAt: 0, updatedAt: 0 }
  ]
  assert.equal(mod.chooseProject(projects, 'p2', '')?.id, 'p2')
  assert.equal(mod.chooseProject(projects, null, 'e:/WORK/app/')?.id, 'p1')
  assert.equal(mod.chooseProject(projects, 'gone', '/home/me/api')?.id, 'p2')
  assert.equal(mod.chooseProject(projects, 'gone', '/elsewhere'), null)
  assert.equal(mod.chooseProject([], 'p1', 'E:\\work\\app'), null)

  const sessions = [
    { id: 's1', path: 'C:\\data\\s1.jsonl', projectId: 'p2' },
    { id: 's2', path: 'C:\\data\\s2.jsonl' }
  ]
  assert.equal(
    mod.projectIdOfView({
      peekedSessionId: 's1',
      peekedPath: null,
      sessions,
      runners: [],
      activeRunnerId: null
    }),
    'p2'
  )
  assert.equal(
    mod.projectIdOfView({
      peekedSessionId: null,
      peekedPath: 'c:/DATA/S1.JSONL',
      sessions,
      runners: [],
      activeRunnerId: null
    }),
    'p2'
  )
  assert.equal(
    mod.projectIdOfView({
      peekedSessionId: 's2',
      peekedPath: null,
      sessions,
      runners: [{ id: 'r1', runId: 'r1', projectId: 'p1' }],
      activeRunnerId: 'r1'
    }),
    'p1'
  )
  assert.equal(
    mod.projectIdOfView({
      peekedSessionId: null,
      peekedPath: null,
      sessions,
      runners: [],
      activeRunnerId: null,
      pendingProjectId: 'p2'
    }),
    'p2'
  )
  assert.equal(
    mod.projectIdOfView({
      peekedSessionId: 's2',
      peekedPath: null,
      sessions,
      runners: [],
      activeRunnerId: null
    }),
    null
  )
}

await runShared()
await runRenderer()
console.log('test-project-scripts: ok')
