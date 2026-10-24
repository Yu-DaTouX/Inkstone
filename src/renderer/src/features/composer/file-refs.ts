import type { Attachment } from '../../../../shared/ipc'

export function fileReferencePath(attachment: Attachment): string {
  const path = attachment.path ?? ''
  return attachment.isDirectory ? `${path.replace(/[\\/]+$/, '')}/` : path
}

export function splitFileReferences(text: string): { text: string; files: { path: string; name: string; isDirectory: boolean }[] } {
  const footer = /(?:^|\n\n)(?:（附件文件，可直接读取）|\(Attached files — read them as needed\))\r?\n((?:- [^\r\n]+(?:\r?\n|$))+)$/.exec(text)
  if (!footer) return { text, files: [] }
  const paths = footer[1].trimEnd().split(/\r?\n/).map((line) => line.slice(2))
  if (paths.some((path) => !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path))) return { text, files: [] }
  return {
    text: text.slice(0, footer.index),
    files: [...new Set(paths)].map((path) => ({
      path,
      name: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path,
      isDirectory: /[\\/]$/.test(path)
    }))
  }
}
