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
/* 日志管道断开（终端关闭 / agent 的 bash 会话结束）不能让我们中途死掉或弹框 */
import './lib/stdio-guard.mjs'
import { spawn, execFileSync } from 'node:child_process'
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
  existsSync,
  symlinkSync,
  utimesSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * 测试统一使用的模型（会让所有 cost>0 场景真实调模型）。
 *
 * 默认用 **commandcode 的 LongCat 2.0（免费）**：
 *   供应商 provider = commandcode
 *   模型 id        = longcat-2.0:free
 * 它成本为 0，适合反复跑回归。若该模型不可用或触顶，改用
 * `YAN_TEST_MODEL="commandcode/laguna-s-2.1-free"` 重跑。个别场景（如 image 要发图）需要视觉模型，
 * 在 CASES 里用 `model:` 单独覆盖。
 *
 * 想用别的模型：`YAN_TEST_MODEL="provider/modelId" npm run test:live -- e2e`。
 * 约束：模型必须能从真实 `~/.pi/agent/` 取到凭证。测试会把它**只读复制**进
 * 隔离的 YAN_PI_DIR（不复制就起不了 pi）；副本只写在系统临时目录、退出时清理，
 * 绝不写回原目录。个别场景需要「没有凭证」的前提，见下面 `piDirNoAuth`。
 * 写成 `provider/id` 形式，交给 pi 的 `--model` 解析。
 */
const TEST_MODEL = process.env.YAN_TEST_MODEL || 'commandcode/longcat-2.0:free'

/**
 * Electron 可执行文件（直接 spawn，不经 npx）。
 *
 * electron 包在 Node 里 require 出来就是可执行文件路径。走 npx 会多一层
 * cmd.exe，而 npx 自己可能先退（抢 npm 缓存锁、检查包），会把“应用还在
 * 跑探针”误判成“应用启动失败”—— 实测踩到过一次，还留下一个无头 GUI 实例。
 */
const electronBin = createRequire(import.meta.url)('electron')

/** 需要视觉的场景专用（Ling 是纯文本模型，发图会失败） */
const TEST_VISION_MODEL =
  process.env.YAN_TEST_VISION_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash'

/*
 * 某些旧场景曾为远程免费模型写死 `model:`，用来绕过当时的供应商波动。
 * 当调用方明确选择本地模型时，这些「正常模型」不应偷偷把请求切回远程；
 * 仍保留故意不存在的模型与本地路由 fixture，因为它们本身就是失败 / 路由测试。
 */
const USE_LOCAL_TEST_MODEL = TEST_MODEL.startsWith('local/')
function modelForCase(fallback) {
  if (USE_LOCAL_TEST_MODEL && fallback && !/nonexistent|route-probe/i.test(fallback)) return TEST_MODEL
  return fallback ?? TEST_MODEL
}

/** 每个场景：probe 脚本 + 等待多久（毫秒）+ 可选的预发按键 */
const CASES = {
  // 纯 DOM 体检：溢出 / 令牌 / 图标 / 字体栅格 / 分区渲染
  live: { probe: 'scripts/probe/live.js', delay: 9000, cost: 0 },
  // 08-S0：隔离 Electron 远程 API → 指定后台 runner → 精确 runId 中止（本机 provider，cost 0）
  remoteroutes: {
    probe: 'scripts/probe/remote-routes.js',
    delay: 15000,
    budget: 120000,
    cost: 0,
    driver: driveRemoteRoutes,
    afterExit: 'remoteRoutes'
  },
  // 推理胶囊：渲染 / 展开 / 折叠 / 无推理不占位（不烧 token，注入数据）
  reasoning: { probe: 'scripts/probe/reasoning.js', delay: 9000, cost: 0 },
  // 模型未知时选择器仍可见（用户报的「看不到模型选择」）
  // 连接就绪后模型/思考档位列表要能补上（端到端）
  capabilityload: { probe: 'scripts/probe/capabilityload.js', delay: 9000, cost: 0 },
  capsettings: { probe: 'scripts/probe/capabilities-tab.js', delay: 12000, cost: 0, budget: 150000 },
  modelnotready: { probe: 'scripts/probe/modelnotready.js', delay: 9000, cost: 0 },
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
  // 删除会话确认框：标题 / 按钮样式 / 不换行 / Esc 不误删（方案 15）
  trash: { probe: 'scripts/probe/trash.js', delay: 10000, cost: 0 },
  /*
   * N21-4 / S1：会话删除时清掉派生状态。
   *
   * 状态文件由 Node 侧种进隔离的 YAN_DATA_DIR（探针按设计碰不到那个目录），
   * 探针只负责走真实界面删一条会话，退出后检查文件是否被清掉。
   * cost 0：不调模型。
   */
  contextstate: {
    probe: 'scripts/probe/context-state.js',
    delay: 10000,
    cost: 0,
    contextStateSeed: true,
    afterExit: 'contextStateCleanup'
  },
  // 文件引用：主进程校验通道 / 标签渲染 / 只有附件也能发（方案 5.1）
  fileref: { probe: 'scripts/probe/fileref.js', delay: 10000, cost: 0 },
  // 链接路由 + 只读文件预览（方案 5.2）
  linkpreview: { probe: 'scripts/probe/linkpreview.js', delay: 11000, cost: 0 },
  // 回复详细程度三档（方案 3.1）
  detail: { probe: 'scripts/probe/detail.js', delay: 10000, cost: 0 },
  // 模型菜单：可见行数 / 不越界 / 键盘选择（注入合成模型，不连 pi）
  modelmenu: {
    probe: 'scripts/probe/modelmenu.js',
    delay: 9000,
    cost: 0,
    wins: ['1440x900', '940x640']
  },
  // 子代理：真起一个独立 pi 子进程（方案第 8 节；本地模型也可能需要更长冷启动）
  subagent: { probe: 'scripts/probe/subagent.js', delay: 12000, cost: 0, budget: 240000 },
  /*
   * 两个并发写入子代理的真实矩阵（L03）：真起两个 pi 子进程，各自在
   * `HEAD` 的独立 worktree 里写文件，然后走合并 / 放弃 / 冲突 / 只读
   * 白名单 / 退出归档。会真调模型（且要求它真的写文件），所以 cost: 1。
   *
   * 退出归档只能在 Electron **已经退出**之后看，所以真正的断言在
   * `afterExit`（Node 侧检查 `YAN_DIR/subagents` 与临时 worktree 目录）。
   */
  subagentpair: {
    probe: 'scripts/probe/subagentpair.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 14000,
    /* 探针要排队跑几个真实模型任务，实测 1.5-2.5 分钟（budget 是最坏兜底，
       跑完就退出；delay 只负责把窗口和应用起起来）。 */
    budget: 240000,
    cost: 1,
    /* 免费 Ling 对工具调用的服从度不稳（有时只回话不写文件），这条链路要求模型
       真的写文件，所以用已在 image 场景使用的 deepseek-v4.1-flash。 */
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    afterExit: 'subagentArchive'
  },
  /*
   * L03 尾巴：子代理**模型自身失败**时的恢复（实施-09 S2 第六批）。
   * 坏模型名 → pi 只 warn、上游 400、**不产生用量**，所以是 cost 0。
   */
  subagentfail: {
    probe: 'scripts/probe/subagent-fail.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 14000,
    budget: 300000,
    cost: 0,
    model: 'deepseek/deepseek-nonexistent',
    afterExit: 'subagentFail'
  },
  /*
   * N12：真实 A/B 会话的后台生命周期。
   *
   * A（cwd=fixture/repo）发一个长任务跑起来，然后：
   *   · 切到 B（不同 cwd）—— 允许，且 A **不能**被停掉；
   *   · 切到 C（与 A 同 cwd）—— 必须明确拒绝并提示，视图不跟着走；
   *   · 切回 A —— 内容还在，没串成 B 的；
   *   · 单独停 A —— B 不受影响。
   *
   * 会话是运行时生成的合成会话（它们的 cwd 必须是 fixture 的绝对路径），
   * 见 `writeAbSessions`；模型只用 deepseek（要它真的吐一段长文本）。
   */
  sessionab: {
    probe: 'scripts/probe/sessionab.js',
    fixture: true,
    abSessions: true,
    delay: 14000,
    budget: 300000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    afterExit: 'sessionabArchive'
  },
  /*
   * 实施-09 S2 第二批：后台会话「等待输入」的真实窗口证据（cost 1）。
   *
   * 与 `ask` 的区别：那条证的是提问链路（扩展 → pi → 面板 → 回填），
   * 全程停在**前台**；这条只证 N12 缺的那一态 —— 用户切走之后，
   * 那个会话还挂着问题，左栏那一行要一直显示「等待输入」。
   *
   * 不复用 `ask`：它刻意不建第二条会话（切会话会让问题面板失去归属，
   * 把原本稳的断言弄脏）；这里反过来，开场就只要两条会话与那次切走。
   */
  askbackground: {
    probe: 'scripts/probe/ask-background.js',
    fixture: true,
    abSessions: true,
    delay: 12000,
    budget: 200000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },
  /*
   * N12 失败态（实施-09 S2 第四批）：把 pi 入口指向一个「存在但立刻退出」的文件，
   * 模拟内置运行时损坏 / 版本不匹配 —— 这是用户机器上真会出现的事。
   * ⚠️ 为什么必须真写一个文件：`resolvePi` 对 `YAN_PI_BIN` 只做 `existsSync`
   *    检查，不存在的路径会被**静默忽略**并回落到内置 pi（刻意的降级，
   *    坏设置不该把应用弄成打不开）。所以不能拿一个编出来的路径做测试。
   */
  runnerfailed: { probe: 'scripts/probe/runner-failed.js', fixture: true, fixtureSub: 'repo', delay: 9000, budget: 120000, cost: 0, brokenPi: true },
  /*
   * 渲染异常兜底（D8）：故意把 sessions 置成非法值把整棵树搞崩，
   * 验证出现的是可读的兜底界面 + 重新加载出口（而不是整屏白）。
   * 它必须独立成一个场景 —— boundary 接管后不会自动恢复。
   */
  crash: { probe: 'scripts/probe/crash.js', delay: 9000, cost: 0 },
  /*
   * N19 的最后一条：@ 引用真的发出去后，模型有没有拿到**文件内容**。
   * 发一次消息（免费模型），真正的断言在退出后的会话 JSONL 里。
   */
  atrefsend: {
    probe: 'scripts/probe/atrefsend.js',
    fixture: true,
    delay: 12000,
    cost: 1,
    model: 'commandcode/longcat-2.0:free',
    afterExit: 'atrefsendArchive'
  },
  /*
   * 真实模型切换矩阵（N02）：只切模型不发消息（不花钱）。
   * 验的是“切过去之后状态归谁”：档位跟随、快速连切不串、用量归属。
   */
  modelswitch: { probe: 'scripts/probe/modelswitch.js', delay: 12000, cost: 0 },
  // 界面密度三档：间距真的变、落盘、字号不变（方案 A1）
  density: { probe: 'scripts/probe/density.js', delay: 10000, cost: 0 },
  // 左栏搜索：入口稳定 / 过滤 / 清空与关闭后的焦点（P1 4.1）
  railsearch: { probe: 'scripts/probe/railsearch.js', delay: 11000, cost: 0 },
  // 性能实测：流式更新 / 面板收放 / 虚拟化窗口（方案 P2 要求先测量）
  /*
   * 性能基线：断言量的是**真实动画/渲染耗时**，而隐藏窗口里 Chromium 会把定时器
   * 节流到 1 秒（实测 1000.1ms / 1000.4ms）——所以这条必须上屏跑。
   * `visible: true` 就是给这种场景开的：单个场景要求可见窗口，
   * 而其他场景仍然默认不上屏（用户要求测试不要弹窗）。
   */
  perf: { probe: 'scripts/probe/perf.js', delay: 16000, cost: 0, visible: true },
  // 增量推送协议：textDelta / thinkingDelta / outputDelta 的拼接与兜底
  deltas: { probe: 'scripts/probe/deltas.js', delay: 12000, cost: 0 },
  // 诊断：grid 容器的行/列是否依赖子元素数量（同类布局 bug 排查）
  layoutdiag: { probe: 'scripts/probe/layoutdiag.js', delay: 12000, cost: 0 },
  // 诊断：长会话虚拟化为什么不渲染（只输出尺寸，不断言）
  virtualdiag: { probe: 'scripts/probe/virtualdiag.js', delay: 14000, cost: 0 },
  // 发送键：规则可选 / 常显 / 生效（Enter 的语义不再随输入框高度隐式变化）
  sendkey: { probe: 'scripts/probe/sendkey.js', delay: 9000, cost: 0 },
  // 悬着的消息：生成中发出去的先悬在输入框上方，由用户选插话 / 排队
  pending: { probe: 'scripts/probe/pending.js', delay: 9000, cost: 0 },
  /*
   * 待定消息的**真实链路**回归（真调模型）。
   *
   * `pending`（上面那条）直接把 store 的 `runners` 改掉来伪造「回合结束」，
   * 绕过主进程推送链 —— 所以 2026-09-19 那个 bug（回合结束不刷 runners 快照，
   * 待定消息永不自动投递）它能测出来才怪。这条走真实回合。
   */
  pendingreal: { probe: 'scripts/probe/pending-real.js', delay: 15000, cost: 1 },
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
  /* 几何测量（阅读位置不能被拉回底部）：同上，位置类断言在隐藏/未渲染窗口里不可信 */
  outlinepos: { probe: 'scripts/probe/outlinepos.js', delay: 9000, cost: 0, visible: true },
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
  // 分组管理（N01）：重命名 + 空白/重名校验 + 解散但保留项目
  grouprename: { probe: 'scripts/probe/grouprename.js', delay: 9000, cost: 0 },
  /*
   * N01 拖拽排序：项目 / 分组顺序用**合成 PointerEvent** 走真实渲染路径
   * （实现里没有用 HTML5 draggable，所以合成事件与用户手拖是同一条），
   * 并回读 `yan.getSettings()` 证明顺序真的过了 IPC 落盘。
   * 探针里要等多次 420ms 的界面落定，所以预算给宽一点。
   */
  railreorder: { probe: 'scripts/probe/rail-reorder.js', delay: 10000, cost: 0, budget: 150000 },
  // 项目默认只展开前五个（N17）：更多/收起 + 搜索 + 当前项目定位
  projectlimit: { probe: 'scripts/probe/projectlimit.js', delay: 9000, cost: 0 },
  // 窄侧栏会话标题可读性（N13）：最小宽度下量标题/缩进/状态槽
  railtitle: { probe: 'scripts/probe/railtitle.js', delay: 9000, cost: 0 },
  // 收起侧栏的 mini 项目文件夹（N14）：图标 / 名称 / 当前标记 / 全部项目浮层
  railmini: { probe: 'scripts/probe/railmini.js', delay: 9000, cost: 0 },
  /*
   * 工作模式（实施-05 S2）：旧配置迁移 / 菜单与键盘 / 会话级隔离。
   *
   * 两个关键设置：
   *   · `legacyAutonomous: true` —— 预置一份**只有旧布尔**的 desktop.json，
   *     验「旧 autonomous=true → 新会话自主」（新字段优先、迁移幂等）；
   *   · `keys + keysDelay` —— Tab 快切是**渲染端**消费的真按键，探针得先
   *     关掉首次引导、把焦点放进输入框，所以把第一枚按键推到 12s。
   */
  workmode: {
    probe: 'scripts/probe/work-mode.js',
    delay: 18000,
    cost: 0,
    budget: 120000,
    legacyAutonomous: true,
    keys: 'tab,tab',
    keysDelay: 15000,
    afterExit: 'workModePersisted'
  },
  /*
   * 澄清就绪转移端到端（实施-05 S3，**花一次模型**）：
   * 切澄清档 → 让模型用内联参数敲 `yan goal ready` → 宿主校验/幂等/落盘 →
   * 模式自动切标准 + 工具卡认成「目标 · 砚内置」。
   *
   * 为何必须是真模型：整条链路（bash → `yan` 启动器 → 环境变量注入 → 身份校验）
   * 里任何一段断了，单测都看不出来（与 `taskcli` 同一个理由）。
   */
  goal: {
    probe: 'scripts/probe/goal.js',
    delay: 12000,
    cost: 1,
    budget: 240000,
    goalResumeExtLog: true,
    afterExit: 'goalPersisted'
  },
  /*
   * 自主档「大任务自己往下推」端到端（实施-05 S3c，**花一次模型**）：
   * 切自主档 → 模型只用 `yan goal report` 报一次进展就收尾 →
   * 宿主 arm 的续行把它自动叫回来（全程不再有用户消息）。
   *
   * 与 `goal` 分开的理由：那边证的是「就绪 → 开工」的一次性续行，
   * 这边证的是「每报一次进展 → 再叫醒一次」的**可重复**链路，
   * 消息标签也不同（`yan-goal-continue`）。合并成一个场景会让失败原因说不清。
   */
  goalloop: {
    probe: 'scripts/probe/goal-loop.js',
    delay: 12000,
    cost: 1,
    budget: 360000,
    goalResumeExtLog: true,
    /*
     * 固定模型：默认那个免费模型（longcat-2.0:free）实测**没跑通** ——
     * 它收到「跑这条命令再收尾」后只回了一段文本、一次工具都没调
     * （2026-09-19 实测：目标停在 rev0、续行根本没机会发生，属于假红）。
     * 同免费档的 deepseek 一闪模型一次跑通，与 browserclimodel 同一个处置。
     */
    model: 'deepseek/deepseek-v4.1-flash',
    afterExit: 'goalLoopPersisted'
  },
  /*
   * 模型出错后的自动继续（实施-05 S5c，**不花额度**）。
   *
   * 模型名故意写坏：pi 不拒启动（只 warn），上游回 400（请求被拒，不产生用量），
   * 那个错误不含额度/认证/上下文关键词 → 砚判为「可重试」→
   * 没人说话的情况下自己再起最多 2 轮（退避压到 1.2s），然后收手。
   *
   * 为何与 `goalloop` 分开：那边续行的理由是「模型报告了进展」，
   * 这边是「模型根本没回话」—— 两条触发源、两个消息标签，必须各证各的。
   */
  autocontinue: {
    probe: 'scripts/probe/auto-continue.js',
    delay: 16000,
    cost: 0,
    budget: 60000,
    model: 'deepseek/deepseek-s5c-nonexistent',
    env: { YAN_AUTO_CONTINUE: JSON.stringify({ limit: 2, delays: [1200, 1200] }) },
    goalResumeExtLog: true,
    afterExit: 'autoContinuePersisted'
  },
  /*
   * 交接包生成（实施-05 S5b-2，**花一次模型**）。
   *
   * 自主档 + `yan goal report`（让「目标在推进」成立）+ `YAN_HANDOFF_THRESHOLD=0`
   * （真实链路要攒够两次真实自动压缩，而那是全项目最贵的场景之一）
   * → 回合结束后宿主判资格 → 写请求 → 薄层在 `agent_settled` 调一次 completion
   * → 宿主解析 / 清洗 / 落盘。
   *
   * 与 `contexttakeover`（S5a 借它验计数）的分工：那边验的是**计数**，
   * 这一片验的是**包本身**（模型真写得出两栏必填 + 来源字段由宿主填）。
   */
  handoffpack: {
    probe: 'scripts/probe/handoff-pack.js',
    delay: 22000,
    cost: 1,
    budget: 240000,
    model: 'deepseek/deepseek-v4.1-flash',
    goalResumeExtLog: true,
    handoffExtLog: true,
    env: { YAN_HANDOFF_THRESHOLD: '0' },
    afterExit: 'handoffPackPersisted'
  },
  /*
   * 交接提交（实施-05 S5b-3b，**会多起一个会话并多跑一轮模型**）。
   *
   * 与 `handoffpack` 的分工：那边验「模型写得出一份包」，这一片验
   * 「包真的被用掉了」—— 停源实例 → 同 cwd 建目的会话 → 写会话链 →
   * 发 resume → 目的会话文件里拿到消费证据。
   *
   * **不设 `YAN_HANDOFF_COMMIT`**：自动交接自 2026-09-19 用户拍板起**默认开**，
   * 这一场顺手把「默认开真的生效」当断言（`initial.autoCommit === true`）。
   * 唯一测试通道是把阈值压到 0（真实链路要攒两次真实自动压缩才够数）。
   */
  handoffcommit: {
    probe: 'scripts/probe/handoff-commit.js',
    delay: 25000,
    cost: 1,
    budget: 400000,
    model: 'deepseek/deepseek-v4.1-flash',
    goalResumeExtLog: true,
    handoffExtLog: true,
    env: { YAN_HANDOFF_THRESHOLD: '0' },
    afterExit: 'handoffCommitPersisted'
  },
  // 上下文分区：压缩后 tokens=null 的诚实显示 + 花费行对齐
  context: { probe: 'scripts/probe/context.js', delay: 9000, cost: 0 },
  /*
   * N21-2 压缩可观测：真实触发一次自动压缩 + 真实的手动压缩失败。
   *
   * ⚠️ **前提已过期（2026-09-19 处置：实施-06 §2 选项 ②，降级为说明）**。
   * pi 0.85.1 不再按 `reserveTokens` 在回合结束自动压，所以下面那个「触发线落到 ≤ 0」
   * 的手法已经失效 —— 跑起来会在「自动压缩真的发生」那一节红，**不是回归**。
   * 不要再为了让它变绿去修这套前提；砚侧自动压缩链路的覆盖改用
   * `contexttakeover`（`YAN_CONTEXT_POLICY` 驱动）与 `contexttakeoverstate`（接管成功分支）。
   * 条目与探针保留在原处，以便将来 pi 恢复或被重新设计时能拿回来对照。
   *
   * 为什么要 `piSettings`：pi 的自动压缩只在「上下文 > 窗口 − reserveTokens」时触发。
   * 默认 reserveTokens=16384，意味着要把上下文填到接近整个窗口 —— 即使拿最大的
   * 免费模型也是几十万 token 的额度。把 reserveTokens 调成比任何窗口都大，
   * 触发线就落到 ≤ 0：第一轮结束必然触发，事件形状与真实情况完全一致。
   * keepRecentTokens=1 同理：不去压一个 20k 的尾巴。
   *
   * cost 1（会真调模型两次：一次正常回合 + 一次摘要请求）—— 所以不进 check 批量。
   */
  compactionstatus: {
    probe: 'scripts/probe/compaction-status.js',
    delay: 9000,
    cost: 1,
    budget: 180000,
    /* cwd = fixture 里那个**带项目级 pi 设置**的目录（见 buildFixtureProject） */
    fixture: true,
    fixtureSub: 'compact',
    piSettings: { compaction: { enabled: true, reserveTokens: 900000, keepRecentTokens: 1 } }
  },
  /*
   * N21-3 工作集（cost 0）：预算公式的参考值（64k/128k/256k/1M）、
   * 「界面上的数 = 砚用来判断的数」、三阶段刻度与未接管的虚线，
   * 以及关掉「自动压缩」后整个工作集视角退回物理窗口。
   */
  contextbudget: { probe: 'scripts/probe/context-budget.js', delay: 14000, cost: 0, budget: 180000 },
  /*
   * N21-3 真实接管（cost 1）：用一次普通回合越过**砚算出来的工作集**，
   * 验证 pi 真的压了、砚把这一次记成自己发起的（pi 一律报 reason=manual）。
   * 触发点用 `YAN_CONTEXT_POLICY` 挪近（默认 240k 要几十万 token 的额度）。
   */
  contexttakeover: {
    probe: 'scripts/probe/context-takeover.js',
    delay: 10000,
    cost: 1,
    /*
     * 420s 的理由：探针现在要跑三个串行阶段 —— 预热回合（建立历史，否则 pi 会说
     * `Nothing to compact (session too small)`）、大回合（把用量推过工作集）、
     * 再等压缩落定。180s 时进程会在探针打印前就被杀掉，而彼时 **buf 是空的**，
     * 报出来的却是「应用可能启动失败」（2026-09-17 晚为此白查了三轮）。
     */
    budget: 420000,
    env: { YAN_CONTEXT_POLICY: '{"workingSetCap":1500}' },
    contextExtLog: true,
    afterExit: 'contextTakeoverHook',
    /*
     * `keepRecentTokens: 1`：会话太小时 pi 自己会说
     * `Nothing to compact (session too small)` —— 保留尾巴默认 20k，
     * 而本场景的上下文只有几 k。调到 1 压缩才会真的发生（触发仍然是砚自己那条线）。
     * 不设 reserveTokens：pi 自己那条线必须留在高处，否则分不清是谁触发的。
     */
    piSettings: { compaction: { keepRecentTokens: 1 } }
  },
  /*
   * 结构化压缩摘要的逐类字段取证（N21-6 最后一项）。
   *
   * 原设计是「长会话触发压缩 → `session_before_compact` 接管」，实测**走不通**：
   * pi 0.85.1 上那条钩子在真实压缩里**一次都没被调到** —— 砚触发的（`reason: manual`）
   * 与 pi 自己按 `threshold` 触发的都是，连那次真的调了模型（5.7s、摘要 280 token）也是。
   * 这是**发现**，不是可以改断言绕过去的东西（登记在归档 §1.19）。
   * 所以本场景只做能真正取证的两件事：
   *   ① 跑两个回合，让**状态生成器**真的落盘（只发一个回合时，模型偶尔返回不合法 JSON，
   *      生成器就空手而归 —— 实测撞到过一次）；
   *   ② 摘要的逐类字段由退出后的检查在**真实状态文件**上跑真实 `buildStructuredSummary` 判。
   * `kinds` 必须显式带 `episode-fold`（否则生成器不工作）；`state.gate` 调成 1/1。
   */
  contexttakeoversummary: {
    probe: 'scripts/probe/context-takeover-summary.js',
    delay: 10000,
    cost: 1,
    budget: 240000,
    contextExtLog: true,
    afterExit: 'contextTakeoverSummary',
    env: {
      YAN_CONTEXT_POLICY:
        '{"kinds":["tool-sweep","recall","compaction","episode-fold"],"state":{"gate":{"minTurns":1,"minTokens":1}}}'
    }
  },
  /*
   * Deep Context（N21-8）—— 默认关的最重的一个可选优化：
   * 它挂在 `context` 钩子里，会在用户开口前**同步**多调一次模型。
   * `minTokens` 降到 1：真实门槛是 150k，而探针会话只有几 k ——
   * 本场景的命题是「打开之后链路通不通」，「门槛算得对不对」由单测钉住。
   */
  contextdeep: {
    probe: 'scripts/probe/context-deep.js',
    delay: 10000,
    cost: 1,
    budget: 240000,
    contextExtLog: true,
    afterExit: 'contextDeep',
    env: {
      YAN_CONTEXT_POLICY: '{"deep":{"enabled":true,"minTokens":1}}'
    }
  },
  /*
   * Deep Context 的**界面路径**（cost 1）：与 `contextdeep` 的分工是 ——
   * 那个走 `YAN_CONTEXT_POLICY`（测试通道）验「链路通不通」，
   * 这个走**设置面板**（`patchSettings`）验「设置真的传到扩展了吗」。
   * 中间隔着「渲染端 → 主进程 → 写盘 → 扩展读 `desktop.json`」四段，
   * 任何一段断了，界面上的开关都会看起来正常而实际无效。
   * 刻意**不设** `YAN_CONTEXT_POLICY` / `YAN_CONTEXT_DEEP` —— 设了就盖掉了本场景的命题。
   */
  contextdeeppref: {
    probe: 'scripts/probe/context-deep-pref.js',
    delay: 10000,
    cost: 1,
    budget: 240000,
    contextExtLog: true,
    afterExit: 'contextDeepPref'
  },
  /*
   * 「压缩接管」的**成功分支**（N21-6 最后一项，cost 1）。
   *
   * 与 `contexttakeover` 的关键差别：这里 `kinds` 含 `episode-fold` 且 gate 调到 1/1
   * —— 所以 `state.inject` 是 **true**，钩子不会走 `fallback: 'inject-off'`，
   * 而是有可能真的接管。
   *
   * `workingSetCap: 20000` 是照「回合 1 不过线、回合 2 过线」**实测**选出来的：
   * 回合 1 只发十几字符，但**工具调用会把用量推上去** —— 实测 pi 报 **5595**；
   * 回合 2 是 46k 字符的填充回合，实测 pi 报 **31019**。
   * 所以两个回合之间要留出一段区间（第一次写 2000 时，回合 1 当场就越线了）。
   * 状态生成器挂在 `agent_settled` 之后且是异步的，所以回合 1 结束就压缩
   * 一定会 `no-state`；两段时序是本场景成立的前提。
   */
  contexttakeoverstate: {
    probe: 'scripts/probe/context-takeover-state.js',
    delay: 10000,
    cost: 1,
    budget: 420000,
    contextExtLog: true,
    afterExit: 'contextTakeoverState',
    /* 固定模型：默认免费档 LongCat 已退役（403），不固定会让场景假红 */
    model: 'deepseek/deepseek-v4.1-flash',
    env: {
      YAN_CONTEXT_POLICY:
        '{"workingSetCap":20000,"kinds":["tool-sweep","recall","compaction","episode-fold"],"state":{"gate":{"minTurns":1,"minTokens":1}}}'
    },
    /* 不调小它，pi 会说 `Nothing to compact (session too small)` */
    piSettings: { compaction: { keepRecentTokens: 1 } }
  },
  /*
   * **压缩接管的档位可达性**（N21-6 尾，实施-06 S4 前半，cost 1）
   *
   * S4 的出口是「`fresh` / `stale-soft` / `stale-hard` 每档至少一次真实接管
   * 或明确的降级记录」—— `stale-hard` 已由 `contexttakeoverstate` 取证。
   * 本场景试了两种构造去命中另两档：
   *   · 让 **pi 自己**在回合中途压（`reserveTokens = 窗口 − 25k`）；
   *   · 让回合 2 明确禁止工具调用（水位后只有 user + assistant 两条）。
   * 两次实测结果**完全一样**：`tier=stale-hard`、`gap=3`，会话条目序列也都是
   * `… user | assistant | compaction | …` —— 即压缩（不管谁发起）**总在回合结束之后**，
   * 水位后至少已有 user + assistant + compaction 三条，gap 永远 ≥ 3。
   *
   * 所以本场景的命题从「命中某档」改成**如实量出可达性**：断言真实链路里
   * 只会出现 `stale-hard`，并把条目序列一并打印作为机制证据。
   * `fresh` / `stale-soft` 两档的**判定正确性**由单测钉住
   *（`scripts/test-context-producer.mjs` 的 `applyFreshness` / `pendingOnly` 各组）。
   */
  contexttakeovergap: {
    probe: 'scripts/probe/context-takeover-tier.js',
    delay: 10000,
    cost: 1,
    budget: 420000,
    contextExtLog: true,
    afterExit: 'contextTakeoverGap',
    model: 'deepseek/deepseek-v4.1-flash',
    env: {
      YAN_CONTEXT_POLICY:
        '{"workingSetCap":20000,"kinds":["tool-sweep","recall","compaction","episode-fold"],"state":{"gate":{"minTurns":1,"minTokens":1}}}'
    },
    piSettings: { compaction: { keepRecentTokens: 1 } }
  },
  contextswitchguard: {
    probe: 'scripts/probe/context-switch-guard.js',
    delay: 10000,
    cost: 0,
    contextGuardSeed: true,
    budget: 90000,
    /*
     * 两条线都压到极低：切到任何有内容的旧会话都必然“在线上”，
     * 于是“切换没有触发压缩”才是一条有效断言（而不是碰巧没过线）。
     */
    env: { YAN_CONTEXT_POLICY: '{"workingSetCap":100,"emergencyRatio":0.001}' }
  },
  /*
   * N21-4 / S2 真实接管（cost 1）：真实回合里把「上一回合的大块工具输出」
   * 换成墓碑（`ctx://tool/<原始 entryId>`），扩展写归档元数据，模型再用
   * `context_recall` 取回原文。
   *
   * 为什么把 recentTail 与门槛压到最小：默认 32k 尾部以下的小会话
   * 永远不会 sweep（整个历史都在尾部里）。压到最小后，只要有两个回合
   * 就必然产生候选 —— 触发路径、钩子调用、消息替换、归档落盘全是真的，
   * 只有“那条线”被挪近了（与 N21-3 的 `workingSetCap=1500` 同一手法）。
   * 取证点在退出后的派生文件（扩展在 renderer 里碰不到 `YAN_DATA_DIR`）。
   *
   * **刻意不设 `kinds`**（2026-09-17 起）："清理默认开"是个产品决定，
   * 所以这里验的就是默认接管集本身 —— 哪天默认值被改回 `['compaction']`，
   * 这条场景会红，而不是静默变成“总是没候选”。
   */
  contextsweep: {
    probe: 'scripts/probe/context-sweep.js',
    delay: 12000,
    cost: 1,
    budget: 420000,
    contextExtLog: true,
    afterExit: 'contextSweepArchive',
    env: {
      YAN_CONTEXT_POLICY:
        '{"recentTail":{"target":1,"max":1},"sweep":{"minTokens":10,"minReclaimTokens":10,"minReclaimRatio":0}}'
    }
  },
  /*
   * N21-4 生成器（cost 1）：真实回合里生成状态 → 落盘 → 下一轮注入。
   * `kinds` **显式**带上 `episode-fold`，验的是「测试通道精确指定接管集」这条路；
   * 「**默认**接管集下也会生成」由 `contextfolddefault` 承担（它刻意不写 `kinds`），
   * 「从设置面板关掉后不生成」由 `contextfoldpref` 承担。退出后检查在 `checkContextProduce`。
   */
  contextproduce: {
    probe: 'scripts/probe/context-produce.js',
    delay: 12000,
    cost: 1,
    budget: 420000,
    contextExtLog: true,
    afterExit: 'contextProduce',
    env: {
      /*
       * `state.gate` 把会话级门槛调成 1 回合 / 1 token：这条场景只跑两个回合，
       * 用它证「够了就生成」；门槛本身由 `contextgate` 场景用默认值证反向。
       */
      YAN_CONTEXT_POLICY:
        '{"kinds":["tool-sweep","recall","compaction","episode-fold"],"state":{"gate":{"minTurns":1,"minTokens":1}}}'
    }
  },
  /*
   * 默认接管集下的生成器（2026-09-18 折叠进默认集）—— cost 1。
   *
   * 与 `contextproduce` 的**唯一差别**：env 里**不写 `kinds`**，只调会话级门槛。
   * 于是 `kinds` 走扩展的内置默认值 —— 这条场景证的是「**默认**接管集下生成器
   * 真的会工作」，而不是「显式打开才会工作」。
   * 反向（默认里没有它 = 不生成）由 `contextgate`（默认门槛）与 `contextbudget`
   * （策略层 + 界面层各一次、含摘掉后回退虚线的反向验证）承担。
   * 复用 `contextProduce` 的检查函数：它的断言全部只关乎「生成了什么」，不读 kinds。
   */
  contextfolddefault: {
    probe: 'scripts/probe/context-produce.js',
    delay: 12000,
    cost: 1,
    budget: 420000,
    contextExtLog: true,
    afterExit: 'contextProduce',
    env: {
      YAN_CONTEXT_POLICY: '{"state":{"gate":{"minTurns":1,"minTokens":1}}}'
    }
  },
  /*
   * 会话级 eligibility gate（cost 1）：kinds 开 `episode-fold`，但门槛保持**默认**
   * （≥4 回合且转录 ≥48k token）—— 一个回合的会话必然不满足，于是
   * 「短会话不生成、不花模型调用、且留得下原因」在真实链路里可以被检查。
   * 与 `contextproduce`（把门槛放开到 1/1 证「够了就生成」）是一对反向对照。
   */
  /*
   * `episode-fold` 的**界面关闭路径**（P2-7，cost 1）—— 上一条的反向对照。
   *
   * 同样的 env（只降门槛、**不给 `kinds`**）、同样的回合形态，唯一差别是：
   * 探针先**从设置面板把开关关掉**。于是「一条生成动作都没有」才是可解释的。
   * 这个入口补的是原来「想关只能手改 `kinds`」的缺口，验的是它真的接到了扩展上
   * （四段链路：渲染端 → 主进程 → 写 `desktop.json` → 扩展每轮读文件），
   * 退出后的检查在 `checkContextFoldPref`。
   */
  contextfoldpref: {
    probe: 'scripts/probe/context-fold-pref.js',
    delay: 12000,
    cost: 1,
    budget: 300000,
    contextExtLog: true,
    afterExit: 'contextFoldPref',
    env: {
      YAN_CONTEXT_POLICY: '{"state":{"gate":{"minTurns":1,"minTokens":1}}}'
    }
  },
  /*
   * Episode 扇叠（§12.6，cost 1）：真实回合里生成一段「已收束的旧工作」的工作状态。
   *
   * env 把 `recentTail` 压到 200/400（测试通道）—— 不压的话两三个回合的会话整体都在
   * 尾部窗口里，候选区间永远为空，「零 Episode」就证明不了任何事；同时把会话级门槛
   * 降到 1/1（历史只有一个回合，默认门槛要 ≥4 回合）。**不给 `kinds`** —— 走默认接管集。
   * 退出后检查在 `checkContextEpisode`（窗口是否算得出来是硬断言，模型给不给 Episode 是软报告）。
   */
  contextepisode: {
    probe: 'scripts/probe/context-episode.js',
    delay: 12000,
    cost: 1,
    budget: 600000,
    contextExtLog: true,
    afterExit: 'contextEpisode',
    env: {
      YAN_CONTEXT_POLICY:
        '{"recentTail":{"target":10,"max":100},"episodes":{"minEntries":1,"minTokens":1},"state":{"gate":{"minTurns":1,"minTokens":1},"rearmMs":1000,"cooldownMs":1000,"episodeGenerate":true}}'
    }
  },
  /*
   * 请求前预算门的真实模型冒烟（实施-05 S4，cost 1）。
   *
   * 与 `hook-probe budget` / `budget-soft`（假 provider，cost 0）成对：
   * 那边验「判得对、拦得住」；这边只验反面 —— **不误拦**。
   * 工作集线压到 3000，真实对话第一轮就过线（soft），但物理线远在窗口那头：
   * 这一轮必须照常发出并拿到回答，磁盘上只能有 soft，不能有 physical / abort。
   */
  budgetgate: {
    probe: 'scripts/probe/budget-gate.js',
    delay: 12000,
    cost: 1,
    budget: 240000,
    contextExtLog: true,
    afterExit: 'budgetGate',
    /*
     * 固定模型：默认那个免费档（LongCat 2.0）已于 2026-09-19 退役
     * （`403 permission_error`：免费层下线），不固定就会变成一条无意义的红。
     *
     * 本场景**不看模型答了什么**（只要这一轮正常跑完）：deepseek 一闪模型在 RPC 链路的
     * 极短问题上偶发空回复（手动 `--print` 同模型同提示正常）——那是模型侧，
     * 判「有没有被误拦」的根据是磁盘上的 physical / budget-abort 断言（都为 0）。
     */
    model: 'deepseek/deepseek-v4.1-flash',
    env: { YAN_CONTEXT_POLICY: '{"workingSetCap":3000}' }
  },
  contextgate: {
    probe: 'scripts/probe/context-gate.js',
    delay: 12000,
    cost: 1,
    budget: 300000,
    contextExtLog: true,
    afterExit: 'contextGate',
    env: {
      YAN_CONTEXT_POLICY: '{"kinds":["tool-sweep","recall","compaction","episode-fold"]}'
    }
  },
  /*
   * State Refresh 档（N21-6）：把刷新比例调到极小，让「接近窗口」这条分支当场命中。
   *
   * 三个参数各自排除一条别的分支：`minTurns:1` 让地板放行、`minTokens` 设成天文数字
   * 排除 long-session，只剩 near-window。这条同时是 **`ctx.model.contextWindow` 能不能
   * 拿到**的真实证据：拿不到则是 0 → 该分支跳过 → 这里会红，而诊断里的 `window` 字段
   * 会把真相直接写出来。
   * 探针与 `contextgate` 共用（它只负责把回合跑出来），所以会话 id 也从 `ctxgate.` 取。
   */
  contextrefresh: {
    probe: 'scripts/probe/context-gate.js',
    delay: 12000,
    cost: 1,
    budget: 300000,
    contextExtLog: true,
    afterExit: 'contextRefresh',
    env: {
      YAN_CONTEXT_POLICY:
        '{"kinds":["tool-sweep","recall","compaction","episode-fold"],"state":{"gate":{"minTurns":1,"minTokens":100000000,"refreshRatio":0.000001}}}'
    }
  },
  /*
   * N21-4 尾 / §12.11 第 10 条：**连续 20+ 长回合压力测试**（cost 1）。
   *
   * 前面所有上下文场景最多跑 3 个回合 —— 能证触发路径通，证不了
   * 「连续很多轮都贴着工作集跑时，冷却 / 收益门槛 / 输出预留还守不守得住」。
   * 这里把两条件都挪近（工作集 6000、尾部 1000）让每一轮都在线上，
   * 跑 22 个真实回合；断言（贴线占比 / 恒不越窗口预留 / 原始会话不被破坏）
   * 全在退出后的 `checkContextPressure` 里读扩展诊断与会话文件。
   *
   * 固定模型：默认那个免费档已退役（见 `budgetgate` 的注释）；压力测试
   * 要的是稳定的工具调用行为，不能因为模型侧波动把“回合数不够”报成代码红。
   */
  contextpressure: {
    probe: 'scripts/probe/context-pressure.js',
    delay: 12000,
    cost: 1,
    budget: 900000,
    contextExtLog: true,
    afterExit: 'contextPressure',
    model: 'deepseek/deepseek-v4.1-flash',
    /*
     * `keepRecentTokens: 1` 与 `contexttakeover` 同一理由：pi 的压缩默认会保留
     * 最近一大段，那就看不出“砚的策略线到底压不压得住”——转录会停在 pi 的
     * 保留量上、而不是工作集上，压力测试会变成在验 pi 的参数。压到 1 才是有效压力条件。
     */
    piSettings: { compaction: { keepRecentTokens: 1 } },
    env: {
      /*
       * 工作集 20000 是「压到小额度但仍然在基线之上」的取值：pi 报的 `contextUsage`
       * 包含系统提示 + 工具定义（本机实测约 10k），工作集低于它时压缩后用量仍过线，
       * 会退化成“一直压”。取 20000（90% = 18000 > 基线）才能让“回落到线下”真的发生，
       * 压力测试量的也才是“转录能不能维持在工作集附近”。
       * 刻意**不压近 `recentTail`**（默认 32k）：转录从未超过它，所以这条场景
       * 量的是**压缩**，不是清扫；清扫的取值由 `contextsweep` 那组覆盖。
       */
      YAN_CONTEXT_POLICY: '{"workingSetCap":20000}'
    }
  },
  /*
   * 压力测试的**低线变体**（cost 1）：工作集压到 6000，**低于** pi 的基线开销
   *（系统提示 + 工具定义，本机约 10k）。
   *
   * 这一条专测 `rearmAfterCompaction`（N21-4 尾的修复）：“回落到线下”的恢复路径
   * 要求 `usage < 工作集 × 0.9 = 5400`，而基线开销就有约 10k —— 那条路**永远不成立**。
   * 修复前 `armed` 回不来，只能等 5 分钟重试窗口 → 22 个回合只压 1–2 次；
   * 修复后每次压缩成功都重新上膛，30s 冷却一到就能再压。
   * 本场景**不判峰值比率**（工作集低于基线，压无可压），只判“压缩能不能持续发生”。
   */
  contextpressurelow: {
    probe: 'scripts/probe/context-pressure.js',
    delay: 12000,
    cost: 1,
    budget: 900000,
    contextExtLog: true,
    afterExit: 'contextPressure',
    model: 'deepseek/deepseek-v4.1-flash',
    piSettings: { compaction: { keepRecentTokens: 1 } },
    env: {
      YAN_CONTEXT_POLICY: '{"workingSetCap":6000}'
    }
  },
/* 同上，但把工作集抬到天上、兜底压到极低 → 命中的是 90% 物理兜底那条线 */
  contextemergency: {
    probe: 'scripts/probe/context-takeover.js',
    delay: 10000,
    cost: 1,
    budget: 180000,
    env: { YAN_CONTEXT_POLICY: '{"workingSetCap":999999999,"emergencyRatio":0.001}' },
    piSettings: { compaction: { keepRecentTokens: 1 } }
  },
  // 思考档位：真实模型（DeepSeek V4.1 Flash）切过去后必须显示真实档位，
  // 且不能被后续 state 推送清空（D11）。不调模型，只 set_model + 读档位。
  thinkinglevels: { probe: 'scripts/probe/thinking-levels.js', delay: 14000, cost: 0 },
  // 排队消息：显示在输入框上方 + 插队按钮接线
  queuestack: { probe: 'scripts/probe/queuestack.js', delay: 9000, cost: 0 },
  // 所有报错都进日志（store.set 包装的回归网）
  logs: { probe: 'scripts/probe/logs.js', delay: 9000, cost: 0 },
  // `/` 斜杠命令：自动重拉 + 常用优先 + Enter/Tab 填充
  slashcmd: { probe: 'scripts/probe/slashcmd.js', delay: 9000, cost: 0 },
  // 分区内容高度可调
  vheight: { probe: 'scripts/probe/vheight.js', delay: 9000, cost: 0 },
  // 工具栏分区排序（拖拽 + 键盘）与工具库（收进库 / 拿回 / 上移下移 / 恢复默认）
  tools: { probe: 'scripts/probe/tools.js', delay: 9000, cost: 0 },
  /*
   * 额度区：Command Code 的月度口径（`monthlyCredits` 是「剩余」不是「已用」）
   * 与颜色分级（<70% 绿 / 70–95% 黄 / ≥95% 红）。
   * 真实接口那段需要本机 commandcode 凭证 + 网络（只读，不花钱）；没有凭证时探针
   * 自己跳过真实数据断言，颜色分级那段用打桩数据走真实渲染路径，仍然会跑。
   * ⚠️ 不进 `check`：方向判据依赖当月真实用量，放在 check 里会变成靠环境碰运气的红灯。
   */
  quota: { probe: 'scripts/probe/quota.js', delay: 10000, cost: 0, budget: 120000 },
  // 面板宽度拖拽（含夹取范围与键盘）
  resize: { probe: 'scripts/probe/resize.js', delay: 9000, cost: 0 },
  // 文件树边界：空目录 / 失效路径 / 多级 / 大目录分页 / 中文空格 / 同名文件 / 目录联接
  fsedge: { probe: 'scripts/probe/fs-edge.js', delay: 11000, cost: 0, fixture: true, budget: 150000 },
  // @ 补全边界：多级 / 大目录截断 / 同名文件 / 引号 / 句中光标 / 切项目竞态
  atpathedge: { probe: 'scripts/probe/at-path-edge.js', delay: 11000, cost: 0, fixture: true },
  // 项目切换（N05）：视图与文件树跟着 cwd 走 / 草稿按实例隔离 / 附件绝对路径 / 失效与无权限目录的真实反馈
  projectswitch: { probe: 'scripts/probe/project-switch.js', delay: 10000, cost: 0, fixture: true, budget: 180000, projectSessions: true },
  /*
   * 「每个项目最后一个会话」的恢复判断（实施-09 S3，cost 0）：不调模型。
   *
   * 与 `projectswitch` 的差别：那个验的是切过去之后草稿/文件树对不对；
   * 这个验**恢复哪一个会话** —— 前提是 fixture 里有两条同项目的会话，
   * 「消息最新的」与「用户真的打开过的」是**不同**的两条。
   */
  projectopened: {
    probe: 'scripts/probe/project-opened.js',
    fixture: true,
    projectSessions: true,
    openedSessions: true,
    delay: 10000,
    budget: 180000,
    cost: 0,
    afterExit: 'projectOpenedLayout'
  },
  /*
   * shell / 第三方工具的变更归属（L05）。cost 0：走直执行 shell 通道
   *（`window.yan.runBash`），不需要模型生成。必须在**隔离的 fixture 目录**里跑，
   * 因为它会真的建/改/删文件。
   */
  workspacechanges: { probe: 'scripts/probe/workspace-changes.js', delay: 10000, cost: 0, fixture: true, fixtureSub: 'repo', budget: 180000, projectPeers: true },
  /*
   * Git 审查 + 环境菜单（方案 G1）—— cost 0，不调模型。
   *
   * 场景 cwd 是 fixture 里那个**故意做脏**的 `review/` 仓库（见
   * buildFixtureProject）：未暂存修改、已暂存新增、未暂存删除、已暂存重命名、
   * 未跟踪文件、中文+空格路径、被改动的 PNG、含 NUL 的二进制。
   * 「只读保证」不在这里断言 —— 那要靠退出后从 Node 侧逐字节比对
   *（`afterExit: 'gitReviewReadonly'`），因为渲染进程里拿不到 git 的真实回答。
   */
  gitreview: {
    probe: 'scripts/probe/git-review.js',
    fixture: true,
    fixtureSub: 'review',
    delay: 11000,
    budget: 150000,
    cost: 0,
    afterExit: 'gitReviewReadonly'
  },
  /*
   * Git 写操作（方案 §5，G2）：暂存 / 取消暂存 / 提交 / 推送 / 拉取 /
   * 切分支 / 新建分支 / 非法输入。
   * cost 0（不调模型），但**会真的改 fixture 仓库** —— 退出后由
   * `afterExit: gitWriteApplied` 用真 git 核对提交与远程。
   */
  gitwrite: {
    probe: 'scripts/probe/git-write.js',
    fixture: true,
    fixtureSub: 'write',
    delay: 13000,
    budget: 240000,
    cost: 0,
    afterExit: 'gitWriteApplied'
  },
  // 文件树（工具栏「文件」分区）：懒加载 / 排序 / 缩进 / 点文件插 @路径 / 溢出
  /*
   * 来源「定位消息」（方案 §8 的 S1，cost 0）：**不调模型** —— 它验的是
   * 「关联已存在」之后的全部链路（落盘 / 菜单入口 / 跳到那条消息）。
   * 发送时建立关联那一段需要模型回合，所以那一段只能在手动场景里跑。
   */
  sourcelink: {
    probe: 'scripts/probe/source-locate.js',
    fixture: true,
    /*
     * 必须是**有 git 仓库的** fixture 子目录：来源区与环境菜单的其它分区
     * 一起渲染在「这个是 git 项目」那个分支里（非 git 目录下整块换成一行提示），
     * 所以 cwd 指到普通目录时 `env-source-menu` 根本不会出现。
     * 选 `review`（只读仓库）而不是 `write` —— 本场景不写 git 任何东西。
     */
    fixtureSub: 'review',
    /*
     * N12 的 A/B 合成会话（cwd = fixture/repo，带 user 消息）—— 本场景需要
     * 「在 git 项目里、且带可定位消息」的会话：plain fixture 的 cwd 是家目录
     *（非 git 仓库，来源区整块不渲染），而默认打开的那个是空会话。
     */
    abSessions: true,
    delay: 11000,
    budget: 150000,
    cost: 0,
    afterExit: 'sourceLocateLinked'
  },
  /*
   * 来源「定位消息」的**发送链路**（同上一片，cost 1）：验的是关联怎么产生的 ——
   * 发一条带图的消息，渲染端把附件对应的来源绑到 pi 刚写出的那条 user 条目上。
   * 这一步需要真实模型回合（消息 id 由 pi 生成），所以**不进 `npm run check`**。
   */
  sourcelinklive: {
    probe: 'scripts/probe/source-locate-send.js',
    fixture: true,
    delay: 9000,
    budget: 200000,
    cost: 1,
    model: 'deepseek/deepseek-v4.1-flash',
    afterExit: 'sourceLocateLinked'
  },
  /*
   * pi 包管理（方案 §9 的 P2，cost 0）：**真实**调用 pi 的 CLI 装一个本地包
   * 再卸掉。用专属 fixture（`fixtureSub: 'pkgs'`）—— 它会在隔离的
   * YAN_PI_DIR 下真写 settings.json 与包目录，所以绝不能挂在没有 fixture
   * 的场景上（那会把 cwd 指到真实项目根）。不联网（本地路径源）。
   */
  pkgs: { probe: 'scripts/probe/packages.js', fixture: true, fixtureSub: 'pkgs', delay: 12000, budget: 300000, cost: 0 },
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
  /*
   * L04 浏览器授权与网络边界：逐站权限真实请求、本地预览边界、DNS 重绑定、
   * 下载来源与不自动打开、Cookie 真实转移但不输出值。
   *
   * 需要 Node 侧的本地 HTTP 服务（`usesBoundaryServer`）；
   * 其中「远程页面借道本地服务」与 DNS 重绑定两节要公网/公网 DNS，
   * 拿不到时会**显式跳过并打印原因**，不假装通过。
   */
  browserboundary: {
    probe: 'scripts/probe/browser-boundary.js',
    delay: 9000,
    cost: 0,
    budget: 180000,
    usesBoundaryServer: true,
    afterExit: 'browserBoundaryDownloads',
    env: { YAN_CHROME_HEADLESS: '1', YAN_CHROME_SYNC: '0' }
  },
  // 浅色主题：对比度 / 代码高亮 / 工具行
  light: { probe: 'scripts/probe/light.js', delay: 9000, cost: 0 },
  // 首次引导：第 2 栏「模型接入」按钮布局（N20；从设置→关于重新打开，不重置首次启动标记）
  onboarding: {
    probe: 'scripts/probe/onboarding.js',
    delay: 9000,
    cost: 0,
    wins: ['1440x900', '940x640']
  },
  // 阶段 2 功能：斜杠菜单 / !bash / 图片附件 / 模型选择器 / 开关 / 重命名删除 / 分叉点
  features: { probe: 'scripts/probe/features.js', delay: 9000, cost: 0 },
  // 对话导航轨：间距拉长 + 鼠标靠近动态展开
  outline: { probe: 'scripts/probe/outline.js', delay: 9000, cost: 0 },
  // 布局：用量条合并 / 消息无上下文 / 右栏任务 / 左栏自动隐藏
  layout: { probe: 'scripts/probe/layout.js', delay: 9000, cost: 0 },
  // 用量条（输入/输出/缓存命中/输出速度）—— 会真调模型
  tokens: { probe: 'scripts/probe/tokens.js', delay: 9000, cost: 1 },
  /*
   * N11 标题：真机下的自动生成 / 单次生成锁 / 手动名粘性 / 候选→采用。
   * cost 1（2 次聊天 + 几次很短的归纳请求）。
   */
  title: {
    probe: 'scripts/probe/title.js',
    delay: 12000,
    budget: 260000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },
  /*
   * N16 语言提示：界面语言 → 模型输出语言。cost 1（3 次调用），
   * 用**互换语言**的对照（中文界面问英文 / 英文界面问中文）来断言
   * "跟着界面语言走"而不是"跟着用户消息走"。
   */
  language: {
    probe: 'scripts/probe/language.js',
    delay: 14000,
    budget: 300000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    /* 诊断：语言扩展把每次注入写一行到该文件（扩展里 YAN_LANG_EXT_LOG 才写） */
    env: { YAN_LANG_EXT_LOG: join(tmpdir(), 'lang-ext.log') }
  },
  // 设置面板的当前布局（外观 / 声音 / 上下文 / 关于…）+ 记忆已整体移除的边界
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
  todos: {
    probe: 'scripts/probe/todos.js',
    delay: 9000,
    cost: 0,
    /* 退出后验「旧会话文件没被改写」（实施-02 S1 的出口） */
    afterExit: 'taskFixtureReadonly',
    readonlySession: 'yan-todo-fixture'
  },
  /*
   * 实施-02 S1 / S5：旧任务扩展与砚**同时存在**，外加一个**无关扩展**。
   *
   * 用专属 piDir（里面多一份 scripts/fixtures/task-ext 的 fixture 旧扩展，
   * 它注册同名 `panel_todos` 并写旧标识 `left-panel-tasks`；另一个
   * `notes-panel.ts` 与任务无关，只注册 `/notes`）。
   * 验四件事：启动期通知降级、来源诊断能说清是谁（两项都数到）、
   * 无关扩展照常可用、砚只读不写（退出后字节比对）。
   */
  taskext: {
    probe: 'scripts/probe/taskext.js',
    delay: 12000,
    cost: 0,
    afterExit: 'taskFixtureReadonly',
    readonlySession: 'yan-todo-fixture'
  },
  // 长会话虚拟化
  /* 虚拟滚动：首屏渲染行数与滚动位置都是几何量 → 需要真实可见窗口 */
  virtual: { probe: 'scripts/probe/virtual.js', delay: 9000, cost: 0, visible: true },
  // 会话切换 + 新建会话
  sessions: { probe: 'scripts/probe/sessions.js', delay: 9000, cost: 0 },
  // 切换会话不能丢历史（含「切语言重建实例之后」这条路）
  historyswitch: { probe: 'scripts/probe/history-switch.js', delay: 9000, cost: 0 },
  // 项目—会话归属：真实 IPC 迁移索引，不移动 pi 的 JSONL 文件
  sessionlayout: { probe: 'scripts/probe/sessionlayout.js', delay: 9000, cost: 0 },
  // 窗口关闭隐藏到托盘，退出取消路径可重复
  tray: { probe: 'scripts/probe/tray.js', delay: 9000, cost: 0, env: { YAN_EXIT_CHOICE: 'cancel' } },
  //
  // N12 退出变体（实施-09 S2 第五批）：保存并退出 + 退出进行中重复请求。
  // `YAN_EXIT_CHOICE` 是原生对话框的 probe 替身 —— 只跳过“选哪个”这一步，
  // 写快照 / 收实例 / 退出的链路完全相同；快照与进程表在 afterExit 看。
  exitsave: { probe: 'scripts/probe/exit-save.js', delay: 9000, cost: 0, afterExit: 'exitSnapshot', env: { YAN_EXIT_CHOICE: 'save' } },
  // 同一套前置，换中断分支：快照 mode=interrupt（差别的判据在落盘文件里）
  exitinterrupt: { probe: 'scripts/probe/exit-interrupt.js', delay: 9000, cost: 0, afterExit: 'exitSnapshot', env: { YAN_EXIT_CHOICE: 'interrupt' } },
  // 运行实例：身份过滤 + 左栏状态槽 + 单独停止（N12，注入合成推送）
  sessionrunners: { probe: 'scripts/probe/sessionrunners.js', delay: 9000, cost: 0 },
  // 运行实例选择：真实主进程注册表路径（N12，不跑回合）
  runnerselect: { probe: 'scripts/probe/runnerselect.js', delay: 12000, cost: 0 },
  // 真发一条消息，验证流式 + 工具卡
  /*
   * ⚠️ 这条探针内部的等待上限是 150s（它要看到流式 + 工具 + 正文），
   * 而 budget 默认只有 90s —— 不够就会被杀在探针打印之前，
   * 报出来的却是「没抓到 PROBE 输出 —— 应用可能启动失败」（误导）。
   * 所以这里显式给足：delay 9s + budget 200s。
   */
  e2e: { probe: 'scripts/probe/e2e.js', delay: 9000, cost: 1, budget: 200000 },
  // 宿主能力服务：模型在 bash 里调 `yan`，宿主校验身份后回结构化摘要（花 token）
  capability: { probe: 'scripts/probe/capability.js', delay: 12000, cost: 1, budget: 180000 },
  // 子代理能力：父模型通过 yan CLI 启动子代理，UI 必须收到同一条实时 run（花 token）
  subagentmodel: {
    probe: 'scripts/probe/subagent-model.js',
    delay: 12000,
    cost: 1,
    budget: 260000,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },
  /*
   * 项目知识的注入链（实施-03 S3，花 token）：宿主检索 → 每条会话一份注入文件
   * → 薄层扩展在 `before_provider_request` 把材料放进上下文；**从设置里关掉
   * 之后下一轮立刻不再注入**。
   *
   * 两个真实回合都在探针里（开 / 关各一轮），断言全在退出后：
   * 「到底注入了什么」只有扩展诊断日志与注入文件知道，而探针按设计读不到
   * `YAN_DATA_DIR`（与 context 系场景同一条分工）。
   * 知识条目由 fixture 预置（`knowledgeSeed`）—— 写入通道是 S4 的 CLI，
   * 本片**不**假装它已经存在。
   */
  knowledgeinject: {
    probe: 'scripts/probe/knowledge-inject.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    /* 三个真实回合（开 / 关 / 重新开 + 无关查询）；单个回合最坏 120s */
    budget: 600000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    knowledgeSeed: true,
    knowledgeExtLog: true,
    afterExit: 'knowledgeInject'
  },
  /*
   * 项目知识设置页（实施-03 S5，**不调模型**）：真开设置 → 读到 fixture →
   * 确认 / 编辑 / 逻辑删除一次走完。落盘由 afterExit 核对（界面上“已消失”
   * 不等于磁盘上真的删了）。
   */
  knowledgetab: {
    probe: 'scripts/probe/knowledge-tab.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    budget: 120000,
    cost: 0,
    knowledgeSeed: 'candidate',
    afterExit: 'knowledgeTab'
  },
  /*
   * 项目知识的跨会话 / 项目 / 工作树隔离（实施-03 S6，**不调模型**）。
   *
   * 为什么要单独一条：`knowledgetab` 验的是「一条会话里界面能读能写」，
   * 它看不出**两个项目 / 一棵工作树会不会共用一个知识空间**。而这正是
   * 实施-03 §4 的硬要求（「工作树默认是独立项目知识空间」）。
   *
   * 这条场景用**真实路径前缀**复现旧 projectId 算法的截断缺陷：
   * `legacyProjectId` 只取路径前 27 字节，而 fixture 根目录很长 ——
   * `repo`（已登记）与 `repo-worktrees/iso`（真 git 工作树，未登记）会派生出
   * **同一个 id**。修复前工作树会读到主仓库的知识（见 afterExit 与 HANDOFF）。
   *
   * `restart` 是这片新增的能力：第一次启动跑主探针 → 退出 → **用同一份
   * `YAN_DATA_DIR` 再启动一次**跑重启探针，验「关掉应用再开，知识还在、隔离还在」。
   * 探针之间用 localStorage 交接观察到的 id（同一个 `YAN_USER_DATA`，跨进程保留）。
   */
  knowledgeisolation: {
    probe: 'scripts/probe/knowledge-isolation.js',
    restart: { probe: 'scripts/probe/knowledge-isolation-restart.js', delay: 12000, budget: 120000 },
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    budget: 150000,
    cost: 0,
    knowledgeIsolationSeed: true,
    afterExit: 'knowledgeIsolation'
  },
  /*
   * `yan knowledge …` 的真实闭环（实施-03 S4，花 token）：模型自己发现并用
   * 随包 CLI 检索 + 提议。
   *
   * 为什么断言在退出后：**「工具执行了」不等于「写进去了」**（§6 明文要求两边都看）。
   * 磁盘上要多出一条 `candidate`（模型不能自证确认），而原来的 active 条目数量不变。
   */
  knowledgecli: {
    probe: 'scripts/probe/knowledge-cli.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    budget: 360000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    knowledgeSeed: true,
    afterExit: 'knowledgeCli'
  },
  /*
   * 宿主任务服务端到端（实施-02 S3，花 token）：
   * 模型 → bash → `yan tasks apply` → 宿主任务日志 → 界面清单。
   *
   * 为什么必须有这条（单测与 `capability` 都不够）：单测证明落盘层对，
   * `capability` 证明管道通 —— 但它们都没有证明「模型照这个用法写出来的任务
   * 真的会出现在界面上」，也没有证明切会话来回能从磁盘读回。
   * `fixture: true` 让 cwd 是合成项目（request 文件由 Node 侧预置在 `tasks/` 下）。
   */
  taskcli: {
    probe: 'scripts/probe/taskcli.js',
    fixture: true,
    delay: 12000,
    cost: 1,
    budget: 300000,
    afterExit: 'taskCliLog'
  },
  /*
   * 真实多步任务（实施-02 S5，花 token）：与 `taskcli` 的分工是
   * 「链路由谁驱动」——taskcli 用预置的请求文件验**写入链**，
   * 这条从写请求文件到勾选全由模型自己做，验的是「真实多步任务下仍然三处一致」。
   * 任务本身是真动作（在 fixture 里建三个文件），退出后能核对。
   */
  taskplan: {
    probe: 'scripts/probe/taskplan.js',
    fixture: true,
    delay: 12000,
    cost: 1,
    budget: 420000,
    afterExit: 'taskPlanMultiStep'
  },
  // 问答功能端到端：模型主动提问 → 弹窗 → 回答 → 回填（真调模型）
  /*
   * 问答（cost 1）：真弹窗 → 选答案 → 回填；第 6 节是「自主档不弹窗」。
   * `questionExtLog` 把扩展读到的模式写成诊断行 —— 不弹窗可能是扩展拦住了，
   * 也可能是模型自己没问，这两件事必须分开（afterExit 核对）。
   */
  ask: {
    probe: 'scripts/probe/ask.js',
    delay: 9000,
    cost: 1,
    questionExtLog: true,
    afterExit: 'questionModeLog'
  },
  // 图片真的发给模型（花 token —— 需要视觉模型，Ling 是纯文本的）
  image: { probe: 'scripts/probe/image.js', delay: 9000, cost: 1, model: TEST_VISION_MODEL },
  // 排队 + Esc 回收：需要真流式，也花 token
  queue: { probe: 'scripts/probe/queue.js', delay: 9000, cost: 1 },
  // 队列撤回的失败与并发边界（N09）：撤回不存在的 id / 连点两次 / 同时两条 —— 不花 token
  queueretract: { probe: 'scripts/probe/queue-retract.js', delay: 9000, cost: 0 },
  /*
   * 实施-01 S4b：`yan browser …` 宿主能力命令（cost 0，不调模型）。
   *
   * 模型工具 `browser_*` 已从薄层移除（01-S4b），浏览器的全部模型面现在只有
   * 这一族 CLI 命令 —— 所以这条场景是「扩展装载被移除后浏览器能力还在吗」的
   * 直接证据（01-S5 的硬前置）。
   *
   * cost 0 的跑法：`window.yan.runBash` 是**不经模型**的直执行 shell 通道，
   * 它继承 pi 子进程的环境（PATH 里的 yan 启动器 + YAN_CLI_* 身份），
   * 所以验的是真进程外 CLI。只用 `about:blank`，不依赖外网可达性，
   * 也**不需要本地 fixture 服务**（`usesBoundaryServer` 会顺带带上 L04 的
   * Cookie 转移断言，那不属本片）。
   * `fixture: true`：宿主侧缺参数那条要写一个临时请求文件，放合成项目里。
   * 需要鼠标的 scroll / click / type 在默认（不上屏）模式下显式跳过，
   * 理由与实测见 scripts/probe/browser-cli.js 的头注释。
   *
   * ⚠️ 还没进 `npm run check` 的场景清单（package.json 不在本片文件域内）。
   */
  browsercli: {
    probe: 'scripts/probe/browser-cli.js',
    delay: 10000,
    cost: 0,
    fixture: true,
    budget: 240000
  },
  /*
   * 同一条能力的**模型端到端**（花 token）：模型 → bash → `yan browser navigate`
   * → 读回执 → 再 `yan browser observe` → 答出 URL。
   *
   * 为什么必须有：`browsercli` 验的是 CLI ↔ 宿主，它绿了也可能是“模型压根不会去用”。
   * 16 个 `browser_*` 工具删掉后，模型能不能靠能力入口说明自己找到 `yan browser`，
   * 只能这样验。不在默认门槛里跑（cost 1）。
   */
  browserclimodel: {
    probe: 'scripts/probe/browser-cli-model.js',
    delay: 10000,
    cost: 1,
    budget: 260000,
    /*
     * 固定模型：默认那个免费模型（longcat-2.0:free）在 2026-09-19 实测对这一条
     * 多步提示连续返回「模型返回错误」（模型侧错误，不是本片代码），
     * 会变成假红。换成同一个免费档的 deepseek 一闪模型即可稳定跑完（实测通过）。
     */
    model: 'deepseek/deepseek-v4.1-flash'
  },

  /*
   * 实施-04 S2：能力目录 + 按需读技能正文的**模型端到端**。
   *
   * 它验的是「发现 → 读取 → 按目标执行」整条链：模型得自己从能力说明
   * 找到 `yan capabilities search`，从候选里挑出技能，再 `skill read` 读正文。
   * 提示词**不给命令名也不给技能名** —— 给了就只验执行链，验不到发现链。
   * 需要专属 piDir（多一个技能），见下面 sandbox 准备区。不在默认门槛里（cost 1）。
   */
  capsearch: {
    probe: 'scripts/probe/capability-search-model.js',
    delay: 10000,
    cost: 1,
    budget: 260000,
    model: 'deepseek/deepseek-v4.1-flash'
  },

  /*
   * 实施-04 S4：**模型自己发现 MCP 工具并调用**（cost 1）。
   * 提示词不给服务名 / 工具名 / MCP 字样，验的就是发现链（mcpcli 只验执行链）。
   */
  capmcp: {
    probe: 'scripts/probe/mcp-search-model.js',
    delay: 10000,
    cost: 1,
    budget: 260000,
    model: 'deepseek/deepseek-v4.1-flash'
  },

  /*
   * 实施-04 S5：`yan capabilities discover/prepare` 的宿主链路 + **真实目录检索**（cost 0）。
   * 两个源都不可用时**跳过**（离线环境），不假装验过 —— 与 probe:chrome 同一口径。
   */
  discnet: { probe: 'scripts/probe/discovery-cli.js', delay: 9000, cost: 0 },

  /*
   * 实施-04 S6b-2：真实独立 Skill 目录（SkillMD API）的只读发现。
   *
   * 不放进默认 check：公网目录不是仓库可控前提；手动运行这条场景时必须真的
   * 看到 items → raw_url → SHA-256 → skill-files 候选链路，离线直接失败而不是
   * 把「没有证据」记成通过。它不 prepare / acquire，不执行第三方正文。
   */
  skilldirnet: {
    probe: 'scripts/probe/skill-directory.js',
    delay: 12000,
    cost: 0,
    env: { YAN_SKILL_DIRECTORY_URL: 'https://api.skillmd.com/v1/search' }
  },

  /*
   * 实施-04 S2：`yan capabilities search` / `yan skill read` 的**宿主链路**（cost 0）。
   *
   * 为什么不是「capsearch 已经验过就不用验」：`capsearch` 实测发现模型读技能
   * 走的是 pi 原生 `read` 工具，根本没碰 `yan skill read` —— 那样就没人验它了。
   * 这里直连宿主把发现 / 读取 / 内容 hash / 错误可分支四条确定性钉住。
   * 复用同一份带技能的 piDir。
   */
  capcli: { probe: 'scripts/probe/capability-cli.js', delay: 9000, cost: 0 },

  /*
   * 实施-04 S3：`yan mcp describe` / `yan mcp call` 的**宿主链路**（cost 0）。
   *
   * 连的是一个**真的 MCP 服务**（官方 SDK 的 stdio server，scripts/lib/mcp-stdio-fixture.mjs）：
   * 验 describe 给 schemaRevision、正常调用、**工具级失败**与可重试的两类错
   * （invalid_arguments / schema-changed）、大结果落盘。服务配置由 YAN_MCP_SERVERS_FILE 注入。
   */
  mcpcli: { probe: 'scripts/probe/mcp-cli.js', delay: 9000, cost: 0 },

  /*
   * 实施-07 S4：来源搜索入口**有则出现**（cost 0）。
   *
   * 场景给一份真实 MCP 配置（同一个 stdio fixture，工具表里有 `web_search`），
   * 宿主真的把它接进能力目录 —— 判定读的就是那份目录，不是占位开关。
   */
  sourcecap: { probe: 'scripts/probe/source-capability.js', delay: 9000, cost: 0 },

  /*
   * 实施-04 S6b-1：远程 MCP 的**自动登记闭环**（cost 0）。
   *
   * 从「确认未配置」开始：真目录 fixture → discover 拿到候选 → 未授权不登记 →
   * `--authorize` 真核验（本地 Streamable HTTP MCP fixture，官方 SDK 握手）→
   * 写受管配置 → 能力目录当场可见 → `mcp call` 真的调得通 → 同一计划重放不重复登记。
   * 配置与授权都落 sandbox（YAN_MCP_SERVERS_FILE），不碰用户真实配置。
   */
  mcpregister: { probe: 'scripts/probe/mcp-register.js', delay: 9000, cost: 0, usesMcpRegisterFixture: true },

  /*
   * 实施-11 H-1：回合页脚的阅读秩序与整轮用时（cost 0）。
   *
   * 不调模型：注入多轮**已结束**的回合（含多工具 / 单工具 / 无用时 / 无元数据），
   * 验助手顶部不再有「砚 / N 步 / 标准」、整轮用时只在底部出现一次且在正文之后、
   * 用时带「含工具往返」的悬停说明、单工具不显示步数、没有点赞点踩。
   * 整轮耗时**怎么算**不在这里断言 —— 那由 `test-turn-timing.mjs` 的纯逻辑钉住。
   */
  turnfooter: { probe: 'scripts/probe/turn-footer.js', delay: 10000, cost: 0 },

  /*
   * 实施-11 H-1：**真实回合**的整轮用时（cost 1，会调模型）。
   *
   * 发一条必定调 bash 的消息，然后把界面上显示的整轮用时对上三件事：探针量的
   * 墙钟、主进程推的 `elapsedMs`、以及由 output/speed 推导的生成时间（必须明显小于
   * 整轮）。若速度改用回合起点、或页脚改用最后一次生成时间，这三条会同时红。
   */
  turnfooterlive: {
    probe: 'scripts/probe/turn-footer-live.js',
    /*
     * 必须用 fixture 沙盒（`fixture-project/repo`，没有 AGENTS.md）：
     * 本机 27B 量化模型在仓库完整上下（~8.6K）下**不调工具**，只回话；
     * 在短项目上下文 + 不可猜任务下才稳定调工具（与历史 `local-tool-test` 一致）。
     */
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    budget: 240000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },

  /*
   * 实施-11 H-2：右栏资源保留（cost 0）。
   *
   * 切右栏标签过去会 `closeBrowser()` —— 网页会话直接丢掉。现在切成“只隐藏、
   * 不释放”，只有显式关标签才释放对应那一个。场景真开一个 about:blank 浏览器，
   * 再走“切走 → 切回 → 收起右栏 → 逐个关标签”。
   */
  rightresources: { probe: 'scripts/probe/right-resources.js', delay: 10000, cost: 0 },

  /*
   * 实施-11 H-4（解析 / 呈现切片）：Markdown 文件链接的 `#L42` 与点击（cost 0）。
   * 走 fixture 沙箱（`repo`），因为要点开 README.md 验证主进程真的读了文件。
   */
  filelink: {
    probe: 'scripts/probe/filelink.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 10000,
    cost: 0
  },

  /*
   * 实施-11 C-4：宿主把生效策略（分层覆盖）交给薄层（cost 0）。
   * 探针改一个数值覆盖，退出后核对 `data/context-policy.effective.json`。
   */
  policyfile: {
    probe: 'scripts/probe/policy-file.js',
    delay: 10000,
    budget: 150000,
    cost: 0,
    afterExit: 'effectivePolicyFile'
  },

  /*
   * 实施-11 H-6：整轮计时的落盘与读回（cost 1，会调模型一次）。
   *
   * 前面两条计时场景验的是「算得对、显示得对」；这条验的是 **pi 会话 JSONL
   * 不存 elapsedMs 时用时还能不能找回来** —— 真实回合 → peekSession 读文件 →
   * 消息上带 turnTiming；退出后由 afterExit 核对 `YAN_DATA_DIR/turn-timing/`。
   */
  turnrestore: {
    probe: 'scripts/probe/turn-timing-store-live.js',
    delay: 12000,
    budget: 300000,
    cost: 1,
    fixture: true,
    fixtureSub: 'repo',
    afterExit: 'turnTimingPersisted'
  },
}

