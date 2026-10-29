import { QRCodeSVG } from 'qrcode.react'
import { cx } from './cx'

export interface QrCodeProps {
  value: string
  size?: number
  level?: 'L' | 'M' | 'Q' | 'H'
  marginSize?: number
  title?: string
  className?: string
}

export function QrCode({ value, size = 144, level = 'M', marginSize = 2, title, className }: QrCodeProps) {
  return (
    <span className={cx('ui-qr', className)} role={title ? 'img' : undefined} aria-label={title}>
      <QRCodeSVG
        value={value}
        size={size}
        level={level}
        marginSize={marginSize}
        bgColor="transparent"
        fgColor="currentColor"
        aria-hidden="true"
      />
    </span>
  )
}
