/*
 * pi 模型元数据里价格字段的纯映射（WP-40）。
 *
 * 为什么单独一份：pi 的 `get_available_models` 返回的模型对象本来就带 `cost`
 * （见 pi `ModelDefinitionSchema`：`cost: Optional(ModelCostSchema)`，四档费率都是
 * 「美元 / 百万 token」），但砚的 `normalizeModelInfo` 之前只挑了能力字段，
 * 报价被丢掉了 —— 选择器即使写了价格显示逻辑也无数据可显示。
 * 这里只做「从 pi 原始记录取报价 → 接到已归一化的 ModelInfo」这一步，
 * 不读 store、不启动 Electron、不按模型名猜价格，所以能在 Node 里直接钉死。
 *
 * 报价缺失（如订阅制、手写 models.json 没填、或上游返回全 0）时保持缺失，
 * 由界面决定不显示 —— 0 不等于「免费」，不能凭它渲染 $0.00。
 */
import { cleanModelCost } from '../../shared/custom-provider'

/**
 * 每百万 token 的报价（美元），与 pi 的 `cost` 同形。
 *
 * `input` / `output` 一定有值；`cacheRead` / `cacheWrite` 在 pi 的
 * `Partial(ModelCostSchema)`（自定义 models.json 覆盖）里可省略，这里保持可选，
 * 由 `cleanModelCost` 把缺失档归 0。
 */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** 从 pi 的原始模型记录里取报价；没有或不是有效报价时返回 undefined。 */
export function modelPriceOf(raw: unknown): ModelPrice | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const cost = cleanModelCost((raw as { cost?: unknown }).cost)
  if (!cost) return undefined
  return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite }
}

/**
 * 把 pi 的报价接到已归一化的模型对象上。
 *
 * `model` 是 `normalizeModelInfo` 的结果；`raw` 是同一份 pi 原始记录 —— 两者
 * 必须来自同一条模型，否则价格会错位。没有报价时原样返回，不写 `cost: undefined`，
 * 保持「上游没给」与「明确为 0」的区别。
 */
export function attachModelPrice<T extends object>(
  model: T | undefined,
  raw: unknown
): (T & { cost?: ModelPrice }) | undefined {
  if (!model) return undefined
  const price = modelPriceOf(raw)
  if (!price) return model
  return { ...model, cost: price }
}