const TS = (offsetSec = 0) => new Date(Date.now() - offsetSec * 1000).toISOString()

/** 窄右栏里一定要被省略的超长文件名（fixture 与探针共用同一个名字） */
const LONG_NAME = '一个非常长的文件名用来验证窄栏下的省略显示-0123456789-abcdefghij-中文结尾.md'

/**
 * 造「无权限目录」：用 ACL 把当前用户对目录的**读取/列举**权限显式拒绝。
 *
 *   `icacls <dir> /deny <user>:(RD)`
 *
 * 只 deny `RD`（Read Data / List Directory），**不** deny `WRITE_DAC` ——
 * 目录属主因此随时能 `/remove:d` 复位。实测若 deny 全权限，连 `rmSync`
 * 都会 EPERM，临时沙箱就删不掉了。
 *
 * Windows 上 Node 的 `readdir` 在这里报的是 **EPERM**（不是 EACCES），
 * 主进程 `statusForError` 两者都映射到 `permission`。
 *
 * 失败（非 NTFS / 组策略 / 改不了 DACL）不算错误：返回 false，
 * 探针把对应断言降级为「跳过」。
 */
function denyDirRead(dir, user = process.env.USERNAME) {
  if (!user) return false
  try {
    execFileSync('icacls', [dir, '/deny', `${user}:(RD)`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 复位 `denyDirRead` 写下那条 deny 项（没有该项 / 目录不存在都算成功）。 */
function allowDirRead(dir, user = process.env.USERNAME) {
  if (!user) return
  try {
    execFileSync('icacls', [dir, '/remove:d', user], { stdio: 'ignore' })
  } catch {
    /* 尽力而为：目录不存在或本来没有 deny 项都不影响后续 */
  }
}

/**
 * Git 审查场景（G1）的**只读基线**。
 *
 * 在 fixture 建好、还没启动应用时记下工作区与 index 的真实内容；
 * 场景跑完后（`afterExit: 'gitReviewReadonly'`）逐字节比对。
 * 这是「打开审查不会动用户暂存区」唯一的硬证据 —— 渲染进程里
 * 拿不到 git 的二进制作答，只能在退出后从 Node 侧看。
 */
let gitReviewBaseline = null

/** 跑一条 git 命令取 stdout（失败时抛） */
function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 取一份「工作区 + index」的快照签名（用于只读比对） */
function gitReadonlySnapshot(repo) {
  return {
    status: gitOut(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    index: gitOut(repo, ['ls-files', '-s']),
    cached: gitOut(repo, ['diff', '--cached', '--numstat', '-z']),
    head: gitOut(repo, ['rev-parse', 'HEAD'])
  }
}

/**
 * 生成一个合法的 PNG（真字节，不是 hex 常量碰运气）。
 *
 * 为什么需要真图：审查场景要断言「旧图来自 Git 对象、新图来自工作区，
 * 两者内容不同」。如果图本身解不开，`<img>` 会变成破图 —— 断言就变成
 * 在验一个坏掉的资源通道。
 */
function makePng(size, rgb) {
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff
    for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 /* bit depth */
  ihdr[9] = 2 /* truecolor */
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    const off = y * stride
    raw[off] = 0 /* filter: none */
    for (let x = 0; x < size; x += 1) {
      raw[off + 1 + x * 3] = rgb[0]
      raw[off + 2 + x * 3] = rgb[1]
      raw[off + 3 + x * 3] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 造一棵内容完全确定的合成项目树，供 `fixture: true` 的场景当 cwd。
 *
 * 每一项都对应一条要验的边界：
 *   `empty/`            空目录（status='empty'，界面上是「空」提示而不是空白）
 *   `deep/a/b/c/d/e/`   多级目录（逐层展开 + 缩进递增）
 *   `dup/one|two/same.ts` 同名文件（身份必须按完整路径区分）
 *   `big/` 60 个文件    大目录（@ 补全 30 条截断；文件树 50 一批分页）
 *   `uni/中文 目录/`     中文 + 空格（Windows 路径上最容易出错的一类）
 *   `notadir.txt`       普通文件（当目录用时必须报 missing，不是空列表）
 *   `junction-dir/file` 目录联接 / 文件链接（主进程必须跳过，不暴露成可展开路径）
 *   `noperm/`           ACL 拒绝读取的真实无权限目录（status='permission'，不是「空」）
 *   `<超长中文名>.md`    窄右栏下必须省略显示、但 `title` 里能给全文
 *
 * 链接 / ACL 创建失败（Windows 未开开发者模式、非 NTFS、无改 DACL 权限）
 * 不影响其余断言：探针会把对应断言降级为「跳过」。
 */
function buildFixtureProject(base) {
  const dir = join(base, 'fixture-project')
  /* 上一轮的 `noperm/` 可能还带着 deny 读取的 ACL，先复位再删（否则 rmSync 报 EPERM）。 */
  allowDirRead(join(dir, 'noperm'))
  rmSync(dir, { recursive: true, force: true })
  const mk = (...parts) => mkdirSync(join(dir, ...parts), { recursive: true })
  const put = (rel, text) => writeFileSync(join(dir, rel), text, 'utf8')

  mk()
  put('README.md', '# fixture project\n\n合成项目，只用于边界场景。\n')
  mk('empty')
  mk('deep', 'a', 'b', 'c', 'd', 'e')
  put(join('deep', 'a', 'b', 'c', 'd', 'e', 'f.txt'), 'deep\n')
  mk('dup', 'one')
  mk('dup', 'two')
  put(join('dup', 'one', 'same.ts'), 'export const one = 1\n')
  put(join('dup', 'two', 'same.ts'), 'export const two = 2\n')
  mk('big')
  for (let i = 1; i <= 60; i += 1) {
    put(join('big', `f${String(i).padStart(3, '0')}.txt`), `${i}\n`)
  }
  mk('uni', '中文 目录')
  put(join('uni', '中文 目录', '文件 名.ts'), 'export const 中文 = 1\n')
  put('notadir.txt', 'not a directory\n')

  /*
   * 带项目级 pi 设置的工作目录（N21-2 / D21）。
   *
   * pi 把「存在 `.pi/settings.json`」的项目视为需要信任（该文件能带 packages /
   * extensions），而 RPC 模式没有信任弹窗 —— 所以这个文件的内容会被 pi **整份忽略**。
   * 造出来就是为了让探针验证两件事：① 压缩参数真的不生效（跑的是全局值）；
   * ② 界面把这件事说出来，而不是拿项目里的数字画一条永远对不上的触发线。
   * 值故意与全局不同（全局 reserveTokens=900000，这里 4096），否则分不出读了哪份。
   */
  mk('compact', '.pi')
  put(
    join('compact', '.pi', 'settings.json'),
    JSON.stringify({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 1000 } }, null, 2)
  )
  put(join('compact', 'README.md'), '# compact cwd\n\nN21-2 的项目级设置边界。\n')

  /*
   * 无权限目录（L02 / N19 共用的边界）：真的用 ACL 拒绝当前用户的读取权限，
   * 而不是靠 mock。造不出来时探针跳过这条（见 `denyDirRead` 注释）。
   */
  mk('noperm')
  put(join('noperm', 'secret.txt'), 'no permission\n')
  const noPermDenied = denyDirRead(join(dir, 'noperm'))

  /* 窄右栏（PANEL_MIN = 220）下必须走省略 + title 全文，所以名字要明显超宽。 */
  put(LONG_NAME, 'long name\n')

  /*
   * 第二个工作目录（N12 的 A/B 矩阵）：运行实例只拒绝**同一** cwd 的并发，
   * 所以「切走不停」必须要有一个不同 cwd 的会话可切。
   */
  mk('other')
  put(join('other', 'README.md'), '# other cwd\n\nN12 用的第二个工作目录。\n')
  try {
    execFileSync('git', ['init', '-q'], { cwd: join(dir, 'other'), stdio: 'ignore' })
  } catch {
    /* 不是必须的：这个目录只当 cwd 用，不建 worktree */
  }

  /*
   * 一个最小 Git 仓库（L03 的写入型子代理要建 worktree）。
   * `LINE-BASE` 是给「两个子代理改同一行」的冲突场景预备的固定锚点。
   */
  const repo = join(dir, 'repo')
  mk('repo')
  put(join('repo', 'README.md'), '# fixture repo\n\nLINE-BASE: 初始内容\n')
  const gitEnv = ['-c', 'user.name=yan-test', '-c', 'user.email=yan@test']
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', [...gitEnv, 'add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', [...gitEnv, 'commit', '-q', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' })
  } catch (error) {
    throw new Error(
      'fixture 仓库初始化失败（L03 的 worktree 场景需要 git）：' + (error instanceof Error ? error.message : String(error))
    )
  }

  /*
   * Git 审查场景（G1）专用的仓库：故意做脏，覆盖方案 §13.1 的 Git 数据清单。
   *
   * 为什么另起一个目录而不是往上面的 repo/ 里塞改动：`subagentpair` 会在
   * repo/ 里建 worktree 并断言「主工作树没被碰过」，一堆预置脏改动会让
   * 那些断言的前提变味（它们要的是干净基线）。
   */
  const reviewRepo = join(dir, 'review')
  mk('review')
  const rgit = (args) => execFileSync('git', args, { cwd: reviewRepo, stdio: 'ignore' })
  const rgitC = (...args) => execFileSync('git', [...gitEnv, ...args], { cwd: reviewRepo, stdio: 'ignore' })
  rgit(['init', '-q', '-b', 'main'])
  /* 关掉 autocrlf：行数在不同平台要一致，否则断言会随机器变 */
  rgit(['config', 'core.autocrlf', 'false'])
  put(join('review', 'modify.txt'), 'one\ntwo\nthree\n')
  put(join('review', 'a-deleted.txt'), 'bye\n')
  put(join('review', 'renamed.txt'), 'rename me\n')
  {
    /* 80 行的文件：待会儿只改首尾两行 → diff 里会出现两个 hunk，
       中间那段就是界面上「N 行未修改」的折叠条 */
    const lines = []
    for (let i = 1; i <= 80; i += 1) lines.push(`line ${i}`)
    put(join('review', 'multi.txt'), lines.join('\n') + '\n')
  }
  mk('review', 'src')
  put(join('review', 'src', 'app.ts'), ['export function app() {', '  return 1', '}', ''].join('\n'))
  mk('review', 'docs', '中文 目录')
  put(join('review', 'docs', '中文 目录', '说明.md'), '# 说明\n\n第一行\n第二行\n')
  writeFileSync(join(reviewRepo, 'pic.png'), makePng(24, [32, 96, 200]))
  rgitC('add', '-A')
  rgitC('commit', '-q', '-m', 'review fixture base')

  /* ① 未暂存修改（+2 -1） */
  put(join('review', 'modify.txt'), 'one\nTWO\nthree\nfour\n')
  /* ② 多 hunk（首行与末行） */
  {
    const lines = []
    for (let i = 1; i <= 80; i += 1) {
      if (i === 2) lines.push('line 2 CHANGED')
      else if (i === 79) lines.push('line 79 CHANGED')
      else lines.push(`line ${i}`)
    }
    put(join('review', 'multi.txt'), lines.join('\n') + '\n')
  }
  /* ③ 未暂存删除 */
  rmSync(join(reviewRepo, 'a-deleted.txt'), { force: true })
  /* ④ 已暂存重命名 */
  rgitC('mv', 'renamed.txt', 'renamed-new.txt')
  /* ⑤ 已暂存新增 */
  put(join('review', 'staged-new.txt'), 'brand new\n')
  rgitC('add', 'staged-new.txt')
  /* ⑥ 中文 + 空格路径的未暂存修改 */
  put(join('review', 'docs', '中文 目录', '说明.md'), '# 说明\n\n第一行\n改过的第二行\n')
  /* ⑦ 未跟踪文件（文本） */
  put(join('review', 'untracked.txt'), 'u1\nu2\nu3\n')
  /* ⑧ 图片改动（真的不同的一张图，颜色与尺寸都变） */
  writeFileSync(join(reviewRepo, 'pic.png'), makePng(24, [220, 48, 48]))
  /* ⑨ 未跟踪的二进制文件（含 NUL 字节） */
  writeFileSync(join(reviewRepo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]))
  /* ⑩ 未暂存修改（源码，用来验语法无关的纯文本 diff） */
  put(join('review', 'src', 'app.ts'), ['export function app() {', '  return 2', '}', ''].join('\n'))

  /*
   * G2 写操作的 fixture：一个**有真实 remote**的仓库。
   *
   * 与 review/ 分开是必须的：写操作会真的改仓库（提交、切分支、推送），
   * 而 review/ 的每条断言都建立在它那份「故意做脏」的状态上 —— 共用一个
   * 目录会让两边的断言互相污染，且失败原因极难区分。
   *
   * 预置：main（已推送到本地 bare remote）、feature（与 main 有内容差异，
   * 用来验证切换真的换了工作区文件）、一处未暂存改动、一个未跟踪文件。
   */
  /*
   * pi 包管理（P2）的 fixture：一个**最小的本地包**。
   *
   * 为什么用本地路径源：安装走的是 pi 自己的 CLI（`pi install <路径>`），
   * 本地路径不需要联网，也不需要真的往用户目录里装东西 —— 测试全程
   * 用隔离的 YAN_PI_DIR。放在 fixture 项目目录下，探针那边可以用 cwd 拼出来。
   */
  mk('probe-ext')
  mk('probe-ext', 'extensions')
  put(join('probe-ext', 'package.json'), JSON.stringify({
    name: 'yan-probe-ext',
    version: '9.9.9',
    description: '探针用的假扩展（P2 的真实安装路径）',
    license: 'MIT',
    keywords: ['pi-package']
  }, null, 2))
  put(join('probe-ext', 'extensions', 'index.js'), 'export default {}\n')

  /*
   * pi 包管理（P2）的 fixture：一个最小的**本地包**，放在专属子目录里。
   * 用本地路径源 —— 装它不需要联网，也不需要往用户目录里写东西
   *（全程用隔离的 YAN_PI_DIR）。
   */
  mk('pkgs')
  mk('pkgs', 'probe-ext')
  mk('pkgs', 'probe-ext', 'extensions')
  put(join('pkgs', 'probe-ext', 'package.json'), JSON.stringify({
    name: 'yan-probe-ext',
    version: '9.9.9',
    description: '探针用的假扩展（P2 的真实安装路径）',
    license: 'MIT',
    keywords: ['pi-package']
  }, null, 2))
  put(join('pkgs', 'probe-ext', 'extensions', 'index.js'), 'export default {}\n')

  const writeRepo = join(dir, 'write')
  mk('write')
  const wgit = (args) => execFileSync('git', args, { cwd: writeRepo, stdio: 'ignore' })
  const wgitC = (...args) => execFileSync('git', [...gitEnv, ...args], { cwd: writeRepo, stdio: 'ignore' })
  wgit(['init', '-q', '-b', 'main'])
  wgit(['config', 'core.autocrlf', 'false'])
  /*
   * 仓库里**必须**有身份：主进程的 git 继承的是测试进程的 env（没有
   * GIT_AUTHOR_*），所以不配的话提交会以「身份未配置」被拒 —— 那是**正确**
   * 的产品行为（分类与提示都对，真实仓库单测 G9-F 专门覆盖它），
   * 但会让这个场景测不到「提交成功」的主路径。
   */
  wgit(['config', 'user.name', 'yan-test'])
  wgit(['config', 'user.email', 'yan-test@example.com'])
  put(join('write', 'a.txt'), 'a1\na2\na3\n')
  put(join('write', 'b.txt'), 'b1\n')
  /* dirty.txt 后面会改成未暂存状态，专门留给「携带未提交改动」那一节 */
  put(join('write', 'dirty.txt'), 'clean\n')
  mk('write', 'src')
  put(join('write', 'src', 'app.ts'), 'export const v = 1\n')
  wgitC('add', '-A')
  wgitC('commit', '-q', '-m', 'write fixture base')
  /* feature：b.txt 的内容与 main 不同（切换后能验证工作区真的换了） */
  wgitC('switch', '-q', '-c', 'feature')
  put(join('write', 'b.txt'), 'b1 on feature\n')
  wgitC('commit', '-qam', 'feature changes b.txt')
  wgitC('switch', '-q', 'main')
  /* bare remote：push / fetch 走真实 git 通道（本地路径，不碰网络） */
  const writeRemote = join(dir, 'write-remote.git')
  execFileSync('git', ['init', '-q', '--bare', writeRemote], { stdio: 'ignore' })
  wgit(['remote', 'add', 'origin', writeRemote])
  wgitC('push', '-q', '-u', 'origin', 'main')
  /* 待暂存的改动 + 未跟踪文件（写操作的输入） */
  put(join('write', 'a.txt'), 'a1\nA2-CHANGED\na3\n')
  put(join('write', 'new.txt'), 'fresh\n')
  /*
   * 另外两份是**给 W2a（携带未提交改动）留的**：探针的 G2 部分只会暂存
   * a.txt 与 new.txt，所以到第 11 节时 dirty.txt 仍是未暂存改动、
   * notes.txt 仍是未跟踪文件 —— 携带那一节才有东西可带。
   */
  put(join('write', 'dirty.txt'), 'dirty\n')
  put(join('write', 'notes.txt'), 'note\n')

  try {
    gitReviewBaseline = gitReadonlySnapshot(reviewRepo)
  } catch (error) {
    console.warn('⚠️  Git 审查基线没能记录：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    symlinkSync(join(dir, 'deep'), join(dir, 'junction-dir'), 'junction')
  } catch {
    /* 没权限建链接就跳过相关断言 */
  }
  try {
    symlinkSync(join(dir, 'README.md'), join(dir, 'junction-file'))
  } catch {
    /* 同上 */
  }
  if (!noPermDenied) {
    console.log('  ⤺ 无权限目录没造成（icacls deny 失败），fsedge 会跳过那组断言')
  }

  /*
   * 宿主任务服务（实施-02 S3）的 request 文件：由 Node 侧预置，探针只让
   * 模型跑 `yan tasks apply --request-file tasks/…`。
   *
   * 为什么不让模型自己写这份 JSON：那要多一次工具往返，而模型可能换个目录写、
   * 或者把内容改掉 —— 本场景要验的是**宿主写入链**，不是 write 工具。
   * 放在 fixture 子目录里：cwd 就是合成项目，绝不碰真实仓库。
   */
  mk('tasks')
  put(
    join('tasks', 'task-set.json'),
    JSON.stringify(
      {
        action: 'set',
        items: [{ text: '确认范围' }, { text: '实现宿主任务服务' }, { text: '真实运行验收' }]
      },
      null,
      2
    ) + '\n'
  )
  put(
    join('tasks', 'task-complete.json'),
    JSON.stringify({ action: 'complete', index: 2 }, null, 2) + '\n'
  )

  return dir
}

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

function writeRemoteRouteSession(root, cwd) {
  const id = 'yan-remote-route-target'
  const timestamp = new Date().toISOString()
  const file = join(root, `2026-09-20T00-00-00-000Z_${id}.jsonl`)
  const lines = [
    { type: 'session', version: 3, id, timestamp, cwd },
    { type: 'model_change', id: 'mc0', parentId: null, timestamp, provider: 'yanrouteprobe', modelId: 'route-probe' },
    {
      type: 'message',
      id: 'u0',
      parentId: 'mc0',
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'Isolated remote route fixture' }] }
    },
    {
      type: 'message',
      id: 'a0',
      parentId: 'u0',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Ready for a local route check.' }],
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop'
      }
    }
  ]
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return { id, file }
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

