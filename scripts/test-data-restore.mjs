import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-restore-test-'))
let count = 0
const digest = (value) => createHash('sha256').update(value).digest('hex')
const check = (value, message) => { assert.ok(value, message); count++; console.log(`✓ ${message}`) }
const rejects = async (operation, message) => { await assert.rejects(operation); count++; console.log(`✓ ${message}`) }
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)) }
try {
  const bundle = join(dir, 'restore.mjs')
  await build({
    stdin: { contents: "export * from './src/main/data-backup.ts'; export * from './src/main/data-restore.ts'; export * from './src/main/data-restore-launch.ts'; export { ArtifactStore } from './src/main/artifacts.ts'", resolveDir: process.cwd() },
    outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent'
  })
  const { createDataBackup, verifyDataBackup, restoreDataBackup, restoredDataEnvironment, ArtifactStore } = await import(pathToFileURL(bundle).href)
  const sessions = join(dir, 'source', 'sessions')
  const yan = join(dir, 'source', 'yan')
  const sourceSession = join(sessions, 'project', 'main.jsonl')
  const sourceImage = join(yan, 'attachments', 'image.png')
  const sourceArtifact = join(yan, 'artifacts', 's-session-restore-test', 'scene.html')
  const widgetSession = sourceSession.replaceAll('\\', '/')
  const prose = `Do not rewrite this message: ${sourceImage}`
  const messages = [
    { type: 'session', version: 3, id: 'session-restore-test', cwd: join(dir, 'project-not-backed-up'), parentSession: sourceSession },
    { type: 'message', id: 'user1', message: { role: 'user', content: [{ type: 'text', text: prose }, { type: 'image', url: pathToFileURL(sourceImage).href }] } }
  ]
  await put(sourceSession, messages.map((item) => JSON.stringify(item)).join('\n') + '\n')
  const legacySession = join(sessions, 'project', 'legacy.jsonl')
  const legacyArtifact = join(yan, 'artifacts', digest(legacySession).slice(0, 32), 'old.html')
  await put(legacySession, [
    { type: 'session', version: 3, id: 'session-legacy-restore', cwd: dir },
    { type: 'message', id: 'legacy-user', message: { role: 'user', content: [{ type: 'image', url: pathToFileURL(legacyArtifact).href }] } }
  ].map((item) => JSON.stringify(item)).join('\n') + '\n')
  await put(legacyArtifact, '<!doctype html><title>legacy</title>')
  await put(join(dirname(legacyArtifact), 'manifest.json'), [{ messageId: 'legacy-reply', artifact: { id: 'legacy-artifact', kind: 'html', title: 'legacy', path: legacyArtifact, filename: 'old.html', bytes: 34, createdAt: 1 } }])
  await put(sourceImage, 'fixture-image')
  await put(sourceArtifact, '<!doctype html><title>restored scene</title>')
  await put(join(dirname(sourceArtifact), 'clip.mp4'), 'fixture-video')
  await put(join(dirname(sourceArtifact), 'manifest.json'), [{ messageId: 'reply1', artifact: { id: 'artifact1', kind: 'html', title: 'scene', path: sourceArtifact, filename: 'scene.html', bytes: 51, createdAt: 1 } }])
  await put(join(yan, 'desktop.json'), { theme: 'dark', cwd: dirname(sourceSession), permissionMode: 'yolo', remoteAccess: { enabled: true }, projects: [{ id: 'p1', cwd: join(dir, 'project-not-backed-up') }] })
  await put(join(yan, 'session-chains.json'), { chains: [{ chainId: widgetSession, segments: [{ sessionFile: widgetSession, startedAt: 1, handoffId: null }], updatedAt: 1 }] })
  await put(join(yan, 'session-layout.json'), { version: 1, entries: [{ sessionFile: sourceSession, sessionId: 'session-restore-test', cwd: dir }] })
  await put(join(yan, 'interaction-state', digest(widgetSession) + '.json'), { version: 1, session: widgetSession, values: { 'bookmark:a': 'saved', 'widget:b': 'state' } })
  await put(join(yan, 'auth.json'), 'not-a-real-credential')
  await put(join(yan, 'pi-package-acquisition', 'package-authorizations.json'), 'must-not-restore-authorization')
  const outside = join(dir, 'external')
  await put(join(outside, 'external.html'), 'must-not-follow-a-link')
  await symlink(outside, join(yan, 'artifacts', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const backups = join(dir, 'backups')
  const destination = join(dir, 'recovered')
  await mkdir(backups)
  await mkdir(destination)
  await rejects(() => createDataBackup(backups, sessions, yan), '备份遇到符号链接时明确拒绝，不跟随外部目标')
  await rm(join(yan, 'artifacts', 'linked'))
  const backup = await createDataBackup(backups, sessions, yan)
  const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf8'))
  check(manifest.version === 2 && manifest.sources.sessions, 'v2 备份保存路径迁移信息')
  check(manifest.files.some((item) => item.path === 'yan/attachments/image.png') && manifest.files.some((item) => item.path.endsWith('/scene.html')) && manifest.files.some((item) => item.path.endsWith('/clip.mp4')), '附件、HTML 成果与视频进入备份')
  check(manifest.files.every((item) => !/auth|linked/.test(item.path)), '不备份凭证、插件授权或外部链接目标')
  check((await verifyDataBackup(backup.path)).files === manifest.files.length, 'v2 备份逐文件校验通过')
  await rejects(() => restoreDataBackup(backup.path, backup.path), '拒绝恢复到备份目录内部')
  await rejects(() => restoreDataBackup(backup.path, yan, [yan]), '拒绝恢复到正在使用的数据目录内部')
  const restored = await restoreDataBackup(backup.path, destination)
  const pi = join(restored.path, 'pi-agent')
  const recoveredSession = join(pi, 'sessions', 'project', 'main.jsonl')
  const recoveredImage = join(pi, 'yan', 'attachments', 'image.png')
  const recoveredMessages = (await readFile(recoveredSession, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  check(await readFile(recoveredImage, 'utf8') === 'fixture-image', '附件恢复到新目录')
  check(recoveredMessages[0].parentSession === recoveredSession && recoveredMessages[1].message.content[1].url === pathToFileURL(recoveredImage).href, '会话父链与图片 URL 指向恢复目录')
  check(recoveredMessages[1].message.content[0].text === prose, '恢复不改写消息正文中的路径文本')
  const chain = JSON.parse(await readFile(join(pi, 'yan', 'session-chains.json'), 'utf8'))
  check(chain.chains[0].segments[0].sessionFile === recoveredSession.replaceAll('\\', '/'), '压缩后的多段会话链迁移到新目录并保持规范斜杠')
  const recoveredWidgetSession = recoveredSession.replaceAll('\\', '/')
  const widget = JSON.parse(await readFile(join(pi, 'yan', 'interaction-state', digest(recoveredWidgetSession) + '.json'), 'utf8'))
  check(widget.session === recoveredWidgetSession && widget.values['bookmark:a'] === 'saved' && widget.values['widget:b'] === 'state', '书签及小部件状态迁移引用与哈希文件名')
  const settings = JSON.parse(await readFile(join(pi, 'yan', 'desktop.json'), 'utf8'))
  check(settings.theme === 'dark' && settings.cwd === join(restored.path, 'workspace') && settings.remoteAccess.enabled === false && settings.permissionMode === 'danger', '恢复副本保留外观，使用独立工作目录、默认权限并关闭远程访问')
  const artifactStore = new ArtifactStore(join(pi, 'yan', 'artifacts'))
  const hydrated = await artifactStore.hydrateMessages(recoveredSession, [{ id: 'reply1', role: 'assistant', text: '' }])
  check(!hydrated[0].artifacts?.[0]?.unavailable && hydrated[0].artifacts?.[0]?.path === join(pi, 'yan', 'artifacts', 's-session-restore-test', 'scene.html'), '恢复后的成果可从真实 ArtifactStore 加载')
  const recoveredLegacySession = join(pi, 'sessions', 'project', 'legacy.jsonl')
  const recoveredLegacyArtifact = join(pi, 'yan', 'artifacts', digest(recoveredLegacySession).slice(0, 32), 'old.html')
  const legacyRows = (await readFile(recoveredLegacySession, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  check(legacyRows[1].message.content[0].url === pathToFileURL(recoveredLegacyArtifact).href && (await readFile(recoveredLegacyArtifact, 'utf8')).includes('legacy'), '旧版路径哈希成果目录与会话内引用同步迁移')
  const legacyHydrated = await artifactStore.hydrateMessages(recoveredLegacySession, [{ id: 'legacy-reply', role: 'assistant', text: '' }])
  check(!legacyHydrated[0].artifacts?.[0]?.unavailable, '旧版成果可继续由真实成果存储加载')
  const env = restoredDataEnvironment(restored.path, { PATH: 'system-path', ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'fake', YAN_DATA_DIR: 'old', PI_AGENT_DIR: 'old', CUSTOM_SECRET: 'fake' })
  check(env.PATH === 'system-path' && env.YAN_USER_DATA === join(restored.path, 'electron') && env.YAN_PI_DIR === pi && !env.OPENAI_API_KEY && !env.ELECTRON_RUN_AS_NODE && !env.CUSTOM_SECRET && !env.PI_AGENT_DIR, '独立窗口不继承服务密钥、旧数据目录或 Electron Node 模式')
  check(await readFile(sourceSession, 'utf8') === messages.map((item) => JSON.stringify(item)).join('\n') + '\n' && JSON.parse(await readFile(join(yan, 'desktop.json'), 'utf8')).remoteAccess.enabled === true, '恢复不修改源会话和现有设置')
  const restoredAgain = await restoreDataBackup(backup.path, destination)
  check(restoredAgain.path !== restored.path, '重复恢复始终创建新目录，不覆盖前次恢复')
  const oversized = structuredClone(manifest)
  oversized.files.find((entry) => entry.path === 'yan/desktop.json').size = 16 * 1024 * 1024 + 1
  await put(join(backup.path, 'manifest.json'), oversized)
  await rejects(() => restoreDataBackup(backup.path, destination), '在读取超大 JSON 元数据前拒绝恢复')
  const bad = structuredClone(manifest)
  bad.files[0].path = 'yan/artifacts/CON.html'
  await put(join(backup.path, 'manifest.json'), bad)
  await rejects(() => restoreDataBackup(backup.path, destination), '拒绝 Windows 设备名称路径')
  bad.files[0].path = 'yan/artifacts/../../escape'
  await put(join(backup.path, 'manifest.json'), bad)
  await rejects(() => restoreDataBackup(backup.path, destination), '拒绝穿越恢复目录')
  await put(join(backup.path, 'manifest.json'), manifest)
  await put(join(backup.path, 'yan', 'attachments', 'image.png'), 'tampered')
  const before = await readdir(destination)
  await rejects(() => restoreDataBackup(backup.path, destination), '损坏的备份在创建恢复目录前被拒绝')
  check(JSON.stringify(await readdir(destination)) === JSON.stringify(before), '校验失败不产生半成品恢复目录')
  const legacy = await createDataBackup(backups, sessions, yan)
  const legacyManifest = JSON.parse(await readFile(join(legacy.path, 'manifest.json'), 'utf8'))
  legacyManifest.version = 1
  legacyManifest.sources = { sessions: false, yan: null }
  legacyManifest.files = legacyManifest.files.filter((item) => item.path.startsWith('sessions/') || item.path === 'yan/desktop.json' || item.path.startsWith('yan/interaction-state/'))
  await put(join(legacy.path, 'manifest.json'), legacyManifest)
  check((await restoreDataBackup(legacy.path, destination)).files === legacyManifest.files.length, '兼容恢复 v1 备份，忽略未定义的来源字段，不伪造缺失的附件和成果')
  console.log(`\n${count} passed`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
