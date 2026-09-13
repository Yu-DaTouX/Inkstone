/*
 * 截图用的假数据（在渲染端执行）。
 *
 * 为什么不启 pi 进程：截图只需要「界面长什么样」，真起 pi 会让截图依赖
 * 模型额度、网络和会话目录，且每次内容都不一样（README 的图会漂）。
 * 这里直接往 `window.__yanStore` 注入一份贴近真实编码会话的数据，
 * 数据通路本身由 `npm run test:live` 覆盖。
 *
 * `shots.mjs` 会把本文件读成字符串交给 `executeJavaScript`，
 * 所以这里必须是一个**自求值的 async IIFE**，且不能用反引号/`${}`。
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  for (let i = 0; i < 80 && !window.__yanStore; i++) await sleep(100)
  if (!window.__yanStore) return 'no-store'

  const store = window.__yanStore
  const now = Date.now()

  const model = {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    provider: 'openai-codex',
    reasoning: true,
    contextWindow: 400000
  }

  const settings = {
    cwd: 'C:/work/pi-desktop',
    theme: 'dark',
    lang: 'zh-CN',
    recentCwds: ['C:/work/pi-desktop'],
    projectNames: {},
    providerBudgets: {},
    rightPanelOpen: true,
    alwaysOnTop: false,
    uiScale: 0,
    profile: { name: '砚', avatarKind: 'letter', avatarValue: '砚', avatarHue: 198, signedIn: false },
    railWidth: 296,
    panelWidth: 336,
    toolOrder: [],
    toolHidden: [],
    toolHeights: {},
    toolDetail: false,
    streamWidth: 940,
    autonomous: false,
    sound: { enabled: false, volume: 0.4, notifications: true, events: { done: true, question: true, error: true } }
  }

  const sessions = [
    {
      id: 's1',
      path: 'C:/Users/x/.pi/agent/sessions/proj/s1.jsonl',
      cwd: 'C:/work/pi-desktop',
      title: '右栏把手改成可拖拽 + 落盘',
      named: false,
      createdAt: now - 86400000 * 2,
      updatedAt: now - 120000,
      messageCount: 24,
      model: 'GPT-6 Astra'
    },
    {
      id: 's2',
      path: 'C:/Users/x/.pi/agent/sessions/proj/s2.jsonl',
      cwd: 'C:/work/pi-desktop',
      title: '内置浏览器接入本机 Chrome',
      named: true,
      parentSession: 's1',
      branchOrigin: '把右栏分区的拖拽把手做成能直接拖的',
      createdAt: now - 86400000,
      updatedAt: now - 3600000,
      messageCount: 41,
      model: 'GPT-6 Astra'
    },
    {
      id: 's3',
      path: 'C:/Users/x/.pi/agent/sessions/proj/s3.jsonl',
      cwd: 'C:/work/pi-desktop',
      title: '供应商额度面板：分窗口进度条',
      named: false,
      createdAt: now - 172800000,
      updatedAt: now - 7200000,
      messageCount: 18,
      model: 'deepseek-v4.1-flash'
    },
    {
      id: 's4',
      path: 'C:/Users/x/.pi/agent/sessions/proj/s4.jsonl',
      cwd: 'C:/work/pi-desktop',
      title: '任务历史跳回对应回合',
      named: false,
      createdAt: now - 259200000,
      updatedAt: now - 10800000,
      messageCount: 33,
      model: 'GPT-6 Astra'
    }
  ]

  const messages = [
    {
      id: 'u1',
      role: 'user',
      text: '把右栏分区的拖拽把手做成能直接拖的，拖完记得落盘。',
      timestamp: now - 300000
    },
    {
      id: 'a1',
      role: 'assistant',
      thinking:
        '先定位现在把手是怎么渲染的：RightPanel 里的 rp-grip，按下后走 moveSection。' +
        '要改成 pointer 拖拽并实时预览插入位置，落盘走 setSettings 的 toolOrder。',
      thinkingMs: 4200,
      thinkingLive: false,
      text: '我先看一眼现在的实现，然后把手势和落盘一起改掉。',
      model: 'GPT-6 Astra',
      usage: { input: 8200, output: 610, cacheRead: 5200, cacheWrite: 0, totalTokens: 8810, cost: 0.004 },
      toolCalls: [
        {
          id: 't1',
          name: 'read',
          args: { path: 'src/renderer/src/components/toolbar/RightPanel.tsx' },
          status: 'ok',
          output: "  1  import { useState } from 'react'\n  2  import { useStore } from '../../state/store'\n ...\n 88  <span className=\"rp-grip\" />",
          startedAt: now - 298000,
          endedAt: now - 297500
        },
        {
          id: 't2',
          name: 'edit',
          args: { path: 'src/renderer/src/components/toolbar/RightPanel.tsx' },
          status: 'ok',
          output: '已应用 3 处改动（+46 −12）',
          startedAt: now - 297000,
          endedAt: now - 296000
        }
      ],
      speed: 42,
      elapsedMs: 31200,
      timestamp: now - 296000
    },
    {
      id: 'u2',
      role: 'user',
      text: '顺手把工具调用详情做成一个能调大小的终端窗口，然后跑一遍检查。',
      timestamp: now - 180000
    },
    {
      id: 'a2',
      role: 'assistant',
      thinking:
        '终端窗口要同时满足两个诉求：像终端、又能调大小。' +
        '结构上分三层：标题栏（三个窗口灯作装饰 + 脉冲图标 + 工具名，右侧是状态胶囊“运行中 / ✓ ok / ✕ error”、耗时、复制、展开）、' +
        'prompt 行（`$ 命令` 或 `> 工具名`）、输出区（等宽、可滚、长命令不折行）。' +
        '调大小用三个把手：下边缘调高度、右边缘调宽度、右下角同时调；把手是 role="separator"，' +
        '键盘 ↑↓/←→ 每次 24px（Shift 96px），双击或 Home 复位。' +
        '尺寸写 localStorage，所有终端共用上次调好的值。' +
        '还要确认 ToolRow 里**正在运行**的调用会自动展开，结束的保持一行——否则“终端窗口”就只是个摆设。',
      thinkingMs: 2600,
      thinkingLive: false,
      text:
        '终端窗口接上了：**正在运行**的调用会自动展开，结束的保持一行——点开才看详情。' +
        '下边缘调高度、右边缘调宽度、右下角一起调，双击把手或按 Home 复位。现在跑一遍检查。',
      model: 'GPT-6 Astra',
      usage: { input: 12400, output: 820, cacheRead: 9000, cacheWrite: 120, totalTokens: 13340, cost: 0.007 },
      toolCalls: [
        {
          id: 't3',
          name: 'bash',
          args: { command: 'npm run check' },
          status: 'running',
          output:
            '> yan-desktop@0.1.0 check\n> tsc --noEmit -p tsconfig.node.json\n> tsc --noEmit -p tsconfig.web.json\n> node scripts/lint-css.mjs\n\n✓ 全部合规（检查了 10 个文件）\n> node scripts/test-unit.mjs\n181/181 通过',
          startedAt: now - 4000
        }
      ],
      speed: 46,
      elapsedMs: 12400,
      timestamp: now - 170000
    }
  ]

  store.setState({
    conn: 'ready',
    connDetail: undefined,
    piInfo: { bin: 'resources/pi-runtime/dist/cli.js', version: '1.2.3', source: 'bundled', bundled: true, bundledAvailable: true },
    models: [model],
    settings,
    sessions,
    session: {
      sessionId: 's1',
      sessionFile: 'C:/Users/x/.pi/agent/sessions/proj/s1.jsonl',
      sessionName: '右栏把手改成可拖拽 + 落盘',
      model,
      isStreaming: true,
      isAgentRunning: true,
      isCompacting: false,
      messageCount: messages.length,
      pendingMessageCount: 0,
      cwd: 'C:/work/pi-desktop',
      autoCompactionEnabled: true,
      thinkingLevel: 'max',
      availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    },
    stats: {
      tokens: { input: 20600, output: 1430, cacheRead: 14200, cacheWrite: 120, total: 36230 },
      cost: 0.011,
      contextUsage: { tokens: 36230, contextWindow: 400000, percent: 9.1 },
      toolCalls: 3,
      userMessages: 2,
      assistantMessages: 2
    },
    todos: [
      { text: '把右栏把手改成可拖拽', done: true },
      { text: '补上 toolOrder 落盘', done: true },
      { text: '工具详情改成终端窗口', done: false },
      { text: '跑一遍完整检查', done: false }
    ],
    todoHistory: [
      {
        id: 'h1',
        round: 1,
        todos: [
          { text: '把右栏把手改成可拖拽', done: true },
          { text: '补上 toolOrder 落盘', done: true }
        ]
      }
    ],
    widgets: {},
    notices: [],
    statuses: {}
  })

  store.getState().applyPush({ ch: 'sync', payload: messages })

  await sleep(400)
  return 'ok'
})()
