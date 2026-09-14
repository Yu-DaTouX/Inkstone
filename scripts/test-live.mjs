/**
 * 真实应用的验收测试（不是对着 mock 测）。
 *
 * 做法：用 `YAN_PROBE=<脚本>` 启动**真正的应用** —— 完整主进程、
 * preload、contextBridge、pi 子进程都在跑 —— 然后在渲染端执行断言。
 *
 * 为什么不在单独的 BrowserWindow 里测：那样 preload/IPC/pi 全都不存在，
 * 断言会「通过」而应用其实是坏的。
 *
 * 用法：
 *   npm run test:live            全部
 *   npm run test:live -- live    只跑 DOM 体检（不烧 token）
 *   npm run test:live -- e2e     发一条真消息（烧 token，约 $0.001）
 *   npm run test:live -- sessions 会话切换 + 新建（不烧 token）
 */
import { spawn } from 'node:child_process'
import vm from 'node:vm'
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  existsSync
} from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * 测试统一使用的模型（会让所有 cost>0 场景真实调模型）。
 *
 * 默认用 **commandcode 的 Ling 3.0 Flash Sante（免费）**：
 *   供应商 provider = commandcode
 *   模型 id        = inclusionai/ling-3.0-flash-sante:free
 * 它成本为 0，适合反复跑回归。个别场景（如 image 要发图）需要视觉模型，
 * 在 CASES 里用 `model:` 单独覆盖。
 *
 * 想用别的模型：`YAN_TEST_MODEL="provider/modelId" npm run test:live -- e2e`。
 * 约束：模型必须能从 **真实 `~/.pi/agent/auth.json`** 取到凭证（测试不隔离 auth）；
 * 写成 `provider/id` 形式，交给 pi 的 `--model` 解析。
 */
const TEST_MODEL = process.env.YAN_TEST_MODEL || 'commandcode/inclusionai/ling-3.0-flash-sante:free'
/** 需要视觉的场景专用（Ling 是纯文本模型，发图会失败） */
const TEST_VISION_MODEL =
  process.env.YAN_TEST_VISION_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash'

