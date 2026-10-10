import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, IconButton } from '../ui'
import { APPEARANCE_EVENT } from '../../lib/appearance'
import { HTML_ARTIFACT_SANDBOX } from '../../../../shared/html-artifact-preview'
import { safeHttpUrl, VISUAL_WIDGET_MAX_CHARS } from '../../../../shared/visual-blocks'

/**
 * 消息内小部件（```yan-widget）：模型写的 HTML/SVG 片段，用于图解、原理示意、交互讲解与插画。
 *
 * - 放进与 HTML 成果同一个隔离协议：无网络、无同源、无宿主对象，CSP 由主进程下发；
 * - 宿主注入主题变量与基础样式；换主题只经消息通道发新变量，不重建页面，页面内的操作不丢；
 * - 离视口很远时卸载页面、只留同高占位，回来重新载入（与 HTML 成果预览同一组边界），
 *   标题行写明当前是「活跃」还是「已暂停」；
 * - 页面只能经 postMessage 回报三件事：高度、打开 http(s) 链接、请求追问。
 *   追问不会自动发送：先在小部件下方显示文字，用户点「填入输入框」后照常由用户发送。
 */

/** 小部件可用的主题变量（名字对模型稳定，值取自砚的令牌） */
const THEME_VARS: Array<[string, string]> = [
  ['--bg', '--bg-0'], ['--surface', '--bg-1'], ['--surface-2', '--bg-2'], ['--surface-3', '--bg-3'],
  ['--text', '--fg'], ['--text-dim', '--fg-dim'], ['--text-mute', '--fg-mute'],
  ['--accent', '--accent'], ['--accent-soft', '--accent-soft'], ['--on-accent', '--on-accent'],
  ['--ok', '--ok'], ['--warn', '--warn'], ['--err', '--err'],
  ['--ok-soft', '--ok-soft'], ['--warn-soft', '--warn-soft'], ['--err-soft', '--err-soft'],
  ['--border', '--border'], ['--border-soft', '--border-soft'], ['--border-strong', '--border-str'],
  ['--font', '--font-body'], ['--mono', '--font-code'],
  ['--c1', '--accent'], ['--c2', '--think-low'], ['--c3', '--warn'], ['--c4', '--think-xhigh'], ['--c5', '--think-high'], ['--c6', '--ok']
]

/** 消息内的高度上限：再高就在框内滚动，不让一个小部件占满整屏 */
const WIDGET_MAX_H = 560
/** 进入近处才载入；离得很远才卸载（与 HtmlArtifactPreview 同一组边界） */
const LOAD_MARGIN = '240px'
const KEEP_MARGIN = '1200px'
/* 已量过的高度：重新挂载（切换分屏会话）时先按它占位，页面载入后不再跳动 */
const heightCache = new Map<string, number>()

/* 桥接：回报高度 / 打开链接 / 追问；只接受父窗口发来的主题变量（逐个 setProperty，不执行任何内容） */
const BRIDGE = `(function(){var p=parent,last=0;function post(m){m.yanWidget=1;p.postMessage(m,'*')}
function h(){var v=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(v!==last){last=v;post({type:'height',h:v})}}
addEventListener('load',h);new ResizeObserver(h).observe(document.documentElement);setTimeout(h,0);
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;e.preventDefault();post({type:'open',url:a.href})},true);
addEventListener('message',function(e){if(e.source!==p)return;var d=e.data;if(!d||d.yanTheme!==1||!d.vars)return;var s=document.documentElement.style;for(var k in d.vars){if(/^--[a-z0-9-]+$/.test(k)&&typeof d.vars[k]==='string')s.setProperty(k,d.vars[k])}var c=d.dark?'dark':'light';s.colorScheme=c;var m=document.querySelector('meta[name=color-scheme]');if(m)m.content=c});
window.askInkstone=function(t){post({type:'ask',text:String(t||'').slice(0,500)})};window.sendPrompt=window.askInkstone;})();`

function themeVars(): { vars: Record<string, string>; dark: boolean } {
  const css = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const [name, source] of THEME_VARS) vars[name] = css.getPropertyValue(source).trim() || 'initial'
  return { vars, dark: document.documentElement.getAttribute('data-theme') === 'dark' }
}

