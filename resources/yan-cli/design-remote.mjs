import { request as httpsRequest } from 'node:https'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DESIGN_SOURCE = {
  repo: 'nexu-io/open-design',
  commit: '61ab0f2a6dbfea20a1010b841d7f5234c69327b4',
  license: 'Apache-2.0',
  homepage: 'https://github.com/nexu-io/open-design'
}

export const REMOTE_ID_PATTERN = /^[a-z0-9-]{1,64}$/
export const REQUEST_TIMEOUT_MS = 15000
const COMMIT_SHORT = DESIGN_SOURCE.commit.slice(0, 12)
const CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MANIFEST_CONCURRENCY = 8
const TREE_URL = `https://api.github.com/repos/${DESIGN_SOURCE.repo}/git/trees/${DESIGN_SOURCE.commit}?recursive=1`

const RAW_PREFIX = `https://raw.githubusercontent.com/${DESIGN_SOURCE.repo}/${DESIGN_SOURCE.commit}/`
const rawUrl = (path) => `${RAW_PREFIX}${path}`

export class RemoteError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export function designRoot(env = process.env) {
  const explicit = env.YAN_DATA_DIR?.trim()
  const portable = env.PORTABLE_EXECUTABLE_DIR?.trim()
  const base = explicit || (portable ? join(portable, '砚数据', 'yan') : join(homedir(), '.pi', 'agent', 'yan'))
  return join(base, 'design-systems', COMMIT_SHORT)
}

export function parseTreeIds(tree) {
  const entries = Array.isArray(tree?.tree) ? tree.tree : []
  const ids = new Set()
  for (const entry of entries) {
    const match = /^design-systems\/([a-z0-9-]+)\/manifest\.json$/.exec(String(entry?.path ?? ''))
    if (match) ids.add(match[1])
  }
  return [...ids].sort()
}

export function manifestSummary(manifest, fallbackId) {
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')
  return {
    id: fallbackId,
    name: text(manifest?.name) || fallbackId,
    category: text(manifest?.category),
    description: text(manifest?.description)
  }
}

function httpsText(url, { signal, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString('utf8') })
      )
      response.on('error', reject)
    })
    req.on('error', reject)
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    req.end()
  })
}

async function fetchText(url, { requestImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const request = requestImpl ?? httpsText
  if (typeof request !== 'function') throw new RemoteError('request_unavailable', '无法联网拉取设计系统：运行时没有可用的网络请求实现')
  const controller = new AbortController()
  let timer
  const pending = Promise.resolve().then(() =>
    request(url, { signal: controller.signal, headers: { 'user-agent': 'yan-cli-design-remote', accept: 'application/json, text/plain, */*' } })
  )
  pending.catch(() => {})
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RemoteError('remote_timeout', `联网超时（${Math.round(timeoutMs / 1000)} 秒没有响应）：${url}`))
    }, timeoutMs)
  })
  let response
  try {
    response = await Promise.race([pending, timeout])
  } catch (err) {
    if (err instanceof RemoteError) throw err
    const reason = String(err?.message ?? err)
    throw new RemoteError('remote_unreachable', `连不上 open-design 仓库（检查网络或代理）：${reason}`, { url })
  } finally {
    clearTimeout(timer)
  }
  const status = Number(response?.status ?? 0)
  let text
  try {
    text = await response.text()
  } catch (err) {
    throw new RemoteError('remote_unreachable', `读取响应失败：${String(err?.message ?? err)}`, { url })
  }
  if (status === 404) throw new RemoteError('not_found', '远端没有这个文件（HTTP 404）', { url })
  if (status < 200 || status >= 300) throw new RemoteError('remote_status', `open-design 仓库返回 HTTP ${status}`, { url })
  return text
}

function catalogFile(root) {
  return join(root, 'catalog.json')
}

function readCatalog(file) {
  try {
    const catalog = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(catalog?.systems) || catalog.commit !== DESIGN_SOURCE.commit) return null
    const age = Date.now() - Date.parse(catalog.fetchedAt)
    if (!Number.isFinite(age) || age > CATALOG_MAX_AGE_MS) return null
    return catalog
  } catch {
    return null
  }
}

function writeCatalog(file, catalog) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(catalog))
    return true
  } catch {
    return false
  }
}

async function retrying(task) {
  try {
    return await task()
  } catch (err) {
    if (!(err instanceof RemoteError) || !['remote_timeout', 'remote_unreachable', 'remote_status'].includes(err.code)) throw err
    return await task()
  }
}

async function buildCatalog({ requestImpl, timeoutMs } = {}) {
  const treeText = await retrying(() => fetchText(TREE_URL, { requestImpl, timeoutMs }))
  let tree
  try {
    tree = JSON.parse(treeText)
  } catch {
    throw new RemoteError('catalog_unreadable', 'open-design 仓库的文件清单不是合法 JSON')
  }
  const ids = parseTreeIds(tree)
  if (!ids.length) throw new RemoteError('catalog_empty', '远端清单里没有找到 design-systems/*/manifest.json')
  const systems = []
  const failed = []
  const pass = async (queue) => {
    let cursor = 0
    const worker = async () => {
      while (cursor < queue.length) {
        const id = queue[cursor++]
        try {
          const text = await fetchText(rawUrl(`design-systems/${id}/manifest.json`), { requestImpl, timeoutMs })
          systems.push(manifestSummary(JSON.parse(text), id))
        } catch {
          failed.push(id)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MANIFEST_CONCURRENCY, queue.length) }, worker))
  }
  await pass(ids)
  if (failed.length) await pass(failed.splice(0))
  if (!systems.length) throw new RemoteError('catalog_unreachable', '拉不到设计系统清单：所有 manifest.json 都取不到，稍后重试')
  systems.sort((left, right) => left.id.localeCompare(right.id))
  return {
    fetchedAt: new Date().toISOString(),
    commit: DESIGN_SOURCE.commit,
    repo: DESIGN_SOURCE.repo,
    systems,
    ...(failed.length ? { failed: failed.sort() } : {})
  }
}