/** 每个场景：probe 脚本 + 等待多久（毫秒）+ 可选的预发按键 */
const CASES = {
  // 纯 DOM 体检：溢出 / 令牌 / 图标 / 字体栅格 / 分区渲染
  live: { probe: 'scripts/probe/live.js', delay: 9000, cost: 0 },
  // 推理胶囊：渲染 / 展开 / 折叠 / 无推理不占位（不烧 token，注入数据）
  reasoning: { probe: 'scripts/probe/reasoning.js', delay: 9000, cost: 0 },
  // 全局快捷键：Ctrl+P 换模型 / Shift+Tab 换强度
  // ⚠️ 必须用**真实**按键（sendInputEvent），因为快捷键是主进程
  //    用 before-input-event 拦的 —— 渲染端的合成 KeyboardEvent 不走那条路，
  //    用它测会「通过」而真实按键其实是坏的。
  hotkeys: {
    probe: 'scripts/probe/hotkeys.js',
    delay: 9000,
    cost: 0,
    keys: 'ctrl+shift+p,ctrl+p,shift+tab'
  },
  // 弹窗行为：快捷键让位（真按键）/ 焦点圈定 / Esc / 焦点恢复 / 图标按钮名称
  dialog: {
    probe: 'scripts/probe/dialog.js',
    delay: 20000,
    cost: 0,
    keys: 'shift+tab,shift+tab,shift+tab,shift+tab'
  },
  // 工具调用行：成功摘要 / 失败保留可展开入口（P1 4.2）
  toolrow: { probe: 'scripts/probe/toolrow.js', delay: 10000, cost: 0 },
  // 左栏搜索：入口稳定 / 过滤 / 清空与关闭后的焦点（P1 4.1）
  railsearch: { probe: 'scripts/probe/railsearch.js', delay: 11000, cost: 0 },
  // 性能实测：流式更新 / 面板收放 / 虚拟化窗口（方案 P2 要求先测量）
  perf: { probe: 'scripts/probe/perf.js', delay: 16000, cost: 0 },
  // 增量推送协议：textDelta / thinkingDelta / outputDelta 的拼接与兜底
  deltas: { probe: 'scripts/probe/deltas.js', delay: 12000, cost: 0 },
  // 诊断：grid 容器的行/列是否依赖子元素数量（同类布局 bug 排查）
  layoutdiag: { probe: 'scripts/probe/layoutdiag.js', delay: 12000, cost: 0 },
  // 诊断：长会话虚拟化为什么不渲染（只输出尺寸，不断言）
  virtualdiag: { probe: 'scripts/probe/virtualdiag.js', delay: 14000, cost: 0 },
  // 发送键：规则可选 / 常显 / 生效（Enter 的语义不再随输入框高度隐式变化）
  sendkey: { probe: 'scripts/probe/sendkey.js', delay: 9000, cost: 0 },
  // 动效：入场 / **退场** / 减少动效 / 消息合并
  // 界面缩放：DPI 取整 + 快捷键（带 keys，因为 Ctrl+= 是主进程拦的）
  zoom: {
    probe: 'scripts/probe/zoom.js',
    delay: 7000,
    cost: 0,
    keys: 'ctrl+=,ctrl+=,ctrl+-,ctrl+0'
  },
  // 会话分支树（左栏入口 + 主进程裁剪）
  branch: { probe: 'scripts/probe/branch.js', delay: 10000, cost: 0 },
  // 标题栏两端的面板开关 + 左栏模式菜单（参考 Codex）
  topbar: { probe: 'scripts/probe/topbar.js', delay: 9000, cost: 0 },
  // 导航轨与消息列的对齐（收起/展开时距离必须稳定）
  outlinepos: { probe: 'scripts/probe/outlinepos.js', delay: 9000, cost: 0 },
  // 窄窗口 + 面板收起态（三档宽度都要过 —— 那三个 bug 只在窄窗口暴露）
  narrow: {
    probe: 'scripts/probe/narrow.js',
    delay: 9000,
    cost: 0,
    wins: ['1456x1000', '1002x700', '940x700']
  },
  // 布局宽度扫描（P0-2 取基线用；只测量 + 最小可用宽度断言）
  narrowscan: {
    probe: 'scripts/probe/narrowscan.js',
    delay: 9000,
    cost: 0,
    wins: ['1600x1000', '1280x860', '1100x760', '1000x700', '940x640']
  },
  // 任务模块：进行中就地显示 / 两行截断 / 全部完成自动收起 / 历史折叠 + 跳转
  todonew: { probe: 'scripts/probe/todonew.js', delay: 9000, cost: 0 },
  // 左栏会话重命名（行内输入；回归 Electron 不支持 window.prompt 的坑）
  rename: { probe: 'scripts/probe/rename.js', delay: 9000, cost: 0 },
  // 自主模式开关（在输入栏里 / 落盘）
  autonomous: { probe: 'scripts/probe/autonomous.js', delay: 9000, cost: 0 },
  // 上下文分区：压缩后 tokens=null 的诚实显示 + 花费行对齐
  context: { probe: 'scripts/probe/context.js', delay: 9000, cost: 0 },
  // 排队消息：显示在输入框上方 + 插队按钮接线
  queuestack: { probe: 'scripts/probe/queuestack.js', delay: 9000, cost: 0 },
  // 所有报错都进日志（store.set 包装的回归网）
  logs: { probe: 'scripts/probe/logs.js', delay: 9000, cost: 0 },
  // `/` 斜杠命令：自动重拉 + 常用优先 + Enter/Tab 填充
  slashcmd: { probe: 'scripts/probe/slashcmd.js', delay: 9000, cost: 0 },
  // 分区内容高度可调
  vheight: { probe: 'scripts/probe/vheight.js', delay: 9000, cost: 0 },
  // 从工具库拖到工具栏（含实时位置预览 / 取消语义）
  libdrag: { probe: 'scripts/probe/libdrag.js', delay: 9000, cost: 0 },
  // 工具栏分区排序（拖拽 + 键盘）与工具库（收进库 / 拿回 / 恢复默认）
  tools: { probe: 'scripts/probe/tools.js', delay: 9000, cost: 0 },
  // 面板宽度拖拽（含夹取范围与键盘）
  resize: { probe: 'scripts/probe/resize.js', delay: 9000, cost: 0 },
  // 文件树（工具栏「文件」分区）：懒加载 / 排序 / 缩进 / 点文件插 @路径 / 溢出
  fs: { probe: 'scripts/probe/fs.js', delay: 9000, cost: 0 },
  // 面板与工具栏：开关位置 / 命名 / 用户档案 / 收放
  panels: { probe: 'scripts/probe/panels.js', delay: 9000, cost: 0 },
  // 开关的几何对称性（展开↔收起逐像素对比 + 必须点得到）
  symmetry: { probe: 'scripts/probe/symmetry.js', delay: 9000, cost: 0 },
  motion: { probe: 'scripts/probe/motion.js', delay: 9000, cost: 0 },
  /*
   * 凭证写在**环境变量**里的那条路。
   * 必须单独一个场景，因为环境变量是**主进程启动时**读的，
   * 不能在探针里造 —— 所以用 caseEnv 注入一个假 key。
   */
  authEnv: {
    probe: 'scripts/probe/auth-env.js',
    delay: 9000,
    cost: 0,
    env: { OPENAI_API_KEY: 'sk-probe-dummy-not-a-real-key' }
  },
  // 模型接入（凭证读写）—— ⚠️ 会用 YAN_PI_DIR 隔离，不碰真实 auth.json
  auth: { probe: 'scripts/probe/auth.js', delay: 9000, cost: 0 },
  // @ 文件引用补全（pi 的 @files 用法）
  atPath: { probe: 'scripts/probe/at-path.js', delay: 9000, cost: 0 },
  // 标题栏：置顶按钮位置 + 精简掉的重复入口
  titlebar: { probe: 'scripts/probe/titlebar.js', delay: 9000, cost: 0 },
  // 内置浏览器：工具栏标题旁开关 → 右栏 WebContentsView/CDP → renderer/preload 状态闭环
  browser: { probe: 'scripts/probe/browser.js', delay: 9000, cost: 0 },
  // 接入本机 Chrome（无头 + 隔离 profile，验 CDP 接入链路）
  externalchrome: {
    probe: 'scripts/probe/external-chrome.js',
    delay: 9000,
    cost: 0,
    /*
     * YAN_CHROME_SYNC=0：接入时不从**真实** Chrome 导入历史/cookie。
     * 测试必须保持隔离 —— 否则跑一次探针就把用户的真实浏览历史
     * 拷进临时目录（功能本身没问题，但在测试里不该发生）。
     * 同步逻辑本身由 test:unit 的合成目录用例覆盖。
     */
    env: { YAN_CHROME_HEADLESS: '1', YAN_CHROME_SYNC: '0' }
  },
  // 浅色主题：对比度 / 代码高亮 / 工具行
  light: { probe: 'scripts/probe/light.js', delay: 9000, cost: 0 },
  // 阶段 2 功能：斜杠菜单 / !bash / 图片附件 / 模型选择器 / 开关 / 重命名删除 / 分叉点
  features: { probe: 'scripts/probe/features.js', delay: 9000, cost: 0 },
  // 对话导航轨：间距拉长 + 鼠标靠近动态展开
  outline: { probe: 'scripts/probe/outline.js', delay: 9000, cost: 0 },
  // 布局：用量条合并 / 消息无上下文 / 右栏任务 / 左栏自动隐藏
  layout: { probe: 'scripts/probe/layout.js', delay: 9000, cost: 0 },
  // 用量条（输入/输出/缓存命中/输出速度）—— 会真调模型
  tokens: { probe: 'scripts/probe/tokens.js', delay: 9000, cost: 1 },
  // 记忆搬进设置：右栏移除 / 设置面板 / 输入区状态条
  settings: { probe: 'scripts/probe/settings.js', delay: 9000, cost: 0 },
  // 声音提示（对齐 opencode 的 attention）：事件触发 / 单事件开关 / 音量夹取
  sound: { probe: 'scripts/probe/sound.js', delay: 9000, cost: 0 },
  // 工具调用栏的展开规则（注入合成回合，不烧 token）
  toolgroup: { probe: 'scripts/probe/toolgroup.js', delay: 9000, cost: 0 },
  // 终端窗口：结构 / 三个拖拽把手 / 拖动与键盘调大小 / 展开恢复（不烧 token）
  terminal: { probe: 'scripts/probe/terminal.js', delay: 9000, cost: 0 },
  // 对话宽度自定义 + 导航轨跟随（不烧 token）
  streamwidth: { probe: 'scripts/probe/streamwidth.js', delay: 9000, cost: 0 },
  // 「正在处理」提示在整个 agent 回合内常驻（不烧 token）
  working: { probe: 'scripts/probe/working.js', delay: 9000, cost: 0 },
  // 连接状态竞态回归（dev 下必现、build 下不现，很容易再犯）—— 会真调模型
  conn: { probe: 'scripts/probe/conn.js', delay: 9000, cost: 1 },
  // 扩展集成：任务清单（panel_todos 的产物）+ 启动通知降级
  todos: { probe: 'scripts/probe/todos.js', delay: 9000, cost: 0 },
  // 长会话虚拟化
  virtual: { probe: 'scripts/probe/virtual.js', delay: 9000, cost: 0 },
  // 会话切换 + 新建会话
  sessions: { probe: 'scripts/probe/sessions.js', delay: 9000, cost: 0 },
  // 真发一条消息，验证流式 + 工具卡
  e2e: { probe: 'scripts/probe/e2e.js', delay: 9000, cost: 1 },
  // 问答功能端到端：模型主动提问 → 弹窗 → 回答 → 回填（真调模型）
  ask: { probe: 'scripts/probe/ask.js', delay: 9000, cost: 1 },
  // 图片真的发给模型（花 token —— 需要视觉模型，Ling 是纯文本的）
  image: { probe: 'scripts/probe/image.js', delay: 9000, cost: 1, model: TEST_VISION_MODEL },
  // 排队 + Esc 回收：需要真流式，也花 token
  queue: { probe: 'scripts/probe/queue.js', delay: 9000, cost: 1 }
}

