import { useEffect, useRef, useState } from 'react'
import type { SourceLinkView, SourceRefView } from '../../../shared/ipc'

/**
 * 读当前会话的来源（实施-18 S3）。
 *
 * 三类来源的存储方式不同（见 `SourceMenu` 的长注释）：图片在我们持有的
 * 副本里，文件只登记路径、由主进程复核，网页只有本地 URL 记录。这里把
 * 三路合成一份只读快照给工作台首页用，**不做登记/删除** —— 那些动作仍归
 * 来源菜单，避免两处写同一份 localStorage 登记。
 *
 * 与 `SourceMenu` 共用同样的 localStorage 键：那是同一份登记数据，
 * 各存一份会立刻漂移。
 */

interface FileRef {
  path: string
  name: string
  addedAt: number
}

interface WebLink {
  id: string
  sessionId: string
  url: string
  title: string
  addedAt: number
}

const FILE_KEY = 'yan.source-files.v1'
const WEB_KEY = 'yan.source-links.v1'

function loadJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export interface SessionSourcesState {
  loading: boolean
  error: boolean
  images: SourceRefView[]
  files: SourceRefView[]
  webs: SourceRefView[]
  links: SourceLinkView[]
  all: SourceRefView[]
}

const EMPTY: SessionSourcesState = {
  loading: false,
  error: false,
  images: [],
  files: [],
  webs: [],
  links: [],
  all: []
}

export function useSessionSources(sessionId: string | undefined): SessionSourcesState {
  const [state, setState] = useState<SessionSourcesState>({ ...EMPTY, loading: Boolean(sessionId) })
  const gate = useRef(0)

  useEffect(() => {
    if (!sessionId) {
      setState(EMPTY)
      return
    }
    /* 迟到的响应不能画到已切换的会话上（来源按会话隔离） */
    const mine = ++gate.current
    setState((s) => ({ ...s, loading: true, error: false }))
    void (async () => {
      let images: SourceRefView[] = []
      let files: SourceRefView[] = []
      let links: SourceLinkView[] = []
      let failed = false

      try {
        const listed = await window.yan.sources.list(sessionId)
        if (gate.current !== mine) return
        images = listed.images ?? []
        links = listed.links ?? []
      } catch {
        failed = true
      }

      const refs = loadJson<FileRef>(FILE_KEY).filter((x) => x.path)
      try {
        const verified = await window.yan.sources.verifyFiles({ sessionId, entries: refs })
        if (gate.current !== mine) return
        files = verified
      } catch {
        failed = true
      }

      const webs: SourceRefView[] = loadJson<WebLink>(WEB_KEY)
        .filter((x) => x.sessionId === sessionId)
        .map((l) => ({
          sourceId: `web:${l.id}`,
          sessionId,
          kind: 'web' as const,
          title: l.title || l.url,
          ref: l.url,
          fingerprint: l.url,
          origin: l.url,
          addedAt: l.addedAt,
          available: true
        }))

      if (gate.current !== mine) return
      const all = [...images, ...files, ...webs].sort((a, b) => b.addedAt - a.addedAt)
      setState({ loading: false, error: failed, images, files, webs, links, all })
    })()
  }, [sessionId])

  return state
}
