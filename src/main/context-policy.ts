/**
 * 主进程侧的上下文策略入口（N21-3 / N21-7）。
 *
 * 纯逻辑（预算公式、触发决策、阶段挑选、多层覆盖解析）都在
 * `src/shared/context-policy.ts` —— 判定与显示必须是同一套规则，
 * 所以它不能只住在主进程里。N21-7 之后“同一个数”还多了一层含义：
 * 设置面板改的值、界面显示的来源、主进程真正用来判断的值，三者必须一致
 * （D21/D22 就是这里出的「界面数字 ≠ 实际生效值」）。
 *
 * 这里只放**需要主进程环境**的两件事：
 *   ① 把 `YAN_CONTEXT_POLICY`（测试通道，最高优先级）读进来；
 *   ② 记住**设置层**（用户级 + 模型级），由 settings 读盘 / patchSettings 后登记。
 *
 * ── 为什么设置层用登记而不是每次 await getSettings ──
 * `AgentController.effectivePolicy()` 是同步的，而它会在每一帧 `setStateFrom`
 * 里被调用（推状态时算预算）。把它改成 async 会让“推一帧”变成 await 链，
 * 而策略只是十几个数字。所以由主进程在**设置变化的时刻**登记一份，
 * 之后同步解析 —— 与 `agentResponseDetail` 是同一个模式。
 */
import {
  buildEffectivePolicyDocument,
  contextPolicyRevision,
  resolveContextPolicy,
  type ContextPolicyLayers,
  type ResolvedContextPolicy
} from '../shared/context-policy'
import type { ContextPolicyOverrides } from '../shared/ipc'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 设置层的两种覆盖（形状与 AppSettings 的两个字段一致） */
export interface ContextPolicySettingsLayer {
  user?: ContextPolicyOverrides
  byModel?: Record<string, ContextPolicyOverrides>
  /**
   * `episode-fold` 的用户开关（`AppSettings.contextFold`，P2-7）。
   *
   * `false` = 用户关掉了状态生成与注入；`true` / 不传 = 按默认（开）。
   * 它是**设置层**而不是数值，所以与 `user` / `byModel` 并列而不是塞进它们
   * （`applyOverrides` 只认数值）。调用方应由 `settings.contextFold?.enabled !== false`
   * 得出一个明确的布尔，不要让 undefined 在链路上漏传。
   */
  foldEnabled?: boolean
}

let settingsLayer: ContextPolicySettingsLayer = {}

/**
 * 登记设置层（读盘 / 写入设置后调用）。
 *
 * 传 `null` / `undefined` 表示“没有任何覆盖”（回到纯默认值）——
 * 与 `{}` 等价，但语义更清楚：调用方不必自己造空对象。
 */
export function setContextPolicySettings(next: ContextPolicySettingsLayer | null | undefined): void {
  settingsLayer = {
    user: next?.user,
    byModel: next?.byModel,
    foldEnabled: next?.foldEnabled
  }
}

/** 当前登记的设置层（测试与日志用；返回副本，外部改不动内部状态） */
export function contextPolicySettings(): ContextPolicySettingsLayer {
  return {
    user: settingsLayer.user ? { ...settingsLayer.user } : undefined,
    byModel: settingsLayer.byModel ? { ...settingsLayer.byModel } : undefined,
    foldEnabled: settingsLayer.foldEnabled
  }
}

/**
 * 当前生效的策略 + 生效层来源。
 *
 * 优先级：`env` > `model`（`provider/model`）> `provider` > `user` > `default`。
 * `modelKey` 传当前会话模型的 `provider/model`；没有当前模型（还没握手 /
 * 后端未连接）时不传，于是只有用户级与默认值参与 —— 这与“界面此刻只能
 * 按未知窗口画”是同一件事，不是降级。
 *
 * env 放在**最高**优先级：它是测试手法（`YAN_CONTEXT_POLICY`），
 * 如果被用户设置盖掉，`contexttakeover` 这类场景会静默失效。
 */
export function activeContextPolicy(
  env: NodeJS.ProcessEnv = process.env,
  modelKey?: string
): ResolvedContextPolicy {
  const layers: ContextPolicyLayers = {
    user: settingsLayer.user,
    byModel: settingsLayer.byModel,
    modelKey,
    envRaw: env.YAN_CONTEXT_POLICY,
    /* `episode-fold` 的用户开关（P2-7）：与扩展侧读的是**同一个设置字段**的两种投影 */
    foldEnabled: settingsLayer.foldEnabled
  }
  return resolveContextPolicy(layers)
}

/**
 * 把生效策略写给薄层（实施-11 C-4）。
 *
 * 为什么需要：数值覆盖住在 `desktop.json`，而 pi 扩展按设计不读它 ——
 * 扩展按默认 240K 算阈值、界面按用户设置的 300K 显示，两边说的不是一件事。
 * 这里把**分层覆盖**落成一个独立文件（`<dataDir>/context-policy.effective.json`），
 * 扩展读它并按同一个 `contextBudget()` 公式算阈值。
 *
 * 三个边界：
 *   · 内容没变（revision 相同）不落盘 —— 每轮 setStateFrom 都会走到这里；
 *   · 写失败只吞掉，不影响设置生效（薄层回落默认，与今天的行为一致）；
 *   · **不写 `YAN_CONTEXT_POLICY`**：那个 env 的优先级高于设置面板，
 *     宿主自己写它会让用户设置被静默忽略。
 */
let lastEffectiveRevision: string | null = null

export async function syncEffectivePolicyFile(
  dataDir: string,
  input: {
    user?: ContextPolicyOverrides
    byModel?: Record<string, ContextPolicyOverrides>
    foldEnabled?: boolean
  }
): Promise<string | null> {
  const revision = contextPolicyRevision(input)
  if (revision === lastEffectiveRevision) return revision
  const doc = buildEffectivePolicyDocument(input)
  try {
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      join(dataDir, 'context-policy.effective.json'),
      `${JSON.stringify(doc)}\n`,
      'utf8'
    )
    lastEffectiveRevision = revision
    return revision
  } catch {
    return null
  }
}