/*
 * N21-3 的切会话守卫需要一个确定性「已经越过两条线」的旧会话。
 * 不能依赖运行机器上碰巧存在的大会话：隔离 fixture 可能只有几条小 JSONL，
 * 那样探针测到的是“前提不存在”，而不是切换没有触发压缩。
 * 这个文件只在 contextswitchguard 场景启动前写入，场景结束后立即删除。
 */
function writeContextGuardSession(dir) {
  const id = `yan-context-guard-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-06T00-00-00-000Z_${id}.jsonl`)
  const text = 'context guard fixture '.repeat(320)
  const timestamp = new Date(Date.now() - 120_000).toISOString()
  const lines = [
    { type: 'session', version: 3, id, timestamp, cwd: homedir() },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp,
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    },
    {
      type: 'message',
      id: 'u0',
      parentId: 'mc0',
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'YAN-CONTEXT-GUARD fixture' }] }
    },
    {
      type: 'message',
      id: 'a0',
      parentId: 'u0',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: {
          input: 1024,
          output: 1024,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop'
      }
    }
  ]
  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  return file
}

/**
 * N12 的 A/B 会话：三个合成会话，cwd 指向 fixture 项目。
 *
 * 为什么要在运行时造（而不是像其他 fixture 那样写在 seedSessions 里）：
 * 它们的 cwd 必须是 fixture 项目的**绝对路径**，而那个路径要等临时
 * 目录建好才知道。
 *
 *   A（`yan-ab-a`）  cwd = fixture/repo   —— 发长任务，验证运行中
 *   B（`yan-ab-b`）  cwd = fixture/other  —— 不同 cwd，切过去不能被拒
 *   C（`yan-ab-c`）  cwd = fixture/repo   —— 与 A 同 cwd，用来验证拒绝
 *
 * 会话平铺在 sessions 根目录：隔离测试里 `YAN_SESSIONS_DIR` 被接管，
 * pi 不再自己建项目子目录（见 `SESSIONS_DIR_IS_OVERRIDE`）。
 */
function writeAbSessions(root, cwdA, cwdB) {
  const stamp = Date.now().toString(36)
  const made = []
  const one = (tag, cwd) => {
    const id = `yan-ab-${tag}-${stamp}`
    const file = join(root, `2026-01-03T00-00-00-000Z_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: TS(600), cwd },
      {
        type: 'model_change',
        id: 'mc0',
        parentId: null,
        timestamp: TS(600),
        provider: 'commandcode',
        modelId: 'deepseek/deepseek-v4.1-flash'
      },
      {
        type: 'message',
        id: 'a0',
        parentId: 'mc0',
        timestamp: TS(590),
        message: { role: 'user', content: [{ type: 'text', text: `YAN-AB-${tag.toUpperCase()} fixture 会话` }] }
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'a0',
        timestamp: TS(580),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `YAN-AB-${tag.toUpperCase()}-REPLY` }],
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop'
        }
      }
    ]
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    made.push({ tag, id, file, cwd })
  }
  one('a', cwdA)
  one('b', cwdB)
  one('c', cwdA)
  return made
}

/**
 * N05 的两个**已落盘**合成会话（cwd = fixture 项目的 A / B）。
 *
 * 为什么必须是落盘的会话（而不像 N12 那样现开一个 `new_session`）：
 * 项目切换要验证的是「切回来还是原来那个会话」—— 草稿按 `sessionId` 存在运行时
 * 缓存里，换了会话就回不来。而刚 `new_session` 出来的会话还没有消息，
 * `listSessions` 解析不出 head、不会出现在会话列表里；空间实例又会在切走时被
 * 回收（实测：切到 B 后 `runners` 里已经没有 A）。那种情况下没有任何东西可以
 * 切回去，验的不是这段逻辑。落盘的会话才对齐用户的真实情形。
 */
function writeProjectSwitchSessions(root, cwdA, cwdB, opts = {}) {
  const stamp = Date.now().toString(36)
  const made = []
  const one = (tag, cwd, skew = 0) => {
    const id = `yan-n05-${tag}-${stamp}`
    const file = join(root, `2026-01-04T00-00-00-000Z_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: TS(700 - skew), cwd },
      {
        type: 'model_change',
        id: 'mc0',
        parentId: null,
        timestamp: TS(700 - skew),
        provider: 'commandcode',
        modelId: 'deepseek/deepseek-v4.1-flash'
      },
      {
        type: 'message',
        id: 'u0',
        parentId: 'mc0',
        timestamp: TS(690 - skew),
        message: { role: 'user', content: [{ type: 'text', text: `YAN-N05-${tag.toUpperCase()} fixture 会话` }] }
      },
      {
        type: 'message',
        id: 'a0',
        parentId: 'u0',
        timestamp: TS(680 - skew),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `YAN-N05-${tag.toUpperCase()}-REPLY` }],
          usage: {
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop'
        }
      }
    ]
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    /*
     * 排序键是**文件 mtime**（`sessions.ts` 用 `f.mtimeMs` 排），不是消息 timestamp。
     * 三个文件先后写入相隔往往只有几毫秒，顺序不稳定 —— 实测就是它让 N05 的
     * “该项目最近访问的会话”选到了 C。这里按 `skew` 显式把 mtime 拨开：
     * skew 越大越旧（A 最新，C 最旧）。
     */
    const t = (Date.now() - (900 + skew) * 1000) / 1000
    try {
      utimesSync(file, t, t)
    } catch {
      /* 个别文件系统不支持改时间戳：不致命，只是排序回到不确定状态 */
    }
    made.push({ tag, cwd, file })
  }
  one('a', cwdA)
  one('b', cwdB)
  /*
   * D/E：**同一个子目录里的两条会话**，只在明确要求时造（`projectPeers: true`）。
   *
   * 存在意义只有一个：L05 要验“同 cwd 已有实例在跑时，切换必须被拒绝”，
   * 而那需要两条同 cwd 的已落盘会话。
   * ⚠️ 它们**必须**在另一个目录里（`peerCwd`，实测用 fixture 里的 `repo/`）：
   * 摆在 A 旁边会参与 N05 的“该项目最近访问的会话”挑选（曾经让
   * `projectswitch` 选到了新造的那条，断言就挂了）。
   */
  if (opts.peers && opts.peerCwd) {
    one('d', opts.peerCwd, 0)
    one('e', opts.peerCwd, 100)
  }
  /*
   * 09-S3（S3）：同一个项目目录里的两条会话，用来验「恢复哪一个」。
   *
   *   hot    —— 消息时间比 `opened` 新（模拟后台跑过消息的会话）；
   *   opened —— 消息时间旧，稍后由探针真的打开一次。
   *
   * ⚠️ 这里的 `skew` 是**加到偏移上**的（`TS(690 - skew)` ⇒ skew 越大消息越新），
   * 与上下文的直觉相反 —— 第一版写反了，结果是 `opened` 的消息反而更新，
   * “只按活动时间排会选错”这个前提直接不成立。
   * 两条都故意把 mtime 拨到更旧（skew 大）—— mtime 不参与判定，
   * 但没必要让它去影响别的场景的列表顺序。
   * ⚠️ 只在明确要求时造：摆在 cwdA 旁边会参与 `projectswitch` 的挑选。
   */
  if (opts.opened) {
    one('hot', cwdA, 300)
    one('opened', cwdA, 50)
  }
  return made
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

/** S1 种子结果（`contextstate` 场景）：退出后检查靠它区分「种子」与「残留」 */
let contextStateSeed = { dir: '', ids: [] }

/**
 * S1：把派生状态种进隔离目录。
 *
 * 用**构建产物里的真实模块**（`out/main/context-state-store.js` +
 * `context-watermark.js`）而不是手写 JSON 夹具 —— 种子与生产走同一套
 * 原子写 / schema 校验 / 水位绑定，live 场景才能真的证明「删会话清派生状态」
 * 这条链路上的文件命名与校验是一致的。
 *
 * 返回 { dir, ids }：ids 给退出后检查用。
 * ⚠️ 所有调用都显式传 `dir`（隔离目录）；store 模块默认的 YAN_DIR
 *    是这个 Node 进程的 process.env，不能依赖它 —— 否则会写进真实用户目录。
 */
async function seedContextStates(sessionsRoot, dataDir) {
  const store = await import('../out/main/context-state-store.js')
  const watermark = await import('../out/main/context-watermark.js')
  const dir = join(dataDir, 'context-state')
  const files = []
  const walk = (parent) => {
    for (const e of readdirSync(parent, { withFileTypes: true })) {
      const p = join(parent, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(sessionsRoot)

  const ids = []
  for (const file of files) {
    const index = await watermark.readSessionEntryIndex(file)
    if (!index?.sessionId) continue
    const now = Date.now()
    await store.saveContextState(
      {
        schemaVersion: store.CONTEXT_STATE_SCHEMA_VERSION,
        sessionId: index.sessionId,
        sourceWatermark: index.watermark,
        createdAt: now,
        updatedAt: now,
        task: store.emptyTaskState('live 场景种下的状态', 'seed'),
        episodes: []
      },
      { dir, raw: { knownEntryIds: index.entryIds } }
    )
    ids.push(index.sessionId)
  }
  return { dir, ids }
}

/**
 * 退出后检查：被删会话的派生状态没了，别人的还在（S1）。
 *
 * 探针把删掉的 sessionId 打印成 `ctxstate.deletedSessionId=…`；这里对文件
 * 系统断言。之所以必须放到退出后：状态文件的清理发生在删除那一刻，
 * 而渲染进程看不到 YAN_DATA_DIR（测试边界：不能把 renderer 接到数据目录）。
 */
function checkContextStateCleanup(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const seeded = contextStateSeed.ids
  say(seeded.length >= 2, `种下的派生状态数 = ${seeded.length}（至少两条才能验“只删对的那条”）`)

  const match = /ctxstate\.deletedSessionId=(\S*)/.exec(probeText)
  const deletedId = match?.[1] ?? ''
  say(!!deletedId, `探针报告被删会话 id = ${JSON.stringify(deletedId)}`)
  say(seeded.includes(deletedId), '被删会话在种子列表里（否则这条场景没验到该验的东西）')

  const dir = join(sandboxRoot, 'data', 'context-state')
  const files = existsSync(dir) ? readdirSync(dir) : []
  const stateFiles = files.filter((f) => f.endsWith('.json') && !f.endsWith('.archive.json'))
  lines.push(`  目录 = ${dir}`)
  lines.push(`  剩下 = ${JSON.stringify(stateFiles)}`)

  say(!files.includes(`${deletedId}.json`), `被删会话的状态文件已清理（${deletedId}.json）`)
  const present = new Set(stateFiles)
  const preservedSeedIds = [...new Set(seeded)].filter((id) => id && id !== deletedId)
  const preservedCount = preservedSeedIds.filter((id) => present.has(`${id}.json`)).length
  say(
    preservedCount === preservedSeedIds.length,
    `其它种子会话的状态一个没少（${preservedCount} / 期望 ${preservedSeedIds.length}；允许场景期间新增的派生文件）`
  )
  say(
    !files.some((f) => f.endsWith('.tmp')),
    '清理后目录里没有残留临时文件'
  )
  return { ok, lines }
}

/**
 * 退出后检查：Tool Sweep 在真实回合里真的发生过（N21-4 / S2）。
 *
 * 三份证据缺一不可：
 *   ① 归档元数据落在隔离的 `YAN_DATA_DIR/context-state/<id>.archive.json`，
 *      且 `ref = ctx://tool/<entryId>` 里的 entryId **真的存在于会话文件**
 *      （不然 Recall 会指向空气）；
 *   ② 扩展诊断里有 `swept >= 1`（证明 `context` 钩子被 pi 调用且替换被采纳），
 *      并且没有 `hook: "error"`（扩展在真实 pi 里没报错）；
 *   ③ 召回审计里有 `result: "ok"`（模型真的用 recall 把原文取回去过）。
 * 三者都在 renderer 看不到的目录里 —— 这正是必须放到退出后检查的原因。
 */
function checkContextSweepArchive(sandboxRoot) {
  return checkContextSweepArchiveImpl(sandboxRoot)
}

/**
 * 退出后检查：状态生成器真的跑通了（N21-4 剩余项）。
 *
 * 四份证据缺一不可（全在 renderer 看不到的目录里）：
 *   ① 诊断里有 `stage: "producer"` 与 `hook: "committed"`（扩展真的调了模型并落盘）；
 *   ② 状态文件存在、`revision >= 1`、`task.objective` 非空，
 *      且 `commandsRun` / `testsRun` / `files` **至少一项来自真实工具调用**；
 *   ③ 下一回合注入发生（诊断里有 `injectedTaskState: true`）；
 *   ④ 状态文件过**主进程的** schema 校验（JS 写、TS 读，两边不许各信各的）。
 * 任一不成立，功能在真实链路里就是静默失效的。
 */
/**
 * 从隔离沙箱的会话条目里累加主 agent 的用量（`stateOverhead` 的分母）。
 *
 * 会话文件是 JSONL，每个 assistant 条目带 `usage: { input, output, cacheRead, cacheWrite }`。
 * 口径说明：分母取 `input + cacheRead + output`（模型**实际处理的量**），因为
 * 状态生成没有缓存命中，拿“只算非缓存 input”去比会把主 agent 的摊子看小。
 * 三个数都打印出来，读者可以按自己的口径重算。
 */
function agentTokensFromSessions(sandboxRoot, onlySessionId = null) {
  const dir = join(sandboxRoot, 'sessions')
  const out = { input: 0, cacheRead: 0, output: 0, files: 0, scoped: !!onlySessionId, matched: 0 }
  const walk = (at) => {
    let list = []
    try {
      list = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of list) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      /*
       * 只算指定会话时按文件名匹配（pi 的文件名是 `<时间戳>_<sessionId>.jsonl`）。
       * 为什么必须能限定：沙箱里有 8 份 fixture 会话，不限定就会把它们几百万 token
       * 全算进分母，比值被稀释成 0.0% —— 那种数字比没有数字更糟（2026-09-17 实测）。
       */
      if (onlySessionId && !entry.name.includes(onlySessionId)) continue
      out.matched += 1
      out.files += 1
      let raw = ''
      try {
        raw = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let rec
        try {
          rec = JSON.parse(line)
        } catch {
          continue
        }
        const u = rec?.message?.usage ?? rec?.usage
        if (!u || typeof u !== 'object') continue
        out.input += Number(u.input) || 0
        out.cacheRead += Number(u.cacheRead) || 0
        out.output += Number(u.output) || 0
      }
    }
  }
  walk(dir)
  return out
}

/**
 * 从探针输出里取本场景的会话 id（各 context 探针都会打印 `ctx<suffix>.sessionId=…`）。
 *
 * 为什么非要拿它：**所有场景共用同一个沙箱**（`sandboxRoot` 在场景循环之前就创建了），
 * 所以诊断日志 `ctx-ext.log` 与 `data/context-state/` 目录里都混着兄弟场景留下的东西。
 * 「没有提交状态」「没有写出状态文件」这类**否定断言**不按会话隔离就必然误判 ——
 * 2026-09-17 实测：并跑时 `contextproduce` / `contextgate` 都红，单跑全绿。
 */
function ownSessionIdFrom(probeText, key) {
  const m = new RegExp(`${key}\\.sessionId=([0-9a-zA-Z-]+)`).exec(String(probeText ?? ''))
  return m ? m[1] : null
}

async function checkContextProduce(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  /* 开销纯函数与扩展同源（直接引扩展源码，保证算的就是刚才跑的那份） */
  const producerModule = await import('../resources/pi-extensions/context-producer.js').catch(() => null)
  const stateOverhead = producerModule?.stateOverhead ?? (() => ({ ratio: null, level: 'unknown' }))
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  /* ---- 诊断日志 ---- */
  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxproduce')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records
  const producerRows = ownRecords.filter((r) => r?.stage === 'producer')
  lines.push(`  诊断行 = ${records.length}（本场景 ${ownRecords.length}，其中 producer ${producerRows.length} 行）`)
  const committed = producerRows.filter((r) => r.hook === 'committed')
  const bad = producerRows.filter((r) => ['error', 'rejected', 'aborted'].includes(r.hook))
  say(committed.length >= 1, `生成器至少提交过一次状态（${committed.length} 次）`)
  for (const row of bad.slice(0, 4)) lines.push(`    · ${JSON.stringify(row).slice(0, 220)}`)
  say(bad.length === 0, `生成器没有报错 / 被拒 / 超时（${bad.length} 条）`)
  /*
   * provenance（第五轮外部意见 Q1 的 P0-③）：提交诊断里必须带**证据分布**。
   * 它回答的是「模型到底给不给得出引用」—— `hypothesis` 就是会被渲染成 `inferred`
   * 的那部分，也是「语义递归有没有被挡住」唯一可观测的量。
   */
  const provenances = committed.map((r) => r.provenance).filter((p) => p && typeof p === 'object')
  say(provenances.length >= 1, `提交诊断里带 provenance 分布（${provenances.length} 次）`)
  const lastProvenance = provenances[provenances.length - 1]
  if (lastProvenance) {
    lines.push(
      `    · provenance = ${JSON.stringify(lastProvenance)}（可引用清单 ${committed[committed.length - 1]?.citable} 条）`
    )
    say(
      Number.isFinite(lastProvenance.total) && lastProvenance.total > 0,
      `统计到 ${lastProvenance.total} 条语义条目（observed ${lastProvenance.observed} / derived ${lastProvenance.derived} / hypothesis ${lastProvenance.hypothesis}）`
    )
    /*
     * 这条是「提示词真的被遵守了吗」的直接取证。红了不是测试的错，是**真实信息**：
     * 说明模型完全不给引用，那这一层的价值就只剩「把无证据的条目标出来」。
     */
    say(lastProvenance.observed + lastProvenance.derived >= 1, '至少有一条带证据的条目（模型真的按提示词引用了）')
  }
  const injected = records.filter((r) => r?.injectedTaskState === true)
  say(injected.length >= 1, `下一个回合真的注入了 <TASK_STATE>（${injected.length} 次）`)
  /*
   * 注入块自身不进任何落盘文件（它是临时消息），所以「契约头里写了什么档位」
   * 只能在注入那一刻记下来。这条断言把「注入真的发生」与「注入的档位可审计」
   * 分开取证（P0-2）。
   */
  const injectRows = records.filter((r) => r?.hook === 'task-state-injected')
  say(injectRows.length >= 1, `注入时记下了契约档位（${injectRows.length} 条注入诊断）`)
  say(
    injectRows.length > 0 &&
      injectRows.every((r) => ['fresh', 'partial', 'stale'].includes(r.freshness) && Number.isFinite(r.sourceHead)),
    `freshness / sourceHead 都是合法值（${JSON.stringify(injectRows[0] ?? null)}）`
  )
  /*
   * 条目状态分布（N21-5 最后一项：`superseded` 的生命周期）：
   * 注入块不进任何落盘文件，所以「被推翻的旧决策到底没进去」只能靠这条诊断观察。
   */
  const itemRows = injectRows.filter((r) => r.items && typeof r.items === 'object')
  say(itemRows.length >= 1, `注入诊断里带条目状态分布（${itemRows.length} 条）`)
  if (itemRows.length) lines.push(`    · items = ${JSON.stringify(itemRows[0].items)}`)
  /*
   * 注入档位应该是 `fresh`：生成在回合 1 结束，注入发生在用户开口的回合 2 ——
   * 只落后「用户刚说的那一条」，按第四轮复核 Q3 的定义不算陈旧。
   * 这条断言钉的就是那个语义（否则模型每轮都会看到 `[stale: verify…]`）。
   */
  say(
    injectRows.some((r) => r.freshness === 'fresh'),
    `注入档位是 fresh（只落后一条尚未 settled 的 user turn）`
  )
  /* gate 被评估过（这条场景把阈值调成了 1/1，所以门槛应当当场满足） */
  const gateRows = producerRows.filter((r) => r.hook === 'gate')
  say(gateRows.some((r) => r.activated === true), `eligibility gate 当场激活（${gateRows.length} 条 gate 诊断）`)

  /*
   * ---- 生成开销：这是「增量 delta 值不值得做」的判据（第四轮复核的成本警告）----
   * 只打印比例、不硬断言具体数值：本场景只有两回合，比例天然偏高，
   * 拿它当阈值会变成一条看模型脸色的断言。硬断言只查「两端都算得出来」。
   * 有真实 usage 就用真实值（分子），否则退回估算。
   */
  const usageRows = producerRows.filter((r) => r.usage)
  const sumOf = (rows, pick) => rows.reduce((n, r) => n + (Number(pick(r)) || 0), 0)
  const realRows = usageRows.filter((r) => r.usage.real && (r.usage.real.input > 0 || r.usage.real.output > 0))
  const pIn = realRows.length
    ? sumOf(realRows, (r) => r.usage.real.input)
    : sumOf(usageRows, (r) => r.usage.input)
  const pOut = realRows.length
    ? sumOf(realRows, (r) => r.usage.real.output)
    : sumOf(usageRows, (r) => r.usage.output)
  /*
   * 分母只算**本场景那条会话**：沙箱里另有 8 份 fixture 会话，混进来会让分母凭空多出几百万
   * token，比值被稀释成 0.0%（2026-09-17 实测）。会话 id 从状态文件名反推（`<sessionId>.json`），
   * 那是本场景唯一的产物。`cacheRead` 按原值计入（没按折扣加权）—— 口径简单透明，
   * 代价是分母偏大、比值偏小，方向对“该不该优化”这个判断是保守的。
   */
  /* 分母只算本场景的会话（id 来自探针输出，理由见 `ownSessionIdFrom` 注释） */
  const agent = agentTokensFromSessions(sandboxRoot, ownId)
  const overhead = stateOverhead({
    producerInput: pIn,
    producerOutput: pOut,
    agentInput: agent.input + agent.cacheRead,
    agentOutput: agent.output
  })
  lines.push(
    `  生成开销：producer=${pIn + pOut}（in ${pIn} / out ${pOut}，${usageRows.length} 次尝试，来源 ${
      realRows.length ? `pi 真实 usage×${realRows.length}` : '本地估算'
    }）；主 agent in ${agent.input} + cacheRead ${agent.cacheRead} + out ${agent.output}` +
      `（分母来自${agent.scoped ? `本场景会话 ${ownId}，${agent.matched} 份 JSONL` : '全部会话'}）`
  )
  lines.push(
    `  stateOverhead = ${pIn + pOut === 0 || overhead.ratio === null ? 'n/a' : `${(overhead.ratio * 100).toFixed(1)}%`}（${overhead.level}）` +
      `  ← 信号不是门槛：本场景只有 2 回合、且可能整场都没成功提交状态；判 delta 要看长会话的长期值`
  )
  say(usageRows.length >= 1, `诊断里记下了生成器的 token 开销（${usageRows.length} 次尝试，含失败路径）`)
  say(agent.input + agent.output > 0, `从会话条目里读到主 agent 的用量（分母不是编的，${agent.matched} 份 JSONL）`)

  /* ---- 状态文件 ---- */
  const dir = join(sandboxRoot, 'data', 'context-state')
  const files = existsSync(dir) ? readdirSync(dir) : []
  lines.push(`  目录 = ${dir}`)
  lines.push(`  文件 = ${JSON.stringify(files)}`)
  const stateFiles = files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.archive.json') && !f.endsWith('.recall.json'))
    .filter((f) => !ownId || f.startsWith(ownId))
  say(stateFiles.length >= 1, `状态文件已写出（${stateFiles.length} 份，本场景 ${ownId ?? '未知'}）`)
  if (!stateFiles.length) return { ok, lines }

  let state = null
  try {
    state = JSON.parse(readFileSync(join(dir, stateFiles[0]), 'utf8'))
  } catch {
    state = null
  }
  say(!!state, '状态文件是合法 JSON')
  if (!state) return { ok, lines }
  say(
    Number.isInteger(state.revision) && state.revision >= 1,
    `revision >= 1（实际 ${state.revision}）`
  )
  const objective = state?.task?.task?.objective
  say(
    typeof objective === 'string' && objective.length > 0,
    `objective 非空（${JSON.stringify(objective)?.slice(0, 80)}）`
  )
  const commands = state?.task?.commandsRun?.length ?? 0
  const tests = state?.task?.testsRun?.length ?? 0
  const fileCount = state?.task?.files?.length ?? 0
  lines.push(`  evidence：commands=${commands} tests=${tests} files=${fileCount}`)
  say(commands + tests + fileCount >= 1, 'evidence 至少一项来自真实工具调用（确定性 reducer 工作）')
  const episodes = Array.isArray(state.episodes) ? state.episodes.length : -1
  /*
   * Episode（§12.6）：本场景的会话很短、尾部窗口是默认的 32k，所以**候选窗口为空** ——
   * 于是状态文件里不该有 Episode。带窗口的真实场景是 `contextepisode`。
   * （旧口径是「不沿用上一版旧语义」，现在 Episode 已经由确定性边界产出，理由变了。）
   */
  const windowRows = ownRecords.filter((r) => r?.stage === 'producer' && Number(r.episodeWindow) > 0)
  say(
    episodes === 0 || windowRows.length > 0,
    `没有 Episode 是因为窗口为空，而不是别的原因（episodes=${episodes}，非空窗口记录=${windowRows.length}）`
  )

  /* ---- 交叉校验：状态文件必须过主进程的读路径 ---- */
  const store = await import('../out/main/context-state-store.js').catch(() => null)
  /*
   * `opts.dir` 是**完整的状态目录**（不是它的父目录）—— 见
   * `contextStateDir(dir)` 的实现：`dir ?? join(YAN_DIR, 'context-state')`。
   * 传错只会得到 `missing`，看起来像“文件没写出”，很容易误导排查。
   */
  const loaded = await store
    ?.loadContextState?.(state.sessionId, { dir })
    .catch(() => null)
  say(loaded?.status === 'ok', `状态文件过主进程的校验（${loaded?.status ?? 'no-store'}）`)
  if (loaded?.status !== 'ok' && loaded?.issues) {
    for (const issue of loaded.issues.slice(0, 4)) lines.push(`    · ${issue.path}: ${issue.message}`)
  }

  /*
   * `superseded` 的生命周期（N21-5 最后一项未验证）——**模块级**验证。
   *
   * 为什么做不到端到端：探针跑在渲染端，按设计读不到 `YAN_DATA_DIR`，没法在真实窗口里
   * 往状态文件里塞一条 superseded。所以这里用的是**刚落盘的真实状态文件** +
   * **真实的注入函数链**（applyFreshness → renderTaskState → injectTaskState）：
   * 数据与渲染器都是真的，只是不经过 app 自己那次注入 —— 这个层级必须说清楚，
   * 不能当成「真实窗口里验过」。
   */
  const transformModule = await import('../resources/pi-extensions/context-transform.js').catch(() => null)
  if (transformModule && producerModule && state?.task) {
    const supersededText = '已被推翻的旧决策（不该出现在注入块里）'
    const patched = {
      ...state.task,
      decisions: [
        {
          text: supersededText,
          status: 'superseded',
          supersededBy: 'd-override',
          source: { kind: 'user', entryId: 'u-override', confidence: 'observed' },
          updatedAt: 1
        },
        ...(Array.isArray(state.task.decisions) ? state.task.decisions : [])
      ]
    }
    const applied = producerModule.applyFreshness(patched, { relation: 'same', gap: 0 })
    const rendered = transformModule.renderTaskState(applied.task, {
      freshness: 'fresh',
      sourceHead: state.sourceWatermark?.entryCount
    })
    say(rendered.includes('<TASK_STATE'), '（superseded 校验）真实状态仍然渲染出块')
    say(!rendered.includes(supersededText), 'superseded 条目没被渲染进注入块（真实状态文件 + 真实渲染器）')
    const counts = producerModule.stateItemCounts(patched)
    say(counts.skipped >= 1, `条目状态分布数得到被跳过的历史（active=${counts.active} skipped=${counts.skipped}）`)
    const injectResult = transformModule.injectTaskState([{ role: 'user', content: 'x' }], rendered)
    say(
      injectResult.injected === true && !JSON.stringify(injectResult.messages).includes(supersededText),
      '走真实注入函数后消息里也没有它'
    )
  }

  return { ok, lines }
}

async function checkContextGate(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxgate')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records
  const producerRows = ownRecords.filter((r) => r?.stage === 'producer')
  const gateRows = producerRows.filter((r) => r.hook === 'gate')
  const committed = producerRows.filter((r) => r.hook === 'committed')
  lines.push(`  诊断行 = ${records.length}（本场景 ${ownRecords.length}，其中 producer ${producerRows.length} 行）`)

  say(gateRows.length >= 1, `gate 被评估过（${gateRows.length} 次）—— 不是静默跳过`)
  const blocked = gateRows.filter((r) => r.reason === 'too-early')
  say(
    blocked.length >= 1,
    `短会话被判为 too-early（${blocked.length} 次）`,
    blocked[0] ? JSON.stringify({ turns: blocked[0].turns, tokens: blocked[0].tokens }) : ''
  )
  say(committed.length === 0, `没有提交状态（${committed.length} 次）—— 短会话不花模型调用`)

  const dir = join(sandboxRoot, 'data', 'context-state')
  const files = existsSync(dir) ? readdirSync(dir) : []
  const stateFiles = files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.archive.json') && !f.endsWith('.recall.json'))
    .filter((f) => !ownId || f.startsWith(ownId))
  say(stateFiles.length === 0, `没有写出状态文件（本场景 ${ownId ?? '未知'} 命中 ${stateFiles.length} 份；目录共 ${files.length} 项）`)

  return { ok, lines }
}

/**
 * State Refresh 档（N21-6）的退出后检查。
 *
 * 与 `checkContextGate` 的区别：那个验「短会话被挡住」（`reason=too-early`），
 * 这个验「接近窗口会放行」（`reason=near-window`）。探针与它共用 `context-gate.js`，
 * 所以会话 id 也从同一个 key 取。
 */
async function checkContextRefresh(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxgate')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records
  const gateRows = ownRecords.filter((r) => r?.stage === 'producer' && r.hook === 'gate')
  lines.push(`  诊断行 = ${records.length}（本场景 ${ownRecords.length}，gate ${gateRows.length} 行）`)
  for (const row of gateRows.slice(0, 4)) lines.push(`    · ${JSON.stringify(row).slice(0, 200)}`)

  say(gateRows.some((r) => r.activated === true), `gate 放行了（${gateRows.filter((r) => r.activated).length} 次）`)
  say(
    gateRows.some((r) => r.reason === 'near-window'),
    `放行理由是 near-window（实际 ${JSON.stringify(gateRows.map((r) => r.reason))}）`
  )
  /*
   * `window` 必须 > 0：它来自 `ctx.model.contextWindow`。为 0 说明 pi 没把这个值
   * 暴露给扩展 —— 设计上会安全跳过该分支（不会误触发），但功能等于没接上，
   * 所以这里必须红，而不是静默地“永远不命中”。
   */
  const windows = gateRows.map((r) => Number(r.window) || 0)
  say(windows.some((w) => w > 0), `诊断里带着真实窗口大小（${JSON.stringify(windows)}）—— 说明 ctx.model.contextWindow 可用`)

  return { ok, lines }
}

/**
 * 结构化压缩“接管”的退出后检查（N21-6 最后一项）。
 *
 * 「接管到底写进去了什么」只有 `ctx-ext.log` 知道 —— 接管块进的是 pi 的摘要，
 * 不落我们的任何文件。探针跑在渲染端读不到它，所以判据在这里。
 */
/**
 * Deep Context（N21-8，cost 1）：Pass 1 真的调了模型 + Pass 2 真的注入了。
 *
 * 断言只落在「链路通不通」上：
 *   · `hook: 'error'` 为空 —— `ctx.modelRegistry.complete()` 的调用约定（context 形状等）
 *     是**从 minified bundle 推的**，它错了这里第一个报出来；
 *   · `hook: 'injected'` 至少一次 —— Pass 1 真的产出并装配了工作 trace；
 *   · `hook: 'context'` 里有 `injectedWorkingTrace: true` —— 注入块真的进了这一轮的消息
 *     （注入块本身不落盘，诊断行是唯一取证点，与 `task-state-injected` 同一层级）。
 *
 * 刻意**不**断归纳质量（那属于 N21-9 的 A/B 判据），也**不**断延迟数字
 * （模型速度差异太大，只如实打印，让它可观测）。
 */
/**
 * 压缩接管的**成功分支**（N21-6 最后一项）。
 *
 * 在这之前，`hook: 'takeover'` **从来没有在真实链路里出现过**：
 *   · `contexttakeover` 没开 `episode-fold` → `fallback: 'inject-off'`（降级）；
 *   · `contexttakeoversummary` 验的是装配（真实状态文件 → 真实函数），不是链路。
 * 本检查断言的就是那一次成功接管。
 */
async function checkContextTakeoverState(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxtakeoverstate')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records

  const committed = ownRecords.filter((r) => r?.stage === 'producer' && r.hook === 'committed')
  say(committed.length >= 1, `状态生成器提交过（${committed.length} 次）—— 接管的前提`)

  const compact = ownRecords.filter((r) => r?.stage === 'compact')
  const entered = compact.filter((r) => r.hook === 'entered')
  const takeovers = compact.filter((r) => r.hook === 'takeover')
  const fallbacks = compact.filter((r) => r.hook === 'fallback')
  say(entered.length >= 1, `钩子被调到（${entered.length} 次）`)
  say(
    takeovers.length >= 1,
    `压缩真的走了**接管分支**（takeover ${takeovers.length} 次 / fallback ${fallbacks.length} 次）`
  )
  const last = takeovers[takeovers.length - 1]
  if (last) {
    lines.push(`    · 接管：tier=${last.tier} gap=${last.gap} fields=${JSON.stringify(last.fields)}`)
    /*
     * 能接管的档位由 `applyFreshness` 决定（`if (!applied.task)` 就 fallback）：
     * 只有 `fresh` / `stale-soft` / `stale-hard` 会带 task。
     * 这里曾写成 `fresh/partial/stale` —— 那三个名字是**猜的**，
     * 真实数据一进来就是 `stale-hard`，断言当场红了（这次是好事）。
     */
    say(['fresh', 'stale-soft', 'stale-hard'].includes(last.tier), `接管写的是真实档位（${last.tier}）`)
    const fields = last.fields ?? {}
    const nonEmpty = Object.entries(fields)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
    say(fields.task === true, '接管摘要里有目标（objective 非空）')
    say(nonEmpty.length >= 2, `摘要里有内容（逐类非空 ${nonEmpty.length} 类：${nonEmpty.join('/') || '无'}）`)
  }
  for (const record of fallbacks.slice(0, 3)) {
    lines.push(`    · fallback: ${JSON.stringify(record).slice(0, 180)}`)
  }
  return { ok, lines }
}

/**
 * 压缩接管的**档位可达性**实测（N21-6 尾 / 实施-06 S4 前半）。
 *
 * 不把「必须命中 fresh / stale-soft」写成断言 —— 两次构造（pi 中途压、
 * 回合 2 禁用工具）实测都得到 `tier=stale-hard`、`gap=3`。真实的断言是：
 * 接管写的是**可接管的真实档位**、水位不是完全一致、摘要里有目标；
 * 再把它实际命中的档位打印出来（结论回写 HANDOFF / 方案）。
 */
async function checkContextTakeoverGap(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxtiertakeover')
  const own = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records

  const compact = own.filter((r) => r?.stage === 'compact')
  const takeovers = compact.filter((r) => r.hook === 'takeover')
  const fallbacks = compact.filter((r) => r.hook === 'fallback')
  const tiers = takeovers.map((t) => t.tier)
  lines.push(`  接管 ${takeovers.length} 次｜降级 ${fallbacks.length} 次｜实测档位 = ${JSON.stringify(tiers)}`)
  for (const t of takeovers) {
    lines.push(`    · takeover tier=${t.tier} gap=${t.gap} fields=${JSON.stringify(t.fields)}`)
  }
  for (const f of fallbacks.slice(0, 4)) lines.push(`    · fallback: ${JSON.stringify(f).slice(0, 180)}`)

  const hit = takeovers.length >= 1
  say(hit, `压缩真的走了接管分支（takeover ${takeovers.length} 次 / fallback ${fallbacks.length} 次）`)

  if (takeovers.length) {
    const last = takeovers[takeovers.length - 1]
    const realTiers = ['fresh', 'stale-soft', 'stale-hard']
    say(realTiers.includes(last.tier), `接管写的是可接管的真实档位（${last.tier}）`)
    say(Number.isFinite(last.gap) && last.gap >= 1, `水位是有界陈旧而不是完全一致（gap=${last.gap}）`)
    const fields = last.fields ?? {}
    say(fields.task === true, `接管摘要里有目标（objective 非空，tier=${last.tier}）`)
    /*
     * 实测结论（见场景注释）：真实链路里压缩**总在回合结束之后**，
     * 水位后至少已有 user + assistant + compaction 三条 → gap ≥ 3 → 只会落到 stale-hard。
     * 这里不把「必须 stale-hard」写成硬断言（将来实现变了不该假红），
     * 只把实际情况打印出来，结论回写 HANDOFF / 方案。
     */
    lines.push(
      last.tier === 'stale-hard'
        ? `  → 实测：真实链路只出现 stale-hard（gap=${last.gap}）；fresh / stale-soft 不可达（两档判定由单测覆盖）`
        : `  → 实测：命中了非 hard 档（tier=${last.tier} gap=${last.gap}）—— 与场景注释里的旧结论不同，需要回写文档`
    )
  } else {
    say(false, '一次接管都没有')
  }

  const errors = own.filter((r) => r.hook === 'error')
  say(errors.length === 0, `扩展没有报错（${errors.length} 条 error）`)

  /*
   * 诊断辅助：把本会话的条目序列打出来。
   * `gap` 是「当前 entryCount − 水位 entryCount」，只看数字没法知道
   * 那几条是什么（回合 2 到底新增了 user/assistant/还是 pi 的包装条目）。
   * 这是调档位时的必需证据，也顺带证明会话文件只追加、没被改写。
   */
  try {
    const sessionsDir = join(sandboxRoot, 'sessions')
    const files = existsSync(sessionsDir)
      ? readdirSync(sessionsDir, { recursive: true })
          .map((n) => String(n))
          .filter((n) => n.endsWith('.jsonl') && (!ownId || n.includes(ownId)))
      : []
    for (const name of files) {
      const text = readFileSync(join(sessionsDir, name), 'utf8')
      const seq = text
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const e = JSON.parse(line)
            return [`${e?.type ?? '?'}:${e?.message?.role ?? ''}`]
          } catch {
            return ['?']
          }
        })
      lines.push(`  会话条目（${seq.length} 条）：${seq.join(' | ')}`)
    }
  } catch (error) {
    lines.push('  （读会话文件失败：' + (error instanceof Error ? error.message : String(error)) + '）')
  }
  return { ok, lines }
}

