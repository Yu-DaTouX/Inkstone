import { useMemo, useState, type ReactElement } from 'react'
import { BookOpen, Code2 } from 'lucide-react'
import { Button, EmptyState, IconButton } from '../../ui'
import { useT } from '../../i18n'
import { Markdown } from '../session/Markdown'
import type { PreviewText } from './preview-text'
import { notebookFence, parseNotebook, type NotebookCell, type NotebookOutput } from './notebook'
import './notebook-view.css'

const CELL_STEP = 20

function OutputBlock({ output }: { output: NotebookOutput }): ReactElement {
  const t = useT()
  if (output.kind === 'image') {
    return (
      <div className="v3-notebook-output v3-notebook-output--image">
        <img src={output.dataUrl} alt="" loading="lazy" />
      </div>
    )
  }
  if (output.kind === 'mime') {
    return <div className="v3-notebook-output v3-notebook-output--mime">{t('preview.notebook.mime', { mime: output.mime })}</div>
  }
  return <pre className="v3-notebook-output">{output.text}</pre>
}

function CellBlock({ cell, index, language }: { cell: NotebookCell; index: number; language: string }): ReactElement {
  const t = useT()
  const badge =
    cell.kind === 'code'
      ? cell.executionCount === null
        ? t('preview.notebook.inEmpty')
        : t('preview.notebook.in', { n: cell.executionCount })
      : cell.kind === 'markdown'
        ? t('preview.notebook.markdown')
        : t('preview.notebook.raw')
  return (
    <section className="v3-notebook-cell" data-kind={cell.kind}>
      <header className="v3-notebook-cellhead">
        <span className="v3-notebook-badge">{badge}</span>
        <span className="v3-notebook-index">{index + 1}</span>
      </header>
      {cell.kind === 'markdown' ? (
        cell.markdown.trim() ? (
          <div className="v3-notebook-md">
            <Markdown text={cell.markdown} />
          </div>
        ) : null
      ) : cell.source.trim() ? (
        <div className="v3-notebook-source">
          {cell.kind === 'code' ? <Markdown text={notebookFence(cell.source, language)} /> : <pre className="v3-notebook-raw">{cell.source}</pre>}
        </div>
      ) : null}
      {cell.outputs.map((output, position) => (
        <OutputBlock key={position} output={output} />
      ))}
    </section>
  )
}

export function NotebookView({ text, name, labels }: { text: string; name: string; labels: PreviewText }): ReactElement {
  const t = useT()
  const parsed = useMemo(() => parseNotebook(text), [text])
  const [visible, setVisible] = useState(CELL_STEP)
  const [source, setSource] = useState(false)
  const summary = parsed.kind === 'ok' ? t('preview.notebook.summary', { cells: parsed.cells.length, language: parsed.language }) : name
  return (
    <div className="v3-notebook" data-testid="v3-preview-notebook" data-file-name={name}>
      <div className="v3-notebook-bar">
        <span role="status">{summary}</span>
        <span className="v3-notebook-hint">{t('preview.notebook.savedOnly')}</span>
        <IconButton
          size="sm"
          className="v3-notebook-mode"
          aria-label={source ? labels.readingMode : labels.sourceMode}
          tooltip={source ? labels.readingMode : labels.sourceMode}
          aria-pressed={source}
          data-testid="v3-notebook-source-toggle"
          onPress={() => setSource((value) => !value)}
        >
          {source ? <BookOpen size={14} /> : <Code2 size={14} />}
        </IconButton>
      </div>
      <div className="v3-notebook-scroll">
        {source ? (
          <pre className="v3-notebook-rawfile">{text}</pre>
        ) : parsed.kind === 'empty' ? (
          <EmptyState className="v3-notebook-empty" data-testid="v3-preview-notebook-empty" title={t('preview.notebook.empty')} />
        ) : parsed.kind === 'failed' ? (
          <EmptyState
            className="v3-notebook-empty"
            data-testid="v3-preview-notebook-failed"
            title={t('preview.notebook.failed')}
            description={t('preview.notebook.failedHint')}
          />
        ) : (
          <>
            {parsed.cells.slice(0, visible).map((cell, index) => (
              <CellBlock key={index} cell={cell} index={index} language={parsed.language} />
            ))}
            {visible < parsed.cells.length ? (
              <Button size="sm" variant="secondary" onPress={() => setVisible((value) => value + CELL_STEP)}>
                {t('preview.notebook.showMore', { n: parsed.cells.length - visible })}
              </Button>
            ) : null}
            {parsed.hiddenCells > 0 ? (
              <p className="v3-notebook-note">
                {t('preview.notebook.hiddenCells', { shown: parsed.cells.length, total: parsed.cells.length + parsed.hiddenCells })}
              </p>
            ) : null}
            {parsed.hiddenOutputs > 0 ? <p className="v3-notebook-note">{t('preview.notebook.hiddenOutputs')}</p> : null}
          </>
        )}
      </div>
    </div>
  )
}
