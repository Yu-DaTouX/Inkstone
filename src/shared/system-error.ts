import { pick } from './ui-lang'

const FAILURES: Record<string, [string, string]> = {
  ENOENT: ['找不到文件或目录', 'File or folder not found'],
  EACCES: ['没有访问权限', 'Permission denied'],
  EPERM: ['操作不被允许', 'Operation not permitted'],
  EBUSY: ['文件正被占用', 'File is in use'],
  ENOSPC: ['磁盘空间不足', 'Disk is full'],
  EEXIST: ['已存在同名文件或目录', 'A file or folder with that name already exists'],
  ENOTDIR: ['路径不是目录', 'Path is not a folder'],
  EISDIR: ['路径是目录而不是文件', 'Path is a folder, not a file'],
  EMFILE: ['打开的文件过多', 'Too many open files'],
  ENOTEMPTY: ['目录不为空', 'Folder is not empty'],
  ETIMEDOUT: ['连接超时', 'Connection timed out'],
  ECONNREFUSED: ['连接被拒绝', 'Connection refused'],
  ECONNRESET: ['连接被重置', 'Connection reset'],
  ENOTFOUND: ['找不到主机', 'Host not found'],
  EAI_AGAIN: ['域名解析失败', 'Name resolution failed'],
  EHOSTUNREACH: ['无法访问主机', 'Host unreachable'],
  ENETUNREACH: ['网络不可用', 'Network unreachable']
}

const ERRNO = /^(E[A-Z_]+):\s*[^,\n]*(?:,\s*\w+\s+'([^']+)')?/

export function humanizeSystemError(message: string): string | null {
  if (/^fetch failed$/i.test(message.trim())) return pick('网络请求失败', 'Network request failed')
  const match = ERRNO.exec(message)
  const failure = match ? FAILURES[match[1]] : undefined
  if (!match || !failure) return null
  const text = pick(failure[0], failure[1])
  return match[2] ? `${text}：${match[2]}` : text
}
