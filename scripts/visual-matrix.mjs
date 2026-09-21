/**
 * 视觉验收矩阵：窗口尺寸 × 缩放 × 主题。
 *
 * 为什么要单独一个脚本（而不是 `npm run test:live` 加场景）：
 *   · 这里要的是**可归档的截图**（N02/N04/N07/N13/N14/N15/N17/N20 的视觉项），
 *     而 `test:live` 的探针只回文本断言，截图是它拉不到的；
 *   · 组合是「几尺寸 × 几缩放 × 两主题」，逐组合起真正的 Electron 窗口，
 *     每个状态截一张，比把它塞进探针的等待窗口更直接。
 *
 * 数据一律来自 `scripts/shot-fixture.js`（合成数据）：
 * 截图会进仓库，**绝不能**把用户真实会话内容截进去。
 *
 * 尺寸/缩放的对应关系（照 `docs/dev/HANDOFF.md` 的验收口径）：
 *   1440x900 → 正常；940x620 → 窄；900x520 → 矮
 *   缩放用应用自己的 `settings.uiScale`（和 Ctrl+= 走同一条路），
 *   不是 Electron 的 `setZoomFactor` —— 后者只影响网页，验不到布局。
 *
 * ⚠️ 两个来自 `scripts/shots.mjs` 的坑（别改回去）：
 *   ① 不能在顶层 `await app.whenReady()`：Electron 的 ESM 加载器要等整个
 *      模块图求值完才发 ready，而 ready 又要等这个 await，直接死锁。
 *   ② 窗口必须 `show: true`：隐藏窗口只合成一次，之后的切主题/开设置
 *      都不再出帧，`capturePage()` 会一直拿到旧画面。
 */
import { missingHandlerSummary, muteMissingHandlerNoise } from './lib/stdio-guard.mjs'  /* 先装护栏：日志管道断了也不能弹框/挂死（见该文件头注释） */
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.env.YAN_SHOT_DIR
  ? resolve(process.env.YAN_SHOT_DIR)
  : join(root, 'docs/design/preview')
/*
 * 截图的日期戳。
 *
 * 新批次用新名，旧图**原样保留**（AGENTS.md：`docs/design/preview/` 里的截图是用户
 * 视觉证据，不删不覆盖；要更新就另存新名）。`YAN_MATRIX_STAMP` 可以覆盖它
 *（调样式时反复重跑用）。
 *
 * ⚠️ 默认值曾经是写死的 \`2026-09-18\` —— 结果是不带环境变量跑一次整组，
 * 就把那一天的 **28 张旧图全部覆盖了**（它们本来都是“另存新名”的批次），
 * 与上面那条规则直接冲突。现在默认带上**时分**：同一分钟内重复跑才会撞名，
 * 正常使用只会新增文件。要拍一个固定名批次，请显式给 \`YAN_MATRIX_STAMP\`。
 */
function defaultStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
const STAMP = process.env.YAN_MATRIX_STAMP || defaultStamp()

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * 自己去一个临时 userData 目录，并且**每次运行都是新的**。
 *
 * 为什么：用默认 userData 时，上一次运行留下的 GPUCache / 锁会让下一次运行
 * 的 GPU 与 network service 起来就崩（终端里是 `GPU process exited unexpectedly`
 * 和 `Network service crashed`），而脚本表现为“停在第一张图前不动”。
 * 截图不需要持久化任何东西，沙箱目录同时也让截图可重现。
 */
const sandbox = mkdtempSync(join(tmpdir(), 'yan-visual-matrix-'))
app.setPath('userData', join(sandbox, 'userData'))
app.setPath('sessionData', join(sandbox, 'sessionData'))
/* 截图不需要 GPU 加速；关掉后 GPU 进程不会成为失败点 */
app.disableHardwareAcceleration()
const MATRIX_ARTIFACT_SVG_PATH = join(sandbox, 'yan-artifact.svg')

/**
 * 只影响「截图好看程度」的两个 IPC 桩（与 `scripts/shots.mjs` 同源）。
 *
 * 截图不跑主进程：文件区/连接状态拿不到数据会显示「读取目录失败」，
 * 在真实应用里是对的，但截图看起来像 bug。这里只补这两块，
 * 其余（会话/模型/提示词）由 `shot-fixture.js` 写进 store。
 */
/* ── Git 审查的合成数据（只用于截图，与任何真实仓库无关） ── */

