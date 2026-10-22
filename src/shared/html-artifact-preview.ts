import { canvasBridgeRuntime } from './html-canvas-bridge'
import { markHtmlSourceOffsets } from './html-source-map'

export const HTML_ARTIFACT_SCHEME = 'inkstone-html'
export const HTML_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024
export const HTML_ARTIFACT_SANDBOX = 'allow-scripts'
export const HTML_INLINE_MAX_BYTES = 1024 * 1024

export type HtmlArtifactPreviewError = 'outside' | 'type' | 'size' | 'read' | 'busy'
export type HtmlArtifactPreviewResult =
  | { ok: true; url: string; nonce: string; hash: string }
  | { ok: false; error: HtmlArtifactPreviewError }

export function isHtmlArtifact(artifact: { filename: string; mediaType?: string }): boolean {
  return /\.html?$/i.test(artifact.filename) || artifact.mediaType?.split(';', 1)[0].trim().toLowerCase() === 'text/html'
}

export const HTML_ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${HTML_ARTIFACT_SCHEME}:`,
  `style-src 'unsafe-inline' ${HTML_ARTIFACT_SCHEME}:`,
  `img-src data: blob: ${HTML_ARTIFACT_SCHEME}:`,
  `font-src data: ${HTML_ARTIFACT_SCHEME}:`,
  `media-src data: blob: ${HTML_ARTIFACT_SCHEME}:`,
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
var parent=window.parent;
var K=${JSON.stringify(HTML_PREVIEW_CHANNEL)};
function shown(r){return r&&r.width>0&&r.height>0?r:null}
var undo=[];
function restore(){for(var i=undo.length-1;i>=0;i--){var u=undo[i];if(u.c){if(u.on)u.el.classList.add(u.c);else u.el.classList.remove(u.c)}else if(u.h)u.el.setAttribute('hidden','');else if(u.v)u.el.style.setProperty('display',u.v,u.p);else u.el.style.removeProperty('display')}undo=[]}
function setClass(el,c,on){if(el.classList.contains(c)===on)return;undo.push({el:el,c:c,on:!on});if(on)el.classList.add(c);else el.classList.remove(c)}
function rendered(el){return getComputedStyle(el).display!=='none'}
function setDisplay(el,v){undo.push({el:el,v:el.style.getPropertyValue('display'),p:el.style.getPropertyPriority('display')});el.style.setProperty('display',v,'important')}
function hiddenPanel(el){while(el&&el!==document.body){if(getComputedStyle(el).display==='none'){var p=el.parentElement;if(!p)return null;for(var c=p.firstElementChild;c;c=c.nextElementSibling){if(c!==el&&c.tagName===el.tagName&&c.getClientRects().length)return{panel:el,live:c}}return null}el=el.parentElement}return null}
function reveal(el){var h=hiddenPanel(el);if(!h)return false;var d=getComputedStyle(h.live).display;var moved=[].slice.call(h.live.classList).filter(function(c){if(h.panel.classList.contains(c))return false;h.live.classList.remove(c);var off=!rendered(h.live);h.live.classList.add(c);return off});moved.forEach(function(c){setClass(h.live,c,false);setClass(h.panel,c,true)});if(h.panel.hasAttribute('hidden')){undo.push({el:h.panel,h:1});h.panel.removeAttribute('hidden')}if(!rendered(h.panel))setDisplay(h.panel,d);if(rendered(h.live))setDisplay(h.live,'none');return true}
function tail(allow){if(!document.body)return null;var all=document.body.getElementsByTagName('*');for(var i=all.length-1;i>=0;i--){var t=all[i].tagName;if(t==='SCRIPT'||t==='STYLE'||t==='TEMPLATE')continue;var r=shown(all[i].getBoundingClientRect());if(r)return r;if(allow&&all[i].textContent.trim()&&reveal(all[i])){r=shown(all[i].getBoundingClientRect());if(r)return r}}return null}
function find(text,allow){if(!document.body)return null;var needle=String(text).replace(/\\s+/g,' ').trim();if(!needle)return null;var walker=document.createTreeWalker(document.body,4);var node,best=null,hidden=null;while((node=walker.nextNode())){var v=node.nodeValue;if(!v||v.replace(/\\s+/g,' ').indexOf(needle)<0)continue;var range=document.createRange();range.selectNodeContents(node);var r=shown(range.getBoundingClientRect());if(r){best=r;break}if(!hidden)hidden=range}if(!best&&hidden&&allow&&reveal(hidden.startContainer.parentElement))best=shown(hidden.getBoundingClientRect());return best}
function measure(d){restore();var r=d.text?find(d.text,!!d.follow):tail(!!d.follow);if(r&&d.follow&&(r.top<0||r.bottom>innerHeight)){scrollTo(0,Math.max(0,r.top+scrollY-innerHeight*0.3));r=d.text?find(d.text,false):tail(false)}return r}
addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=='object')return;if(d[K]==='chrome'){document.documentElement.setAttribute('data-yan-chrome',d.bare?'bare':'');return}if(d[K]==='restore'){restore();return}if(d[K]!=='probe')return;var r=null;try{r=measure(d)}catch(_){}var reply={id:d.id,rect:r?{x:r.left,y:r.top,w:r.width,h:r.height}:null,docHeight:document.documentElement?document.documentElement.scrollHeight:0};reply[K]='probe';parent.postMessage(reply,'*')});
})();`

const PREVIEW_RUNTIME = `<style data-yan-preview>${PREVIEW_RUNTIME_STYLE}</style><script data-yan-preview>${PREVIEW_RUNTIME_SCRIPT}</script>`

export function withPreviewRuntime(html: string, nonce?: string): string {
  const marked = markHtmlSourceOffsets(html.replace(/^\uFEFF/, ''))
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(marked)
  const at = doctype ? doctype[0].length : 0
  return marked.slice(0, at) + PREVIEW_RUNTIME + canvasBridgeRuntime(nonce) + marked.slice(at)
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

export const HTML_ASSET_MAX_BYTES = 8 * 1024 * 1024

export const HTML_ASSET_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export function htmlArtifactAsset(url: string): { token: string; rel: string; type: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${HTML_ARTIFACT_SCHEME}:` || parsed.username || parsed.password || parsed.port) return null
    if (!/^[a-f0-9]{32}$/.test(parsed.hostname) || parsed.pathname === '/index.html') return null
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
    const segments = rel.split(/[\\/]/)
    if (!rel || rel.includes('\0') || rel.includes(':') || segments.some((part) => !part || part === '.' || part === '..')) return null
    const dot = rel.lastIndexOf('.')
    const type = dot > 0 ? HTML_ASSET_TYPES[rel.slice(dot).toLowerCase()] : undefined
    return type ? { token: parsed.hostname, rel: segments.join('/'), type } : null
  } catch {
    return null
  }
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