const TS = (offsetSec = 0) => new Date(Date.now() - offsetSec * 1000).toISOString()

function seedSessions(destRoot) {
  const project = '--C--Users-Test--'
  const destDir = join(destRoot, project)
  mkdirSync(destDir, { recursive: true })
  let n = 0

  try {
    const real = join(homedir(), '.pi', 'agent', 'sessions')
    if (existsSync(real)) {
      const found = []
      const walk = (dir, depth) => {
        if (depth > 2) return
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) walk(p, depth + 1)
          else if (e.name.endsWith('.jsonl')) {
            found.push({ path: p, project: basename(dir), mtime: statSync(p).mtimeMs })
          }
        }
      }
      walk(real, 0)

      for (const f of found.sort((a, b) => b.mtime - a.mtime).slice(0, 3)) {
        const d = join(destRoot, f.project)
        mkdirSync(d, { recursive: true })
        copyFileSync(f.path, join(d, basename(f.path)))
        n++
      }
    }
  } catch (e) {
    console.log('  ⚠️  拷贝真实会话失败：' + e.message)
  }

  // 合成：带任务清单的会话（确定性，不依赖真实数据）
  writeTodoSession(destDir, 'yan-todo-fixture')
  n++

  // 合成：一组「分支会话」——父会话 + 两个子会话（带 parentSession）
  // 用来验左栏的「分支数 / 分支编号 / 分叉自哪句话」
  writeBranchFamily(destDir, 'yan-family')
  n += 3

  // 合成：20 条消息的普通会话
  writePlainSession(destDir, 'yan-plain-fixture', 20)
  n++

  return n
}

