/**
 * 「扩展」分页（S2）：砚内置能力 + 用户安装的 pi 插件包。
 *
 * 内置能力只读；pi 插件的安装 / 更新 / 卸载都只在用户点击后走 `packages.action`。
 * 不显示「当前会话可用」——加载要等 pi 下次启动，如实交给 `installedNotLoaded`。
 */
import type { ReactElement } from 'react'
import { useCapsText } from './text'
import { PackagesPanel } from './PackagesPanel'

export function ExtensionsSection(): ReactElement {
  const text = useCapsText()
  return <PackagesPanel showBuiltin note={text('extensionsPackagesNote')} />
}