/** 一个合法的小 PNG（图片对照的截图里必须真的能解码，否则截到的是破图） */
function matrixPng(size, rgb) {
  const table = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
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
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    const off = y * stride
    for (let x = 0; x < size; x += 1) {
      /* 画一个简单的斜向渐变，截图里能看出是两张**不同**的图 */
      raw[off + 1 + x * 3] = (rgb[0] + x * 6) & 0xff
      raw[off + 2 + x * 3] = (rgb[1] + y * 6) & 0xff
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

const GIT_STUB_IMAGE_OLD = matrixPng(24, [40, 90, 190])
const GIT_STUB_IMAGE_NEW = matrixPng(24, [200, 70, 60])

function gitStubRepo() {
  return {
    root: 'C:/work/pi-desktop',
    name: 'pi-desktop',
    repoId: 'stub-repo',
    worktreeId: 'stub-worktree',
    branch: 'main',
    detached: false,
    unborn: false,
    head: '0aaadf9f00d4a5f5d1f0c9b1b3a1c7e5c8d2f4a6',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    busyBranches: [],
    changedCount: 9,
    stagedCount: 3,
    unstagedCount: 6,
    untrackedCount: 2,
    unpushedCount: 1,
    hasCommit: true
  }
}

function gitStubFiles() {
  const mk = (path, status, additions, deletions, extra = {}) => ({
    path,
    status,
    staged: extra.staged ?? null,
    unstaged: extra.unstaged ?? status,
    untracked: extra.untracked ?? false,
    unmerged: false,
    kind: extra.kind ?? 'text',
    additions,
    deletions,
    oldFingerprint: 'aaa111',
    newFingerprint: 'bbb222',
    ...(extra.oldPath ? { oldPath: extra.oldPath } : {})
  })
  return [
    mk('src/renderer/src/components/review/ReviewPanel.tsx', 'modified', 42, 8, { staged: 'modified' }),
    mk('src/shared/git.ts', 'added', 318, 0, { staged: 'added' }),
    mk('docs/design/DESIGN.md', 'modified', 30, 2),
    mk('src/renderer/src/styles/review.css', 'added', 402, 0),
    mk('src/renderer/src/components/chat/SessionHeader.tsx', 'modified', 5, 18),
    mk('docs/design/preview/matrix-review.png', 'modified', 0, 0, { kind: 'image' }),
    mk('docs/中文 目录/说明.md', 'untracked', 12, 0, { untracked: true }),
    mk('assets/logo.bin', 'untracked', 0, 0, { untracked: true, kind: 'binary' }),
    mk('scripts/test-live.mjs', 'modified', 96, 3, { oldPath: 'scripts/live-tests.mjs' })
  ]
}

function gitStubSnapshot() {
  const files = gitStubFiles()
  return {
    ok: true,
    repo: gitStubRepo(),
    scope: { kind: 'working' },
    files,
    stats: {
      files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      binary: 2,
      truncated: false
    },
    notes: ['有些文件同时有已暂存与未暂存的部分，行数统计按最终内容算，不重复相加'],
    truncated: false,
    requestId: 'stub',
    generatedAt: Date.now(),
    /* 写操作的预期版本（少了它，界面上的暂存 / 提交按钮会一直是 disabled） */
    expected: { head: 'a'.repeat(40), indexDigest: 'stub-idx', statusDigest: 'stub-status' }
  }
}

/**
 * 非 Git 目录的合成状态（实施-07 S1 的取证）。
 *
 * 真实链路里 `yan:git:state` 对非仓库目录返回 `repo: null` —— 那是**正常结果**，
 * 不是错误（见 src/main/git-diff.ts 的注释）。截图要证的正是界面据此走
 * 「未使用 Git」分支：环境菜单不给写操作入口、审查面板说清没有改动可审查。
 */
const NON_GIT_STUB_CWD = 'C:/work/notes-notgit'
/**
 * 主进程侧的切换开关（不是“按 cwd 判断”）。
 *
 * 起初写的是“cwd 落在合成目录就返回 repo: null”，但那样必须同时改
 * `session.cwd` —— 实测会让渲染端卡住（cwd 一变，一批依赖它的组件开始
 * 重新拉数据，矩阵的 `executeJavaScript` 再不返回）。截图需要的只是
 *「数据源变成非 Git」，不需要真的换目录，所以改成主循环按状态切换开关。
 */
let stubNonGit = false
/** 需要“非 Git 数据源”的两个状态；主循环据此切换 `stubNonGit` */
const NON_GIT_STATES = new Set(['envnotgit', 'reviewnotgit'])
function gitStubNonGitState() {
  return { repo: null, expected: undefined }
}
function gitStubNonGitSnapshot() {
  return {
    ok: true,
    repo: null,
    scope: { kind: 'working' },
    files: [],
    stats: { files: 0, additions: 0, deletions: 0, binary: 0, truncated: false },
    notes: [],
    truncated: false,
    requestId: 'stub-notgit',
    generatedAt: Date.now()
  }
}

/** 合成一段真实的 hunk（行号连贯，截图里能看出旧/新两列行号推进） */
function gitStubHunks(seed, lines = 8) {
  const ctx = (i, oldNo, newNo) => ({ type: 'ctx', text: `  // 上下文第 ${i} 行`, oldLine: oldNo, newLine: newNo })
  const first = { header: `@@ -10,${lines} +10,${lines + 1} @@`, section: 'export function ReviewPanel() {', oldStart: 10, oldCount: lines, newStart: 10, newCount: lines + 1, lines: [] }
  let oldNo = 10
  let newNo = 10
  first.lines.push(ctx(1, oldNo++, newNo++))
  first.lines.push({ type: 'del', text: `  const files = snapshot.files ?? []`, oldLine: oldNo++, newLine: null })
  first.lines.push({ type: 'add', text: `  const files = snapshot?.files ?? []`, oldLine: null, newLine: newNo++ })
  first.lines.push({ type: 'add', text: `  const [filter, setFilter] = useState<Filter>('all')`, oldLine: null, newLine: newNo++ })
  for (let i = 2; i < lines; i += 1) first.lines.push(ctx(i, oldNo++, newNo++))
  const second = { header: '@@ -78,6 +82,7 @@ function FileCard(', section: '', oldStart: 78, oldCount: 6, newStart: 82, newCount: 7, lines: [] }
  let o2 = 78
  let n2 = 82
  for (let i = 0; i < 3; i += 1) second.lines.push(ctx(i + 20, o2++, n2++))
  second.lines.push({ type: 'del', text: `      <span className="rcard-stat">`, oldLine: o2++, newLine: null })
  second.lines.push({ type: 'add', text: `      <span className="rcard-stat" data-testid="review-stat">`, oldLine: null, newLine: n2++ })
  for (let i = 0; i < 2; i += 1) second.lines.push(ctx(i + 30, o2++, n2++))
  void seed
  return [first, second]
}

function gitStubPatch(path) {
  const file = gitStubFiles().find((f) => f.path === path)
  const base = {
    ok: true,
    path,
    kind: file?.kind ?? 'text',
    status: file?.status ?? 'modified',
    binary: false,
    truncated: false,
    hunks: [],
    header: [],
    additions: file?.additions ?? 0,
    deletions: file?.deletions ?? 0,
    synthesized: !!file?.untracked,
    requestId: 'stub'
  }
  if (file?.kind === 'binary' || file?.kind === 'image') {
    return { ...base, binary: true, kind: file.kind }
  }
  const hunks = gitStubHunks(path)
  return { ...base, hunks, header: ['index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`] }
}

function gitStubContent(path, side) {
  const file = gitStubFiles().find((f) => f.path === path)
  if (file?.kind === 'image') {
    const buf = side === 'old' ? GIT_STUB_IMAGE_OLD : GIT_STUB_IMAGE_NEW
    return {
      ok: true,
      path,
      side,
      kind: 'image',
      missing: false,
      base64: buf.toString('base64'),
      mimeType: 'image/png',
      bytes: buf.length,
      truncated: false,
      requestId: 'stub'
    }
  }
  if (file?.kind === 'binary') {
    return { ok: true, path, side, kind: 'binary', missing: false, bytes: 20480, truncated: false, requestId: 'stub' }
  }
  return {
    ok: true,
    path,
    side,
    kind: 'text',
    missing: false,
    text: `// ${side === 'old' ? '改动前' : '改动后'}的 ${path}\n`,
    bytes: 120,
    truncated: false,
    requestId: 'stub'
  }
}

function registerStubHandlers() {
  ipcMain.handle('yan:agentStatus', () => ({ state: 'ready', detail: '' }))
  /*
   * 额度区：没有它界面上会写“查询失败（Error invoking remote method 'yan:pro…'）”，
   * 截进验收图会被当成真 bug。数据与 shots.mjs 一致。
   *
   * `commandcode` 这个 provider 在视觉矩阵里**只有** `quotatone` 状态会用（fixture 会话
   * 是 openai-codex），所以这里可以按 provider 名分支返回三档数据，而不是另造一个名字
   * —— 图上显示的就是真实供应商名。真实额度永远落不到 70 / 95 这两个分界上，
   * 所以这组截图得自己造数据；但走的仍是真实渲染路径（状态脚本改 store 里的
   * provider → 额度区自己来查）。
   */
  ipcMain.handle('yan:providerQuota', (_e, provider) => {
    if (provider === 'commandcode') {
      return {
        provider: 'commandcode',
        supported: true,
        currency: 'USD',
        label: '本月已用',
        used: 10,
        total: 10,
        remaining: 0,
        checkedAt: Date.now(),
        windows: [
          { id: 'fiveHour', label: '5 小时', used: 6.9, total: 10 },
          { id: 'weekly', label: '每周', used: 7.5, total: 10 },
          { id: 'monthly', label: '本月', used: 10, total: 10, exceeded: true, estimated: true }
        ]
      }
    }
    return {
      provider: provider || 'openai-codex',
      supported: true,
      remaining: 8.42,
      currency: 'USD',
      label: '余额',
      windows: [
        { id: '5h', label: '5 小时', used: 1.58, total: 10 },
        { id: 'week', label: '本周', used: 6.2, total: 30 }
      ],
      checkedAt: Date.now()
    }
  })
  /* 其余启动期拉取：给空值，让界面停在“没有更多数据”而不是报 IPC 错 */
  ipcMain.handle('yan:listSessions', () => [])
  ipcMain.handle('yan:listCommands', () => [])
  ipcMain.handle('yan:listThinkingLevels', () => [])
  ipcMain.handle('yan:compactionInfo', () => ({
    /*
     * 与真实场景一致的一组值：全局设置了 reserveTokens，项目里的
     * `.pi/settings.json` 因为未信任而**不会被 pi 读** —— 这就是
     * `compaction` 截图里要看到的那句警告（D21）。
     */
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    contextWindow: 400000,
    threshold: 383616,
    custom: false,
    scope: 'global',
    projectIgnored: true
  }))
  /*
   * 回收站通知（N08/N13/N14/N15/N17 的视觉缺口）：截图要拍到「已删除 · 撤销」那条
   * 非模态通知，所以删除必须成功 —— 给一个桩，撤销也给一个（截图不点它，
   * 但按钮的存在依赖 token 非空）。
   */
  /*
   * 文件引用登记（N19 截图要真的走一遍「加入上下文」）：真实主进程会 realpath 校验
   * 并登记路径；截图环境里没有那些文件，所以按请求原样回一个成功的描述 ——
   * 形状与 `grantFiles()` 完全一致（ok / input / path / name / size / mimeType / kind）。
   */
  ipcMain.handle('yan:describeFiles', (_e, paths) =>
    (Array.isArray(paths) ? paths : []).map((p) => {
      const input = String(p)
      const name = input.split(/[\\/]/).pop() ?? input
      return {
        ok: true,
        input,
        path: input,
        name,
        size: 91230,
        mimeType: name.endsWith('.md') ? 'text/markdown' : 'text/typescript',
        kind: 'text'
      }
    })
  )
  ipcMain.handle('yan:deleteSession', () => ({ ok: true, undoToken: 'shot-token' }))
  ipcMain.handle('yan:restoreSession', () => ({ ok: true }))
  ipcMain.handle('yan:authProviders', () => [])
  /*
   * ⚠️ 拉取型 IPC **故意不注册**（getSettings / getState / getStats / listModels …）。
   *
   * 曾经给它们返回空值想“让日志干净一点”，结果是 bootstrap 把空值写回 store，
   * 盖掉 `shot-fixture.js` 刚注入的数据（`settings` 变成 null 时 React 直接
   * 卸载整棵树），表现为后面几张图“缺 .settings / 缺 rail-toggle”。
   * 让它们报 IPC 错反而是对的：store 保留注入值，日志噪音在跑脚本时过滤即可。
   */
  ipcMain.handle('yan:getZoom', () => ({ factor: 1, uiScale: 1 }))
  ipcMain.handle('yan:runnerStatuses', () => [])
  ipcMain.handle('yan:listDir', (_e, rel) => {
    const path = rel || ''
    /*
     * 无权限目录（L02）：截图里要看到「没有读取权限」这一行，
     * 而不是一个空目录 —— 这两种状态在界面上必须是可区分的。
     */
    if (path === 'noperm') {
      return {
        path,
        abs: 'C:/work/pi-desktop/noperm',
        entries: [],
        skipped: [],
        truncated: false,
        status: 'permission',
        error: 'permission'
      }
    }
    /*
     * 目录内容按路径区分：以前每一层都返回同一批名字（src 下面还是 src），
     * 拍"深层文件"的截图时看起来像树坏了。这里给两层真实感的内容。
     */
    const tree = {
      src: [
        { name: 'main', dir: true },
        { name: 'renderer', dir: true },
        { name: 'shared', dir: true },
        { name: 'agent.ts', dir: false, size: 18240 },
        { name: 'index.ts', dir: false, size: 2210 }
      ],
      'src/main': [
        { name: 'agent.ts', dir: false, size: 91230 },
        { name: 'title.ts', dir: false, size: 11040 },
        { name: 'files.ts', dir: false, size: 8120 }
      ]
    }
    return {
      path,
      abs: 'C:/work/pi-desktop' + (path ? '/' + path : ''),
      entries: tree[path] ?? [
        { name: 'src', dir: true },
        { name: 'docs', dir: true },
        { name: 'scripts', dir: true },
        { name: 'noperm', dir: true },
        /*
         * 超长名（窄右栏的省略 + `title` 全文）：长度要明显超过 `PANEL_MIN=220`
         * 下名字的可用宽度，否则截图里看不出省略行为。
         */
        {
          name: '一个非常长的文件名用来验证窄栏下的省略显示-0123456789-abcdefghij-中文结尾.md',
          dir: false,
          size: 4096
        },
        { name: 'README.md', dir: false, size: 23073 },
        { name: 'package.json', dir: false, size: 2966 }
      ],
      skipped: ['node_modules', '.git'],
      truncated: false,
      rootName: 'pi-desktop'
    }
  })

  /*
   * Git 审查的桩（方案 G1 的视觉验收）。
   *
   * 为什么必须给桩：视觉矩阵**故意不连真实主进程**，而审查面板的每一块
   * 内容都来自 `yan:git:*`。没有桩就只会截到「正在读取…」，
   * 那就不是在验收布局与配色。数据是合成的，**绝不进用户真实仓库**。
   */
  /* `stubNonGit` 由主循环按状态切换：截图需要的是“数据源变成非 Git”
     （cwd 不变 —— 见模块顶部 NON_GIT_STUB_CWD 的注释） */
  ipcMain.handle('yan:git:state', () =>
    stubNonGit
      ? gitStubNonGitState()
      : {
          repo: gitStubRepo(),
          expected: { head: 'a'.repeat(40), indexDigest: 'stub-idx', statusDigest: 'stub-status' }
        }
  )
  /* 写操作：矩阵只看界面，返回一个「成功且状态更新」的结果即可 */
  ipcMain.handle('yan:git:action', (_e, req) => ({
    ok: true,
    summary: (req && req.kind === 'commit' ? '已提交' : '已暂存') || '完成',
    headBefore: 'a'.repeat(40),
    headAfter: 'b'.repeat(40),
    committed: req && req.kind === 'commit',
    commit: 'b0b0b0b',
    state: gitStubRepo()
  }))
  ipcMain.handle('yan:git:remotes', () => ['origin'])
  /*
   * 会话来源（§8 的 S1）。视觉矩阵不跑 registerIpc，所有通道都要有桩 ——
   * 这里给一张"已经关联过东西"的样子：一张图（缩略图用一个 1×1 的 PNG）、
   * 一个文件、两条网页。
   */
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  /*
   * 来源搜索入口（实施-07 S4）：界面的可见性就是这条 IPC 回什么 ——
   * 桩返回一条“已发现的搜索能力”，张图才能看到那枚入口（真链路证据在 live 的 sourcecap）。
   */
  ipcMain.handle('yan:sources:webSearch', () => ({
    available: true,
    capabilityId: 'mcp:fixture/web_search',
    title: 'fixture · web_search',
    location: 'yan mcp describe --server fixture --tool web_search',
    owner: 'mcp'
  }))
  ipcMain.handle('yan:sources:list', () => ({
    ok: true,
    dir: 'C:/Users/me/AppData/Roaming/yan/sources/sess-1',
    images: [
      {
        sourceId: 'image:aaaa1111bbbb2222cccc3333dddd4444',
        sessionId: 'sess-1',
        kind: 'image',
        title: 'aaaa1111.png',
        ref: 'C:/Users/me/AppData/Roaming/yan/sources/sess-1/aaaa1111bbbb2222cccc3333dddd4444.png',
        fingerprint: 'aaaa1111bbbb2222cccc3333dddd4444',
        origin: 'screenshot.png',
        addedAt: Date.now() - 60_000,
        available: true,
        size: 20_480
      }
    ],
    /*
     * 来源 ↔ 消息的关联（实施-07 S3）：有它菜单里才会出现「定位消息」入口。
     * 视觉矩阵里只要求按钮画得出来，跳转本身由 `sourcelink` 探针断言。
     */
    links: [
      {
        sourceId: 'image:aaaa1111bbbb2222cccc3333dddd4444',
        messageId: 'u1',
        at: Date.now() - 45_000
      }
    ]
  }))
  ipcMain.handle('yan:sources:verifyFiles', () => [
    {
      sourceId: 'file:ffff9999eeee8888dddd7777',
      sessionId: 'sess-1',
      kind: 'file',
      title: 'HANDOFF.md',
      ref: 'C:/work/pi-desktop/docs/dev/HANDOFF.md',
      fingerprint: '20480:1710000000000',
      origin: 'C:/work/pi-desktop/docs/dev/HANDOFF.md',
      addedAt: Date.now() - 120_000,
      available: true
    },
    {
      sourceId: 'file:0000111122223333',
      sessionId: 'sess-1',
      kind: 'file',
      title: 'gone.md',
      ref: 'C:/work/pi-desktop/gone.md',
      fingerprint: '',
      origin: 'C:/work/pi-desktop/gone.md',
      addedAt: Date.now() - 180_000,
      available: false,
      error: '文件不在了（被删除或改名）'
    }
  ])
  ipcMain.handle('yan:sources:readImage', () => ({ ok: true, base64: png1x1, mime: 'image/png' }))
  ipcMain.handle('yan:sources:addImage', () => null)
  ipcMain.handle('yan:sources:removeImage', () => ({ ok: true }))
  /*
   * pi 包管理（§9 的 P2）。视觉矩阵**不跑 registerIpc**，所有通道都靠桩 ——
   * 少一个就会在界面上渲染成 "No handler registered for ..."（第一次跑就是
   * 这么发现漏了桩的）。这里给两条：一条装的、一条「登记着但磁盘上没有」
   *（后者是要在界面上看得出来的异常状态）。
   */
  ipcMain.handle('yan:packages:list', () => ({
    ok: true,
    agentDir: 'C:/Users/me/.pi/agent',
    userSettings: 'C:/Users/me/.pi/agent/settings.json',
    projectSettings: 'C:/work/pi-desktop/.pi/settings.json',
    entries: [
      {
        source: 'npm:pi-zh-cn',
        scope: 'user',
        name: 'pi-zh-cn',
        version: '0.2.6',
        description: 'pi 编码代理的简体中文界面汉化插件',
        repository: 'git+https://github.com/GoetheDady/pi-zh-cn.git',
        license: 'MIT',
        installed: true,
        path: 'C:/Users/me/.pi/agent/npm/node_modules/pi-zh-cn'
      },
      {
        source: 'npm:pi-reverse-basics',
        scope: 'project',
        name: 'pi-reverse-basics',
        version: '1.4.0',
        description: '逆向工程基础技能包（反调试 / 反混淆 / 签名分析）',
        repository: 'git+https://github.com/example/pi-reverse-basics.git',
        license: 'MIT',
        installed: true,
        path: 'C:/Users/me/.pi/agent/npm/node_modules/pi-reverse-basics'
      },
      {
        source: 'npm:pi-old-thing',
        scope: 'user',
        name: 'pi-old-thing',
        version: null,
        description: null,
        repository: null,
        license: null,
        installed: false,
        path: null
      }
    ]
  }))
  ipcMain.handle('yan:packages:action', () => ({ ok: true, output: 'Installed npm:pi-zh-cn' }))
  /*
   * 受信内置能力（实施-02 S4）：设置页「插件」里的内置能力区。
   * 桩数据与主进程 `builtinCapabilities()` 同形：第一条是宿主任务计划
   *（没有 file），其余按**实际加载的扩展文件名**派生 id。
   * 漏了这个桩，那张截图里就会缺掉整块（渲染端拉不到就为空）。
   */
  ipcMain.handle('yan:capabilities:builtin', () => [
    { id: 'task-plan' },
    { id: 'browser', file: 'browser.js' },
    { id: 'question', file: 'question.js' },
    { id: 'response-detail', file: 'response-detail.js' },
    { id: 'language', file: 'language.js' },
    { id: 'capability-guide', file: 'capability-guide.js' },
    { id: 'context', file: 'context.js' },
    { id: 'project-knowledge', file: 'project-knowledge.js' }
  ])
  ipcMain.handle('yan:capabilities:settings', () => ({
    configWarning: false,
    skills: [
      { id: 'skill:release-check', title: '发布验收', description: '检查构建、解包与发布证据。' },
      { id: 'skill:project-knowledge', title: '项目知识', description: '读取当前项目的已确认知识。' }
    ],
    servers: [{
      id: 'fixture',
      title: '本地 MCP Fixture',
      transport: 'stdio',
      enabled: true,
      effect: 'unknown',
      projectScoped: true,
      endpointOrigin: null,
      status: 'disconnected',
      toolCount: null
    }]
  }))
  ipcMain.handle('yan:capabilities:discover', () => ({
    sources: [
      { sourceId: 'npm-registry', ok: true, pages: 1, candidateCount: 1 },
      { sourceId: 'mcp-registry', ok: true, pages: 1, candidateCount: 1 }
    ],
    candidates: [{
      candidateId: 'fixture:capability@1.0.0',
      title: '本地能力示例',
      summary: '用于视觉矩阵的安全目录候选。',
      kind: 'skill',
      installKind: 'pi-package',
      version: '1.0.0',
      verification: 'metadata-only'
    }]
  }))
  ipcMain.handle('yan:capabilities:verify', () => ({ ok: false, error: '视觉矩阵不执行连接' }))
  ipcMain.handle('yan:capabilities:verification', () => null)
  ipcMain.handle('yan:capabilities:cancelVerification', () => ({ ok: false, error: '视觉矩阵不执行连接' }))
  /*
   * 项目知识页（实施-03 S5）的桩数据。
   *
   * 三条各自代表一个视觉分支：已确认但**需复核**（分支漂移 + 来源被删）、
   * 待确认（候选，多了「确认」按钮）、已被替代（无操作按钮）。
   * `confidenceLabel` 只给一个中性说法（§6：不显示可信度百分比）。
   */
  ipcMain.handle('yan:knowledge:list', () => ({
    ok: true,
    projectId: 'proj-fixture',
    enabled: true,
    counts: { all: 3, active: 1, candidate: 1, review: 1 },
    entries: [
      {
        id: 'k-demo0001',
        revision: 4,
        kind: 'decision',
        status: 'active',
        text: '发布走 npm run dist，便携包用 dist:portable-fast；两者都先跑 test:packaged。',
        tags: ['release', 'packaging'],
        confidenceClass: 'user-confirmed',
        confidenceLabel: '用户确认',
        createdAt: '2026-09-18T02:11:00.000Z',
        updatedAt: '2026-09-19T09:24:00.000Z',
        evidence: [
          { file: 'docs/dev/RELEASING.md', excerpt: '先跑 test:packaged', readable: true },
          { sessionId: 'r-9f3ac210', readable: false }
        ],
        validFor: { branch: 'main', paths: ['docs/dev/RELEASING.md'] },
        review: { needed: true, reasons: ['branch', 'source'] }
      },
      {
        id: 'k-demo0002',
        revision: 1,
        kind: 'fact',
        status: 'candidate',
        text: '砚的构建产物在 out/ 目录（构建后再跑 test:unit，否则验的是旧产物）。',
        tags: [],
        confidenceClass: 'inferred',
        confidenceLabel: '模型推断',
        createdAt: '2026-09-19T04:02:00.000Z',
        updatedAt: '2026-09-19T04:02:00.000Z',
        evidence: [{ sessionId: 'r-1c07be55', readable: true }],
        review: { needed: false, reasons: [] }
      },
      {
        id: 'k-demo0003',
        revision: 2,
        kind: 'constraint',
        status: 'superseded',
        text: '（旧）发布前手动改版本号。',
        tags: ['release'],
        confidenceClass: 'verified',
        confidenceLabel: '已验证',
        createdAt: '2026-09-17T08:00:00.000Z',
        updatedAt: '2026-09-18T02:10:00.000Z',
        evidence: [{ file: 'package.json', readable: true }],
        review: { needed: false, reasons: [] }
      }
    ]
  }))
  /* 导出只回一段文本，保存走真对话框 —— 视觉矩阵里只截「复制」那条路 */
  ipcMain.handle('yan:knowledge:export', () => ({ ok: true, markdown: '# 项目知识 · proj-fixture\n' }))
  /* 来源跳转在矩阵里不发实际切换（点了也只影响一次截图） */
  ipcMain.handle('yan:knowledge:sourceSession', () => ({ ok: false, error: '来源会话已被删除，无法回读' }))
  /* remote 的托管网页地址（G3）：给一个 GitHub 地址，图上才能看到「在网上比较」 */
  ipcMain.handle('yan:git:remoteWeb', () => ({ ok: true, web: 'https://github.com/o/pi-desktop', remote: 'origin' }))
  /* PR 状态（§7）：给一个"已合并 + 检查通过 + 本地有未推送提交"的样子 */
  ipcMain.handle('yan:git:prStatus', () => ({
    ok: true,
    state: 'merged',
    checks: 'success',
    title: '把手改可拖拽 + 落盘',
    number: 42,
    url: 'https://github.com/o/pi-desktop/pull/42',
    base: 'main',
    localAhead: true,
    host: 'github.com',
    owner: 'o',
    repo: 'pi-desktop'
  }))
  /* 工作树（W1）：两条，一条主、一条「砚创建」 */
  ipcMain.handle('yan:git:worktrees', () => ({
    ok: true,
    repoRoot: 'C:/work/pi-desktop',
    worktrees: [
      {
        path: 'C:/work/pi-desktop',
        head: 'a'.repeat(40),
        branch: 'main',
        bare: false,
        main: true,
        locked: false,
        prunable: false,
        ours: false
      },
      {
        path: 'C:/work/pi-desktop-worktrees/git-review',
        head: 'b'.repeat(40),
        branch: 'feat/git-review',
        bare: false,
        main: false,
        locked: false,
        prunable: false,
        ours: true
      }
    ]
  }))
  /*
   * 「会话 ↔ 工作树」的来源关系（实施-07 S2）。视觉矩阵不跑 registerIpc，
   * 所以这里给一条真的（sessionId 与 `envworktrees` 状态脚本里那个会话 id 对齐）。
   */
  ipcMain.handle('yan:git:worktreeLinks', () => [
    {
      sessionId: 'sess-1',
      sessionFile: 'C:/Users/me/.pi/agent/sessions/sess-1.jsonl',
      worktree: 'C:/work/pi-desktop-worktrees/git-review',
      branch: 'feat/git-review',
      fromSessionId: 'sess-src',
      fromSessionFile: 'C:/Users/me/.pi/agent/sessions/sess-src.jsonl',
      fromCwd: 'C:/work/pi-desktop',
      at: Date.now() - 90_000
    }
  ])
  ipcMain.handle('yan:git:worktreeCreate', () => ({ ok: true, path: 'C:/work/x', branch: 'x', notes: [] }))
  ipcMain.handle('yan:git:worktreeRemove', () => ({ ok: true, summary: '已移除工作树' }))
  /*
   * 工作树 Fork 的文件引用重绑定（实施-07 S2b-3）。
   * 桩成「3 条引用、2 个能对上、1 个没有」—— 截图要展示的就是那行小字
   * （有引用才出现；空数组时它必须消失，这是同一口径的“有则出现、无则隐藏”）。
   */
  ipcMain.handle('yan:fork:fileRefs', () => ({
    worktree: 'C:/work/pi-desktop-worktrees/git-review',
    root: 'C:/work/pi-desktop-worktrees/git-review',
    sourceRoot: 'C:/work/pi-desktop',
    sourceFile: 'C:/Users/me/.pi/agent/sessions/sess-src.jsonl',
    refs: [
      { ref: 'src/renderer/src/components/review/EnvironmentMenu.tsx', state: 'resolved', abs: 'C:/work/pi-desktop-worktrees/git-review/src/renderer/src/components/review/EnvironmentMenu.tsx', kind: 'file' },
      { ref: 'docs/plan/实施-07-Git与环境菜单收尾-已完成.md', state: 'resolved', abs: 'C:/work/pi-desktop-worktrees/git-review/docs/plan/实施-07-Git与环境菜单收尾-已完成.md', kind: 'file' },
      { ref: 'src/main/worktree-links.ts', state: 'missing', abs: 'C:/work/pi-desktop-worktrees/git-review/src/main/worktree-links.ts', kind: null }
    ],
    summary: {
      total: 3,
      resolved: 2,
      missing: 1,
      mismatch: 0,
      outside: 0,
      problems: [
        { ref: 'src/main/worktree-links.ts', state: 'missing', abs: 'C:/work/pi-desktop-worktrees/git-review/src/main/worktree-links.ts', kind: null }
      ]
    }
  }))
  ipcMain.handle('yan:trust:status', () => ({ cwd: 'C:/work/pi-desktop-worktrees/git-review', trusted: false, entry: null }))
  ipcMain.handle('yan:git:refs', () => ({
    ok: true,
    busyBranches: [],
    refs: [
      { ref: 'main', label: 'refs/heads/main', kind: 'head', current: true },
      { ref: 'origin/main', label: 'refs/remotes/origin/main', kind: 'remote', current: false },
      { ref: 'feature/review-panel', label: 'refs/heads/feature/review-panel', kind: 'local', current: false }
    ]
  }))
  ipcMain.handle('yan:git:snapshot', () => (stubNonGit ? gitStubNonGitSnapshot() : gitStubSnapshot()))
  ipcMain.handle('yan:git:patch', (_e, req) => gitStubPatch(String(req?.path ?? '')))
  ipcMain.handle('yan:git:content', (_e, req) => gitStubContent(String(req?.path ?? ''), req?.side === 'new' ? 'new' : 'old'))
}

/**
 * 组合表。`states` 里每一项都要在下面 STATES 里能找到脚本。
 * 深浅两套不必每个状态都截：深色多截几个（细节对比更明显），
 * 浅色只截最容易被主题漏掉的那几个（主界面/推理/设置/迷你栏）。
 */
const GROUPS = [
  {
    w: 1440,
    h: 900,
    scale: 1,
    theme: 'dark',
    /*
     * ⚠️ `railsessions` / `pendingcards` 放在**最后**：它们会改 `sessions`（造八条假会话）
     *    与 `runners`（造一个 running 的回合）—— 放在中间会影响后面几张图的 fixture
     *    （实测：`railsessions` 那八条会话把 `trashtoast` 要删的那一行挤进了折叠段）。
     */
    states: ['main', 'righttoolmenu', 'rightwindows', 'artifact', 'imageprogress', 'autonomous', 'autonomousrunning', 'workmodemenu', 'modelmenu', 'reasoning', 'toolgroup', 'toolterm', 'settings', 'capabilities', 'capabilitiesmcp', 'ctxsettings', 'knowledgetab', 'railmini', 'compaction', 'contextbudget', 'ctxnarrow', 'fsnarrow', 'fileincontext', 'trashtoast', 'wschanges', 'wsunknown', 'browserboundary', 'browserblocked', 'usageelapsed', 'usageturn', 'railreorder', 'railsessions', 'pendingcards', 'envmenu', 'envnotgit', 'envbranches', 'envworktrees', 'forkdraft', 'envlinks', 'sourcesearch', 'settingspkg', 'extdiag', 'taskhost', 'taskcard', 'review', 'reviewnotgit', 'reviewwrite', 'subagentlaunch', 'subagent', 'subagentinline', 'subagentfailed', 'chainjoin', 'railwaiting']
  },
  { w: 1440, h: 900, scale: 1, theme: 'light', states: ['main', 'righttoolmenu', 'autonomous', 'autonomousrunning', 'workmodemenu', 'reasoning', 'settings', 'capabilities', 'capabilitiesmcp', 'ctxsettings', 'knowledgetab', 'railmini', 'compaction', 'contextbudget', 'trashtoast', 'browserboundary', 'browserblocked', 'usageelapsed', 'usageturn', 'railreorder', 'envmenu', 'envnotgit', 'envbranches', 'envlinks', 'sourcesearch', 'envworktrees', 'forkdraft', 'extdiag', 'taskhost', 'taskcard', 'settingspkg', 'review', 'reviewnotgit', 'reviewwrite', 'subagentlaunch', 'subagent', 'subagentinline', 'subagentfailed', 'chainjoin', 'railwaiting'] },
  { w: 940, h: 620, scale: 1, theme: 'dark', states: ['main', 'modelmenu', 'railmini'] },
  { w: 940, h: 620, scale: 1, theme: 'light', states: ['main', 'settings', 'knowledgetab'] },
  { w: 900, h: 520, scale: 1, theme: 'dark', states: ['main', 'settings', 'knowledgetab', 'toolgroup', 'taskcard', 'workmodemenu', 'envnotgit', 'envlinks'] },
  { w: 1440, h: 900, scale: 1.25, theme: 'dark', states: ['main', 'settings'] },
  { w: 1440, h: 900, scale: 1.5, theme: 'dark', states: ['main', 'reasoning'] },
  /*
   * 单开一组：额度三档配色（绿 / 黄 / 红 + 「已用完」）。
   * 为什么单独一组而不塞进组 0：那个状态会把会话的 provider 换成受控桩名，
   * 同一组里后面的状态接着截图就会带着这个假 provider（会话已经被改了）。
   * 新组只含这一个状态，不影响任何旧图。
   */
  { w: 1440, h: 900, scale: 1, theme: 'dark', states: ['quotatone'] },
  { w: 1440, h: 900, scale: 1, theme: 'light', states: ['quotatone'] }
]

/** 引导态单独跑（要先把 onboarded 标记拿掉） */
const ONBOARDING_GROUPS = [
  { w: 1440, h: 900, scale: 1, theme: 'dark' },
  { w: 940, h: 620, scale: 1, theme: 'dark' },
  { w: 900, h: 520, scale: 1, theme: 'light' }
]

/*
 * 状态脚本：都在渲染端求值。
 *
 * 约定：每个脚本先把界面复位到「主界面」，再摆出自己那个状态 ——
 * 否则上一个状态留下的菜单/面板会串进下一张图（截出来的是两态叠加）。
 */
const STATES = {
  /* 主界面：右栏打开、左栏展开、没有浮层 */
  main: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      return 'ok';
    })()
  `,
  /* Codex 风格的右栏工具启动器：紧凑列出审查 / 终端 / 浏览器 / 文件。 */
  righttoolmenu: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.closeReview?.();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: true, filePreview: null });
      await sleep(200);
      const button = document.querySelector('[data-testid="right-tool-menu"]');
      if (!button) return 'no-launcher';
      button.click();
      await sleep(180);
      return document.querySelector('[data-testid="right-tool-menu-popover"]') ? 'ok' : 'no-popover';
    })()
  `,
  /* 右栏窗口标签：同一条标签栏同时承载工具栏、审查、浏览器和文件预览。 */
  rightwindows: `
    (async () => {
      try {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const st = window.__yanStore.getState();
        st.closeSettings();
        st.closeReview?.();
        st.closePreview?.();
        st.setRailPinned(true);
        window.__yanStore.setState({ rightPanelOpen: true, filePreview: null });
        await sleep(250);
      /* 视觉矩阵不注册原生浏览器 IPC；用真实 BrowserState 让 BrowserSurface
       * 渲染出来，原生 WebContentsView 的坐标生命周期仍由 live browser 场景验证。 */
      window.__yanStore.setState({
        browserState: {
          open: true,
          url: 'about:blank',
          title: '浏览器窗口',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          mode: 'embedded',
          tabs: [{ id: 'matrix-browser-tab', title: '浏览器窗口', url: 'about:blank' }],
          activeTabId: 'matrix-browser-tab'
        }
      });
      await sleep(650);
      /* 视觉矩阵只注册布局相关 IPC，不注册 readPreview；直接摆真实 FilePreviewState
       * 的渲染输入，仍然走 FilePreviewPane，不为截图专门造 HTML。 */
      const cwd = window.__yanStore.getState().session?.cwd || window.__yanStore.getState().settings?.cwd || 'C:/yan-preview';
      window.__yanStore.setState({
        filePreview: {
          path: 'src/main/agent.ts',
          cwd,
          loading: false,
          data: {
            ok: true,
            path: 'src/main/agent.ts',
            abs: cwd + '/src/main/agent.ts',
            name: 'agent.ts',
            size: 4920,
            kind: 'text',
            text: 'export async function runAgent() {\\n  return "window surface"\\n}\\n'
          }
        }
      });
      await sleep(650);
      /* 直接落 reviewOpen，避免视觉矩阵未注册的 browser.setVisible IPC 干扰标签截图。 */
      window.__yanStore.setState({
        reviewOpen: true,
        reviewScope: { kind: 'working' },
        rightPanelOpen: true
      });
      await sleep(800);
      /* 文件树在工具窗口首次挂载时会清理旧预览；审查窗口打开后再放回文件预览，
       * 才能在同一张图里稳定展示四个并列窗口入口，而不改变真实运行时语义。 */
      window.__yanStore.setState({
        filePreview: {
          path: 'src/main/agent.ts',
          cwd,
          loading: false,
          data: {
            ok: true,
            path: 'src/main/agent.ts',
            abs: cwd + '/src/main/agent.ts',
            name: 'agent.ts',
            size: 4920,
            kind: 'text',
            text: 'export async function runAgent() {\\n  return "window surface"\\n}\\n'
          }
        }
      });
      await sleep(350);
        const tabs = [...document.querySelectorAll('[data-testid="right-window-tabs"] [role="tab"]')]
          .map((el) => el.textContent?.replace('×', '').trim())
          .filter(Boolean);
        return tabs.length >= 4 ? 'ok' : 'tabs=' + JSON.stringify(tabs);
      } catch (error) {
        return 'error:' + (error?.stack || error?.message || String(error));
      }
    })()
  `,
  /* AI 文件产物：走真实 TurnView → ArtifactCard，不用截图专用 HTML。 */
  artifact: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closePreview?.();
      window.__yanStore.setState({ rightPanelOpen: false });
      const artifact = {
        id: 'matrix-artifact-svg',
        sourceId: 'matrix-artifact-svg',
        filename: 'yan-mark.svg',
        path: ${JSON.stringify(MATRIX_ARTIFACT_SVG_PATH)},
        mediaType: 'image/svg+xml',
        kind: 'svg',
        bytes: 436,
        createdAt: Date.now(),
        previewable: true,
        provider: 'codex',
        model: 'gpt-image-2',
        description: 'AI 生成的砚图标（真实 artifact 卡片）'
      };
      const messages = window.__yanStore.getState().messages;
      const host = messages.find((m) => m.role === 'assistant');
      if (!host) return 'no-assistant';
      window.__yanStore.setState({
        messages: messages.map((m) => m.id === host.id ? { ...m, artifacts: [artifact] } : m)
      });
      await sleep(650);
      const card = document.querySelector('[data-testid="turn-artifacts"] .artifact-card');
      if (!card) return 'no-card';
      card.scrollIntoView({ block: 'center' });
      await sleep(250);
      return 'ok';
    })()
  `,
  /* 生图中：验证进度条目存在、会显示阶段和实时用时，而不是静默等待。 */
  imageprogress: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: false });
      const messages = window.__yanStore.getState().messages;
      const host = messages.find((m) => m.role === 'assistant');
      if (!host) return 'no-assistant';
      window.__yanStore.setState({
        messages: messages.map((m) => m.id === host.id ? {
          ...m,
          imageProgress: [{
            id: 'matrix-image-progress',
            stage: 'generating',
            startedAt: Date.now() - 24000,
            updatedAt: Date.now(),
            provider: 'codex',
            model: 'gpt-image-2',
            detail: '正在生成图片'
          }]
        } : m)
      });
      await sleep(700);
      const card = document.querySelector('[data-testid="image-progress-list"]');
      if (!card) return 'no-progress';
      card.scrollIntoView({ block: 'center' });
      await sleep(250);
      return 'ok';
    })()
  `,
  /*
   * 自主模式：输入框边框上的两条对称光带（DESIGN §4.2）。
   *
   * 实施-05 起“是不是自主”由**会话级工作模式**决定，不再是全局布尔 —— 所以
   * 这里直接注入 store 的 `workMode`（视觉矩阵是 mock 环境，没有 IPC）。
   * 静态图只能证明「这个状态存在」且「两条都在」；相位是否真对称（相隔半个周期）
   * 靠 `workmode` 探针断言 `animation-delay`，以及现场看一眼。
   */
  autonomous: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({ workMode: { mode: 'autonomous', revision: 1 } });
      /* 真实使用时输入框就是聚焦的（聚焦时边框更亮，光带也更容易看清） */
      document.querySelector('[data-testid="composer"]')?.focus();
      return 'ok';
    })()
  `,
  /*
   * 自主模式 + **任务真的在跑**（实施-09 N10 的尾项）。
   *
   * 与 `autonomous` 的差别：那张是“刚切到自主、还什么都没发生”，
   * 这张是“自主模式下有一回合在跑”——用户真正会盯着看的状态。
   * 光带动画是常驻的（不区分跑没跑），所以这里证的是它与运行态界面
   *（停止按钮 / 流式提示 / 左栏运行中那一行）同屏正常。
   * 动画“真的在跑”由 `workmode` 探针量（playState + currentTime 递增）。
   */
  autonomousrunning: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      const stamp = Date.now();
      const cwd = String(st.settings.cwd);
      const file = cwd + '/autorun.jsonl';
      window.__yanStore.setState({
        workMode: { mode: 'autonomous', revision: 1 },
        session: { ...(st.session ?? {}), cwd, sessionFile: file, isStreaming: true, isAgentRunning: true },
        activeRunnerId: 'vs-autorun',
        runners: [{
          id: 'vs-autorun', runId: 'vs-autorun', cwd, sessionFile: file, sessionId: 'autorun',
          generation: 1, running: true, waiting: false, failed: false,
          conn: 'ready', createdAt: stamp, lastActiveAt: stamp, isActive: true
        }]
      });
      document.querySelector('[data-testid="composer"]')?.focus();
      return 'ok';
    })()
  `,
  /*
   * 工作模式菜单（实施-05 §3）：原位显示「标准 / 澄清 / 自主 ▾」，
   * 菜单里每项带一句说明。状态为「澄清 + 菜单展开」——这正是用户第一次
   * 接触三档时要看到的样子。
   */
  workmodemenu: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: false, workMode: { mode: 'clarify', revision: 2 } });
      await sleep(60);
      document.querySelector('[data-testid="work-mode-button"]')?.click();
      await sleep(120);
      return 'ok';
    })()
  `,
  toolgroup: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: false });
      await sleep(200);
      /*
       * 先造一个**长组**（60 条调用）：用户报的就是这个场景 ——
       * 「主动展开调用工具/命令栏的时候，给展开的条目一个显示范围，
       * 而不是铺开到整个界面」（他截图里那条组有 146 次调用）。
       * fixture 只有几条，不造的话这张图上看不出限高。
       */
      const now = Date.now();
      const cmds = [
        'grep -rn "steering|followUp" src/renderer/src/state/store.ts | head -30',
        'sed -n 795,830p src/renderer/src/components/rail/Rail.tsx',
        'npm run check',
        'rg -n "tgroup-body" src/renderer/src/styles',
        'git diff --stat src/renderer/src/styles',
        'node scripts/test-unit.mjs'
      ];
      const tools = Array.from({ length: 60 }, (_, i) => ({
        id: 'shot-tool-' + i,
        name: 'bash',
        args: { command: (i + 1) + ') ' + cmds[i % cmds.length] },
        status: 'ok',
        output: 'done',
        startedAt: now - (60 - i) * 1000,
        endedAt: now - (60 - i) * 1000 + 400
      }));
      /*
       * ⚠️ 只能**追加**到已有的 assistant 消息上，不能整包替换 messages：
       *    后面几张图（wschanges / wsunknown / usageelapsed …）都靠 fixture 的
       *    消息与回合，整包换掉它们就全找不着元素了（实测踩过，6 张图缺件）。
       */
      const prev = window.__yanStore.getState().messages;
      /* 挑**第一条**带工具的 assistant 消息：它的组在页面靠上，展开后 548px 的
         列表基本落在视口内（放到最后一条会有一大半截在屏幕外面，图上看不到边界） */
      const withTools = prev.find((m) => m.role === 'assistant' && m.toolCalls?.length);
      window.__yanStore.setState({
        messages: withTools
          ? prev.map((m) => (m === withTools ? { ...m, toolCalls: [...m.toolCalls, ...tools] } : m))
          : [...prev, { id: 'shot-a', role: 'assistant', text: '', toolCalls: tools }]
      });
      await sleep(500);
      /* 只做一件事：展开折叠组。
       *
       * 为什么不把终端窗口一起点开（曾经试过）：点工具行会走 withScrollAnchor（碰 store），
       * 那一次重渲染会把组的内部 manual 状态打回收起的默认值 —— 两张形态合在一张图里
       * 怎么排都会丢一张。所以拆成两个状态：本状态管**组展开**（组内行保持一行，N03 的规则），
       * toolterm 管**命令行的终端窗口**。
       */
      /* 点刚加长的那一组（第一条带工具的 assistant 消息 → 第一个组头） */
      const heads = [...document.querySelectorAll('.tgroup-head')];
      const head = heads[0];
      if (head) head.click();
      await sleep(500);
      return 'ok(count=' + document.querySelectorAll('.tgroup-body .trow').length + ')';
    })()
  `,
  /* 工具详情：命令行展开后的终端窗口（N03；只有命令类工具会渲染 .term） */
  toolterm: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: false });
      await sleep(200);
      const row =
        document.querySelector('.trow[data-tool="bash"] .trow-head') ||
        document.querySelector('.trow[data-state="running"] .trow-head');
      if (row) row.click();
      await sleep(400);
      return 'ok';
    })()
  `,
  /* 模型菜单（N02/N08）：真实点开 picker，让菜单自己算位置。
     picker 在“忙”的时候是 disabled（`busy = session.isStreaming || isCompacting`），
     而 fixture 故意把会话摆成“正在流式”——不先把它放空，点击就完全没反应。 */
  modelmenu: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      const btn = document.querySelector('[data-testid="model-picker"]');
      if (!btn) return 'no-picker';
      if (btn.disabled) return 'picker-disabled';
      btn.click();
      return 'ok(items=' + document.querySelectorAll('.mt-item').length + ')';
    })()
  `,
  /* 推理块（N04）：展开最后一段，并把对话滚到它 */
  reasoning: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      const toggles = [...document.querySelectorAll('[data-testid="reasoning-toggle"]')];
      const last = toggles[toggles.length - 1];
      if (last && last.getAttribute('aria-expanded') !== 'true') last.click();
      const box = document.querySelector('.stream');
      if (box) box.scrollTop = box.scrollHeight;
      return toggles.length ? 'ok' : 'no-reasoning';
    })()
  `,
  /* 设置面板（N07） */
  settings: `
    (() => {
      const st = window.__yanStore.getState();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      st.openSettings('appearance');
      return 'ok';
    })()
  `,
  /* 能力设置页（实施-04 S7）：安全快照 + 三档策略 + MCP 状态卡。 */
  capabilities: `
    (() => {
      const st = window.__yanStore.getState();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({ settings: { ...st.settings, capabilityStrategy: 'auto-connect' } });
      st.openSettings('capabilities');
      return 'ok';
    })()
  `,
  capabilitiesmcp: `
    (() => {
      const st = window.__yanStore.getState();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({ settings: { ...st.settings, capabilityStrategy: 'auto-connect' } });
      st.openSettings('capabilities');
      return 'ok';
    })()
  `,
  /*
   * 上下文设置（N21-7）：工作集阀值可配 + 生效来源。
   * 单独一个状态而不是只拍 appearance —— 新 tab 的排版（数值输入、
   * 预设分段控件、来源行）只能在真图里看是否折行 / 溢出。
   */
  ctxsettings: `
    (() => {
      const st = window.__yanStore.getState();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /*
       * 注入一份“用户级覆盖”的真实形状：来源 + 覆盖字段 + 预算都是主进程
       * 会推的那几个字段（不是只为截图摆的假数据）。
       */
      window.__yanStore.setState({
        settings: { ...st.settings, contextPolicy: { workingSetCap: 300000, windowRatio: 0.75 } },
        session: {
          ...st.session,
          isStreaming: false,
          isAgentRunning: false,
          contextPolicy: {
            enabled: true,
            kinds: ['tool-sweep', 'recall', 'episode-fold', 'compaction'],
            source: 'user',
            overridden: ['workingSetCap', 'windowRatio'],
            budget: {
              contextWindow: 400000,
              responseReserve: 32000,
              safetyMargin: 8000,
              workingSet: 300000,
              triggers: { sweep: 210000, fold: 255000, compact: 300000 },
              emergency: 360000
            }
          }
        }
      });
      st.openSettings('context');
      return 'ok';
    })()
  `,
  /*
   * 项目知识页（实施-03 S5）。
   *
   * 数据是桩（`yan:knowledge:list` 在矩阵主进程里直接返回）—— 这一张验的是
   * 信息层次：开关、三个筛选 + 计数、条目的状态 / 来源 / 有效范围 / 需复核，
   * 以及操作按钮窄窗口下会不会溢出。**不要**拿它当「真读到了项目知识」的证据
   *（那是 live 场景的事）。
   */
  knowledgetab: `
    (() => {
      const st = window.__yanStore.getState();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({ settings: { ...st.settings, projectKnowledge: { enabled: true } } });
      st.openSettings('knowledge');
      return 'ok';
    })()
  `,
  /* 悬着的消息（用户 2026-09-19）：生成中发出去的先悬在输入框上方 */
  /*
   * 后台会话「等待输入」的状态槽（实施-09 S2 第二批）。
   *
   * 单独一个状态、不复用 `railsessions`：那个状态的会话列表会被后面几个状态
   * 用到的 fixture，而这里只需要「一行在跑 / 一行挂着问题等回答」。
   * 注入的是 `runners` 里的 `waiting: true` —— 这正是 `Rail` 渲染 `?` 的**真实判据**
   *（`RunnerStatus.waiting = agent.getPendingUiCount() > 0`，真实链路见场景 `askbackground`）。
   * 第四批（N12 失败态）又加了第三条：`failed: true` 的那一行画 `alert-circle`
   *（真源 `conn === 'error' || conn === 'exited'`，真实故障见场景 `runnerfailed`）。
   * 放在整组最末，并用 AFTER_STATE 把假实例撤走。
   */
  railwaiting: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      const stamp = Date.now();
      const cwd = String(st.settings.cwd);
      const sessions = [
        {
          id: 'vsw-0', path: cwd + '/vsw-0.jsonl', cwd, projectId: 'vsw-proj',
          title: '会话 1 · 正在跑', named: true,
          createdAt: stamp, updatedAt: stamp, lastActivityAt: stamp, messageCount: 4
        },
        {
          id: 'vsw-1', path: cwd + '/vsw-1.jsonl', cwd, projectId: 'vsw-proj',
          title: '会话 2 · 后台等你回答', named: true,
          createdAt: stamp - 60000, updatedAt: stamp - 60000, lastActivityAt: stamp - 60000, messageCount: 6
        },
        {
          id: 'vsw-2', path: cwd + '/vsw-2.jsonl', cwd, projectId: 'vsw-proj',
          title: '会话 3 · 实例起来了又崩了', named: true,
          createdAt: stamp - 120000, updatedAt: stamp - 120000, lastActivityAt: stamp - 120000, messageCount: 2
        }
      ];
      window.__yanStore.setState({
        sessions,
        session: { ...(st.session ?? {}), cwd, sessionFile: sessions[0].path },
        activeRunnerId: 'vsw-r1',
        runners: [
          {
            id: 'vsw-r1', runId: 'vsw-r1', cwd, projectId: 'vsw-proj',
            sessionFile: sessions[1].path, sessionId: 'vsw-1',
            generation: 1, running: false, waiting: true, failed: false,
            conn: 'ready', createdAt: stamp, lastActiveAt: stamp, isActive: true
          },
          /* 失败态：真源是 conn 不是 ready（RunnerStatus.failed = conn 为 error 或 exited） */
          {
            id: 'vsw-r2', runId: 'vsw-r2', cwd, projectId: 'vsw-proj',
            sessionFile: sessions[2].path, sessionId: 'vsw-2',
            generation: 1, running: false, waiting: false, failed: true,
            conn: 'exited', createdAt: stamp, lastActiveAt: stamp, isActive: false
          }
        ]
      });
      st.patchSettings({
        projectGroups: [],
        projects: [{ id: 'vsw-proj', cwd, name: 'pi-desktop', archived: false, createdAt: stamp, updatedAt: stamp }],
        recentCwds: [cwd]
      });
      return 'ok';
    })()
  `,
  pendingcards: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /* 回合在跑，才有「插话 / 排队」二选一 */
      window.__yanStore.setState({
        activeRunnerId: 'pv-run',
        runners: [{
          id: 'pv-run', runId: 'pv-run', sessionFile: 'pv.jsonl', sessionId: 'pv',
          generation: 1, cwd: 'C:/yan-preview', running: true, waiting: false, failed: false,
          conn: 'ready', createdAt: Date.now(), lastActiveAt: Date.now(), isActive: true
        }]
      });
      st.holdSend('插话：先把当前的边界说清楚');
      st.holdSend('排队：等这轮跑完再补上测试');
      st.holdSend('一条比较长的待投递消息，用来验证卡片上的省略号与按钮排布不会被挤掉');
      return 'ok';
    })()
  `,
  /* 项目下的会话折叠（用户 2026-09-19：默认只显示前五个） */
  railsessions: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      const stamp = Date.now();
      const cwd = String(st.settings.cwd);
      const names = ['重构入口', '补测试', '查崩溃', '改样式', '写文档', '调性能', '看日志', '读代码'];
      const sessions = names.map((n, i) => ({
        id: 'vs-' + i,
        path: cwd + '/vs-' + i + '.jsonl',
        cwd,
        projectId: 'vs-proj',
        title: '会话 ' + (i + 1) + ' · ' + n,
        named: true,
        createdAt: stamp,
        updatedAt: stamp - i * 1000,
        messageCount: 3
      }));
      window.__yanStore.setState({
        sessions,
        session: { ...(st.session ?? {}), cwd, sessionFile: sessions[0].path }
      });
      st.patchSettings({
        projectGroups: [],
        projects: [{ id: 'vs-proj', cwd, name: 'pi-desktop', archived: false, createdAt: stamp, updatedAt: stamp }],
        recentCwds: [cwd]
      });
      return 'ok';
    })()
  `,
  /*
   * 交接之后的「一条会话」（实施-05 S5b-4）。
   *
   * 这一张要证明的是**渲染层的形态**：侧栏只出现一条（链上的旧段不显示），
   * 而历史里两段的内容排在**同一条时间线**上（fixture 的旧消息 + 新段那条交接消息）。
   *
   * ⚠️ 过滤逻辑本身归主进程（`test:live -- handoffcommit` 用真 IPC 验
   *    “列表里只有代表段”），这里不伪造「前端自己会过滤」的假象。
   */
  chainjoin: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({ rightPanelOpen: false });
      const stamp = Date.now();
      const cwd = String(st.settings.cwd);
      const sessions = [
        {
          id: 'vs-chain-dest', path: cwd + '/vs-chain-dest.jsonl', cwd, projectId: 'vs-proj',
          title: '长任务续接 · 导入提速', named: false,
          createdAt: stamp, updatedAt: stamp, messageCount: 5
        },
        {
          id: 'vs-other', path: cwd + '/vs-other.jsonl', cwd, projectId: 'vs-proj',
          title: '另一个会话', named: true,
          createdAt: stamp - 9000, updatedAt: stamp - 9000, messageCount: 2
        }
      ];
      const resume = {
        id: 'shot-handoff-resume',
        role: 'user',
        text: '这是一个跨会话交接：上面的对话换了新会话继续，下面是上一个会话留下的交接包。 / [yan-handoff-resume:demo] / 用户目标：把导入做快 / 交付物：可用的批量导入 / 下一步：加进度条',
        createdAt: stamp
      };
      window.__yanStore.setState({
        sessions,
        session: { ...(st.session ?? {}), cwd, sessionFile: sessions[0].path },
        messages: [...st.messages, resume]
      });
      st.patchSettings({
        projectGroups: [],
        projects: [{ id: 'vs-proj', cwd, name: 'pi-desktop', archived: false, createdAt: stamp, updatedAt: stamp }],
        recentCwds: [cwd]
      });
      return 'ok';
    })()
  `,
  /* 迷你项目栏（N14） */
  railmini: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      st.setRailPinned(false);
      return 'ok';
    })()
  `,
  /*
   * 窄右栏文件树（L02）：收到 `PANEL_MIN=220`，一张图里看三件事 ——
   *   · 超长文件名省略显示（`title` 里能给全文）
   *   · 深层的浅缩进在窄栏下收敛，不再把图标顶出右边界
   *   · 无权限目录给的是「没有读取权限」，而不是「空目录」
   */
  /*
   * 浏览器边界（L04）：一张图看三件事 ——
   *   · 被拦下的请求在「⋯」里**可追溯**（目标主机 + 原因 + 是谁想访问）
   *   · 下载条写明「未自动打开」并带**来源**
   *   · 权限记录（默认拒绝）与拦截记录并列
   * 原生网页视图在这个脚本里不存在（它只在真窗口里存在），所以这一张
   * 拍的是工具栏 + 状态行 —— 也就是**渲染层能负责的那部分**。
   */
  browserboundary: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({
        rightPanelOpen: true,
        filePreview: null,
        browserState: {
          open: true,
          url: 'https://example.com/',
          title: 'Example Domain',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          mode: 'embedded',
          lastDownload: {
            path: 'C:\\Users\\yan\\Downloads\\yan-probe-download.txt',
            filename: 'yan-probe-download.txt',
            size: 48,
            source: 'http://127.0.0.1:39873/download'
          },
          permissions: [
            { permission: 'geolocation', origin: 'http://127.0.0.1:39873', status: 'blocked', at: Date.now() - 42000 }
          ],
          blockedRequests: [
            { host: '127.0.0.1', reason: 'private-host', from: 'example.com', at: Date.now() - 9000, count: 2 },
            { host: '127-0-0-1.sslip.io', reason: 'dns-rebind', from: 'example.com', at: Date.now() - 8000, count: 1 }
          ]
        }
      });
      await new Promise((r) => setTimeout(r, 300));
      const more = document.querySelector('[data-testid="browser-more"]');
      if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
      await new Promise((r) => setTimeout(r, 350));
      const list = document.querySelector('[data-testid="browser-blocked"]');
      if (list) list.scrollIntoView({ block: 'nearest' });
      await new Promise((r) => setTimeout(r, 250));
      return 'ok';
    })()
  `,
  /*
   * 同一组数据的**另一面**：⋯ 收起时，状态行上是「已拦截 N 个请求」+ 带来源的
   * 下载条 —— 这两个恰好是用户不打开菜单也能看到的（也是“页面打不开”的解释）。
   * 为什么要两张：菜单与状态行在 JSX 里是互斥分支，一张图拍不全。
   */
  browserblocked: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({
        rightPanelOpen: true,
        filePreview: null,
        browserState: {
          open: true,
          url: 'https://example.com/',
          title: 'Example Domain',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          mode: 'embedded',
          lastDownload: {
            path: 'C:\\Users\\yan\\Downloads\\yan-probe-download.txt',
            filename: 'yan-probe-download.txt',
            size: 48,
            source: 'http://127.0.0.1:39873/download'
          },
          blockedRequests: [
            { host: '127.0.0.1', reason: 'private-host', from: 'example.com', at: Date.now() - 9000, count: 2 },
            { host: '127-0-0-1.sslip.io', reason: 'dns-rebind', from: 'example.com', at: Date.now() - 8000, count: 1 }
          ]
        }
      });
      await new Promise((r) => setTimeout(r, 300));
      const more = document.querySelector('[data-testid="browser-more"]');
      if (more && more.getAttribute('aria-expanded') === 'true') more.click();
      await new Promise((r) => setTimeout(r, 350));
      const status = document.querySelector('[data-testid="browser-status"]');
      if (status) status.scrollIntoView({ block: 'nearest' });
      await new Promise((r) => setTimeout(r, 250));
      return 'ok';
    })()
  `,
  fsnarrow: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /*
       * 不走 store 的 setPanelWidth：那是 async 且要等 patchSettings IPC，
       * 而截图脚本没跑主进程（没有该 handler）—— 实测会卡在这一步。
       * 直接改本地 settings：布局的列宽就从这里读。
       */
      window.__yanStore.setState({
        settings: { ...(st.settings || {}), panelWidth: 220, rightPanelOpen: true }
      });
      /* 展开无权限目录：要拍到的是「没有读取权限」这一行，而不是空白 */
      const np = document.querySelector('[data-testid="fs-row-noperm"]');
      if (np) np.click();
      return 'ok(noperm=' + (np ? 'clicked' : 'missing') + ')';
    })()
  `,
  /*
   * shell 的目录级改动（L05）：展开那条带 `workspaceChanges` 的命令行。
   * 展开后卡片才渲染，所以先 click 再等一帧，最后把卡片滚到视口中间 ——
   * 否则截到的是对话底部，卡片在画面之外。
   */
  wschanges: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /*
       * 已结束的工具被收进「运行了命令 N」组（ToolGroup），组不展开就没有 ToolRow。
       * 先把所有组打开，再找那条带 workspaceChanges 的命令。
       */
      /* aria-expanded 在**按钮**上，不在容器 div 上 ——
         读错了就会「已经开着又点一次」，把组重新关掉（实测踩过）。 */
      document.querySelectorAll('[data-testid="tool-group"]').forEach((g) => {
        const head = g.querySelector('[data-testid="tool-group-toggle"]');
        if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
      });
      await new Promise((r) => setTimeout(r, 350));
      const rows = [...document.querySelectorAll('[data-testid="tool-row"]')];
      const row = rows.find((r) => /migrate-tokens/.test(r.textContent || ''));
      if (!row) return 'no-row(rows=' + rows.length + ', ' + rows.map((r) => (r.textContent || '').slice(0, 18)).join(' | ') + ')';
      if (row.getAttribute('aria-expanded') !== 'true') row.click();
      await new Promise((r) => setTimeout(r, 400));
      const cards = [...document.querySelectorAll('[data-testid="workspace-changes"]')];
      const card = cards[cards.length - 1];
      if (card) card.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 250));
      return cards.length ? 'ok' : 'no-card';
    })()
  `,
  /*
   * 压缩可观测（N21-2）：一张图里看四件事 ——
   *   · 进行中那一行带**原因**（「压缩中 · 已达阈值」）
   *   · 「最近一次」在压缩进行中仍显示上一轮的结果（两条互不覆盖）
   *   · 失败时把 pi 的原文摆出来（不静默）+ 压缩前后 token
   *   · 项目级设置被 pi 忽略时说出来（D21）
   * 截的是详情展开态：这些行都在「详情」里。
   */
  compaction: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({
        session: {
          ...st.session,
          isStreaming: false,
          isCompacting: true,
          compaction: { status: 'running', reason: 'threshold', startedAt: Date.now() - 2400 },
          lastCompaction: {
            status: 'failed',
            reason: 'manual',
            startedAt: Date.now() - 660000,
            endedAt: Date.now() - 659000,
            beforeTokens: 36230,
            afterTokens: 18400,
            error: 'Compaction failed: Already compacted'
          }
        }
      });
      await new Promise((r) => setTimeout(r, 250));
      const toggle = document.querySelector('[data-testid="ctx-details-toggle"]');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      await new Promise((r) => setTimeout(r, 350));
      const row = document.querySelector('[data-testid="ctx-last-compaction"]');
      if (row) row.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 250));
      return 'ok';
    })()
  `,
  /*
   * 工作集视角（N21-3）：一张图里看四件事 ——
   *   · 主值是**工作集**（240k）而不是物理窗口（400k），带 data-mode
   *   · 三条阶段刻度：压缩实线（真的会触发）、清理/折叠虚线（阶段 4 才接管）
   *   · 「下一步：压缩上下文（约 240k 时）」
   *   · 详情里的 工作集 / 预留 / 安全余量 / 物理兜底
   * 预算值直接注入 store（与主进程推来的同构），这里不重算公式。
   */
  /*
   * 本轮用时（用户要求）：回合结束后，底部用量条上要能看到「用时 Ns」。
   * fixture 默认把会话摆成「流式中」（那时显示的是「生成中 Ns」），
   * 所以这里显式置为已结束，并确认真的渲染出了耗时项。
   */
  usageelapsed: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({ session: { ...st.session, isStreaming: false, isAgentRunning: false } });
      await new Promise((r) => setTimeout(r, 400));
      const box = document.querySelector('.stream');
      if (box) box.scrollTop = box.scrollHeight;
      await new Promise((r) => setTimeout(r, 250));
      return document.querySelector('[data-testid="ub-elapsed"]') ? 'ok' : 'no-elapsed';
    })()
  `,
  /*
   * 新一轮刚开始（R03）：会话里上一轮有非零 usage 与 speed，现在追加一条
   * 用户消息并回到流式 —— 用量条必须显示「生成中 Ns」，**不能**把上一轮的
   * 46 tok/s 标成实时速度，输入/输出/缓存也要是「—」而不是旧值。
   * 零费用：完全在渲染端注入状态，不调模型。
   */
  usageturn: `
    (async () => {
      try {
        const st = window.__yanStore.getState();
        st.closeSettings();
        st.setRailPinned(true);
        document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
        const next = [...st.messages, { id: 'u3', role: 'user', text: '还要把右键菜单也整理一下。', timestamp: Date.now() }];
        window.__yanStore.setState({
          messages: next,
          session: { ...st.session, isStreaming: true, isAgentRunning: true }
        });
        await new Promise((r) => setTimeout(r, 500));
        const bar = document.querySelector('[data-testid="usagebar"]');
        if (!bar) return 'no-usagebar';
        const text = bar.textContent || '';
        if (!/生成中|generating/i.test(text)) return 'no-generating';
        if (!bar.querySelector('.ub-live')) return 'no-live-dot';
        if (text.includes('tok/s')) return 'stale-speed';
        if (bar.querySelector('[data-testid="ub-elapsed"]')) return 'stale-elapsed';
        const box = document.querySelector('.stream');
        if (box) box.scrollTop = box.scrollHeight;
        await new Promise((r) => setTimeout(r, 250));
        return 'ok';
      } catch (e) {
        return 'err:' + (e && e.message ? e.message : String(e));
      }
    })()
  `,
  contextbudget: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({
        session: {
          ...st.session,
          isStreaming: false,
          isAgentRunning: false,
          contextPolicy: {
            enabled: true,
            kinds: ['tool-sweep', 'recall', 'episode-fold', 'compaction'],
            budget: {
              /*
               * 窗口必须与截图 fixture 的模型一致（400k，见 shot-fixture.js），
               * 否则会出现“面板里的窗口 400k、兜底线却是 262k 窗口算出来的”这种
               * 自相矛盾的截图（正是 D21/D22 那类误解）。
               * 兜底线在 400k 上不被预留卡住（360k < 368k），所以这里看不出 D31 的
               * 差别 —— 那一条由单测扫描 + 探针在**真实窗口**上断言（probe/context-budget.js 第 2 节）。
               */
              contextWindow: 400000,
              responseReserve: 32000,
              safetyMargin: 8000,
              workingSet: 240000,
              triggers: { sweep: 168000, fold: 204000, compact: 240000 },
              emergency: 360000
            }
          }
        }
      });
      await new Promise((r) => setTimeout(r, 250));
      const toggle = document.querySelector('[data-testid="ctx-details-toggle"]');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      await new Promise((r) => setTimeout(r, 350));
      return 'ok';
    })()
  `,
  /*
   * 最窄右栏（PANEL_MIN = 220px）+ 工作集视角：用户截图里的组合。
   * 要拍的就是「自动压缩」那一行 —— 压缩按钮必须**一行高**、与标题同一条中线，
   * 文字不能被折成「压缩上/下文」；阶段刻度和「下一步」在窄栏下也要能读。
   */
  ctxnarrow: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /* 不走 store 的 setPanelWidth（async + 需要主进程 handler），直接改本地 settings */
      window.__yanStore.setState({
        settings: { ...(st.settings || {}), panelWidth: 220, rightPanelOpen: true },
        session: {
          ...st.session,
          isStreaming: false,
          isAgentRunning: false,
          contextPolicy: {
            enabled: true,
            kinds: ['tool-sweep', 'recall', 'episode-fold', 'compaction'],
            budget: {
              /*
               * 用真实模型的窗口（262144，与用户机器一致）而不是整数 400k：
               * 这个窗口上兜底线正好被输出预留卡住（224k 而不是 230.4k），
               * 截图里「物理兜底」那一行就是 §12.1 / D31 的证据。
               */
              contextWindow: 262144,
              responseReserve: 32000,
              safetyMargin: 8000,
              workingSet: 183501,
              triggers: { sweep: 128451, fold: 155976, compact: 183501 },
              emergency: 229376
            }
          }
        }
      });
      await new Promise((r) => setTimeout(r, 400));
      const row = document.querySelector('[data-testid="rp-context-actions"]');
      if (row) row.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 250));
      return 'ok';
    })()
  `,
  /*
   * 删除后的**非模态**通知条（回收站）。几何与文案由 `trash` 探针断言，
   * 这里补的是静态截图（浅色/深色各一张）—— 它是左栏唯一一条"操作已完成、
   * 还能撤销"的横条，颜色与按钮宽度最容易在改主题时坏掉。
   *
   * 注意：删除成功后 store 会 `refreshSessions()`，而截图环境故意不注册
   * 拉取型 IPC（返回空会盖掉 fixture 注入的数据）—— 这里先把会话列表存一份，
   * 等通知出现后再放回去，否则截图里左栏会空掉（那不是这个状态要拍的东西）。
   */
  extdiag: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closePreview?.();
      st.clearAttachments?.();
      /*
       * 「扩展来源」诊断（实施-02 S1）：这三行就是迁移期给用户的诊断样例。
       * 摆的是**真实文案**（与 extensions-inventory.ts 的输出一致），不是示意。
       */
      window.__yanStore.setState({
        logs: [
          '[来源] 用户扩展 1 项：left-info-panel.ts（pi 启动时会自动发现并加载它们；砚不删除、不改写）',
          '[来源] 砚内置薄层 6 项：browser.js、question.js、response-detail.js、language.js、capability-guide.js、context.js（显式传入，只挂生命周期钩子，不注册模型工具）',
          '[来源] 检测到用户扩展：当前任务清单仍由扩展写入 \`left-panel-tasks\`，砚只读取并显示；砚内置任务计划落地后写入改走宿主日志，旧条目保持只读（两者不会互相覆盖）'
        ]
      });
      await sleep(350);
      /* 日志分区默认收起 —— 展开才看得到内容 */
      const head = document.querySelector('[data-testid="rp-log"] .rp-sec-head');
      if (!head) return 'no-log-section';
      if (head.getAttribute('aria-expanded') === 'false') {
        head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(450);
      }
      const body = document.querySelector('[data-testid="log-body"]');
      if (!body) return 'no-log-body';
      const text = body.textContent || '';
      if (!text.includes('[来源] 用户扩展')) return 'no-diag-text';
      /*
       * 右栏很长（任务 / 上下文 / 文件 / 额度 / 队列都在日志上面），
       * 不滚过去的话截图里根本看不到日志区 —— 实测第一张就是这样（只证明了元素存在）。
       */
      head.scrollIntoView({ block: 'center' });
      body.scrollTop = body.scrollHeight;
      await sleep(350);
      const r = body.getBoundingClientRect();
      return 'ok(h=' + Math.round(r.height) + ' lines=' + text.split('\\n').length + ')';
    })()
  `,
  /*
   * 宿主任务清单（实施-02 S3）。
   *
   * 这一片**不改任务面板 UI**（那是产品边界），改的是清单的来源：
   * 现在由宿主任务日志（`YAN_DIR/task-plans/<sessionId>.jsonl`）提供，
   * 与会话里的旧条目走同一套归并。所以这张图要看的是：
   *   · 清单主体（含完成 / 未完成状态）照旧正确；
   *   · 多轮历史快照折叠展开后每份清单的样式没变。
   * 数据是摆的（视觉矩阵没有主进程），形态与 `yan tasks apply` 写出来的一致。
   */
  taskhost: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closePreview?.();
      st.clearAttachments?.();
      window.__yanStore.setState({
        rightPanelOpen: true,
        todos: [
          { text: '确认范围', done: false },
          { text: '实现宿主任务服务', done: true, status: 'done' },
          { text: '真实运行验收', done: false }
        ],
        todoHistory: [
          {
            id: 'h1',
            round: 1,
            todos: [
              { text: '确认范围', done: false },
              { text: '实现宿主任务服务', done: false },
              { text: '真实运行验收', done: false }
            ]
          },
          {
            id: 'h2',
            round: 2,
            todos: [
              { text: '确认范围', done: false },
              { text: '实现宿主任务服务', done: true, status: 'done' },
              { text: '真实运行验收', done: false }
            ]
          }
        ]
      });
      await sleep(350);
      const toggle = document.querySelector('[data-testid="todo-history-toggle"]');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(400);
      }
      const hist = document.querySelector('[data-testid="todo-history"]');
      if (!hist) return 'no-history';
      hist.scrollIntoView({ block: 'center' });
      await sleep(300);
      return 'ok(items=' + document.querySelectorAll('.rp-todo').length + ')';
    })()
  `,
  /*
   * 任务计划工具卡（实施-02 S4）。
   *
   * 模型维护任务清单的方式是用**原生 bash** 敲 `yan tasks apply` ——
   * 对模型这是 bash，对用户应该是“砚内置的任务计划”。这张图要看的是：
   *   · 卡片上有「任务计划 · 砚内置」来源徐标；
   *   · 命令原文仍在（用户靠它判断在干什么）；
   *   · 展开后仍是原始 bash 调用与输出（不伪造独立工具事件）。
   * 数据是摆的（视觉矩阵没有主进程），形态与 `taskcli` 真实跑出来的一致。
   */
  taskcard: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closePreview?.();
      window.__yanStore.setState({ rightPanelOpen: false });
      await sleep(200);
      const now = Date.now();
      const call = {
        id: 'shot-task-plan',
        name: 'bash',
        args: { command: 'yan tasks apply --request-file tasks/task-set.json' },
        status: 'ok',
        output:
          '{"ok":true,"operationId":"8f27c14b-ef14-44ab","summary":{"kind":"task-plan","action":"set","revision":1,"items":3,"done":0}}',
        startedAt: now - 4200,
        endedAt: now - 3600
      };
      const prev = window.__yanStore.getState().messages;
      /* 只**追加**一条调用，不整包换 messages（后面的图还靠 fixture 的消息） */
      const host = prev.find((m) => m.role === 'assistant' && m.toolCalls?.length);
      window.__yanStore.setState({
        messages: host
          ? prev.map((m) => (m === host ? { ...m, toolCalls: [call, ...m.toolCalls] } : m))
          : [...prev, { id: 'shot-task-card', role: 'assistant', text: '', toolCalls: [call] }]
      });
      await sleep(500);
      /*
       * 先展开**还没开**的工具组（收起时内部的行不在 DOM 里），再展开那一行。
       * 只点没开的：菜单/组是开关，把已展开的点一下反而会收起来（这个坑犯过好几次）。
       */
      document
        .querySelectorAll('.tgroup:not(.open) .tgroup-head')
        .forEach((h) => h.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
      await sleep(500);
      const row = document.querySelector('.trow[data-origin="yan-task-plan"] .trow-head');
      if (row && row.getAttribute('aria-expanded') !== 'true') {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(500);
      }
      const badge = document.querySelector('[data-testid="tool-src"]');
      if (!badge) return 'no-badge';
      badge.closest('.trow')?.scrollIntoView({ block: 'center' });
      await sleep(300);
      return 'ok(' + (badge.textContent || '') + ')';
    })()
  `,
  trashtoast: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      /*
       * 复位右栏：上几张图（fsnarrow / fileincontext）会留下展开的文件树、文件预览
       * 与输入区里的附件标签 —— 不清掉的话这张"回收站通知"的图里会挂着别人的状态。
       */
      st.closePreview?.();
      st.clearAttachments?.();
      document
        .querySelector('[data-testid="rp-files"] .rp-sec-head')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(300);
      const saved = window.__yanStore.getState().sessions;
      /*
       * 截图需要一条**可删的**会话：当前会话禁止删除，而 fixture 里只有一条
       * 显示的会话（其它几条在同名项目分组里没渲染出来）。所以临时补一条
       * 合成会话 —— 它只活在这张截图里，删完立刻把原列表放回去。
       */
      const extra = {
        ...saved[0],
        id: 'shot-trash',
        path: 'C:/Users/x/.pi/agent/sessions/proj/shot-trash.jsonl',
        title: '布局微调 · 待删除的会话',
        updatedAt: Date.now() - 60000
      };
      window.__yanStore.setState({ sessions: [...saved.filter((x) => x.id !== 'shot-trash'), extra] });
      await sleep(400);
      const row = document.querySelector('[data-session-path="' + extra.path + '"]');
      if (!row) return 'no-row(rows=' + document.querySelectorAll('.srow').length + ')';
      const setValue = (el, v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      row.querySelector('.srow-acts button')?.click();
      await sleep(300);
      const danger =
        row.querySelector('.srow-menu-btn.danger:not([disabled])') ??
        [...document.querySelectorAll('.srow-menu-btn.danger:not([disabled])')].pop();
      if (!danger) return 'no-danger-item';
      danger.click();
      await sleep(500);
      const dlg = document.querySelector('.rail-delete-dialog');
      const input = dlg?.querySelector('.modal-input');
      if (!input) return 'no-dialog';
      setValue(input, input.placeholder);
      await sleep(250);
      const confirm = dlg.querySelector('.modal-foot .btn.danger');
      if (!confirm || confirm.disabled) return 'confirm-disabled';
      confirm.click();
      for (let i = 0; i < 30; i++) {
        if (document.querySelector('[data-testid="trash-notice"]')) break;
        await sleep(150);
      }
      /* 删除后 store 会 refreshSessions（截图环境没有该 IPC）→ 把原列表放回去 */
      window.__yanStore.setState({ sessions: saved });
      await sleep(400);
      const notice = document.querySelector('[data-testid="trash-notice"]');
      if (!notice) return 'no-notice';
      const r = notice.getBoundingClientRect();
      const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const chain = [];
      for (let el = notice.parentElement; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        chain.push((el.className || el.tagName) + ':' + cs.overflow + '/' + cs.overflowY + ':' + el.scrollTop + '/' + el.clientHeight + '/' + el.scrollHeight);
        if (chain.length > 6) break;
      }
      return 'ok(mid=' + (mid?.className || mid?.tagName) + '|' + chain.join(' > ') + ')';
    })()
  `,
  fileincontext: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.getState().clearAttachments?.();
      const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      click(document.querySelector('[data-testid="fs-row-src"]'));
      await new Promise((r) => setTimeout(r, 700));
      click(document.querySelector('[data-testid="fs-row-src/main"]'));
      await new Promise((r) => setTimeout(r, 700));
      const file = document.querySelector('[data-testid="fs-row-src/main/agent.ts"]');
      if (!file) return 'no-file-row';
      /* 单击 = 只读预览（与"加入上下文"是两件事，这里两样都要拍到） */
      click(file);
      await new Promise((r) => setTimeout(r, 500));
      const add = document.querySelector('[data-testid="fs-add-src/main/agent.ts"]');
      if (!add) return 'no-add-button';
      click(add);
      await new Promise((r) => setTimeout(r, 600));
      const tagged = window.__yanStore.getState().attachments?.some((a) => a.kind === 'file');
      const dot = document.querySelector('[data-testid="fs-inctx-src/main/agent.ts"]');
      return 'ok(tagged=' + (tagged ? 1 : 0) + ',dot=' + (dot ? 1 : 0) + ')';
    })()
  `,
  /* 同一个组件的第二个变体：归属存疑（并发）时的写法 */
  wsunknown: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /* aria-expanded 在**按钮**上，不在容器 div 上 ——
         读错了就会「已经开着又点一次」，把组重新关掉（实测踩过）。 */
      document.querySelectorAll('[data-testid="tool-group"]').forEach((g) => {
        const head = g.querySelector('[data-testid="tool-group-toggle"]');
        if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
      });
      await new Promise((r) => setTimeout(r, 350));
      const rows = [...document.querySelectorAll('[data-testid="tool-row"]')];
      const row = rows.find((r) => /npm run build/.test(r.textContent || ''));
      if (!row) return 'no-row(rows=' + rows.length + ')';
      if (row.getAttribute('aria-expanded') !== 'true') row.click();
      await new Promise((r) => setTimeout(r, 400));
      const warn = document.querySelector('[data-testid="ws-unknown"]');
      if (warn) warn.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 250));
      return warn ? 'ok' : 'no-unknown';
    })()
  `,
  /*
   * 项目 / 分组拖拽排序（N01）：停在**拖拽进行中**。
   *
   * 为什么不截拖完的结果：拖完的列表与普通列表在视觉上完全一样，
   * 而这次交互唯一的视觉语言就是「被拖的行半透明 + 目标位置一条 2px 插入线」，
   * 它必须在真图里能被人眼检查（尤其是浅色主题下的对比度）。
   */
  railreorder: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      const base = String(st.settings.cwd || '').replace(/[\\/][^\\/]*$/, '');
      const stamp = Date.now();
      const projects = [
        { id: 'vis-p1', cwd: base + '/vis-one', name: '一号项目', groupId: 'vis-ga', archived: false, createdAt: stamp, updatedAt: stamp + 6 },
        { id: 'vis-p2', cwd: base + '/vis-two', name: '二号项目', groupId: 'vis-ga', archived: false, createdAt: stamp, updatedAt: stamp + 5 },
        { id: 'vis-p3', cwd: base + '/vis-three', name: '三号项目', groupId: 'vis-ga', archived: false, createdAt: stamp, updatedAt: stamp + 4 },
        { id: 'vis-p4', cwd: base + '/vis-four', name: '四号项目', groupId: 'vis-gb', archived: false, createdAt: stamp, updatedAt: stamp + 3 },
        { id: 'vis-p5', cwd: base + '/vis-five', name: '五号项目', groupId: 'vis-gb', archived: false, createdAt: stamp, updatedAt: stamp + 2 },
        { id: 'vis-p6', cwd: base + '/vis-six', name: '六号项目', groupId: undefined, archived: false, createdAt: stamp, updatedAt: stamp + 1 }
      ];
      /*
       * 直接 setState 而不走 patchSettings：截图脚本**故意不注册**写设置类 IPC
       * （见 registerStubHandlers 的说明），调它只会拿到
       * “No handler registered for 'yan:patchSettings'”。
       */
      window.__yanStore.setState({
        settings: {
          ...st.settings,
          projectGroups: [
            { id: 'vis-ga', name: '产品线', createdAt: stamp },
            { id: 'vis-gb', name: '实验线', createdAt: stamp }
          ],
          projects,
          projectOrder: projects.map((p) => p.id),
          recentCwds: projects.map((p) => p.cwd)
        }
      });
      await new Promise((r) => setTimeout(r, 450));
      const rows = [...document.querySelectorAll('[data-testid="rail-project-row"]')];
      if (rows.length < 4) return 'rows=' + rows.length;
      /*
       * 拖动源与落点必须**同组**：跨组不接受落点（归属变更走右键菜单），
       * 选错就是一张没有插入线的图（实测踩过）。
       * 分组聚合后的顺序是：产品线 p1,p2,p3 → 实验线 p4,p5 → 未分组 p6。
       */
      const from = rows[2];
      const to = rows[0];
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1, isPrimary: true, pointerType: 'mouse'
      }));
      pe(from, 'pointerdown', a.left + 30, a.top + a.height / 2);
      await new Promise((r) => setTimeout(r, 40));
      /* 先越过 4px 阀值才进拖拽态 —— 与用户手拖走的是同一条路径 */
      pe(window, 'pointermove', a.left + 30, a.top + a.height / 2 + 10);
      await new Promise((r) => setTimeout(r, 40));
      pe(window, 'pointermove', b.left + 30, b.top + b.height * 0.2);
      await new Promise((r) => setTimeout(r, 260));
      return 'ok';
    })()
  `,
  /*
   * 环境菜单（G1 §3.1）：项目胶囊点开后的样子。
   *
   * 这张图要能看清五件事：变更数、工作目录、当前分支（带 ↑1）、
   * 「无法获取 Pull Request 状态」、比较分支。最后一条就是“不伪造状态”。
   */
  envmenu: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      /* 审查面板必须关掉：它优先于其它右栏视图，留着会把菜单遮在后面 */
      st.closeReview?.();
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      await sleep(400);
      /*
 * 菜单是**开关**：组内前一个状态可能把它留着开着，再点一次就关上了。
 * 所以先看它开没开 —— 幂等。
 */
if (!document.querySelector('[data-testid="env-menu"]')) {
      document.querySelector('[data-testid="session-project"]')?.click();
      await sleep(500);
}
      return document.querySelector('[data-testid="env-menu"]') ? 'ok' : 'no-menu';
    })()
  `,
  /*
   * 审查面板（G1 §3.2）：范围选择 + 统计 + 逐文件 diff（含「N 行未修改」折叠）
   * + 变更文件树 + 已查看进度 + 图片前后对照。
   *
   * 数据是合成的（见上面的 gitStub*）—— 截图绝不接真实仓库。
   */
  /*
   * 写操作界面（G2 §5.2 / §5.3）：每个文件行的「暂存 / 取消暂存」、
   * 头部的批量按钮、面板底部的提交区（说明 + 提交 / 提交并推送）。
   *
   * 这些控件的位置与可用性是截图才能验收的东西：它们挤在文件行右侧、
   * 行内还有「已查看」，谁在谁左边、忙的时候什么样，只有图说得清。
   */
  /*
   * 非 Git 目录 · 环境菜单（实施-07 S1）。
   *
   * 不能复用 `envmenu` 的截图：那张图里全是 Git 才有的区块。
   * 这里把会话 cwd 换成合成目录，`yan:git:state` 就返回 `repo: null`，
   * 菜单落进 `env-notgit` 分支（不给变更数、不给写操作入口）。
   */
  envnotgit: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      window.__yanStore.setState({ rightPanelOpen: true });
      /* 菜单是开关：先确保关掉，再点开 */
      const btn = () => document.querySelector('[data-testid="session-project"]');
      if (btn()?.getAttribute('aria-expanded') === 'true') btn().click();
      await sleep(250);
      /* 仓库状态是组件级缓存，只认 cwd 变化与窗口获焦（2s 防抖）——
         这里的 focus 是同一个监听、同一条刷新路径，不是绕开它 */
      window.dispatchEvent(new Event('focus'));
      await sleep(900);
      btn()?.click();
      await sleep(800);
      return document.querySelector('[data-testid="env-notgit"]') ? 'ok' : 'no-notgit';
    })()
  `,
  /* 非 Git 目录 · 审查面板：说清「没有改动可审查」，而不是给一个空的 diff */
  reviewnotgit: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: true });
      const btn = document.querySelector('[data-testid="session-project"]');
      if (btn && btn.getAttribute('aria-expanded') === 'true') btn.click();
      /* 上一条 review 可能已经把面板挂上了；先关再开，让快照重新拉一次 */
      st.closeReview?.();
      await sleep(200);
      st.openReview({ kind: 'working' });
      await sleep(600);
      window.dispatchEvent(new Event('focus'));
      await sleep(1000);
      return document.querySelector('[data-testid="review-notgit"]') ? 'ok' : 'no-notgit';
    })()
  `,
  reviewwrite: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: true });
      const btn = document.querySelector('[data-testid="session-project"]');
      if (btn && btn.getAttribute('aria-expanded') === 'true') btn.click();
      await sleep(200);
      st.openReview({ kind: 'working' });
      await sleep(1400);
      /* 填一句提交说明：空输入框看不出 placeholder 之外的东西，
         而这一区要验的是「说明 + 已暂存数 + 主按钮文案」三者的排布 */
      const ta = document.querySelector('[data-testid="commit-message"]');
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, 'feat: 给审查面板加上暂存与提交');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(300);
      return document.querySelector('[data-testid="commit-bar"]') ? 'ok' : 'no-commit';
    })()
  `,
  /*
   * 环境菜单的分支区（G2 §5.1）：分支列表 + 当前分支标记 + 新建分支输入框，
   * 以及「拉取」「推送（↑1）」两项。这张图要能看出**哪些能点**：
   * 当前分支的条目是灰的。
   */
  envbranches: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      await sleep(300);
      /*
 * 菜单是**开关**：组内前一个状态可能把它留着开着，再点一次就关上了。
 * 所以先看它开没开 —— 幂等。
 */
if (!document.querySelector('[data-testid="env-menu"]')) {
      document.querySelector('[data-testid="session-project"]')?.click();
      await sleep(500);
}
      document.querySelector('[data-testid="env-branch"]')?.click();
      await sleep(600);
      return document.querySelector('[data-testid="env-branches"]') ? 'ok' : 'no-branches';
    })()
  `,
  /*
   * 工作树区（W1 §6.2）：列出主工作树与「砚创建」的那条，附新建输入与
   * 目标目录。这张图要能看出**主工作树没有「移除」按钮**（它删不得）。
   */
  /*
   * 「关联外部任务」与「在网上比较」（方案 §6.4 / §7）：都在菜单**最下面**，
   * 所以这张图要把菜单滚到底 —— 否则看到的是同一屏的前半段。
   */
  /*
   * 设置 → 插件（方案 §9 的 P2）：目录入口 + 安装区 + 已装列表 + 生效时机。
   * 列表读的是真实 pi 目录（只读），所以这张图反映的是这台机器上真正装了什么。
   */
  settingspkg: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.setRailPinned(true);
      st.closeReview?.();
      await sleep(200);
      window.__yanStore.getState().openSettings('packages');
      await sleep(700);
      return document.querySelector('[data-testid="set-packages"]') ? 'ok' : 'no-packages-tab';
    })()
  `,
  sourcesearch: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      await sleep(300);
      /* 菜单是开关：前一个状态可能把它留着开着（与 envlinks 同一处理） */
      if (!document.querySelector('[data-testid="env-menu"]')) {
        document.querySelector('[data-testid="session-project"]')?.click();
        await sleep(700);
      }
      return document.querySelector('[data-testid="src-websearch"]') ? 'ok' : 'no-entry';
    })()
  `,
  envlinks: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      await sleep(300);
      /*
 * 菜单是**开关**：组内前一个状态可能把它留着开着，再点一次就关上了。
 * 所以先看它开没开 —— 幂等。
 */
