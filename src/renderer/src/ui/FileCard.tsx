import { FileText, Folder } from 'lucide-react'
import { Button, type ButtonProps } from './Button'
import { cx } from './cx'

export function FileCard({ name, path, isDirectory, compact, className, ...props }: ButtonProps & { name: string; path?: string; isDirectory?: boolean; compact?: boolean }) {
  return (
    <Button
      {...props}
      variant="secondary"
      className={cx('ui-file-card', compact && 'ui-file-card--compact', typeof className === 'string' ? className : undefined)}
      title={path || name}
      aria-label={name}
      icon={isDirectory ? <Folder size={compact ? 16 : 22} /> : <FileText size={compact ? 16 : 22} />}
    >
      <span className="ui-file-card__name">{name}</span>
    </Button>
  )
}
