/**
 * 「扩展来源」诊断：把**谁在给这个 pi 实例加东西**说清楚。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（实施-02 S1 的出口）
 * ══════════════════════════════════════════════════════════════════
 * 任务工具从「用户扩展提供」迁到「砚内置」的过渡期里，两种来源可能同时存在：
 * 用户 `~/.pi/agent/extensions/` 里的旧扩展仍会被 pi **自动发现并加载**，
 * 而砚自己还挂着 6 个薄层扩展（`--extension` 显式传入）。用户看到的界面是
 * 一个任务清单，但底下有两套写入路径 —— 一旦出问题（清单跳变、历史对不上），
 * 没有一份「来源清单」就没法判断是谁写的。
 *
 * 所以这个模块只做一件事：**如实列举来源**，不做任何修复动作。
 *
 * ── 边界（不能长成「插件管理器」）──
 * · 只 `readdir`，**不解析**扩展源码、不 import 它们、不改动它们；
 * · 不显示「已启用 / 已同步」这类没有依据的状态；
 * · 用户扩展**不删、不禁用**（AGENTS.md：不删用户已装的扩展）。
 *
 * `enabled` 一词在这里只描述**当前事实**（pi 会不会自动发现这个目录），
 * 不表达砚的推荐。默认路线不再加载用户扩展要等 [实施-01 S5]；
 * 那一步完成时，本文件的措辞与 `--no-extensions` 开关要一起改。
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
        `（pi 启动时会自动发现并加载它们；砚不删除、不改写）`
    )
  } else {
    lines.push('[来源] 未检测到用户扩展（pi 的扩展目录是空的）')
  }

  lines.push(
    `[来源] 砚内置薄层 ${thin.length} 项：${thin.join('、') || '（无）'}` +
      `（显式传入，只挂生命周期钩子，不注册模型工具）`
  )

  if (user.length) {
    /*
     * 只在真有用户扩展时说这段：它解释的是「两套来源同时存在」的后果。
     *
     * ⚠️ 文案必须跟着 S3 的事实走：宿主**从 S3 起真的在写**任务日志，
     * 所以不能说「砚只读不写」（那是 S3 之前的真相，继续留着就是撒谎）。
     * 但也不能说成「旧扩展已经不写了」—— 砚禁不了它，它写不写由它自己决定。
     * 能确定说的只有两件：两条写入路径各写各的；同一轮都有时宿主优先。
     */
    lines.push(
      '[来源] 检测到用户扩展：它可能仍在写会话里的 `left-panel-tasks`；' +
        '砚内置任务计划写宿主日志（数据目录下的 task-plans）。同一轮两者都有时以宿主日志为准，' +
        '旧条目只读、不会被覆盖，也不会被回写'
    )
  }

  return lines
}

/** 一条「受信内置能力」（砚随包分发，不是用户装的包）。 */
export interface BuiltinCapability {
  /**
   * 稳定 id —— 渲染端用它翻文案。
   *
   * 扩件取文件名去后缀（`browser.js` → `browser`）；
   * 宿主服务用固定 id（任务计划是 `task-plan`）。
   */
  id: string
  /** 实际加载的扩展文件名；宿主服务没有这一项。 */
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
 * ── 清単来自「实际加载路径」而不是另写一份 ──
 * 传入的是主进程真正传给 pi 的 `--extension` 路径，所以清单不会与
 * 实际加载的东西漂移（新加一个薄层扩展就自动出现在这里）。
 * 未在渲染端登记的 id 不会消失 —— 界面退而成显示文件名，
 * 让「新扩展忘了配文案」成为一个看得见的缺口。
 */
export function builtinCapabilities(thinPaths: readonly string[]): BuiltinCapability[] {
  const list: BuiltinCapability[] = [{ id: 'task-plan' }]
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