function writeTodoSession(dir, idBase) {
  const id = `${idBase}-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`)
  const cwd = homedir()
  const m = (role, text, i, extra = {}) => ({
    type: 'message',
    id: 'm' + i,
    parentId: i === 0 ? null : 'm' + (i - 1),
    timestamp: TS(100 - i),
    message: {
      role,
      content: [{ type: 'text', text }],
      ...(role === 'assistant'
        ? {
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop'
          }
        : {}),
      ...extra
    }
  })

  const lines = [
    { type: 'session', version: 3, id, timestamp: TS(200), cwd },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp: TS(200),
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    },
    m('user', 'YAN-TODO fixture：用来验证任务清单渲染', 0),
    m('assistant', '好，我把计划列出来。', 1),
    {
      type: 'custom',
      id: 'task0',
      parentId: 'm1',
      timestamp: TS(90),
      customType: 'left-panel-tasks',
      data: {
        todos: [
          { text: '读 spec 并确认范围', done: true },
          { text: '写 protocol.ts 的 JSONL 分帧', done: true },
          { text: '把渲染端的假数据换成 MainPush 补丁', done: false },
          { text: '补测试并用真实应用跑一遍回归', done: false }
        ]
      }
    }
  ]

  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
}

/**
 * 合成：一组「分支会话」——父会话 + 两个子会话。
 *
 * 子会话头里的 `parentSession` 指向父会话文件（pi 就是这么记分叉来源的），
 * 且子会话开头拷入了父会话的前缀（包括那句「源问题」）—— 与真实分叉一致，
 * 这样「分叉自哪句话」才能算出来。
 */
