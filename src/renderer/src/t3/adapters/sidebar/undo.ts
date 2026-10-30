import { useSessionUndoNotice } from '../../../features/sidebar/session-undo-toast'

export interface ThreadUndoNotice {
  text: string | null
  label: string
  undo(): void
}

export function useThreadUndoNotice(): ThreadUndoNotice {
  return useSessionUndoNotice()
}