function buildDocument(html: string): string {
  const { vars, dark } = themeVars()
  const inline = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${dark ? 'dark' : 'light'}">
<style>:root{${inline};--radius:4px;color-scheme:${dark ? 'dark' : 'light'}}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:var(--text);font:13px/1.7 var(--font);font-synthesis:none}
body{padding:2px}svg{max-width:100%;height:auto}svg text{fill:var(--text)}a{color:var(--accent)}
button{font:inherit;color:inherit;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:4px;padding:2px 12px;cursor:pointer}
button:hover{border-color:var(--accent)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
input,select,textarea{font:inherit;color:inherit;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:2px 8px}
input[type=range]{-webkit-appearance:none;appearance:none;height:16px;padding:0;border:0;background:none;accent-color:var(--accent)}
input[type=range]::-webkit-slider-runnable-track{height:2px;border-radius:1px;background:var(--border-strong)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;margin-top:-4px;border-radius:50%;background:var(--accent)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:1ms!important;transition-duration:1ms!important}}</style>
<script>${BRIDGE}</script></head><body>${html}</body></html>`
}

export function WidgetBlock({ html, fallback }: { html: string; fallback: React.ReactNode }) {
  const t = useT()
  const link = useStore((s) => s.openBrowser)
  const root = useRef<HTMLElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [near, setNear] = useState(false)
  const [reload, setReload] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(() => heightCache.get(html) ?? 160)
  const [ask, setAsk] = useState<string | null>(null)
  const tooLarge = html.length > VISUAL_WIDGET_MAX_CHARS
  /* 文档只随内容变化；主题由下面的消息通道更新 */
  const doc = useMemo(() => (tooLarge ? '' : buildDocument(html)), [html, tooLarge])

  useEffect(() => {
    const node = root.current
    if (!node) return
    const load = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true)
    }, { rootMargin: LOAD_MARGIN })
    const keep = new IntersectionObserver((entries) => {
      if (entries.every((entry) => !entry.isIntersecting)) setNear(false)
    }, { rootMargin: KEEP_MARGIN })
    load.observe(node)
    keep.observe(node)
    return () => { load.disconnect(); keep.disconnect() }
  }, [])

  /* 换主题：把新变量发进页面（页面状态保留）；页面重新载入时也补发一次 */
  const sendTheme = (): void => {
    frame.current?.contentWindow?.postMessage({ yanTheme: 1, ...themeVars() }, '*')
  }
  useEffect(() => {
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener(APPEARANCE_EVENT, sendTheme)
    return () => { observer.disconnect(); window.removeEventListener(APPEARANCE_EVENT, sendTheme) }
  }, [])

  useEffect(() => {
    if (!doc || !near) { setUrl(null); return }
    let alive = true
    let prepared: string | null = null
    setError(null)
    void window.yan.prepareHtmlWidget(doc).then((result) => {
      if (!result.ok) { if (alive) setError(result.error); return }
      prepared = result.url
      if (alive) setUrl(result.url)
      else void window.yan.releaseHtmlArtifact(result.url).catch(() => undefined)
    }).catch(() => { if (alive) setError('read') })
    return () => {
      alive = false
      setUrl(null)
      if (prepared) void window.yan.releaseHtmlArtifact(prepared).catch(() => undefined)
    }
  }, [doc, near, reload])

  /* 只认自己这个 iframe 发来的、格式正确的三种消息 */
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const data = event.data as { yanWidget?: number; type?: string; h?: unknown; url?: unknown; text?: unknown }
      if (!data || data.yanWidget !== 1) return
      if (data.type === 'height' && typeof data.h === 'number' && Number.isFinite(data.h)) { const next = Math.max(40, Math.min(WIDGET_MAX_H, Math.ceil(data.h))); if (heightCache.size >= 100) heightCache.delete(heightCache.keys().next().value as string); heightCache.set(html, next); setHeight(next) }
      else if (data.type === 'open') { const target = safeHttpUrl(data.url); if (target) void link(target) }
      else if (data.type === 'ask' && typeof data.text === 'string' && data.text.trim()) setAsk(data.text.trim().slice(0, 500))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [link, html])

  if (tooLarge || error) {
    return <div className="vb-invalid">{fallback}<div className="vb-invalid-note">{t('vb.invalid', { error: tooLarge ? t('vb.widgetTooLarge') : t('vb.widgetFailed', { error: error ?? '' }) })}</div></div>
  }
  const live = !!url
  return (
    <figure ref={root} className="vb vb-widget" data-testid="vb-widget" onClick={(e) => e.stopPropagation()}>
      {/* 标题行与图表标题同级：名称 · 隔离说明 ······ 生命周期 · 重新载入 */}
      <figcaption className="vb-widget-head">
        <span className="vb-widget-name" title={t('vb.widgetNote')}>{t('vb.widgetTitle')}</span>
        <span className="vb-widget-sp" />
        <span className={`vb-widget-life${live ? ' on' : ''}`} data-testid="vb-widget-life" title={live ? undefined : t('artifact.htmlParked')}>
          {live ? t('widget.live') : t('widget.paused')}
        </span>
        <IconButton size="sm" icon="refresh" label={t('artifact.htmlReload')} onClick={() => setReload((n) => n + 1)} />
      </figcaption>
      <div className="vb-widget-stage" style={{ height }}>
        {url ? <iframe
          ref={frame}
          key={url}
          className="ui-html-preview vb-widget-frame"
          src={url}
          title={`${t('vb.widgetTitle')} · ${t('vb.widgetNote')}`}
          sandbox={HTML_ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; display-capture 'none'; usb 'none'; serial 'none'; payment 'none'"
          data-testid="vb-widget-frame"
          onLoad={sendTheme}
        /> : <div className="vb-pending-inline" role="status">{near ? t('vb.pending') : t('artifact.htmlParked')}</div>}
      </div>
      {ask ? (
        <div className="vb-ask" role="status">
          <span className="vb-ask-label">{t('vb.askLabel')}</span>
          <span className="vb-ask-text">{ask}</span>
          <Button size="sm" variant="primary" onClick={() => { useStore.getState().insertIntoComposer(ask); setAsk(null) }}>{t('vb.askFill')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>{t('vb.askDismiss')}</Button>
        </div>
      ) : null}
    </figure>
  )
}