function writeBranchFamily(dir, idBase) {
  const stamp = Date.now().toString(36)
  const cwd = homedir()
  const T0 = Date.now() - 60_000
  const iso = (ms) => new Date(ms).toISOString()
  const msg = (id, parentId, role, text, ts) => ({
    type: 'message',
    id,
    parentId,
    timestamp: iso(ts),
    message: {
      role,
      content: [{ type: 'text', text }],
      ...(role === 'assistant'
        ? {
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop'
          }
        : {})
    }
  })
  const modelLine = {
    type: 'model_change',
    id: 'mc0',
    parentId: null,
    timestamp: iso(T0),
    provider: 'commandcode',
    modelId: 'deepseek/deepseek-v4.1-flash'
  }
  const ORIGIN = 'YAN-FAMILY 源问题：这段对话要怎么分帧？'

  const parentFile = join(dir, `2026-01-05T00-00-00-000Z_${idBase}-parent-${stamp}.jsonl`)
  writeFileSync(
    parentFile,
    [
      { type: 'session', version: 3, id: `${idBase}-parent-${stamp}`, timestamp: iso(T0), cwd },
      modelLine,
      msg('fu0', 'mc0', 'user', ORIGIN, T0 + 1),
      msg('fa0', 'fu0', 'assistant', '按行切就行。', T0 + 2)
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
    'utf8'
  )

  for (let i = 1; i <= 2; i++) {
    const forkTs = T0 + i * 1000
    const file = join(dir, `2026-01-05T00-00-0${i}-000Z_${idBase}-child${i}-${stamp}.jsonl`)
    writeFileSync(
      file,
      [
        {
          type: 'session',
          version: 3,
          id: `${idBase}-child${i}-${stamp}`,
          timestamp: iso(forkTs),
          cwd,
          parentSession: parentFile
        },
        modelLine,
        msg('fu0', 'mc0', 'user', ORIGIN, T0 + 1),
        msg('fa0', 'fu0', 'assistant', '按行切就行。', T0 + 2),
        msg(`c${i}u`, 'fa0', 'user', `YAN-FAMILY 分支${i}：改用方案 ${i}`, forkTs + 1),
        msg(`c${i}a`, `c${i}u`, 'assistant', `好，用方案 ${i}。`, forkTs + 2)
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
      'utf8'
    )
  }
}

function writePlainSession(dir, idBase, count) {
  const id = `${idBase}-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-02T00-00-00-000Z_${id}.jsonl`)
  const cwd = homedir()
  const lines = [
    { type: 'session', version: 3, id, timestamp: TS(500), cwd },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp: TS(500),
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    }
  ]
  for (let i = 0; i < count; i++) {
    lines.push({
      type: 'message',
      id: 'p' + i,
      parentId: i === 0 ? 'mc0' : 'p' + (i - 1),
      timestamp: TS(400 - i),
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `YAN-PLAIN fixture 第 ${i} 条消息` }],
        ...(i % 2 === 1
          ? {
              usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'stop'
            }
          : {})
      }
    })
  }
  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
}

/**
 * 探针脚本的语法检查。
 *
 * 它们会被当成字符串交给 `executeJavaScript`，所以语法错误不会在构建期
 * 暴露 —— 只会变成「没抓到 PROBE 输出 —— 应用可能启动失败」，
 * 跟真正的启动失败混在一起。实测踩过一次（重名 const），排查花了不少时间。
 *
 * @returns 错误信息，合法时返回 null
 */
