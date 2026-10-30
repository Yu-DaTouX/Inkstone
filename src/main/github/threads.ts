import type { GhPrReviewThreadCommentJson, GhPrReviewThreadJson } from '../../shared/github'
import { classifyGhFailure, runGh } from './command'
import type { GhRunner } from './command'

const COMMENT_FIELDS = 'id databaseId author { login } body createdAt url path line startLine replyTo { databaseId }'
const THREAD_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line startLine diffSide startDiffSide comments(first:100){pageInfo{hasNextPage endCursor}nodes{${COMMENT_FIELDS}}}}}}}}`
const COMMENT_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{${COMMENT_FIELDS}}}}}}`
const MAX_PAGES = 20

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const side = (value: unknown): 'LEFT' | 'RIGHT' => value === 'LEFT' ? 'LEFT' : 'RIGHT'
const line = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null

function comments(value: unknown, thread: GhPrReviewThreadJson): GhPrReviewThreadCommentJson[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(raw => {
    const c = object(raw)
    if (!Number.isSafeInteger(c.databaseId) || Number(c.databaseId) < 1) return []
    const author = object(c.author)
    const reply = object(c.replyTo)
    return [{
      id: String(c.id ?? ''), databaseId: Number(c.databaseId),
      author: typeof author.login === 'string' ? { login: author.login } : null,
      body: typeof c.body === 'string' ? c.body : '', createdAt: typeof c.createdAt === 'string' ? c.createdAt : '', url: typeof c.url === 'string' ? c.url : '',
      path: typeof c.path === 'string' ? c.path : thread.path, line: line(c.line) ?? thread.line, side: thread.side,
      startLine: line(c.startLine) ?? thread.startLine, startSide: thread.startSide,
      ...(Number.isSafeInteger(reply.databaseId) ? { replyToId: Number(reply.databaseId) } : {}), isResolved: thread.isResolved
    }]
  })
}

export async function readReviewThreads(cwd: string, number: number, run: GhRunner = runGh): Promise<{ reviewThreads: GhPrReviewThreadJson[]; reviewThreadsTruncated?: boolean; reviewThreadsError?: string }> {
  const threads: GhPrReviewThreadJson[] = []
  let truncated = false
  async function query(text: string, fields: string[]): Promise<Json> {
    const result = await run(cwd, ['api', 'graphql', '-f', `query=${text}`, ...fields])
    if (!result.ok) throw new Error(classifyGhFailure(result).message)
    const parsed = object(JSON.parse(result.stdout))
    if (Array.isArray(parsed.errors) && parsed.errors.length) throw new Error('无法读取行内评审讨论')
    if (!parsed.data) throw new Error('行内评审讨论数据无法解析')
    return object(parsed.data)
  }
  async function moreComments(thread: GhPrReviewThreadJson, connection: Json): Promise<void> {
    const seen = new Set<string>()
    for (let page = 0; object(connection.pageInfo).hasNextPage === true; page++) {
      const cursor = object(connection.pageInfo).endCursor
      if (page >= MAX_PAGES || typeof cursor !== 'string' || seen.has(cursor)) { truncated = true; return }
      seen.add(cursor)
      const data = await query(COMMENT_QUERY, ['-f', `id=${thread.id}`, '-f', `cursor=${cursor}`])
      connection = object(object(data.node).comments)
      if (!Array.isArray(connection.nodes)) throw new Error('行内评审评论数据无法解析')
      thread.comments.push(...comments(connection.nodes, thread))
    }
  }
  try {
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await query(THREAD_QUERY, ['-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${number}`, ...(cursor ? ['-f', `cursor=${cursor}`] : [])])
      const connection = object(object(object(data.repository).pullRequest).reviewThreads)
      if (!Array.isArray(connection.nodes)) throw new Error('行内评审讨论数据无法解析')
      for (const raw of connection.nodes) {
        const t = object(raw)
        if (typeof t.id !== 'string' || typeof t.path !== 'string') continue
        const thread: GhPrReviewThreadJson = { id: t.id, isResolved: t.isResolved === true, isOutdated: t.isOutdated === true, path: t.path, line: line(t.line), side: side(t.diffSide), startLine: line(t.startLine), startSide: t.startDiffSide === 'LEFT' || t.startDiffSide === 'RIGHT' ? t.startDiffSide : null, comments: [] }
        const connection = object(t.comments)
        thread.comments = comments(connection.nodes, thread)
        threads.push(thread)
        await moreComments(thread, connection)
      }
      if (object(connection.pageInfo).hasNextPage !== true) return { reviewThreads: threads, ...(truncated ? { reviewThreadsTruncated: true } : {}) }
      const next = object(connection.pageInfo).endCursor
      if (typeof next !== 'string' || seen.has(next)) { truncated = true; break }
      seen.add(next)
      cursor = next
      if (page === MAX_PAGES - 1) truncated = true
    }
    return { reviewThreads: threads, reviewThreadsTruncated: true }
  } catch (error) {
    return { reviewThreads: threads, reviewThreadsTruncated: true, reviewThreadsError: error instanceof SyntaxError ? '行内评审讨论数据无法解析' : error instanceof Error ? error.message : '无法读取行内评审讨论' }
  }
}
