import { useState, type ReactElement } from 'react'
import { Collapsible, CollapsibleHeader, CollapsiblePanel, EmptyState, Notice, Tab, TabList, Tabs } from '../../ui'
import { useT } from '../../i18n'
import {
  OFFICE_MAX_LINES,
  OFFICE_MAX_SHEET_COLUMNS,
  OFFICE_MAX_SHEET_ROWS,
  officeColumnName,
  type OfficeDocxBlock,
  type OfficeDocumentView,
  type OfficeSheet,
  type OfficeSlide,
  type OfficeSection,
  type OfficeTextRun
} from '../../../../shared/office'
import type { PreviewText } from './preview-text'
import './office-view.css'

function RunText({ runs }: { runs: OfficeTextRun[] }): ReactElement {
  return (
    <>
      {runs.map((run, index) => {
        const content = run.bold && run.italic ? (
          <strong>
            <em>{run.text}</em>
          </strong>
        ) : run.bold ? (
          <strong>{run.text}</strong>
        ) : run.italic ? (
          <em>{run.text}</em>
        ) : (
          run.text
        )
        return <span key={index}>{content}</span>
      })}
    </>
  )
}

function DocumentTable({ rows }: { rows: string[][] }): ReactElement {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  const headered = rows.length > 1 && rows[0].length > 0 && rows[0].every((cell) => cell.trim() !== '')
  return (
    <div className="v3-office-tablewrap">
      <table className="v3-office-table">
        {headered ? (
          <thead>
            <tr>
              {rows[0].map((cell, column) => (
                <th key={column} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {(headered ? rows.slice(1) : rows).map((row, index) => (
            <tr key={index}>
              {Array.from({ length: width }, (_, column) => (
                <td key={column}>{row[column] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DocumentBlocks({ blocks }: { blocks: OfficeDocxBlock[] }): ReactElement {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <p key={index} className="v3-office-heading" role="heading" aria-level={block.level} data-level={block.level}>
              {block.text}
            </p>
          )
        }
        if (block.kind === 'table') return <DocumentTable key={index} rows={block.rows} />
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul'
          return (
            <List key={index} className="v3-office-list">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </List>
          )
        }
        return (
          <p key={index} className="v3-office-paragraph">
            <RunText runs={block.runs} />
          </p>
        )
      })}
    </>
  )
}

function NumericCell(value: string | undefined): boolean {
  if (!value) return false
  return /^-?\d+(?:[.,]\d+)?%?$/.test(value.trim())
}

function SheetTable({ sheet }: { sheet: OfficeSheet }): ReactElement {
  const t = useT()
  if (!sheet.rows.length) {
    return <EmptyState className="v3-office-sheet-empty" data-testid="v3-office-sheet-empty" title={t('preview.office.sheetEmpty')} />
  }
  const columns = sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  const firstRow = sheet.startRow ?? 1
  const firstColumn = sheet.startColumn ?? 0
  return (
    <div className="v3-office-sheet-scroll" role="region" aria-label={t('preview.office.sheetTable')} tabIndex={0}>
      <table className="v3-office-sheet-table">
        <thead>
          <tr>
            <th className="v3-office-sheet-corner" scope="col">
              <span aria-hidden>#</span>
            </th>
            {Array.from({ length: columns }, (_, column) => (
              <th key={column} scope="col">
                {officeColumnName(firstColumn + column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, index) => (
            <tr key={index}>
              <th className="v3-office-sheet-rowhead" scope="row">
                {firstRow + index}
              </th>
              {Array.from({ length: columns }, (_, column) => (
                <td key={column} data-numeric={NumericCell(row[column]) || undefined}>
                  {row[column] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WorkbookSheets({ sheets }: { sheets: OfficeSheet[] }): ReactElement {
  const t = useT()
  const [active, setActive] = useState('0')
  const index = Math.min(Math.max(0, Number(active) || 0), sheets.length - 1)
  const sheet = sheets[index]
  return (
    <div className="v3-office-sheets" data-testid="v3-preview-office-sheets">
      <Tabs
        className="v3-office-sheet-tabs"
        selectedKey={String(index)}
        onSelectionChange={(key) => setActive(String(key))}
      >
        <TabList aria-label={t('preview.office.sheetTabs')}>
          {sheets.map((item, position) => (
            <Tab key={position} id={String(position)}>
              {item.name}
            </Tab>
          ))}
        </TabList>
      </Tabs>
      <SheetTable sheet={sheet} />
      {sheet.truncated ? (
        <p className="v3-office-note" role="status">
          {t('preview.office.sheetTruncated', { rows: OFFICE_MAX_SHEET_ROWS, cols: OFFICE_MAX_SHEET_COLUMNS })}
        </p>
      ) : null}
    </div>
  )
}

function SlideCard({ slide }: { slide: OfficeSlide }): ReactElement {
  const t = useT()
  return (
    <section className="v3-office-slide" data-testid="v3-office-slide">
      <header className="v3-office-slide-head">
        <span className="v3-office-slide-number">{t('preview.office.slidePage', { n: slide.index })}</span>
        {slide.title ? <p className="v3-office-slide-title">{slide.title}</p> : null}
      </header>
      <div className="v3-office-slide-body">
        {slide.bullets.length ? (
          <ul className="v3-office-list">
            {slide.bullets.map((bullet, index) => (
              <li key={index}>{bullet}</li>
            ))}
          </ul>
        ) : null}
        {slide.notes?.length ? (
          <Collapsible className="v3-office-slide-notes">
            <CollapsibleHeader>{t('preview.office.slideNotes')}</CollapsibleHeader>
            <CollapsiblePanel>
              <div className="v3-office-slide-notebody">
                {slide.notes.map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ) : null}
      </div>
    </section>
  )
}

function PlainSections({
  sections,
  note,
  truncated,
  labels
}: {
  sections: OfficeSection[]
  note: string
  truncated: boolean
  labels: PreviewText
}): ReactElement {
  const total = sections.reduce((sum, section) => sum + section.lines.length, 0)
  return (
    <div className="v3-office" data-testid="v3-preview-office">
      {sections.map((section, index) => (
        <section key={index} className="v3-preview-office-section">
          <h4 className="v3-preview-office-title">{section.title}</h4>
          <pre className="v3-preview-code">
            <code>{section.lines.join('\n')}</code>
          </pre>
        </section>
      ))}
      <div className="v3-preview-note">
        {note}
        {truncated || total > OFFICE_MAX_LINES ? ` ${labels.truncated}` : ''}
      </div>
      <div className="v3-preview-hint">{labels.officeNote}</div>
    </div>
  )
}

export function OfficeView({ view, labels }: { view: OfficeDocumentView; labels: PreviewText }): ReactElement {
  const t = useT()
  if (!view.ok) {
    return (
      <Notice tone="fail" className="v3-preview-error" data-testid="v3-preview-office-error">
        {view.error}
      </Notice>
    )
  }
  const footer = (
    <>
      <div className="v3-preview-note">
        {view.note}
        {view.truncated ? ` ${labels.truncated}` : ''}
      </div>
      <div className="v3-preview-hint">{labels.officeNote}</div>
    </>
  )
  if (view.format === 'docx' && view.blocks && view.blocks.length) {
    return (
      <div className="v3-office" data-testid="v3-preview-office" data-office-format="docx">
        <article className="v3-office-doc" aria-label={t('preview.office.document')}>
          <DocumentBlocks blocks={view.blocks} />
        </article>
        {footer}
      </div>
    )
  }
  if (view.format === 'xlsx' && view.sheets && view.sheets.length) {
    return (
      <div className="v3-office v3-office--sheet" data-testid="v3-preview-office" data-office-format="xlsx">
        <WorkbookSheets sheets={view.sheets} />
        {footer}
      </div>
    )
  }
  if (view.format === 'pptx' && view.slides && view.slides.length) {
    return (
      <div className="v3-office v3-office--slides" data-testid="v3-preview-office" data-office-format="pptx">
        <div className="v3-office-slides">
          {view.slides.map((slide) => (
            <SlideCard key={slide.index} slide={slide} />
          ))}
        </div>
        {footer}
      </div>
    )
  }
  return <PlainSections sections={view.sections} note={view.note} truncated={view.truncated} labels={labels} />
}
