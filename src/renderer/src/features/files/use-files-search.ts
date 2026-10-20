import { useEffect, useRef, useState } from 'react'
import type { FilesOwner } from './files-model'
import {
  contentSearchError,
  contentSearchLimit,
  groupContentHits,
  nameSearchFailed,
  nameSearchRows,
  parseFilesQuery,
  type ContentOptions,
  type FilesSearchError,
  type FilesSearchLimit,
  type FilesSearchRow
} from './files-search'

const NAME_DELAY = 120
const CONTENT_DELAY = 250
const NAME_LIMIT = 50

export interface FilesSearchState {
  mode: 'name' | 'content'
  phase: 'idle' | 'searching' | 'done'
  rows: FilesSearchRow[]
  truncated: boolean
  limit: FilesSearchLimit
  shown: number
  failed: boolean
  error: FilesSearchError | null
}

const IDLE: FilesSearchState = { mode: 'name', phase: 'idle', rows: [], truncated: false, limit: null, shown: 0, failed: false, error: null }

export function useFilesSearch(
  owner: FilesOwner,
  active: boolean,
  raw: string,
  retry = 0,
  options?: ContentOptions
): FilesSearchState {
  const [state, setState] = useState<FilesSearchState>(IDLE)
  const sequenceRef = useRef(0)
  const parsed = parseFilesQuery(raw)
  const { cwd, key, generation } = owner
  const matchCase = !!options?.matchCase
  const wholeWord = !!options?.wholeWord
  const regexp = !!options?.regexp

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
      setState((prev) => ({
        ...IDLE,
        mode,
        phase: 'searching',
        rows: prev.mode === mode && !prev.failed ? prev.rows : []
      }))
      const context = { cwd, generation: generation ?? 0 }
      const requestId = `${key}:${sequence}`
      const run = async (): Promise<void> => {
        try {
          if (mode === 'content') {
            const result = await window.yan.searchFileContents({ ...context, requestId, query, matchCase, wholeWord, regexp })
            if (sequenceRef.current !== sequence) return
            const error = contentSearchError(result)
            const groups = groupContentHits(error ? [] : result.hits)
            const limit = error ? null : contentSearchLimit(result, groups)
            setState({
              mode,
              phase: 'done',
              rows: groups.rows,
              truncated: !!limit,
              limit,
              shown: groups.shown,
              failed: !!error,
              error
            })
            return
          }
          const result = await window.yan.searchFileNames({ ...context, requestId, query, limit: NAME_LIMIT })
          if (sequenceRef.current !== sequence) return
          if (result.error?.code === 'superseded') return
          const failed = nameSearchFailed(result)
          const rows = query.endsWith('/') ? nameSearchRows(result) : nameSearchRows(result).filter((row) => !row.dir)
          setState({
            mode,
            phase: 'done',
            rows,
            truncated: result.truncated,
            limit: result.truncated ? 'scan' : null,
            shown: rows.length,
            failed,
            error: failed ? 'error' : null
          })
        } catch {
          if (sequenceRef.current !== sequence) return
          setState({ ...IDLE, mode, phase: 'done', failed: true, error: 'error' })
        }
      }
      void run()
    }, mode === 'content' ? CONTENT_DELAY : NAME_DELAY)

    return () => window.clearTimeout(timer)
  }, [active, parsed.mode, parsed.query, cwd, key, generation, retry, matchCase, wholeWord, regexp])

  return state
}
