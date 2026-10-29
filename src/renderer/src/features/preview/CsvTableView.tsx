import { useMemo, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { EmptyState, IconButton, SearchField } from '../../ui'
import { useI18n } from '../../i18n'
import type { PreviewText } from './preview-text'
import {
  csvColumnKind,
  filterCsvRowOrder,
  numericCsvColumns,
  parseCsvPreview,
  sortCsvRowOrder,
  type CsvParseResult
} from './csv-table'

interface CsvSort {
  column: number
  header: string
  direction: 'asc' | 'desc'
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

function truncationCaption(table: Extract<CsvParseResult, { kind: 'ok' }>['table'], text: PreviewText): string | null {
  const cells = table.cellsTruncated ? text.csvLongCells : ''
  if (!table.rowsTruncated && !table.colsTruncated) return table.cellsTruncated ? text.csvLongCells : null
  const values = { rows: table.rows.length, cols: table.rows[0]?.length ?? 0, cells }
  if (table.rowsTruncated && table.colsTruncated) return fill(text.csvShowingBoth, values)
  if (table.rowsTruncated) return fill(text.csvShowingRows, values)
  return fill(text.csvShowingColumns, values)
}

export function CsvTableView({
  text: textKey,
  name,
  delimiter,
  truncated,
  labels
}: {
  text: string
  name: string
  delimiter: string
  truncated?: boolean
  labels: PreviewText
}): ReactElement {
  const { lang } = useI18n()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CsvSort | null>(null)
  const parsed = useMemo(() => parseCsvPreview(textKey, delimiter), [textKey, delimiter])

  const model = useMemo(() => {
    if (parsed.kind !== 'ok') return null
    const table = parsed.table
    const header = table.hasHeader ? table.rows[0] : null
    const body = table.hasHeader ? table.rows.slice(1) : table.rows
    const width = body.reduce((widest, row) => Math.max(widest, row.length), header?.length ?? 0)
    const kinds = Array.from({ length: width }, (_, column) => csvColumnKind(body, column))
    return { table, header, body, width, kinds, numeric: numericCsvColumns(body) }
  }, [parsed])

  if (!model) {
    const empty = parsed.kind === 'empty'
    return (
      <EmptyState
        className="v3-preview-csv-empty"
        data-testid={empty ? 'v3-preview-csv-empty' : 'v3-preview-csv-failed'}
        title={empty ? labels.csvEmpty : labels.csvFailed}
        description={empty ? undefined : labels.csvFailedHint}
      />
    )
  }

  const { table, header, body, width, kinds, numeric } = model
  const active = sort && header && header[sort.column] === sort.header ? sort : null
  const order = active ? sortCsvRowOrder(body, active, kinds[active.column] ?? 'text', lang) : body.map((_, index) => index)
  const shown = filterCsvRowOrder(body, order, query)
  const caption = truncationCaption(table, labels)
  const filtered = query.trim() !== ''
  const count = filtered ? fill(labels.csvShownRows, { shown: shown.length, total: body.length }) : fill(labels.csvRowCount, { n: body.length })

  const toggle = (column: number, label: string): void => {
    const direction: CsvSort | null =
      active?.column === column ? (active.direction === 'asc' ? { column, header: label, direction: 'desc' } : null) : { column, header: label, direction: 'asc' }
    setSort(direction)
  }

  return (
    <div className="v3-preview-csv" data-testid="v3-preview-csv" data-file-name={name}>
      <div className="v3-preview-csv-bar">
        <SearchField
          className="v3-preview-csv-filter"
          aria-label={labels.csvFilterRows}
          placeholder={labels.csvFilterRows}
          value={query}
          onChange={setQuery}
        />
        <span className="v3-preview-csv-count" aria-live="polite">
          {count}
        </span>
      </div>
      {caption ? (
        <p className="v3-preview-csv-note" role="status">
          {caption}
        </p>
      ) : null}
      <div className="v3-preview-csv-scroll" role="region" aria-label={labels.csvTableLabel} tabIndex={0}>
        <table className="v3-preview-csv-table">
          {header ? (
            <thead>
              <tr>
                {header.map((label, column) => {
                  const direction = active?.column === column ? active.direction : null
                  const sortLabel = fill(labels.csvSortBy, { column: label === '' ? String(column + 1) : label })
                  return (
                    <th
                      key={column}
                      scope={label === '' ? undefined : 'col'}
                      data-numeric={numeric.has(column) || undefined}
                      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
                    >
                      <span className="v3-preview-csv-head">
                        <span className="v3-preview-csv-head-label">{label}</span>
                        <IconButton size="sm" aria-label={sortLabel} tooltip={sortLabel} onPress={() => toggle(column, label)}>
                          {direction === 'asc' ? (
                            <ChevronUp size={14} />
                          ) : direction === 'desc' ? (
                            <ChevronDown size={14} />
                          ) : (
                            <ChevronsUpDown size={14} />
                          )}
                        </IconButton>
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {shown.map((index) => (
              <tr key={index}>
                {Array.from({ length: width }, (_, column) => (
                  <td key={column} data-numeric={numeric.has(column) || undefined}>
                    {body[index][column] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated ? (
        <p className="v3-preview-csv-note" role="status">
          {labels.csvMissingEnd}
        </p>
      ) : null}
    </div>
  )
}
