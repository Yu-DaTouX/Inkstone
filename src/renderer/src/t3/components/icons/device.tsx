import type { ReactElement, SVGProps } from 'react'

export type PlatformIcon = (props: SVGProps<SVGSVGElement>) => ReactElement

export const AppleIcon: PlatformIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
  </svg>
)

export const AndroidIcon: PlatformIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path
      d="m8 3-1-2m9 2 1-2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
    <path
      fillRule="evenodd"
      d="M5 10a7 7 0 0 1 14 0H5Zm4-4a.8.8 0 1 0 0 1.6A.8.8 0 0 0 9 6Zm6 0a.8.8 0 1 0 0 1.6A.8.8 0 0 0 15 6Z"
    />
    <path d="M5 11h14v7a2 2 0 0 1-2 2v2a1.5 1.5 0 0 1-3 0v-2h-4v2a1.5 1.5 0 0 1-3 0v-2a2 2 0 0 1-2-2v-7Z" />
    <rect x="1" y="11" width="3" height="8" rx="1.5" />
    <rect x="20" y="11" width="3" height="8" rx="1.5" />
  </svg>
)
