/**
 * 变更文件树（只含**有改动**的文件）。
 *
 * 与右栏那个 FileTree 的区别：那个是「浏览整个工作目录」（一层一层懒加载），
 * 这个是「这次改动的全景」（一次全给，因为没有几万个改动文件）。
 * 所以两者的数据来源与交互都不同，没有合并成一个组件。
 *
 * 交互：目录可折叠、按状态筛选、已查看进度、点文件显示它的 diff。
 * 窄面板时导航排在当前文件差异的上方。
 */
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { GitChangedFile, GitChangeStatus } from '../../../../shared/ipc'
import { useT } from '../../i18n'

export interface FileTreeNode {
  /** 目录名或文件名（不含父路径） */
  name: string
  /** 完整路径（目录也有） */
  path: string
  dir: boolean
  children: FileTreeNode[]
  file?: GitChangedFile
}

/** 把扁平的改动列表折成目录树（纯函数，方便单测与复用） */
export function buildFileTree(files: GitChangedFile[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', dir: true, children: [] }
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean)
    let cur = root
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1
      const name = parts[i]
      const path = parts.slice(0, i + 1).join('/')
      let next = cur.children.find((c) => c.name === name && c.dir === !isLeaf)
      if (!next) {
        next = { name, path, dir: !isLeaf, children: [] }
        cur.children.push(next)
      }
      if (isLeaf) next.file = f
      cur = next
    }
  }
  /* 目录在前、同级按名字排（数字感知，`file2` 在 `file10` 前面） */
  const sort = (nodes: FileTreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
    })
    for (const n of nodes) sort(n.children)
  }
  sort(root.children)
  return root.children
}

/** 单字符状态标记（与 git 的 XY 一致，界面上一眼能看出改的是什么） */
export function statusGlyph(status: GitChangeStatus): string {
  switch (status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'modified':
      return 'M'
    case 'typechange':
      return 'T'
    case 'unmerged':
      return 'U'
    case 'untracked':
      return '?'
    default:
      return '·'
  }
}

type Filter = 'all' | 'text' | 'image' | 'other'

export interface ChangedFileTreeProps {
  files: GitChangedFile[]
  selected: string | null
  onSelect: (file: GitChangedFile) => void
  isViewed: (file: GitChangedFile) => boolean
  viewedCount: number
}

export function ChangedFileTree({ files, selected, onSelect, isViewed, viewedCount }: ChangedFileTreeProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return files.filter((f) => {
      if (q && !f.path.toLowerCase().includes(q)) return false
      if (filter === 'text') return f.kind === 'text' || f.kind === 'symlink'
      if (filter === 'image') return f.kind === 'image'
      if (filter === 'other') return f.kind !== 'text' && f.kind !== 'image'
      return true
    })
  }, [files, query, filter])

  const tree = useMemo(() => buildFileTree(filtered), [filtered])

  const toggle = (path: string): void =>
    setCollapsed((p) => {
      const next = new Set(p)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="rtree" data-testid="review-tree">
      <div className="rtree-head">
        <input
          className="rtree-search"
          value={query}
          placeholder={t('review.filter')}
          data-testid="review-filter"
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('review.filter')}
        />
        <div className="rtree-filters" role="group" aria-label={t('review.filterKind')}>
          {(['all', 'text', 'image', 'other'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`rtree-chip ${filter === f ? 'on' : ''}`}
              onClick={() => setFilter(f)}
              data-testid={`review-filter-${f}`}
            >
              {t(`review.kind.${f}` as 'review.kind.all')}
            </button>
          ))}
        </div>
      </div>

      <div className="rtree-progress" data-testid="review-progress">
        <span className="rtree-bar" aria-hidden="true">
          <span
            className="rtree-bar-fill"
            style={{ width: `${files.length ? Math.round((viewedCount / files.length) * 100) : 0}%` }}
          />
        </span>
        <span className="rtree-bar-text">
          {t('review.viewedProgress', { n: viewedCount, total: files.length })}
        </span>
      </div>

      <div className="rtree-list" role="tree">
        {tree.length === 0 ? <div className="rtree-empty">{t('review.noMatch')}</div> : null}
        {tree.map((n) => (
          <Node
            key={n.path}
            node={n}
            depth={0}
            collapsed={collapsed}
            onToggle={toggle}
            selected={selected}
            onSelect={onSelect}
            isViewed={isViewed}
          />
        ))}
      </div>
    </div>
  )
}

function Node(props: {
  node: FileTreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (p: string) => void
  selected: string | null
  onSelect: (f: GitChangedFile) => void
  isViewed: (f: GitChangedFile) => boolean
}): ReactElement {
  const { node, depth, collapsed, onToggle, selected, onSelect, isViewed } = props
  const pad = { paddingLeft: `${depth * 12 + 6}px` }

  if (node.dir) {
    const closed = collapsed.has(node.path)
    return (
      <>
        <button type="button" className="rtree-dir" style={pad} onClick={() => onToggle(node.path)} aria-expanded={!closed}>
          <span className={`chev ${closed ? '' : 'open'}`} aria-hidden="true">▸</span>
          <span className="rtree-dir-name">{node.name}</span>
        </button>
        {closed
          ? null
          : node.children.map((c) => (
              <Node
                key={c.path}
                {...props}
                node={c}
                depth={depth + 1}
              />
            ))}
      </>
    )
  }

  const f = node.file
  if (!f) return <></>
  const viewed = isViewed(f)
  return (
    <button
      type="button"
      className={`rtree-file ${selected === f.path ? 'on' : ''} ${viewed ? 'viewed' : ''}`}
      style={pad}
      onClick={() => onSelect(f)}
      data-testid="review-tree-file"
      data-path={f.path}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
    >
      <span className={`rtree-glyph st-${f.status}`} aria-hidden="true">{statusGlyph(f.status)}</span>
      <span className="rtree-file-name">{node.name}</span>
      {f.additions || f.deletions ? (
        <span className="rtree-stat">
          {f.additions ? <span className="add">+{f.additions}</span> : null}
          {f.deletions ? <span className="del">-{f.deletions}</span> : null}
        </span>
      ) : null}
    </button>
  )
}
