import { useEffect, useRef, useState } from 'react'
import type { FilesOwner } from './files-model'
import {
  contentSearchRows,
  nameSearchFailed,
  nameSearchRows,
  parseFilesQuery,
  searchStatusFailed,
  type FilesSearchRow
} from './files-search'

const NAME_DELAY = 80
const CONTENT_DELAY = 250
const NAME_LIMIT = 200

export interface FilesSearchState {
  mode: 'name' | 'content'
  phase: 'idle' | 'searching' | 'done'
  rows: FilesSearchRow[]
  truncated: boolean
  failed: boolean
}

const IDLE: FilesSearchState = { mode: 'name', phase: 'idle', rows: [], truncated: false, failed: false }

export function useFilesSearch(owner: FilesOwner, active: boolean, raw: string, retry = 0): FilesSearchState {
  const [state, setState] = useState<FilesSearchState>(IDLE)
  const sequenceRef = useRef(0)
  const parsed = parseFilesQuery(raw)
  const { cwd, key, generation } = owner

  useEffect(() => {
    if (!active || !parsed.query || !cwd) {
      sequenceRef.current += 1
      setState((prev) => (prev.phase === 'idle' && prev.rows.length === 0 && !prev.failed ? prev : { ...IDLE, mode: parsed.mode }))
      return undefined
    }

    sequenceRef.current += 1
    const sequence = sequenceRef.current
    const mode = parsed.mode
    const query = parsed.query
    const timer = window.setTimeout(() => {
      setState((prev) => ({ mode, phase: 'searching', rows: prev.mode === mode ? prev.rows : [], truncated: false, failed: false }))
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
          const result = await window.yan.searchFileNames({ ...context, requestId, query, limit: NAME_LIMIT })
          if (sequenceRef.current !== sequence) return
          if (result.error?.code === 'superseded') return
          setState({
            mode,
            phase: 'done',
            rows: nameSearchRows(result),
            truncated: result.truncated,
            failed: nameSearchFailed(result)
          })
        } catch {
          if (sequenceRef.current !== sequence) return
          setState({ mode, phase: 'done', rows: [], truncated: false, failed: true })
        }
      }
      void run()
    }, mode === 'content' ? CONTENT_DELAY : NAME_DELAY)

    return () => window.clearTimeout(timer)
  }, [active, parsed.mode, parsed.query, cwd, key, generation, retry])

  return state
}
