import { useStore } from '../../state/store'
import { FileCard } from '../../ui/FileCard'
import { useSessionText } from './text'
import { openMessageMenu } from './message-menu'
import type { splitFileReferences } from '../composer/file-refs'

export function MessageFiles({ files, sourceCwd }: { files: ReturnType<typeof splitFileReferences>['files']; sourceCwd?: string }) {
  const tt = useSessionText()
  const previewFile = useStore((s) => s.previewFile)
  return (
    <div className="v3-user-files" data-testid="v3-user-files">
      {files.map((file) => {
        const open = (): void => {
          if (file.isDirectory) void window.yan.openPath(file.path)
          else void previewFile(file.path, undefined, sourceCwd)
        }
        return (
          <FileCard key={file.path} {...file} className="v3-user-file" onPress={open} onContextMenu={(event) => {
            openMessageMenu(event, tt('menuLink'), [
              { id: 'preview', label: tt('menuPreviewFile'), run: open },
              { id: 'reveal', label: tt('menuRevealFile'), run: () => void window.yan.revealPath(file.path) },
              { id: 'copy', label: tt('menuCopyPath'), run: () => void navigator.clipboard.writeText(file.path) }
            ])
          }} />
        )
      })}
    </div>
  )
}
