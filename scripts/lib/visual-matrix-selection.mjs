/** 模型菜单专项组使用稳定名称，runner 与 Electron 入口共用同一份配置。 */
export const MODEL_MENU_GROUPS = [
  { name: 'modelmenufull-dark', w: 1280, h: 680, scale: 1, theme: 'dark', states: ['modelmenufull'] },
  { name: 'modelmenufull-light', w: 1280, h: 680, scale: 1, theme: 'light', states: ['modelmenufull'] },
  { name: 'modelmenufull-narrow', w: 940, h: 600, scale: 1, theme: 'dark', states: ['modelmenufull'] }
]

export function selectRunGroups(wanted, only, defaults) {
  if (wanted.length) return wanted
  if (!only.includes('modelmenufull')) return defaults
  const names = MODEL_MENU_GROUPS.map((group) => group.name)
  return only.every((state) => state === 'modelmenufull') ? names : [...defaults, ...names]
}

/** 保留旧数字组号，同时支持不随数组位置变化的命名组。 */
export function selectMatrixGroups(groups, wanted) {
  return groups.filter((group, index) =>
    wanted.length === 0 || wanted.includes(String(index)) || (group.name && wanted.includes(group.name))
  )
}

export function hasRequestedStates(groups, only) {
  return groups.some((group) => group.states.some((state) => only.length === 0 || only.includes(state)))
}