if (!document.querySelector('[data-testid="env-menu"]')) {
      document.querySelector('[data-testid="session-project"]')?.click();
      await sleep(600);
}
      /* 先写一条关联，列表区才有内容可看 */
      const box = document.querySelector('[data-testid="src-url"]');
      const title = document.querySelector('[data-testid="src-title"]');
      if (box && title) {
        const set = (el, v) => {
          const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
          d.set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(box, 'https://github.com/o/pi-desktop/issues/42');
        set(title, '把手改可拖拽 · 落盘');
        await sleep(120);
        document.querySelector('[data-testid="src-add-web"]')?.click();
        await sleep(400);
      }
      const menu = document.querySelector('.env-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
      await sleep(500);
      const ok =
        document.querySelector('[data-testid="env-source-menu"]') &&
        document.querySelector('[data-testid="env-compare-web"]',
    '[data-testid="env-pr-state"]');
      return ok ? 'ok' : 'no-links';
    })()
  `,
  /*
   * 派生到工作树之后的「接手上下文」草稿（实施-07 S2b-4）。
   *
   * 输入框里应该已经有一段标了来源、并写清「环境状态是在这个工作树**重算**的」的草稿 ——
   * 用户可以直接发、补一句、或删掉。这张图证的是它“长得不像一句模板”且与正常
   * 输入框共存正常；内容正确性（分支来自目标工作树、没有自动发送）由 `gitwrite` 断言管。
   */
  forkdraft: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      window.__yanStore.setState({ rightPanelOpen: false });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      st.injectComposerText([
        '[yan-fork-context:6b0f2c1e-7d31-4a55-9f80-2c1f4a7b8d90]',
        '这段上下文来自砚的工作树派生（Fork）：我从另一个会话派生到这条工作树上接手，不是同一条会话的继续 —— 源会话的对话历史没有带过来。需要哪一段直接说，我按需去读源会话文件，不要凭印象复述。',
        '',
        '当前工作树的状态（接手时在目标目录重新读的，不是从源会话抄来的）：',
        '- 目录：C:/work/pi-desktop-worktrees/git-review（仓库 pi-desktop）',
        '- 分支：feat/git-review @ a1b2c3d4，相对 upstream +2/-1 个提交',
        '- 工作区：3 个未提交变更',
        '- 来源会话：sess-src（原工作目录 C:/work/pi-desktop）',
        '',
        '源会话里提到过的文件在这个工作树里的对照：共 3 个，2 个能对上；对不上的：',
        '- src/main/worktree-links.ts（这个工作树里没有）',
        '',
        '源会话里有 1 个图片附件没有带过来（附件不迁移）。需要哪张就在新会话里重新添加/截图发给我 —— 不要去猜它们的内容。',
        '',
        '上一个会话没有留下交接包：只有上面这些（工作树状态 + 文件对照）。缺什么直接问。',
        '',
        '按上面的定位继续推进：不要重新确认已经确认过的信息、不要重做已经完成的部分。'
      ].join('\\n'));
      await sleep(250);
      /*
       * 滚到草稿尾部：输入框高度有限，而这张图要证明的是**正文里写了什么**
       * （文件对照、附件不迁移、没有交接包那几行在靠后的位置）。先 focus 再设 scrollTop ——
       * focus 会把光标放到末尾并可能重置滚动。
       */
      const el = document.querySelector('[data-testid="composer"]');
      if (el) {
        el.focus();
        el.scrollTop = el.scrollHeight;
      }
      return 'ok';
    })()
  `,
  envworktrees: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      await sleep(300);
      /*
 * 菜单是**开关**：组内前一个状态可能把它留着开着，再点一次就关上了。
 * 所以先看它开没开 —— 幂等。
 */
