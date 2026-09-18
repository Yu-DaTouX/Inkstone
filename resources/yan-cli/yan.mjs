#!/usr/bin/env node
/**
 * `yan` — 砚宿主能力 CLI（随包分发）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它在架构里的位置
 * ══════════════════════════════════════════════════════════════════
 * 模型只有 pi 的基础工具（read / bash / …）。砚的能力**不注册成模型工具**，
 * 而是通过这个 CLI 触达：模型在 bash 里调 `yan <组> <动作>`，
 * 宿主（Electron 主进程）执行后把结果落成文件，stdout 只回一段**受限摘要**。
 *
 * ```
 *   模型 ──bash──▶ yan capabilities search --query-file q.json
 *                        │
 *                        ├─ POST http://127.0.0.1:<随机端口>/rpc
 *                        │    Authorization: Bearer <一次性 token>
 *                        │    { apiVersion, command, params, sessionId, projectId }
 *                        │
 *                        ▼
 *                   宿主能力服务（身份校验 → 执行 → 结果落文件）
 *                        │
 *                        ▼
 *                 { ok, operationId, summary, resultFile }  ← 只有这段进上下文
 * ```
 *
 * ── 为什么身份从环境变量来、而不是命令行参数 ──
 *   命令行参数会出现在进程列表里，也会被模型/用户看见；
 *   环境变量由宿主注入 pi 子进程，模型看不到，也无法伪造别的会话。
 *   宿主侧仍会拿它和绑定的 (sessionId, projectId) 逐一比对 —— 环境变量只是传递，
 *   **信任在宿主**（见 src/main/capability-server.ts）。
 *
 * ── 为什么参数用文件 ──
 *   `--query-file` / `--request-file` 收 UTF-8 JSON 文件路径。
 *   这样模型不用在 shell 里拼 JSON（转义 / 注入 / 引号地狱），
 *   大参数也不会撞命令行长度限制。
 *
 * ── 边界 ──
 *   本文件**不 import pi 的任何模块**、不注册工具、不写 pi 的设置。
 *   它只做三件事：读环境里的身份、发一个 HTTP 请求、把摘要打到 stdout。
 */

import { readFileSync } from 'node:fs'

const API_VERSION = 1

/** 退出码：区分「用法错」与「宿主/业务拒绝」，脚本才好据以分支。 */
const EXIT = { ok: 0, failed: 1, usage: 2, unavailable: 3 }

const USAGE = `yan — 砚宿主能力 CLI

用法：
  yan <组> <动作> [选项]

常用：
  yan operations status --id <操作ID>
  yan capabilities search --query-file query.json [--scope available]
  yan capabilities discover --query-file query.json
  yan capabilities prepare --candidate <ID>
  yan capabilities acquire --plan <ID>
  yan skill read --id <技能ID>
  yan mcp describe --server <ID> --tool <名称>
  yan mcp call --request-file request.json
  yan tasks apply --request-file task-update.json
  yan knowledge search --query-file query.json
  yan browser <动作> [选项]     内置浏览器（yan browser --help 看全部动作）

选项：
  --query-file <文件>      UTF-8 JSON，作为请求参数（推荐，避免 shell 转义）
  --request-file <文件>    同上，用于写操作
  --output <文件>          把结果另存一份到指定路径
  --help                   显示本帮助

说明：
  身份（会话 / 项目）由宿主通过环境变量注入，**不需要也不应该手工指定**。
  stdout 只回一段受限摘要；完整结果在 resultFile 指向的文件里，用 read/grep 取需要的片段。
  「tasks apply」的回执里有 operationId：要重试同一次提交时把它一起传回来
  （同一个 operationId 只会生效一次，不会重复添加）。
`

/**
 * 分组的详细用法（`yan <组> --help`）。
 *
 * 为什么单独一份而不是把全部动作堆在主用法里：主用法是模型**每轮都可能看到**的
 * 一段文字，浏览器的 19 个动作列进去就不叫「摘要」了；按需读才不占上下文。
 * 这份表与 `src/main/capability-server.ts` 的 `KNOWN_COMMANDS`、
 * `src/main/agent.ts` 的 `runBrowserCommand` 三处必须一致。
 */