function checkProbeSyntax(probe) {
  try {
    const src = readFileSync(join(root, probe), 'utf8')
    // 与 executeJavaScript 一致：按普通脚本（非 module）解析
    new vm.Script(src, { filename: probe })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function runProbe({ probe, delay, keys, env: caseEnv }, env) {
  return new Promise((resolvePromise) => {
    const child = spawn('npx', ['electron', '.'], {
      cwd: root,
      env: {
        ...env,
        // 场景自己的环境变量（如 authEnv 要验「key 写在环境变量里」那条路）
        ...(caseEnv ?? {}),
        YAN_PROBE: probe,
        YAN_PROBE_DELAY: String(delay),
        ...(keys ? { YAN_PROBE_KEYS: keys } : {})
      },
      shell: true,
      windowsHide: true
    })

    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
    })
    child.stderr.on('data', (d) => {
      buf += d
    })

    // 预发按键会额外占时间（每个组合等 1.4s）
    const keyCost = keys ? keys.split(',').length * 1500 : 0
    const kill = setTimeout(() => {
      child.kill()
    }, delay + keyCost + 90_000)

    child.on('exit', (code) => {
      clearTimeout(kill)

      const m = /---PROBE-START---\r?\n([\s\S]*?)\r?\n---PROBE-END---/.exec(buf)
      if (!m) {
        resolvePromise({
          ok: false,
          text: buf.slice(-3000),
          hint: '没抓到 PROBE 输出 —— 应用可能启动失败。先跑 `npm run probe-pi`。'
        })
        return
      }

      const body = m[1]
      // 断言失败标记：✗ 或 “=0（应为 1）” 之类的显式否定
      const bad = /✗/.test(body)
      resolvePromise({
        ok: !bad && code === 0,
        text: body + '\n',
        hint: bad ? '输出里有 ✗ 的行' : undefined
      })
    })
  })
}


/* 入口：放在最后调用。
   为什么不在顶层直接跑：fixture 生成器用了 `const TS`，而它在顶层被调用时
   还在 TDZ（函数声明会提升，const 不会）—— 包成函数调用就绕开了。 */