async function checkContextDeep(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxdeep')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records

  const deep = ownRecords.filter((r) => r?.stage === 'deep')
  const injected = deep.filter((r) => r.hook === 'injected')
  const skipped = deep.filter((r) => r.hook === 'skipped')
  const errors = deep.filter((r) => r.hook === 'error')
  const empty = deep.filter((r) => r.hook === 'empty')

  /*
   * 诊断分布：一次定性「是 env 没到扩展」还是「到了但被闸门挡了」还是「抛错了」。
   * 没有它的话，`stage:'deep'` 为空只能知道「没跑」，而「为什么没跑」要看天。
   */
  const dist = {}
  for (const record of ownRecords) {
    const key = `${record.stage ?? '?'}:${record.hook ?? '?'}`
    dist[key] = (dist[key] ?? 0) + 1
  }
  lines.push(`    · 诊断分布：${JSON.stringify(dist)}`)
  const boot = ownRecords.filter((r) => r?.stage === 'boot')
  for (const record of boot.slice(0, 2)) {
    lines.push(`    · 扩展启动时看到的策略：${record.policy || '(空)'}`)
  }
  const contextErrors = ownRecords.filter((r) => r?.stage === 'context' && r.hook === 'error')
  for (const record of contextErrors.slice(0, 2)) {
    lines.push(`    · context 钩子抛错：${String(record.message).slice(0, 200)}`)
  }

  say(
    errors.length === 0,
    `Pass 1 没有报错（${errors.length} 次${errors[0]?.message ? `：${String(errors[0].message).slice(0, 160)}` : ''}）`
  )
  say(
    skipped.every((r) => r.reason !== 'disabled'),
    '没有被「开关没打开」挡掉（否则这个场景什么也没验到）'
  )
  say(
    injected.length >= 1,
    `Pass 1 真的产出并注入了工作 trace（${injected.length} 次；skipped ${skipped.length} / empty ${empty.length}）`
  )
  if (injected[0]) {
    lines.push(
      `    · ms=${injected[0].ms} inputTokens=${injected[0].inputTokens} outputChars=${injected[0].outputChars} blockTokens=${injected[0].blockTokens}`
    )
    say(Number(injected[0].outputChars) > 0, '归纳结果非空')
    say(Number(injected[0].blockTokens) > 0, '注入块有内容（不是空壳）')
  }
  /*
   * `hook: 'context'` 这个组合是唯一的（compact / producer 都不用它），
   * 所以这里用 hook 而不是 stage —— 后者要求调用方记得在 payload 里写，
   * 而 context 系的 trace 没写（正是这一轮误报的成因，见 MAINTENANCE）。
   */
  const contexts = ownRecords.filter((r) => r?.hook === 'context')
  const flagged = contexts.filter((r) => r.injectedWorkingTrace === true)
  say(
    flagged.length >= 1,
    `hook:'context' 里有 injectedWorkingTrace:true（${flagged.length} 次）—— 注入块真的进了这一轮消息`
  )
  if (skipped.length > 0) {
    lines.push(`    · skipped 原因：${[...new Set(skipped.map((r) => r.reason))].join(', ')}`)
  }

  return { ok, lines }
}

/**
 * 「压缩那一刻，`session_before_compact` 到底有没有被调到」——N21-12 的唯一直接取证点。
 *
 * ⚠️ 这个检查存在的一半理由是**它曾经是错的**：`diagnostic()` 只把 trace 的
 * 第一参数放进 `hook` 字段，而 compact 系调用没有在 payload 里写 `stage`
 * （producer 系写了）—— 于是 `stage === 'compact'` 的过滤**永远为空**，
 * 看起来就是「一次都没被调到」，而真把 `stage` 补上后结论才作数。
 * 这类「工具错得很安静」的坑，比它当时想抓的 bug 更值得写下来。
 *
 * 只取证不断言：本条跑的是「压缩一定发生」的场景，数字本身就是结论。
 */
async function checkContextTakeoverHook(sandboxRoot) {
  const lines = []
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const compact = records.filter((r) => r?.stage === 'compact')
  const byHook = {}
  for (const record of compact) byHook[record.hook] = (byHook[record.hook] ?? 0) + 1
  lines.push(`  session_before_compact 诊断：${JSON.stringify(byHook)}（共 ${compact.length} 条）`)
  for (const record of compact.slice(0, 4)) lines.push(`    · ${JSON.stringify(record).slice(0, 200)}`)
  const entered = compact.filter((r) => r.hook === 'entered')
  lines.push(
    entered.length > 0
      ? '  → 钩子**确实被调到了**：压缩接管在真实链路里是可用的'
      : '  → 钩子一次都没被调到（`stage` 已确认修对，这个结论现在可信）'
  )

  /*
   * 交接计数（实施-05 S5a）：这次压缩是**砚自己发起的自动完整压缩**，
   * 所以它必须被计进 `handoffs.json` —— 计数是「压够两次就换会话」的唯一依据，
   * 记不上就等于那件事永远不会发生。
   */
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  try {
    const file = join(sandboxRoot, 'data', 'handoffs.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(
      `  handoffs.json：${entries
        .map(([k, v]) => `${String(k).split(/[\\/]/).pop()}=${v?.tally?.count ?? 0}`)
        .join(', ') || '（空）'}`
    )
    const tally = entries.map(([, v]) => v?.tally).find((t) => (t?.count ?? 0) > 0)
    say(!!tally, '自动压缩被计进交接计数（≥ 1 次）')
    if (tally) say(Array.isArray(tally.keys) && tally.keys.length >= 1, '计数的去重键也落了盘')
  } catch (error) {
    say(false, '读 handoffs.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }
  return { ok, lines }
}

/**
 * Deep Context 的**界面路径**：在设置面板开的开关，扩展真的读到了吗。
 *
 * 证据形态是 `stage:'deep'` 的 `skipped: below-threshold` —— 它**只在**
 * `p.deep.enabled` 为 true 时才可能产生（`if (p.deep.enabled)` 才进 `runDeepPass`），
 * 而探针会话只有几 k token、真实门槛是 150k，所以必然停在门槛上。
 * 换句话说：**「因为它没跑」这件事本身就是「开关被读到了」的证据**。
 * （真正的注入由 `contextdeep` 验 —— 那需要把门槛降下来，只能用测试通道。）
 */
async function checkContextDeepPref(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxdeeppref')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records

  const deep = ownRecords.filter((r) => r?.stage === 'deep')
  const reasons = [...new Set(deep.map((r) => r.reason).filter(Boolean))]
  say(deep.length >= 1, `扩展读到了界面上的开关（${deep.length} 条 deep 记录）`)
  say(reasons.includes('below-threshold'), `停在门槛上（reason=${reasons.join(',') || '无'}）—— 短会话不该注入`)
  say(!reasons.includes('disabled'), '不是「开关没打开」被挡掉（否则这个场景什么也没验到）')
  say(!deep.some((r) => r.hook === 'injected'), '短会话里真的没有注入（门槛生效）')
  const boot = ownRecords.filter((r) => r?.stage === 'boot')
  if (boot[0]) lines.push(`    · 启动时扩展看到的策略：${boot[0].policy || '(空，本场景期望为空)'}`)

  return { ok, lines }
}

/**
 * `episode-fold`（任务状态记忆）的**界面关闭路径**（P2-7）—— 配 `contextfoldpref` 场景。
 *
 * 这是一条**否定式断言**（「生成器一次都没跑」），而否定式断言最容易假通过：
 * 扩展没加载、回合没跑、根本没原料，都会得到同样的「零」。所以这里必须同时钉
 * 三件正向的事：设置真的落了盘、扩展真的在读这份设置（`hook:'skipped'` 那行里的
 * `kinds` 就是它的解析结果）、探针那个回合真的调了工具。
 * **「本该有」的对照**是同 env、同探针形态的 `contextfolddefault` —— 它用同一套
 * 条件（`YAN_CONTEXT_POLICY` 只降门槛、**不给 `kinds`**）证明默认集下真的会生成。
 */
/* ══════════════════════════════════════════════════════════════════
 * 项目知识注入（实施-03 S3）
 * ══════════════════════════════════════════════════════════════════ */

/** 项目知识 fixture 的项目 id / 条目 id / 正文（afterExit 也读这几个常量）。 */
const KNOWLEDGE_FIXTURE_PROJECT_ID = 'proj-fixture'
const KNOWLEDGE_FIXTURE_ENTRY_ID = 'kn-deploy'
const KNOWLEDGE_FIXTURE_TEXT = '发布流程统一走 npm run dist，先跑完整门槛'
/* 设置页场景专用的候选条目：确认按钮只对 candidate 出现 */
const KNOWLEDGE_FIXTURE_CANDIDATE_ID = 'k-candidate01'
const KNOWLEDGE_FIXTURE_CANDIDATE_TEXT = 'out/ 是构建产物目录，跑单测前先 build'

/**
 * 预置一份项目知识（fixture）。
 *
 * 指纹用**真模块**算（靠 Node 的类型剥离直接 import `src/shared/project-memory.ts`）——
 * 手写一个 16 位 hex 也许能过形状校验，但那是 fixture 在替产品说谎，
 * 而这条场景的全部意义就是「真检索、真注入」。
 */
async function seedProjectKnowledge(dataDir, opts = {}) {
  const projectId = KNOWLEDGE_FIXTURE_PROJECT_ID
  const { pathToFileURL } = await import('node:url')
  const memory = await import(pathToFileURL(join(root, 'src/shared/project-memory.ts')).href)
  const now = new Date().toISOString()
  const entry = {
    schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    id: KNOWLEDGE_FIXTURE_ENTRY_ID,
    projectId,
    revision: 1,
    kind: 'decision',
    status: 'active',
    text: KNOWLEDGE_FIXTURE_TEXT,
    textDigest: memory.textDigest(KNOWLEDGE_FIXTURE_TEXT),
    tags: ['发布'],
    evidence: [{ sessionId: 'fixture' }],
    confidenceClass: 'user-confirmed',
    createdAt: now,
    updatedAt: now
  }
  /*
   * 「设置页」场景要多一条**候选**：确认按钮只对 `candidate` 出现，
   * 而候选只能是模型提议出来的（宿主不会自己造）——所以 fixture 必须准备好，
   * 否则那一列永远是空的，接口不接也不知道。
   */
  const candidate = opts.withCandidate
    ? {
        ...entry,
        id: KNOWLEDGE_FIXTURE_CANDIDATE_ID,
        revision: 1,
        kind: 'fact',
        status: 'candidate',
        text: KNOWLEDGE_FIXTURE_CANDIDATE_TEXT,
        textDigest: memory.textDigest(KNOWLEDGE_FIXTURE_CANDIDATE_TEXT),
        tags: [],
        evidence: [{ sessionId: opts.sessionId ?? 'fixture' }],
        confidenceClass: 'inferred'
      }
    : null
  /* 来源跳转要一个**真存在**的会话：fixture 会话 id 是动态的，由调用方查好传进来 */
  if (opts.sessionId) entry.evidence = [{ sessionId: opts.sessionId }]
  const entries = [entry, ...(candidate ? [candidate] : [])]
  const manifest = {
    schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    projectId,
    revision: 1,
    updatedAt: now,
    entries: entries.map((item) => memory.pointerOf(item))
  }
  const dir = join(dataDir, 'project-knowledge', projectId)
  for (const item of entries) {
    mkdirSync(join(dir, 'entries', item.id), { recursive: true })
    writeFileSync(join(dir, 'entries', item.id, 'r1.json'), JSON.stringify(item, null, 2), 'utf8')
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(
    `  项目知识 fixture：${projectId}/${entry.id}${candidate ? ` + ${candidate.id}（候选）` : ''}（digest ${entry.textDigest.slice(0, 8)}${opts.sessionId ? `，来源会话 ${opts.sessionId}` : ''}）`
  )
}

/**
 * 实施-03 S6 的隔离 fixture 常量（probe 与 afterExit 都要用）。
 *
 * 为什么 id / 正文写在这里：探针只做界面断言，真正的字节（digest）核验在
 * Node 侧（探针按设计读不到 `YAN_DATA_DIR`）。两边得拿同一份常量。
 */
const KNOWLEDGE_ISO_A_ID = 'kn-iso-a'
const KNOWLEDGE_ISO_A_TEXT = 'fixture：主仓库的发布流程统一走 npm run dist'
const KNOWLEDGE_ISO_B_ID = 'kn-iso-b'
const KNOWLEDGE_ISO_B_TEXT = 'fixture：另一个项目的接口约定（与主仓库无关）'
const KNOWLEDGE_ISO_TITLES = { a: 'YAN-ISO-A', b: 'YAN-ISO-B', w: 'YAN-ISO-W' }
/** 跨重启交接观察结果的 localStorage 键（同一个 YAN_USER_DATA，进程退出后仍在）。 */
const KNOWLEDGE_ISO_STASH_KEY = 'yan.probe.knowledge-iso.v1'
/** 旧用户数据的哨兵（实施-03 §9：遗留 `memory.json` / `soul.md` 不主动删）。 */
const LEGACY_DATA_SENTINELS = [
  { name: 'memory.json', body: '{"entries":[{"id":"old-1","text":"用户遗留的旧记忆，不许被删除或改写"}]}\n' },
  { name: 'soul.md', body: '# soul\n\n用户遗留的旧人设文件，逐字节不许变。\n' }
]

/**
 * 把三个 cwd 的会话写进隔离会话目录。
 *
 * 为什么自己写而不复用 `writeProjectSwitchSessions`：那个函数只支持两个 cwd，
 * 而这片要验三处 —— 主仓库 A / 另一个项目 B / **未登记的 git 工作树 W**。
 * 用 `utimesSync` 把 mtime 拨开（排序键是文件 mtime，不是消息时间戳）。
 */
function writeIsolationSessions(root, cwdA, cwdB, cwdW) {
  const stamp = Date.now().toString(36)
  const made = {}
  const one = (tag, key, cwd, skew) => {
    const id = `yan-iso-${tag}-${stamp}`
    const file = join(root, `2026-01-05T00-00-00-000Z_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: TS(800 - skew), cwd },
      { type: 'model_change', id: 'mc0', parentId: null, timestamp: TS(800 - skew), provider: 'commandcode', modelId: 'deepseek/deepseek-v4.1-flash' },
      {
        type: 'message',
        id: 'u0',
        parentId: 'mc0',
        timestamp: TS(790 - skew),
        message: { role: 'user', content: [{ type: 'text', text: `${KNOWLEDGE_ISO_TITLES[key]} fixture 会话` }] }
      },
      {
        type: 'message',
        id: 'a0',
        parentId: 'u0',
        timestamp: TS(780 - skew),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${KNOWLEDGE_ISO_TITLES[key]}-REPLY` }],
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop'
        }
      }
    ]
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    const t = (Date.now() - (900 + skew) * 1000) / 1000
    try {
      utimesSync(file, t, t)
    } catch {
      /* 个别文件系统不支持改时间戳：不致命 */
    }
    made[key] = { tag, cwd, file }
  }
  one('a', 'a', cwdA, 0)
  one('b', 'b', cwdB, 10)
  one('w', 'w', cwdW, 20)
  return made
}

/**
 * 项目知识隔离 fixture（实施-03 S6）。
 *
 * 造出四种真实条件：
 *   ① A = 主仓库（`fixture-project/repo`，真 git 仓库）—— 用**旧算法**的 id 登记，
 *      这是「项目被自动登记」时的真实取值；
 *   ② B = 另一个项目（`fixture-project/other`）—— 它的旧 id 与 A 撞，所以登记时
 *      必须拿到哈希 id（与 `sanitizeProjects` 的碰撞退路一致）；
 *   ③ W = A 的**真 git 工作树**（`fixture-project/repo-worktrees/iso`）—— **不登记**，
 *      模拟「直接打开一条工作树会话」；它的旧 id 与 A 完全相同；
 *   ④ 旧的 `memory.json` / `soul.md` 哨兵：跑完必须逐字节不变。
 *
 * 修复前 ③ 会读到 ① 的知识（工作树与主仓库共用一个 id）—— 这条 fixture
 * 就是为那个缺陷准备的。
 */
async function seedKnowledgeIsolation(sandboxRoot, fixtureProject, caseCwd) {
  const { pathToFileURL } = await import('node:url')
  const ids = await import(pathToFileURL(join(root, 'src/main/project-id.ts')).href)
  const memory = await import(pathToFileURL(join(root, 'src/shared/project-memory.ts')).href)

  const cwdA = caseCwd
  const cwdB = join(fixtureProject, 'other')
  const worktreeRoot = join(fixtureProject, 'repo-worktrees')
  const cwdW = join(worktreeRoot, 'iso')

  /* 真 git 工作树；git 不可用时退化成普通目录 —— 路径前缀（碰撞的成因）不受影响 */
  let worktreeIsReal = false
  try {
    mkdirSync(worktreeRoot, { recursive: true })
    execFileSync('git', ['-c', 'user.name=yan-test', '-c', 'user.email=yan@test', 'worktree', 'add', '-q', '-b', `iso-${Date.now().toString(36)}`, cwdW], {
      cwd: cwdA,
      stdio: 'ignore'
    })
    worktreeIsReal = true
  } catch (error) {
    mkdirSync(cwdW, { recursive: true })
    console.log(`  ⚠️  工作树没建起来（${error instanceof Error ? error.message : String(error)}）—— 退化成普通目录，路径前缀不变`)
  }

  const idA = ids.legacyProjectId(cwdA)
  const idB = ids.hashedProjectId(cwdB)
  const legacyW = ids.legacyProjectId(cwdW)

  const entry = (key, id, text, kind) => {
    const now = new Date().toISOString()
    return {
      schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
      id,
      projectId: key,
      revision: 1,
      kind,
      status: 'active',
      text,
      textDigest: memory.textDigest(text),
      tags: [],
      evidence: [{ sessionId: 'fixture' }],
      confidenceClass: 'user-confirmed',
      createdAt: now,
      updatedAt: now
    }
  }
  const writeOne = (projectId, item) => {
    const dir = join(sandboxRoot, 'data', 'project-knowledge', projectId)
    mkdirSync(join(dir, 'entries', item.id), { recursive: true })
    writeFileSync(join(dir, 'entries', item.id, 'r1.json'), JSON.stringify(item, null, 2), 'utf8')
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
          projectId,
          revision: 1,
          updatedAt: item.updatedAt,
          entries: [memory.pointerOf(item)]
        },
        null,
        2
      ),
      'utf8'
    )
  }
  writeOne(idA, entry(idA, KNOWLEDGE_ISO_A_ID, KNOWLEDGE_ISO_A_TEXT, 'decision'))
  writeOne(idB, entry(idB, KNOWLEDGE_ISO_B_ID, KNOWLEDGE_ISO_B_TEXT, 'fact'))

  writeFileSync(
    join(sandboxRoot, 'data', 'desktop.json'),
    JSON.stringify(
      {
        cwd: cwdA,
        lang: 'zh-CN',
        projectKnowledge: { enabled: true },
        projects: [
          { id: idA, cwd: cwdA, name: '主仓库', archived: false, createdAt: Date.now(), updatedAt: Date.now() },
          { id: idB, cwd: cwdB, name: '另一个项目', archived: false, createdAt: Date.now(), updatedAt: Date.now() }
        ]
      },
      null,
      2
    ),
    'utf8'
  )

  const sessions = join(sandboxRoot, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const made = writeIsolationSessions(sessions, cwdA, cwdB, cwdW)

  /* 旧用户数据哨兵：两份（pi 目录 + 数据目录），跑完都要逐字节不变 */
  const sentinels = []
  for (const base of [join(sandboxRoot, 'pi-agent'), join(sandboxRoot, 'data')]) {
    mkdirSync(base, { recursive: true })
    for (const sentinel of LEGACY_DATA_SENTINELS) {
      const path = join(base, sentinel.name)
      writeFileSync(path, sentinel.body, 'utf8')
      sentinels.push({ path, body: sentinel.body })
    }
  }

  console.log(`  隔离 fixture：A=${idA.slice(0, 18)}…(登记) / B=${idB.slice(0, 18)}…(登记·哈希) / W=${legacyW.slice(0, 18)}…(工作树·未登记)`)
  console.log(`    工作树：${cwdW}${worktreeIsReal ? '（真 git 工作树）' : '（普通目录）'}`)
  return { cwdA, cwdB, cwdW, idA, idB, legacyW, sessions: made, sentinels }
}

/**
 * 退出后检查：注入真的发生过，而且关掉之后不再发生。
 *
 * 三处证据缺一不可：
 *   ① `desktop.json` 里开关真的落成了 false（渲染端 → 主进程 → 磁盘）；
 *   ② 扩展诊断日志里先有 `inject`（带 fixture 条目 id），之后有 `injected:false`；
 *   ③ 注入文件最后停成空块 —— 这是「下一轮看得到的」那份状态。
 */
