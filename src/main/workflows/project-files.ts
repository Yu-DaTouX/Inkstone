import { pick } from '../../shared/ui-lang'
import { randomBytes } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const PROJECT_FILE_LIMITS = {
  maxReadBytes: 4 * 1024 * 1024,
  maxWriteBytes: 4 * 1024 * 1024,
  maxListed: 100_000,
  maxPathChars: 1024
} as const

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectFileError'
  }
}

export interface ProjectFiles {
  readonly root: string
  readText(path: unknown): string
  writeText(path: unknown, text: unknown): { path: string; bytes: number }
  listFiles(dir?: unknown, glob?: unknown): string[]
  relativeOf(path: unknown): string
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i
const WINDOWS = process.platform === 'win32'

function realpath(path: string): string {
  return realpathSync.native(path)
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function inside(root: string, path: string): string | null {
  const rel = relative(root, path)
  if (rel === '') return ''
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel
}

function segments(rel: string): string[] {
  return rel.split(/[\\/]+/).filter(Boolean)
}

function hasGit(rel: string): boolean {
  return segments(rel).some((part) => part.toLowerCase() === '.git')
}

function slash(rel: string): string {
  return rel.split(sep).join('/')
}

function checkShape(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new ProjectFileError(pick(`${what}需要非空字符串路径`, `${what}needs a non-empty string path`))
  const path = raw.trim()
  if (path.length > PROJECT_FILE_LIMITS.maxPathChars) throw new ProjectFileError(pick(`${what}路径超过 ${PROJECT_FILE_LIMITS.maxPathChars} 字符`, `${what}path is longer than ${PROJECT_FILE_LIMITS.maxPathChars} characters`))
  if (/[\u0000-\u001f]/.test(path)) throw new ProjectFileError(pick(`${what}路径含控制字符`, `${what}path contains control characters`))
  if (/^[\\/]{2}/.test(path)) throw new ProjectFileError(pick(`${what}不接受网络（UNC）或设备路径：${path}`, `${what}does not accept network (UNC) or device paths: ${path}`))
  if (/^[A-Za-z]:(?![\\/])/.test(path)) throw new ProjectFileError(pick(`${what}不接受盘符相对路径（如 C:foo）：${path}`, `${what}does not accept drive-relative paths (like C:foo): ${path}`))
  const body = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(2) : path
  for (const part of segments(body)) {
    if (part === '.' || part === '..') continue
    if (/[<>:"|?*]/.test(part)) throw new ProjectFileError(pick(`${what}路径里的名称含不允许的字符（如 : 会写进 NTFS 备用数据流）：${part}`, `${what}path name contains a forbidden character (: would write an NTFS alternate data stream): ${part}`))
    if (/[. ]$/.test(part)) throw new ProjectFileError(pick(`${what}路径里的名称不能以点或空格结尾（Windows 会把它剥掉）：「${part}」`, `${what}path names cannot end with a dot or space (Windows strips them): "${part}"`))
    if (RESERVED.test(part.split('.')[0])) throw new ProjectFileError(pick(`${what}路径里的名称是 Windows 设备名：${part}`, `${what}path name is a Windows device name: ${part}`))
  }
  return path
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&')
}

export function globToRegExp(glob: string): RegExp {
  let out = ''
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/'
        out += slashAfter ? '(?:[^/]*/)*' : '.*'
        i += slashAfter ? 2 : 1
      } else out += '[^/]*'
    } else if (ch === '?') out += '[^/]'
    else if (ch === '{') {
      depth += 1
      out += '(?:'
    } else if (ch === '}' && depth > 0) {
      depth -= 1
      out += ')'
    } else if (ch === ',' && depth > 0) out += '|'
    else if (ch === '\\' || ch === '/') out += '/'
    else out += escapeRegex(ch)
  }
  if (depth > 0) throw new ProjectFileError(pick(`glob 的 { } 没有配对：${glob}`, `Unbalanced { } in glob: ${glob}`))
  return new RegExp(`^${out}$`, WINDOWS ? 'i' : '')
}

export function createProjectFiles(projectRoot: string): ProjectFiles {
  let rootReal: string | null = null
  const root = (): string => {
    if (rootReal) return rootReal
    try {
      rootReal = realpath(resolve(projectRoot))
    } catch (error) {
      throw new ProjectFileError(pick(`项目目录不可用：${projectRoot}（${error instanceof Error ? error.message : String(error)}）`, `Project folder is not available: ${projectRoot} (${error instanceof Error ? error.message : String(error)})`))
    }
    if (!statSync(rootReal).isDirectory()) throw new ProjectFileError(pick(`项目目录不是目录：${projectRoot}`, `Project folder is not a directory: ${projectRoot}`))
    return rootReal
  }

  const outside = (raw: string): ProjectFileError => new ProjectFileError(pick(`路径不在项目目录内：${raw}（只允许 ${root()} 以内）`, `Path is outside the project folder: ${raw} (only ${root()} is allowed)`))

  const lexical = (raw: unknown, what: string): { raw: string; full: string; rel: string } => {
    const path = checkShape(raw, what)
    const base = root()
    const lexicalRoot = resolve(projectRoot)
    const full = resolve(lexicalRoot, path)
    const rel = inside(lexicalRoot, full) ?? inside(base, full)
    if (rel === null) throw outside(path)
    if (hasGit(rel)) throw new ProjectFileError(pick(`不允许访问 .git 目录：${path}`, `Access to the .git folder is not allowed: ${path}`))
    return { raw: path, full: rel === '' ? base : join(base, rel), rel }
  }

  const confirmReal = (raw: string, real: string): string => {
    const rel = inside(root(), real)
    if (rel === null) throw outside(raw)
    if (hasGit(rel)) throw new ProjectFileError(pick(`不允许访问 .git 目录：${raw}`, `Access to the .git folder is not allowed: ${raw}`))
    return rel
  }

  const existingReal = (raw: string, full: string, missing: string): string => {
    let real: string
    try {
      real = realpath(full)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new ProjectFileError(`${missing}: ${raw}`)
      throw new ProjectFileError(pick(`读不到 ${raw}：${error instanceof Error ? error.message : String(error)}`, `Cannot read ${raw}: ${error instanceof Error ? error.message : String(error)}`))
    }
    confirmReal(raw, real)
    return real
  }

  const readText = (rawPath: unknown): string => {
    const { raw, full } = lexical(rawPath, 'readText ')
    const real = existingReal(raw, full, pick('文件不存在', 'File not found'))
    const info = statSync(real)
    if (!info.isFile()) throw new ProjectFileError(pick(`不是文件：${raw}`, `Not a file: ${raw}`))
    if (info.size > PROJECT_FILE_LIMITS.maxReadBytes) throw new ProjectFileError(pick(`文件 ${raw} 有 ${info.size} 字节，超过单文件读取上限 4MB`, `File ${raw} has ${info.size} bytes, over the 4MB read limit`))
    const data = readFileSync(real)
    if (data.length > PROJECT_FILE_LIMITS.maxReadBytes) throw new ProjectFileError(pick(`文件 ${raw} 超过单文件读取上限 4MB`, `File ${raw} is over the 4MB read limit`))
    return data.toString('utf8')
  }

  const ensureDir = (raw: string, dir: string): string => {
    const base = root()
    const missing: string[] = []
    let cursor = dir
    while (!exists(cursor)) {
      missing.unshift(basename(cursor))
      const parent = dirname(cursor)
      if (parent === cursor) throw outside(raw)
      cursor = parent
    }
    let real = realpath(cursor)
    confirmReal(raw, real)
    if (!statSync(real).isDirectory()) throw new ProjectFileError(pick(`父路径不是目录：${raw}`, `Parent path is not a directory: ${raw}`))
    for (const name of missing) {
      const next = join(real, name)
      try {
        mkdirSync(next)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ProjectFileError(pick(`建目录失败：${raw}（${error instanceof Error ? error.message : String(error)}）`, `Could not create the folder for ${raw} (${error instanceof Error ? error.message : String(error)})`))
      }
      real = realpath(next)
      confirmReal(raw, real)
      if (!statSync(real).isDirectory()) throw new ProjectFileError(pick(`父路径不是目录：${raw}`, `Parent path is not a directory: ${raw}`))
    }
    if (inside(base, real) === null) throw outside(raw)
    return real
  }

  const writeText = (rawPath: unknown, text: unknown): { path: string; bytes: number } => {
    const { raw, full, rel } = lexical(rawPath, 'writeText ')
    if (rel === '') throw new ProjectFileError(pick('writeText 不能写项目目录本身', 'writeText cannot write the project folder itself'))
    if (typeof text !== 'string') throw new ProjectFileError(pick(`writeText 的内容必须是字符串：${raw}`, `writeText content must be a string: ${raw}`))
    const data = Buffer.from(text, 'utf8')
    if (data.length > PROJECT_FILE_LIMITS.maxWriteBytes) throw new ProjectFileError(pick(`写入 ${raw} 的内容有 ${data.length} 字节，超过单文件写入上限 4MB`, `Content for ${raw} has ${data.length} bytes, over the 4MB write limit`))
    const parent = ensureDir(raw, dirname(full))
    let target = join(parent, basename(full))
    if (exists(target)) {
      target = existingReal(raw, target, pick('文件不存在', 'File not found'))
      if (!statSync(target).isFile()) throw new ProjectFileError(pick(`目标已存在且是目录，不能写成文件：${raw}`, `Target exists and is a folder, cannot write it as a file: ${raw}`))
    }
    const targetDir = dirname(target)
    confirmReal(raw, realpath(targetDir))
    const temp = join(targetDir, `.${basename(target)}.${randomBytes(4).toString('hex')}.tmp`)
    let fd: number | null = null
    try {
      fd = openSync(temp, 'wx')
      writeSync(fd, data)
      closeSync(fd)
      fd = null
      renameSync(temp, target)
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd) } catch {}
      }
      try { rmSync(temp, { force: true }) } catch {}
      throw new ProjectFileError(pick(`写入 ${raw} 失败：${error instanceof Error ? error.message : String(error)}`, `Writing ${raw} failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    return { path: slash(confirmReal(raw, target)), bytes: data.length }
  }

  const listFiles = (rawDir?: unknown, rawGlob?: unknown): string[] => {
    const dirInput = rawDir === undefined || rawDir === null || rawDir === '' ? '.' : rawDir
    if (rawGlob !== undefined && rawGlob !== null && typeof rawGlob !== 'string') throw new ProjectFileError(pick('listFiles 的 glob 必须是字符串', 'The listFiles glob must be a string'))
    const matcher = typeof rawGlob === 'string' && rawGlob.trim() ? globToRegExp(rawGlob.trim()) : null
    const { raw, full } = lexical(dirInput, 'listFiles ')
    const start = existingReal(raw, full, pick('目录不存在', 'Folder not found'))
    if (!statSync(start).isDirectory()) throw new ProjectFileError(pick(`不是目录：${raw}`, `Not a folder: ${raw}`))
    const base = root()
    const out: string[] = []
    const walk = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase() === '.git') continue
          walk(path)
        } else if (entry.isFile()) {
          const fromStart = slash(relative(start, path))
          if (matcher && !matcher.test(fromStart)) continue
          out.push(slash(relative(base, path)))
          if (out.length > PROJECT_FILE_LIMITS.maxListed) throw new ProjectFileError(pick(`listFiles 结果超过 ${PROJECT_FILE_LIMITS.maxListed} 个文件；缩小目录或加 glob`, `listFiles found more than ${PROJECT_FILE_LIMITS.maxListed} files; narrow the folder or add a glob`))
        }
      }
    }
    walk(start)
    return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  }

  const relativeOf = (rawPath: unknown): string => slash(lexical(rawPath, '').rel)

  return {
    get root() {
      return root()
    },
    readText,
    writeText,
    listFiles,
    relativeOf
  }
}
