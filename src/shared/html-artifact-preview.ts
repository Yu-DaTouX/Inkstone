export const HTML_ARTIFACT_SCHEME = 'inkstone-html'
export const HTML_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024
export const HTML_ARTIFACT_SANDBOX = 'allow-scripts'
export const HTML_INLINE_MAX_BYTES = 1024 * 1024

export type HtmlArtifactPreviewError = 'outside' | 'type' | 'size' | 'read' | 'busy'
export type HtmlArtifactPreviewResult =
  | { ok: true; url: string }
  | { ok: false; error: HtmlArtifactPreviewError }

export function isHtmlArtifact(artifact: { filename: string; mediaType?: string }): boolean {
  return /\.html?$/i.test(artifact.filename) || artifact.mediaType?.split(';', 1)[0].trim().toLowerCase() === 'text/html'
}

export const HTML_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts'
].join('; ')

export const HTML_PREVIEW_CHANNEL = 'yan-preview'

export interface HtmlPreviewRect {
  x: number
  y: number
  w: number
  h: number
}

export interface HtmlPreviewProbeReply {
  id: number
  rect: HtmlPreviewRect | null
  docHeight: number
}

const PREVIEW_RUNTIME_STYLE = [
  '::-webkit-scrollbar{width:10px;height:10px}',
  '::-webkit-scrollbar-thumb{background:rgba(128,128,128,.42);background-clip:padding-box;border:3px solid transparent;border-radius:999px}',
  '::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}',
  'html[data-yan-chrome=bare],html[data-yan-chrome=bare] *{scrollbar-width:none}'
].join('')

const PREVIEW_RUNTIME_SCRIPT = `(function(){
var K=${JSON.stringify(HTML_PREVIEW_CHANNEL)};
function shown(r){return r&&r.width>0&&r.height>0?r:null}
function tail(){if(!document.body)return null;var all=document.body.getElementsByTagName('*');for(var i=all.length-1;i>=0;i--){var t=all[i].tagName;if(t==='SCRIPT'||t==='STYLE'||t==='TEMPLATE')continue;var r=shown(all[i].getBoundingClientRect());if(r)return r}return null}
function find(text){if(!document.body)return null;var needle=String(text).replace(/\\s+/g,' ').trim();if(!needle)return null;var walker=document.createTreeWalker(document.body,4);var node,best=null;while((node=walker.nextNode())){var v=node.nodeValue;if(!v||v.replace(/\\s+/g,' ').indexOf(needle)<0)continue;var range=document.createRange();range.selectNodeContents(node);var r=shown(range.getBoundingClientRect());if(r){best=r;break}}return best}
function measure(d){var r=d.text?find(d.text):tail();if(r&&d.follow&&(r.top<0||r.bottom>innerHeight)){scrollTo(0,Math.max(0,r.top+scrollY-innerHeight*0.3));r=d.text?find(d.text):tail()}return r}
addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=='object')return;if(d[K]==='chrome'){document.documentElement.setAttribute('data-yan-chrome',d.bare?'bare':'');return}if(d[K]!=='probe')return;var r=null;try{r=measure(d)}catch(_){}var reply={id:d.id,rect:r?{x:r.left,y:r.top,w:r.width,h:r.height}:null,docHeight:document.documentElement?document.documentElement.scrollHeight:0};reply[K]='probe';parent.postMessage(reply,'*')});
})();`

const PREVIEW_RUNTIME = `<style data-yan-preview>${PREVIEW_RUNTIME_STYLE}</style><script data-yan-preview>${PREVIEW_RUNTIME_SCRIPT}</script>`

export function withPreviewRuntime(html: string): string {
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype[0].length : 0
  return html.slice(0, at) + PREVIEW_RUNTIME + html.slice(at)
}

export function readProbeReply(data: unknown): HtmlPreviewProbeReply | null {
  if (!data || typeof data !== 'object') return null
  const value = data as Record<string, unknown>
  if (value[HTML_PREVIEW_CHANNEL] !== 'probe' || typeof value.id !== 'number') return null
  const raw = value.rect as Record<string, unknown> | null | undefined
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  const rect = raw && finite(raw.x) && finite(raw.y) && finite(raw.w) && finite(raw.h) ? { x: raw.x, y: raw.y, w: raw.w, h: raw.h } : null
  return { id: value.id, rect, docHeight: finite(value.docHeight) ? value.docHeight : 0 }
}

export function htmlArtifactToken(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${HTML_ARTIFACT_SCHEME}:` || parsed.pathname !== '/index.html' || parsed.search || parsed.username || parsed.password || parsed.port) return null
    return /^[a-f0-9]{32}$/.test(parsed.hostname) ? parsed.hostname : null
  } catch {
    return null
  }
}