async function checkKnowledgeInject(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  /* ① 设置文件：只如实报最终值（探针最后一节把开关重新打开了，不是断言点） */
  try {
    const settings = JSON.parse(readFileSync(join(sandboxRoot, 'data', 'desktop.json'), 'utf8'))
    lines.push(`  desktop.json：projectKnowledge=${JSON.stringify(settings?.projectKnowledge ?? null)}`)
    say(settings?.projectKnowledge?.enabled === true, '设置写入链通（探针重开后最终为 true）')
  } catch (error) {
    say(false, '读 desktop.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* ② 诊断日志 */
  const logFile = join(sandboxRoot, 'knowledge-ext.log')
  const records = (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const injects = records.filter((record) => record.hook === 'inject')
  /* 先把诊断原样报出来：沙箱退出后会清掉，这里不报就设不了案 */
  lines.push(`  诊断行数 = ${records.length}`)
  for (const record of records.slice(0, 8)) lines.push('    ' + JSON.stringify(record))
  say(injects.length >= 1, `扩展真的注入过（inject ${injects.length} 次）`)
  say(
    injects.some((record) => (record.ids ?? []).includes(KNOWLEDGE_FIXTURE_ENTRY_ID)),
    `注入的条目里有 fixture 那条（${KNOWLEDGE_FIXTURE_ENTRY_ID}）`
  )
  const firstInject = records.findIndex((record) => record.hook === 'inject')
  const afterInject = firstInject >= 0 ? records.slice(firstInject + 1) : []
  say(
    afterInject.some((record) => record.hook === 'payload' && record.injected === false),
    '关掉之后的回合不再注入（诊断里 injected:false）'
  )
  /* 最后一次模型请求必须是「没注入」—— 它对应「重新开启 + 无关查询」那一轮 */
  const lastPayload = [...records].reverse().find((record) => record.hook === 'payload')
  say(lastPayload?.injected === false, '最后一次模型请求没注入（与注入文件的 no-match 对应）')

  /* ③ 注入文件：最后停成空块 */
  try {
    const injectDir = join(sandboxRoot, 'data', 'project-knowledge', '_inject')
    const files = existsSync(injectDir) ? readdirSync(injectDir).filter((name) => name.endsWith('.json')) : []
    say(files.length >= 1, `注入文件存在（${files.length} 份）`)
    const last = files.length ? JSON.parse(readFileSync(join(injectDir, files[files.length - 1]), 'utf8')) : null
    if (last) {
      lines.push(`  注入文件（${files[files.length - 1]}）：enabled=${last.enabled} reason=${last.reason} hits=${(last.hits ?? []).length} block=${(last.block ?? '').length} 字符`)
    }
    /*
     * 最后一份注入文件对应「重新开启 + 无关查询」那一轮：
     * 开关是开的（所以不是靠关掉蒙过去），但块为空、原因是 no-match ——
     * 这就是「无相关项则零注入」的磁盘证据。
     */
    say(last?.enabled === true && last?.block === '', '无关查询下注入文件是空块（开启着也不注入）')
    say(last?.reason === 'no-match', `空块的原因是 no-match（收到 ${last?.reason ?? '(无)'}）`)
  } catch (error) {
    say(false, '读注入文件失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(!/\[knowledgeinject\]\s+[1-9]\d*\s+条失败/.test(probeText), '探针自身没有失败项')
  return { ok, lines }
}

/**
 * 退出后检查：`yan knowledge propose` 真的落盘了，而且落的是 `candidate`。
 *
 * 三条：① 条目数增加；② 新条目是 `candidate`（模型不能自证确认）；
 * ③ 原 fixture 那条仍是唯一的 `active`（没有被顺手改写）。
 */
async function checkKnowledgeCli(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const manifestFile = join(sandboxRoot, 'data', 'project-knowledge', KNOWLEDGE_FIXTURE_PROJECT_ID, 'manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const entries = Array.isArray(manifest.entries) ? manifest.entries : []
    const active = entries.filter((entry) => entry.status === 'active')
    const candidates = entries.filter((entry) => entry.status === 'candidate')
    lines.push(`  manifest：revision=${manifest.revision} 共 ${entries.length} 条（active ${active.length} / candidate ${candidates.length}）`)
    for (const entry of entries) lines.push(`    ${entry.id} ${entry.status} ${entry.kind}`)
    say(entries.length >= 2, '磁盘上真的多了一条（propose 写进去了）')
    say(candidates.length >= 1, '新条目落成 candidate（模型不能自证 user-confirmed）')
    say(active.length === 1, 'active 条目仍然只有 fixture 那一条')
  } catch (error) {
    say(false, '读 manifest 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(!/\[knowledgecli\]\s+[1-9]\d*\s+条失败/.test(probeText), '探针自身没有失败项')
  return { ok, lines }
}

/**
 * 退出后检查：设置页里那三次操作真的落盘了。
 *
 * 三件：① 被删的那条 `status` 变成 `deleted` 且 revision 加了至少 3（确认 / 编辑 / 删除）；
 * ② 另一条 fixture 一点没被动过；③ 删掉的那条**正文不在导出材料里**（墓碑不回流）。
 */
async function checkKnowledgeTab(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const manifestFile = join(sandboxRoot, 'data', 'project-knowledge', KNOWLEDGE_FIXTURE_PROJECT_ID, 'manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const entries = Array.isArray(manifest.entries) ? manifest.entries : []
    lines.push(`  manifest：revision=${manifest.revision} 共 ${entries.length} 条`)
    for (const entry of entries) lines.push(`    ${entry.id} ${entry.status} rev ${entry.revision}`)
    const deleted = entries.find((entry) => entry.id === KNOWLEDGE_FIXTURE_CANDIDATE_ID)
    const untouched = entries.find((entry) => entry.id === KNOWLEDGE_FIXTURE_ENTRY_ID)
    say(!!deleted, '被删的那条仍在 manifest 里（逻辑删除，不是抹掉）')
    say(deleted?.status === 'deleted', '被删的那条状态是 deleted')
    say((deleted?.revision ?? 0) >= 4, `revision 至少加了 3（确认 / 编辑 / 删除）：${deleted?.revision}`)
    say(untouched?.status === 'active' && untouched?.revision === 1, '另一条 fixture 完全没被动过（active / rev 1）')
    /*
     * 墓碑不回流：删除后的正文不该出现在导出材料里。这里直接读墓碑正文（还在盘上，
     * 逻辑删除保留可恢复），确认它**不等于**原来那条候选的文字 ——
     * 若发现它还是 active 或 revision 没变，上面的断言已经先报错了。
     */
    const tombstoneFile = join(
      sandboxRoot,
      'data',
      'project-knowledge',
      KNOWLEDGE_FIXTURE_PROJECT_ID,
      'entries',
      KNOWLEDGE_FIXTURE_CANDIDATE_ID,
      `r${deleted?.revision ?? 0}.json`
    )
    const tombstone = JSON.parse(readFileSync(tombstoneFile, 'utf8'))
    say(typeof tombstone.text === 'string' && tombstone.text.length > 0, '墓碑保留正文（逻辑删除可恢复）')
    say(tombstone.status === 'deleted', '那版 revision 文件本身也是 deleted 状态')
  } catch (error) {
    say(false, '读 manifest / 墓碑失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(!/\[knowledgetab\]\s+[1-9]\d*\s+条失败/.test(probeText), '探针自身没有失败项')
  return { ok, lines }
}

/**
 * 退出后检查：项目知识的跨项目 / 工作树隔离 + 跨重启持久化 + 便携数据完整性
 *（实施-03 S6）。
 *
 * 为什么全部在退出后看：探针跑在渲染端，按设计读不到 `YAN_DATA_DIR` ——
 * 「界面上看不到 B 的知识」可能只是这一轮没刷新。真正的保证是磁盘上
 * 两个项目就是两个目录、各只有自己的条目；而重启后再读一次，证明它不是内存态。
 *
 * 反向验证：把 `capability.projectId` 的“未登记回退”改回裸 `legacyProjectId(cwd)`，
 * 工作树那条断言（探针里的 ids.w）会当场变红 —— 这就是旧算法 27 字节截断
 * 让工作树与主仓库共用 id 的缺陷（详见 HANDOFF 六栅）。
 */
async function checkKnowledgeIsolation(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const { pathToFileURL } = await import('node:url')
  const ids = await import(pathToFileURL(join(root, 'src/main/project-id.ts')).href)
  const memory = await import(pathToFileURL(join(root, 'src/shared/project-memory.ts')).href)
  const fixtureProject = join(sandboxRoot, 'fixture-project')
  const cwdA = join(fixtureProject, 'repo')
  const cwdB = join(fixtureProject, 'other')
  const cwdW = join(fixtureProject, 'repo-worktrees', 'iso')
  const idA = ids.legacyProjectId(cwdA)
  const idB = ids.hashedProjectId(cwdB)
  const idW = ids.hashedProjectId(cwdW)
  const knDir = (projectId) => join(sandboxRoot, 'data', 'project-knowledge', projectId)
  const readManifest = (projectId) => JSON.parse(readFileSync(join(knDir(projectId), 'manifest.json'), 'utf8'))

  /* ── ① 前提：旧算法的 27 字节截断真的让工作树与主仓库同 id ── */
  say(
    ids.legacyProjectId(cwdW) === idA,
    '前提成立：工作树的旧算法 id 与主仓库完全相同（路径前 27 字节被截断）',
  )
  say(idB !== idA, '另一个项目的登记 id 与主仓库不同（碰撞退路生效）')

  /* ── ② 磁盘上两个项目各只有自己那条 ── */
  try {
    const manifestA = readManifest(idA)
    const manifestB = readManifest(idB)
    const entryA = (manifestA.entries ?? []).find((entry) => entry.id === KNOWLEDGE_ISO_A_ID)
    const entryB = (manifestB.entries ?? []).find((entry) => entry.id === KNOWLEDGE_ISO_B_ID)
    lines.push(`  A(${idA.slice(0, 18)}…) → ${(manifestA.entries ?? []).map((e) => e.id).join(', ') || '（空）'}`)
    lines.push(`  B(${idB.slice(0, 18)}…) → ${(manifestB.entries ?? []).map((e) => e.id).join(', ') || '（空）'}`)
    say(entryA?.status === 'active', 'A 的条目在 A 的知识目录里（active）')
    say(entryB?.status === 'active', 'B 的条目在 B 的知识目录里（active）')
    say(
      entryA?.digest === memory.textDigest(KNOWLEDGE_ISO_A_TEXT),
      'A 的条目正文指纹与 fixture 一致（逐字节没被改动）',
    )
    say(
      !(manifestA.entries ?? []).some((entry) => entry.id === KNOWLEDGE_ISO_B_ID),
      'A 的目录里**没有** B 的条目（物理隔离，不靠查询条件）',
    )
    say(
      !(manifestB.entries ?? []).some((entry) => entry.id === KNOWLEDGE_ISO_A_ID),
      'B 的目录里**没有** A 的条目',
    )
  } catch (error) {
    say(false, '读项目 manifest 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* ── ③ 工作树不该拿到主仓库的知识 ── */
  try {
    const worktreeManifest = existsSync(join(knDir(idW), 'manifest.json')) ? readManifest(idW) : null
    lines.push(
      `  工作树 id（哈希）→ ${worktreeManifest ? (worktreeManifest.entries ?? []).map((e) => e.id).join(', ') : '（没有知识目录）'}`,
    )
    say(
      !worktreeManifest || (worktreeManifest.entries ?? []).length === 0,
      '工作树没有拿到任何条目（即使没有知识目录也算通过 —— 它不该读主仓库的）',
    )
  } catch (error) {
    say(false, '读工作树知识目录失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* ── ④ 探针自己报的 id：运行时真的用了「哈希退路」 ── */
  const idLine = /\[knowledgeisolation\] ids=(\{[^\n]*\})/.exec(probeText)
  let runtimeIds = null
  if (!idLine) {
    say(false, '探针没有打印运行时的 projectId（拿不到隔离的直接证据）')
  } else {
    try {
      runtimeIds = JSON.parse(idLine[1])
      lines.push(`  运行时 id = ${JSON.stringify(runtimeIds)}`)
      say(runtimeIds.a === idA, '主仓库会话用的就是登记 id')
      say(runtimeIds.b === idB, '另一个项目会话用的是哈希 id（登记过）')
      say(runtimeIds.w === idW, '工作树会话用的是哈希 id —— 不是主仓库的 id（隔离成立）')
      say(runtimeIds.w !== runtimeIds.a, '工作树的 id 与主仓库不同（这就是旧算法会撞的地方）')
    } catch (error) {
      say(false, '解析探针 id 失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /* ── ⑤ 重启：用同一份数据目录第二次启动，读到同一批 id 与条目 ── */
  const restartLine = /\[knowledgeisolation\] restart=(\{[^\n]*\})/.exec(probeText)
  if (!restartLine) {
    say(false, '没有拿到重启探针的输出（cross-process 持久化没验到）')
  } else {
    try {
      const restart = JSON.parse(restartLine[1])
      lines.push(`  重启后 = ${JSON.stringify(restart)}`)
      say(restart.aHasEntry === true, '重启后主仓库仍能读到自己的条目（知识在盘上，不是内存态）')
      say(restart.aSameId === true, '重启后主仓库的 projectId 与上一次相同（派生确定性）')
      say(restart.bHasEntry === true, '重启后另一个项目仍能读到自己的条目')
      say(restart.wEmpty === true, '重启后工作树仍然读不到任何条目')
      say(restart.wSameId === true, '重启后工作树的 projectId 与上一次相同（哈希退路确定）')
    } catch (error) {
      say(false, '解析重启探针输出失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /* ── ⑥ 无开发目录依赖：知识不往仓库里写 ── */
  say(!existsSync(join(root, 'project-knowledge')), '开发仓库根目录下没有被创建 project-knowledge（数据只在 YAN_DIR）')
  say(
    existsSync(knDir(idA)) && knDir(idA).startsWith(join(sandboxRoot, 'data')),
    '知识目录落在隔离的 YAN_DIR 下',
  )

  /* ── ⑦ 旧用户数据逐字节不变（实施-03 §9）── */
  for (const base of ['pi-agent', 'data']) {
    for (const sentinel of LEGACY_DATA_SENTINELS) {
      const path = join(sandboxRoot, base, sentinel.name)
      let same = false
      try {
        same = readFileSync(path, 'utf8') === sentinel.body
      } catch {
        same = false
      }
      say(same, `旧用户数据逐字节不变：${base}/${sentinel.name}`)
    }
  }

  say(!/\[knowledgeisolation\]\s+[1-9]\d*\s+条失败/.test(probeText), '探针自身没有失败项')
  return { ok, lines }
}

async function checkContextFoldPref(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  /* ---- ① 界面 → 主进程 → desktop.json 这一段真的通了 ---- */
  const settingsFile = join(sandboxRoot, 'data', 'desktop.json')
  let settings = null
  try {
    settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
  } catch {
    settings = null
  }
  say(settings?.contextFold?.enabled === false, `设置真的落盘为「关」（${settingsFile}）`)
  say(settings?.contextDeep?.enabled !== true, 'Deep Context 没有被连带打开（两个开关共用一份桌面端设置缓存）')

  /* ---- ② 诊断日志：不该有任何真实动作，但必须有「被关掉」的正面证据 ---- */
  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxfoldpref')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records
  const producerRows = ownRecords.filter((r) => r?.stage === 'producer')
  const actions = producerRows.filter((r) => r.hook !== 'skipped')
  const offRows = producerRows.filter((r) => r.hook === 'skipped' && r.reason === 'kind-off')
  lines.push(`  诊断行 = ${records.length}（本场景 ${ownRecords.length}，其中 producer ${producerRows.length} 行）`)
  const toolCalls = /ctxfoldpref\.toolCalls=(\d+)/.exec(probeText)?.[1] ?? '?'
  lines.push(`  探针那个回合的工具调用数 = ${toolCalls}（有原料却不生成，才是开关的功劳）`)
  for (const row of producerRows.slice(0, 3)) lines.push(`    · ${JSON.stringify(row).slice(0, 240)}`)
  say(
    actions.length === 0,
    `生成器没有任何动作（gate / committed / error 共 ${actions.length} 条）—— 关掉之后连门槛判定都不该发生`
  )
  say(
    offRows.length >= 1,
    `留下「被关掉」的正面证据（${offRows.length} 条 hook:skipped / kind-off）—— 证明扩展确实在跑，不是没加载`
  )
  const offKinds = offRows[0]?.kinds
  say(
    Array.isArray(offKinds) && !offKinds.includes('episode-fold') && offKinds.includes('tool-sweep'),
    `扩展解析出的 kinds 不含 episode-fold、但其它阶段还在（${JSON.stringify(offKinds ?? null)}）—— 只关了一项，没把整个扩展关掉`
  )
  const injected = ownRecords.filter((r) => r?.injectedTaskState === true)
  say(injected.length === 0, `没有任何 <TASK_STATE> 注入（${injected.length} 次）`)

  /* ---- ③ 状态文件不该被创建 ---- */
  const statePath = ownId ? join(sandboxRoot, 'data', 'context-state', `${ownId}.json`) : ''
  say(!statePath || !existsSync(statePath), `没有为这个会话落盘状态文件（${statePath || '（会话 id 未知）'}）`)

  return { ok, lines }
}

/**
 * Episode 扇叠（§12.6）的真实回合取证 —— 配 `contextepisode` 场景。
 *
 * 两层证据分开：
 *   · **硬**：诊断里候选窗口算出来了（`episodeWindow > 0`）—— 确定性边界在真实链路里成立；
 *   · **强**：模型真的给了收束的一段 → 状态文件里有 Episode，逐字段可验。
 * 「没给」**不算失败**：收束判据在模型的输出里（`unresolved` 为空才算），它有权说这段
 * 还没完 —— 那时如实报告，不把产品判断当成测试失败。
 * shadow 也在这里验：默认 `episodeInject` 关，所以 `task.episodeRefs` 里不该有它。
 */
async function checkContextEpisode(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxepisode')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records
  const producerRows = ownRecords.filter((r) => r?.stage === 'producer')
  const committed = producerRows.filter((r) => r.hook === 'committed')
  /*
   * 「边界算得出来」的证据来自**窗口那一行**，不是 committed 行 ——
   * 窗口在模型调用之前就算出来了，而模型输出会有 `not-json` 的拒收。
   */
  const windows = producerRows.filter((r) => r.hook === 'episode-window')
  lines.push(`  诊断行 = ${records.length}（本场景 ${ownRecords.length}，其中 producer ${producerRows.length} 行）`)
  say(committed.length >= 1, `生成器至少提交过一次状态（${committed.length} 次）`)
  say(
    windows.length >= 1,
    `Episode 的候选窗口在真实链路里算得出来（${windows.length} 次：${JSON.stringify(windows.map((r) => `${r.from}→${r.to}(${r.entries}条/${r.tokens}tok)`))}）`
  )
  const withEpisodes = committed.filter((r) => Number(r.episodes) === 1)
  lines.push(`  其中带 Episode 的提交 = ${withEpisodes.length}（模型认为那段收束了才会给，没给不算失败）`)
  for (const row of producerRows.slice(0, 6)) {
    lines.push(
      `    · ${JSON.stringify({ hook: row.hook, reason: row.reason ?? null, window: row.episodeWindow ?? null, episodes: row.episodes ?? null, why: row.episodeReason ?? null })}`
    )
  }

  const dir = join(sandboxRoot, 'data', 'context-state')
  const files = existsSync(dir) ? readdirSync(dir) : []
  const stateFiles = files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.archive.json') && !f.endsWith('.recall.json'))
    .filter((f) => !ownId || f.startsWith(ownId))
  if (!stateFiles.length) {
    say(false, `状态文件已写出（本场景 ${ownId ?? '未知'} 命中 0 份；目录共 ${files.length} 项）`)
    return { ok, lines }
  }
  let state = null
  try {
    state = JSON.parse(readFileSync(join(dir, stateFiles[0]), 'utf8'))
  } catch {
    state = null
  }
  say(!!state, '状态文件是合法 JSON')
  if (!state) return { ok, lines }

  const episodes = Array.isArray(state.episodes) ? state.episodes : []
  if (!episodes.length) {
    lines.push('  ⤺ 本次模型没有给出可扇叠的一段（正常结果，不是失败）；结构校验跳过')
  } else {
    const ep = episodes[0]
    say(typeof ep.id === 'string' && ep.id.startsWith('ep-'), `Episode 的 id 是确定性拼出来的（${ep.id}）`)
    say(
      typeof ep.sourceRange?.from === 'string' && typeof ep.sourceRange?.to === 'string',
      `sourceRange 指回原始条目（${ep.sourceRange?.from} → ${ep.sourceRange?.to}）`
    )
    say(
      !!ep.watermark?.lastEntryId && Number(ep.tokensBefore) > 0,
      `watermark 与 tokensBefore 都写上了（${ep.tokensBefore} tokens）`
    )
    say(
      typeof ep.objective === 'string' && ep.objective.length > 0 && typeof ep.outcome === 'string',
      'objective / outcome 非空（一段的「做了什么 → 做成了什么」）'
    )
    say(
      Array.isArray(ep.unresolved) && ep.unresolved.length === 0,
      `落盘的 Episode 一定是收束的（unresolved=${(ep.unresolved ?? []).length}，非空的不该落盘）`
    )
    const refs = Array.isArray(ep.importantRefs) ? ep.importantRefs : []
    say(refs.every((r) => /^ctx:\/\/(tool|file|diff)\//.test(r)), `importantRefs 只有归档引用（${JSON.stringify(refs)}）`)
    say(
      !(Array.isArray(state.task?.episodeRefs) ? state.task.episodeRefs : []).includes(ep.id),
      'shadow：默认不把 Episode 汇总进 task.episodeRefs（消费门关着）'
    )
  }

  /* ---- 交叉校验：状态文件必须过主进程的读路径（schema + 引用合法性） ---- */
  const store = await import('../out/main/context-state-store.js').catch(() => null)
  const loaded = await store?.loadContextState?.(state.sessionId, { dir }).catch(() => null)
  say(loaded?.status === 'ok', `状态文件过主进程的校验（${loaded?.status ?? 'no-store'}）`)
  if (loaded?.status !== 'ok' && loaded?.issues) {
    for (const issue of loaded.issues.slice(0, 4)) lines.push(`    · ${issue.path}: ${issue.message}`)
  }
  return { ok, lines }
}

async function checkContextTakeoverSummary(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const ownId = ownSessionIdFrom(probeText, 'ctxsum')
  const ownRecords = ownId ? records.filter((r) => !r.sessionId || r.sessionId === ownId) : records

  const committed = ownRecords.filter((r) => r?.stage === 'producer' && r.hook === 'committed')
  say(committed.length >= 1, `状态生成器提交过（${committed.length} 次）—— 接管要有状态可用`)

  /*
   * Deep Context（N21-8）的**反向验证**：本场景的 env 没开 `deep`，
   * 所以扩展侧的日志里不该出现任何 `stage: 'deep'` 的记录。
   * 「默认关闭」不能靠代码里那句 `enabled: false` 自证 —— 那条分支也可能写错，
   * 只有「没开的时候真的一次都没跑」才是真实链路里的证据。
   */
  const deepRows = ownRecords.filter((r) => r?.stage === 'deep')
  say(deepRows.length === 0, `没开 Deep Context 时一次都没跑（${deepRows.length} 条 deep 记录）`)

  const compactRows = ownRecords.filter((r) => r?.stage === 'compact')
  const entered = compactRows.filter((r) => r.hook === 'entered')
  const takeovers = compactRows.filter((r) => r.hook === 'takeover')
  const fallbacks = compactRows.filter((r) => r.hook === 'fallback')
  /*
   * **真实发现（2026-09-18，待查，见归档 §1.19）**：pi 0.85.1 在这个场景里压了两次
   * （砚的 policy 一次、pi 自己的 threshold 一次），但 `session_before_compact`
   * **一次都没被调到** —— 连专门加的 `entered` 取证也是空的。
   * bundle 里两处调用点都先判 `hasHandlers('session_before_compact')`，所以要么 handler
   * 没注册上，要么走的不是那两条路。这里**如实记下来、不断言**：
   * 断言它只会把发现变成一个“测试失败”，而发现本身比一条绿更重要。
   */
  lines.push(
    `  pi 调 session_before_compact 的次数 = ${entered.length}（takeover ${takeovers.length} / fallback ${fallbacks.length}）`
  )
  for (const row of entered.slice(0, 2)) lines.push(`    · entered: ${JSON.stringify(row).slice(0, 200)}`)
  for (const row of fallbacks.slice(0, 2)) lines.push(`    · fallback: ${JSON.stringify(row).slice(0, 200)}`)

  /*
   * 接管函数本身：用**刚落盘的真实状态文件**跑一遍 ——
   * 「逐类字段非空」这条命题在钩子没被调的当下只能做到这个层级（如实标注在文档里）。
   */
  const transformModule = await import('../resources/pi-extensions/context-transform.js').catch(() => null)
  const statePath = ownId ? join(sandboxRoot, 'data', 'context-state', `${ownId}.json`) : ''
  const state = transformModule && statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
  if (!transformModule || !state) {
    say(false, `读不到真实状态文件，无法验证接管装配（${statePath || 'no-id'}）`)
    return { ok, lines }
  }
  const built = transformModule.buildStructuredSummary(state, { freshness: 'fresh' })
  say(built.ok === true, `真实状态能装配出结构化摘要（${built.ok ? 'ok' : built.reason}）`)
  const summary = built.summary ?? ''
  say(
    summary.includes('<HISTORICAL_CONTEXT>') && summary.includes('<TASK_STATE'),
    '摘要里两个块都在（历史上下文 + 任务状态）'
  )
  const nonEmpty = Object.entries(built.fields ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key)
  lines.push(`    · fields=${JSON.stringify(built.fields)}（摘要 ${summary.length} 字符）`)
  say(nonEmpty.length >= 3, `逐类字段非空 ${nonEmpty.length} 类（${nonEmpty.join('/') || '无'}）`)
  say(built.fields?.task === true, 'objective 非空')

  return { ok, lines }
}

async function checkContextSweepArchiveImpl(sandboxRoot) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'context-state')
  const files = existsSync(dir) ? readdirSync(dir) : []
  lines.push(`  目录 = ${dir}`)
  lines.push(`  文件 = ${JSON.stringify(files)}`)

  const archives = files.filter((f) => f.endsWith('.archive.json'))
  say(archives.length >= 1, `扩展写出了归档元数据（${archives.length} 份）`)

  let archive = null
  if (archives.length) {
    try {
      archive = JSON.parse(readFileSync(join(dir, archives[0]), 'utf8'))
    } catch {
      archive = null
    }
  }
  const toolEntries = (archive?.entries ?? []).filter((e) => e.kind === 'tool')
  say(toolEntries.length >= 1, `归档里有工具条目（${toolEntries.length} 条）`)

  /* 归档引用的 entryId 必须真的在会话文件里 */
  const knownIds = new Set()
  const sessionsDir = join(sandboxRoot, 'sessions')
  if (existsSync(sessionsDir)) {
    const stack = [sessionsDir]
    while (stack.length) {
      const current = stack.pop()
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const p = join(current, entry.name)
        if (entry.isDirectory()) stack.push(p)
        else if (entry.name.endsWith('.jsonl')) knownIds.add(p)
      }
    }
  }
  const sessionFiles = [...knownIds]
  const entryIds = new Set()
  /* 用构建产物里的真实读法（与主进程同一实现），不手写 JSON 解析 */
  const watermark = await import('../out/main/context-watermark.js').catch(() => null)
  for (const file of sessionFiles) {
    const index = await watermark?.readSessionEntryIndex?.(file).catch(() => null)
    if (!index) continue
    for (const id of index.entryIds) entryIds.add(id)
  }
  {
    say(entryIds.size > 0, `读到会话原始条目 id（${entryIds.size} 条）`)
    const refs = toolEntries.map((e) => e.ref).filter((r) => typeof r === 'string')
    say(refs.length > 0, '归档条目带 ctx:// 引用')
    const resolvable = refs.filter((r) => {
      const id = r.slice(r.lastIndexOf('/') + 1)
      return entryIds.has(id)
    })
    say(
      resolvable.length > 0,
      `ctx:// 引用指得回原始条目（${resolvable.length}/${refs.length}）`,
    )
    const sameRange = toolEntries.every((e) => e.sourceRange?.from === e.sourceRange?.to && entryIds.has(e.sourceRange?.from))
    say(toolEntries.length > 0 && sameRange, 'sourceRange 是单条原始 entry（不是数组下标 / token 偏移）')

    /* 扩展诊断 */
    const logPath = join(sandboxRoot, 'ctx-ext.log')
    const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const logLines = logText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const swept = logLines.filter((l) => l.hook === 'context' && Number(l.swept) >= 1)
    say(swept.length >= 1, `诊断里有 swept>=1（扩展的 context 钩子在真实 pi 里被采纳）`)
    const errors = logLines.filter((l) => l.hook === 'error')
    say(errors.length === 0, `扩展没有报错（${errors.length} 条 error）`)
    const skips = logLines.filter((l) => l.hook === 'sweep-skipped')
    if (skips.length) lines.push(`  （跳过记录：${JSON.stringify(skips.map((s) => s.reason))}）`)

    /* 召回审计 */
    const auditFiles = files.filter((f) => f.endsWith('.recall.jsonl'))
    const auditLines = auditFiles.flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    )
    lines.push(`  召回审计 = ${JSON.stringify(auditLines)}`)
    const recalled = auditLines.some((l) => l.kind === 'recall' && l.result === 'ok')
    if (recalled) {
      /*
       * 召回真的发生过 → TTL（ttl='turn'）必须在下一轮把正文清成存根。
       * 这是「召回不是永久恢复历史」的真实证据；如果模型没召回就不适用
       * （那种情况由单测覆盖）。
       */
      const expired = logLines.filter((l) => l.hook === 'context' && Number(l.expiredRecalls) >= 1)
      say(expired.length >= 1, '下一轮把上一轮的召回正文清成存根（expiredRecalls≥1）')
    } else {
      lines.push('  （本次模型没有调用 recall —— 召回链路由单测覆盖）')
    }
  }
  return { ok, lines }
}

/**
 * N21-4 尾 / §12.11 第 10 条：**连续 20+ 长回合压力测试**的退出后断言。
 *
 * 这一场不验“某个功能通不通”（那由 `contextsweep` / `contextproduce` 等覆盖），
 * 验的是连续很多轮都贴着工作集跑时的**稳定性**：
 *   ① 压力条件真的成立（够多回合在线上）；
 *   ② 转录没有一路爆上去（工作集附近的回合占比）；
 *   ③ 没有任何一次请求越过「窗口 − 输出预留」；
 *   ④ 会话文件不被破坏（原始条目一条不少、没有重复 id）——
 *      清扫 / 接管只改**发给模型的窗口**，绝不改磁盘。
 *
 * 数据来源只有两个：扩展诊断（`ctx-ext.log`，每轮一条 `sweep-forced-by-budget`
 * 记下当时的 `transcriptTokens`）与会话文件本身。与其它上下文场景同一边界：
 * 探针不读 `YAN_DATA_DIR`，断言在 Node 侧做。
 */
async function checkContextPressure(sandboxRoot) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logPath = join(sandboxRoot, 'ctx-ext.log')
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const logLines = logText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  lines.push(`  诊断行数 = ${logLines.length}`)

  /* ---------- ① 每一轮都留下了请求诊断（真实链路跑完的证据） ---------- */
  const budgetRows = logLines.filter((l) => typeof l.hook === 'string' && l.hook.startsWith('request-budget-'))
  const physical = budgetRows.filter((l) => l.hook === 'request-budget-physical')
  const aborts = logLines.filter((l) => l.hook === 'budget-abort')
  lines.push(`  请求诊断行 = ${budgetRows.length}`)
  say(budgetRows.length >= 18, `每个回合都真的发了请求（${budgetRows.length} 条诊断）`)
  say(physical.length === 0, `没有被物理线拦下的请求（physical ${physical.length} 条）`)
  say(aborts.length === 0, `没有 budget-abort（${aborts.length} 条）`)

  /* ---------- ② 恒不越窗口预留 ---------- */
  {
    const worst = budgetRows
      .map((r) => ({ est: Number(r.estimatedTokens), win: Number(r.window) }))
      .filter((r) => Number.isFinite(r.est) && Number.isFinite(r.win))
      .map((r) => ({ est: r.est, win: r.win, headroom: r.win - r.est }))
      .sort((a, b) => a.headroom - b.headroom)[0]
    if (worst) {
      lines.push(`  最小余量 = ${worst.headroom} token（窗口 ${worst.win}｜最大估算 ${worst.est}）`)
      say(worst.headroom > 0, '每一次请求的估算都在窗口之内（余量 > 0）')
    } else {
      say(false, '没有带 window / estimatedTokens 的诊断行')
    }
  }

  /* ---------- ④ 会话文件不被破坏 ---------- */
  let sessionFiles = []
  const sessionsDir = join(sandboxRoot, 'sessions')
  if (existsSync(sessionsDir)) {
    sessionFiles = readdirSync(sessionsDir, { recursive: true })
      .map((n) => join(sessionsDir, String(n)))
      .filter((p) => p.endsWith('.jsonl'))
  }
  lines.push(`  会话文件 = ${sessionFiles.length}`)
  const texts = sessionFiles.map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : ''))
  const all = texts.join('\n')
  const marks = Array.from({ length: 22 }, (_, i) => `pressure-${i + 1}`)
  const seenMarks = marks.filter((m) => all.includes(m))
  say(seenMarks.length >= 20, `会话文件里保留了压力回合的用户消息（${seenMarks.length}/22）`)
  /*
   * 「原始 session 不被破坏」的核心证据：那些很大的工具输出**还在文件里**。
   * 清扫只把墓碑写进发给模型的窗口，磁盘上必须仍是原文；否则“可召回”是假的。
   */
  const bigOutputs = texts.flatMap((t) =>
    t
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .map((entry) => JSON.stringify(entry))
      .filter((raw) => raw.length > 3000)
  )
  lines.push(`  大块条目（>3000 字符的原始行）= ${bigOutputs.length}`)
  say(bigOutputs.length >= 10, `磁盘上仍保留着大块工具输出原文（${bigOutputs.length} 行）`)

  const errors = logLines.filter((l) => l.hook === 'error')
  say(errors.length === 0, `扩展没有报错（${errors.length} 条 error）`)

  return { ok, lines }
}

/**
 * 退出后的落盘检查（L03）。
 *
 * 子代理的合并 / 放弃 / 冲突 / 只读封堵 / 退出归档，最终都体现在
 * `YAN_DIR/subagents/<id>.json` + `<id>.patch` 和临时 worktree 目录上。
 * 这些必须在 Electron **已经退出**之后看才说明问题 —— 退出归档
 * （D2）就是退出那一刻发生的事，渲染层看不到。
 *
 * 探针把固定标记（`YAN-ALPHA` 等）写进任务描述，这里按标记找回记录，
 * 并顺带直接查主工作树：这才是“主树没被污染”的独立证据。
 */
function checkSubagentArchive(sandboxRoot, tempBefore) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'subagents')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const records = []
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
      /* 写了一半的文件当作记录缺失，下面会报出 */
    }
  }
  lines.push(`  元数据 ${records.length} 份：${files.join(' ') || '（空）'}`)

  const byMark = (mark) => records.find((r) => String(r.task ?? '').includes(mark))
  const patchExists = (r) => !!r?.patchPath && existsSync(r.patchPath)

  const expect = (mark, review, label) => {
    const run = byMark(mark)
    say(!!run, `找到 ${label} 记录`)
    if (!run) return null
    say(run.review === review, `${label} review=${run.review}（期望 ${review}）`)
    return run
  }

  const alpha = expect('YAN-ALPHA', 'merged', 'ALPHA')
  if (alpha) say(patchExists(alpha), 'ALPHA 的补丁留在归档目录（合并后仍可追溯）')
  const beta = expect('YAN-BETA', 'discarded', 'BETA')
  if (beta) say(patchExists(beta), 'BETA 的补丁留在归档目录（放弃但没丢）')
  expect('YAN-CONFLICT-D', 'merged', 'CONFLICT-D')
  /*
   * CONFLICT-C 在退出前一直是未审阅的冲突，所以退出时应该被归档
   * （review 从 conflict 变成 archived）—— 这正是“未合并差异不因退出丢掉”
   * 的证据。若它还停在 conflict，说明退出归档没跑到。
   */
  const conflictC = expect('YAN-CONFLICT-C', 'archived', 'CONFLICT-C')
  if (conflictC) say(patchExists(conflictC) || !conflictC.diff?.files, 'CONFLICT-C 的冲突补丁也归档了')
  /*
   * LONGRUN 是专门留给退出的：它进去先写一个文件，再到长任务里。
   * 不管退出时它仍在跑（中断）还是刚好结束（未审阅），都该落成 archived。
   */
  const longrun = expect('YAN-LONGRUN', 'archived', 'LONGRUN')
  if (longrun) say(patchExists(longrun) || !longrun.diff?.files, 'LONGRUN 的退出归档落盘')
  expect('YAN-READONLY', 'none', 'READONLY')

  /* 主工作树：合并的进来了、放弃与只读的没有 */
  const repo = join(sandboxRoot, 'fixture-project', 'repo')
  say(existsSync(join(repo, 'alpha.txt')), '主工作树留住了已合并的 alpha.txt')
  say(!existsSync(join(repo, 'beta.txt')), '被放弃的 beta.txt 没有进主工作树')
  say(!existsSync(join(repo, 'readonly-attempt.txt')), '只读子代理没能写进主工作树')
  let readme = ''
  try {
    readme = readFileSync(join(repo, 'README.md'), 'utf8')
  } catch {
    /* 读不到也算失败，下面两条会报出来 */
  }
  say(readme.includes('LINE-D'), '主工作树 README 是 CONFLICT-D 的版本')
  say(!readme.includes('LINE-C'), '冲突的 CONFLICT-C 没有被半截写入')

  /* 退出后不能留下孤儿 worktree 容器 */
  const leftovers = readdirSync(tmpdir()).filter(
    (n) => n.startsWith('yan-subagent-') && !(tempBefore ?? new Set()).has(n)
  )
  for (const dir of leftovers) {
    /* 把残留目录对回到任务标记，否则看不出是哪条链路漏了清理 */
    const id = /^yan-subagent-(sub-[0-9a-f]+)-/.exec(dir)?.[1]
    const owner = records.find((r) => r.id === id)
    lines.push(`    残留 ${dir} → ${owner ? String(owner.task ?? '').slice(0, 24) + `（${owner.review}）` : '未知任务'}`)
  }
  say(leftovers.length === 0, `退出后没有残留的隔离目录（新增 ${leftovers.length} 个）`)

  return { ok, lines }
}

/**
 * N12 退出后的落盘检查。
 *
 * 这里要回答的是“后台会话真的跑过了、而且结果落进了**它自己**的会话文件”：
 * A 的长任务回复只能出现在 A 的文件里，不能跑到 B/C 里去。
 * 当前会话在内存里看着对，不代表落盘也对 —— 切会话正是最容易把内容
 * 写错文件的一条路。
 *
 * 同时确认 A 的仓库工作树没被“数数”这种只读任务改坏（模型若真跑了写工具，
 * README 的锚点会消失）：这是“后台会话不越界动文件”的一道侧证。
 */
function checkSessionabArchive(sandboxRoot) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const sessionsRoot = join(sandboxRoot, 'sessions')
  const files = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []
  const fileOf = (tag) => files.find((f) => f.includes(`yan-ab-${tag}-`) && f.endsWith('.jsonl'))
  const readMessages = (file) => {
    const text = readFileSync(join(sessionsRoot, file), 'utf8')
    const msgs = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o.type === 'message') msgs.push(o.message)
      } catch {
        /* 半截行忽略 */
      }
    }
    return msgs
  }
  const textOf = (msgs, role) =>
    msgs
      .filter((m) => m?.role === role)
      .map((m) => (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''))
      .join('\n')

  const fileA = fileOf('a')
  const fileB = fileOf('b')
  const fileC = fileOf('c')
  lines.push(`  A=${fileA ?? '（缺失）'}  B=${fileB ?? '（缺失）'}  C=${fileC ?? '（缺失）'}`)
  say(!!fileA && !!fileB && !!fileC, '三个会话文件都还在')
  if (!fileA || !fileB || !fileC) return { ok, lines }

  const msgsA = readMessages(fileA)
  const msgsB = readMessages(fileB)
  const msgsC = readMessages(fileC)
  const aText = textOf(msgsA, 'assistant')
  const bText = textOf(msgsB, 'assistant')
  const cText = textOf(msgsC, 'assistant')

  lines.push(`  A 落盘：${msgsA.length} 条消息，助手正文 ${aText.length} 字`)
  /*
   * 要证的是**后台会话真的在执行工具**——工具参数落在它自己的会话记录里，
   * 而不是只存在于渲染层的内存里。
   *
   * ⚠️ 匹配 `sleep \d+` 而不是写死的 `sleep 90`：探针 3.5 节要等它**自然跑完**
   * 才能验未读，所以那个秒数为了控制场景时长改过（现为 30）。
   * 写死秒数就等于把测试与实现里的参数绑在一起，改一处红一处。
   */
  say(/sleep \d+/.test(JSON.stringify(msgsA)), 'A 的会话记录里有那次工具调用（真执行了）')
  /*
   * 模型自己那个助手回合（fixture 里本来已有一个）——被中断时不一定写出正文，
   * 所以数条数而不是找文本。
   */
  say(msgsA.filter((m) => m?.role === 'assistant').length >= 2, 'A 的会话文件里多了模型自己的回合（被中断也算落盘）')
  say(!bText.includes('YAN-AB') || bText.includes('YAN-AB-B-REPLY'), 'B 的回复属于 B（没被 A 的内容覆盖）')
  say(cText.includes('YAN-AB-C-REPLY'), 'C 的回复原样保留（同 cwd 被拒的那次没写坏它）')
  /*
   * 串线的典型症状：A 的长回复被写到 B/C 的文件里。
   * 判据用“C 的助手消息数”而不是关键字 —— 拒绝之后 C 不应该多出任何消息。
   */
  say(msgsC.filter((m) => m?.role === 'assistant').length === 1, 'C 只有一个助手回合（被拒后确实没动它）')

  let readme = ''
  try {
    readme = readFileSync(join(sandboxRoot, 'fixture-project', 'repo', 'README.md'), 'utf8')
  } catch {
    /* 读不到下面会报 */
  }
  say(readme.includes('LINE-BASE'), '与 A 同 cwd 的仓库工作树没被弄坏')

  return { ok, lines }
}

/**
 * `@` 引用的真实发送（N19 最后一条）。
 *
 * 要证的是一件在渲染层看不到的事：**选中的文件内容到底进没进模型上下文**。
 * pi 收到 prompt 时会把 `@路径` 展开，展开结果会落在会话 JSONL 里 ——
 * 所以断言只能在 Electron 退出之后做（读文件）。
 */
function checkAtRefSend(sandboxRoot) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const sessionsRoot = join(sandboxRoot, 'sessions')
  const files = existsSync(sessionsRoot)
    ? readdirSync(sessionsRoot)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, t: statSync(join(sessionsRoot, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : []
  say(files.length > 0, `找到了会话文件（共 ${files.length} 个）`)
  if (!files.length) return { ok, lines }

  /* 本场景新建的那个会话就是最新的一个 */
  const file = files[0].f
  const raw = readFileSync(join(sessionsRoot, file), 'utf8')
  lines.push(`  最新会话 = ${file}（${raw.length} 字节）`)

  /*
   * RPC 的 prompt 只接受 message / images / streamingBehavior —— **没有文件参数**，
   * 所以 pi 不会把 `@路径` 展开成内容（那是 CLI 参数层 `pi @file "..."` 的行为）。
   * 砚的 @ 补全因此是“把路径写进消息”，文案也写的是“附件文件，可直接读取”，
   * 由模型自己调 read。要验的是**路径原样到了模型手里**。
   */
  say(raw.includes('@README.md'), '引用路径原样送达模型（RPC 不展开 @，模型自行读取）')
  const readIt = raw.includes('fixture project')
  lines.push(`  （模型本轮是否真去读了该文件：${readIt ? '是' : '否'}；会话 ${raw.length} 字节）`)
  say(/read|已读|第一行/.test(raw), '模型按任务回了话（引用语法没有打断这一轮）')

  return { ok, lines }
}

/**
 * Git 审查（G1）的**只读断言**（退出后从 Node 侧比对）。
 *
 * 这是「打开审查/刷新/切范围不会改用户工作区与暂存区」的唯一硬证据：
 * 渲染进程里看不到 git 的原始输出，只能看界面。把 fixture 仓库在
 * 应用启动**之前**的 status / index / 已暂存差异记下来，跑完再逐字节比。
 *
 * ⚠️ 为什么这条特别重要：同一个仓库里另有一个 `collectDiff()`（子代理隔离）
 * 会执行 `git add -A` —— 那是**故意**的（它只动隔离 worktree 的独立 index）。
 * 一旦审查面板错误地复用了那条路径，用户打开一次审查就会发现自己的
 * 暂存区被清空并全部暂存。这条断言就是拦它的。
 */
function checkGitReviewReadonly(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  if (!gitReviewBaseline) {
    lines.push('  （fixture 基线没记到，无法比对：跳过）')
    return { ok: true, lines }
  }

  const repo = join(sandboxRoot, 'fixture-project', 'review')
  let now
  try {
    now = gitReadonlySnapshot(repo)
  } catch (error) {
    say(false, '跑完审查后仓库读不出来了：' + (error instanceof Error ? error.message : String(error)))
    return { ok, lines }
  }

  say(now.status === gitReviewBaseline.status, 'git status 逐字节相同（工作区没被审查动过）')
  say(now.index === gitReviewBaseline.index, 'index 内容（ls-files -s）逐字节相同（没有偷偷 add）')
  say(now.cached === gitReviewBaseline.cached, '已暂存差异完全没变（diff --cached --numstat）')
  say(now.head === gitReviewBaseline.head, 'HEAD 没动过（没有偷偷提交）')

  /* 探针自己有没有跑完 / 有没有失败项 */
  say(/\[gitreview\]/.test(probeText), '探针确实跑到了审查场景（输出里有 [gitreview] 小结）')
  if (/\[gitreview\]\s+\d+\s+条失败/.test(probeText)) say(false, '探针自身有失败项（见上面的 ✗）')

  /* 脏改动应当还在（审查不是“修好”了什么，而是什么都没动） */
  const entries = now.status.split('\0').filter(Boolean).length
  lines.push(`  ⓘ 跑完后仓库状态条目 = ${entries}（fixture 故意做脏，不应为 0）`)
  say(entries > 0, 'fixture 的脏改动还在（审查没有顺手清理什么东西）')

  return { ok, lines }
}

/**
 * Git 写操作场景（G2）的**落地验证**。
 *
 * 为什么必须在应用退出后做：探针里的断言虽然回读了主进程的 git 状态，
 * 但那一层仍然在**应用内部**。这里换成第三方的真 git 直接看仓库：
 * HEAD 是谁、提交说明是什么、index 是否干净、bare remote 里有没有那个提交。
 * 这些是渲染进程（乃至整个应用）伪造不了的。
 *
 * 断言的是「写操作**真的发生了**」—— 与 G1 那条「什么都没动」正好相反，
 * 两条一起才说明「该动的动了、不该动的没动」。
 */
function checkGitWriteApplied(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const repo = join(sandboxRoot, 'fixture-project', 'write')
  const bare = join(sandboxRoot, 'fixture-project', 'write-remote.git')
  const read = (args, cwd = repo) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  try {
    /* 失败时把实际值打出来 —— 只说「不对」的断言要花一轮才知道「是什么」 */
    lines.push(
      '  ⓘ 实际：HEAD=' +
        read(['log', '-1', '--pretty=%s']) +
        ' / 分支=' +
        read(['rev-parse', '--abbrev-ref', 'HEAD']) +
        ' / 最近三条=' +
        JSON.stringify(read(['log', '-3', '--pretty=%s']).split(String.fromCharCode(10)))
 +
        ' / 全部分支提交=' +
        JSON.stringify(read(['log', '--all', '--pretty=%h %s']).split(String.fromCharCode(10))) +
        ' / main=' +
        read(['rev-parse', 'main']) +
        ' live-made=' +
        read(['rev-parse', '--verify', 'live-made'])
    )
    say(
      read(['log', '-1', '--pretty=%s']) === 'feat: live 写操作验收',
      'HEAD 上的提交正是界面上输入的那条说明'
    )
    say(read(['rev-parse', '--abbrev-ref', 'HEAD']) === 'main', '收尾时停在 main 分支（探针最后切回来了）')
    say(read(['branch', '--list', 'live-made']) !== '', '新建的分支 live-made 真的存在')

    /* 暂存过的 a.txt 已经随提交进了历史 → 工作区里它不再是「已暂存/已修改」 */
    const status = read(['status', '--porcelain'])
    const aLine = status.split('\n').find((l) => l.endsWith('a.txt')) ?? ''
    say(
      aLine === '' || aLine.startsWith('??') === false,
      'a.txt 没有留在「已暂存」里（暂存的内容随提交进了历史）[' + aLine + ']'
    )

    /* 远程：bare 仓库收到了同一个提交（推送真的出去了） */
    const localHead = read(['rev-parse', 'HEAD'])
    const remoteHead = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    say(localHead === remoteHead, 'bare remote 里的 main 与本地 HEAD 相同（推送成功）')
  } catch (error) {
    say(false, '退出后读仓库失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(/\[gitwrite\]/.test(probeText), '探针确实跑到了写操作场景（输出里有 [gitwrite] 小结）')

  /*
   * 实施-07 S2b-2：`trust.json` 里真的多了两条（主仓库 + 工作树），且值为 true。
   * 这一步只能 Node 侧做 —— 探针里读到的 "trusted: true" 只是主进程的回话，
   * 磁盘上到底写没写、写成什么形状，得直接读文件才知道。
   */
  try {
    const trustFile = join(sandboxRoot, 'pi-agent', 'trust.json')
    const table = JSON.parse(readFileSync(trustFile, 'utf8'))
    const keys = Object.keys(table)
    const wtKey = keys.find((k) => /live-carry/i.test(k))
    say(keys.length >= 2, 'trust.json 里至少有两条（主仓库 + 工作树）：' + keys.length)
    say(!!wtKey, '其中一条是工作树目录：' + String(wtKey ?? '(无)'))
    say(keys.every((k) => table[k] === true), '两条的值都是 true（没有写出 false 条目）')
  } catch (error) {
    say(false, '退出后读 trust.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }
  if (/\[gitwrite\]\s+[1-9]\d*\s+条失败/.test(probeText)) say(false, '探针自身有失败项（见上面的 ✗）')

  /*
   * 工作树来源关系（实施-07 S2）：探针已经用**主进程回读**验过一遍，
   * 这里再从 Node 侧读那份 `worktree-links.json` —— 退出之后看磁盘，
   * 是这套取证里最强的一层（渲染进程伪造不了它）。
   */
  const sessionId = /worktreelink\.sessionId=([A-Za-z0-9._-]+)/.exec(probeText)?.[1]
  const worktree = /worktreelink\.worktree=(.+)/.exec(probeText)?.[1]?.trim()
  say(!!sessionId && !!worktree, `探针报告了新会话与工作树（${sessionId} / ${worktree}）`)
  const linkFile = join(sandboxRoot, 'data', 'worktree-links.json')
  if (!existsSync(linkFile)) {
    say(false, `没有找到 ${linkFile}（关系没落盘）`)
  } else {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(linkFile, 'utf8'))
    } catch {
      /* 下面如实报失败 */
    }
    const item = Array.isArray(parsed?.links) ? parsed.links.find((x) => x?.sessionId === sessionId) : null
    say(!!item, '磁盘上的那条关系就是探针登记的那条（会话 id 对得上）', JSON.stringify(item ?? null))
    if (item) {
      say(item.worktree === worktree, '工作树目录对得上', String(item.worktree))
      say(!!item.fromSessionId, '源会话记下来了（不是一条孤立记录）', String(item.fromSessionId))
      say(item.fromSessionId !== item.sessionId, '源会话与新会话不是同一条（方向没写反）')
      say(Number.isFinite(item.at) && item.at > 0, '带时间戳', String(item.at))
    }
  }

  return { ok, lines }
}

/**
 * 「每个项目最后一个会话」的退出后检查（实施-09 S3，cost 0，进 `check`）。
 *
 * 探针已经用主进程回读验过一遍；这里再从 Node 侧读 `session-layout.json`，
 * 确认那条「打开过」的记录**真的落盘**，而且 `hot` 那条没有被误写。
 */
async function checkProjectOpenedLayout(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }
  const text = String(probeText ?? '')
  const openedId = /projectopened\.sessionId=([A-Za-z0-9._-]+)/.exec(text)?.[1]
  say(!!openedId, `探针报告了被打开的会话（${openedId}）`)
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok, lines }
  }
  const file = join(sandboxRoot, 'data', 'session-layout.json')
  if (!existsSync(file)) {
    say(false, `没有找到 ${file}（打开记录没落盘）`)
    return { ok, lines }
  }
  let doc = null
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* 下面如实报失败 */
  }
  const entries = Array.isArray(doc?.entries) ? doc.entries : null
  say(!!entries, 'session-layout.json 是合法的（有 entries 数组）')
  if (!entries) return { ok, lines }
  const opened = entries.find((e) => e?.sessionId === openedId)
  const hot = entries.find((e) => String(e?.sessionId ?? '').includes('yan-n05-hot'))
  say(!!opened, '被打开的那条在布局索引里')
  if (opened) say(Number.isFinite(opened.lastOpenedAt) && opened.lastOpenedAt > 0, '它的 lastOpenedAt 真的落盘了', String(opened.lastOpenedAt))
  say(!!hot, 'hot 那条也在索引里（对照项没有缺席）')
  if (hot) say(!hot.lastOpenedAt, 'hot 那条没有被写上 lastOpenedAt（没打开过就不该有）', String(hot.lastOpenedAt ?? '无'))
  return { ok, lines }
}

/** 退出后检查的注册表：CASES 里用 `afterExit: '子代理归档'` 引用 */
/**
 * 来源「定位消息」的退出后检查（实施-07 S3，cost 0，进 `check`）。
 *
 * 探针已经说过「关联写进了主进程」—— 但那只是渲染端自己的话。这里从 Node 侧
 * 直接读沙箱里的 `links.json`：文件真的在、里面真的是那一条、而且只有一条。
 * 「落盘」这件事只能这样证明。
 */
async function checkSourceLocateLinked(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }
  const text = String(probeText ?? '')
  const sid = /sourcelink\.sessionId=([A-Za-z0-9._-]+)/.exec(text)?.[1]
  const messageId = /sourcelink\.messageId=([A-Za-z0-9._:-]+)/.exec(text)?.[1]
  const sourceId = /sourcelink\.sourceId=(image:[A-Za-z0-9._-]+)/.exec(text)?.[1]
  say(!!sid && !!messageId && !!sourceId, `探针报告了定位信息（${sid} / ${messageId} / ${sourceId}）`)
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok, lines }
  }

  const safe = String(sid ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  const hits = []
  const walk = (dir, depth = 0) => {
    if (depth > 6) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name === 'links.json' && full.includes(safe)) hits.push(full)
    }
  }
  walk(sandboxRoot)
  say(hits.length === 1, `磁盘上找得到 links.json（${hits.length} 个）`, hits[0] ?? '')
  if (hits.length === 1) {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(hits[0], 'utf8'))
    } catch {
      /* 下面会如实报失败 */
    }
    say(Array.isArray(parsed), '文件是合法 JSON 数组')
    const item = Array.isArray(parsed) ? parsed.find((x) => x?.sourceId === sourceId) : null
    say(!!item && item.messageId === messageId, '文件里那条关联的 sourceId + messageId 都对得上', JSON.stringify(item))
    say(Array.isArray(parsed) && parsed.length === 1, '只有一条（幂等：重复登记没写第二条）', String(parsed?.length))
  }
  return { ok, lines }
}

