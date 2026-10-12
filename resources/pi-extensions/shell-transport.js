/**
 * Windows 上 bash 工具的命令交付方式（由 shell-fallback.js 接入，本文件不依赖 pi，便于单测）。
 *
 * pi 原生把整条命令作为 `bash.exe -c <命令>` 的一个参数交给 Git Bash。这一跳经过 MSYS2
 * 的命令行解析：成对反斜杠被减半（`\\` → `\`，heredoc 与单引号里也一样），命令超过
 * 8186 个字符会被截断；前者退出码照样是 0，后者报成看似引号没配对的语法错误。
 * 模型拿到这种结果会以为自己写错了命令，反复改写本来正确的命令。
 *
 * 这里改为把命令原文写进临时文件，`-c` 只携带一句不含反斜杠的 `. '<文件>'`，由同一个
 * bash 读取执行。模型看到的命令、审批与会话记录里的仍是原文，只换交付这一跳。
 * 不走 stdin（`bash -s`）：命令里读 stdin 的程序会把后面的脚本当输入吃掉。
 */

import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Windows 路径转成 bash 单引号字面量：反斜杠换成 `/`，单引号按 `'\''` 转义。 */
export function bashQuotedPath(path) {
  return `'${path.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

/**
 * 包装 pi 的 BashOperations：每次执行把命令写进新的临时文件（仅当前用户可读、
 * 不覆盖已有文件），执行结束即删除。`source` 会先把整个文件读进来，所以删除不影响
 * 命令里起的后台进程。`preamble` 是宿主要求的环境准备（不含反斜杠的一句 bash），
 * 在同一个 bash 里先于命令执行，不写进命令文件。
 */
export function fileTransportOperations(base, { dir = tmpdir(), preamble = '' } = {}) {
  return {
    ...base,
    async exec(command, cwd, options) {
      const file = join(dir, `yan-bash-${randomBytes(8).toString('hex')}.sh`)
      await writeFile(file, command, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        return await base.exec(`${preamble ? `${preamble}; ` : ''}. ${bashQuotedPath(file)}`, cwd, options)
      } finally {
        await rm(file, { force: true }).catch(() => {})
      }
    }
  }
}
