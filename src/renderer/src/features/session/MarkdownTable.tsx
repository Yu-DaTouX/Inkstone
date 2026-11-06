import { useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { estimateColumnShares, sharesShifted } from './markdown-table'

const COLUMN_MIN_PX = 96

export function MarkdownTable({ children }: { children?: ReactNode }): JSX.Element {
  const tableRef = useRef<HTMLTableElement | null>(null)
  const [shares, setShares] = useState<number[] | null>(null)
  const applied = useRef<number[] | null>(null)

  useLayoutEffect(() => {
    const table = tableRef.current
    if (!table) return
    const rows = Array.from(table.rows, (row) => Array.from(row.cells, (cell) => cell.textContent ?? ''))
    const next = estimateColumnShares(rows)
    if (!next.length || !sharesShifted(applied.current, next)) return
    applied.current = next
    setShares(next)
  })

  return (
    <div className="v3-md-table-wrap">
      <table ref={tableRef} data-cols={shares ? '' : undefined} style={shares ? { minWidth: shares.length * COLUMN_MIN_PX } : undefined}>
        {shares ? (
          <colgroup>
            {shares.map((share, index) => (
              <col key={index} style={{ width: `${share}%` }} />
            ))}
          </colgroup>
        ) : null}
        {children}
      </table>
    </div>
  )
}
