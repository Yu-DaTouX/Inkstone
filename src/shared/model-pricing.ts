/*
 * 会话花费的兜底估算（纯函数 + 一份由宿主注入的模型报价目录）。
 *
 * pi 按「模型定义里的 cost」算每条回复的费用。订阅制或自己写的服务（Command Code、中转站、
 * 手写 models.json）常常没填报价，pi 就记 0，状态栏的「本会话」永远是 $0.000。
 * 这里在 pi 报 0 而 token 不为 0 时，按随包模型目录里的公开 API 报价补一个估算：
 * 报价只认目录里同名（忽略厂商前缀）模型，找不到就保持 0，不猜。
 * pi 已经算出费用的消息一概不动。目录由主进程启动时注入（`setPricingCatalog`）。
 */
import { catalogKey, cleanModelCost, type ModelCost, type PiModelCatalog } from './custom-provider'

let catalog: PiModelCatalog = {}

export function setPricingCatalog(next: PiModelCatalog): void {
  catalog = next
}

export function priceOf(model: string | undefined): ModelCost | undefined {
  if (!model) return undefined
  return cleanModelCost(catalog[catalogKey(model)]?.cost)
}

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 按每百万 token 报价估算费用（美元）；目录里没有这个模型的价格返回 undefined */
export function estimateCost(model: string | undefined, tokens: TokenCounts): number | undefined {
  const price = priceOf(model)
  if (!price) return undefined
  return (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) / 1_000_000
}
