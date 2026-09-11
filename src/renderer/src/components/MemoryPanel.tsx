import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import {
  MEMORY_SECTIONS,
  MEMORY_SECTION_IDS,
  TOPIC_LABEL_KEY,
  type MemorySectionDef,
  type MemorySectionId,
  type Topic
} from '../data/sections'
import type { MemoryItem } from '../../../shared/ipc'

/* ===================================================================
   右栏 —— 记忆面板
   身份 → 关于你 → 我的印象 → 人 → 项目 → 状态
   前三块是核心，状态沉底（读起来才像「记忆」而不是「账单后台」）
   =================================================================== */

const ORDER_KEY = 'yan.memory-panel-order'

/** localStorage 在 file:// 下会抛（opaque origin），读写都要兜住 */
function loadOrder(): MemorySectionId[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return [...MEMORY_SECTION_IDS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...MEMORY_SECTION_IDS]
    const known = parsed.filter((id): id is MemorySectionId =>
      (MEMORY_SECTION_IDS as readonly string[]).includes(String(id))
    )
    const missing = MEMORY_SECTION_IDS.filter((id) => !known.includes(id))
    return [...known, ...missing]
  } catch {
    return [...MEMORY_SECTION_IDS]
  }
}

export function MemorySections() {
  const t = useT()
  const groups = useStore((s) => s.groups)
  const [order, setOrder] = useState<MemorySectionId[]>(loadOrder)
  const [collapsed, setCollapsed] = useState<Set<MemorySectionId>>(
    () => new Set(MEMORY_SECTIONS.filter((s) => !s.defaultOpen).map((s) => s.id))
  )
  const [dragId, setDragId] = useState<MemorySectionId | null>(null)
  const [dropMark, setDropMark] = useState<{ id: MemorySectionId; after: boolean } | null>(null)

  const byId = useMemo(() => new Map(MEMORY_SECTIONS.map((s) => [s.id, s])), [])
  const sections = order.map((id) => byId.get(id)).filter((s): s is MemorySectionDef => !!s)

  const commit = useCallback((next: MemorySectionId[]) => {
    setOrder(next)
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    } catch {
      /* 存不了就只在本次会话生效 */
    }
  }, [])

  const toggleCollapse = useCallback((id: MemorySectionId) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const drop = useCallback(
    (targetId: MemorySectionId, after: boolean) => {
      if (!dragId || dragId === targetId) return
      const next = order.filter((id) => id !== dragId)
      const at = next.indexOf(targetId)
      next.splice(after ? at + 1 : at, 0, dragId)
      commit(next)
    },
    [dragId, order, commit]
  )

  /** Alt+↑↓ —— 键盘可达，不能只有鼠标能排序 */
  const move = useCallback(
    (id: MemorySectionId, dir: -1 | 1) => {
      const i = order.indexOf(id)
      const j = i + dir
      if (j < 0 || j >= order.length) return
      const next = [...order]
      ;[next[i], next[j]] = [next[j], next[i]]
      commit(next)
    },
    [order, commit]
  )

  const counts: Record<MemorySectionId, number> = {
    soul: 0,
    about: groups.about.length,
    impressions: groups.impressions.length,
    people: groups.people.length,
    projects: groups.projects.length,
    status: 0
  }

  return (
    <div className="mem-sections">
      <div className="mem-sections-head">
        <span className="mem-sections-hint">{t('mem.reorder')}</span>
        <span className="spacer" />
        <button
          className="btn"
          data-testid="mem-reset"
          title={t('mem.reorder')}
          onClick={() => commit([...MEMORY_SECTION_IDS])}
        >
          <Icon name="refresh" size={12} />
          <span>{t('mem.reset')}</span>
        </button>
      </div>

      {sections.map((sec) => (
        <Section
          key={sec.id}
          def={sec}
          count={counts[sec.id]}
          collapsed={collapsed.has(sec.id)}
          dragging={dragId === sec.id}
          dropMark={dropMark?.id === sec.id ? dropMark.after : null}
          onToggle={() => toggleCollapse(sec.id)}
          onGripDragStart={() => setDragId(sec.id)}
          onGripDragEnd={() => {
            setDragId(null)
            setDropMark(null)
          }}
          onDragOver={(after) => setDropMark({ id: sec.id, after })}
          onDragLeave={() => setDropMark((m) => (m?.id === sec.id ? null : m))}
          onDrop={(after) => {
            drop(sec.id, after)
            setDragId(null)
            setDropMark(null)
          }}
          onMove={(dir) => move(sec.id, dir)}
          items={
            sec.source === 'about'
              ? groups.about
              : sec.source === 'impressions'
                ? groups.impressions
                : sec.source === 'people'
                  ? groups.people
                  : sec.source === 'projects'
                    ? groups.projects
                    : []
          }
        />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ 分区 */
interface SectionProps {
  def: MemorySectionDef
  count: number
  items: MemoryItem[]
  collapsed: boolean
  dragging: boolean
  dropMark: boolean | null
  onToggle: () => void
  onGripDragStart: () => void
  onGripDragEnd: () => void
  onDragOver: (after: boolean) => void
  onDragLeave: () => void
  onDrop: (after: boolean) => void
  onMove: (dir: -1 | 1) => void
}

function Section(p: SectionProps) {
  const t = useT()
  const { def, collapsed, dragging, dropMark } = p

  const cls = [
    'sect',
    collapsed ? 'collapsed' : 'open',
    dragging && 'dragging',
    dropMark === true && 'drop-below',
    dropMark === false && 'drop-above'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      data-sec={def.id}
      onDragOver={(e) => {
        if (!dragging) e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        p.onDragOver(e.clientY > r.top + r.height / 2)
      }}
      onDragLeave={p.onDragLeave}
      onDrop={(e) => {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        p.onDrop(e.clientY > r.top + r.height / 2)
      }}
    >
      {/* 不用 <button>：里面还有可聚焦的拖拽把手，嵌套交互元素是非法 HTML */}
      <div
        className="sect-title"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.grip')) return
          p.onToggle()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            p.onToggle()
          }
        }}
      >
        <span
          className="grip"
          role="button"
          tabIndex={0}
          data-testid="mem-grip"
          title={t('mem.reorder')}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', def.id)
            p.onGripDragStart()
          }}
          onDragEnd={p.onGripDragEnd}
          onKeyDown={(e) => {
            if (!e.altKey) return
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            e.preventDefault()
            e.stopPropagation()
            p.onMove(e.key === 'ArrowUp' ? -1 : 1)
          }}
        >
          <Icon name="menu" size={12} />
        </span>

        <Icon name={def.icon as IconName} size={12} />
        <span>{t(def.titleKey)}</span>
        <span className="spacer" />
        {p.count > 0 ? <span className="extra">{p.count}</span> : null}
      </div>

      <SectionBody def={def} items={p.items} />
    </div>
  )
}

