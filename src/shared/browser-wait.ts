/**
 * `yan browser wait` 的条件判定（实施-27 S5）。
 *
 * 为什么单独抽出来：真正的等待循环（读页面、睡 250ms、再读）必须挨着浏览器服务，
 * 没法单测；但「什么算满足」是一个纯函数 —— 把它留在一个带 host 的私有方法里，
 * 这块最容易出错的逻辑（叠加条件是"且"、`--gone` 与 `--ref` 的搭配、
 * 超时上限）就只能靠真实页面来试。抽出来之后可以用假 observation 钉住。
 */

export interface BrowserWaitCondition {
  /** 元素 ref（来自 `yan browser observe`） */
  ref?: string
  /** 可见文本里要出现的片段 */
  text?: string
  /** 当前地址里要出现的片段 */
  url?: string
  /** 配合 `ref`：等它**消失**而不是出现 */
  gone?: boolean
}

/** 超时上限：等太久会把一次工具调用变成卡死（模型侧看不到进度） */
export const WAIT_TIMEOUT_MIN_MS = 100
export const WAIT_TIMEOUT_MAX_MS = 60_000
export const WAIT_TIMEOUT_DEFAULT_MS = 10_000
/** 轮询间隔：observe 一次要读 AX 树，太密会拖慢页面本身 */
export const WAIT_POLL_MS = 250

export type WaitParseResult =
  | { ok: true; condition: BrowserWaitCondition; timeoutMs: number }
  | { ok: false; code: string; message: string }

/** `--gone` 在 CLI 里可能以字符串形式到（`--gone` 不带值时是 `true`） */
function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === ''
}

/**
 * 解析参数。**没有条件就拒**：一个"什么都不等"的 wait 会白等满超时，
 * 而模型会以为"等过了页面就该好了"。
 */
export function parseWaitCondition(params: Record<string, unknown>): WaitParseResult {
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const ref = text(params.ref)
  const body = text(params.text)
  const url = text(params.url)
  const gone = truthy(params.gone)

  if (!ref && !body && !url) {
    return {
      ok: false,
      code: 'missing_condition',
      message: 'wait 需要一个条件：yan browser wait --ref <ref> / --text <文本> / --url <子串>（可加 --timeout <毫秒>）'
    }
  }
  if (gone && !ref) {
    /* `--gone` 只对元素有意义：文本/地址"消失"没法可靠判定（页面重渲染时文本会短暂为空） */
    return { ok: false, code: 'missing_ref', message: '--gone 要配合 --ref：yan browser wait --ref <ref> --gone' }
  }

  const raw = Number(params.timeout ?? params['timeout-ms'] ?? WAIT_TIMEOUT_DEFAULT_MS)
  const timeoutMs = Number.isFinite(raw)
    ? Math.min(Math.max(Math.floor(raw), WAIT_TIMEOUT_MIN_MS), WAIT_TIMEOUT_MAX_MS)
    : WAIT_TIMEOUT_DEFAULT_MS

  return {
    ok: true,
    condition: { ...(ref ? { ref } : {}), ...(body ? { text: body } : {}), ...(url ? { url } : {}), ...(gone ? { gone: true } : {}) },
    timeoutMs
  }
}

/** 满足条件？（叠加条件是**且** —— 逐条不满足就立刻返回 false） */
export function waitSatisfied(
  condition: BrowserWaitCondition,
  observation: { url: string; text: string; elements: { ref: string }[] }
): boolean {
  if (condition.ref) {
    const found = observation.elements.some((el) => el.ref === condition.ref)
    if (condition.gone ? found : !found) return false
  }
  if (condition.text && !observation.text.includes(condition.text)) return false
  if (condition.url && !observation.url.includes(condition.url)) return false
  return true
}

/** 人话描述等待的条件（超时报错与日志共用一份措辞） */
export function describeWait(condition: BrowserWaitCondition): string {
  return [
    condition.ref ? (condition.gone ? `ref=${condition.ref} 消失` : `ref=${condition.ref} 出现`) : '',
    condition.text ? `文本「${condition.text}」` : '',
    condition.url ? `地址包含「${condition.url}」` : ''
  ]
    .filter(Boolean)
    .join(' 且 ')
}
