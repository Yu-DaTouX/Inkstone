/**
 * 「扩展来源」诊断：把**谁在给这个 pi 实例加东西**说清楚。
 *
 * 如实列举用户目录与显式传入的宿主适配；目录清单不代表实际加载成功。
 * 原生 pi 的发现与禁用设置由 pi 管理，旧版 runner 保留隔离发现的策略。
 *
 * ── 边界（不能长成「插件管理器」）──
 * · 只 `readdir`，**不解析**扩展源码、不 import 它们、不改动它们；
 * · 不显示「已启用 / 已同步」这类没有依据的状态；
 * · 用户扩展**不删、不禁用**（AGENTS.md：不删用户已装的扩展）。
 *
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
  /** 与当前 runner 的启动参数一致，原生发现由 pi 设置与项目信任控制。 */
  nativeDiscovery: boolean
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
 * 清单与加载策略分别描述，不把目录存在当作加载成功。
 */
export function extensionDiagnostics(opts: ExtensionExpectation): string[] {
  const user = readUserExtensions(opts.piDir)
  const thin = (opts.yanThinPaths ?? []).map((p) => basename(p)).filter(Boolean)
  const lines: string[] = []

  if (user.length) {
    lines.push(
      `[来源] 用户扩展 ${user.length} 项：${user.join('、')}` +
        (opts.nativeDiscovery
          ? '（由 pi 原生发现；是否加载由 pi 设置与项目信任决定，目录清单不代表已加载；不删除、不改写）'
          : '（旧版 runner 使用 --no-extensions，不自动加载；不删除、不改写）')
    )
  } else {
    lines.push('[来源] 未检测到用户扩展（pi 的扩展目录是空的）')
  }

  lines.push(
    `[来源] 砚内置薄层 ${thin.length} 项：${thin.join('、') || '（无）'}` +
      `（显式传入；承载宿主生命周期与授权适配，不注册模型工具；上下文由 Agent 原生管理，交互提问走宿主 yan question ask，归档回读走 yan context recall）`
  )

  if (user.length) {
    lines.push(
      '[来源] 历史会话里的 `left-panel-tasks` 只读，砚内置任务计划写宿主日志（数据目录下的 task-plans），' +
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
