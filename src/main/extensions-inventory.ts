/**
 * 「扩展来源」诊断：把**谁在给这个 pi 实例加东西**说清楚。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（实施-02 S1 的出口）
 * ══════════════════════════════════════════════════════════════════
 * 任务工具从「用户扩展提供」迁到「砚内置」的过渡期里，两种来源曾经同时存在：
 * 用户 `~/.pi/agent/extensions/` 里的旧扩展会被 pi 自动发现，而砚自己的薄层
 * 是 `--extension` 显式传入。01-S5 收口后，砚默认启动带 `--no-extensions`，
 * 用户目录仍只读列出但不再加载；来源清单继续保留，方便解释历史会话与独立
 * pi 终端之间的差异。
 *
 * 所以这个模块只做一件事：**如实列举来源**，不做任何修复动作。
 *
 * ── 边界（不能长成「插件管理器」）──
 * · 只 `readdir`，**不解析**扩展源码、不 import 它们、不改动它们；
 * · 不显示「已启用 / 已同步」这类没有依据的状态；
 * · 用户扩展**不删、不禁用**（AGENTS.md：不删用户已装的扩展）。
 *
 * 用户扩展的存在不等于砚默认启用：默认 runner 的启动参数由 01-S5 固定为
 * `--no-extensions` / `--no-skills`，独立 pi 终端仍由用户自己决定。
 */
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

/** pi 认的扩展文件后缀（`.ts` 由 pi 侧加载器转译，用户扩展常见就是它）。 */
const EXTENSION_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/i

export interface ExtensionExpectation {
  /** 用户扩展目录（`<PI_AGENT_DIR>/extensions`）。 */
  piDir: string
  /** 砚**显式**传给 pi 的薄层扩展路径（`--extension`）。 */
  yanThinPaths?: string[]
}

/**
 * 列出用户扩展目录里的条目名（文件按扩展名过滤，目录保留 —— 扩展可以是一个包目录）。
 *
 * 读不到目录（首次安装、便携版还没建）就是空清单：**这不是错误**，
 * 不能因为它去打扰用户，也不能把 IOException 当成「没有扩展」以外的结论。
 */
export function readUserExtensions(piDir: string): string[] {
  try {
    return readdirSync(join(piDir, 'extensions'), { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .filter((e) => e.isDirectory() || EXTENSION_FILE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * 生成诊断行（每行是一条可以直接进「日志」分区的文本）。
 *
 * 文案规则：说清**事实**与**后果**，不承诺砚做不到的事。
 * 尤其不能写「任务由内置任务计划维护」—— 那要等 S3 真的接管写入之后，
 * 现在宿主还只读不写（先写了就是撒谎，用户按这句话排障会被带偏）。
 */
export function extensionDiagnostics(opts: ExtensionExpectation): string[] {
  const user = readUserExtensions(opts.piDir)
  const thin = (opts.yanThinPaths ?? []).map((p) => basename(p)).filter(Boolean)
  const lines: string[] = []

  if (user.length) {
    lines.push(
      `[来源] 用户扩展 ${user.length} 项：${user.join('、')}` +
        `（砚默认启动使用 --no-extensions，不加载；不删除、不改写）`
    )
  } else {
    lines.push('[来源] 未检测到用户扩展（pi 的扩展目录是空的）')
  }

  lines.push(
    `[来源] 砚内置薄层 ${thin.length} 项：${thin.join('、') || '（无）'}` +
      `（显式传入；只承载宿主没有 CLI / RPC 等价物的生命周期钩子，不注册模型工具；交互提问走宿主 yan question ask，归档回读走 yan context recall）`
  )

  if (user.length) {
    /*
     * 只在真有用户扩展时说这段：它解释的是「升级目录里仍有旧文件，
     * 但砚默认 runner 不加载」的后果。
     *
     * 默认 runner 已经关掉用户扩展自动发现，所以这里不再暗示「两套路径
     * 同时写入」。需要说明的是：历史会话里的旧条目仍可读，宿主新任务计划
     * 写自己的日志，升级也不会反向改写旧数据。
     */
    lines.push(
      '[来源] 检测到用户扩展：砚默认启动不会加载它们（独立 pi 终端仍可自行加载）；' +
        '历史会话里的 `left-panel-tasks` 只读，砚内置任务计划写宿主日志（数据目录下的 task-plans），' +
        '不会覆盖或回写旧条目'
    )
  }

  return lines
}

/** 一条「受信内置能力」（砚随包分发，不是用户装的包）。 */
export interface BuiltinCapability {
  /**
   * 稳定 id —— 渲染端用它翻文案。
   *
   * 薄层扩展取文件名去后缀（`language.js` → `language`）；
   * 宿主服务 / CLI 能力用固定 id（任务计划是 `task-plan`，内置浏览器是 `browser`）。
   */
  id: string
  /** 实际加载的扩展文件名；宿主服务 / CLI 能力没有这一项。 */
  file?: string
}

/**
 * 砚自带的受信能力清单（实施-02 S4）。
 *
 * ── 为什么要跟用户装的包分开展示 ──
 * 「插件」页现在只列 pi 装的包，于是用户会以为任务的写入方是某个第三方包，
 * 或者反过来以为内置能力也能卸载。两者必须分开：内置能力**随砚分发**、
 * 没有卸载按钮、也不是从 pi 的包目录加载的。
 *
 * ── 清单来自「实际加载路径」而不是另写一份 ──
 * 传入的是主进程真正传给 pi 的 `--extension` 路径，所以清单不会与
 * 实际加载的东西漂移（新加一个薄层扩展就自动出现在这里）。
 * 未在渲染端登记的 id 不会消失 —— 界面退而成显示文件名，
 * 让「新扩展忘了配文案」成为一个看得见的缺口。
 *
 * 宿主服务 / CLI 能力没有对应扩展文件，因此固定登记在最前面：
 * 任务计划走 `yan tasks apply`，内置浏览器走 `yan browser …`（01-S5 收尾时
 * 移除了那个不注册任何东西的空壳 `browser.js`，能力本身没有变化）。
 */
export function builtinCapabilities(thinPaths: readonly string[]): BuiltinCapability[] {
  const list: BuiltinCapability[] = [{ id: 'task-plan' }, { id: 'browser' }]
  const seen = new Set(list.map((c) => c.id))
  for (const p of thinPaths) {
    const file = basename(p)
    if (!file) continue
    const id = file.replace(/\.(?:js|mjs|cjs|ts|mts|cts)$/i, '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    list.push({ id, file })
  }
  return list
}
