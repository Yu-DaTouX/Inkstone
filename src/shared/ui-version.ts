/** 外壳选择是启动配置，不改变会话、运行或权限语义。 */
export type UiVersion = 'v2' | 'v3'

export function asUiVersion(value: unknown): UiVersion | null {
  return value === 'v2' || value === 'v3' ? value : null
}

/** 显式环境覆盖 > 持久设置 > 默认 v2。脏值不能意外开启开发外壳。 */
export function resolveUiVersion(environment: unknown, setting: unknown): UiVersion {
  return asUiVersion(environment) ?? asUiVersion(setting) ?? 'v2'
}

/** 沙箱 preload 只读宿主显式提供的参数，不依赖 renderer 的 process.env。 */
export function uiVersionArgument(args: readonly string[]): UiVersion | null {
  if (args.includes('--yan-ui=v3')) return 'v3'
  if (args.includes('--yan-ui=v2')) return 'v2'
  return null
}
