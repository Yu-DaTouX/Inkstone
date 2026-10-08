/* 启动时把随包模型目录的报价注入花费估算（纯函数在 shared/model-pricing.ts） */
import { setPricingCatalog } from '../shared/model-pricing'
import { readPiModelCatalog } from './pi-model-catalog'

let loading: Promise<void> | undefined

/** 读完之前估算不生效（花费按 pi 的原值显示），不阻塞启动 */
export function loadModelPricing(): Promise<void> {
  loading ??= readPiModelCatalog().then(setPricingCatalog).catch(() => undefined)
  return loading
}
