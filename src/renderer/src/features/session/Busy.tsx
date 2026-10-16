import type { JSX } from 'react'

export function Busy({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`v3-busy ${className}`.trim()} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}
