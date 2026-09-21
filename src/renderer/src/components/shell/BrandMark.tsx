/**
 * 品牌标记使用与 build/prompt-stone.svg 相同的几何路径，但在这里内联。
 *
 * 不能把带 currentColor 的外部 SVG 直接当 CSS mask：Electron 的 Chromium
 * 在这条路径上可能把 mask 解析成整块不透明区域，最后只看到蓝色方块。
 * 内联 SVG 保留 currentColor，同时让透明背景和描边在深浅主题中都可靠。
 * 功能按钮仍使用 reicon；提示砚只出现在产品识别与品牌空状态中。
 */
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
      viewBox="0 0 100 100"
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
        d="M70 22H25Q22 22 22 25V75Q22 78 25 78H75Q78 78 78 75V53"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <path
        d="M36 40L47 50L36 60M57 62H69"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  )
}