if (!document.querySelector('[data-testid="env-menu"]')) {
      document.querySelector('[data-testid="session-project"]')?.click();
      await sleep(500);
}
      /*
       * 当前会话 id 固定成 stub 那条（worktreeLinks 的桩按它返回）——
       * 否则「这个会话从哪来」那一行永远不会出现，图里也就看不见它。
       */
      window.__yanStore.setState({
        session: { ...window.__yanStore.getState().session, sessionId: 'sess-1' }
      });
      document.querySelector('[data-testid="env-worktrees"]')?.click();
      await sleep(700);
      return document.querySelector('[data-testid="env-worktree-list"]') ? 'ok' : 'no-worktrees';
    })()
  `,
  review: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: true });
      /* 上两个状态可能留着环境菜单（它是组件内部 state，不随 store 复位），
         不关掉就会盖在审查面板上 —— 实测就这么截出过一张“菜单图”。 */
      const btn = document.querySelector('[data-testid="session-project"]');
      if (btn && btn.getAttribute('aria-expanded') === 'true') btn.click();
      await sleep(200);
      st.openReview({ kind: 'working' });
      /* 等清单 + 前几个文件的 patch（懒加载是两次 IPC 往返） */
      await sleep(1200);
      /* 标记第一个文件为已查看：进度条与已查看态都要进证据 */
      document.querySelector('[data-testid="review-viewed"]')?.click();
      await sleep(400);
      return document.querySelector('[data-testid="review-diff"]') ? 'ok' : 'no-diff';
    })()
  `,
  /*
   * 子代理委派（2026-09-19）：输入区上方的显式入口 + 展开的任务面板。
   *
   * 这一态要验的是「能力能被发现」：按钮、面板、只读开关、说明与两个动作
   * 都在一屏内 —— 不需要真起子进程（真链路证据在 live 的 `subagent` /
   * `subagentmodel` 两个场景）。
   */
  subagentlaunch: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      /* 上两态可能留着环境菜单（组件内部 state，不随 store 复位） */
      const menu = document.querySelector('[data-testid="session-project"]');
      if (menu && menu.getAttribute('aria-expanded') === 'true') menu.click();
      window.__yanStore.setState({ rightPanelOpen: true, subagents: [], subagentPreviewId: null });
      await sleep(200);
      const btn = document.querySelector('[data-testid="subagent-new"]');
      if (!btn) return 'no-launcher';
      if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
      await sleep(300);
      const ta = document.querySelector('[data-testid="subagent-task"]');
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '把登录流程的错误分支补上测试并跑一遍');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(250);
      return document.querySelector('[data-testid="subagent-start"]') ? 'ok' : 'no-panel';
    })()
  `,
  /*
   * 一条运行中的子代理详情：任务 + 实时转录 + 工具活动 + 变更审阅摘要。
   * 数据是造的（不真起子进程）—— 这一张验的是信息层次与布局，
   * 不要拿它当「子代理真的在跑」的证据（那是 live 场景的事）。
   */
  subagent: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      const menu = document.querySelector('[data-testid="session-project"]');
      if (menu && menu.getAttribute('aria-expanded') === 'true') menu.click();
      /* 上一态（subagentlaunch）把委派面板留着开着 —— 它升在消息流上，不关就遮住详情卡 */
      const launch = document.querySelector('[data-testid="subagent-new"]');
      if (launch && launch.getAttribute('aria-expanded') === 'true') launch.click();
      const startedAt = Date.now() - 42_000;
      window.__yanStore.setState({
        rightPanelOpen: true,
        subagentPreviewId: 'sub-preview',
        subagents: [{
          id: 'sub-preview',
          task: '把登录流程的错误分支补上测试并跑一遍',
          cwd: 'C:/yan-worktrees/sub-preview',
          parentSessionId: 'session-preview',
          parentRunId: 'run-preview',
          isolation: 'worktree',
          model: 'deepseek/deepseek-v4.1-flash',
          status: 'running',
          startedAt,
          latestActivity: '正在读 src/auth/login.ts',
          review: 'pending',
          diff: {
            files: 2,
            additions: 48,
            deletions: 6,
            paths: ['src/auth/login.ts', 'test/login.test.ts'],
            truncated: false
          },
          transcript: [
            { id: 'sub-t1', role: 'user', text: '把登录流程的错误分支补上测试并跑一遍' },
            {
              id: 'sub-t2',
              role: 'assistant',
              text: '我先读一遍现有实现，确认错误码分支的覆盖情况，再补测试。',
              thinking: '先看 login.ts 的失败分支，再对照现有测试找出缺口。',
              toolCalls: [
                { id: 'sub-c1', name: 'read', status: 'done' },
                { id: 'sub-c2', name: 'bash', status: 'running' }
              ]
            }
          ]
        }]
      });
      await sleep(400);
      return document.querySelector('[data-testid="subagent-preview"]') ? 'ok' : 'no-detail';
    })()
  `,
  /* 模型触发的子代理：卡片必须出现在触发它的助手回合内，且不抢开右栏详情。 */
  subagentinline: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      const host = st.messages.find((message) => message.role === 'assistant');
      if (!host) return 'no-assistant';
      window.__yanStore.setState({
        rightPanelOpen: false,
        subagentPreviewId: null,
        subagents: [{
          id: 'sub-inline-preview',
          task: '检查登录失败分支并把测试结果带回当前回合',
          cwd: 'C:/yan-worktrees/sub-inline',
          parentSessionId: 'session-preview',
          parentRunId: 'run-preview',
          parentMessageId: host.id,
          isolation: 'worktree',
          model: 'deepseek/deepseek-v4.1-flash',
          status: 'running',
          startedAt: Date.now() - 18_000,
          latestActivity: '正在检查登录失败分支',
          review: 'none',
          transcript: [
            { id: 'sub-inline-t1', role: 'assistant', text: '我会把结果直接带回当前助手回合。' }
          ]
        }]
      });
      await sleep(400);
      return document.querySelector('[data-testid="subagent-inline-list"]') && document.querySelector('[data-testid="subagent-inline-sub-inline-preview"]')
        ? 'ok'
        : 'no-inline-card';
    })()
  `,
  /*
   * 子代理「模型自己失败」的形态（实施-09 S2 第六批）。
   *
   * 与上一态只差 status/error 两处，但正是用户看得见的那两处：列表行变 ✕、
   * 详情卡状态写「失败」、meta 行多一段红字的原因。真实链路证据在 live 的
   * `subagentfail`（那里用坏模型名真跑了一次）。
   */
  subagentfailed: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      st.closeReview?.();
      const launch = document.querySelector('[data-testid="subagent-new"]');
      if (launch && launch.getAttribute('aria-expanded') === 'true') launch.click();
      const startedAt = Date.now() - 96_000;
      window.__yanStore.setState({
        rightPanelOpen: true,
        subagentPreviewId: 'sub-failed',
        subagents: [{
          id: 'sub-failed',
          task: '把登录流程的错误分支补上测试并跑一遍',
          cwd: 'C:/yan-worktrees/sub-failed',
          parentSessionId: 'session-preview',
          parentRunId: 'run-preview',
          isolation: 'worktree',
          model: 'deepseek/deepseek-v4.1-flash',
          status: 'error',
          startedAt,
          endedAt: startedAt + 96_000,
          latestActivity: '模型返回错误',
          review: 'none',
          error: '模型返回错误（这一轮没有产出可用结果）',
          transcript: [
            { id: 'sub-f1', role: 'user', text: '把登录流程的错误分支补上测试并跑一遍' },
            { id: 'sub-f2', role: 'assistant', text: '', error: '模型返回错误' }
          ]
        }]
      });
      await sleep(400);
      return document.querySelector('.sp-err') ? 'ok' : 'no-err';
    })()
  `,
  /*
   * 额度三档配色（<70 绿 / 70–95 黄 / ≥95 红）。
   * 数据来自上面对 `commandcode` 的桩；这里只把会话的 provider 换成它，
   * 剩下的查询与渲染跟真实额度完全同路。
   */
  quotatone: `
    (async () => {
      try {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const st = window.__yanStore.getState();
        st.closeSettings();
        st.setRailPinned(true);
        window.__yanStore.setState({ rightPanelOpen: true, filePreview: null });
        const s = window.__yanStore.getState().session;
        window.__yanStore.setState({
          session: {
            ...(s ?? {}),
            sessionId: s?.sessionId ?? 'matrix-quota',
            thinkingLevel: s?.thinkingLevel ?? 'medium',
            availableThinkingLevels: s?.availableThinkingLevels ?? [],
            isStreaming: false,
            isCompacting: false,
            model: { provider: 'commandcode', id: 'matrix/quotatone' }
          }
        });
        for (let i = 0; i < 40; i++) {
          if (document.querySelector('[data-testid="quota-win-monthly-reached"]')) {
            /*
             * 不只看类名：把三档的实际颜色与设计令牌对一下（--ok / --warn / --err）。
             * 类名对、颜色没变（比如令牌被覆盖）的回归不能靠肉眼在 1440px 截图上发现。
             */
            const cssVar = (name) => {
              const probe = document.createElement('span');
              probe.style.color = 'var(' + name + ')';
              document.body.appendChild(probe);
              const v = getComputedStyle(probe).color;
              probe.remove();
              return v;
            };
            const colorOf = (testid) => {
              const el = document.querySelector('[data-testid="' + testid + '"]');
              return el ? getComputedStyle(el).color : 'missing';
            };
            const got = {
              low: colorOf('quota-win-fiveHour-pct'),
              mid: colorOf('quota-win-weekly-pct'),
              high: colorOf('quota-win-monthly-pct'),
              main: colorOf('quota-main-value')
            };
            const want = { low: cssVar('--ok'), mid: cssVar('--warn'), high: cssVar('--err'), main: cssVar('--err') };
            if (got.low !== want.low || got.mid !== want.mid || got.high !== want.high || got.main !== want.main) {
              return 'bad-colors:' + JSON.stringify({ got, want });
            }
            return 'ok';
          }
          await sleep(120);
        }
        const panel = document.querySelector('[data-testid="rp-quota"]');
        return 'no-quota-windows:' + (panel ? panel.textContent.slice(0, 120) : 'no-panel');
      } catch (e) {
        return 'error:' + (e && (e.message || String(e)));
      }
    })()
  `
}

