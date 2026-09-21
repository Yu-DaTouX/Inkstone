import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { SourceLinkView, SourceRefView } from '../../../../shared/ipc'

/**
 * 来源菜单（方案 §8 的 S1）。
 *
 * ── 三类来源，各自的存在方式不同（这一点决定了实现）──
 *
 * | 类 | 我们持有字节吗 | 所以 |
 * |---|---|---|
 * | 图片 | **持有**（存到数据目录，按会话隔离） | 可以显示缩略图、可以真的删掉副本 |
 * | 文件 | **不持有**（只登记路径与 size:mtime 指纹） | 只能告诉用户"还在不在"，**永不删原文件** |
 * | 网页 | 不持有（只有 URL 与标题） | 只负责打开 |
 *
 * ── 状态只有两态，这是有意的（方案 §8）──
 * 「已关联」= 登记在案；「已读取」需要 pi 真的读过它。方案的原话是
 * 「证据不足时不显示后一状态」—— 所以我们不显示「已读取」，也不显示
 * 「本轮已参与上下文」（那个由发送时的附件列表决定，属于另一处 UI）。
 * 宁可少显示一个状态，也不显示一个我们证明不了的状态。
 *
 * ── 移除外键语义 ──
 * 「移除」删的是**会话对这个来源的引用**：图片连副本一起删（那是我们存的），
 * 文件**只删登记**（原文件是用户的），网页只删登记。并且**不改写已发送的历史**。
 */
export type SourceFilter = 'all' | 'image' | 'file' | 'web'

interface FileRef {
  path: string
  name: string
  addedAt: number
}

const FILE_KEY = 'yan.source-files.v1'
const WEB_KEY = 'yan.source-links.v1'

export interface WebLink {
  id: string
  sessionId: string
  url: string
  title: string
  addedAt: number
}

function loadJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function saveJson(key: string, list: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, 200)))
  } catch {
    /* 存不下不影响本次会话里看到的东西 */
  }
}

function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