const GROUP_USAGE = {
  browser: `yan browser <动作> [选项]

动作（结果都落成 JSON 文件；stdout 只回一段摘要）：
  navigate --url <地址>          打开 http(s) 页面（about:blank 也可以）
  open     --url <地址>          navigate 的别名
  state                          当前状态：是否打开 / 标签列表 / 活动标签
  observe                        观察当前页面：URL / 标题 / 可交互元素 ref / 可见文本
  click    --ref <ref>           点击一个元素（ref 来自 observe）
  type     --ref <ref> --text <文本>
  press    --key <键>            Enter / Tab / Escape / ArrowDown …
  scroll   --delta-y <像素> [--delta-x <像素>]
  back / forward / reload        历史与刷新
  new-tab  [--url <地址>]        新标签页
  switch-tab  --id <标签id>      切到某个标签（id 从 state 里取）
  close-tab   [--id <标签id>]    关闭标签
  screenshot                     截图（PNG 落盘，摘要里给路径，用 read 看图）
  download                       最近一次完成的下载
  request-user-control [--reason <原因>]
                                 暂停自动化，交给用户处理密码 / 验证码 / 支付
  connect-chrome [--url <地址>]  接入本机已安装的 Chrome（需要登录态时用）
  disconnect-chrome              断开并关闭砚启动的那个 Chrome

说明：
  · 浏览器还没打开时，除 navigate / open 外的动作回 code=browser_not_open；
  · 元素 ref 会随页面变化失效（报 STALE_ELEMENT 之类）→ 重新 observe 一次再点；
  · 不提供「执行任意页面 JavaScript」的入口（那是被有意关掉的）。
`
}

function fail(code, message, extra) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...(extra ?? {}) }) + '\n')
  process.exit(code)
}

/* -------------------------------------------------------------- 参数解析 */

/**
 * 每个分组的已知动作与必填参数。
 *
 * ── 为什么要在这里再列一份 ──
 *   这里不是权限表（能不能跑由宿主的 `KNOWN_COMMANDS` 决定），目的只有一个：
 *   把**打错的子命令 / 漏掉的参数**变成人（和模型）一眼能改的提示，
 *   而不是一次往返后收到 `unknown_command` 这类接线语。
 *   `--request-file` 可以绕开这层（参数在文件里），所以宿主侧**仍然**要自己校验 ——
 *   两道都要有，不能只留一道。
 *
 * 表中的动作必须与 `src/main/capability-server.ts` 的登记、
 * `src/main/agent.ts` 的 `runBrowserCommand` 一一对应。
 */
const GROUP_SPECS = {
  browser: {
    actions: [
      'navigate',
      'open',
      'state',
      'observe',
      'click',
      'type',
      'press',
      'scroll',
      'back',
      'forward',
      'reload',
      'new-tab',
      'switch-tab',
      'close-tab',
      'screenshot',
      'download',
      'request-user-control',
      'connect-chrome',
      'disconnect-chrome'
    ],
    /* 这里只列「缺了完全无法解释意图」的参数；其余交给宿主报业务错误 */
    required: {
      navigate: ['url'],
      open: ['url'],
      click: ['ref'],
      type: ['ref', 'text'],
      press: ['key'],
      scroll: ['delta-y'],
      'switch-tab': ['id']
    }
  }
}

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') flags.help = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next
          i++
        } else flags[a.slice(2)] = true
      }
    } else positional.push(a)
  }
  return { flags, positional }
}

function readJsonFile(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    fail(EXIT.usage, `${label} 读不到：${path}`, { detail: String(err?.message ?? err) })
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    fail(EXIT.usage, `${label} 不是合法 JSON：${path}`, { detail: String(err?.message ?? err) })
  }
}

/* ------------------------------------------------------------ 主流程 */

const { flags, positional } = parseArgs(process.argv.slice(2))

