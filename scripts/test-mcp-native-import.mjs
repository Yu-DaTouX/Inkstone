/**
 * 旧宿主 MCP 导入 pi 原生（方案合集 06 后端）。
 *
 * 现场编译 `src/main/mcp/native-import.ts`（会带上 config / shared），在**临时目录**里
 * 用假校验回调覆盖：stdio / http / projectScope / authRef / windows 跳过、同名碰撞、
 * 源与目标并发变化、写失败、校验失败/未接线、外部改动不被覆盖、迁移提示与未知字段保留。
 * 不启动 Electron、不连接真实服务、不调用真实 pi CLI。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-native-import-'))
process.env.YAN_PI_DIR = join(root, 'pi-agent')
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_MCP_SERVERS_FILE = join(root, 'yan', 'mcp-servers.json')

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks++
  console.log(`✓ ${message}`)
}
const fails = async (work, code, message) => {
  let thrown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  ok(
    Boolean(thrown) && thrown.code === code,
    message,
    thrown ? `${thrown.code}: ${thrown.message}` : '没有抛错'
  )
}

const outfile = join(root, 'native-import.mjs')
await build({
  stdin: {
    contents:
      "export * from './src/main/mcp/native-import';" +
      "export * from './src/main/mcp/config';" +
      "export * from './src/shared/mcp-native-import';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

const agentDir = join(root, 'pi-agent')
const hostConfigFile = join(root, 'yan', 'mcp-servers.json')
const projectCwd = join(root, 'project')
await mkdir(hostConfigFile.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
await mkdir(agentDir, { recursive: true })
await mkdir(projectCwd, { recursive: true })
const projects = [{ id: 'p-main', cwd: projectCwd }]
const host = { agentDir, hostConfigFile, projects }
const nativeGlobal = join(agentDir, 'mcp.json')
const nativeProject = join(projectCwd, '.pi', 'mcp.json')

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

try {
  /* ---------------------------------------------------------------- stdio 导入 */

  await writeJson(hostConfigFile, {
    unknownTop: { keep: true },
    servers: [
      {
        id: 'weather',
        title: '天气',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--x'],
        env: { API_KEY: 'secret' },
        effect: 'read',
        customField: 42
      },
      { id: 'other', transport: 'stdio', command: 'other' }
    ]
  })
  const stdioPreview = await m.prepareNativeMcpImport({ host, serverId: 'weather', owner: { id: 'runner-1' } })
  const stdioContent = JSON.parse(stdioPreview.content)
  ok(stdioPreview.nativeName === 'weather' && stdioPreview.scope === 'global', 'stdio：全局服务名与范围正确')
  ok(stdioPreview.targetPath === nativeGlobal, 'stdio：目标是 <PI_AGENT_DIR>/mcp.json', stdioPreview.targetPath)
  ok(
    typeof stdioPreview.token === 'string' && stdioPreview.token.length >= 24 && !stdioPreview.token.includes('weather'),
    'stdio：令牌不可预测且不携带 id'
  )
  ok(
    stdioContent.mcpServers.weather.command === 'node' &&
      JSON.stringify(stdioContent.mcpServers.weather.args) === '["server.js","--x"]' &&
      stdioContent.mcpServers.weather.env.API_KEY === 'secret' &&
      stdioContent.mcpServers.weather.description === '天气',
    'stdio：command / args / env / description 直接对应'
  )
  ok(!('customField' in stdioContent.mcpServers.weather), 'stdio：旧配置私有字段不写进原生')
  ok(!('effect' in stdioContent.mcpServers.weather), 'stdio：effect 不写进原生')
  ok(stdioPreview.warnings.some((w) => w.includes('effect')), 'stdio：effect 丢失给出可读警告')
  ok(stdioPreview.requiresReauth === false, 'stdio：没有 authRef 时不要求重新登录')

  let verifyCalls = 0
  const stdioCommitHost = {
    ...host,
    verify: async () => {
      verifyCalls++
      return { ok: true, connected: true, toolCount: 3 }
    }
  }
  const stdioResult = await m.commitNativeMcpImport({
    host: stdioCommitHost,
    token: stdioPreview.token,
    owner: { id: 'runner-1' }
  })
  ok(
    stdioResult.ok && stdioResult.nativeWritten && stdioResult.deactivated && stdioResult.verified,
    'stdio：校验通过后写原生并停用旧条目',
    `${stdioResult.steps.nativeWrite}/${stdioResult.steps.verify}/${stdioResult.steps.hostDisable}`
  )
  ok(verifyCalls === 1, 'stdio：校验回调各调用一次')
  const nativeAfterStdio = await readJson(nativeGlobal)
  ok(nativeAfterStdio.mcpServers.weather.command === 'node', 'stdio：原生文件已落盘')
  const hostAfterStdio = await readJson(hostConfigFile)
  const weatherEntry = hostAfterStdio.servers.find((entry) => entry.id === 'weather')
  ok(
    weatherEntry.enabled === false &&
      weatherEntry.migratedToNative.nativeName === 'weather' &&
      weatherEntry.migratedToNative.targetPath === nativeGlobal,
    'stdio：旧条目 enabled=false 且写入迁移标记'
  )
  ok(weatherEntry.customField === 42 && hostAfterStdio.unknownTop.keep === true, 'stdio：旧配置未知字段保留')
  ok(hostAfterStdio.servers.find((entry) => entry.id === 'other').enabled === undefined, 'stdio：其他服务不受影响')
  await fails(
    () => m.prepareNativeMcpImport({ host, serverId: 'weather', owner: { id: 'runner-1' } }),
    'already_migrated',
    'stdio：已迁移服务重复导入时给出迁移提示'
  )
  const reparsed = m.parseMcpServersDocument(await readFile(hostConfigFile, 'utf8'), hostConfigFile)
  ok(Boolean(reparsed.servers.find((entry) => entry.id === 'weather')?.migratedToNative), 'stdio：配置解析认得迁移标记')
  ok(
    m.migratedMcpCommandNotice('weather', weatherEntry.migratedToNative).includes('mcp__weather__*'),
    'stdio：yan mcp 提示指向 mcp__<服务>__* 工具'
  )
  ok(
    m.migratedMcpCommandNotice('my-svc', { at: 'x', targetPath: 'y', nativeName: 'my-svc' }).includes('mcp__my_svc__*'),
    'stdio：带连字符的服务名按 pi 命名空间提示'
  )
  await fails(
    () => m.commitNativeMcpImport({ host: stdioCommitHost, token: stdioPreview.token, owner: { id: 'runner-1' } }),
    'token_invalid',
    'stdio：令牌一次性，重复提交被拒'
  )

  /* --------------------------------------------------- http + authRef + 项目范围 */

  await writeJson(hostConfigFile, {
    servers: [
      {
        id: 'remote',
        transport: 'http',
        url: 'https://mcp.example/mcp',
        authRef: 'vault,remote',
        projectScope: 'p-main'
      }
    ]
  })
  await writeJson(nativeProject, { autoEnableCodemode: true, mcpServers: { existing: { command: 'x' } } })
  const httpPreview = await m.prepareNativeMcpImport({ host, serverId: 'remote', owner: { id: 'runner-2' } })
  ok(
    httpPreview.scope === 'project' && httpPreview.projectId === 'p-main' && httpPreview.targetPath === nativeProject,
    'http：projectScope 解析成项目登记里的 .pi/mcp.json',
    httpPreview.targetPath
  )
  ok(httpPreview.requiresReauth === true && httpPreview.reauthNotice.includes('重新登录'), 'http：authRef 提示在 pi 里重新登录')
  ok(httpPreview.warnings.some((w) => w.includes('信任')), 'http：项目级配置需要目录信任的提醒')
  ok(
    !httpPreview.content.includes('authRef') && !httpPreview.content.includes('vault,remote') && !httpPreview.content.includes('"auth"'),
    'http：authRef 凭证不迁移，也不伪造 auth'
  )
  const httpResult = await m.commitNativeMcpImport({
    host: { ...host, verify: async () => ({ ok: true }) },
    token: httpPreview.token,
    owner: { id: 'runner-2' }
  })
  ok(httpResult.ok && httpResult.deactivated, 'http：项目级导入成功')
  const nativeProjectDoc = await readJson(nativeProject)
  ok(
    nativeProjectDoc.autoEnableCodemode === true &&
      nativeProjectDoc.mcpServers.existing.command === 'x' &&
      nativeProjectDoc.mcpServers.remote.url === 'https://mcp.example/mcp',
    'http：原生文档的未知顶层字段与其它服务保留'
  )
  const hostAfterHttp = await readJson(hostConfigFile)
  const remoteEntry = hostAfterHttp.servers.find((entry) => entry.id === 'remote')
  ok(
    remoteEntry.authRef === 'vault,remote' && remoteEntry.enabled === false && remoteEntry.migratedToNative,
    'http：旧条目凭证引用原样保留，只停用'
  )

  /* ------------------------------------------------------- 边界：拒绝条件 */

  await writeJson(hostConfigFile, {
    servers: [{ id: 'p2', transport: 'http', url: 'https://x.test/mcp', projectScope: 'missing' }]
  })
  await fails(
    () => m.prepareNativeMcpImport({ host, serverId: 'p2', owner: { id: 'r' } }),
    'unregistered_project',
    'projectScope：未登记项目拒绝，不按目录反推'
  )

  await writeJson(hostConfigFile, { servers: [{ id: 'windows-mcp', transport: 'stdio', command: 'win' }] })
  await fails(
    () => m.prepareNativeMcpImport({ host, serverId: 'windows-mcp', owner: { id: 'r' } }),
    'windows_mcp_preserved',
    'windows-mcp：保留在砚的连接里，不导入'
  )

  await writeJson(hostConfigFile, { servers: [{ id: 'weather', transport: 'stdio', command: 'node' }] })
  await fails(
    () => m.prepareNativeMcpImport({ host, serverId: 'weather', owner: { id: 'r' } }),
    'name_conflict',
    '碰撞：原生已存在同名服务时拒绝覆盖'
  )

  await writeJson(hostConfigFile, { servers: [{ id: 'shapey', transport: 'stdio', command: 'node' }] })
  await writeJson(nativeGlobal, { mcpServers: [] })
  await fails(
    () => m.prepareNativeMcpImport({ host, serverId: 'shapey', owner: { id: 'r' } }),
    'target_shape',
    '坏结构：mcpServers 不是对象时拒绝改写'
  )
  await writeFile(nativeGlobal, '{ 坏 JSON')
  await fails(
    () => m.prepareNativeMcpImport({ host, serverId: 'shapey', owner: { id: 'r' } }),
    'target_invalid_json',
    '坏 JSON：原生配置无法解析时拒绝改写'
  )

  /* --------------------------------------------------- 源 / 目标并发变化 */

  await writeJson(nativeGlobal, { mcpServers: {} })
  await writeJson(hostConfigFile, { servers: [{ id: 'srcmove', transport: 'stdio', command: 'node' }] })
  const srcPreview = await m.prepareNativeMcpImport({ host, serverId: 'srcmove', owner: { id: 'r' } })
  await writeJson(hostConfigFile, {
    servers: [
      { id: 'srcmove', transport: 'stdio', command: 'node' },
      { id: 'added', transport: 'stdio', command: 'node' }
    ]
  })
  await fails(
    () => m.commitNativeMcpImport({ host, token: srcPreview.token, owner: { id: 'r' } }),
    'source_changed',
    '并发变化：旧配置在预览后被改动时拒绝提交'
  )

  await writeJson(hostConfigFile, { servers: [{ id: 'tgtmove', transport: 'stdio', command: 'node' }] })
  const tgtPreview = await m.prepareNativeMcpImport({ host, serverId: 'tgtmove', owner: { id: 'r' } })
  await writeJson(nativeGlobal, { mcpServers: {}, autoEnableCodemode: true })
  await fails(
    () => m.commitNativeMcpImport({ host, token: tgtPreview.token, owner: { id: 'r' } }),
    'target_changed',
    '并发变化：原生配置在预览后被改动时拒绝提交'
  )

  /* ----------------------------------------------------------- 写失败与部分状态 */

  await writeJson(nativeGlobal, { mcpServers: {} })
  await writeJson(hostConfigFile, { servers: [{ id: 'wfail', transport: 'stdio', command: 'node' }] })
  const failPreview = await m.prepareNativeMcpImport({ host, serverId: 'wfail', owner: { id: 'r' } })
  const failResult = await m.commitNativeMcpImport({
    host: {
      ...host,
      writeText: async (path, text) => {
        if (path === nativeGlobal) throw new Error('fixture write failure')
        await writeFile(path, text)
      }
    },
    token: failPreview.token,
    owner: { id: 'r' }
  })
  ok(
    !failResult.ok && !failResult.nativeWritten && failResult.steps.nativeWrite === 'failed',
    '写失败：如实回报未写入原生',
    failResult.notice
  )
  const hostAfterFail = await readJson(hostConfigFile)
  ok(hostAfterFail.servers[0].enabled === undefined && !hostAfterFail.servers[0].migratedToNative, '写失败：旧条目不动')

  await writeJson(hostConfigFile, { servers: [{ id: 'vfail', transport: 'stdio', command: 'node' }] })
  const vfailPreview = await m.prepareNativeMcpImport({ host, serverId: 'vfail', owner: { id: 'r' } })
  const vfailResult = await m.commitNativeMcpImport({
    host: { ...host, verify: async () => ({ ok: false, detail: '连接超时' }) },
    token: vfailPreview.token,
    owner: { id: 'r' }
  })
  ok(
    vfailResult.nativeWritten && !vfailResult.deactivated && vfailResult.steps.verify === 'failed',
    '校验失败：原生写入但不停用旧条目',
    vfailResult.notice
  )
  ok((await readJson(hostConfigFile)).servers[0].enabled === undefined, '校验失败：旧条目仍启用')

  await writeJson(hostConfigFile, { servers: [{ id: 'vnone', transport: 'stdio', command: 'node' }] })
  const vnonePreview = await m.prepareNativeMcpImport({ host, serverId: 'vnone', owner: { id: 'r' } })
  const vnoneResult = await m.commitNativeMcpImport({ host, token: vnonePreview.token, owner: { id: 'r' } })
  ok(
    vnoneResult.nativeWritten && !vnoneResult.deactivated && vnoneResult.verification === 'unavailable' &&
      vnoneResult.notice.includes('主会话'),
    '未接线校验：标记为需主会话补齐，不假装通过、不停用旧条目',
    vnoneResult.notice
  )

  /* -------------------------------------------------- 身份绑定与外部改动保护 */

  await writeJson(hostConfigFile, { servers: [{ id: 'omis', transport: 'stdio', command: 'node' }] })
  const ownerPreview = await m.prepareNativeMcpImport({ host, serverId: 'omis', owner: { id: 'owner-a' } })
  await fails(
    () => m.commitNativeMcpImport({ host, token: ownerPreview.token, owner: { id: 'owner-b' } }),
    'token_owner_mismatch',
    '身份：令牌绑定调用者，换身份被拒'
  )
  const ownerRetry = await m.commitNativeMcpImport({
    host: { ...host, verify: async () => ({ ok: true }) },
    token: ownerPreview.token,
    owner: { id: 'owner-a' }
  })
  ok(ownerRetry.ok, '身份：归属正确时同一令牌仍可提交')

  await writeJson(hostConfigFile, { servers: [{ id: 'extchg', transport: 'stdio', command: 'node' }] })
  const extPreview = await m.prepareNativeMcpImport({ host, serverId: 'extchg', owner: { id: 'r' } })
  const extResult = await m.commitNativeMcpImport({
    host: {
      ...host,
      verify: async () => {
        const doc = await readJson(hostConfigFile)
        doc.servers.push({ id: 'external-added', transport: 'stdio', command: 'node' })
        await writeJson(hostConfigFile, doc)
        return { ok: true }
      }
    },
    token: extPreview.token,
    owner: { id: 'r' }
  })
  ok(
    extResult.nativeWritten && !extResult.deactivated && extResult.steps.hostDisable === 'skipped-external-change',
    '外部改动：校验期间旧配置被改时不覆盖、不停用',
    extResult.notice
  )
  const hostAfterExternal = await readJson(hostConfigFile)
  ok(
    hostAfterExternal.servers.some((entry) => entry.id === 'external-added') &&
      hostAfterExternal.servers.find((entry) => entry.id === 'extchg').enabled === undefined,
    '外部改动：外部新增条目与旧条目的启用状态都保留'
  )

  /* ------------------------------------------------------- 数组形式的旧配置 */

  await writeFile(hostConfigFile, JSON.stringify([{ id: 'arr', transport: 'stdio', command: 'node', extra: 1 }]))
  const arrPreview = await m.prepareNativeMcpImport({ host, serverId: 'arr', owner: { id: 'r' } })
  const arrResult = await m.commitNativeMcpImport({
    host: { ...host, verify: async () => ({ ok: true }) },
    token: arrPreview.token,
    owner: { id: 'r' }
  })
  ok(arrResult.deactivated, '数组形式：裸数组旧配置也能停用迁移')
  const arrHost = JSON.parse(await readFile(hostConfigFile, 'utf8'))
  ok(
    Array.isArray(arrHost) && arrHost[0].enabled === false && arrHost[0].extra === 1 && arrHost[0].migratedToNative,
    '数组形式：未知字段保留，形状不变'
  )

  /* -------------------------------------- 解析错误 / null / 项目变化 / 并发 / 上限 */

  await writeFile(
    hostConfigFile,
    JSON.stringify({ servers: [{ id: 'goodentry', transport: 'stdio', command: 'node' }, { id: 'badentry' }] })
  )
  await fails(
    () => m.prepareNativeMcpImport({ host, serverId: 'goodentry', owner: { id: 'r' } }),
    'host_config_invalid',
    '解析错误：旧源含坏条目时拒绝从部分有效条目继续导入'
  )

  await writeJson(hostConfigFile, { servers: [{ id: 'nulltarget', transport: 'stdio', command: 'node' }] })
  await writeFile(nativeGlobal, 'null')
  await fails(
    () => m.prepareNativeMcpImport({ host, serverId: 'nulltarget', owner: { id: 'r' } }),
    'target_shape',
    '坏配置：目标文件解析为 JSON null 时拒绝覆盖'
  )
  ok((await readFile(nativeGlobal, 'utf8')) === 'null', '坏配置：拒绝后原文件未被改写')

  await writeFile(nativeGlobal, JSON.stringify({ mcpServers: {} }))
  await writeJson(hostConfigFile, {
    servers: [{ id: 'projmove', transport: 'http', url: 'https://x.test/mcp', projectScope: 'p-main' }]
  })
  const projPreview = await m.prepareNativeMcpImport({ host, serverId: 'projmove', owner: { id: 'r' } })
  await fails(
    () =>
      m.commitNativeMcpImport({
        host: { ...host, projects: [{ id: 'p-main', cwd: join(root, 'other-project') }] },
        token: projPreview.token,
        owner: { id: 'r' }
      }),
    'project_changed',
    '项目变化：项目目录改变后拒绝提交'
  )
  await writeJson(hostConfigFile, {
    servers: [{ id: 'projgone', transport: 'http', url: 'https://x.test/mcp', projectScope: 'p-main' }]
  })
  const gonePreview = await m.prepareNativeMcpImport({ host, serverId: 'projgone', owner: { id: 'r' } })
  await fails(
    () => m.commitNativeMcpImport({ host: { ...host, projects: [] }, token: gonePreview.token, owner: { id: 'r' } }),
    'project_changed',
    '项目变化：项目登记被移除后拒绝提交'
  )

  /* 写入后读取旧源失败：必须返回 nativeWritten:true 的部分结果，而不是裸抛异常。 */
  await writeFile(nativeGlobal, JSON.stringify({ mcpServers: {} }))
  await writeJson(hostConfigFile, { servers: [{ id: 'readfail', transport: 'stdio', command: 'node' }] })
  const readFailPreview = await m.prepareNativeMcpImport({ host, serverId: 'readfail', owner: { id: 'r' } })
  const readFailResult = await m.commitNativeMcpImport({
    host: {
      ...host,
      verify: async () => {
        await rm(hostConfigFile, { force: true })
        await mkdir(hostConfigFile, { recursive: true })
        return { ok: true }
      }
    },
    token: readFailPreview.token,
    owner: { id: 'r' }
  })
  ok(
    readFailResult.nativeWritten &&
      !readFailResult.deactivated &&
      readFailResult.steps.hostDisable === 'failed' &&
      /读取/.test(readFailResult.notice),
    '写入后读取失败：返回 nativeWritten:true 的部分结果而非裸抛',
    readFailResult.notice
  )
  ok((await readJson(nativeGlobal)).mcpServers.readfail.command === 'node', '写入后读取失败：原生配置已落盘')
  await rm(hostConfigFile, { recursive: true, force: true })
  await writeJson(hostConfigFile, { servers: [] })

  /* 校验期间目标文件被外部改动：不停用旧条目。 */
  await writeFile(nativeGlobal, JSON.stringify({ mcpServers: {} }))
  await writeJson(hostConfigFile, { servers: [{ id: 'tgtverify', transport: 'stdio', command: 'node' }] })
  const tgtVerifyPreview = await m.prepareNativeMcpImport({ host, serverId: 'tgtverify', owner: { id: 'r' } })
  const tgtVerifyResult = await m.commitNativeMcpImport({
    host: {
      ...host,
      verify: async () => {
        const doc = await readJson(nativeGlobal)
        doc.externalAdded = true
        await writeJson(nativeGlobal, doc)
        return { ok: true }
      }
    },
    token: tgtVerifyPreview.token,
    owner: { id: 'r' }
  })
  ok(
    tgtVerifyResult.nativeWritten &&
      !tgtVerifyResult.deactivated &&
      tgtVerifyResult.steps.hostDisable === 'skipped-external-change',
    '目标外部改动：校验期间原生配置被改时不停用旧条目',
    tgtVerifyResult.notice
  )
  ok(
    (await readJson(hostConfigFile)).servers.find((entry) => entry.id === 'tgtverify').enabled === undefined,
    '目标外部改动：旧条目仍启用'
  )

  /* 令牌 claim 一次：并发提交同一令牌只有一个成功。 */
  await writeFile(nativeGlobal, JSON.stringify({ mcpServers: {} }))
  await writeJson(hostConfigFile, { servers: [{ id: 'concurrent', transport: 'stdio', command: 'node' }] })
  const concurrentPreview = await m.prepareNativeMcpImport({ host, serverId: 'concurrent', owner: { id: 'r' } })
  const concurrentHost = { ...host, verify: async () => ({ ok: true }) }
  const settled = await Promise.allSettled([
    m.commitNativeMcpImport({ host: concurrentHost, token: concurrentPreview.token, owner: { id: 'r' } }),
    m.commitNativeMcpImport({ host: concurrentHost, token: concurrentPreview.token, owner: { id: 'r' } })
  ])
  const okCount = settled.filter((entry) => entry.status === 'fulfilled' && entry.value.ok === true).length
  const rejectedEntry = settled.find((entry) => entry.status === 'rejected')
  ok(
    okCount === 1 && Boolean(rejectedEntry) && rejectedEntry.reason.code === 'token_invalid',
    '令牌并发：同一令牌只能 claim 一次，另一个被拒',
    settled.map((entry) => (entry.status === 'fulfilled' ? entry.value.ok : entry.reason?.code)).join(',')
  )

  /* A：commit 必须用本次刚写入的完整文本的 SHA256 作为校验指纹传给 verifier。 */
  await writeFile(nativeGlobal, JSON.stringify({ mcpServers: {} }))
  await writeJson(hostConfigFile, { servers: [{ id: 'fppass', transport: 'stdio', command: 'node' }] })
  const fpPreview = await m.prepareNativeMcpImport({ host, serverId: 'fppass', owner: { id: 'r' } })
  let seenFingerprint
  const fpResult = await m.commitNativeMcpImport({
    host: {
      ...host,
      verify: async (input) => {
        seenFingerprint = input.expectedFingerprint
        return { ok: true }
      }
    },
    token: fpPreview.token,
    owner: { id: 'r' }
  })
  ok(
    fpResult.ok && seenFingerprint === createHash('sha256').update(await readFile(nativeGlobal, 'utf8')).digest('hex'),
    'A：commit 用写入内容的 SHA256 作为校验指纹',
    seenFingerprint
  )

  /* 待确认上限：反复 preview 不确认时不能无限增长。 */
  await writeJson(hostConfigFile, { servers: [{ id: 'limit-svc', transport: 'stdio', command: 'node' }] })
  let limitHit
  for (let index = 0; index < 40; index++) {
    try {
      await m.prepareNativeMcpImport({ host, serverId: 'limit-svc', owner: { id: 'r' } })
    } catch (error) {
      limitHit = error
      break
    }
  }
  ok(limitHit && limitHit.code === 'too_many_pending', '待确认上限：超限后拒绝继续 preview', limitHit?.code)

  /* 运行实例身份比对（IPC 提交前重核用的纯函数）。 */
  const identityA = { runnerId: 'r1', generation: 1, cwd: 'C:/a', projectId: null }
  ok(m.sameNativeMcpImportRuntime(identityA, { ...identityA }), '身份比对：相同身份视为同一实例')
  ok(!m.sameNativeMcpImportRuntime(identityA, { ...identityA, runnerId: 'r2' }), '身份比对：换 runner 视为不同实例')
  ok(!m.sameNativeMcpImportRuntime(identityA, { ...identityA, generation: 2 }), '身份比对：代次变化视为不同实例')
  ok(!m.sameNativeMcpImportRuntime(identityA, { ...identityA, cwd: 'C:/b' }), '身份比对：项目目录变化视为不同实例')
  ok(!m.sameNativeMcpImportRuntime(identityA, { ...identityA, projectId: 'p' }), '身份比对：项目身份变化视为不同实例')

  /* atomicWrite：rename 前指纹核对与失败后临时文件清理。 */
  const fp = (text) => createHash('sha256').update(text === null ? '\u0000absent' : text).digest('hex')
  const atomicPath = join(root, 'atomic.json')
  await writeFile(atomicPath, 'original')
  await m.atomicWrite(atomicPath, 'next', fp('original'))
  ok((await readFile(atomicPath, 'utf8')) === 'next', 'atomicWrite：指纹匹配时替换成功')
  await writeFile(atomicPath, 'changed-externally')
  let atomicThrown
  try {
    await m.atomicWrite(atomicPath, 'next2', fp('original'))
  } catch (error) {
    atomicThrown = error
  }
  ok(Boolean(atomicThrown), 'atomicWrite：期望指纹不符时放弃替换')
  ok((await readFile(atomicPath, 'utf8')) === 'changed-externally', 'atomicWrite：指纹不符时目标保持外部内容')
  const leftover = (await readdir(root)).filter((name) => name.startsWith('atomic.json.') && name.endsWith('.tmp'))
  ok(leftover.length === 0, 'atomicWrite：失败后不残留自己的临时文件', leftover.join(','))
  const atomicDir = join(root, 'atomic-dir')
  await mkdir(atomicDir)
  let renameThrown
  try {
    await m.atomicWrite(atomicDir, 'x')
  } catch (error) {
    renameThrown = error
  }
  ok(Boolean(renameThrown), 'atomicWrite：替换目录失败时不静默成功')
  ok((await stat(atomicDir)).isDirectory(), 'atomicWrite：失败后目标目录未被破坏')
  const leftoverDir = (await readdir(root)).filter((name) => name.startsWith('atomic-dir.') && name.endsWith('.tmp'))
  ok(leftoverDir.length === 0, 'atomicWrite：替换失败后不残留临时文件', leftoverDir.join(','))

  console.log(`\n${checks} 项检查通过`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
