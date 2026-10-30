import { useEffect, useRef, useState } from 'react'
import type { WorkspaceOwner } from '../workbench/types'
import type { CommandItem, PaletteMode } from './command-items'
import {
  CONTENT_QUERY_DELAY,
  CONTENT_RESULT_LIMIT,
  FILE_QUERY_DELAY,
  FILE_RESULT_LIMIT,
  contentHitItems,
  contentIssue,
  contentTruncated,
  fileNameIssue,
  fileNameItems,
  type FileSearchIssue
} from './command-file-search'

export interface PaletteFileSearch {
  phase: 'idle' | 'searching' | 'done'
  items: CommandItem[]
  issue: FileSearchIssue
  truncated: boolean
}

const IDLE: PaletteFileSearch = { phase: 'idle', items: [], issue: null, truncated: false }

export function usePaletteFileSearch(mode: PaletteMode, term: string, owner: Pick<WorkspaceOwner, 'key' | 'cwd' | 'generation'>): PaletteFileSearch {
  const [state, setState] = useState<PaletteFileSearch>(IDLE)
  const sequence = useRef(0)
  const searchable = mode === 'file' || mode === 'content'
  const { key, cwd, generation } = owner

  useEffect(() => {
    sequence.current += 1
    const current = sequence.current
    if (!searchable || !term || !cwd) {
      setState(IDLE)
      return undefined
    }
    const group = mode === 'content' ? 'content' : 'file'
    setState((previous) => ({ ...previous, phase: 'searching', issue: null, items: previous.items.filter((item) => item.group === group) }))
    const context = { cwd, generation: generation ?? 0 }
    const requestId = `palette:${key}:${current}`
    const timer = window.setTimeout(() => {
      const run = async (): Promise<void> => {
        try {
          if (mode === 'content') {
            const result = await window.yan.searchFileContents({ ...context, requestId, query: term, limit: CONTENT_RESULT_LIMIT + 1 })
            if (sequence.current !== current) return
            const issue = contentIssue(result)
            const items = issue ? [] : contentHitItems(result)
            setState({ phase: 'done', items, issue, truncated: !issue && contentTruncated(result) })
            return
          }
          const result = await window.yan.searchFileNames({ ...context, requestId, query: term, limit: FILE_RESULT_LIMIT })
          if (sequence.current !== current) return
          if (result.error?.code === 'superseded') return
          const issue = fileNameIssue(result)
          setState({ phase: 'done', items: issue ? [] : fileNameItems(result), issue, truncated: !issue && result.truncated })
        } catch {
          if (sequence.current !== current) return
          setState({ phase: 'done', items: [], issue: 'failed', truncated: false })
        }
      }
      void run()
    }, mode === 'content' ? CONTENT_QUERY_DELAY : FILE_QUERY_DELAY)
    return () => window.clearTimeout(timer)
  }, [searchable, mode, term, key, cwd, generation])

  return state
}
