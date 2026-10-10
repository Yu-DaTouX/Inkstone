import { protocol, session, type WebContents } from 'electron'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { HtmlArtifactPreviewStore } from './html-artifact-preview-store'
import { HTML_ARTIFACT_CSP, HTML_ARTIFACT_SCHEME } from '../shared/html-artifact-preview'

// 在 app.ready 之前声明；独立文档不继承主窗口 CSP，也不获得同源权限。
protocol.registerSchemesAsPrivileged([
  { scheme: HTML_ARTIFACT_SCHEME, privileges: { standard: true, secure: true } }
])

export const htmlArtifactPreviews = new HtmlArtifactPreviewStore(join(YAN_DIR, 'artifacts'))
const isPreviewUrl = (url: string): boolean => url.startsWith(`${HTML_ARTIFACT_SCHEME}:`)

export function registerHtmlArtifactProtocol(): void {
  protocol.handle(HTML_ARTIFACT_SCHEME, (request) => {
    const html = request.method === 'GET' ? htmlArtifactPreviews.read(request.url) : null
    return new Response(html ?? 'Preview unavailable', {
      status: html === null ? 404 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': HTML_ARTIFACT_CSP,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), display-capture=(), usb=(), serial=(), payment=()'
      }
    })
  })

  // CSP 之外再拦子文档导航，包含 meta refresh；不影响浏览器的独立 partition。
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const source = details.frame?.url ?? ''
    if (details.resourceType === 'subFrame') {
      callback({ cancel: htmlArtifactPreviews.read(details.url) === null })
    } else if (isPreviewUrl(source) || isPreviewUrl(details.referrer)) {
      callback({ cancel: !/^(data:|blob:)/.test(details.url) })
    } else {
      callback({ cancel: false })
    }
  })
}

export function guardHtmlArtifactFrames(contents: WebContents): void {
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame) htmlArtifactPreviews.clear()
  })
  contents.on('render-process-gone', () => htmlArtifactPreviews.clear())
  contents.once('destroyed', () => htmlArtifactPreviews.clear())
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    // 只有主页面可以装配 iframe；产物自己发起的外链/重载不交给系统浏览器。
    const parentInitiated = event.initiator === contents.mainFrame
    const directChild = event.frame?.parent === contents.mainFrame
    if (!parentInitiated || !directChild || htmlArtifactPreviews.read(event.url) === null) event.preventDefault()
  })
}
