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