/** 每个状态要顺带核对的元素（截图的图不能是空的） */
const MUST_HAVE = {
  /* 主界面（注意：fixture 里会话是「流式中」，所以这里不会出现「用时」——
     用时的视觉证据在 usageelapsed 状态里） */
  main: ['.rail', '.stream', '.composer, [data-testid="composer"]'],
  rightwindows: [
    '[data-testid="right-window-tabs"]',
    '[data-testid="right-window-tab-tools"]',
    '[data-testid="right-window-tab-browser"]',
    '[data-testid="right-window-tab-file"]',
    '[data-testid="review-tab"]',
    '[data-testid="review-panel"]'
  ],
  artifact: ['.stream', '[data-testid="turn-artifacts"]', '[data-artifact-id="matrix-artifact-svg"]', '.artifact-image', '.artifact-download'],
  imageprogress: ['.stream', '[data-testid="image-progress-list"]', '.image-progress[data-stage="generating"]', '.image-progress-track'],
  /* 自主模式：数据属性是探针/检查的钩子，光带本身在现场看（§4.2） */
  autonomous: ['[data-testid="composer"]', '.composer-wrap[data-autonomous="1"]', '[data-testid="work-mode-button"][data-mode="autonomous"]'],
  /* 自主 + 任务在跑（N10）：光带在，且输入框那个键已经变成「停止」形态 */
  autonomousrunning: ['.composer-wrap[data-autonomous="1"]', '[data-testid="send"].abort', '[data-testid="work-mode-button"][data-mode="autonomous"]'],
  workmodemenu: ['[data-testid="work-mode-button"][data-mode="clarify"]', '[data-testid="work-mode-menu"]', '[data-testid="work-mode-option-autonomous"]'],
  modelmenu: ['[data-testid="model-picker"]', '[data-testid="model-menu"]'],
  toolgroup: ['.tgroup.open'],
  toolterm: ['.trow.open .term'],
  reasoning: ['[data-testid="reasoning-toggle"]'],
  settings: ['.settings'],
  capabilities: ['.settings', '[data-testid="set-capabilities"]', '[data-testid="cap-strategy"]', '[data-testid="cap-mcp-server"]'],
  capabilitiesmcp: ['.settings', '[data-testid="cap-skills"]', '[data-testid="cap-mcp"]', '[data-testid="cap-mcp-server"]'],
  knowledgetab: [
    '.settings',
    '[data-testid="kn-toggle"]',
    '[data-testid="kn-filter"]',
    '[data-testid="kn-item-k-demo0001"]',
    '[data-testid="kn-review-k-demo0001"]',
    '[data-testid="kn-export-copy"]'
  ],
  ctxsettings: ['.settings', '[data-testid="ctx-source"]', '[data-testid="ctx-cap"]', '[data-testid="ctx-preset"]', '[data-testid="ctx-fold"]', '[data-testid="ctx-deep"]'],
  railmini: ['[data-testid="rail-toggle"]'],
  chainjoin: ['[data-testid="rail-session"]', '.stream'],
  quotatone: [
    '[data-testid="rp-quota"]',
    '[data-testid="quota-win-fiveHour-pct"]',
    '[data-testid="quota-win-weekly-pct"]',
    '[data-testid="quota-win-monthly-pct"]',
    '[data-testid="quota-main-value"]'
  ],
  railsessions: ['[data-testid="rail-more-sessions"]', '[data-testid="rail-session"]'],
  /* 实施-09 S2：后台会话在等输入的 `?` 槽、以及与失败槽（第四批） */
  railwaiting: ['[data-testid="rail-session"]', '[data-testid="rail-waiting"]', '[data-testid="rail-failed"]'],
  pendingcards: ['[data-testid="queue-pending"]', '[data-testid="pending-steer"]', '[data-testid="pending-follow"]'],
  envmenu: ['[data-testid="env-menu"]', '[data-testid="env-changes"]', '[data-testid="env-pr"]', '[data-testid="env-compare"]'],
  envbranches: [
    '[data-testid="env-menu"]',
    '[data-testid="env-branches"]',
    '[data-testid="env-branch-item"]',
    '[data-testid="env-new-branch-name"]',
    '[data-testid="env-fetch"]',
    '[data-testid="env-push"]'
  ],
  sourcesearch: [
    '[data-testid="env-menu"]',
    '[data-testid="env-source-menu"]',
    '[data-testid="src-websearch"]',
    '[data-testid="src-search-query"]',
    '[data-testid="src-search-run"]',
    /* 入口与手工添加网址同时在场：这就是「有搜索能力时长什么样」 */
    '[data-testid="src-url"]'
  ],
  settingspkg: [
    '[data-testid="set-packages"]',
    '[data-testid="set-pi-catalog"]',
    '[data-testid="set-pi-catalog-open"]',
    '[data-testid="pkg-source"]',
    '[data-testid="pkg-install-btn"]',
    '[data-testid="pkg-effect"]',
    /* 实施-02 S4：内置能力区必须与「已装的插件」同时出现在图上 */
    '[data-testid="set-builtin-caps"]',
    '[data-testid="builtin-cap"]'
  ],
  envlinks: [
    '[data-testid="env-menu"]',
    '[data-testid="env-source-menu"]',
    '[data-testid="src-list"]',
    '[data-testid="src-url"]',
    '[data-testid="env-compare-web"]',
    /* 实施-07 S3：有落盘关联的来源必须带「定位消息」入口。缺了这张图就没意义 */
    '[data-testid="src-locate"]'
  ],
  extdiag: ['[data-testid="rp-log"]', '[data-testid="log-body"]'],
  taskhost: [
    '[data-testid="rp-todo"]',
    '[data-testid="todo-meter"]',
    '[data-testid="todo-history"]',
    '[data-testid="todo-history-toggle"]'
  ],
  /* 内置来源的工具卡（S4）：徐标 + 原始命令都在 */
  taskcard: ['[data-testid="tool-src"]', '.trow.open .term'],
  envworktrees: [
    '[data-testid="env-menu"]',
    '[data-testid="env-worktree-list"]',
    '[data-testid="env-worktree-remove"]',
    '[data-testid="env-worktree-branch"]',
    '[data-testid="env-worktree-create"]',
    '[data-testid="env-worktree-path"]',
    /* 实施-07 S2：「这个会话从哪来」必须画得出来，缺了这张图就没意义 */
    '[data-testid="env-worktree-origin"]'
  ],
  reviewwrite: [
    '[data-testid="review-panel"]',
    '[data-testid="review-stage"], [data-testid="review-unstage"]',
    '[data-testid="commit-bar"]',
    '[data-testid="commit-message"]',
    '[data-testid="commit-submit"]'
  ],
  /* 非 Git 目录：两张图各自的关键元素（菜单走了 env-notgit 分支 / 面板说了原因） */
  envnotgit: ['[data-testid="env-menu"]', '[data-testid="env-notgit"]', '.env-sub'],
  reviewnotgit: ['[data-testid="review-panel"]', '[data-testid="review-notgit"]', '[data-testid="review-scope"]'],
  review: [
    '[data-testid="review-panel"]',
    '[data-testid="review-tab"]',
    '[data-testid="review-scope"]',
    '[data-testid="review-stats"]',
    '[data-testid="review-diff"]',
    '[data-testid="review-tree"]',
    '[data-testid="review-progress"]',
    '[data-testid="review-viewed"]'
  ],
  compaction: [
    '[data-testid="rp-context"]',
    '[data-testid="ctx-compacting-reason"]',
    '[data-testid="ctx-last-compaction"]',
    '[data-testid="ctx-last-compaction-error"]',
    '[data-testid="ctx-project-ignored"]'
  ],
  browserboundary: [
    '[data-testid="browser-surface"]',
    '[data-testid="browser-blocked"]',
    '[data-testid="browser-permissions"]'
  ],
  browserblocked: [
    '[data-testid="browser-surface"]',
    '[data-testid="browser-blocked-hint"]',
    '[data-testid="browser-download"]'
  ],
  fsnarrow: ['[data-testid="rightpanel"]', '[data-testid="rp-files"]'],
  wschanges: ['[data-testid="workspace-changes"]', '[data-testid="ws-title"]'],
  wsunknown: ['[data-testid="workspace-changes"]', '[data-testid="ws-unknown"]'],
  ctxnarrow: ['[data-testid="rp-context-actions"]', '[data-testid="rp-compact-now"]', '[data-testid="ctx-stages"]'],
  trashtoast: ['[data-testid="trash-notice"]', '[data-testid="trash-undo"]', '.rail-trash-name', '.srow'],
  fileincontext: ['[data-testid="fs-tree"]', '[data-testid="file-preview"]', '[data-testid="fs-inctx-src/main/agent.ts"]', '[data-testid="composer"]'],
  usageelapsed: [
    '[data-testid="usagebar"]',
    '[data-testid="ub-elapsed"]',
    '.usagebar .ub-item',
    '[data-testid="composer"]'
  ],
  usageturn: [
    '[data-testid="usagebar"]',
    '.usagebar .ub-live',
    '.usagebar .ub-item',
    '[data-testid="composer"]'
  ],
  contextbudget: [
    '[data-testid="ctx-stages"]',
    '[data-testid="ctx-stage-mark"]',
    '[data-testid="ctx-next-stage"]',
    '[data-testid="ctx-working-set"]'
  ],
  /* 子代理委派：入口 + 展开的任务面板（面板里四个元素缺一这张图就没有意义） */
  subagentlaunch: [
    '[data-testid="subagent-new"]',
    '[data-testid="subagent-launch-panel"]',
    '[data-testid="subagent-task"]',
    '[data-testid="subagent-readonly"]',
    '[data-testid="subagent-start"]'
  ],
  /* 运行中的子代理详情：任务、转录、变更审阅摘要都要在图里 */
  subagent: [
    '[data-testid="subagent-preview"]',
    '[data-testid="subagent-preview-body"]',
    '[data-testid="subagent-review"]',
    '.sp-main'
  ],
  subagentinline: [
    '[data-testid="subagent-inline-list"]',
    '[data-testid="subagent-inline-sub-inline-preview"]',
    '.subagent-inline-task'
  ],
  /* 失败态：状态写成失败、meta 行带原因、紧凑列表那一行也在 */
  subagentfailed: [
    '[data-testid="subagent-preview"]',
    '.sp-state.error',
    '.sp-err',
    '[data-testid="subagent-sub-failed"]'
  ],
  /* 拖拽中的视觉：被拖行 + 目标行上的插入线必须都在，否则这张图没意义 */
  railreorder: [
    '.rail',
    '[data-testid="rail-project-row"]',
    '.is-dragging',
    '.drop-before, .drop-after'
  ]
}

