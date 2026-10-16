/**
 * 品牌标记的几何来自唯一真源 `resources/brand/inkstone-design.json`：由
 * `npm run icon` 生成 `src/shared/brand-geometry.ts`，这里直接引用，不再手写一份路径。
 *
 * 为什么渲染成内联 SVG 而不是外链 `build/prompt-stone.svg`：Electron 的 Chromium
 * 把带 currentColor 的外部 SVG 当 CSS mask 时可能解析成整块不透明区域。内联保留
 * currentColor，深浅主题都可靠。功能按钮仍使用 reicon；提示砚只出现在产品识别与空态。
 */
import { BRAND_FRAME, BRAND_PROMPT, BRAND_VIEW_BOX } from '../../../../shared/brand-geometry'

export function BrandMark({
  size = 20,
  className,
  decorative = false
}: {
  size?: number
  className?: string
  decorative?: boolean
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={BRAND_VIEW_BOX}
      className={['brand-mark', className].filter(Boolean).join(' ')}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : '砚'}
      aria-hidden={decorative ? true : undefined}
      style={{
        width: size,
        height: size
      }}
    >
      <path
        d={BRAND_FRAME.path}
        fill="none"
        stroke="currentColor"
        strokeWidth={BRAND_FRAME.strokeWidth}
        strokeLinecap={BRAND_FRAME.linecap}
        strokeLinejoin={BRAND_FRAME.linejoin}
      />
      {BRAND_PROMPT.map((part) => (
        <path
          key={part.path}
          d={part.path}
          fill="none"
          stroke="currentColor"
          strokeWidth={part.strokeWidth}
          strokeLinecap={part.linecap}
          strokeLinejoin={part.linejoin}
        />
      ))}
    </svg>
  )
}
