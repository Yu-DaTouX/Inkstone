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
 * 约束：模型必须能从真实 `~/.pi/agent/` 取到凭证。测试会把它**只读复制**进
 * 隔离的 YAN_PI_DIR（不复制就起不了 pi）；副本只写在系统临时目录、退出时清理，
 * 绝不写回原目录。个别场景需要「没有凭证」的前提，见下面 `piDirNoAuth`。
 * 写成 `provider/id` 形式，交给 pi 的 `--model` 解析。
 */
const TEST_MODEL = process.env.YAN_TEST_MODEL || 'commandcode/inclusionai/ling-3.0-flash-sante:free'

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

/** 每个场景：probe 脚本 + 等待多久（毫秒）+ 可选的预发按键 */
const CASES = {
  // 纯 DOM 体检：溢出 / 令牌 / 图标 / 字体栅格 / 分区渲染
  live: { probe: 'scripts/probe/live.js', delay: 9000, cost: 0 },
  // 推理胶囊：渲染 / 展开 / 折叠 / 无推理不占位（不烧 token，注入数据）
  reasoning: { probe: 'scripts/probe/reasoning.js', delay: 9000, cost: 0 },
  // 模型未知时选择器仍可见（用户报的「看不到模型选择」）
  // 连接就绪后模型/思考档位列表要能补上（端到端）
  capabilityload: { probe: 'scripts/probe/capabilityload.js', delay: 9000, cost: 0 },
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
  // 子代理：真起一个独立 pi 子进程（方案第 8 节；用免费模型）
  subagent: { probe: 'scripts/probe/subagent.js', delay: 12000, cost: 0 },
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
    budget: 200000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    afterExit: 'sessionabArchive'
  },
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
    model: 'commandcode/meituan/LongCat-2.0:free',
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
  // 分组管理（N01）：重命名 + 空白/重名校验 + 解散但保留项目
  grouprename: { probe: 'scripts/probe/grouprename.js', delay: 9000, cost: 0 },
  // 项目默认只展开前五个（N17）：更多/收起 + 搜索 + 当前项目定位
  projectlimit: { probe: 'scripts/probe/projectlimit.js', delay: 9000, cost: 0 },
  // 窄侧栏会话标题可读性（N13）：最小宽度下量标题/缩进/状态槽
  railtitle: { probe: 'scripts/probe/railtitle.js', delay: 9000, cost: 0 },
  // 收起侧栏的 mini 项目文件夹（N14）：图标 / 名称 / 当前标记 / 全部项目浮层
  railmini: { probe: 'scripts/probe/railmini.js', delay: 9000, cost: 0 },
  // 自主模式开关（在输入栏里 / 落盘）
  autonomous: { probe: 'scripts/probe/autonomous.js', delay: 9000, cost: 0 },
  // 上下文分区：压缩后 tokens=null 的诚实显示 + 花费行对齐
  context: { probe: 'scripts/probe/context.js', delay: 9000, cost: 0 },
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
  // 面板宽度拖拽（含夹取范围与键盘）
  resize: { probe: 'scripts/probe/resize.js', delay: 9000, cost: 0 },
  // 文件树边界：空目录 / 失效路径 / 多级 / 大目录分页 / 中文空格 / 同名文件 / 目录联接
  fsedge: { probe: 'scripts/probe/fs-edge.js', delay: 11000, cost: 0, fixture: true, budget: 150000 },
  // @ 补全边界：多级 / 大目录截断 / 同名文件 / 引号 / 句中光标 / 切项目竞态
  atpathedge: { probe: 'scripts/probe/at-path-edge.js', delay: 11000, cost: 0, fixture: true },
  // 项目切换（N05）：视图与文件树跟着 cwd 走 / 草稿按实例隔离 / 附件绝对路径 / 失效与无权限目录的真实反馈
  projectswitch: { probe: 'scripts/probe/project-switch.js', delay: 10000, cost: 0, fixture: true, budget: 180000, projectSessions: true },
  /*
   * shell / 第三方工具的变更归属（L05）。cost 0：走直执行 shell 通道
   *（`window.yan.runBash`），不需要模型生成。必须在**隔离的 fixture 目录**里跑，
   * 因为它会真的建/改/删文件。
   */
  workspacechanges: { probe: 'scripts/probe/workspace-changes.js', delay: 10000, cost: 0, fixture: true, fixtureSub: 'repo', budget: 180000, projectPeers: true },
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
  // 项目—会话归属：真实 IPC 迁移索引，不移动 pi 的 JSONL 文件
  sessionlayout: { probe: 'scripts/probe/sessionlayout.js', delay: 9000, cost: 0 },
  // 窗口关闭隐藏到托盘，退出取消路径可重复
  tray: { probe: 'scripts/probe/tray.js', delay: 9000, cost: 0, env: { YAN_EXIT_CHOICE: 'cancel' } },
  // 运行实例：身份过滤 + 左栏状态槽 + 单独停止（N12，注入合成推送）
  sessionrunners: { probe: 'scripts/probe/sessionrunners.js', delay: 9000, cost: 0 },
  // 运行实例选择：真实主进程注册表路径（N12，不跑回合）
  runnerselect: { probe: 'scripts/probe/runnerselect.js', delay: 12000, cost: 0 },
  // 真发一条消息，验证流式 + 工具卡
  e2e: { probe: 'scripts/probe/e2e.js', delay: 9000, cost: 1 },
  // 问答功能端到端：模型主动提问 → 弹窗 → 回答 → 回填（真调模型）
  ask: { probe: 'scripts/probe/ask.js', delay: 9000, cost: 1 },
  // 图片真的发给模型（花 token —— 需要视觉模型，Ling 是纯文本的）
  image: { probe: 'scripts/probe/image.js', delay: 9000, cost: 1, model: TEST_VISION_MODEL },
  // 排队 + Esc 回收：需要真流式，也花 token
  queue: { probe: 'scripts/probe/queue.js', delay: 9000, cost: 1 },
  // 队列撤回的失败与并发边界（N09）：撤回不存在的 id / 连点两次 / 同时两条 —— 不花 token
  queueretract: { probe: 'scripts/probe/queue-retract.js', delay: 9000, cost: 0 },
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
   * 不期望“长回复”：任务是个 `sleep 90`，而探针在它跑完之前就把它停了。
   * 要证的是**后台会话真的在执行工具**——工具参数落在它自己的会话记录里，
   * 而不是只存在于渲染层的内存里。
   */
  say(JSON.stringify(msgsA).includes('sleep 90'), 'A 的会话记录里有那次工具调用（真执行了）')
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

