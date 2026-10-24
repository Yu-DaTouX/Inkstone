import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstanceInfo, JavaEntry, LoaderKind } from '../src/shared/api.ts'
import type { CrashRuleMatch } from '../src/shared/crash-api.ts'
import { buildCrashActions, suggestMemoryMb } from '../src/core/crash/actions.ts'
import { maskSecrets, normalizeExitCode } from '../src/core/crash/collect.ts'
import { diagnose } from '../src/core/crash/diagnose.ts'
import { CrashCenter } from '../src/core/crash/index.ts'
import { missingDependencies, scanMods } from '../src/core/crash/mods.ts'
import { preflightLaunch } from '../src/core/crash/preflight.ts'
import { CRASH_RULES } from '../src/core/crash/rules.ts'
import { makeZip } from '../src/core/crash/zip.ts'
import { ZipReader } from '../src/core/dev/zip.ts'
import { splitArgs } from '../src/core/launch.ts'
import { storedZip } from './zip-fixture.ts'

let passed = 0
function test(name: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(run()).then(
    () => {
      passed += 1
    },
    (error: unknown) => {
      console.error(`✗ ${name}`)
      throw error
    }
  )
}

const fixtureDir = join(import.meta.dirname, '..', 'src', 'core', 'crash', 'fixtures')
const root = mkdtempSync(join(tmpdir(), 'inkstone-crash-test-'))

const FIXTURES: Array<{ file: string; loader: LoaderKind; rule: string; evidence: string }> = [
  { file: 'java-version.log', loader: 'fabric', rule: 'java-version', evidence: 'UnsupportedClassVersionError' },
  { file: 'out-of-memory.log', loader: 'fabric', rule: 'out-of-memory', evidence: 'OutOfMemoryError' },
  { file: 'corrupt-file.log', loader: 'fabric', rule: 'corrupt-file', evidence: 'invalid LOC header' },
  { file: 'missing-dependency.log', loader: 'fabric', rule: 'missing-dependency', evidence: 'which is missing' },
  { file: 'duplicate-mod.log', loader: 'fabric', rule: 'duplicate-mod', evidence: 'Duplicate mod' },
  { file: 'entrypoint-crash.log', loader: 'fabric', rule: 'entrypoint-crash', evidence: 'provided by' },
  { file: 'mixin-failure.log', loader: 'fabric', rule: 'mixin-failure', evidence: 'Critical injection failure' },
  { file: 'forge-incomplete.log', loader: 'forge', rule: 'forge-incomplete', evidence: 'Missing patched client' },
  { file: 'coremod.log', loader: 'forge', rule: 'coremod', evidence: 'Coremod' },
  { file: 'native-library.log', loader: 'fabric', rule: 'native-library', evidence: 'UnsatisfiedLinkError' },
  { file: 'gpu-driver.log', loader: 'fabric', rule: 'gpu-driver', evidence: 'does not appear to support OpenGL' }
]

function fabricMeta(value: Record<string, unknown>): Buffer {
  return storedZip({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, ...value }) })
}

const modsDir = join(root, 'mods')
mkdirSync(modsDir, { recursive: true })
writeFileSync(
  join(modsDir, 'sodium-0.5.8.jar'),
  fabricMeta({
    id: 'sodium',
    name: 'Sodium',
    version: '0.5.8',
    depends: { minecraft: '*' },
    entrypoints: { main: [{ value: 'net.caffeinemc.mods.sodium.client.SodiumClientMod' }] },
    mixins: ['sodium.mixins.json']
  })
)
writeFileSync(
  join(modsDir, 'sodium-extra-0.6.1.jar'),
  fabricMeta({
    id: 'sodium-extra',
    name: 'Sodium Extra',
    version: '0.6.1',
    depends: { minecraft: '*', 'fabric-api': '*' },
    entrypoints: { main: [{ value: 'net.caffeinemc.mods.sodiumextra.client.SodiumExtraClientMod' }] },
    mixins: ['sodium-extra.mixins.json']
  })
)
writeFileSync(join(modsDir, 'sodium-extra-copy-0.6.1.jar.disabled'), fabricMeta({ id: 'sodium-extra', name: 'Sodium Extra', version: '0.6.1' }))

