import { useEffect, useRef, useState } from 'react'
import type { FilesOwner } from './files-model'
import { contentSearchRows, nameSearchRows, parseFilesQuery, searchStatusFailed, type FilesSearchRow } from './files-search'

const NAME_DELAY = 120
const CONTENT_DELAY = 250

export interface FilesSearchState {
  mode: 'name' | 'content'
  phase: 'idle' | 'searching' | 'done'
  rows: FilesSearchRow[]
  truncated: boolean
  failed: boolean
}

const IDLE: FilesSearchState = { mode: 'name', phase: 'idle', rows: [], truncated: false, failed: false }

export function useFilesSearch(owner: FilesOwner, active: boolean, raw: string): FilesSearchState {
  const [state, setState] = useState<FilesSearchState>(IDLE)
  const sequenceRef = useRef(0)
  const parsed = parseFilesQuery(raw)
  const { cwd, key, generation } = owner

  useEffect(() => {
    if (!active || !parsed.query || !cwd) {
      sequenceRef.current += 1
      setState((prev) => (prev.phase === 'idle' && prev.rows.length === 0 && !prev.failed ? prev : IDLE))
      return undefined
    }

    sequenceRef.current += 1
    const sequence = sequenceRef.current
    const mode = parsed.mode
    const query = parsed.query
    const timer = window.setTimeout(() => {
      setState({ mode, phase: 'searching', rows: [], truncated: false, failed: false })
      const context = { cwd, generation: generation ?? 0 }
      const requestId = `${key}:${sequence}`
      const run = async (): Promise<void> => {
        try {
          if (mode === 'content') {
            const result = await window.yan.searchFileContents({ ...context, requestId, query })
            if (sequenceRef.current !== sequence) return
            setState({
              mode,
              phase: 'done',
              rows: contentSearchRows(result),
              truncated: result.truncated,
              failed: searchStatusFailed(result.status)
            })
            return
          }
          const result = await window.yan.searchFiles({ ...context, requestId, query })
          if (sequenceRef.current !== sequence) return
          setState({
            mode,
            phase: 'done',
            rows: nameSearchRows(result),
            truncated: result.truncated,
            failed: searchStatusFailed(result.status)
          })
        } catch {
          if (sequenceRef.current !== sequence) return
          setState({ mode, phase: 'done', rows: [], truncated: false, failed: true })
        }
      }
      void run()
    }, mode === 'content' ? CONTENT_DELAY : NAME_DELAY)

    return () => window.clearTimeout(timer)
  }, [active, parsed.mode, parsed.query, cwd, key, generation])

  return state
}
