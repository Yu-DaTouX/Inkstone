import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Section } from './ToolSection'
import type { DirListing } from '../../../../shared/ipc'

/**
 * 文件树（右栏分区）。
 *
 * ── 设计约束 ──
 * ① **懒加载，一层一次**。不做递归预扫：cwd 可能是整个仓库，
 *    递归会把主进程卡住（`node_modules` 一个目录就能有几万条）。
 * ② 点击文件 = 往输入框插一个 `@相对路径`（复用已有的 @ 文件引用机制），
 *    而不是打开文件 —— 这个应用的正文区是对话，不是编辑器。
 *    用户要的是「把哪个文件交给 agent」，不是「看文件内容」。
 * ③ 目录默认折叠。展开状态与已加载的内容都缓存在本组件内 ——
 *    折叠再展开不重新拉（目录内容在一次会话里基本不变）。
 * ④ 换 cwd 必须清空缓存（否则会拿旧项目的目录树当新的）。
 *
 * ── 与 completePath（@ 补全）的关系 ──
 * 两者共用同一个安全边界（见 main/files.ts）：都只能看 cwd 以内的路径。
 * 但用途不同 —— 补全是「我记得名字，帮我补全」，
 * 文件树是「我不知道有什么，让我看看」。
 */
export function FileTree() {
  const t = useT()
  const cwd = useStore((s) => s.settings?.cwd)

  /** 路径（'' = 根）→ 该层内容。null = 加载失败 */
  const [cache, setCache] = useState<Record<string, DirListing | null>>({})
  const [open, setOpen] = useState<Set<string>>(new Set(['']))
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  /**
   * 是否列出隐藏项（.gitignore / .vscode / node_modules / .git 这类）。
   *
   * 用户要求：「已跳过改为已隐藏，加一个开关」。
   * 定位：它是**临时看一眼**的动作（找一个被点掉的文件、确认 .git 在不在），
   * 不值得落盘变成永久偏好 —— 所以只存在这个组件的 state 里，重启回默认。
   */
  const [showHidden, setShowHidden] = useState(false)

  /* 换 cwd → 整个树作废 */
  useEffect(() => {
    setCache({})
    setOpen(new Set(['']))
    setError(null)
  }, [cwd, showHidden])

  const load = useCallback(
    async (path: string) => {
      setLoading((s) => new Set(s).add(path))
      try {
        const r = await window.yan.listDir(path, showHidden)
        setCache((c) => ({ ...c, [path]: r }))
        setError(null)
      } catch {
        setCache((c) => ({ ...c, [path]: null }))
        setError(t('rp.fsError'))
      } finally {
        setLoading((s) => {
          const n = new Set(s)
          n.delete(path)
          return n
        })
      }
    },
    [t, showHidden]
  )

  /* 根层一定要有内容（展开状态里 '' 默认就在） */
  useEffect(() => {
    if (!cwd) return
    if (cache[''] === undefined && !loading.has('')) void load('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, cache[''], load])

  const toggleDir = useCallback(
    (path: string) => {
      setOpen((prev) => {
        const n = new Set(prev)
        if (n.has(path)) {
          n.delete(path)
        } else {
          n.add(path)
          if (cache[path] === undefined) void load(path)
        }
        return n
      })
    },
    [cache, load]
  )

  const refresh = useCallback(() => {
    // 只刷新**已展开**的层，不把没看过的目录也拉一遍
    for (const p of open) void load(p)
  }, [open, load])

  const rootName = cache['']?.rootName ?? t('rp.fsRoot')
  const total = useMemo(
    () => Object.values(cache).reduce((n, l) => n + (l?.entries.length ?? 0), 0),
    [cache]
  )

  return (
    <Section
      titleKey="rp.files"
      testId="rp-files"
      extra={
        <>
          <span className="rp-count" data-testid="fs-count">
            {total}
          </span>
          <button
            className={`rp-mini ${showHidden ? 'on' : ''}`}
            data-testid="fs-hidden-toggle"
            title={showHidden ? t('rp.fsHideHidden') : t('rp.fsShowHidden')}
            aria-pressed={showHidden}
            onClick={(e) => {
              e.stopPropagation()
              setShowHidden((v) => !v)
            }}
          >
            <Icon name={showHidden ? 'sun' : 'moon'} size={12} />
          </button>
          <button
            className="rp-mini"
            data-testid="fs-refresh"
            title={t('rp.fsRefresh')}
            onClick={(e) => {
              e.stopPropagation()
              refresh()
            }}
          >
            <Icon name="refresh" size={12} />
          </button>
        </>
      }
    >
      <div className="rp-fs" data-testid="fs-tree">
        <TreeRow
          path=""
          name={rootName}
          dir
          depth={0}
          open={open.has('')}
          loading={loading.has('')}
          onToggle={toggleDir}
        />
        {open.has('') ? (
          <TreeLevel
            listing={cache[''] ?? null}
            depth={1}
            open={open}
            loading={loading}
            cache={cache}
            onToggle={toggleDir}
            onPick={(p) => pickIntoComposer(p)}
          />
        ) : null}
      </div>

      {error ? <div className="rp-dim rp-fs-err">{error}</div> : null}
      {cache['']?.skipped.length ? (
        <div className="rp-dim" data-testid="fs-skipped">
          {/*
            * 用户要求把「已跳过」改成「已隐藏」——
            * 「跳过」听起来像程序跳过了它们（可能漏内容），
            * 「隐藏」才是事实：它们还在，点上面的开关就显示。
            */}
          {t('rp.fsHidden', { names: cache[''].skipped.join('、') })}
        </div>
      ) : null}
    </Section>
  )
}

/**
 * 把 `@相对路径` 插进输入框。
 *
 * 复用 store 的 `editorInject` —— 那是扩展 set_editor_text 用的通道，
 * 行为一致（Composer 会把它并进当前草稿并清空该字段）。
 * 不自己往 Composer 里塞状态：草稿是 Composer 的私有 state，
 * 外部改它需要一条正式的通道，而这条已经存在且有测试覆盖。
 */
function pickIntoComposer(rel: string): void {
  const path = rel.replace(/\\/g, '/')
  // 含空格的路径要引号包起来，否则 pi 会把它拆成多个 @ 参数
  const needQuote = /\s/.test(path)
  useStore.setState({ editorInject: needQuote ? `@"${path}"` : `@${path}` })
}



/** 一层的内容（根下面的所有条目） */
function TreeLevel({
  listing,
  depth,
  open,
  loading,
  cache,
  onToggle,
  onPick
}: {
  listing: DirListing | null
  depth: number
  open: Set<string>
  loading: Set<string>
  cache: Record<string, DirListing | null>
  onToggle: (p: string) => void
  onPick: (rel: string) => void
}) {
  const t = useT()

  if (listing === null) return <div className="rp-dim" style={{ paddingLeft: depth * 12 }}>—</div>
  if (listing.entries.length === 0) {
    return (
      <div className="rp-dim" style={{ paddingLeft: depth * 12 + 14 }}>
        {t('rp.fsEmpty')}
      </div>
    )
  }

  return (
    <>
      {listing.entries.map((e) => {
        const childPath = listing.path ? `${listing.path}/${e.name}` : e.name
        const isOpen = e.dir && open.has(childPath)
        return (
          <div key={childPath} className="rp-fs-node">
            <TreeRow
              path={childPath}
              name={e.name}
              dir={e.dir}
              size={e.size}
              depth={depth}
              open={isOpen}
              loading={e.dir && loading.has(childPath)}
              onToggle={onToggle}
              onPick={onPick}
            />
            {isOpen ? (
              <TreeLevel
                listing={cache[childPath] ?? null}
                depth={depth + 1}
                open={open}
                loading={loading}
                cache={cache}
                onToggle={onToggle}
                onPick={onPick}
              />
            ) : null}
          </div>
        )
      })}
      {listing.truncated ? (
        <div className="rp-dim" style={{ paddingLeft: depth * 12 + 14 }}>
          {t('rp.fsMore')}
        </div>
      ) : null}
    </>
  )
}

function TreeRow({
  path,
  name,
  dir,
  size,
  depth,
  open,
  loading,
  onToggle,
  onPick
}: {
  path: string
  name: string
  dir: boolean
  size?: number
  depth: number
  open: boolean
  loading?: boolean
  onToggle: (p: string) => void
  onPick?: (rel: string) => void
}) {
  const [hot, setHot] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  /*
   * 点击后的短暂高亮：「已插入 @路径」必须看得见 ——
   * 否则用户不知道点这一下发生了什么（输入框可能在视野下方）。
   */
  useEffect(() => {
    if (!hot) return
    const id = setTimeout(() => setHot(false), 700)
    return () => clearTimeout(id)
  }, [hot])

  return (
    <button
      ref={ref}
      className={`rp-fs-row ${dir ? 'dir' : 'file'} ${hot ? 'hot' : ''}`}
      style={{ paddingLeft: 4 + depth * 12 }}
      data-path={path}
      data-dir={dir ? '1' : '0'}
      data-testid={`fs-row-${path || 'root'}`}
      title={dir ? name : `${name}${size !== undefined ? ` · ${fmtSize(size)}` : ''}`}
      onClick={() => {
        if (dir) onToggle(path)
        else {
          setHot(true)
          onPick?.(path)
        }
      }}
    >
      {dir ? (
        <Icon name={open ? 'folder-open' : 'folder'} size={12} className="rp-fs-ico" />
      ) : (
        <span className="rp-fs-dot" aria-hidden />
      )}
      <span className="rp-fs-name">{name}</span>
      {dir && loading ? <span className="rp-fs-spin" aria-hidden /> : null}
      {!dir && size !== undefined ? <span className="rp-fs-size">{fmtSize(size)}</span> : null}
    </button>
  )
}

/** 1023 B → 1023B，1.4 KB，2.1 MB（文件树里只需量级，不要精度） */
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n / 1024 < 10 ? 1 : 0)}K`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}