/** 截完图要做的复位（目前只有：把为拍模型菜单而放空的“忙”状态改回去） */
const AFTER_STATE = {
  /*
   * 把 `railwaiting` 注入的假实例撤走：同一组后面的状态（以及下一次跑整组）
   * 不该看到一个并不存在的会话在等输入。
   */
  railwaiting: `
    (() => {
      window.__yanStore.setState({ runners: [] });
      return 'ok';
    })()
  `,
  modelmenu: `
    (() => {
      const st = window.__yanStore.getState();
      window.__yanStore.setState({ session: { ...st.session, isStreaming: true } });
      document.querySelectorAll('[data-testid="model-picker"]').forEach((b) => b.click());
      return 'ok';
    })()
  `,
  /*
   * 自主模式必须在同组里关掉：它会在后续每张图的输入框边框上留下光带
   *（同一组共用同一个窗口）。实施-05 起模式在 store 的 `workMode` 上。
   */
  autonomous: `
    (() => {
      window.__yanStore.setState({ workMode: null });
      return 'ok';
    })()
  `,
  /* 收尾：把 `autonomousrunning` 注入的假实例与模式都撤走（同一组共用窗口） */
  autonomousrunning: `
    (() => {
      window.__yanStore.setState({ workMode: null, runners: [], activeRunnerId: null });
      return 'ok';
    })()
  `,
  /*
   * 非 Git 的两张图都要把 cwd 还原：`session.cwd` 是同一组共用窗口上的全局状态，
   * 不复位会让后面每张图都跟着显示成非 Git。菜单 / 审查面板也顺手关掉。
   */
  envnotgit: `
    (() => {
      const btn = document.querySelector('[data-testid="session-project"]');
      if (btn && btn.getAttribute('aria-expanded') === 'true') btn.click();
      return 'ok';
    })()
  `,
  reviewnotgit: `
    (() => {
      window.__yanStore.getState().closeReview?.();
      return 'ok';
    })()
  `,
  /* 菜单展开状态也要复位：后面的图不能让浮层挡着 */
  workmodemenu: `
    (() => {
      window.__yanStore.setState({ workMode: null });
      /* 组件自己监听 document mousedown 关菜单 —— 模拟一次点外部，
         而不是直接移 DOM（浮层由 React 管，手拆会与它的状态不一致） */
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return 'ok';
    })()
  `,
  /*
   * 压缩态把 isCompacting 置 true，而「忙」时模型 picker 是 disabled ——
   * 不复位的话，同一组里**排在后面**的状态会点不开菜单（实测踩过同类问题）。
   */
  compaction: `
    (() => {
      const st = window.__yanStore.getState();
      window.__yanStore.setState({
        session: { ...st.session, isCompacting: false, compaction: undefined, lastCompaction: undefined }
      });
      const toggle = document.querySelector('[data-testid="ctx-details-toggle"]');
      if (toggle && toggle.getAttribute('aria-expanded') === 'true') toggle.click();
      return 'ok';
    })()
  `,
  /*
   * 拖拽截完必须**取消**而不是松手：松手会把这次拖拽真的提交，
   * 后续状态的左栏顺序就跟着变（截图之间互相干扰）。
   * Esc 是产品里真有的取消出口，顺便把它也走一遍。
   * 造出来的分组/项目不清 —— railreorder 在组内排最后，不会串到别的图。
   */
  railreorder: `
    (() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'ok';
    })()
  `
}

