#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-agent-commands-'))
process.env.YAN_DATA_DIR = join(root, 'data')
const project = join(root, 'project')
await mkdir(project, { recursive: true })
const source = (path) => resolve(path).replace(/\\/g, '/')
const entry = join(root, 'entry.ts')
await writeFile(entry, [
  `export * from '${source('src/main/agent-commands/danger-confirm.ts')}'`,
  `export * from '${source('src/main/agent-commands/file-trash.ts')}'`,
  `export * from '${source('src/main/agent-commands/session-move.ts')}'`,
  `export * from '${source('src/main/agent-commands/artifact-export.ts')}'`,
  `export * from '${source('src/main/agent-commands/skill-save.ts')}'`,
  `export { CapabilityCommandError } from '${source('src/main/capability-server.ts')}'`
].join('\n'))
const electronStub = {
  name: 'electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js',
      contents: [
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(String(value)), decryptString: value => Buffer.from(value).toString() }'
      ].join('\n')
    }))
  }
}

const rejects = async (work) => {
  try {
    await work
  } catch (error) {
    return error
  }
  return null
}

try {
  await runSuite(import.meta.url, async (ok, compile) => {
    const mod = await compile(entry, { plugins: [electronStub] })

    const dangerHost = (options = {}) => {
      const asked = []
      return {
        asked,
        cwd: () => project,
        permissionMode: async () => options.mode ?? 'danger',
        confirmDanger: async (request) => {
          asked.push(request)
          return options.answer === undefined ? { decision: 'allow' } : options.answer
        },
        approvalOwner: () => ({ instanceId: 'fixture', generation: 2 })
      }
    }

    {
      const host = dangerHost({ mode: 'all' })
      const result = await mod.runDangerConfirmCommand(host, { tool: 'bash', detail: 'rm -rf x' })
      ok(result.summary.allowed === true && result.summary.decision === 'auto' && host.asked.length === 0, '「不受限制」档不弹审批')
    }

    {
      const host = dangerHost()
      const result = await mod.runDangerConfirmCommand(host, { tool: 'bash', detail: 'x'.repeat(20_001) })
      ok(result.summary.allowed === false && result.summary.decision === 'no-answer' && host.asked.length === 0, '超长审批内容直接拒绝，不弹不完整的审批')
    }

    {
      const host = dangerHost({ answer: { decision: 'deny', feedback: '换个目录' } })
      const reasons = Array.from({ length: 70 }, (_, i) => `reason-${i}`)
      const outsideDirs = ['C:/a', 'x'.repeat(600)]
      const result = await mod.runDangerConfirmCommand(host, { tool: 'a'.repeat(60), detail: 'write', reasons, outsideDirs, kind: 'delete', toolCallId: 'call-1' })
      const request = host.asked[0]
      ok(request.tool.length === 40 && request.cwd === project && request.owner.instanceId === 'fixture' && request.owner.generation === 2, '审批请求带上截断后的工具名、项目目录与归属')
      ok(request.reasons.length === 64 && request.reasons[62] === 'reason-62' && request.reasons.at(-1).includes('7'), '原因过多时折叠并注明未列出的数量')
      ok(request.outsideDirs[1].length === 500 && request.outsideTruncated === true && request.kind === 'delete' && request.toolCallId === 'call-1', '目录外路径截断并标记，kind 与 toolCallId 透传')
      ok(result.summary.allowed === false && result.summary.decision === 'deny' && result.summary.feedback === '换个目录' && result.data.decision === 'deny', '拒绝结果带回用户反馈')
    }

    {
      const host = dangerHost({ answer: null })
      const result = await mod.runDangerConfirmCommand(host, { detail: 'write' })
      ok(result.summary.tool === 'tool' && result.summary.decision === 'no-answer' && result.summary.allowed === false, '没有审批通道时按未回答处理')
    }

    {
      const moved = []
      const host = { ...dangerHost({ mode: 'all' }), trashItem: () => async (path) => { moved.push(path) } }
      ok((await rejects(mod.runFileTrashCommand({ ...host, trashItem: () => undefined }, { path: 'a.txt' })))?.code === 'trash_unavailable', '宿主未注入回收站时拒绝')
      ok((await rejects(mod.runFileTrashCommand(host, { path: '  ' })))?.code === 'trash_path_required', '缺少路径时拒绝')
      ok((await rejects(mod.runFileTrashCommand(host, { paths: Array.from({ length: 201 }, (_, i) => `f${i}`) })))?.code === 'trash_too_many', '一次超过 200 个路径时拒绝')
      await writeFile(join(project, 'a.txt'), 'a')
      const result = await mod.runFileTrashCommand(host, { path: 'a.txt', paths: [homedir(), 'missing.txt'] })
      ok(JSON.stringify(moved) === JSON.stringify([join(project, 'a.txt')]), '相对路径按项目目录解析并移入回收站')
      ok(result.summary.trashed === 1 && result.summary.failed === 2 && result.data.failed.some((item) => item.path === resolve(homedir())), '家目录与不存在的路径记为失败，不移动')
    }

    {
      const calls = []
      const host = {
        cwd: () => project,
        session: () => ({ sessionId: 's1', sessionFile: join(project, 's1.jsonl') }),
        sessionMover: () => async (request) => { calls.push(request); return { decision: 'approved', message: 'ok' } }
      }
      ok((await rejects(mod.runSessionMoveCommand(host, {})))?.code === 'session_move_dir_required', '缺少目标目录时拒绝')
      ok((await rejects(mod.runSessionMoveCommand({ ...host, sessionMover: () => undefined }, { dir: 'D:/next' })))?.code === 'session_move_unavailable', '宿主未注入移动入口时拒绝')
      ok((await rejects(mod.runSessionMoveCommand({ ...host, session: () => ({ sessionId: 's1' }) }, { dir: 'D:/next' })))?.code === 'session_move_unsaved', '会话未落盘时拒绝')
      const result = await mod.runSessionMoveCommand(host, { dir: '  D:/next  ', reason: ' 整理 ' })
      ok(calls.length === 1 && calls[0].dir === 'D:/next' && calls[0].reason === '整理' && calls[0].cwd === project && calls[0].sessionId === 's1', '移动请求带上目录、原因、当前目录与会话身份')
      ok(result.summary.allowed === true && result.summary.target === 'D:/next' && !('feedback' in result.summary), '同意后的结果以请求目录为目标')
      const denied = await mod.runSessionMoveCommand({ ...host, sessionMover: () => async () => ({ decision: 'denied', target: 'E:/x', feedback: '别动', message: '用户拒绝' }) }, { dir: 'D:/next' })
      ok(denied.summary.allowed === false && denied.summary.target === 'E:/x' && denied.summary.feedback === '别动' && denied.summary.message === '用户拒绝', '拒绝结果带回反馈与说明')
    }

    {
      const exported = []
      const video = async (htmlPath, cwd, request) => {
        exported.push({ htmlPath, cwd, request })
        return { path: request.outPath ?? join(cwd, 'out.mp4'), frames: 30, fps: 30, width: 640, height: 360, duration: 1, bytes: 10, elapsedMs: 5 }
      }
      ok((await rejects(mod.runArtifactExportVideoCommand(project, video, {})))?.code === 'artifact_path_missing', '导出视频缺少路径时拒绝')
      ok((await rejects(mod.runArtifactExportVideoCommand(project, video, { path: 'a.png' })))?.code === 'artifact_export_type', '导出视频只接受 HTML')
      ok((await rejects(mod.runArtifactExportVideoCommand(project, undefined, { path: 'a.html' })))?.code === 'artifact_export_unavailable', '没有导出能力时拒绝')
      ok((await rejects(mod.runArtifactExportVideoCommand(project, video, { path: 'a.html', fps: '0' })))?.code === 'artifact_export_fps', '帧率必须大于 0')
      ok((await rejects(mod.runArtifactExportVideoCommand(project, video, { path: 'a.html', out: join(root, 'elsewhere', 'x.mp4') })))?.code === 'artifact_export_out', '输出不能写到项目外')
      const result = await mod.runArtifactExportVideoCommand(project, video, { path: 'a.html', out: 'clips/demo', fps: 24 })
      ok(exported.at(-1).htmlPath === join(project, 'a.html') && exported.at(-1).request.outPath === join(project, 'clips', 'demo.mp4') && exported.at(-1).request.fps === 24, '相对路径按项目解析，输出补上 .mp4')
      ok(result.summary.size === '640x360' && result.summary.frames === 30, '视频导出摘要包含尺寸与帧数')
      const failing = async () => { throw Object.assign(new Error('no ffmpeg'), { code: 'ffmpeg-missing' }) }
      ok((await rejects(mod.runArtifactExportVideoCommand(project, failing, { path: 'a.html' })))?.code === 'artifact_export_ffmpeg_missing', '导出错误码映射成命令错误码')
    }

    {
      const image = async (htmlPath, cwd, request) => ({ path: request.outPath ?? join(cwd, 'a.png'), width: 100, height: 50, scale: 2, pixelWidth: 200, pixelHeight: 100, target: request.selector ? 'selector' : 'poster', bytes: 9 })
      ok((await rejects(mod.runArtifactExportImageCommand(project, image, { path: 'a.html', width: '-1' })))?.code === 'artifact_export_size', '截图尺寸必须大于 0')
      const poster = await mod.runArtifactExportImageCommand(project, image, { path: 'a.htm', out: 'shots/cover' })
      ok(poster.summary.path === join(project, 'shots', 'cover.png') && poster.summary.pixels === '200x100' && poster.summary.target === 'poster', '截图输出补上 .png 并报告实际像素')
      const selected = await mod.runArtifactExportImageCommand(project, image, { path: 'a.html', selector: ' #card ' })
      ok(selected.summary.target === 'selector', '选择器去掉首尾空白后交给导出')
      const failing = async () => { throw Object.assign(new Error('missing'), { code: 'selector-missing' }) }
      ok((await rejects(mod.runArtifactExportImageCommand(project, failing, { path: 'a.html', selector: '#x' })))?.code === 'artifact_export_selector', '选择器找不到时报专门的错误码')
    }

    {
      const approvals = []
      const host = (answer) => ({
        bundledSkills: () => [join(root, 'bundled', 'artifact', 'SKILL.md')],
        requestApproval: async (request) => { approvals.push(request); return typeof answer === 'function' ? answer(request) : answer }
      })
      const input = { name: 'weekly-report', description: '每周汇报时用', body: '# 周报\n按模板写。' }
      ok((await rejects(mod.runSkillSave(host({ value: 'x' }), { ...input, name: 'artifact' })))?.code === 'skill_reserved_name' && approvals.length === 0, '随包技能名不能占用，且不弹审批')
      const declined = await rejects(mod.runSkillSave(host({ value: '换个名字' }), input))
      ok(declined?.code === 'skill_declined' && declined.message.includes('换个名字') && approvals.length === 1, '用户不同意时带回回复并不保存')
      ok(!existsSync(join(root, 'data', 'skills', 'weekly-report', 'SKILL.md')), '不同意时没有写入技能文件')
      const saved = await mod.runSkillSave(host((request) => ({ value: request.options[0] })), input)
      const file = join(root, 'data', 'skills', 'weekly-report', 'SKILL.md')
      ok(saved.summary.name === 'weekly-report' && saved.summary.replaced === false && existsSync(file) && (await readFile(file, 'utf8')).includes('按模板写'), '同意后保存到我的技能')
      const timedOut = await rejects(mod.runSkillSave(host(async () => { throw new mod.CapabilityCommandError('question_timeout', 'timeout') }), { ...input, replace: true }))
      ok(timedOut?.code === 'skill_declined' && timedOut.message !== 'timeout', '审批超时按未同意处理')
      const broken = new Error('ui closed')
      ok(await rejects(mod.runSkillSave(host(async () => { throw broken }), { ...input, replace: true })) === broken, '其他审批错误原样抛出')
    }
  })
} finally {
  await rm(root, { recursive: true, force: true })
}