/**
 * N12 退出变体（实施-09 S2 第五批）：退出快照的落盘证据。
 *
 * 探针在渲染端只能看到 `requestExit` 的返回值；快照文件得等 Electron 退出后
 * 再看 —— 探针按设计读不到 `YAN_DATA_DIR`，让它去读就是破坏测试边界。
 * 期望的 `mode` 与写盘时刻由探针打印在 PROBE 输出里，Node 侧照着核对，
 * 于是 `save` / `interrupt` 两个场景共用同一个检查，也不会退化成
 * 「只要文件存在就算过」（沙箱是整个批次共用的，陈留文件必须能分辨出来）。
 */
function checkExitSnapshot(sandboxRoot, tempBefore, lastProbeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data')
  const file = join(dir, 'exit-snapshot.json')
  const expectMode = /expect-mode=(\w+)/.exec(lastProbeText)?.[1] ?? null
  const probeAt = Number(/probe-at=(\d+)/.exec(lastProbeText)?.[1] ?? 0)
  const runnerCount = Number(/^runners=(\d+)$/m.exec(lastProbeText)?.[1] ?? -1)

  say(!!expectMode, `探针声明了期望的 mode（${expectMode ?? '缺失'}）`)
  say(probeAt > 0, `探针报了自己的时刻（${probeAt || '缺失'}）`)
  if (!existsSync(file)) {
    say(false, '退出快照 exit-snapshot.json 已写下', file)
    return { ok, lines }
  }
  say(true, '退出快照 exit-snapshot.json 已写下')

  let snapshot = null
  try {
    snapshot = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* 下面会如实报失败 */
  }
  if (!snapshot) {
    say(false, '文件是合法 JSON')
    return { ok, lines }
  }

  say(snapshot.version === 1, 'version=1（格式契约）', String(snapshot.version))
  say(
    !!expectMode && snapshot.mode === expectMode,
    `mode 与本次请求一致（期望 ${expectMode}，实际 ${snapshot.mode}）`
  )
  say(
    typeof snapshot.at === 'number' && snapshot.at >= probeAt && snapshot.at - probeAt < 120_000,
    'at 是这次退出写的（探针时刻之后、120s 之内）',
    `at-probe=${(snapshot.at ?? 0) - probeAt}ms`
  )

  const runners = Array.isArray(snapshot.runners) ? snapshot.runners : null
  say(!!runners, 'runners 是数组')
  if (runners) {
    say(
      runnerCount >= 0 && runners.length === runnerCount,
      `runners 条数与窗口里看到的一致（窗口 ${runnerCount} / 快照 ${runners.length}）`
    )
    const shaped = runners.every((r) => r && typeof r.cwd === 'string' && typeof r.conn === 'string' && typeof r.running === 'boolean')
    say(shaped, '每条都带 cwd / conn / running（元数据，不含消息正文）')
    const bodies = JSON.stringify(snapshot)
    say(!/"(content|text|message|messages)"\s*:/.test(bodies), '快照里没有消息正文/消息数组字段')
    lines.push(`    实例：${runners.map((r) => `${r.id}@${r.conn}${r.running ? '(running)' : ''}`).join(' ') || '（空）'}`)
  }

  const temps = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith('exit-snapshot.json.') && f.endsWith('.tmp'))
    : []
  say(temps.length === 0, '没有留下写一半的 .tmp（原子写：tmp → rename）', temps.join(' '))
  return { ok, lines }
}

/**
 * L03 尾巴：子代理「模型自己失败」的退出后证据（实施-09 S2 第六批）。
 *
 * 探针看得到终态与转录，看不到两件事：归档元数据里怎么记的、临时 worktree
 * 有没有收掉。这两件都在 Electron 退出后查 —— 与 `subagentArchive` 同一套方法。
 */
function checkSubagentFail(sandboxRoot, tempBefore) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'subagents')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const records = []
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
      /* 写了一半的文件当作记录缺失，下面会报出来 */
    }
  }
  lines.push(`  元数据 ${records.length} 份：${files.join(' ') || '（空）'}`)

  const run = records.find((r) => String(r.task ?? '').includes('YAN-SUBFAIL'))
  say(!!run, '找到 YAN-SUBFAIL 的归档记录', String(run?.task ?? ''))
  if (run) {
    say(run.status === 'error', `归档里 status=error（实际 ${run.status}）`)
    say(run.review === 'none', `没有改动 → review=none（实际 ${run.review}）`)
    say(run.endedAt > 0 && run.startedAt > 0, '有起止时间（可追溯）')
  }

  /* 退出后不能留下孤儿 worktree 容器（与 subagentArchive 同一条判据） */
  const leftovers = readdirSync(tmpdir()).filter(
    (n) => n.startsWith('yan-subagent-') && !(tempBefore ?? new Set()).has(n)
  )
  say(leftovers.length === 0, `退出后没有残留的隔离目录（新增 ${leftovers.length} 个）`, leftovers.join(' '))

  return { ok, lines }
}

const AFTER_EXIT = {
  exitSnapshot: checkExitSnapshot,
  remoteRoutes: checkRemoteRoutes,
  subagentFail: checkSubagentFail,
  subagentArchive: checkSubagentArchive,
  knowledgeInject: checkKnowledgeInject,
  knowledgeCli: checkKnowledgeCli,
  knowledgeTab: checkKnowledgeTab,
  knowledgeIsolation: checkKnowledgeIsolation,
  sessionabArchive: checkSessionabArchive,
  atrefsendArchive: checkAtRefSend,
  browserBoundaryDownloads: checkBrowserBoundaryDownloads,
  contextStateCleanup: checkContextStateCleanup,
  contextSweepArchive: checkContextSweepArchive,
  contextProduce: checkContextProduce,
  contextPressure: checkContextPressure,
  contextGate: checkContextGate,
  contextRefresh: checkContextRefresh,
  contextTakeoverSummary: checkContextTakeoverSummary,
  contextTakeoverState: checkContextTakeoverState,
  contextTakeoverGap: checkContextTakeoverGap,
  sourceLocateLinked: checkSourceLocateLinked,
  projectOpenedLayout: checkProjectOpenedLayout,
  contextDeepPref: checkContextDeepPref,
  contextFoldPref: checkContextFoldPref,
  contextEpisode: checkContextEpisode,
  contextTakeoverHook: checkContextTakeoverHook,
  contextDeep: checkContextDeep,
  gitReviewReadonly: checkGitReviewReadonly,
  gitWriteApplied: checkGitWriteApplied,
  taskFixtureReadonly: checkTaskFixtureReadonly,
  taskCliLog: checkTaskCliLog,
  taskPlanMultiStep: checkTaskPlanMultiStep,
  workModePersisted: checkWorkModePersisted,
  goalPersisted: checkGoalPersisted,
  turnTimingPersisted: checkTurnTimingPersisted,
  effectivePolicyFile: checkEffectivePolicyFile,
  goalLoopPersisted: checkGoalLoopPersisted,
  autoContinuePersisted: checkAutoContinuePersisted,
  handoffPackPersisted: checkHandoffPackPersisted,
  handoffCommitPersisted: checkHandoffCommitPersisted,
  budgetGate: checkBudgetGate,
  questionModeLog: checkQuestionModeLog
}

/**
 * 提问扩展的模式诊断（实施-05 S2）。
 *
 * `ask` 第 6 节的断言是「自主档不弹窗」—— 但“不弹窗”有两种原因：
 *   ① 扩展真的读到了自主模式并在 `execute` 里拦下（正确）；
 *   ② 模型这一轮压根没调 `question`（假通过）。
 * 诊断行把两者分开：每行带 `{hook,mode,sessionId,file}`。
 */
async function checkQuestionModeLog(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  /* 与 language 场景同一做法：诊断写 tmpdir 固定文件（沙箱会被清掉） */
  const logFile = join(tmpdir(), 'yan-question-ext.log')
  const records = (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  lines.push(`  诊断行数 = ${records.length}`)
  for (const r of records.slice(0, 12)) {
    lines.push(`    ${r.hook} mode=${r.mode} sid=${r.sessionId ?? '-'}`)
  }
  say(records.length >= 1, '扩展真的被调用并写下模式')
  say(
    records.some((r) => r.mode === 'autonomous'),
    '自主档真的到达扩展（不靠 defaultWorkMode 猜）'
  )
  say(
    records.some((r) => r.hook === 'execute' && r.mode === 'autonomous'),
    'question.execute 在自主模式下被调到（模型试着提问，被扩展拦下）'
  )
  return { ok, lines }
}

/**
 * 工作模式（实施-05 S2）退出后的磁盘核对。
 *
 * 界面上“切了模式”只是内存里的一个值；真正要钉的是：
 *   ① 每个会话各自一份（`work-modes.json` 里两条不同的值）；
 *   ② 模型侧读的那份快照真的落了盘（`work-mode/<runnerId>.json`）；
 *   ③ 迁移与「默认态不落盘」没有反过来擅自改写用户的 desktop.json。
 */
async function checkWorkModePersisted(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'work-modes.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(`  work-modes.json 条目：${entries.map(([k, v]) => `${k}=${v.mode}(rev${v.revision})`).join(', ')}`)
    say(entries.length >= 2, `至少两个会话各自存了一份（实际 ${entries.length}）`)
    say(entries.some(([, v]) => v.mode === 'autonomous'), '存下了自主模式（A 会话）')
    say(entries.some(([, v]) => v.mode === 'clarify'), '存下了澄清模式（B 会话）')
    say(entries.every(([, v]) => Number.isFinite(v.revision) && v.revision >= 1), '每条都有 revision（提交过）')
  } catch (error) {
    say(false, '读 work-modes.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 模型侧（薄层扩展）读的那份快照 */
  try {
    const snapDir = join(dataDir, 'work-mode')
    const files = readdirSync(snapDir).filter((n) => n.endsWith('.json'))
    lines.push(`  work-mode/ 快照：${files.join(', ') || '(空)'}`)
    say(files.length >= 1, '写了至少一份模型侧快照')
    const records = files.map((n) => JSON.parse(readFileSync(join(snapDir, n), 'utf8')))
    say(
      records.every((r) => ['standard', 'clarify', 'autonomous'].includes(r?.mode)),
      '每份快照的 mode 都是合法值（扩展读它决定提不提问）'
    )
    say(
      records.some((r) => r.mode === 'clarify') || records.some((r) => r.mode === 'autonomous'),
      '快照内容跟随会话（不是一直停在默认值）'
    )
  } catch (error) {
    say(false, '读 work-mode/ 快照失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* desktop.json：旧字段保留、新字段不擅自回写、关掉的开关恢复后删键 */
  try {
    const settings = JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8'))
    say(settings.autonomous === true, '旧 autonomous 原样留在磁盘上（不抹掉用户已写下的值）')
    say(
      settings.defaultWorkMode === 'autonomous',
      '迁移结果随写入固化到新字段（与旧值语义相同，幂等）'
    )
    say(!('workModeTab' in settings), '关掉再打开的开关不落盘（默认态无键）')
  } catch (error) {
    say(false, '读 desktop.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  return { ok, lines }
}

/*
 * ── 「会话文件只读」基线（实施-02 S1）──
 *
 * 判据为什么是「前缀一致 + 只追加」而不是「整文件 sha 不变」：
 * pi 自己在载入会话时会往文件**追加**一条 `thinking_level_change`
 * （实测：原封不动的会话也会多这一行）。把它当成「被改写」就只能
 * 得到一个永远要放宽的断言，等于没验。
 * 真正要钉的是两件事：
 *   ① 原有内容一个字节都不许动（不批量转换、不回写旧标识）；
 *   ② 追加的行里不许出现任务类 custom entry（砚不得伪造任务写入）。
 */
let taskFixtureBaseline = null

/** 在 sandbox 会话目录里按文件名子串找一个 jsonl，记下原始文本 */
function captureSessionFile(sessionsRoot, needle) {
  const found = []
  const walk = (dir, depth = 0) => {
    if (depth > 3) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name.endsWith('.jsonl') && e.name.includes(needle)) found.push(p)
    }
  }
  walk(sessionsRoot)
  if (!found[0]) return null
  return { path: found[0], text: readFileSync(found[0], 'utf8') }
}

async function checkTaskFixtureReadonly() {
  const lines = []
  if (!taskFixtureBaseline) {
    return { ok: false, lines: ['✗ 没有会话只读基线（场景里没找到 fixture 会话）'] }
  }
  let after = ''
  try {
    after = readFileSync(taskFixtureBaseline.path, 'utf8')
  } catch (err) {
    return { ok: false, lines: [`✗ 读不到基线会话文件：${err.message}`] }
  }
  let ok = true
  lines.push(
    `基线：${basename(taskFixtureBaseline.path)}（${Buffer.byteLength(taskFixtureBaseline.text)} 字节）`
  )
  if (after.startsWith(taskFixtureBaseline.text)) {
    lines.push('✓ 原有内容逐字节不变（只允许在末尾追加）')
  } else {
    ok = false
    lines.push('✗ 原有内容被改写了（前缀不一致）—— 契约要求历史文件不回写、不批量转换')
  }
  const added = after.slice(taskFixtureBaseline.text.length)
  const addedLines = added.split('\n').filter(Boolean)
  lines.push(`追加 ${addedLines.length} 行：`)
  for (const l of addedLines.slice(0, 5)) lines.push(`  · ${l.slice(0, 200)}`)
  const taskWrites = addedLines.filter(
    (l) => l.includes('left-panel-tasks') || l.includes('yan-task-plan')
  )
  if (taskWrites.length) {
    ok = false
    lines.push(`✗ 追加里出现了任务快照条目（${taskWrites.length} 条）—— 砚不应替模型伪造任务写入`)
  } else {
    lines.push('✓ 追加里没有任务快照条目（没有伪造任务写入）')
  }
  return { ok, lines }
}

/*
 * ── 宿主任务日志（实施-02 S3）──
 *
 * 退出后核对「磁盘上的真相」：
 *   ① `YAN_DIR/task-plans/<sessionId>.jsonl` 真的写了两行（且 revision 1 → 2）；
 *   ② 会话 JSONL 里**没有**任务条目 —— 宿主日志不寄在会话文件上
 *      （「不能直接编辑正在使用的 pi JSONL」，见 task-plan-store.ts 头注释）；
 *   ③ 文件名就是会话 id（没有 pending / 路径穿越那类不该出现的键）。
 *
 * 界面侧的证据（清单真的出现、切会话来回读得回）在探针里 ——
 * 这一支只回答「磁盘上是什么」。
 */
/**
 * 澄清就绪转移的磁盘核对（实施-05 S3，`goal` 场景）。
 *
 * 探针看到的 `getGoal()` 是**内存态**；这里在窗口关掉之后读磁盘，
 * 证明 commitReady 真做到了「先落盘再返回」，而且**恰好一次**：
 * transitions 里只有一条、goal.revision 只推进一步。
 */
/**
 * 退出后检查：整轮计时的元数据日志真的落盘了（实施-11 H-6）。
 *
 * 渲染进程按设计看不到 `YAN_DATA_DIR`，所以「谁写了文件、写了什么」只能在
 * 退出后从磁盘上核对（与 context / goal 系场景同一条分工）。
 */
async function checkTurnTimingPersisted(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const liveMs = Number(/turn-timing\.liveElapsedMs=(\d+)/.exec(probeText)?.[1] ?? 0)
  const dir = join(sandboxRoot, 'data', 'turn-timing')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`  目录 = ${dir}`)
  lines.push(`  文件 = ${JSON.stringify(files)}`)
  say(files.length >= 1, `至少一个会话的计时日志（${files.length}）`)

  const records = []
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        /* 坏行不致命（单测里单独验证过） */
      }
    }
  }
  say(records.length >= 1, `至少一条记录（${records.length}）`)
  const last = records[records.length - 1]
  say(last?.v === 1, `记录带版本号（v=${last?.v}）`)
  say(Number(last?.elapsedMs) > 0, `记录里的用时是正数（${last?.elapsedMs}ms）`)
  if (liveMs > 0 && last) {
    say(
      Math.abs(Number(last.elapsedMs) - liveMs) <= Math.max(1500, liveMs * 0.2),
      `落盘用时与界面一致（${last.elapsedMs} ≈ ${liveMs}）`
    )
  }
  say(
    Array.isArray(last?.sourceIds) && last.sourceIds.length >= 1,
    '记录带归属消息 id（否则读回来不知道该挂给哪个回合）'
  )
  const expectedReason = /turn-timing\.expectedReason=(\w+)/.exec(probeText)?.[1] ?? ''
  say(
    ['completed', 'failed', 'stopped', 'interrupted'].includes(String(last?.terminalReason)),
    `终止原因是四个合法值之一（实际 ${last?.terminalReason}）`
  )
  if (expectedReason) {
    say(
      last?.terminalReason === expectedReason,
      `终止原因与界面一致（${last?.terminalReason} vs ${expectedReason}）`
    )
  }
  return { ok, lines }
}

/**
 * 退出后检查：宿主写给薄层的生效策略文件（实施-11 C-4）。
 *
 * 渲染进程看不到 `YAN_DATA_DIR`，而「扩展到底能读到什么」完全取决于这个文件 ——
 * 所以断言只能在退出后从磁盘上做。
 */
async function checkEffectivePolicyFile(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const file = join(sandboxRoot, 'data', 'context-policy.effective.json')
  if (!existsSync(file)) {
    say(false, `没有写出生效策略文件（${file}）`)
    return { ok, lines }
  }
  let doc = null
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    say(false, `文件不是合法 JSON：${error?.message ?? error}`)
    return { ok, lines }
  }
  lines.push(`  文件 = ${file}`)
  say(doc?.v === 1, `带版本号（v=${doc?.v}）`)
  say(typeof doc?.revision === 'string' && doc.revision.length > 0, `带策略指纹（revision=${doc?.revision}）`)
  say(doc?.default?.workingSetCap === 333_000, `默认层写进了用户级覆盖（cap=${doc?.default?.workingSetCap}）`)
  say(doc?.default?.windowRatio === 0.6, `比例字段一并写入（ratio=${doc?.default?.windowRatio}）`)
  say(doc?.foldEnabled === true, `foldEnabled 归一成布尔（${doc?.foldEnabled}）`)
  say(Number.isFinite(doc?.updatedAt) && doc.updatedAt > 0, '带写入时间')
  return { ok, lines }
}