/**
 * 采集几何：横向溢出是最常见的窄/矮窗口缺陷，直接当断言。
 * 同时统计关键元素是否真的在视口里（截图一片空白时能立刻看出来）。
 */
const probeGeometry = (selectors) => `
  (() => {
    const d = document.documentElement;
    const list = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
    };
    const sels = ${JSON.stringify(selectors)};
    return {
      sw: d.scrollWidth, cw: d.clientWidth, sh: d.scrollHeight, ch: d.clientHeight,
      uiScale: window.__yanStore.getState().settings?.uiScale ?? null,
      theme: document.documentElement.dataset.theme || '',
      boxes: Object.fromEntries(sels.map((sel) => [sel, list(sel)])),
      must: Object.fromEntries(sels.map((sel) => [sel, !!document.querySelector(sel)]))
    };
  })()
`

/** 只跑某些状态（调脚本时用）：`YAN_MATRIX_ONLY=modelmenu` */
const ONLY = (process.env.YAN_MATRIX_ONLY ?? '').split(',').filter(Boolean)

/*
 * 只跑某几组（下标，逗号分隔）：`YAN_MATRIX_GROUP=0,2`。
 *
 * 为什么要能拆：这台机器上跑满 7 组时，后半程会出现
 * `Network service crashed` / `GPU process exited unexpectedly`，
 * 脚本停住不动。拆成一组一个进程既不会长时间持有合成器，
 * 也方便失败后只重跑那一组。
 */
