import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

interface LocalRoot {
  root: string
  prefix: string
  origin: string
  server: Server
}

const roots = new Map<string, Promise<LocalRoot>>()

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function rootKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root
}

function startRoot(root: string): Promise<LocalRoot> {
  const prefix = `/${randomBytes(9).toString('hex')}`
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      res.writeHead(404).end()
      return
    }
    let rel: string
    try {
      rel = decodeURIComponent(pathname.slice(prefix.length))
    } catch {
      res.writeHead(400).end()
      return
    }
    let target = resolve(root, `.${sep}${rel}`)
    if (!inside(root, target)) {
      res.writeHead(403).end()
      return
    }
    try {
      if (statSync(target).isDirectory()) target = join(target, 'index.html')
      const stat = statSync(target)
      if (!stat.isFile()) throw new Error('not file')
      res.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store'
      })
      if (req.method === 'HEAD') res.end()
      else createReadStream(target).pipe(res)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
    }
  })
  return new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.unref()
      done({ root, prefix, origin: `http://127.0.0.1:${port}`, server })
    })
  })
}

export function localFileRoot(file: string, cwd: string | undefined): string {
  if (cwd && inside(resolve(cwd), file)) return resolve(cwd)
  return dirname(file)
}

export async function serveLocalFile(path: string, cwd?: string): Promise<string> {
  const file = resolve(cwd ?? process.cwd(), path)
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat) throw new Error(`本地文件不存在：${file}`)
  const entry = stat.isDirectory() ? join(file, 'index.html') : file
  const root = localFileRoot(entry, cwd)
  const key = rootKey(root)
  let pending = roots.get(key)
  if (!pending) {
    pending = startRoot(root)
    roots.set(key, pending)
    pending.catch(() => roots.delete(key))
  }
  const served = await pending
  const segments = relative(served.root, entry).split(sep).map(encodeURIComponent).join('/')
  return `${served.origin}${served.prefix}/${segments}`
}