async function main() {

  // 支持多个场景：npm run test:live -- live memory sessions
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const names = argv.length ? argv : Object.keys(CASES)

  for (const n of names) {
    if (!CASES[n]) {
      console.error(`未知场景：${n}。可选：${Object.keys(CASES).join(' / ')}`)
      process.exit(2)
    }
  }

  // 早失败比晚失败好：确认探针脚本都存在
  for (const n of names) {
    readFileSync(join(root, CASES[n].probe), 'utf8')
  }

  console.log(`将运行：${names.join(', ')}`)
  console.log(`测试模型：${TEST_MODEL}（可用 YAN_TEST_MODEL 覆盖）`)
  const spends = names.filter((n) => CASES[n].cost > 0)
  if (spends.length) {
    for (const n of spends) {
      console.log(`⚠️  ${n} 会真的调用模型（花少量额度）→ ${CASES[n].model ?? TEST_MODEL}`)
    }
  }

  /* 状态隔离 —— 每个测试批次用一套临时目录。
     为什么必须做：验收测试会改应用状态（右栏分区顺序、主题、语言存在
     localStorage；会话文件在 ~/.pi/agent/sessions）以及写记忆。
     共用真实目录就会污染用户数据 —— 已经踩过两次：
     · 会话目录里多了 6 个测试会话
     · 记忆里留了 5 条编造的「已确认事实」（会误导后续对话）
     · 右栏顺序被拖成了 status 开头
     隔离三件事：
     YAN_USER_DATA      Electron 的 localStorage / cache
     YAN_SESSIONS_DIR   会话文件（同时 pi 也会收到 --session-dir）
     YAN_DATA_DIR       桌面端设置（desktop.json） */
  const ISOLATED = process.env.YAN_TEST_ISOLATED !== '0'   // 调试时「=0」可跑真实环境
  const sandboxRoot = ISOLATED ? mkdtempSync(join(tmpdir(), 'yan-test-')) : null

  let env = { ...process.env }
  if (sandboxRoot) {
    const userData = join(sandboxRoot, 'userData')
    const sessions = join(sandboxRoot, 'sessions')
    const data = join(sandboxRoot, 'data')
    /*
     * pi 的凭证目录（auth.json）。
     *
     * ⚠️ 必须隔离：`auth` 场景会写入并删除一个测试凭证，
     *   而 auth.json 里是用户的**真实密钥**。写坏了比污染
     *   会话目录/记忆文件严重得多（那两件已经各踩过一次）。
     */
    const piDir = join(sandboxRoot, 'pi-agent')
    for (const d of [userData, sessions, data, piDir]) mkdirSync(d, { recursive: true })

    /*
     * 预置工作目录 = **项目根**（不是 home）。
     *
     * 为什么：隔离后 desktop.json 是空的，cwd 会落到 homedir()，
     * 于是 fs 场景（文件树）只能看到家目录的杂项，
     * 所有「应该有 docs/ src/ scripts/」这类断言都无法写。
     * 指到项目根之后，文件树的断言才有确定的内容可测。
     *
     * 只写这一个字段 —— 其余设置由应用自己填默认值（不要在这里模拟）。
     */
    writeFileSync(
      join(data, 'desktop.json'),
      JSON.stringify({ cwd: root, lang: 'zh-CN' }, null, 2),
      'utf8'
    )

    env = {
      ...env,
      YAN_USER_DATA: userData,
      YAN_SESSIONS_DIR: sessions,
      YAN_DATA_DIR: data,
      YAN_PI_DIR: piDir
    }

    // 从真实会话目录**只读**拷几份当 fixture。
    // 为什么要拷：有些场景（切会话、长会话虚拟化）需要真实数据才有意义；
    // 为什么是拷贝而不是直接引用：测试会改名/删除会话，不能动原件。
    const seeded = seedSessions(sessions)

    console.log(`隔离目录：${sandboxRoot}`)
    console.log(`  fixture：${seeded} 份（真实会话只读拷贝 + 合成；原件不受影响）`)
    console.log('  （不碰真实的 sessions / memory.json / localStorage）')
    console.log('  （也不碰真实的 ~/.pi/agent/auth.json —— 里面是用户的密钥）')
  } else {
    console.log('⚠️  YAN_TEST_ISOLATED=0 —— 直接改真实数据，仅用于排查问题')
  }

  let failed = 0

  for (const name of names) {
    const c = CASES[name]
    console.log(`\n${'='.repeat(64)}\n▶ ${name}  (${c.probe})\n${'='.repeat(64)}`)

    /*
     * 每个场景开跑前把设置文件**重置回已知状态**（且每档窗口都重置）——
     * 所有场景共用一个隔离目录，而 desktop.json 是持久化的：
     * 上一个场景改了 cwd / 缩放 / 面板宽度 / 分区顺序，下一个就会带着开跑。
     * 实测后果：某场景改掉 cwd 后，后面的 atPath 拿到家目录、断言全落空，
     * 而且「单跑必过、全量才炸」。
     *
     * 重置成「只有 cwd」而不是删文件：应用会用 DEFAULTS 补全其余字段。
     */
    /*
     * 一个场景可能需要跑**多档窗口宽度**（narrow 就是）。
     * 每档都要重置设置 —— 否则上一档留下的面板宽度/收起态会带过来。
     */
    const wins = c.wins ?? [null]
    let allOk = true
    let hint

    /*
     * 探针脚本先过一遍**语法检查**。
     *
     * 它们是以字符串形式被 executeJavaScript 执行的，所以语法错误
     * （比如重复声明一个 const）不会在构建期报错，只会表现为
     * 「没抓到 PROBE 输出 —— 应用可能启动失败」，极难定位。
     * 实测踩过一次（topbar 里重名 cur），这里提前拦住。
     */
    const syntaxErr = checkProbeSyntax(c.probe)
    if (syntaxErr) {
      console.log(`  ✗ 探针脚本语法错误：${syntaxErr}`)
      failed++
      console.log(`\n✗ ${name} 未通过`)
      continue
    }

    for (const win of wins) {
      if (sandboxRoot) {
        writeFileSync(join(sandboxRoot, 'data', 'desktop.json'), JSON.stringify({ cwd: root, lang: 'zh-CN' }, null, 2), 'utf8')
      }
      if (win) console.log(`\n─── 窗口 ${win} ───`)
      const out = await runProbe(c, {
        ...env,
        ...(win ? { YAN_WIN: win } : {}),
        // 每个场景用自己的模型（默认免费 Ling；image 用视觉模型）
        YAN_TEST_MODEL: c.model ?? TEST_MODEL
      })
      process.stdout.write(out.text)
      if (!out.ok) {
        allOk = false
        hint = hint ?? out.hint
      }
    }

    if (!allOk) {
      failed++
      console.log(`\n✗ ${name} 未通过`)
      if (hint) console.log(`  提示：${hint}`)
    } else {
      console.log(`\n✓ ${name} 通过`)
    }
  }

  if (sandboxRoot) {
    try {
      rmSync(sandboxRoot, { recursive: true, force: true })
    } catch {
      /* Windows 上偶有句柄未释放，留着也无害 */
    }
  }

  console.log(`\n${'='.repeat(64)}`)
  console.log(failed === 0 ? `全部通过（${names.length} 个场景）` : `${failed}/${names.length} 个场景失败`)
  process.exit(failed === 0 ? 0 : 1)


}

await main()