const GROUP_ONLY = (process.env.YAN_MATRIX_GROUP ?? '')
  .split(',')
  .filter(Boolean)
/* 引导组也算一组（用名字）：`YAN_MATRIX_GROUP=onboarding` */
const WANT_ONBOARDING = GROUP_ONLY.length === 0 || GROUP_ONLY.includes('onboarding')

async function main() {
  /*
   * 截图/测量脚本**故意**不注册拉取型 IPC（返回空值会覆盖 fixture 注入的 store）：
   * Electron 会把每次失败调用刷成一整段堆栈，既是这次 EPIPE 事故里被淹没的
   * “原始错误”，也会把真错误顶出屏幕。这里显式静音并计数（结尾汇总），
   * 其余 console.error 原样透传。
   */
  muteMissingHandlerNoise()
  registerStubHandlers()
  await app.whenReady()
  await writeFile(
    MATRIX_ARTIFACT_SVG_PATH,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="32" fill="#16171a"/><path d="M31 31h46c11 0 20 9 20 20v26c0 11-9 20-20 20H51c-11 0-20-9-20-20V51c0-11 9-20 20-20Z" fill="none" stroke="#f4f1e9" stroke-width="12"/><circle cx="87" cy="38" r="9" fill="#4fc3f7"/></svg>',
    'utf8'
  )

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    frame: false,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      /* 产物是 .cjs：sandboxed preload 不支持 ESM（见 electron.vite.config.ts） */
      preload: join(root, 'out/preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      /*
       * 关掉后台节流。
       *
       * 默认情况下窗口被遮住/不在前台时，渲染进程不再出帧 ——
       * `capturePage()` 于是会一直等一张永远不来的画面，
       * 表现成“脚本停在那里、什么也不打印”（实测踩过）。
       */
      backgroundThrottling: false
    }
  })
  await win.loadFile(join(root, 'out/renderer/index.html'))
  await win.webContents.executeJavaScript(`
    try {
      localStorage.setItem('yan.theme', 'dark');
      localStorage.setItem('yan.lang', 'zh-CN');
      localStorage.setItem('yan.onboarded', '1');
      localStorage.setItem('yan.termSize', JSON.stringify({ h: 260, w: 0 }));
    } catch {}
  `)
  await win.webContents.reload()

  /* 等字体栅格就绪（Maple），否则汉字会回退成别的字体：截图证据就不可比了。
     带超时兜底：`document.fonts.ready` 在字体加载失败时可能永不 resolve，
     而这里卡住的表现是“什么也不打印”，极难当场看出原因（实测踩过一次）。 */
  let cnWidth = await win.webContents.executeJavaScript(`
    Promise.race([
      document.fonts.ready.then(() => {
        const el = document.createElement('span');
        el.style.cssText = 'position:fixed;visibility:hidden;font:12.5px "Maple Mono CN"';
        el.textContent = '国';
        document.body.appendChild(el);
        const w = el.getBoundingClientRect().width;
        el.remove();
        return w;
      }),
      new Promise((r) => setTimeout(() => r(-1), 5000))
    ])
  `)

  const fixture = await readFile(join(root, 'scripts/shot-fixture.js'), 'utf8')
  const injected = await win.webContents.executeJavaScript(fixture)
  if (injected !== 'ok') throw new Error('fixture 注入失败: ' + injected)
  await wait(700)

  const failures = []
  const shot = async (name, geometry) => {
    /* 再等两帧 + 一点时间：确保这次变更已经画出来（否则截到上一态） */
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
    )
    /*
     * 再显式要一次重绘。为什么需要：trashtoast 那张图实测**DOM 里有通知条、
     * elementFromPoint 也命中它，但截图里没有** —— 窗口不在前台时合成器可能停在
     * 上一帧（等 rAF 只保证脚本侧排过队，不保证真的出帧）。
     * invalidate() 只影响画面、不改布局，对所有状态都安全。
     */
    win.webContents.invalidate()
    await wait(220)
    const outPath = join(outDir, name)
    await mkdir(dirname(outPath), { recursive: true })
    /* capturePage 也可能挂住（窗口被遮、合成器不给帧）—— 给个上限，别卡死整个矩阵 */
    const img = await Promise.race([
      win.webContents.capturePage(),
      new Promise((r) => setTimeout(() => r(null), 8000))
    ])
    if (!img) {
      failures.push(`${name}（截图超时）`)
      console.log(`  ✗ ${name}  截图超时（窗口可能被遮住）`)
      return geometry
    }
    await writeFile(outPath, img.toPNG())
    const over = geometry.sw - geometry.cw
    const missing = Object.entries(geometry.must)
      .filter(([, okFlag]) => !okFlag)
      .map(([sel]) => sel)
    const good = over <= 1 && missing.length === 0
    if (!good) failures.push(`${name}（溢出 ${over}px${missing.length ? '，缺 ' + missing.join(',') : ''}）`)
    console.log(
      `  ${good ? '✓' : '✗'} ${name}  溢出=${over}px  缩放=${geometry.uiScale}  主题=${geometry.theme}` +
        (missing.length ? `  缺=${missing.join(',')}` : '')
    )
    return geometry
  }

  const applyScale = async (scale) => {
    await win.webContents.executeJavaScript(`
      (() => {
        const st = window.__yanStore.getState();
        const projects = Array.isArray(st.settings?.projects) ? st.settings.projects : [];
        window.__yanStore.setState({ settings: { ...st.settings, uiScale: ${scale}, projects } });
        return 'ok';
      })()
    `)
    await wait(220)
  }

  for (const [gi, g] of GROUPS.entries()) {
    if (GROUP_ONLY.length && !GROUP_ONLY.includes(String(gi))) continue
    const size = `${g.w}x${g.h}`
    const pct = Math.round(g.scale * 100)
    console.log(`\n▶ ${size} @ ${pct}% ${g.theme}`)
    win.setSize(g.w, g.h)
    await wait(260)
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${g.theme}'`)
    await applyScale(g.scale)

    for (const state of g.states) {
      if (ONLY.length && !ONLY.includes(state)) continue
      /* 非 Git 状态切换主进程的 Git 桩（见 NON_GIT_STUB_CWD 的注释） */
      stubNonGit = NON_GIT_STATES.has(state)
      console.log(`  · ${state}`)
      /*
       * 模型菜单需要先把“忙”放开（picker 在忙时 disabled）。
       * 必须**分两次** executeJavaScript：setState 到 DOM 反映要等 React 重渲染，
       * 在同一次调用里紧接着读 `btn.disabled` 拿到的还是旧值（实测踩过）。
       */
      if (state === 'modelmenu') {
        await win.webContents.executeJavaScript(`
          (() => {
            const st = window.__yanStore.getState();
            window.__yanStore.setState({ session: { ...st.session, isStreaming: false, isCompacting: false } });
            return 'ok';
          })()
        `)
        await wait(350)
      }
      const res = await win.webContents.executeJavaScript(STATES[state])
      if (!String(res).startsWith('ok')) failures.push(`${size}@${pct} ${state}: 状态脚本返回 ${res}`)
      if (String(res) !== 'ok') console.log(`    （${state} 状态脚本：${res}）`)
      await wait(420)
      if (state === 'capabilitiesmcp') {
        await win.webContents.executeJavaScript(`
          (() => {
            const body = document.querySelector('.settings-body');
            if (!body) return 'no-settings-body';
            body.scrollTop = body.scrollHeight;
            return 'scrolled';
          })()
        `)
        await wait(220)
      }
      const geometry = await win.webContents.executeJavaScript(probeGeometry(MUST_HAVE[state] ?? []))
      await shot(`matrix-${state}-${size}-${pct}-${g.theme}-${STAMP}.png`, geometry)
      if (AFTER_STATE[state]) await win.webContents.executeJavaScript(AFTER_STATE[state])
    }
  }

  /* ---- 首次引导（N20）：单独一轮（拆组调试时只有显式要它才跑） ---- */
  if (!WANT_ONBOARDING) {
    console.log('\n（指定了 YAN_MATRIX_GROUP，且不含 onboarding：跳过引导组）')
  } else {
  /*
   * 自动弹的入口在 App 里：`if (window.yan.isProbe) return`（探针模式不弹）。
   * 这里不是探针模式，但隔离环境里 bootstrap 拿不到设置，弹不弹取决于时序；
   * 为了截图稳定，走「关于页 → 查看首次引导」这条**真实存在**的入口，
   * 渲染出来的引导层与首次启动时是同一个组件。
   */
  await win.webContents.executeJavaScript(`try { localStorage.removeItem('yan.onboarded') } catch {}`)
  await win.webContents.reload()
  await wait(600)
  await win.webContents.executeJavaScript(fixture)
  await wait(700)
  const onboardingHow = await win.webContents.executeJavaScript(`
    (() => {
      const st = window.__yanStore.getState();
      st.openSettings('about');
      return 'opened-about';
    })()
  `)
  await wait(600)
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('[data-testid="ob-reopen"]');
      if (btn) btn.click();
      return btn ? 'clicked' : 'no-reopen-button';
    })()
  `)
  await wait(700)
  const onboardingShown = await win.webContents.executeJavaScript(
    `!!document.querySelector('[data-testid="onboarding"]')`
  )
  console.log(`\n引导层：${onboardingHow}，显示=${onboardingShown}`)

  for (const g of ONBOARDING_GROUPS) {
    const size = `${g.w}x${g.h}`
    console.log(`\n▶ onboarding ${size} ${g.theme}`)
    win.setSize(g.w, g.h)
    await wait(260)
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${g.theme}'`)
    await wait(500)
    const geometry = await win.webContents.executeJavaScript(`
      (() => {
        const d = document.documentElement;
        const primary = document.querySelector('[data-testid="onboarding-primary"], .ob-primary, button');
        return {
          sw: d.scrollWidth, cw: d.clientWidth, sh: d.scrollHeight, ch: d.clientHeight,
          uiScale: window.__yanStore.getState().settings?.uiScale ?? null,
          theme: document.documentElement.dataset.theme || '',
          must: { '引导层': !!document.querySelector('[data-testid="onboarding"]'), '主按钮': !!document.querySelector('[data-testid="ob-done"], .ob-btn') }
        };
      })()
    `)
    await shot(`matrix-onboarding-${size}-100-${g.theme}-${STAMP}.png`, geometry)
  }
  }

  cnWidth = Number(cnWidth)
  console.log(`\n${'='.repeat(64)}`)
  console.log(
    cnWidth < 0
      ? '汉字格宽 = 测量超时（字体可能未加载）'
      : `汉字格宽 = ${cnWidth.toFixed(2)}px ${Math.abs(cnWidth - 15) < 0.01 ? '(Maple 已生效)' : '⚠️ 字体未生效'}`
  )
  if (failures.length) {
    console.log(`✗ ${failures.length} 项不通过：`)
    for (const f of failures) console.log('  · ' + f)
  } else {
    console.log('✓ 视觉矩阵通过（溢出与关键元素都正常）')
  }
  console.log(`截图目录：${outDir}`)
  /*
   * 结尾把静音掉的那类日志汇总一行。
   * 为什么不干脆丢掉：那些 handler 缺失是**故意**的（见 muteMissingHandlerNoise 注释），
   * 但它也能解释“某块界面没数据”—— 得留个可查的痕迹。
   */
  const noise = missingHandlerSummary()
  if (noise) {
    console.log(
      `预期内：截图脚本未注册 ${noise.names.length} 个数据型 IPC，Electron 报了 ${noise.total} 条「No handler registered」，已静音`
    )
  }
  app.exit(failures.length === 0 && Math.abs(cnWidth - 15) < 0.01 ? 0 : 1)
}

/*
 * 看门狗：这个脚本会真的开窗口，如果卡在某个 executeJavaScript 上，
 * 外层只能看到“什么也不输出”——加一个自己的超时，把阶段信息带回终端。
 */
const watchdog = setTimeout(() => {
  console.error('✗ 视觉矩阵超时（10 分钟）——最后完成的阶段见上面的输出')
  app.exit(2)
}, 10 * 60_000)

main()
  .then(() => clearTimeout(watchdog))
  .catch((err) => {
    clearTimeout(watchdog)
    console.error('✗ 视觉矩阵失败：', err)
    app.exit(2)
  })