/** 退出后检查的注册表：CASES 里用 `afterExit: '子代理归档'` 引用 */
const AFTER_EXIT = {
  subagentArchive: checkSubagentArchive,
  sessionabArchive: checkSessionabArchive,
  atrefsendArchive: checkAtRefSend
}

function runProbe({ probe, delay, keys, env: caseEnv, budget }, env) {
  return new Promise((resolvePromise) => {
    const probeEnv = {
      ...env,
      // 场景自己的环境变量（如 authEnv 要验「key 写在环境变量里」那条路）
      ...(caseEnv ?? {}),
      YAN_PROBE: probe,
      YAN_PROBE_DELAY: String(delay),
      ...(keys ? { YAN_PROBE_KEYS: keys } : {})
    }
    // GUI 进程不能带 ELECTRON_RUN_AS_NODE：否则 Electron 二进制退化成纯 Node，
    // 无窗口、静默 exit 0，探针什么都拿不到（详见 scripts/test-packaged.mjs）。
    delete probeEnv.ELECTRON_RUN_AS_NODE
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

    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
    })
    child.stderr.on('data', (d) => {
      buf += d
    })

    // 预发按键会额外占时间（每个组合等 1.4s）
    const keyCost = keys ? keys.split(',').length * 1500 : 0
    const killTree = () => {
      if (process.platform === 'win32' && child.pid) {
        /* Windows 上 child.kill() 只杀直接子进程，Electron 的 GPU/渲染/pi 子进程会变孤儿 */
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          /* 已经退了 */
        }
      }
      child.kill()
    }
    /*
     * delay 是“窗口显示后等多久才执行探针”（给应用启动/连上 pi 用），
     * 不是探针的执行预算 —— 这两件事以前混在一起，于是为了给长场景留时间，
     * 只能把 delay 往大里设，结果是白等：探针窗口其实还是 90s。
     * 现在分开： 才决定探针能跑多久。
     */
    const kill = setTimeout(killTree, delay + keyCost + (budget ?? 90_000))

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
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) {
        copyFileSync(src, join(piDir, f))
        copied.push(f)
      }
    }
    if (copied.length) {
      console.log(`  pi 文件：已复制 ${copied.join(' / ')} 到隔离目录（仅本次测试，不进包）`)
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
      YAN_PI_DIR: piDir
    }

    // 从真实会话目录**只读**拷几份当 fixture。
    // 为什么要拷：有些场景（切会话、长会话虚拟化）需要真实数据才有意义；
    // 为什么是拷贝而不是直接引用：测试会改名/删除会话，不能动原件。
    const seeded = seedSessions(sessions)

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
        peerCwd: join(fixtureProject, 'repo')
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
    /* 边界场景把 cwd 指到合成 fixture 项目（`fixtureSub` 可再下钻到子目录），其余场景用项目根。 */
    const caseCwd = c.fixture ? (c.fixtureSub ? join(fixtureProject, c.fixtureSub) : fixtureProject) : root
    /* 退出后检查需要的“场景开始前”快照（临时 worktree 容器） */
    const tempBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('yan-subagent-')))

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
        writeFileSync(join(sandboxRoot, 'data', 'desktop.json'), JSON.stringify({ cwd: caseCwd, lang: 'zh-CN' }, null, 2), 'utf8')
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
      const res = check(sandboxRoot, tempBefore)
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
  console.log(failed === 0 ? `全部通过（${names.length} 个场景）` : `${failed}/${names.length} 个场景失败`)
  process.exit(failed === 0 ? 0 : 1)


}

await main()