try {
  await test('每条规则都有一份 fixture，并且命中自己的规则', async () => {
    assert.deepEqual(
      CRASH_RULES.map((rule) => rule.id).sort(),
      FIXTURES.map((fixture) => fixture.rule).sort()
    )
    for (const fixture of FIXTURES) {
      const text = readFileSync(join(fixtureDir, fixture.file), 'utf8')
      const result = diagnose({ text, loader: fixture.loader, mods: [], sources: [{ source: 'latest.log', text }] })
      assert.equal(result.rule?.id, fixture.rule, `${fixture.file} 命中了 ${result.rule?.id ?? '无'}`)
      assert.ok(result.evidence.length > 0, `${fixture.file} 没有证据行`)
      assert.ok(
        result.evidence.some((line) => line.text.includes(fixture.evidence)),
        `${fixture.file} 的证据里没有 ${fixture.evidence}`
      )
      assert.ok((result.rule?.explanation ?? '').length > 8, `${fixture.file} 没有一句结论`)
    }
  })

  await test('加载器不适用时不套用 Forge 规则', async () => {
    const text = readFileSync(join(fixtureDir, 'forge-incomplete.log'), 'utf8')
    const result = diagnose({ text, loader: 'fabric', mods: [], sources: [{ source: 'latest.log', text }] })
    assert.notEqual(result.rule?.id, 'forge-incomplete')
  })

  await test('缺依赖日志给出缺的 modid 与是谁需要', async () => {
    const text = readFileSync(join(fixtureDir, 'missing-dependency.log'), 'utf8')
    const result = diagnose({ text, loader: 'fabric', mods: [], sources: [{ source: 'latest.log', text }] })
    assert.deepEqual(result.outcome?.missing, ['fabric-api'])
    assert.match(result.rule?.explanation ?? '', /Fabric API|fabric-api/)
  })

  await test('嫌疑 Mod 按包名、modid、Mixin 配置命中排序', async () => {
    const mods = await scanMods(modsDir)
    assert.equal(mods.length, 3)
    assert.equal(mods.find((mod) => mod.fileName.startsWith('sodium-0.5.8'))?.enabled, true)
    assert.equal(mods.find((mod) => mod.fileName.endsWith('.disabled'))?.enabled, false)
    const text = [
      '[13:00:00] [Render thread/ERROR]: Exception in thread "Render thread"',
      'java.lang.RuntimeException: boom',
      '\tat net.caffeinemc.mods.sodium.client.SodiumClientMod.onInitialize(SodiumClientMod.java:42)',
      '\tat net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23)'
    ].join('\n')
    const result = diagnose({ text, loader: 'fabric', mods, sources: [{ source: 'process', text }] })
    assert.equal(result.suspects[0]?.modId, 'sodium')
    assert.ok((result.suspects[0]?.hits ?? 0) >= 3)
    assert.ok(result.suspects[0]?.reasons.some((reason) => reason.includes('net.caffeinemc.mods.sodium')))
    assert.ok(!result.suspects.some((suspect) => suspect.modId === 'sodium-extra'))
  })

  await test('Mod 依赖扫描：停用的重复项不进依赖表', async () => {
    const mods = await scanMods(modsDir)
    assert.deepEqual(
      missingDependencies(mods).map((issue) => ({ modId: issue.modId, missing: issue.missing })),
      [{ modId: 'sodium-extra', missing: ['fabric-api'] }]
    )
  })

  await test('启动前检查：Java 太低阻断、缺依赖和缺文件只提醒', async () => {
    const instance: InstanceInfo = {
      id: '1.21.1-Fabric',
      folder: 'E:/game',
      minecraftVersion: '1.21.1',
      loader: 'fabric',
      loaderVersion: '0.16.10',
      javaMajor: 21,
      isolated: true,
      gameDir: 'E:/game',
      modCount: 2,
      preferredJava: null,
      error: null
    }
    const old: JavaEntry[] = [{ path: 'C:/jdk17/bin/java.exe', version: '17.0.9', majorVersion: 17 }]
    const blocked = await preflightLaunch({
      versionId: instance.id,
      loader: 'fabric',
      instance,
      javas: old,
      javaPath: old[0].path,
      accountName: 'Steve',
      maxMemoryMb: 4096,
      totalMemMb: 8192,
      modsDir,
      missingFiles: 2
    })
    assert.equal(blocked.blocked, true)
    assert.equal(blocked.items.find((item) => item.id === 'java')?.level, 'block')
    assert.equal(blocked.items.find((item) => item.id === 'deps')?.level, 'warn')
    assert.match(blocked.items.find((item) => item.id === 'deps')?.detail ?? '', /Fabric API|fabric-api/)
    assert.equal(blocked.items.find((item) => item.id === 'files')?.level, 'warn')

    const good: JavaEntry[] = [{ path: 'C:/jdk21/bin/java.exe', version: '21.0.4', majorVersion: 21 }]
    const ready = await preflightLaunch({
      versionId: instance.id,
      loader: 'fabric',
      instance,
      javas: good,
      javaPath: good[0].path,
      accountName: 'Steve',
      maxMemoryMb: 2048,
      totalMemMb: 8192,
      modsDir,
      missingFiles: 0
    })
    assert.equal(ready.blocked, false)
    assert.equal(ready.items.find((item) => item.id === 'java')?.level, 'ok')
    assert.equal(ready.javaPath, good[0].path)
  })

  await test('内存建议不超过物理内存的 75%', () => {
    assert.equal(suggestMemoryMb(2048, 16384), 4096)
    assert.equal(suggestMemoryMb(12288, 16384), 12288)
  })

  await test('JVM 参数按引号切分', () => {
    assert.deepEqual(splitArgs('-XX:+UseG1GC -Dfoo="a b" -Dbar=1'), ['-XX:+UseG1GC', '-Dfoo=a b', '-Dbar=1'])
    assert.deepEqual(splitArgs('  '), [])
    assert.deepEqual(splitArgs(null), [])
  })

  await test('退出码按有符号显示', () => {
    assert.equal(normalizeExitCode(4294967295), -1)
    assert.equal(normalizeExitCode(1), 1)
    assert.equal(normalizeExitCode(null), null)
  })

  await test('崩溃动作按规则给出，导出总在最后', () => {
    const rule: CrashRuleMatch = {
      id: 'missing-dependency',
      title: '缺少前置 Mod 或依赖版本不符',
      explanation: '缺少前置 Mod：Fabric API（Sodium Extra 需要）。',
      confidence: 'high',
      evidence: []
    }
    const actions = buildCrashActions({
      rule,
      suspects: [{ modId: 'sodium-extra', name: 'Sodium Extra', fileName: 'sodium-extra-0.6.1.jar', hits: 4, reasons: [] }],
      missing: ['fabric-api'],
      names: new Map([['fabric-api', 'Fabric API']]),
      javas: [
        { path: 'C:/jdk17/bin/java.exe', version: '17.0.9', majorVersion: 17 },
        { path: 'C:/jdk21/bin/java.exe', version: '21.0.4', majorVersion: 21 }
      ],
      javaPath: 'C:/jdk17/bin/java.exe',
      requiredMajor: 21,
      maxMemoryMb: 2048,
      totalMemMb: 16384
    })
    assert.ok(actions.some((action) => action.kind === 'install-deps' && action.label.includes('Fabric API')))
    assert.equal(actions.find((action) => action.kind === 'disable-mod')?.value, 'sodium-extra-0.6.1.jar')
    assert.equal(actions.at(-1)?.kind, 'export')
    const next = buildCrashActions({
      rule: { ...rule, id: 'out-of-memory' },
      suspects: [],
      missing: [],
      names: new Map(),
      javas: [
        { path: 'C:/jdk17/bin/java.exe', version: '17.0.9', majorVersion: 17 },
        { path: 'C:/jdk21/bin/java.exe', version: '21.0.4', majorVersion: 21 }
      ],
      javaPath: 'C:/jdk21/bin/java.exe',
      requiredMajor: 21,
      maxMemoryMb: 2048,
      totalMemMb: 16384
    })
    assert.deepEqual(
      next.map((action) => action.kind),
      ['memory', 'export']
    )
    assert.match(next[0].label, /4 GB/)
  })

  await test('导出前把令牌和用户目录打码', () => {
    const masked = maskSecrets('--accessToken abc123 --username Steve accessToken=zzz123 C:\\Users\\YuDaTou\\AppData\\Roaming\\.minecraft /home/steve/.minecraft')
    assert.ok(!masked.includes('abc123'))
    assert.ok(!masked.includes('zzz123'))
    assert.ok(!masked.includes('YuDaTou'))
    assert.ok(masked.includes('<用户目录>\\AppData'))
    assert.ok(masked.includes('/home/<用户>/.minecraft'))
  })

  await test('诊断包 zip 能读回中文条目', async () => {
    const file = join(root, 'pack.zip')
    writeFileSync(file, makeZip([{ name: '摘要.txt', data: Buffer.from('缺少前置 Mod', 'utf8') }, { name: 'logs/a.log', data: Buffer.from('x'.repeat(6000)) }]))
    const reader = await ZipReader.open(file)
    assert.ok(reader.entries.has('摘要.txt'))
    assert.equal((await reader.read('摘要.txt'))?.toString('utf8'), '缺少前置 Mod')
    assert.equal((await reader.read('logs/a.log'))?.length, 6000)
  })

  await test('崩溃收集：落盘、摘要、诊断包、记录列表', async () => {
    const gameDir = join(root, 'game')
    mkdirSync(join(gameDir, 'logs'), { recursive: true })
    mkdirSync(join(gameDir, 'mods'), { recursive: true })
    writeFileSync(join(gameDir, 'mods', 'sodium-extra-0.6.1.jar'), readFileSync(join(modsDir, 'sodium-extra-0.6.1.jar')))
    const center = new CrashCenter(join(root, 'crash'))
    const context = await center.begin({ folder: 'E:/game', versionId: '1.21.1-Fabric 缺失依赖', loader: 'fabric', gameDir, javaPath: 'C:/jdk21/bin/java.exe', maxMemoryMb: 4096 })
    writeFileSync(
      join(gameDir, 'logs', 'latest.log'),
      [
        '[20:11:58] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.10',
        "[20:11:59] [main/ERROR]: Mod 'Sodium Extra' (sodium-extra) 0.6.1 requires any version of fabric-api, which is missing!",
        '\tat net.fabricmc.loader.impl.discovery.ModSolver.add(ModSolver.java:88)'
      ].join('\n')
    )
    const analysis = await center.finish(context, {
      exitCode: 1,
      windowShown: false,
      processLines: ['[main/ERROR]: Mod resolution failed', 'accessToken=secret-token-123'],
      launchArgs: ['C:/jdk21/bin/java.exe', '--accessToken', 'secret-arg-456'],
      stopped: false
    })
    assert.ok(analysis)
    const diagnosis = analysis.diagnosis
    assert.equal(diagnosis.rule?.id, 'missing-dependency')
    assert.deepEqual(diagnosis.missing, ['fabric-api'])
    assert.equal(diagnosis.suspects[0]?.modId, 'sodium-extra')
    assert.ok(diagnosis.note?.includes('窗口没出现'))
    assert.equal(diagnosis.actions.at(-1)?.kind, 'export')
    const summary = readFileSync(join(diagnosis.recordDir ?? '', '摘要.txt'), 'utf8')
    assert.match(summary, /缺少前置 Mod/)
    assert.ok(!summary.includes('secret-arg-456'))
    const processLog = readFileSync(join(diagnosis.recordDir ?? '', '进程输出.log'), 'utf8')
    assert.ok(!processLog.includes('secret-token-123'))
    assert.ok(readdirSync(diagnosis.recordDir ?? '').includes('诊断.json'))

    const exported = await center.exportRecord('E:/game', '1.21.1-Fabric 缺失依赖', diagnosis.id)
    assert.ok(exported && exported.bytes > 200)
    const reader = await ZipReader.open(exported?.path ?? '')
    assert.ok(reader.entries.has('摘要.txt'))
    assert.ok(reader.entries.has('诊断.json'))
    assert.ok(reader.entries.has('进程输出.log'))
    assert.ok(reader.entries.has('启动参数.txt'))
    assert.ok(reader.entries.has('Mod 清单.txt'))

    const records = await center.list('E:/game', '1.21.1-Fabric 缺失依赖')
    assert.equal(records.length, 1)
    assert.equal(records[0].ruleId, 'missing-dependency')
    assert.equal((await center.latest('E:/game', '1.21.1-Fabric 缺失依赖'))?.id, diagnosis.id)
    assert.equal(await center.get('E:/game', '别的版本', diagnosis.id), null)
  })

  await test('正常退出不生成崩溃记录', async () => {
    const gameDir = join(root, 'clean-game')
    mkdirSync(join(gameDir, 'logs'), { recursive: true })
    const center = new CrashCenter(join(root, 'clean-crash'))
    const context = await center.begin({ folder: 'E:/game', versionId: '1.21.1', loader: 'fabric', gameDir, javaPath: null, maxMemoryMb: 2048 })
    const none = await center.finish(context, { exitCode: 0, windowShown: true, processLines: ['done'], launchArgs: [], stopped: false })
    assert.equal(none, null)
    assert.deepEqual(await center.list('E:/game', '1.21.1'), [])
  })

  await test('新 crash-report 也会触发收集', async () => {
    const gameDir = join(root, 'report-game')
    mkdirSync(join(gameDir, 'crash-reports'), { recursive: true })
    const center = new CrashCenter(join(root, 'report-crash'))
    const context = await center.begin({ folder: 'E:/game', versionId: '1.20.1', loader: 'forge', gameDir, javaPath: null, maxMemoryMb: 4096 })
    writeFileSync(join(gameDir, 'crash-reports', 'crash-2026-10-24_20.00.00-client.txt'), 'Description: Rendering screen\njava.lang.UnsupportedClassVersionError: foo\n')
    const analysis = await center.finish(context, { exitCode: null, windowShown: true, processLines: [], launchArgs: [], stopped: true })
    assert.equal(analysis, null)
    const crashed = await center.finish(context, { exitCode: 0, windowShown: true, processLines: [], launchArgs: [], stopped: false })
    assert.equal(crashed?.diagnosis.rule?.id, 'java-version')
    assert.equal(crashed?.diagnosis.note?.includes('崩溃报告'), true)
  })
  await test('崩溃记录上限：每版本保留最近 20 条并清理最旧的', async () => {
    const recordsRoot = join(root, 'retention')
    const center = new CrashCenter(recordsRoot)
    const base = Date.now()
    const write = (index: number, versionId = '1.21.1'): void => {
      const id = `${base}-${index}`
      const dir = join(recordsRoot, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '诊断.json'), JSON.stringify({ id, at: base - index * 1000, folder: 'E:/game', versionId, rule: null }), 'utf8')
      writeFileSync(join(dir, '进程输出.log'), 'x'.repeat(1024))
    }
    for (let index = 0; index < 25; index += 1) write(index)
    write(99, '别的版本')
    const removed = await center.prune()
    assert.equal(removed.length, 5)
    const left = readdirSync(recordsRoot)
    assert.equal(left.length, 21)
    assert.equal(left.includes(`${base}-24`), false)
    assert.equal(left.includes(`${base}-20`), false)
    assert.equal(left.includes(`${base}-19`), true)
    assert.equal(left.includes(`${base}-99`), true)
  })

  await test('崩溃记录总量上限：超过 200MB 类上限时先删最旧的', async () => {
    const recordsRoot = join(root, 'retention-size')
    const center = new CrashCenter(recordsRoot, { maxTotalBytes: 5120 })
    const base = Date.now()
    for (let index = 0; index < 4; index += 1) {
      const dir = join(recordsRoot, `r-${index}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '诊断.json'), JSON.stringify({ id: `r-${index}`, at: base - index * 1000, folder: 'E:/game', versionId: '1.20.1' }), 'utf8')
      writeFileSync(join(dir, '进程输出.log'), Buffer.alloc(2048))
    }
    const removed = await center.prune()
    assert.deepEqual(removed.sort(), ['r-2', 'r-3'])
    assert.deepEqual(readdirSync(recordsRoot).sort(), ['r-0', 'r-1'])
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`✓ 启动与崩溃 ${passed} 项通过`)
