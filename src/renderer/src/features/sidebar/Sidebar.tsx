import { memo, type ReactElement } from 'react'
import { T3SidebarShell } from '../../t3/shell/T3SidebarShell'
import './Sidebar.css'

interface Props {
  preview?: boolean
  onPin?: () => void
  onClose?: () => void
  onSchedule?: () => void
  onCollab?: () => void
  onArtifacts?: () => void
  onSettings?: () => void
  onSearch?: () => void
}

export const Sidebar = memo(function Sidebar(props: Props): ReactElement {
  return <T3SidebarShell {...props} />
})
