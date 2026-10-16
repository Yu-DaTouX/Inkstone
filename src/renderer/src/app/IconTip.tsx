import type { ReactElement } from 'react'
import { Tooltip, TooltipTrigger } from '../ui'

/**
 * 图标按钮的提示气泡（延迟 500ms，键盘聚焦也出现，见 02 §15.2）。
 *
 * 单独一个文件是因为外壳与侧栏都要用；`ui/Tooltip` 本身只负责外观，
 * 「成对使用 Trigger + Tooltip」的写法在这里统一一次。
 */
export function IconTip({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <TooltipTrigger delay={500}>
      {children}
      <Tooltip>{label}</Tooltip>
    </TooltipTrigger>
  )
}
