import type { FindBarOption } from '../../ui'
import type { FindOptions } from './code-find'

export interface FindOptionLabels {
  findMatchCase: string
  findWholeWord: string
  findRegexp: string
}

export function findOptionEntries(labels: FindOptionLabels, options: FindOptions): FindBarOption[] {
  return [
    { id: 'matchCase', label: labels.findMatchCase, icon: <span className="v3-code-find-glyph">Aa</span>, selected: options.matchCase },
    { id: 'wholeWord', label: labels.findWholeWord, icon: <span className="v3-code-find-glyph" data-word="">ab</span>, selected: options.wholeWord },
    { id: 'regexp', label: labels.findRegexp, icon: <span className="v3-code-find-glyph">.*</span>, selected: options.regexp }
  ]
}

export function isFindOptionKey(id: string): id is keyof FindOptions {
  return id === 'matchCase' || id === 'wholeWord' || id === 'regexp'
}