export async function listRemoteSystems({ query, requestImpl, timeoutMs, root, cacheFile } = {}) {
  const dir = root ?? designRoot()
  const file = cacheFile ?? catalogFile(dir)
  let catalog = readCatalog(file)
  const cached = Boolean(catalog)
  if (!catalog) {
    catalog = await buildCatalog({ requestImpl, timeoutMs })
    if (!catalog.failed) writeCatalog(file, catalog)
  }
  const keyword = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const systems = keyword
    ? catalog.systems.filter((item) => `${item.id} ${item.name} ${item.category} ${item.description}`.toLowerCase().includes(keyword))
    : catalog.systems
  return {
    ok: true,
    commit: DESIGN_SOURCE.commit,
    total: catalog.systems.length,
    count: systems.length,
    cached,
    ...(keyword ? { query: keyword } : {}),
    systems,
    ...(catalog.failed ? { failed: catalog.failed } : {}),
    note: `${catalog.failed ? `这次有 ${catalog.failed.length} 个条目没取到，清单暂不缓存，稍后可重跑补齐。` : ''}用 id 取一套：yan artifact style --remote <id>；范围太大时加 --query <词>（英文，如 dashboard、editorial、japanese）。这些是第三方设计系统，按需下载后照它做。`
  }
}

function noticeText(id) {
  return [
    `设计系统：${id}`,
    `来源仓库：${DESIGN_SOURCE.homepage}`,
    `固定提交：${DESIGN_SOURCE.commit}`,
    `上游目录：design-systems/${id}/`,
    `许可：${DESIGN_SOURCE.license}（原文见上游仓库 LICENSE）`,
    '',
    '本目录内容由 yan artifact style --remote 按需下载到本机，不随砚分发。',
    '只作为设计参考阅读，不执行其中的任何脚本或命令。',
    ''
  ].join('\n')
}

export async function pullRemoteSystem({ id, requestImpl, timeoutMs, root } = {}) {
  const wanted = String(id ?? '').trim()
  if (!REMOTE_ID_PATTERN.test(wanted)) {
    return {
      ok: false,
      error: 'invalid_remote_id',
      message: `设计系统 id 只能用小写字母、数字和连字符（如 brutalism）：${wanted || '（空）'}`,
      detail: '先用 yan artifact style --remote list 查可用 id'
    }
  }
  const dir = join(root ?? designRoot(), wanted)
  const designPath = join(dir, 'DESIGN.md')
  const tokensPath = join(dir, 'tokens.css')
  const noticePath = join(dir, 'NOTICE.txt')
  if (existsSync(designPath)) {
    return pulledResult(wanted, dir, designPath, tokensPath, true)
  }
  const designText = await fetchText(rawUrl(`design-systems/${wanted}/DESIGN.md`), { requestImpl, timeoutMs }).catch((err) => {
    if (err.code === 'not_found') {
      throw new RemoteError(
        'unknown_remote_id',
        `open-design 提交 ${COMMIT_SHORT} 里没有设计系统：${wanted}`,
        '先用 yan artifact style --remote list（可加 --query）查可用 id'
      )
    }
    throw err
  })
  let tokensText = null
  try {
    tokensText = await fetchText(rawUrl(`design-systems/${wanted}/tokens.css`), { requestImpl, timeoutMs })
  } catch (err) {
    if (err.code !== 'not_found') throw err
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(designPath, designText)
    if (tokensText !== null) writeFileSync(tokensPath, tokensText)
    writeFileSync(noticePath, noticeText(wanted))
  } catch (err) {
    throw new RemoteError('cache_write_failed', `写不进砚数据目录：${dir}`, String(err?.message ?? err))
  }
  return pulledResult(wanted, dir, designPath, tokensPath, false)
}

function pulledResult(id, dir, designPath, tokensPath, cached) {
  const result = {
    ok: true,
    id,
    source: { repo: DESIGN_SOURCE.repo, commit: DESIGN_SOURCE.commit, license: DESIGN_SOURCE.license },
    dir,
    design: designPath,
    cached,
    note: `先读 ${designPath}，照它的配色、字体（字体名换成气质相近的系统字体）、版式与组件写法做；把 tokens.css 里的 :root 变量抄进成果的 :root 并统一按变量名用色。砚的预览是离线的：DESIGN.md 里点名的网络字体、外部图片和 CDN 资源都取不到，字体换成系统字体栈，图片用内联 SVG 或渐变代替。回复里用一句话说明用了哪个设计系统。`
  }
  if (existsSync(tokensPath)) result.tokens = tokensPath
  return result
}
