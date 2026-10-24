import { FileText, Folder } from 'lucide-react'
import { Button, type ButtonProps } from './Button'
import { cx } from './cx'

export function FileCard({ name, path, isDirectory, className, ...props }: ButtonProps & { name: string; path?: string; isDirectory?: boolean }) {
  return (
    <Button
      {...props}
      variant="secondary"
      className={cx('ui-file-card', typeof className === 'string' ? className : undefined)}
      title={path || name}
      aria-label={name}
      icon={isDirectory ? <Folder size={22} /> : <FileText size={22} />}
    >
      <span className="ui-file-card__name">{name}</span>
    </Button>
  )
}