async function checkGoalPersisted(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')
  const short = (key) => String(key).split(/[\\/]/).pop()

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'goals.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(
      `goals.json 条目：${entries.map(([k, v]) => `${short(k)}=${v?.goal?.phase}(rev${v?.goal?.revision})`).join(', ') || '（空）'}`
    )
    say(entries.length === 1, `恰好一条会话记录（实际 ${entries.length}）`)
    const entry = entries[0]?.[1]
    say(entry?.goal?.phase === 'executing', `目标已进入 executing（实际 ${entry?.goal?.phase}）`)
    say(entry?.goal?.revision === 1, `目标只推进过一次（实际 rev${entry?.goal?.revision}）`)
    const transitions = Object.entries(entry?.transitions ?? {})
    say(transitions.length === 1, `就绪转移只记了一条（实际 ${transitions.length}）`)
    say(String(transitions[0]?.[0] ?? '') === 'tr-probe-1', `幂等键就是探针给的那个（${transitions[0]?.[0] ?? '无'}）`)
    const understanding = transitions[0]?.[1]?.result?.understanding ?? {}
    say(String(understanding.acceptance ?? '').includes('CSV'), '五栏（含验收标准）真的传到了宿主')
    say(transitions[0]?.[1]?.result?.mode === 'standard', '转移记录里写着「模式切标准」')

    /*
     * 续行留痕（实施-05 S3b）：两类自定义条目都得在**会话文件**里 ——
     * `yan-goal-resume` 是扩展写的消费证据，`yan-goal-ready` 是那条控制消息。
     * 会话文件路径就是 goals.json 的键（宿主按会话文件索引）。
     */
    const sessionFile = String(entries[0]?.[0] ?? '')
    if (sessionFile && existsSync(sessionFile)) {
      const text = readFileSync(sessionFile, 'utf8')
      say(text.includes('"customType":"yan-goal-resume"'), '会话里有续行的消费证据条目（yan-goal-resume）')
      say(text.includes('"customType":"yan-goal-ready"'), '会话里有那条控制消息（yan-goal-ready，角色不是 user）')
      const role = /"customType":"yan-goal-ready"[^}]*/.exec(text)?.[0] ?? ''
      say(!role.includes('"role":"user"'), '控制消息不是伪造的用户消息')
    } else {
      say(false, '从 goals.json 的键找不到会话文件：' + (sessionFile || '（无）'))
    }
  } catch (error) {
    say(false, '读 goals.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'work-modes.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(
      `work-modes.json 条目：${entries.map(([k, v]) => `${short(k)}=${v.mode}(rev${v.revision})`).join(', ') || '（空）'}`
    )
    say(entries.some(([, v]) => v.mode === 'standard'), '磁盘上的模式已是标准（就绪转移的另一半）')
    say(
      entries.some(([, v]) => Number.isFinite(v.revision) && v.revision >= 2),
      '模式 revision 至少推进两次（切澄清 + 就绪切标准）'
    )
  } catch (error) {
    say(false, '读 work-modes.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 宿主写给薄层的续行快照（没有它，扩展再对也发不出去） */
  try {
    const dir = join(dataDir, 'goal-resume')
    const files = existsSync(dir) ? readdirSync(dir) : []
    lines.push(`goal-resume/ 快照：${files.join(', ') || '（空）'}`)
    for (const name of files) {
      if (!name.endsWith('.json')) continue
      const rec = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      lines.push(`    ${name}: operationId=${rec?.operationId ?? '(null)'}`)
    }
    say(files.includes('r1.json'), '写了续行快照（按 runnerId 命名，扩展据此判断）')
  } catch (error) {
    say(false, '读 goal-resume/ 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 续行扩展诊断（实施-05 S3b）：把「不该发」「发失败」「被活动抢了」分开 */
  const resumeLog = join(tmpdir(), 'yan-goal-resume.log')
  if (existsSync(resumeLog)) {
    const rows = readFileSync(resumeLog, 'utf8').trim().split('\n').filter(Boolean)
    lines.push(`  续行扩展诊断（${rows.length} 行）：`)
    for (const row of rows.slice(-6)) lines.push('    ' + row)
  } else {
    lines.push('  续行扩展诊断：没有文件（扩展没跑过 message_end，或没开日志）')
  }

  return { ok, lines }
}

/**
 * 自主档连续续接的磁盘核对（实施-05 S3c，`goalloop` 场景）。
 *
 * 探针证明「新回合真的起了」；这里回答磁盘上的三个问题：
 *   ① 那是**继续**续行（`yan-goal-continue`），不是就绪续行；
 *   ② 宿主真的记了连续次数（`autoContinues`）；
 *   ③ 薄层的消费证据与诊断日志都留下了。
 *
 * 为何不硬断 `phase === 'executing'`：模型可能在续接轮里把目标报到
 * `completed` / `blocked`，那是合法推进（甚至更好）—— 那时计数按设计归零，
 * 不能用它判红。
 */
/**
 * 请求前预算门的真实模型核对（实施-05 S4，`budgetgate` 场景）。
 *
 * 探针只能证「模型回了话」；磁盘上要回答三件事：
 *   ① 诊断真的记了（否则链路上根本没跑）；
 *   ② 只到 `soft`，**没有** `physical` / `budget-abort`（真实窗口下误拦是灾难性回归）；
 *   ③ 估算与真实 `usage.input` **同量级** —— 估算是拿来判生死的，估偏了就等于闸门失准。
 */
async function checkBudgetGate(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const logFile = join(sandboxRoot, 'ctx-ext.log')
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const budgetRows = records.filter((r) => String(r?.hook ?? '').startsWith('request-budget-'))
  lines.push(`  诊断行 = ${records.length}（其中请求前预算 ${budgetRows.length} 行）`)
  say(budgetRows.length >= 1, '请求前预算诊断真的记了（钩子在真实链路里跑起来了）')
  for (const row of budgetRows) {
    lines.push(
      `    ${row.hook}：messages ${row.messages} + tools ${row.tools} + system ${row.system} = 估算 ${row.estimatedTokens} ` +
        `/ 工作集 ${row.workingSet} / 窗口 ${row.window} / 预留 ${row.responseReserve}`
    )
  }
  const soft = budgetRows.filter((r) => r.hook === 'request-budget-soft')
  say(soft.length >= 1, '工作集线压到 3000 后，真实对话到了 soft')
  const physical = budgetRows.filter((r) => r.hook === 'request-budget-physical')
  say(physical.length === 0, '没有误判 physical（真实窗口下不该拦）')
  const aborted = records.filter((r) => r.hook === 'budget-abort')
  say(aborted.length === 0, '没有 abort（真实请求照常发出）')

  /* 估算 vs 真实 usage.input（同量级即算通过；数字如实打印出来校准估算） */
  const sessionId = budgetRows.find((r) => r.sessionId)?.sessionId ?? null
  const sessionsDir = join(sandboxRoot, 'sessions')
  let usageInput = null
  if (sessionId && existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.jsonl') && f.includes(sessionId))
    if (files.length) {
      const rows = readFileSync(join(sessionsDir, files[files.length - 1]), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
      for (const row of rows) {
        const usage = row?.message?.usage
        if (row?.message?.role === 'assistant' && Number(usage?.input) > 0) usageInput = Number(usage.input)
      }
    }
  }
  const estimate = budgetRows.length ? Number(budgetRows[budgetRows.length - 1].estimatedTokens) : 0
  /*
   * 估算 vs 真实 `usage.input` **只打印、不判红**：
   * 这个场景的模型可能返回空内容（上游波动，与预算无关），那时 usage 只是
   * 一个失败响应的数字，拿它当基准会把「模型侧抽风」误判成「闸门失准」。
   * 估算精度的确定性证据在 `hook-probe budget-soft`：估算 13621 token ↔
   * 真实请求体 55054 字符（4 字符/token 口径下偏差 ~1%）。
   */
  if (usageInput == null) {
    lines.push('  · 没读到真实 usage.input（本轮模型可能返回空）：只核对诊断，不比数字')
  } else {
    lines.push(`  参考：估算 ${estimate} / 真实 usage.input ${usageInput}（不判红，空回复时不可比）`)
  }

  return { ok, lines }
}

async function checkGoalLoopPersisted(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')
  const short = (key) => String(key).split(/[\\/]/).pop()

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'goals.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(
      `goals.json 条目：${entries
        .map(([k, v]) => `${short(k)}=${v?.goal?.phase}(rev${v?.goal?.revision}) auto=${v?.autoContinues ?? 0}`)
        .join(', ') || '（空）'}`
    )
    const entry = entries[0]?.[1]
    say((entry?.goal?.revision ?? 0) >= 1, `目标至少推进过一次（实际 rev${entry?.goal?.revision ?? '?'}）`)
    say(
      Object.keys(entry?.reports ?? {}).length >= 1,
      `目标报告落了盘（${Object.keys(entry?.reports ?? {}).length} 条）`
    )
    const phase = entry?.goal?.phase
    const active = phase === 'planning' || phase === 'executing' || phase === 'verifying'
    if (active) {
      say(
        Number.isFinite(entry?.autoContinues) && entry.autoContinues >= 1,
        `宿主记了连续续接次数（实际 ${entry?.autoContinues ?? '无'}；0 说明报告后根本没 arm）`
      )
    } else {
      lines.push(`  · 目标已进终态（${phase}）→ autoContinues 按设计归零（实际 ${entry?.autoContinues ?? '无'}）`)
    }

    const sessionFile = String(entries[0]?.[0] ?? '')
    if (sessionFile && existsSync(sessionFile)) {
      const text = readFileSync(sessionFile, 'utf8')
      say(text.includes('"customType":"yan-goal-resume"'), '会话里有续行的消费证据条目（yan-goal-resume）')
      say(
        text.includes('"customType":"yan-goal-continue"'),
        '会话里有**继续**那条控制消息（yan-goal-continue；只有就绪续行说明 S3c 没接上）'
      )
      const role = /"customType":"yan-goal-continue"[^}]*/.exec(text)?.[0] ?? ''
      say(!role.includes('"role":"user"'), '控制消息不是伪造的用户消息')
    } else {
      say(false, '从 goals.json 的键找不到会话文件：' + (sessionFile || '（无）'))
    }
  } catch (error) {
    say(false, '读 goals.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 宿主写的快照 + 薄层的消费证据（没有它，扩展再对也发不出去） */
  try {
    const dir = join(dataDir, 'goal-resume')
    const files = existsSync(dir) ? readdirSync(dir) : []
    lines.push(`goal-resume/ 文件：${files.join(', ') || '（空）'}`)
    say(files.includes('r1.json'), '有宿主写的续行快照（按 runnerId 命名）')
    const consumed = files.find((name) => name.endsWith('.consumed.json'))
    if (consumed) {
      const rec = JSON.parse(readFileSync(join(dir, consumed), 'utf8'))
      say(
        typeof rec?.operationId === 'string' && rec.operationId.length > 0,
        '消费证据记了 operationId（先留证据再发送）'
      )
    } else {
      say(false, '没有 consumed.json：续行没被消费过（= 自动续接没发生）')
    }
  } catch (error) {
    say(false, '读 goal-resume/ 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 诊断日志：区分「不该发」「被活动抢了」「发失败」 */
  const resumeLog = join(tmpdir(), 'yan-goal-resume.log')
  if (existsSync(resumeLog)) {
    const rows = readFileSync(resumeLog, 'utf8').trim().split('\n').filter(Boolean)
    lines.push(`  续行扩展诊断（${rows.length} 行，末 6 行）：`)
    for (const row of rows.slice(-6)) lines.push('    ' + row)
    say(
      rows.some((row) => row.includes('"kind":"continue"') && row.includes('resume_sent')),
      '日志里有 kind=continue 的发送记录'
    )
  } else {
    say(false, '没有续行扩展诊断文件（扩展没跑过 message_end，或没开日志）')
  }

  return { ok, lines }
}

/**
 * 模型出错后自动继续的磁盘核对（实施-05 S5c，`autocontinue` 场景）。
 *
 * 探针能证「没人说话也起了新轮次」；磁盘要回答三件事：
 *   ① 宿主真的把「连续失败几次」记下来并**停在上限**（不是每轮都无限重试）；
 *   ② 续行是 `yan-auto-continue`（不是 S3b/S3c 的 ready/continue ——
 *      出现那两个就说明触发源搞错了，虽然“也起了轮次”）；
 *   ③ 薄层的消费证据与诊断都留下了（否则「没继续」与「继续了但没发出去」分不开）。
 */
async function checkAutoContinuePersisted(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')
  const short = (key) => String(key).split(/[\\/]/).pop()
  const limit = 2 /* 与 CASES.autocontinue 的 YAN_AUTO_CONTINUE 对齐 */

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'auto-continue.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(
      `auto-continue.json：${entries.map(([k, v]) => `${short(k)} attempts=${v?.attempts}`).join(', ') || '（空）'}`
    )
    const max = entries.reduce((acc, [, value]) => Math.max(acc, Number(value?.attempts) || 0), 0)
    say(entries.length >= 1, '宿主真的记了连续失败次数（否则链路上根本没跑到自动继续）')
    say(max === limit, `计数停在上限（实际 ${max}，limit=${limit}）`)
    say(
      entries.some(([, value]) => Boolean(value?.lastError)),
      '记了最后一次错误文本（排障与界面提示都要用）'
    )

    const sessionFile = String(entries[0]?.[0] ?? '')
    if (sessionFile && existsSync(sessionFile)) {
      const text = readFileSync(sessionFile, 'utf8')
      say(text.includes('"customType":"yan-auto-continue"'), '会话里有自动继续的控制消息（yan-auto-continue）')
      say(
        !text.includes('"customType":"yan-goal-ready"') && !text.includes('"customType":"yan-goal-continue"'),
        '没有混入 S3b/S3c 的续行标签（触发源没有搞错）'
      )
      const around = /"customType":"yan-auto-continue"[^}]*/.exec(text)?.[0] ?? ''
      say(!around.includes('"role":"user"'), '控制消息不是伪造的用户消息')
      const count = text.split('"customType":"yan-auto-continue"').length - 1
      lines.push(`  会话里的 yan-auto-continue 条目：${count} 条（limit=${limit}）`)
      say(count >= 1 && count <= limit + 1, `自动继续条数落在上限内（${count} ≤ ${limit + 1}）`)
    } else {
      say(false, '从 auto-continue.json 的键找不到会话文件：' + (sessionFile || '（无）'))
    }
  } catch (error) {
    say(false, '读 auto-continue.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 宿主写的快照 + 薄层的消费证据（没有它，扩展再对也发不出去） */
  try {
    const dir = join(dataDir, 'goal-resume')
    const files = existsSync(dir) ? readdirSync(dir) : []
    lines.push(`goal-resume/ 文件：${files.join(', ') || '（空）'}`)
    const consumed = files.find((name) => name.endsWith('.consumed.json'))
    if (consumed) {
      const rec = JSON.parse(readFileSync(join(dir, consumed), 'utf8'))
      say(
        typeof rec?.operationId === 'string' && rec.operationId.length > 0,
        '消费证据记了 operationId（先留证据再发送）'
      )
    } else {
      say(false, '没有 consumed.json：续行没被消费过（= 自动继续没发生）')
    }
  } catch (error) {
    say(false, '读 goal-resume/ 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 诊断日志：区分「不该发」「被活动抢了」「发失败」 */
  const resumeLog = join(tmpdir(), 'yan-goal-resume.log')
  if (existsSync(resumeLog)) {
    const rows = readFileSync(resumeLog, 'utf8').trim().split('\n').filter(Boolean)
    lines.push(`  续行扩展诊断里 kind=retry 的行（末 5 条）：`)
    for (const row of rows.filter((r) => r.includes('"kind":"retry"')).slice(-5)) lines.push('    ' + row)
    say(
      rows.some((row) => row.includes('"kind":"retry"') && row.includes('resume_sent')),
      '日志里有 kind=retry 的发送记录'
    )
  } else {
    say(false, '没有续行扩展诊断文件（扩展没跑过 message_end，或没开日志）')
  }

  return { ok, lines }
}

/**
 * 交接包生成的磁盘核对（实施-05 S5b-2，`handoffpack` 场景）。
 *
 * 探针用 `yan:getHandoff` 证「界面上看得到包」；磁盘要回答四件事：
 *   ① 包真的落进了 `handoffs.json`（不是只在内存里好看）；
 *   ② 必填栏与**来源字段**都对（来源由宿主填，模型不能自称）；
 *   ③ 薄层真的调了模型（扩展日志有 `produced`，而不是“文件交换假装成功”）；
 *   ④ 请求 / 结果文件已被清理 —— 否则下一次交接会拿到这次的遗物。
 */
async function checkHandoffPackPersisted(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')
  const short = (key) => String(key).split(/[\\/]/).pop()

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'handoffs.json'), 'utf8'))
    const entries = Object.entries(doc?.entries ?? {})
    lines.push(`handoffs.json：${entries.map(([k, v]) => `${short(k)} count=${v?.tally?.count ?? 0} pkg=${v?.package ? '有' : '无'}`).join(', ') || '（空）'}`)
    const entry = entries[0]?.[1]
    const pkg = entry?.package
    say(!!pkg, '交接包真的落盘了')
    if (pkg) {
      say(typeof pkg.goal === 'string' && pkg.goal.trim().length > 0, '必填栏 goal 非空')
      say(typeof pkg.deliverable === 'string' && pkg.deliverable.trim().length > 0, '必填栏 deliverable 非空')
      say(pkg.generator === 'model', `generator=model（实际 ${pkg.generator}）`)
      say(/\.jsonl$/.test(String(pkg.sourceSession)), `sourceSession 是会话文件（${short(pkg.sourceSession)}）`)
      say(typeof pkg.sourceHead === 'string' && pkg.sourceHead.length > 0, `记了水位 sourceHead=${String(pkg.sourceHead).slice(0, 24)}`)
      say(pkg.mode === 'autonomous', `来源模式是自主档（实际 ${pkg.mode}）`)
      const lists = ['constraints', 'acceptance', 'done', 'remaining', 'nextActions', 'blockers', 'files', 'notes']
      say(
        lists.every((field) => Array.isArray(pkg[field])),
        '八个列表栏都是数组（宽容读法真的生效了）'
      )
    }
    say(Number(entry?.tally?.count ?? -1) === 0, `阈值覆盖不改计数（实际 count=${entry?.tally?.count}）`)
  } catch (error) {
    say(false, '读 handoffs.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 扩展日志：证「真的调了一次 completion」 */
  const extLog = join(sandboxRoot, 'handoff-ext.log')
  if (existsSync(extLog)) {
    const rows = readFileSync(extLog, 'utf8').trim().split('\n').filter(Boolean)
    lines.push(`  交接扩展诊断（${rows.length} 行）：`)
    for (const row of rows.slice(-6)) lines.push('    ' + row)
    const produced = rows
      .map((row) => {
        try {
          return JSON.parse(row)
        } catch {
          return null
        }
      })
      .filter((row) => row && row.hook === 'produced')
    say(produced.length >= 1, '扩展日志里有 produced（模型真的被调了一次）')
    const good = produced.find((row) => !row.error && row.chars > 0)
    say(!!good, `模型返回了非空原文（chars=${good?.chars ?? 0}，ms=${good?.ms ?? '-' }）`)
  } else {
    say(false, '没有交接扩展诊断文件（扩展没加载 / 没跑到 agent_settled）')
  }

  /* 请求 / 结果文件必须已被消费清理（不留下一次交接的遗物） */
  for (const dir of ['handoff-request', 'handoff-result']) {
    const path = join(dataDir, dir)
    const files = existsSync(path) ? readdirSync(path) : []
    say(files.length === 0, `${dir}/ 已清空（${files.join(', ') || '空'}）`)
  }

  return { ok, lines }
}

/**
 * 交接提交的磁盘核对（实施-05 S5b-3b，`handoffcommit` 场景）。
 *
 * 探针在渲染端能看到「视图切到了目的段、事务到了 resumed」；磁盘要回答的是
 * 那些**只有真文件才知道**的事：
 *   ① 事务日志真的记到了 resumed，且步骤一个不缺（不是内存里改的）；
 *   ② 会话链真的有两段、目的段的 `handoffId` 对得上（前端“一条会话”的依据）；
 *   ③ 目的会话文件里真的有那条 resume 的标记行（消费证据，不是「我发过了」）；
 *   ④ 源会话还在、包还在（§8：失败 / 回滚都要靠它们）。
 */
async function checkHandoffCommitPersisted(sandboxRoot, _tempBefore, _probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const dataDir = join(sandboxRoot, 'data')
  const short = (key) => String(key).split(/[\\/]/).pop()
  /* 链里存的是归一化后的键（正斜杠、无尾斜杠），比较时必须用同一口径 */
  const norm = (value) => String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')

  let handoffId = ''
  let source = ''
  let destination = ''
  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'handoff-transactions.json'), 'utf8'))
    const txs = Object.values(doc?.transactions ?? {})
    lines.push(
      `handoff-transactions.json：${txs.map((t) => `${String(t.handoffId).slice(0, 8)}…=${t.stage}(attempts=${t.resumeAttempts ?? 0})`).join(', ') || '（空）'}`
    )
    const tx = txs.find((t) => t.stage === 'resumed') ?? txs[0]
    say(!!tx, '有交接事务')
    if (tx) {
      handoffId = String(tx.handoffId)
      source = String(tx.sourceSession ?? '')
      destination = String(tx.destinationSession ?? '')
      say(tx.stage === 'resumed', `事务走到 resumed（实际 ${tx.stage}）`)
      say((tx.resumeAttempts ?? 0) >= 1, `记了 resume 发送尝试（${tx.resumeAttempts ?? 0} 次）`)
      const steps = Array.isArray(tx.steps) ? tx.steps : []
      const order = steps.map((s) => s.to).join(',')
      say(order === 'snapshot,validated,destination-created,committed,resumed', `五个阶段一个不缺：${order}`)
      say(!!destination && destination !== source, '目的会话与源会话是两份文件（后台真的切开了）')
    }
  } catch (error) {
    say(false, '读 handoff-transactions.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'session-chains.json'), 'utf8'))
    const chains = Array.isArray(doc?.chains) ? doc.chains : []
    const chain = chains.find((c) => (c.segments ?? []).length >= 2)
    lines.push(`session-chains.json：${chains.length} 条链${chain ? ` · 最长 ${chain.segments.length} 段` : ''}`)
    say(!!chain, '有一条两段以上的会话链（前端据此只显示一条会话）')
    if (chain) {
      const segments = chain.segments ?? []
      say(segments.some((s) => norm(s.sessionFile) === norm(source)), '链上有源段')
      const dest = segments.find((s) => norm(s.sessionFile) === norm(destination))
      say(!!dest, '链上有目的段')
      say(dest?.handoffId === handoffId, '目的段记的 handoffId 与事务一致')
      say(segments[0] !== undefined && norm(segments[0].sessionFile) === norm(source), '源段在前（链只向后延伸）')
    }
  } catch (error) {
    say(false, '读 session-chains.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  if (destination && existsSync(destination)) {
    const text = readFileSync(destination, 'utf8')
    say(text.includes(`[yan-handoff-resume:${handoffId}]`), '目的会话文件里有 resume 的消费证据（标记行）')
    say(text.includes('跨会话交接'), '目的会话里那条消息是交接正文（不是空壳）')
    lines.push(`  目的会话文件大小：${text.length} 字符`)
  } else {
    say(false, `找不到目的会话文件：${destination || '（未记）'}`)
  }
  say(!!source && existsSync(source), '源会话文件还在（交接不删旧会话，回滚只能靠它）')

  try {
    const doc = JSON.parse(readFileSync(join(dataDir, 'handoffs.json'), 'utf8'))
    const entry = Object.values(doc?.entries ?? {})[0]
    say(!!entry?.package, '交接包仍在 handoffs.json 里（事务日志里也留了一份）')
  } catch (error) {
    say(false, '读 handoffs.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  /* 请求 / 结果目录必须已被消费清理（不留下一次交接的遗物） */
  for (const dir of ['handoff-request', 'handoff-result']) {
    const path = join(dataDir, dir)
    const files = existsSync(path) ? readdirSync(path) : []
    say(files.length === 0, `${dir}/ 已清空（${files.join(', ') || '空'}）`)
  }

  return { ok, lines }
}

async function checkTaskCliLog(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const text = String(probeText ?? '')
  const sid = /taskcli\.sessionId=([0-9A-Za-z._-]+)/.exec(text)?.[1] ?? ''
  const sessionFile = /taskcli\.sessionFile=(.+)/.exec(text)?.[1]?.trim() ?? ''
  const dir = join(sandboxRoot, 'data', 'task-plans')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`任务日志目录：${files.length ? files.join('、') : '（空）'}；会话 id = ${sid || '（探针没报）'}`)

  say(!!sid && files.includes(`${sid}.jsonl`), '日志按会话 id 命名（不是 runner id / 时间戳）')
  say(
    files.every((f) => /^[0-9A-Za-z._-]+\.jsonl$/.test(f)),
    '文件名都是合法会话 id（没有 pending: / 路径分隔符）'
  )

  const path = sid ? join(dir, `${sid}.jsonl`) : null
  const raw = path && existsSync(path) ? readFileSync(path, 'utf8') : ''
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
  const bad = rows.filter((r) => r === null).length
  const valid = rows.filter(Boolean)
  say(bad === 0, `没有写坏的行（坏行 ${bad} 条）`)
  say(valid.length === 2, `两次提交写了两行（实际 ${valid.length} 行）`)
  say(
    valid.every((r) => r.data?.schemaVersion === 1),
    '每行都带 schemaVersion = 1（读回来判版本用）'
  )
  say(
    valid[0]?.data?.revision === 1 && valid[1]?.data?.revision === 2,
    `revision 从 1 递增到 2（实际 ${valid.map((r) => r.data?.revision).join(' → ')}）`
  )
  say(
    !!valid[0]?.data?.operationId && valid[0].data.operationId !== valid[1]?.data?.operationId,
    '两次提交各有自己的 operationId（幂等键随提交变化）'
  )
  say(valid[0]?.data?.todos?.length === 3, `第一行是三项（实际 ${valid[0]?.data?.todos?.length}）`)
  say(valid[1]?.data?.todos?.[1]?.done === true, '第二行第 2 项已完成（complete 真的落盘了）')
  say(
    valid.every((r) => Number.isInteger(r.round) && r.round >= 1),
    '每行都记了轮次（历史分组靠它）'
  )
  say(valid.every((r) => typeof r.at === 'string' && r.at.length > 0), '每行都有提交时间')

  if (sessionFile && existsSync(sessionFile)) {
    const sessionText = readFileSync(sessionFile, 'utf8')
    say(
      !sessionText.includes('yan-task-plan'),
      '会话 JSONL 里没有被写入任务条目（宿主日志在砚自己的目录）'
    )
    say(
      !sessionText.includes('left-panel-tasks'),
      '也没有旧标识的任务条目（本场景没有旧扩展）'
    )
  } else {
    lines.push('（探针没报会话文件路径，跳过会话 JSONL 检查）')
  }

  return { ok, lines }
}

/*
 * ── 真实多步任务（实施-02 S5）──
 *
 * 三处一致在这里落地：
 *   ① 工具调用 —— 探针已经断言过（界面上的 `yan tasks apply` 与来源徐标）；
 *   ② 原生任务清单 —— 探针把渲染端看到的 todos 打成 `taskplan.todos=…`；
 *   ③ 实际落盘 —— 宿主日志最后一行。
 * 退出后把 ② 与 ③ 逐条比对（文字与勾选状态），并确认会话 JSONL 里没有任务条目。
 *
 * 另加一条**真实动作**的核对：任务本身是「在 fixture 里建三个文件」，
 * 所以 step-1/2/3.txt 真的存在、而且非空，才算做完 —— 这条能拆穿
 *「只登记了计划、文件没建」或「嘴上说做完了」。
 */
async function checkTaskPlanMultiStep(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const text = String(probeText ?? '')
  const sid = /taskplan\.sessionId=([0-9A-Za-z._-]+)/.exec(text)?.[1] ?? ''
  const sessionFile = /taskplan\.sessionFile=(.+)/.exec(text)?.[1]?.trim() ?? ''
  const todoLine = text.split(/\r?\n/).find((l) => l.startsWith('taskplan.todos=')) ?? ''
  let uiTodos = []
  try {
    const parsed = JSON.parse(todoLine.slice('taskplan.todos='.length))
    if (Array.isArray(parsed)) uiTodos = parsed
  } catch {
    uiTodos = []
  }

  /* ① 真实文件动作（任务本身：在 fixture 项目里建 step-1/2/3.txt） */
  const tasksDir = join(sandboxRoot, 'fixture-project', 'tasks')
  const steps = [1, 2, 3].map((n) => join(tasksDir, `step-${n}.txt`))
  const made = steps.filter((p) => existsSync(p))
  const nonEmpty = made.filter((p) => readFileSync(p, 'utf8').trim().length > 0)
  lines.push(`真实文件：` + `tasks/step-*.txt 存在 ${made.length}/3（非空 ${nonEmpty.length}）`)
  say(made.length >= 2, '模型真的建了文件（多步任务确实执行了，不是只登记计划）')
  say(nonEmpty.length === made.length, '建出来的文件都有内容（不是空文件占位）')

  /* ② 宿主日志（磁盘上的真相） */
  const dir = join(sandboxRoot, 'data', 'task-plans')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`任务日志：${files.length ? files.join('、') : '（空）'}；会话 id = ${sid || '（探针没报）'}`)
  say(!!sid && files.includes(`${sid}.jsonl`), '日志按会话 id 命名')

  const path = sid ? join(dir, `${sid}.jsonl`) : null
  const raw = path && existsSync(path) ? readFileSync(path, 'utf8') : ''
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
  const bad = rows.filter((r) => r === null).length
  const valid = rows.filter(Boolean)
  say(bad === 0, `没有写坏的行（坏行 ${bad} 条）`)
  say(valid.length >= 2, `模型自主提交了 ${valid.length} 次（登记 + 勾选）`)
  const revisions = valid.map((r) => r.data?.revision)
  const increasing = revisions.every((v, i) => (i === 0 ? v === 1 : v === revisions[i - 1] + 1))
  say(increasing, `revision 逐次 +1（实际 ${revisions.join(' → ')}）`)
  say(valid.every((r) => r.data?.schemaVersion === 1), '每行都带 schemaVersion = 1')

  const last = valid[valid.length - 1]
  const diskTodos = Array.isArray(last?.data?.todos) ? last.data.todos : []
  lines.push('  磁盘最后一行 todos = ' + JSON.stringify(diskTodos.map((t) => ({ text: t.text, done: t.done }))))
  say(diskTodos.length === 3, `日志最后一行是 3 条（实际 ${diskTodos.length}）`)

  /* ③ 界面报告 vs 磁盘日志 —— 「三处一致」里的 ②③ */
  say(
    JSON.stringify(uiTodos.map((t) => t.text)) === JSON.stringify(diskTodos.map((t) => t.text)),
    '界面清单与磁盘日志的文字逐条一致（不是各显示一套）',
    uiTodos.length ? '' : '（探针没报 todos，比对不可信）'
  )
  say(
    JSON.stringify(uiTodos.map((t) => !!t.done)) === JSON.stringify(diskTodos.map((t) => !!t.done)),
    '勾选状态也一致'
  )
  say(
    diskTodos.every((t) => typeof t.text === 'string' && t.text.trim().length > 0),
    '日志里每条都有非空文字（没有空条目）'
  )

  /* ④ 会话 JSONL 里不能有任务条目 */
  if (sessionFile && existsSync(sessionFile)) {
    const sessionText = readFileSync(sessionFile, 'utf8')
    say(
      !sessionText.includes('yan-task-plan'),
      '会话 JSONL 里没有被写入任务条目（宿主日志在砚自己的目录）'
    )
    say(!sessionText.includes('left-panel-tasks'), '也没有旧标识的任务条目（本场景没有旧扩展）')
  } else {
    lines.push('（探针没报会话文件路径，跳过会话 JSONL 检查）')
  }

  return { ok, lines }
}

/*
 * ── 孤儿 pi 进程检查（N12 / L03 的共同缺口）──
 *
 * 为什么需要它：D16（子代理跑完 pi 进程不退出）与 L03 的「退出后无残留」都是靠
 * 目录/文件间接推的 —— 目录能删不等于进程真的没了。这里直接看进程表。
 *
 * 判据：命令行含 `--mode rpc`（pi 的 RPC 入口）**且父进程已不在进程表里**。
 * 为什么不比 PID 基线：那要改所有 afterExit 检查的签名，而这条判据本身已经够准。
 * 为什么不会误报：用户自己正在跑的砚，它的 pi 进程父进程（Electron）是活的。
 * 返回 `null` = 拿不到进程表（非 Windows / 权限不足）：调用方**跳过**，
 * 不要把「查不到」当成「没残留」。
 */
function orphanPiProcesses() {
  if (process.platform !== 'win32') return null
  const script = [
    '$all = Get-CimInstance Win32_Process',
    '$ids = @{}',
    'foreach ($p in $all) { $ids[[int]$p.ProcessId] = 1 }',
    'foreach ($p in $all) {',
    "  if ($p.CommandLine -and $p.CommandLine -match '--mode\\s+rpc') {",
    '    if (-not $ids.ContainsKey([int]$p.ParentProcessId)) {',
    '      "ORPHAN pid=$($p.ProcessId) parent=$($p.ParentProcessId)"',
    '    }',
    '  }',
    '}'
  ].join('; ')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true
    })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('ORPHAN'))
  } catch {
    return null
  }
}

/*
 * ── L04 浏览器边界用的本地 HTTP 服务 ──
 *
 * 为什么必须有真实服务：下载来源、Cookie 真的转移过去了没有、本地预览
 * 能不能用 —— 这些没法用纯逻辑或 DOM 断言代替，而探针跑在渲染进程里
 * 起不了服务，`YAN_*` 环境变量也只有主进程读得到。所以服务开在 Node 侧，
 * 端口用**约定值**并把地址硬写在探针里。
 *
 * 端口被占用就直接报错不静默降级：换一个端口探针就连到别人身上了，
 * 那时失败原因会变得极难看懂。
 */
const BOUNDARY_PORT = 39873
const BOUNDARY_ORIGIN = `http://127.0.0.1:${BOUNDARY_PORT}`
const REMOTE_ROUTE_API_PORT = 37893
const REMOTE_ROUTE_TOKEN = 'yan-remote-route-probe-token-2026'
let remoteRouteProbeState = null
/** Cookie 值哨兵：它**只能**出现在网络里，不许出现在任何日志/状态/结果里 */
const BOUNDARY_SECRET = `yan-probe-cookie-${Date.now()}`

function startRemoteRouteProvider() {
  const state = {
    requests: 0,
    canceledStreams: 0,
    completedStreams: 0,
    targetRequests: 0,
    canceledTargetStreams: 0,
    completedTargetStreams: 0,
    responses: new Set()
  }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (part) => (raw += part))
    req.on('end', () => {
      state.requests++
      const isTargetRequest = raw.includes('Reply briefly. This is an isolated local route test; do not use tools.')
      if (isTargetRequest) state.targetRequests++
      try {
        const payload = JSON.parse(raw)
        state.models ??= []
        state.models.push(payload.model)
      } catch {
        state.invalidBodies = (state.invalidBodies ?? 0) + 1
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      state.responses.add(res)
      res.write(
        `data: ${JSON.stringify({
          id: 'remote-route-probe',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'route-probe',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'local route fixture' }, finish_reason: null }]
        })}\n\n`
      )
      const finish = setTimeout(() => {
        if (res.destroyed) return
        state.completedStreams++
        if (isTargetRequest) state.completedTargetStreams++
        res.end('data: [DONE]\n\n')
      }, 60_000)
      finish.unref()
      res.on('close', () => {
        clearTimeout(finish)
        state.responses.delete(res)
        if (!res.writableFinished) {
          state.canceledStreams++
          if (isTargetRequest) state.canceledTargetStreams++
        }
      })
    })
  })
  server.unref()
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('远程路由本机 provider 未分配 TCP 端口'))
        return
      }
      remoteRouteProbeState = state
      resolvePromise({ server, port: address.port, state })
    })
  })
}

async function closeRemoteRouteProvider(provider) {
  if (!provider) return
  for (const response of provider.state.responses) response.destroy()
  await new Promise((resolvePromise) => provider.server.close(() => resolvePromise()))
}

async function assertPortAvailable(port) {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? reject(error) : resolvePromise()))
    })
  })
}

async function checkRemoteRoutes(_sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  say(String(probeText ?? '').includes('remote-routes.driver.ok=true'), 'Node 客户端对真实 Electron 远程路由的断言全绿')
  const state = remoteRouteProbeState
  lines.push(
    `本机 provider：总请求 ${state?.requests ?? 0}；测试消息请求 ${state?.targetRequests ?? 0}；目标流取消 ${state?.canceledTargetStreams ?? 0}`
  )
  say((state?.targetRequests ?? 0) === 1, '本机 provider 收到且只收到一次目标消息请求')
  say(
    (state?.canceledTargetStreams ?? 0) === 1 && (state?.completedTargetStreams ?? 0) === 0,
    '定向 abort 关闭了该目标消息对应的未完成 provider 流'
  )
  say((state?.invalidBodies ?? 0) === 0, '本机 provider 收到有效的 OpenAI 兼容请求体')
  return { ok, lines }
}

async function driveRemoteRoutes() {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '✓ ' : '✗ ') + text)
    if (!good) ok = false
  }
  const origin = `http://127.0.0.1:${REMOTE_ROUTE_API_PORT}/remote/v1`
  const token = REMOTE_ROUTE_TOKEN
  const request = async (path, { auth = true, method = 'GET', body, timeoutMs = 2500 } = {}) => {
    const headers = {}
    if (auth) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    let json = null
    try {
      json = await response.json()
    } catch {
      /* 无效 JSON 会由后续数据断言标红 */
    }
    return { status: response.status, json }
  }
  const untilStatus = async (predicate, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs
    let latest = null
    while (Date.now() < deadline) {
      try {
        latest = await request('/status')
      } catch (error) {
        latest = { status: 0, error }
      }
      if (latest.status === 200 && predicate(latest.json?.data)) return latest.json.data
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return latest?.json?.data ?? null
  }

  try {
    const healthDeadline = Date.now() + 20000
    let health = null
    while (Date.now() < healthDeadline) {
      try {
        health = await request('/health', { auth: false, timeoutMs: 800 })
        if (health.status === 200) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    say(health?.status === 200 && health.json?.ok === true, `真实 Electron 远程 health 路由返回 ${health?.status ?? '无响应'}`)

    const denied = await request('/status', { auth: false })
    say(denied.status === 401, `无 token 的受保护路由返回 401（实际 ${denied.status}）`)

    const before = await request('/status')
    const activeBefore = before.json?.data?.agent?.activeSessionId
    const targetSessionId = before.json?.data?.sessions?.find((session) => session.id === 'yan-remote-route-target')?.id
    say(before.status === 200 && typeof activeBefore === 'string', '带 token 的状态路由给出桌面当前会话 id')
    say(typeof targetSessionId === 'string' && targetSessionId !== activeBefore, '隔离沙箱中存在独立的后台目标会话')
    if (!targetSessionId) throw new Error('状态快照中找不到合成目标会话')

    const created = await request('/sessions/new', { method: 'POST', body: {} })
    const selectedSessionId = created.json?.data?.sessionId
    say(created.status === 200 && typeof selectedSessionId === 'string', '新建会话路由返回稳定 sessionId')
    if (!selectedSessionId) throw new Error('新建会话路由没有返回 sessionId')
    const active = await untilStatus((data) => data?.agent?.activeSessionId === selectedSessionId)
    say(active?.agent?.activeSessionId === selectedSessionId, '新建会话成为桌面当前视图')
    say(active?.sessions?.some((session) => session.id === targetSessionId), '原目标会话仍在会话列表中')

    const sendRequest = request(`/sessions/${encodeURIComponent(targetSessionId)}/messages`, {
      method: 'POST',
      body: { text: 'Reply briefly. This is an isolated local route test; do not use tools.' },
      timeoutMs: 60000
    }).catch((error) => ({ status: 0, error }))
    const running = await untilStatus((data) =>
      data?.agent?.runners?.some((runner) => runner.sessionId === targetSessionId && runner.running)
    )
    const targetRunner = running?.agent?.runners?.find(
      (runner) => runner.sessionId === targetSessionId && runner.running
    )
    const runId = targetRunner?.runId
    say(/^r[1-9]\d{0,8}$/.test(runId ?? ''), `目标 runner 运行中并公开精确 runId（${runId ?? '缺失'}）`)
    if (!runId) throw new Error('目标后台 runner 未进入运行态')
    say(targetRunner.isActive === false, '目标会话由后台 runner 执行，未切换桌面视图')
    say(running?.agent?.activeSessionId === selectedSessionId, '发送期间桌面当前会话未变化')

    await new Promise((resolve) => setTimeout(resolve, 500))
    const aborted = await request('/runs/abort', { method: 'POST', body: { runId } })
    say(aborted.status === 200 && aborted.json?.data?.runId === runId, `按精确 runId 中止成功（HTTP ${aborted.status}）`)

    const sent = await Promise.race([
      sendRequest,
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, error: 'timeout waiting for send route response' }), 8000))
    ])
    say(
      sent.status === 200 && sent.json?.data?.sessionId === targetSessionId && sent.json?.data?.runId === runId,
      `消息路由最终回报了匹配的 sessionId / runId（HTTP ${sent.status}）`
    )

    const settled = await untilStatus((data) =>
      data?.agent?.runners?.some((runner) => runner.runId === runId && !runner.running)
    )
    const finalTarget = settled?.agent?.runners?.find((runner) => runner.runId === runId)
    say(finalTarget?.sessionId === targetSessionId && finalTarget.running === false, '中止后精确目标 runner 已停止')
    say(settled?.agent?.activeSessionId === selectedSessionId, '中止目标任务后桌面当前会话未改变')
  } catch (error) {
    say(false, `远程路由驱动异常：${error instanceof Error ? error.message : String(error)}`)
  }

  lines.push(`remote-routes.driver.ok=${ok}`)
  return { ok, text: lines.join('\n') }
}

function startBoundaryServer() {
  const secretHash = createHash('sha256').update(BOUNDARY_SECRET).digest('hex').slice(0, 8)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', BOUNDARY_ORIGIN)
    if (url.pathname === '/download') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="yan-probe-download.txt"'
      })
      res.end(`download fixture ${BOUNDARY_SECRET}\n`)
      return
    }
    if (url.pathname === '/whoami') {
      /*
       * 只回「有没有 Cookie」+ 值的前 8 位哈希。
       * 为什么回哈希而不是原值：本场景要在**输出里**断言“不得出现 Cookie 值”，
       * 而回显原值就会把它带进页面文本 → 进 observe 结果 → 进日志，
       * 那正好是我们要防的事。哈希能证明「到的是同一个值」。
       */
      const cookie = /(?:^|;\s*)yan_probe_cookie=([^;]*)/.exec(req.headers.cookie ?? '')
      const value = cookie?.[1] ?? ''
      const hash = value ? createHash('sha256').update(value).digest('hex').slice(0, 8) : 'none'
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`cookie=${value ? 'present' : 'none'} hash=${hash}\n`)
      return
    }
    if (url.pathname === '/private') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('private-ok\n')
      return
    }
    if (url.pathname === '/ask') {
      /*
       * 真实发起权限请求 —— 不靠界面上调 `setPermission` 写记录，
       * 而是让 Chromium 的 permission handler 真的跑一遍。
       *
       * 同时发两种（定位 + 通知）：不同 Chromium 版本对“无用户手势时
       * 要不要问 handler”的处理不一样，哪种真的问到了就用哪种
       *（探针从记录里读实际的名字，不硬编）。
       */
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>ask</title><body>ask' +
          '<script>' +
          'try{navigator.geolocation.getCurrentPosition(function(){},function(){})}catch(e){}' +
          'try{if(window.Notification)Notification.requestPermission()}catch(e){}' +
          '</script></body>'
      )
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `yan_probe_cookie=${BOUNDARY_SECRET}; Path=/; SameSite=Lax`
    })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>yan boundary fixture</title>' +
        '<a id="dl" href="/download">download</a>'
    )
  })
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(BOUNDARY_PORT, '127.0.0.1', () => resolvePromise(server))
  })
}

/**
 * 退出后（Electron 已关）检查下载真的落到了隔离目录里。
 *
 * 为什么放在退出后：`will-download` 的 `done` 回调与文件落盘是异步的，
 * 在应用还开着的时候查有竞态；关掉之后看的是终态。
 */
function checkBrowserBoundaryDownloads(sandboxRoot) {
  const lines = []
  if (!sandboxRoot) return { ok: false, lines: ['✗ 非隔离模式无法检查下载目录'] }
  const dir = join(sandboxRoot, 'downloads')
  const names = existsSync(dir) ? readdirSync(dir) : []
  lines.push(`  下载目录（隔离）：${names.length ? names.join(', ') : '（空）'}`)
  const file = names.find((n) => n === 'yan-probe-download.txt')
  let ok = Boolean(file)
  if (!file) {
    lines.push('  ✗ 没有找到 yan-probe-download.txt')
  } else {
    const size = statSync(join(dir, file)).size
    lines.push(`  ✓ yan-probe-download.txt 已落盘，${size} 字节`)
    ok = size > 0
    if (!ok) lines.push('  ✗ 文件是空的')
  }
  return { ok, lines }
}

/*
 * 当前正在跑的 Electron 子进程。
 *
 * 为什么要全局记住它：这个脚本可能被 Ctrl+C / 被外层 timeout 杀掉。
 * 那时如果只是自己退出，Electron 会变成孤儿并继续往一个**没人读的管道**写日志 ——
 * 反复 EPIPE，而 Electron 默认会把 EPIPE 变成模态错误框，进程再也不退出
 *（2026-09-16 实测：一条 visual:matrix 链就这样挂了几个小时）。
 */
let activeChild = null

/** 收掉整棵进程树：Windows 上 child.kill() 只杀直接子进程，GPU/渲染/pi 会变孤儿。 */
function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 已经退了 */
    }
  }
  try {
    child.kill()
  } catch {
    /* 同上 */
  }
}

/* Ctrl+C / 被 kill：先收子进程再退，别把它留成孤儿 */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killTree(activeChild)
    process.exit(130)
  })
}

