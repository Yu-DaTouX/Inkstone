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
      if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error('链接含控制字符')
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('只允许无凭据的公开 HTTPS 链接')
      const domains = await resolveDomainList([url.origin], 'network', resolveHost)
      if (!domains[0]?.allowed || signal.aborted) throw new Error('链接目标被安全策略拒绝')
      await shell.openExternal(url.href)
    },
    async downloadFile(contents, _facts, signal) {
      const parsed = McpUiDownloadFileRequestSchema.parse({ method: 'ui/download-file', params: { contents } })
      if (parsed.params.contents.length !== 1) throw new Error('一次只接受一个内嵌文件')
      const content = parsed.params.contents[0]
      if (content.type !== 'resource') throw new Error('不自动获取远程下载链接，请使用内嵌资源')
      const resource = content.resource
      const bytes = 'text' in resource ? Buffer.from(resource.text, 'utf8') : Buffer.from(resource.blob, 'base64')
      if (bytes.length > 1024 * 1024) throw new Error('下载文件超过 1 MiB')
      if (signal.aborted) throw new Error('App 实例已失效')
      const saved = await dialog.showSaveDialog({ title: 'MCP App · 保存文件', defaultPath: 'mcp-app-export' })
      if (saved.canceled || !saved.filePath || signal.aborted) throw new Error('下载已取消')
      await writeFile(saved.filePath, bytes, { signal })
    }
  }
}