if (flags.help || positional.length === 0) {
  /* `yan <组> --help`：给出这一组的用法（按需读，不把全部动作堆进主用法） */
  if (flags.help && positional.length === 1 && GROUP_USAGE[positional[0]]) {
    process.stdout.write(GROUP_USAGE[positional[0]])
    process.exit(EXIT.ok)
  }
  process.stdout.write(USAGE)
  process.exit(positional.length === 0 && !flags.help ? EXIT.usage : EXIT.ok)
}

if (positional.length < 2) {
  fail(EXIT.usage, '命令要写成「组 动作」两段，例如 capabilities search。用 --help 看全部。')
}

/*
 * 本地校验一律在**身份检查之前**：
 * 「拼错了子命令」「漏了参数」跟你在不在会话里无关，
 * 而这两句提示是模型/人第一眼要看到的东西。
 */
const command = `${positional[0]}.${positional[1]}`
const groupSpec = GROUP_SPECS[positional[0]]

/* 参数：优先用参数文件，其余 flag 原样带上（如 --scope available）。 */
let params = {}
if (typeof flags['query-file'] === 'string') params = readJsonFile(flags['query-file'], '参数文件')
else if (typeof flags['request-file'] === 'string')
  params = readJsonFile(flags['request-file'], '请求文件')
else {
  for (const [k, v] of Object.entries(flags)) {
    if (k === 'output' || k === 'help') continue
    params[k] = v
  }
}

if (groupSpec && !groupSpec.actions.includes(positional[1])) {
  fail(EXIT.usage, `未知的 ${positional[0]} 子命令：${positional[1]}`, {
    detail: `可用：${groupSpec.actions.join(' / ')}（或 yan ${positional[0]} --help）`
  })
}

/*
 * 必填参数检查放在**参数成型之后**：`--query-file` / `--request-file`
 * 把参数放在文件里，只看 flag 会误报「缺参数」。
 * 宿主侧仍会自己校验一次（它不能假定请求来自本 CLI）。
 */
if (groupSpec?.required?.[positional[1]]) {
  const missing = groupSpec.required[positional[1]].filter((key) => {
    const value = params[key]
    return value === undefined || value === '' || value === true
  })
  if (missing.length) {
    fail(
      EXIT.usage,
      `${positional[0]} ${positional[1]} 缺少参数：${missing.map((k) => `--${k}`).join(' ')}`,
      { detail: `用 yan ${positional[0]} --help 看用法` }
    )
  }
}

/** 身份只来自宿主注入的环境变量。 */
const url = process.env.YAN_CLI_URL
const token = process.env.YAN_CLI_TOKEN
const sessionId = process.env.YAN_SESSION_ID
const projectId = process.env.YAN_PROJECT_ID

if (!url || !token || !sessionId || !projectId) {
  fail(EXIT.unavailable, '宿主能力服务不可用', {
    detail:
      '缺少 YAN_CLI_URL / YAN_CLI_TOKEN / YAN_SESSION_ID / YAN_PROJECT_ID。' +
      '这通常意味着 yan 不是在砚启动的会话里运行的。'
  })
}

let response
try {
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ apiVersion: API_VERSION, command, params, sessionId, projectId })
  })
} catch (err) {
  fail(EXIT.unavailable, '连不上宿主能力服务', { detail: String(err?.message ?? err) })
}

const text = await response.text()
let payload
try {
  payload = JSON.parse(text)
} catch {
  fail(EXIT.failed, `宿主返回了非 JSON 响应（HTTP ${response.status}）`, {
    detail: text.slice(0, 300)
  })
}

/*
 * --output：宿主已经把完整结果落盘，这里只是**另存一份到模型指定的位置**。
 * 读写都在 CLI 进程里完成，宿主不参与路径决策。
 */
if (payload?.ok && typeof flags.output === 'string' && typeof payload.resultFile === 'string') {
  try {
    const { copyFileSync } = await import('node:fs')
    copyFileSync(payload.resultFile, flags.output)
    payload.copiedTo = flags.output
  } catch (err) {
    payload.copyError = String(err?.message ?? err)
  }
}

/* stdout 只回受限摘要：完整内容在 resultFile 里，让模型按需去读片段。 */
process.stdout.write(JSON.stringify(payload) + '\n')
process.exit(payload?.ok ? EXIT.ok : EXIT.failed)