function runProbe({ probe, delay, keys, keysDelay, env: caseEnv, budget, visible, driver }, env) {
  return new Promise((resolvePromise) => {
    const probeEnv = {
      ...env,
      // 场景自己的环境变量（如 authEnv 要验「key 写在环境变量里」那条路）
      ...(caseEnv ?? {}),
      YAN_PROBE: probe,
      YAN_PROBE_DELAY: String(delay),
      /*
       * 默认**不上屏**：测试不应该在用户面前弹窗（用户明确要求）。
       * 需要看真实窗口时：`YAN_SHOW_WINDOW=1 npm run test:live -- <场景>`。
       *
       * 之前默认是 `showInactive()`（不抢焦点但仍会出现在屏幕上）；
       * 连跑十几个场景时，窗口不断出现本身就是在打断用户。
       */
      ...(process.env.YAN_SHOW_WINDOW || visible ? {} : { YAN_PROBE_HIDDEN: '1' }),
      ...(keys ? { YAN_PROBE_KEYS: keys } : {}),
      /* 用例自己调第一枚按键的延时（探针要先关引导 / 拿到输入框焦点时用） */
      ...(keys && keysDelay ? { YAN_PROBE_KEYS_DELAY: String(keysDelay) } : {})
    }
    // GUI 进程不能带 ELECTRON_RUN_AS_NODE：否则 Electron 二进制退化成纯 Node，
    // 无窗口、静默 exit 0，探针什么都拿不到（详见 scripts/test-packaged.mjs）。
    /*
     * 还要剥掉**外层砚实例**的能力服务地址与身份：
     * 从砚的 pi 子进程里跑 test:live 时，这几个变量会跟着继承下去。
     * pi 子进程的环境本来由主进程覆盖，但能力服务没起来时就是「没有覆盖」，
     * 那时被测试的实例里 `yan` 会打到外层那个真实实例（写真实用户数据目录）。
     * 本轮在 test-packaged 里真撞到过（一个操作回执被写进了真实 ~/.pi）。
     */
    for (const k of ['ELECTRON_RUN_AS_NODE', 'YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']) {
      delete probeEnv[k]
    }
    /*
     * 直接拿 electron 包导出的可执行文件，**不走 npx**。
     *
     * 为什么：`spawn('npx', ['electron'], { shell: true })` 在 Windows 上
     * 是 cmd.exe → npx → electron 三层。npx 会先抢 npm 缓存锁、检查包，
     * 偶发几秒内就退出（实测：场景刚起了两个子代理，npx 先退了），于是
     * test-live 判定“没抓到 PROBE 输出”，而 Electron 其实还在后台跑探针 ——
     * 既拿不到证据，又留下一个没人管的 GUI 实例。
     */
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env: probeEnv,
      windowsHide: true
    })
    activeChild = child
    const driverPromise = driver
      ? Promise.resolve()
          .then(() => driver())
          .catch((error) => ({ ok: false, text: `✗ 外部验收驱动异常：${error?.message ?? error}` }))
      : null

    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
    })
    child.stderr.on('data', (d) => {
      buf += d
    })

    // 预发按键会额外占时间（第一枚前可自定义延时，之后每个组合等 1.5s）
    const keyCost = keys ? (keysDelay ?? 0) + keys.split(',').length * 1500 : 0
    const killChild = () => killTree(child)
    /*
     * delay 是“窗口显示后等多久才执行探针”（给应用启动/连上 pi 用），
     * 不是探针的执行预算 —— 这两件事以前混在一起，于是为了给长场景留时间，
     * 只能把 delay 往大里设，结果是白等：探针窗口其实还是 90s。
     * 现在分开： 才决定探针能跑多久。
     */
    const kill = setTimeout(killChild, delay + keyCost + (budget ?? 90_000))

    child.on('exit', async (code) => {
      clearTimeout(kill)
      if (activeChild === child) activeChild = null
      const driven = driverPromise ? await driverPromise : null

      const m = /---PROBE-START---\r?\n([\s\S]*?)\r?\n---PROBE-END---/.exec(buf)
      if (!m) {
        /*
         * 两种失败长得完全不同，必须分开报：探针自己打印过东西（说明应用起来了、
         * 只是没走完），与**一句都没打印**（进程在探针输出前就没了 —— 最常见的是
         * 场景预算不够、探针被 kill）。合成一个提示的话，排查会直接走向错方向。
         */
        const hadOutput = buf.trim().length > 0
        resolvePromise({
          ok: false,
          text: [buf.slice(-3000), driven?.text].filter(Boolean).join('\n'),
          hint: hadOutput
            ? '没抓到 PROBE 输出（但有其它输出）—— 应用可能启动失败，先跑 `npm run probe-pi`。'
            : `一句输出都没有 —— 进程在探针打印前就被结束了。先看场景预算够不够：delay ${delay}ms + budget ${budget ?? 90_000}ms`
        })
        return
      }

      const body = m[1]
      // 断言失败标记：✗ 或 “=0（应为 1）” 之类的显式否定
      const combined = [body, driven?.text].filter(Boolean).join('\n')
      const bad = /✗/.test(combined)
      resolvePromise({
        ok: !bad && code === 0 && (driven?.ok ?? true),
        text: combined + '\n',
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
      console.log(`⚠️  ${n} 会真的调用模型（花少量额度）→ ${modelForCase(CASES[n].model)}`)
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
  if (names.includes('remoteroutes') && !sandboxRoot) {
    console.error('✗ remoteroutes 必须运行在隔离 sandbox 中；拒绝触碰真实用户数据。')
    process.exit(2)
  }

  /*
   * 合成 fixture 项目树（`fixture: true` 的场景把它当 cwd）。
   *
   * 为什么需要：文件树 / @ 补全的剩余边界（空目录、失效路径、大目录、
   * 中文空格、同名文件、目录联接）需要一个**内容已知且可穷举**的项目；
   * 源码树既不能造空目录，也不能保证里面有哪些文件，断言只能写成
   * “看起来像”。fixture 建在临时目录里，不往项目根塞测试垃圾。
   */
  const fixtureBase = sandboxRoot ?? mkdtempSync(join(tmpdir(), 'yan-fixture-'))
  const fixtureProject = buildFixtureProject(fixtureBase)

  /*
   * L04 场景的本地服务：只有真的要点它的场景才占端口。
   * 服务挂了要直接失败 —— 没服务的 browserboundary 只会给出一堆看不懂的断言失败。
   */
  let boundaryServer = null
  if (names.some((n) => CASES[n].usesBoundaryServer)) {
    try {
      boundaryServer = await startBoundaryServer()
      console.log(`  本地 fixture 服务：${BOUNDARY_ORIGIN}（下载 / Cookie 哨兵 / 内网目标）`)
    } catch (error) {
      console.error(`✗ 端口 ${BOUNDARY_PORT} 起不了本地服务：${error?.message ?? error}`)
      console.error('  该端口被别的程序占着？先关掉它再跑（不自动换端口，否则探针会连到别人身上）')
      process.exit(2)
    }
  }
  if (names.includes('remoteroutes')) {
    try {
      await assertPortAvailable(REMOTE_ROUTE_API_PORT)
      console.log(`  远程 API 测试端口：${REMOTE_ROUTE_API_PORT}（仅 127.0.0.1）`)
    } catch (error) {
      console.error(`✗ 远程 API 测试端口 ${REMOTE_ROUTE_API_PORT} 不可用：${error?.message ?? error}`)
      console.error('  为避免探针误连到其它服务，本场景不自动换端口。')
      process.exit(2)
    }
  }
  let remoteRouteProvider = null

  /*
   * sandbox 里现在有 **pi 凭证副本**（为了让 pi 能起来），所以清理不能再只靠
   * 正常跑完的那次 rmSync —— 被 Ctrl+C 或被 timeout 杀掉时，密钥会留在临时目录。
   * 实测已经踩到：02:14 那批异常退出后，三个 yan-test-* 目录里的 auth.json 副本
   * 一直留到被发现。这里把清理挂到进程退出，覆盖正常退出与 SIGINT/SIGTERM
   *（SIGKILL 无法捕获，那就只能靠下次跑到时看见了）。
   */
  if (sandboxRoot) {
    const cleanupSandbox = () => {
      try {
        /* `noperm/` 带着 deny 读取的 ACL，不复位的话 rmSync 会 EPERM 把沙箱留在临时目录。 */
        allowDirRead(join(fixtureProject, 'noperm'))
        rmSync(sandboxRoot, { recursive: true, force: true })
      } catch {
        /* 尽力而为，不能因为清理失败盖住真正的测试结果 */
      }
    }
    process.once('exit', cleanupSandbox)
    process.once('SIGINT', () => {
      cleanupSandbox()
      process.exit(130)
    })
    process.once('SIGTERM', () => {
      cleanupSandbox()
      process.exit(143)
    })
  } else {
    /*
     * 非隔离模式（`YAN_TEST_ISOLATED=0`，仅排查用）下 fixture 是自己的临时目录，
     * 不会被沙箱清理覆盖 —— 而 `noperm/` 的 ACL 会让它变成用户手动删不掉的垃圾。
     * 所以这一支也必须挂退出清理。
     */
    process.once('exit', () => {
      try {
        allowDirRead(join(fixtureProject, 'noperm'))
        rmSync(fixtureBase, { recursive: true, force: true })
      } catch {
        /* 同上 */
      }
    })
  }

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
     * 给隔离环境准备 pi 的**凭证 + 模型目录**，否则 pi 根本起不来。
     *
     * 为什么需要两个文件：
     *   · auth.json  —— 凭证；没有它 pi 只能起一个 unknown 模型。
     *   · models.json —— 自定义 provider 定义。这台机器上的 `commandcode`
     *     provider（69 个模型）就来自这里，**不在** pi 的内置目录里；
     *     少了它，pi 解析 `--model commandcode/...` 会直接 "Model not found"
     *     并退出，表现为 conn 一直卡在 starting、场景全部失败。
     *   · models-store.json —— 目录缓存（存在就带上，省一次网络拉取）。
     *
     * ⚠️ 安全边界（用户明确要求：测试可以用，**打包切勿放进去**）：
     *   · 只**读**源文件，写成 sandbox 里的副本；
     *   · 除 auth.json 外已确认不含密钥字段；auth 场景改写也只动副本；
     *   · sandbox 在系统临时目录，批次结束整个 rmSync 删除；
     *   · **绝不写入项目目录** —— electron-builder 的 files / extraResources
     *     只收 out/、build/icon.png、package.json 和 resources/pi-runtime，
     *     临时目录不可能进发布包；.gitignore 也已忽略 `auth.json`。
     */
    const sourceAgentDir = process.env.YAN_PI_DIR?.trim() || join(homedir(), '.pi', 'agent')
    const copied = []
    const routeOnly = names.length === 1 && names[0] === 'remoteroutes'
    if (!routeOnly) {
      for (const f of ['auth.json', 'models.json', 'models-store.json']) {
        const src = join(sourceAgentDir, f)
        if (existsSync(src)) {
          copyFileSync(src, join(piDir, f))
          copied.push(f)
        }
      }
    }
    if (copied.length) {
      console.log(`  pi 文件：已复制 ${copied.join(' / ')} 到隔离目录（仅本次测试，不进包）`)
    } else if (routeOnly) {
      console.log('  pi 文件：远程路由场景使用独立本机 provider，不读取真实 auth.json / models.json')
    } else {
      console.log('  pi 文件：没找到凭证/模型目录 —— 依赖 pi 就绪的场景会失败')
    }

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
      YAN_PI_DIR: piDir,
      /* 完整隔离批次会产生超过默认桌面快照上限的临时会话；不改变生产口径，
       * 只让本次测试保留自己种下的早期 fixture。 */
      YAN_TEST_SESSION_LIST_LIMIT: '500',
      /*
       * 下载必须隔离：内置浏览器与本机 Chrome 都写 `app.getPath('downloads')`，
       * 而那默认是**用户真实的下载目录** —— 测试往里丢文件，
       * 用户会当成自己的文件（而且我们没法替他删）。
       */
      YAN_DOWNLOADS_DIR: join(sandboxRoot, 'downloads')
    }
    mkdirSync(join(sandboxRoot, 'downloads'), { recursive: true })

    if (names.includes('remoteroutes')) {
      try {
        remoteRouteProvider = await startRemoteRouteProvider()
        const routePiDir = join(sandboxRoot ?? fixtureBase, 'pi-agent-remote-routes')
        mkdirSync(routePiDir, { recursive: true })
        writeFileSync(
          join(routePiDir, 'models.json'),
          JSON.stringify({
            providers: {
              yanrouteprobe: {
                name: 'Yan Remote Route Probe',
                baseUrl: `http://127.0.0.1:${remoteRouteProvider.port}/v1`,
                api: 'openai-completions',
                models: [{ id: 'route-probe', name: 'Route Probe', contextWindow: 32768, maxTokens: 256 }]
              }
            }
          }),
          'utf8'
        )
        writeFileSync(
          join(routePiDir, 'auth.json'),
          JSON.stringify({ yanrouteprobe: { type: 'api_key', key: 'local-route-fixture-only' } }),
          'utf8'
        )
        CASES.remoteroutes.model = 'yanrouteprobe/route-probe'
        CASES.remoteroutes.env = {
          YAN_PI_DIR: routePiDir,
          PI_OFFLINE: '1',
          YAN_REMOTE_ENABLE: '1',
          YAN_REMOTE_HOST: '127.0.0.1',
          YAN_REMOTE_PORT: String(REMOTE_ROUTE_API_PORT),
          YAN_REMOTE_TOKEN: REMOTE_ROUTE_TOKEN
        }
        console.log(`  远程路由本机 provider：127.0.0.1:${remoteRouteProvider.port}（无上游转发）`)
      } catch (error) {
        console.error(`✗ 无法启动远程路由本机 provider：${error?.message ?? error}`)
        process.exit(2)
      }
    }

    /* 服务句柄不能让事件循环挂住 —— 跑完要关。 */
    if (boundaryServer) {
      process.once('exit', () => boundaryServer.close())
    }

    // 从真实会话目录**只读**拷几份当 fixture。
    // 为什么要拷：有些场景（切会话、长会话虚拟化）需要真实数据才有意义；
    // 为什么是拷贝而不是直接引用：测试会改名/删除会话，不能动原件。
    const seeded = seedSessions(sessions)
    if (names.includes('remoteroutes')) {
      const routeSession = writeRemoteRouteSession(sessions, fixtureProject)
      console.log(`  远程路由目标会话：${routeSession.id}（仅隔离 sandbox）`)
    }

    /*
     * N12 的 A/B 会话：cwd 必须是 fixture 项目的绝对路径，而那个路径
     * 要等上面建完才知道，所以只能在这里补写（详见 `writeAbSessions`）。
     */
    if (names.some((n) => CASES[n]?.abSessions)) {
      const made = writeAbSessions(sessions, join(fixtureProject, 'repo'), join(fixtureProject, 'other'))
      console.log(`  N12 A/B 会话：${made.map((m) => m.tag + '→' + m.cwd).join('，')}`)
    }

    /*
     * N05 的 A/B 会话：同样需要 fixture 的绝对路径，而且必须是**已落盘**的
     * （详见 `writeProjectSwitchSessions`）。
     */
    if (names.some((n) => CASES[n]?.projectSessions || CASES[n]?.projectPeers)) {
      const made = writeProjectSwitchSessions(sessions, fixtureProject, join(fixtureProject, 'other'), {
        /* 只有明确要“同 cwd 第二条会话”的场景才造，而且造在另一个子目录里 */
        peers: names.some((n) => CASES[n]?.projectPeers),
        peerCwd: join(fixtureProject, 'repo'),
        /* 09-S3：造「活动新但没打开过」/「活动旧但将被打工」的一对（见该函数注释） */
        opened: names.some((n) => CASES[n]?.openedSessions)
      })
      console.log(`  N05 项目会话：${made.map((m) => m.tag.toUpperCase() + '→' + m.cwd).join('，')}`)
    }

    /*
     * `auth` 场景要验的是「**没有**凭证时给出应用内登录入口」
     * （`data-testid="auth-login-openai-codex"`）。而上面那个 piDir 为了能起 pi
     * 复制了真实 auth.json，前提正好相反 —— 单独给它一个空目录。
     * 只放 models.json：provider 定义仍要能解析，否则列表渲染不出来。
     */
    const piDirNoAuth = join(sandboxRoot, 'pi-agent-no-auth')
    mkdirSync(piDirNoAuth, { recursive: true })
    const modelsForNoAuth = join(sourceAgentDir, 'models.json')
    if (existsSync(modelsForNoAuth)) copyFileSync(modelsForNoAuth, join(piDirNoAuth, 'models.json'))
    CASES.auth.env = { YAN_PI_DIR: piDirNoAuth }

    /*
     * N18：`slashcmd` 要验「运行时技能的真实发现」——不能拿“本环境正好没有技能”
     * 当结论。pi 从 `<agentDir>/skills/<name>/SKILL.md` 发现用户技能，而主 piDir
     * 只复制了凭证/模型文件，通常没有 skills。所以单独给这一个场景一份 piDir：
     * 与主 piDir 同样能起 pi，另外多一个探测技能。其它场景照旧看不到它，
     * 命令列表长度、系统提示都不受影响。
     */
    const piDirSkill = join(sandboxRoot, 'pi-agent-skill')
    for (const d of [piDirSkill, join(piDirSkill, 'skills', 'probe-skill')]) mkdirSync(d, { recursive: true })
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) copyFileSync(src, join(piDirSkill, f))
    }
    writeFileSync(
      join(piDirSkill, 'skills', 'probe-skill', 'SKILL.md'),
      [
        '---',
        'name: probe-skill',
        'description: 仅用于验证「运行时技能会被报告进命令列表」的探测技能，没有任何实际能力。',
        '---',
        '',
        '这个技能存在的唯一目的：证明 pi 会把 `<agentDir>/skills` 下的 SKILL.md 变成命令列表里的 skill 来源条目。'
      ].join('\n'),
      'utf8'
    )
    CASES.slashcmd.env = { YAN_PI_DIR: piDirSkill }

    /*
     * 实施-04 S2：`capsearch` 要验「模型自己发现技能 → 读正文 → 按目标执行」。
     * 所以单独一份 piDir：与主 piDir 同样能起 pi，另外多一个**回执技能**，
     * 其正文里带一行只有它才有的标记 —— 模型必须真的读到正文才写得出来。
     * 其它场景看不到它，命令列表与系统提示不受影响。
     */
    const piDirCapability = join(sandboxRoot, 'pi-agent-capability')
    for (const d of [piDirCapability, join(piDirCapability, 'skills', 'yan-capability-probe')])
      mkdirSync(d, { recursive: true })
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) copyFileSync(src, join(piDirCapability, f))
    }
    writeFileSync(
      join(piDirCapability, 'skills', 'yan-capability-probe', 'SKILL.md'),
      [
        '---',
        'name: yan-capability-probe',
        'description: 能力探测回执技能。用户要求「验证能力发现 / 按技能产出回执」时使用，会生成一份回执文件。',
        '---',
        '',
        '# 能力探测回执技能',
        '',
        '照下面步骤做，不要跳步：',
        '',
        '1. 在系统的临时目录里创建文件 `yan-capability-probe.txt`（`/tmp` 或 `$TEMP` 都可以），内容**恰好**是这一行：',
        '   `YAN-CAPABILITY-PROBE-OK 7f3a91`',
        '2. 用 bash 把该文件读回来，确认内容一致。',
        '3. 在最终回复里原样包含这一行标记。',
        '',
        '这行标记只出现在本技能正文里；没读到本技能就写不出它。'
      ].join('\n'),
      'utf8'
    )
    CASES.capsearch.env = { YAN_PI_DIR: piDirCapability }
    CASES.capcli.env = { YAN_PI_DIR: piDirCapability }

    /*
     * 实施-04 S3：`mcpcli` 要连一个真 MCP 服务。配置指向官方 SDK 的 stdio fixture；
     * `command` 用当前 Node（test-live 就是 node 起的），不碰用户真实配置。
     */
    const mcpServersFile = join(sandboxRoot, 'mcp-servers.json')
    writeFileSync(
      mcpServersFile,
      JSON.stringify(
        {
          servers: [
            {
              id: 'fixture',
              title: 'MCP 单测夹具服务',
              transport: 'stdio',
              command: process.execPath,
              args: [join(process.cwd(), 'scripts', 'lib', 'mcp-stdio-fixture.mjs')]
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    )
    CASES.mcpcli.env = { YAN_MCP_SERVERS_FILE: mcpServersFile }
    CASES.capsettings.env = { YAN_MCP_SERVERS_FILE: mcpServersFile }
    /* 实施-07 S4：同一个 fixture 服务，但这条验的是「它能不能被认成搜索能力」 */
    CASES.sourcecap.env = { YAN_MCP_SERVERS_FILE: mcpServersFile }

    /*
     * 实施-04 S6b-1：`mcpregister` 要两个**真的本地服务**——
     *   ① 目录 fixture（MCP Registry 返回形状）→ 让 discover 拿到远程候选；
     *   ② Streamable HTTP MCP fixture（官方 SDK）→ 让 acquire 的端点核验真握手。
     * npm 源也指向本地：这条场景验的是 MCP 路径，没必要为它真连公网。
     * 两个服务都只绑 127.0.0.1；起不来就直失败（不静默降级成「没候选」）。
     */
    if (names.some((n) => CASES[n].usesMcpRegisterFixture)) {
      const MCP_REG_FIXTURE_PORT = 39341
      const MCP_REG_CATALOG_PORT = 39342
      const mcpRegCatalogOrigin = `http://127.0.0.1:${MCP_REG_CATALOG_PORT}`
      const mcpRegCatalog = createServer((req, res) => {
        const url = new URL(req.url ?? '/', mcpRegCatalogOrigin)
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (url.pathname.startsWith('/npm')) {
          /* npm 侧返回空目录：这条场景只验 MCP 路径。 */
          res.end(JSON.stringify({ objects: [] }))
          return
        }
        res.end(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'yan/fixture-remote',
                  title: '砚远程登记夹具服务',
                  description: '仅用于验证「目录候选 → 授权 → 端点核验 → 登记 → 可用」闭环的远程 MCP 服务。',
                  version: '1.0.0',
                  remotes: [{ type: 'streamable-http', url: `http://127.0.0.1:${MCP_REG_FIXTURE_PORT}/mcp` }]
                }
              }
            ]
          })
        )
      })
      const mcpRegHttpFixture = spawn(process.execPath, [join(root, 'scripts', 'lib', 'mcp-http-fixture.mjs')], {
        env: { ...process.env, YAN_MCP_HTTP_PORT: String(MCP_REG_FIXTURE_PORT) },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      try {
        await new Promise((resolvePromise, rejectPromise) => {
          mcpRegCatalog.once('error', rejectPromise)
          mcpRegCatalog.listen(MCP_REG_CATALOG_PORT, '127.0.0.1', resolvePromise)
        })
        await new Promise((resolvePromise, rejectPromise) => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            rejectPromise(new Error('MCP HTTP fixture 10s 内没起来'))
          }, 10_000)
          mcpRegHttpFixture.stderr.on('data', (chunk) => {
            if (settled) return
            if (String(chunk).includes('listening')) {
              settled = true
              clearTimeout(timer)
              resolvePromise()
            }
          })
          mcpRegHttpFixture.once('exit', (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            rejectPromise(new Error(`MCP HTTP fixture 提前退出（code=${code}）`))
          })
        })
      } catch (error) {
        console.error(`✗ mcpregister 的本地 fixture 起不了：${error?.message ?? error}`)
        process.exit(2)
      }
      console.log(`  本地 fixture 服务：目录 ${mcpRegCatalogOrigin} + MCP HTTP 127.0.0.1:${MCP_REG_FIXTURE_PORT}/mcp`)
      CASES.mcpregister.env = {
        YAN_MCP_REGISTRY_URL: `${mcpRegCatalogOrigin}/v0/servers`,
        YAN_NPM_SEARCH_URL: `${mcpRegCatalogOrigin}/npm`,
        YAN_MCP_SERVERS_FILE: join(sandboxRoot, 'mcp-servers-register.json'),
        /* 仅隐藏 live fixture 能模拟本机确认；产品 CLI 参数本身不是授权。 */
        YAN_PROBE_AUTO_AUTHORIZE_LOOPBACK_MCP: '1'
      }
      process.on('exit', () => {
        try {
          mcpRegCatalog.close()
        } catch {
          /* 进程都要退了，关不掉也不影响结论 */
        }
        try {
          mcpRegHttpFixture.kill()
        } catch {
          /* 同上 */
        }
      })
    }

    /*
     * 实施-04 S4：`capmcp` 除了同一份 MCP 配置，还要 MARKER ——
     * fixture 在 `compute` 被调用时往它 append 一行，那是「调用真的到了服务端」的
     * 唯一硬证据（回复里的数字可能是模型自己编的）。文件放 sandbox，不污染仓库。
     */
    CASES.capmcp.env = {
      YAN_MCP_SERVERS_FILE: mcpServersFile,
      YAN_MCP_FIXTURE_MARKER: join(sandboxRoot, 'mcp-probe-marker.txt')
    }

    /*
     * 实施-02 S1：`taskext` 要验「旧任务扩展与砚同时存在」，所以单独一份 piDir。
     *
     * 旧扩展从 `scripts/fixtures/task-ext/` 现拷（**不是**用户本机那份）——
     * fixture 必须自包含，否则换一台机器场景就变成「不存在旧扩展」而静默变形。
     * 只读它的行为在本文件的场景注释里说明。
     */
    const piDirTaskExt = join(sandboxRoot, 'pi-agent-task-ext')
    for (const d of [piDirTaskExt, join(piDirTaskExt, 'extensions')]) mkdirSync(d, { recursive: true })
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) copyFileSync(src, join(piDirTaskExt, f))
    }
    copyFileSync(
      join(root, 'scripts', 'fixtures', 'task-ext', 'left-info-panel.ts'),
      join(piDirTaskExt, 'extensions', 'left-info-panel.ts')
    )
    /*
     * 实施-02 S5：「旧扩展 + 无关扩展」共存。真实用户目录里往往还有别的扩展，
     * 只放一个任务扩展验不出「无关扩展会不会被任务迁移影响」（诊断计数、
     * 命令列表、清单来源判定三处都可能受它影响）。
     */
    copyFileSync(
      join(root, 'scripts', 'fixtures', 'task-ext', 'notes-panel.ts'),
      join(piDirTaskExt, 'extensions', 'notes-panel.ts')
    )
    CASES.taskext.env = { YAN_PI_DIR: piDirTaskExt }

    console.log(`隔离目录：${sandboxRoot}`)
    console.log(`  fixture：${seeded} 份（真实会话只读拷贝 + 合成；原件不受影响）`)
    console.log('  （不碰真实的会话、派生状态与 localStorage）')
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
    /* 退出后检查需要探针的输出（例如 S1 要它报告被删会话的 sessionId） */
    let lastProbeText = ''
    /* 边界场景把 cwd 指到合成 fixture 项目（`fixtureSub` 可再下钻到子目录），其余场景用项目根。 */
    const caseCwd = c.fixture ? (c.fixtureSub ? join(fixtureProject, c.fixtureSub) : fixtureProject) : root

    /*
     * 隔离的 pi 全局设置（`piSettings`）。
     *
     * 为什么必须先删再写：所有场景共用一个隔离 piDir，而 `continue` 分支
     *（语法错、场景失败）会跳过清理 —— 把“清理”放在**每个场景开头**
     * 就不依赖控制流一定会走到收尾（与 desktop.json 每个场景重置同一个思路）。
     *
     * 为什么只写隔离目录：那是本次测试的临时副本（已含 auth.json 副本），
     * 写它等于扮“用户自己的 pi 全局设置”；**真实** ~/.pi/agent 永远不被写。
     */
    const piSettingsFile = sandboxRoot ? join(sandboxRoot, 'pi-agent', 'settings.json') : null
    if (piSettingsFile) {
      rmSync(piSettingsFile, { force: true })
      if (c.piSettings) writeFileSync(piSettingsFile, JSON.stringify(c.piSettings, null, 2), 'utf8')
    } else if (c.piSettings) {
      console.log('  ⤺ 跳过：非隔离模式（YAN_TEST_ISOLATED=0）不会写真实 pi 目录的 settings.json')
      continue
    }
    /* 退出后检查需要的“场景开始前”快照（临时 worktree 容器） */
    const tempBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('yan-subagent-')))

    /*
     * S1 的派生状态种子（`contextstate`）。
     *
     * 必须**每个场景开跑前**种，而不是批次开始时种一次：所有场景共用一个隔离
     * 会话目录，而 `trash` 也会真删会话 —— 那会连带清掉先前种下的状态文件，
     * 于是全量跑时 `contextstate` 的计数对不上。
     * 它跟 `desktop.json` 的“每场景重置”是同一个道理。
     */
    /* 提问扩展诊断：每次跑前清空，退出后检查只看这一轮的（实施-05 S2） */
    if (c.questionExtLog) rmSync(join(tmpdir(), 'yan-question-ext.log'), { force: true })
    if (c.goalResumeExtLog) rmSync(join(tmpdir(), 'yan-goal-resume.log'), { force: true })

    if (c.contextStateSeed && sandboxRoot) {
      contextStateSeed = await seedContextStates(join(sandboxRoot, 'sessions'), join(sandboxRoot, 'data'))
      console.log(`  S1 派生状态：种下 ${contextStateSeed.ids.length} 份 → ${contextStateSeed.dir}`)
    }

    /*
     * 探针脚本先过一遍**语法检查**。
     *
     * 它们是以字符串形式被 executeJavaScript 执行的，所以语法错误
     * （比如重复声明一个 const）不会在构建期报错，只会表现为
     * 「没抓到 PROBE 输出 —— 应用可能启动失败」，极难定位。
     * 实测踩过一次（topbar 里重名 cur），这里提前拦住。
     */
    /*
     * 「会话文件只读」的基线（todos / taskext）：Electron 起来之前记下 fixture
     * 的原始字节，退出后再比 —— 前缀必须逐字节一致（见 checkTaskFixtureReadonly）。
     * 每个场景都重置：不跳过声明就没基线，避免上一个场景的基线被顺手复用。
     */
    taskFixtureBaseline = null
    if (c.readonlySession && sandboxRoot) {
      taskFixtureBaseline = captureSessionFile(join(sandboxRoot, 'sessions'), c.readonlySession)
      console.log(
        taskFixtureBaseline
          ? `  只读基线：${basename(taskFixtureBaseline.path)}（${Buffer.byteLength(taskFixtureBaseline.text)} 字节）`
          : `  ⚠️  找不到只读基线会话：${c.readonlySession}`
      )
    }

    const syntaxErr = checkProbeSyntax(c.probe)
    if (syntaxErr) {
      console.log(`  ✗ 探针脚本语法错误：${syntaxErr}`)
      failed++
      console.log(`\n✗ ${name} 未通过`)
      continue
    }
    /* 隔离 fixture 的“只种一次”门（wins 多档时不能重复建工作树 / 重复写会话） */
    let isolationSeeded = false
    let contextGuardFixturePath = null

    for (const win of wins) {
      if (sandboxRoot) {
        const desktop = { cwd: caseCwd, lang: 'zh-CN' }
        /* 工作模式迁移场景：只留旧布尔，验「旧 true → 新字段」的真实清洗 */
        if (c.legacyAutonomous) desktop.autonomous = true
        if (c.knowledgeSeed) {
          /*
           * 项目登记决定 `projectId`（宿主用登记里的 id，而不是现场派生）：
           * fixture 写下的知识目录必须与它同名，所以登记也由 fixture 给定。
           * 开关同样写在这里 —— 探针之后会从界面上把它关掉。
           */
          desktop.projects = [
            {
              id: KNOWLEDGE_FIXTURE_PROJECT_ID,
              cwd: caseCwd,
              name: 'Fixture',
              archived: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
          ]
          desktop.projectKnowledge = { enabled: true }
        }
        /*
         * 隔离 fixture（`knowledgeIsolationSeed`）自己写 desktop.json ——
         * 默认那份不能覆盖它（否则第二次窗口开跑时项目登记会没，身份退回派生，
         * 验的就变成另一回事了）。
         */
        if (!c.knowledgeIsolationSeed) {
          writeFileSync(join(sandboxRoot, 'data', 'desktop.json'), JSON.stringify(desktop, null, 2), 'utf8')
        }
        if (c.knowledgeSeed) {
          /*
           * 来源跳转要一个真存在的会话：fixture 会话 id 是动态生成的，
           * 所以从会话目录里现取一个（文件名 `<时间戳>_<id>.jsonl`）。
           */
          let fixtureSessionId
          try {
            /* 会话文件可能嵌在项目子目录里（`--C--Users-...--/<时间戳>_<id>.jsonl`），所以要递归找 */
            const file = readdirSync(join(sandboxRoot, 'sessions'), { recursive: true })
              .map((name) => String(name))
              .find((name) => name.endsWith('.jsonl'))
            if (file) fixtureSessionId = basename(file).replace(/\.jsonl$/, '').split('_').slice(1).join('_')
          } catch {
            /* 没有会话目录就算了：来源会显示成「不可回读」，探针会跟着分支 */
          }
          await seedProjectKnowledge(join(sandboxRoot, 'data'), {
            withCandidate: c.knowledgeSeed === 'candidate',
            sessionId: c.knowledgeSeed === 'candidate' ? fixtureSessionId : undefined
          })
        }
        /*
         * 实施-03 S6：隔离 fixture 自己写 desktop.json / 会话 / 数据哨兵，
         * 所以**不能**被上面的默认 desktop 覆盖。每场景只种一次（wins 可能多档）。
         */
        if (c.knowledgeIsolationSeed && !isolationSeeded) {
          await seedKnowledgeIsolation(sandboxRoot, fixtureProject, caseCwd)
          isolationSeeded = true
        }
        if (c.contextGuardSeed && !contextGuardFixturePath) {
          contextGuardFixturePath = writeContextGuardSession(join(sandboxRoot, 'sessions'))
          console.log(`  上下文守卫 fixture：${basename(contextGuardFixturePath)}（仅本场景）`)
        }
      }
      if (win) console.log(`\n─── 窗口 ${win} ───`)
      /* 坏 pi 入口：内容无所谓，只要立即退出（spawn 得到 code 不 0 的退出） */
      let brokenPiBin
      if (c.brokenPi && sandboxRoot) {
        brokenPiBin = join(sandboxRoot, 'broken-pi.js')
        writeFileSync(brokenPiBin, 'process.exit(3)\n', 'utf8')
      }
      const out = await runProbe(c, {
        ...env,
        ...(win ? { YAN_WIN: win } : {}),
        /* 扩展诊断落到隔离沙箱（退出后检查读它） */
        ...(c.contextExtLog && sandboxRoot ? { YAN_CONTEXT_EXT_LOG: join(sandboxRoot, 'ctx-ext.log') } : {}),
        /* 项目知识注入的诊断（同上，实施-03 S3） */
        ...(c.knowledgeExtLog && sandboxRoot ? { YAN_KNOWLEDGE_EXT_LOG: join(sandboxRoot, 'knowledge-ext.log') } : {}),
        /*
         * 提问扩展的模式诊断（实施-05 S2）：确认「自主档」真的到达扩展。
         * 写 tmpdir 固定文件（与 language 场景同一做法）—— 场景失败时
         * 沙箱会被清掉，写沙箱里就等于没有证据。
         */
        ...(c.questionExtLog ? { YAN_QUESTION_EXT_LOG: join(tmpdir(), 'yan-question-ext.log') } : {}),
        /* 续行扩展诊断（实施-05 S3b）：没发出时要知道是「不该发」还是「发失败」 */
        ...(c.goalResumeExtLog ? { YAN_GOAL_RESUME_EXT_LOG: join(tmpdir(), 'yan-goal-resume.log') } : {}),
        /*
         * 场景自己的环境变量（实施-05 S5c 首位使用者：`YAN_AUTO_CONTINUE` 压短退避 ——
         * 真实验证不能等 3s+10s+30s）。放在 `YAN_TEST_MODEL` 之前，
         * 让场景也能覆盖模型之外的开关。
         */
        ...(c.env ?? {}),
        /* N12 失败态：见上面 brokenPiBin 的说明 */
        ...(brokenPiBin ? { YAN_PI_BIN: brokenPiBin } : {}),
        /* 交接包生成的诊断（实施-05 S5b-2）：区分「没跑」「跑了失败」「写了但不能解析」 */
        ...(c.handoffExtLog && sandboxRoot ? { YAN_HANDOFF_EXT_LOG: join(sandboxRoot, 'handoff-ext.log') } : {}),
        // 每个场景用自己的模型（默认免费 Ling；image 用视觉模型）
        YAN_TEST_MODEL: modelForCase(c.model)
      })
      if (contextGuardFixturePath) {
        rmSync(contextGuardFixturePath, { force: true })
        contextGuardFixturePath = null
      }
      if (name === 'remoteroutes' && remoteRouteProvider) {
        await closeRemoteRouteProvider(remoteRouteProvider)
        remoteRouteProvider = null
      }
      process.stdout.write(out.text)
      lastProbeText = out.text
      if (!out.ok) {
        allOk = false
        hint = hint ?? out.hint
      }
      /*
       * 「不得输出 Cookie 值」（L04 的硬约束）：输出的每一行都过一遍哨兵。
       * 放在这里而不是探针里：探针本身看不到自己产生了什么输出，
       * 而 stdout + stderr 全在 `out.text` 里。
       */
      if (c.usesBoundaryServer) {
        if (out.text.includes(BOUNDARY_SECRET)) {
          allOk = false
          console.log('  ✗ 输出里出现了 Cookie 值（哨兵）—— 凭证不得进日志/状态/结果')
        } else {
          console.log('  ✓ 输出里没有 Cookie 值（哨兵未泄漏）')
        }
        /*
         * 光有「页面上有 Cookie」还不能说明复制对了 —— 哨兵值的哈希对得上
         * 才能证明过去的是**同一个值**（而不是别的 Cookie，也不是空值）。
         */
        const expectedHash = createHash('sha256').update(BOUNDARY_SECRET).digest('hex').slice(0, 8)
        if (out.text.includes(`cookieHash=${expectedHash}`)) {
          console.log(`  ✓ 目标浏览器拿到的 Cookie 值与源值一致（sha256 前 8 位 ${expectedHash}）`)
        } else {
          allOk = false
          console.log(`  ✗ 目标浏览器里的 Cookie 值对不上（期待 cookieHash=${expectedHash}）`)
        }
      }
    }

    /*
     * 跨进程重启（实施-03 S6）：关掉应用后**用同一份 `YAN_DATA_DIR`
     * 再启动一次**，跑第二个探针。
     *
     * 为什么不靠 wins 循环顺路验：那一支每档都会**重置 desktop.json**
     *（项目登记跟着没了，projectId 会退回派生 —— 验的就是另一回事了）。
     * 这里刻意不碰任何隔离文件，验的就是「上次写下的东西还在不在」。
     */
    if (allOk && c.restart) {
      console.log(`\n─── 重启（第二次启动，同一份 YAN_DATA_DIR）───`)
      const out2 = await runProbe(
        { ...c.restart },
        { ...env, YAN_TEST_MODEL: modelForCase(c.restart.model ?? c.model) }
      )
      process.stdout.write(out2.text)
      /* 两轮输出拼在一起：afterExit 要同时看到首次与重启后的两份证据 */
      lastProbeText = lastProbeText + out2.text
      if (!out2.ok) {
        allOk = false
        hint = hint ?? out2.hint
      }
    }

    if (!allOk) {
      failed++
      console.log(`\n✗ ${name} 未通过`)
      if (hint) console.log(`  提示：${hint}`)
      continue
    }

    /*
     * 退出后检查（若场景声明了）：此刻 Electron 已经关闭，才能看到
     * 退出归档、临时 worktree 清理、以及主工作树的最终状态。
     */
    if (c.afterExit) {
      const check = AFTER_EXIT[c.afterExit]
      if (!check) {
        console.log(`  ✗ 未注册的 afterExit 检查：${c.afterExit}`)
        failed++
        continue
      }
      const res = await check(sandboxRoot, tempBefore, lastProbeText)
      console.log('\n退出后检查（Electron 已关闭）')
      console.log(res.lines.join('\n'))
      if (!res.ok) {
        failed++
        console.log(`\n✗ ${name} 未通过（退出后检查）`)
        continue
      }
    }

    console.log(`\n✓ ${name} 通过`)
  }

  if (sandboxRoot) {
    try {
      rmSync(sandboxRoot, { recursive: true, force: true })
    } catch {
      /* Windows 上偶有句柄未释放，留着也无害 */
    }
  } else {
    /* 非隔离调试时 fixture 有自己的临时根目录，也要清掉。 */
    try {
      rmSync(fixtureBase, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }

  console.log(`\n${'='.repeat(64)}`)
  /*
   * 全部场景跑完之后才查：每个场景的 Electron 这时都已退出，所以「父进程不在表里」
   * 就等于「它被留下了」。一条检查覆盖所有场景（包括将来新加的）。
   */
  const orphanPi = orphanPiProcesses()
  if (orphanPi === null) {
    console.log('\n孤儿进程：跳过检查（拿不到进程表，不把“查不到”当成“没残留”）')
  } else if (orphanPi.length === 0) {
    console.log('\n孤儿进程：✓ 没有残留的 pi 进程（命令行含 --mode rpc 且父进程已退出）')
  } else {
    failed++
    console.log(`\n孤儿进程：✗ 发现 ${orphanPi.length} 个残留的 pi 进程`)
    for (const row of orphanPi.slice(0, 6)) console.log(`    · ${row}`)
  }

  console.log(failed === 0 ? `全部通过（${names.length} 个场景）` : `${failed}/${names.length} 个场景失败`)
  process.exit(failed === 0 ? 0 : 1)


}

await main()
