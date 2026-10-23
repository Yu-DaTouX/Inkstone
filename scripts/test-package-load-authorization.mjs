import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runPiPackageSchedulerTests } from './test-pi-package-scheduler.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-package-authorization-'))
let passed = 0
const ok = (value, message, detail) => {
  assert.ok(value, detail ? `${message}: ${detail}` : message)
  passed += 1
}

try {
  const main = await readFile('src/main/index.ts', 'utf8')
  const start = main.indexOf('confirmCapabilityAuthorization: async (')
  const end = main.indexOf('confirmExternalApi: async (', start)
  ok(start >= 0 && end > start, '定位原生授权回调边界')
  const authorization = main.slice(start, end)
  const detailStart = authorization.indexOf('detail: [')
  const detailEnd = authorization.indexOf("].join('\\n')", detailStart)
  ok(detailStart >= 0 && detailEnd > detailStart, '定位原生授权 detail 边界')
  const detail = authorization.slice(detailStart, detailEnd)
  for (const expected of [
    '安装前的临时环境加载验证（smoke）',
    '实际加载候选扩展并执行代码',
    '当前桌面用户权限',
    '可读写该用户的文件并联网',
    '临时目录和清空继承环境不是操作系统沙箱',
    '禁用 npm lifecycle scripts 只关闭安装生命周期脚本',
    '不会阻止扩展代码运行',
    '候选：${request.source}',
    '项目：${request.projectId}',
    '内容指纹：${request.digest}',
    '授权仅绑定此候选 / host 与当前项目'
  ]) {
    ok(detail.includes(expected), `原生授权 detail 包含：${expected}`)
  }
  ok(!detail.includes('安装后的预检') && !detail.includes('Windows 用户'), '原生风险提示不再误报执行时点或限定 Windows')
  ok(/defaultId:\s*0/.test(authorization) && /cancelId:\s*0/.test(authorization), '原生授权默认和取消均选择拒绝')
  const buttons = authorization.slice(authorization.indexOf('const buttons ='), authorization.indexOf('const response ='))
  ok((buttons.match(/\[\s*'拒绝'/g) ?? []).length === 3, '远程、已信任及未信任分支首项均为拒绝')
  ok(/if \(!win \|\| win\.isDestroyed\(\)\) return 'deny'/.test(authorization), '没有有效窗口时拒绝')
  ok(/const choice = response\.response === 2\s*\? 'allow-with-lifecycle-scripts'\s*: response\.response === 1\s*\? 'allow'\s*: 'deny'/.test(authorization), '只有明确允许按钮能够产生授权')

  const acquisition = await readFile('src/main/capabilities/acquisition-commands.ts', 'utf8')
  const grantStart = acquisition.indexOf('let packageGrant =')
  const grantEnd = acquisition.indexOf('if (!packageGrant) {', grantStart)
  ok(grantStart >= 0 && grantEnd > grantStart, '定位精确授权读写边界')
  const grant = acquisition.slice(grantStart, grantEnd)
  ok(/if \(!packageGrant && explicitAuthorize\)/.test(grant), '仅缺少授权且显式请求时弹窗')
  ok(grant.includes('this.host.confirmCapabilityAuthorization()?.({') && grant.includes("}) ?? 'deny'"), '保留原授权端口和缺省拒绝')
  ok(!acquisition.includes('confirmPackageLoadAuthorization'), '没有额外加载风险确认 helper')
  ok(!grant.includes('requestApproval'), '包授权没有第二层确认')
  for (const operation of ['find', 'grant']) {
    ok(new RegExp(`\\.${operation}\\(\\{\\s*candidateId: candidate\\.candidateId,\\s*digest,\\s*projectId: plan\\.projectId`).test(grant), `${operation} 绑定精确候选、指纹和项目`)
  }
  ok(/source: candidate\.candidateId,\s*projectId: plan\.projectId,\s*cwd: this\.host\.cwd\(\),\s*digest/.test(grant), '授权弹窗收到同一候选、项目、目录和指纹')
  ok(/if \(choice !== 'deny'\)\s*\{\s*packageGrant =/.test(grant), '拒绝时不保存授权')
  ok(grant.includes("allowLifecycleScripts: choice === 'allow-with-lifecycle-scripts'"), 'lifecycle 仍需独立明确选择')

  const modules = {}
  for (const [name, entry] of [
    ['service', 'src/main/capabilities/acquisition-service.ts'],
    ['scheduler', 'src/main/capabilities/pi-package-scheduler.ts']
  ]) {
    const outfile = join(root, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm' })
    modules[name] = await import(pathToFileURL(outfile).href)
  }
  await runPiPackageSchedulerTests(ok, {
    AcquisitionService: modules.service.AcquisitionService,
    PiPackageActivationScheduler: modules.scheduler.PiPackageActivationScheduler
  })
  console.log(`PASS ${passed} native authorization source-boundary and scheduler checks`)
} finally {
  await rm(root, { recursive: true, force: true })
}
