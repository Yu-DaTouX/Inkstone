import { pick } from '../../shared/ui-lang'
import { dialog, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { resolveDomainList, type McpAppResolveHost } from '../../shared/mcp-app-preview'
import { isMcpAppPrivateHost } from './app-network-policy'
import { McpUiDownloadFileRequestSchema } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { McpAppHostRequests } from './app-view-service'

export function createMcpAppHostRequests(
  message: NonNullable<McpAppHostRequests['message']>,
  resolveHost: McpAppResolveHost = isMcpAppPrivateHost
): McpAppHostRequests {
  return {
    message,
    async openLink(value, _facts, signal) {
      if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error(pick('链接含控制字符', 'The link contains control characters'))
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error(pick('只允许无凭据的公开 HTTPS 链接', 'Only public HTTPS links without credentials are allowed'))
      const domains = await resolveDomainList([url.origin], 'network', resolveHost)
      if (!domains[0]?.allowed || signal.aborted) throw new Error(pick('链接目标被安全策略拒绝', 'The link target was rejected by the security policy'))
      await shell.openExternal(url.href)
    },
    async downloadFile(contents, _facts, signal) {
      const parsed = McpUiDownloadFileRequestSchema.parse({ method: 'ui/download-file', params: { contents } })
      if (parsed.params.contents.length !== 1) throw new Error(pick('一次只接受一个内嵌文件', 'Only one embedded file is accepted at a time'))
      const content = parsed.params.contents[0]
      if (content.type !== 'resource') throw new Error(pick('不自动获取远程下载链接，请使用内嵌资源', 'Remote download links are not fetched automatically; use an embedded resource'))
      const resource = content.resource
      const bytes = 'text' in resource ? Buffer.from(resource.text, 'utf8') : Buffer.from(resource.blob, 'base64')
      if (bytes.length > 1024 * 1024) throw new Error(pick('下载文件超过 1 MiB', 'The download is larger than 1 MiB'))
      if (signal.aborted) throw new Error(pick('App 实例已失效', 'The App instance is no longer valid'))
      const saved = await dialog.showSaveDialog({ title: pick('MCP App · 保存文件', 'MCP App · Save file'), defaultPath: 'mcp-app-export' })
      if (saved.canceled || !saved.filePath || signal.aborted) throw new Error(pick('下载已取消', 'Download cancelled'))
      await writeFile(saved.filePath, bytes, { signal })
    }
  }
}