/* ------------------------------------------------------------- 分区内容 */
function SectionBody({ def, items }: { def: MemorySectionDef; items: MemoryItem[] }) {
  const t = useT()

  if (def.source === 'soul') return <SoulCard />
  if (def.source === 'status') return <StatusCard />
  if (def.source === 'impressions') return <GuessesCard items={items} />

  const topic = def.source as Topic
  return (
    <div className="card">
      <MemoryList items={items} empty={t(`mem.empty${cap(def.source)}` as never)} />
      {/* 手动添加只给「关于你」一个入口。
          每个分区都摆一排输入框会让右栏变成三个一样的表单，
          而且用户想把一条记忆归到「人」时，改分类比换框更自然。 */}
      {topic === 'about' ? <AddMemory topic={topic} /> : null}
    </div>
  )
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function MemoryList({ items, empty }: { items: MemoryItem[]; empty: string }) {
  if (items.length === 0) return <div className="mem-empty">{empty}</div>
  return (
    <div className="mems">
      {items.map((m) => (
        <MemRow key={m.id} item={m} />
      ))}
    </div>
  )
}

/** 未确认区块：整块虚线 + 每条带「对/不对」 */
function GuessesCard({ items }: { items: MemoryItem[] }) {
  const t = useT()
  const confirm = useStore((s) => s.confirmMemory)

  return (
    <div className="card guess-card">
      {items.length === 0 ? (
        <div className="mem-empty">{t('mem.emptyGuesses')}</div>
      ) : (
        <div className="mems">
          {items.map((m) => (
            <div key={m.id} className="memrow guess">
              <span className="bar" />
              <span className="txt">{m.text}</span>
              <span className="src">{t('mem.srcMe')}</span>
              <span className="acts">
                <button className="btn fact" onClick={() => void confirm(m.id, true)}>
                  {t('mem.yes')}
                </button>
                <button className="btn danger" onClick={() => void confirm(m.id, false)}>
                  {t('mem.no')}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mem-note">{t('mem.guessBlock')}</div>
    </div>
  )
}

function MemRow({ item }: { item: MemoryItem }) {
  const t = useT()
  const remove = useStore((s) => s.removeMemory)
  const edit = useStore((s) => s.editMemory)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)

  useEffect(() => setDraft(item.text), [item.text])

  if (editing) {
    return (
      <div className="memrow editing">
        <span className="bar" />
        <input
          className="mem-edit"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void edit(item.id, { text: draft })
              setEditing(false)
            } else if (e.key === 'Escape') {
              setDraft(item.text)
              setEditing(false)
            }
          }}
        />
        <span className="acts editing">
          <button
            className="btn fact"
            onClick={() => {
              void edit(item.id, { text: draft })
              setEditing(false)
            }}
          >
            {t('mem.save')}
          </button>
          <button
            className="btn"
            onClick={() => {
              setDraft(item.text)
              setEditing(false)
            }}
          >
            {t('mem.cancel')}
          </button>
        </span>
      </div>
    )
  }

  return (
    <div className={`memrow ${item.kind} topic-${item.topic}`}>
      <span className="bar" />
      <span className="txt">{item.text}</span>
      <span className="src">{item.source === 'you' ? t('chat.you') : t('mem.srcMe')}</span>
      <span className="acts">
        <button className="btn" onClick={() => setEditing(true)}>
          {t('mem.edit')}
        </button>
        <button className="btn danger" onClick={() => void remove(item.id)}>
          {t('mem.retract')}
        </button>
      </span>
    </div>
  )
}

/** 手动添加：这是「你告诉它」的路径，所以默认存为已确认 */
function AddMemory({ topic }: { topic: Topic }) {
  const t = useT()
  const add = useStore((s) => s.addMemory)
  const [text, setText] = useState('')
  const [asFact, setAsFact] = useState(true)

  const submit = () => {
    const v = text.trim()
    if (!v) return
    void add(v, asFact ? 'fact' : 'guess', topic)
    setText('')
  }

  return (
    <div className="mem-add">
      <input
        className="mem-add-input"
        value={text}
        placeholder={t('mem.addPlaceholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button className="btn" onClick={submit} disabled={!text.trim()}>
        <Icon name="plus" size={12} />
        <span>{t('mem.add')}</span>
      </button>
      <label className="mem-add-fact" title={t('mem.addAsFact')}>
        <input type="checkbox" checked={asFact} onChange={(e) => setAsFact(e.target.checked)} />
        <span>{t('mem.confirmed')}</span>
      </label>
    </div>
  )
}

/** 身份：只读。agent 不能改自己 —— 这条不变量要在界面上看得见 */
function SoulCard() {
  const t = useT()
  const soul = useStore((s) => s.soul)

  return (
    <div className="card">
      <dl className="soul">
        <div className="soul-line">
          <dt>{t('mem.name')}</dt>
          <dd>{soul.name}</dd>
        </div>
        <div className="soul-line">
          <dt>{t('mem.selfRef')}</dt>
          <dd>{soul.selfRef}</dd>
        </div>
        <div className="soul-line">
          <dt>{t('mem.tone')}</dt>
          <dd>{soul.tone}</dd>
        </div>
      </dl>
      <div className="soul-ro">
        <Icon name="shield-check" size={12} />
        <span>{t('mem.soulLock')}</span>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 状态卡 */
const nf = new Intl.NumberFormat('en-US')

function StatusCard() {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const session = useStore((s) => s.session)
  const memory = useStore((s) => s.memory)
  const compact = useStore((s) => s.compact)
  const models = useStore((s) => s.models)
  const thinkingLevels = useStore((s) => s.thinkingLevels)
  const setModel = useStore((s) => s.setModel)
  const setThinking = useStore((s) => s.setThinking)
  const setAutoCompaction = useStore((s) => s.setAutoCompaction)
  const setAutoRetry = useStore((s) => s.setAutoRetry)

  const cu = stats?.contextUsage
  const pct = cu?.percent ?? (cu?.tokens && cu.contextWindow ? (cu.tokens / cu.contextWindow) * 100 : 0)
  const used = cu?.tokens ?? 0
  const window = cu?.contextWindow ?? session?.model?.contextWindow ?? 0

  // 模型按 provider 分组 —— 不然一个下拉里塞几十项没法用
  const byProvider = new Map<string, typeof models>()
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? []
    list.push(m)
    byProvider.set(m.provider, list)
  }

  const currentModelKey = session?.model ? `${session.model.provider}|${session.model.id}` : ''
  const busy = !!session?.isStreaming || !!session?.isCompacting

  return (
    <div className="card">
      {/* 模型：真正可切换的下拉 */}
      <label className="kv-field">
        <span className="kv-label">{t('mem.model')}</span>
        <select
          className="pick"
          value={currentModelKey}
          disabled={busy || models.length === 0}
          onChange={(e) => {
            const [provider, id] = e.target.value.split('|')
            if (provider && id) void setModel(provider, id)
          }}
        >
          {models.length === 0 ? <option value="">{t('status.noModels')}</option> : null}
          {[...byProvider.entries()].map(([provider, list]) => (
            <optgroup key={provider} label={provider}>
              {list.map((m) => (
                <option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>
                  {m.name}
                  {m.reasoning ? ' · reasoning' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {/* 思考档 */}
      <label className="kv-field">
        <span className="kv-label">{t('mem.thinking')}</span>
        <select
          className="pick"
          value={session?.thinkingLevel ?? 'off'}
          disabled={busy || thinkingLevels.length === 0}
          onChange={(e) => void setThinking(e.target.value)}
        >
          {(thinkingLevels.length ? thinkingLevels : ['off']).map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>

      <div className="meter">
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="meter-label">
        <span>
          {nf.format(used)} / {window ? nf.format(window) : '—'}
        </span>
        <span>{window ? `${pct.toFixed(1)}%` : '—'}</span>
      </div>

      <div className="usage-line">
        <span>
          <b>{t('mem.memCount')}</b> {memory.length}
        </span>
        <span>
          <b>{t('status.tools')}</b> {stats?.toolCalls ?? 0}
        </span>
        <span>
          <b>{t('mem.cost')}</b> ${(stats?.cost ?? 0).toFixed(3)}
        </span>
      </div>

      <div className="status-actions">
        <button className="btn" onClick={() => void compact()} disabled={busy}>
          <Icon
            name={session?.isCompacting ? 'refresh' : 'layers'}
            size={12}
            className={session?.isCompacting ? 'spin' : undefined}
          />
          <span>{session?.isCompacting ? t('status.compacting') : t('status.compact')}</span>
        </button>
      </div>

      <div className="switch-row">
        <Toggle
          label={t('status.autoCompact')}
          hint={t('status.autoCompactHint')}
          on={session?.autoCompactionEnabled ?? true}
          onChange={(v) => void setAutoCompaction(v)}
        />
        <Toggle
          label={t('status.autoRetry')}
          hint={t('status.autoRetryHint')}
          on={autoRetryRef.current}
          onChange={(v) => {
            autoRetryRef.current = v
            void setAutoRetry(v)
          }}
        />
      </div>
    </div>
  )
}

/**
 * pi 的 get_state 不返回 autoRetry 状态（只有 autoCompactionEnabled），
 * 所以重试开关只能客户端自己记。默认 true（与 pi 默认一致）。
 */
const autoRetryRef = { current: true }

function Toggle({
  label,
  hint,
  on,
  onChange
}: {
  label: string
  hint?: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="switch" title={hint}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}