export function SourceMenu({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose?: () => void }): React.JSX.Element {
  const t = useT()
  const locateMessage = useStore((s) => s.locateMessage)
  const injectComposerText = useStore((s) => s.injectComposerText)
  const [images, setImages] = useState<SourceRefView[]>([])
  const [files, setFiles] = useState<SourceRefView[]>([])
  const [webs, setWebs] = useState<SourceRefView[]>([])
  const [links, setLinks] = useState<SourceLinkView[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [bad, setBad] = useState(false)
  const [dir, setDir] = useState('')
  /*
   * 网页**搜索**入口（实施-07 S4）：只有在已发现兼容搜索能力时才出现。
   *
   * 为什么不在这里自己发搜索请求：方案明写「不要自造私有搜索后端」——
   * 搜索能力由用户接入的 MCP 工具 / 技能提供，宿主只负责“发现 + 把它交给模型”。
   * 所以这个入口做的事是**往输入区写一条草稿**，让用户确认后发送。
   */
  const [webSearch, setWebSearch] = useState<{ available: boolean; title?: string; location?: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  /*
   * 迟到的响应要丢掉：来源按会话隔离，切会话后上一轮的 list/verifyFiles 可能
   * 才回来 —— 那会把 A 会话的来源画到 B 会话的面板上。
   */
  const gate = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++gate.current
    const current = sessionId
    try {
      const listed = await window.yan.sources.list(current)
      if (gate.current !== mine) return
      setImages(listed.images ?? [])
      setDir(listed.dir ?? '')
      setLinks(listed.links ?? [])
    } catch {
      if (gate.current === mine) setImages([])
    }
    /* 文件引用：登记在本地，由主进程复核「还在不在」 */
    const refs = loadJson<FileRef>(FILE_KEY).filter((x) => x.path)
    try {
      const verified = await window.yan.sources.verifyFiles({ sessionId: current, entries: refs })
      if (gate.current === mine) setFiles(verified)
    } catch {
      if (gate.current === mine) setFiles([])
    }
    /* 网页：纯本地记录（登记 URL + 标题，不抓正文）。**搜索**是另一件事：
       只有已发现兼容搜索能力时菜单里才出现那枚入口，见下方 `webSearch` */
    const links = loadJson<WebLink>(WEB_KEY).filter((x) => x.sessionId === current)
    if (gate.current !== mine) return
    setWebs(
      links.map((l) => ({
        sourceId: `web:${l.id}`,
        sessionId: current,
        kind: 'web' as const,
        title: l.title || l.url,
        ref: l.url,
        fingerprint: l.url,
        origin: l.url,
        addedAt: l.addedAt,
        available: true
      }))
    )
  }, [sessionId])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  /* 能力目录查询单独一次（它会真连 MCP 服务，不能跟着每次 refresh 跑） */
  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      try {
        const res = await window.yan.sources.webSearch()
        if (alive) setWebSearch(res ?? { available: false })
      } catch {
        /* 查不到就当没有：入口是增益，不该因为能力服务抖动而报错 */
        if (alive) setWebSearch({ available: false })
      }
    })()
    return () => {
      alive = false
    }
  }, [open])

  /* 缩略图按需读：一次读一张，失败就留着占位（不静默消失） */
  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      for (const img of images) {
        if (thumbs[img.sourceId]) continue
        const res = await window.yan.sources.readImage({ sessionId, sourceId: img.sourceId })
        if (!alive) return
        if (res.ok && res.base64) {
          setThumbs((prev) => ({ ...prev, [img.sourceId]: `data:${res.mime ?? 'image/png'};base64,${res.base64}` }))
        }
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, images, sessionId])

  const all: SourceRefView[] = [...images, ...files, ...webs].sort((a, b) => b.addedAt - a.addedAt)
  const shown = filter === 'all' ? all : all.filter((x) => x.kind === filter)

  const removeOne = async (item: SourceRefView): Promise<void> => {
    if (item.kind === 'image') {
      /* 图片：连**我们存的副本**一起删 */
      await window.yan.sources.removeImage({ sessionId, sourceId: item.sourceId }).catch(() => undefined)
    } else if (item.kind === 'file') {
      /* 文件：只删登记 —— 原文件是用户的，这一层永远不碰 */
      saveJson(
        FILE_KEY,
        loadJson<FileRef>(FILE_KEY).filter((x) => x.path !== item.ref)
      )
    } else {
      saveJson(
        WEB_KEY,
        loadJson<WebLink>(WEB_KEY).filter((x) => `web:${x.id}` !== item.sourceId)
      )
    }
    await refresh()
  }

  const addWeb = (): void => {
    const clean = normalizeUrl(url)
    if (!clean) {
      setBad(true)
      return
    }
    setBad(false)
    const links = loadJson<WebLink>(WEB_KEY)
    links.unshift({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      url: clean,
      title: title.trim() || new URL(clean).host,
      addedAt: Date.now()
    })
    saveJson(WEB_KEY, links)
    setUrl('')
    setTitle('')
    void refresh()
  }

  const counts = {
    all: all.length,
    image: images.length,
    file: files.length,
    web: webs.length
  }

  return (
    <div className="env-links" data-testid="env-source-menu">
      <div className="env-links-head">
        <Icon name="layers" size={14} />
        <span className="env-label">{t('src.title')}</span>
        <span className="env-sub">{counts.all > 0 ? String(counts.all) : ''}</span>
      </div>

      {/* 筛选：三类 + 全部。三类都为空时不显示（省一行噪声） */}
      {counts.all > 0 ? (
        <div className="src-filters">
          {(['all', 'image', 'file', 'web'] as SourceFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`src-filter ${filter === f ? 'sel' : ''}`}
              data-testid={`src-filter-${f}`}
              disabled={f !== 'all' && counts[f] === 0}
              onClick={() => setFilter(f)}
            >
              {t(`src.${f}`)} {f === 'all' ? counts.all : counts[f]}
            </button>
          ))}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <div className="env-carry-hint" data-testid="src-empty">
          {counts.all === 0 ? t('src.empty') : t('src.noneInFilter')}
        </div>
      ) : (
        <div className="src-list" data-testid="src-list">
          {shown.map((item) => (
            <div className="src-item" key={item.sourceId} data-testid="src-item">
              {item.kind === 'image' ? (
                thumbs[item.sourceId] ? (
                  <img className="src-thumb" src={thumbs[item.sourceId]} alt={item.title} data-testid="src-thumb" />
                ) : (
                  /* 还没读出来 / 读失败：留占位而不是留空白，用户知道这里有一张图 */
                  <span className="src-thumb src-thumb-empty" title={t('src.thumbPending')}>
                    <Icon name="layers" size={14} />
                  </span>
                )
              ) : (
                <span className="src-icon">
                  <Icon name={item.kind === 'web' ? 'globe' : 'folder'} size={14} />
                </span>
              )}

              <div className="src-meta">
                <span className="src-title" title={item.kind === 'file' ? item.ref : item.origin || item.title}>
                  {item.title}
                </span>
                {/* 状态只有「已关联」这一种能证明的；不可用要明说原因 */}
                <span className="src-tags">
                  <span className="src-tag">{t('src.linked')}</span>
                  {item.kind === 'file' && !item.available ? (
                    <span className="src-tag src-tag-bad" data-testid="src-unavailable">
                      {item.error ?? t('src.unavailable')}
                    </span>
                  ) : null}
                </span>
              </div>

              {/* 关联：只显示“能证明的”—— 有落盘关联才出现定位入口 */}
              {(() => {
                const mine = links.filter((l) => l.sourceId === item.sourceId)
                if (mine.length === 0) return null
                const latest = mine[mine.length - 1]
                return (
                  <button
                    type="button"
                    className="env-mini"
                    data-testid="src-locate"
                    title={t('src.locateHint', { n: mine.length })}
                    onClick={() => locateMessage(latest.messageId)}
                  >
                    {t('src.locate')}
                  </button>
                )
              })()}
              <button
                type="button"
                className="env-mini"
                data-testid="src-open"
                title={item.kind === 'image' ? item.ref : item.ref}
                onClick={() => {
                  if (item.kind === 'web') void window.yan.browser.open(item.ref)
                  /* 图片/文件：不在菜单里"打开"—— 复制路径交给系统的文件管理器更稳 */
                  else void navigator.clipboard.writeText(item.ref).catch(() => undefined)
                }}
              >
                {item.kind === 'web' ? t('src.openWeb') : t('src.copyPath')}
              </button>
              <button type="button" className="env-mini" data-testid="src-remove" onClick={() => void removeOne(item)}>
                {t('src.remove')}
              </button>
            </div>
          ))}
        </div>
      )}

      {dir ? (
        <div className="env-carry-hint" title={dir}>
          {t('src.stored', { dir })}
        </div>
      ) : null}

      {/* 网页来源：粘贴图片与文件走附件流，网址只能手填 */}
      {/*
        搜索入口：**没发现兼容搜索能力时整块不渲染** —— 不做“点了才知道不行”的按钮。
        它只写草稿（不替用户发言），因此也不需要任何网络权限。
      */}
      {webSearch?.available && webSearch.title ? (
        <div className="env-link-add" data-testid="src-websearch">
          <input
            className="env-branch-input"
            data-testid="src-search-query"
            placeholder={t('src.searchPlaceholder')}
            value={searchQuery}
            spellCheck={false}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            type="button"
            className="env-mini"
            data-testid="src-search-run"
            disabled={!searchQuery.trim()}
            onClick={() => {
              const query = searchQuery.trim()
              if (!query) return
              const hint = webSearch.location ? `（能力入口：${webSearch.location}）` : ''
              /*
               * 用 `injectComposerText` 而不是 `setSessionDraft`：草稿只在切会话时
               * 同步进输入框，外部写它对当前这一屏不可见（实测踩到过）。
               */
              injectComposerText(
                `请用「${webSearch.title}」搜索网页：${query}\n${hint}搜到的链接与标题请作为网页来源登记。`
              )
              setSearchQuery('')
              onClose?.()
            }}
          >
            {t('src.searchWith', { name: webSearch.title })}
          </button>
        </div>
      ) : null}
      <div className="env-link-add">
        <input
          className="env-branch-input"
          data-testid="src-url"
          placeholder="https://…"
          value={url}
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value)
            setBad(false)
          }}
        />
        <input
          className="env-branch-input"
          data-testid="src-title"
          placeholder={t('src.titlePlaceholder')}
          value={title}
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="button" className="env-mini" data-testid="src-add-web" disabled={!url.trim()} onClick={addWeb}>
          {t('src.add')}
        </button>
      </div>
      {bad ? <div className="env-error">{t('src.badUrl')}</div> : null}
      {/* 边界（方案 §6.4 的硬要求）：只是关联，不宣称上传/同步/远程执行 */}
      <div className="env-carry-hint">{t('src.note')}</div>
    </div>
  )
}
