import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { APPEARANCE_EVENT } from '../../lib/appearance'
import { useStore } from '../../state/store'
import { Button, Notice } from '../../ui'
import { HTML_ARTIFACT_SANDBOX } from '../../../../shared/html-artifact-preview'
import { VISUAL_WIDGET_MAX_CHARS } from '../../../../shared/visual-blocks'
import { ArtifactFrame } from './ArtifactFrame'
import { SaveAsArtifactButton, shortHash } from './SaveAsArtifact'
import { deriveWidgetIdentityKey, useNearViewport, usePreviewSnapshot, useWidgetIdentity } from './widget-lifecycle'
import type { ArtifactForm } from './model'

const THEME_VARS: ReadonlyArray<readonly [string, string]> = [
  ['--bg', '--bg'],
  ['--surface', '--surface'],
  ['--surface-2', '--hover'],
  ['--surface-3', '--sunken'],
  ['--text', '--fg'],
  ['--text-dim', '--fg2'],
  ['--text-mute', '--fg3'],
  ['--accent', '--accent'],
  ['--on-accent', '--on-ink'],
  ['--ok', '--ok'],
  ['--warn', '--ask'],
  ['--err', '--fail'],
  ['--border', '--line'],
  ['--border-strong', '--line2'],
  ['--font', '--font-ui'],
  ['--mono', '--font-mono'],
  ['--c1', '--data-1'],
  ['--c2', '--data-2'],
  ['--c3', '--data-3'],
  ['--c4', '--data-4'],
  ['--c5', '--data-5'],
  ['--c6', '--data-6'],
  ['--background', '--bg'],
  ['--foreground', '--fg'],
  ['--muted', '--sunken'],
  ['--muted-foreground', '--fg3'],
  ['--card', '--surface'],
  ['--card-foreground', '--fg'],
  ['--popover', '--surface'],
  ['--popover-foreground', '--fg'],
  ['--secondary', '--hover'],
  ['--secondary-foreground', '--fg'],
  ['--input', '--line2'],
  ['--ring', '--accent'],
  ['--primary', '--accent'],
  ['--primary-foreground', '--on-ink'],
  ['--destructive', '--fail'],
  ['--warning', '--ask'],
  ['--success', '--ok'],
  ['--chart-1', '--data-1'],
  ['--chart-2', '--data-2'],
  ['--chart-3', '--data-3'],
  ['--chart-4', '--data-4'],
  ['--chart-5', '--data-5'],
  ['--chart-6', '--data-6'],
  ['--font-sans', '--font-ui'],
  ['--font-mono', '--font-mono']
]

const BASE_STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:var(--text);font:13px/1.7 var(--font);font-synthesis:none}
body{padding:2px}svg{max-width:100%;height:auto}a{color: var(--accent-t)}
button{font:inherit;color:inherit;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:6px;padding:2px 12px;cursor:pointer}
button:hover{border-color:var(--accent)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:1ms!important;transition-duration:1ms!important}}`

function bridgeScript(generation: number): string {
  return `(function(){var p=parent,last=0;window.__inkGen=${generation};
function post(m){m.yanGeneration=window.__inkGen;p.postMessage(m,'*')}
function h(){var r=document.documentElement;var v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v>0&&v!==last){last=v;post({method:'ui/notifications/size-changed',params:{height:v}})}}
var ro=window.ResizeObserver?new ResizeObserver(h):null;if(ro)ro.observe(document.documentElement);
addEventListener('DOMContentLoaded',function(){if(ro&&document.body)ro.observe(document.body);h()});addEventListener('load',h);setTimeout(h,0);
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var u;try{u=new URL(a.href,location.href)}catch(_){return}
if(u.protocol!=='http:'&&u.protocol!=='https:'){if(u.hash&&u.href.split('#')[0]===location.href.split('#')[0])return;e.preventDefault();return}
e.preventDefault();post({method:'ui/open-link',params:{url:u.href}})},true);
window.askInkstone=function(t){post({method:'ui/message',params:{content:String(t||'').slice(0,2000)}})};window.sendPrompt=window.askInkstone;
window.inkstoneSaveState=function(v){var s;try{s=JSON.stringify(v)}catch(_){return}if(typeof s==='string')post({method:'x-inkstone/state-save',params:{state:s}});};
addEventListener('message',function(e){if(e.source!==p)return;var d=e.data;if(!d||typeof d!=='object')return;
if(d.yanHostContext===1&&d.vars){var st=document.documentElement.style;for(var k in d.vars){if(/^--[a-z0-9-]+\$/i.test(k)&&typeof d.vars[k]==='string')st.setProperty(k,d.vars[k])}var c=d.dark?'dark':'light';st.colorScheme=c;}
else if(d.yanRestore===1&&d.state){try{window.dispatchEvent(new CustomEvent('inkstone:restore',{detail:JSON.parse(d.state)}))}catch(_){}}});
post({method:'ui/initialize',params:{version:'0.1'}});})();`
}

function themeVars(): { vars: Record<string, string>; dark: boolean } {
  const css = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const [name, source] of THEME_VARS) vars[name] = css.getPropertyValue(source).trim() || 'initial'
  const theme = document.documentElement.getAttribute('data-theme')
  const dark = theme ? theme === 'dark' : typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
  return { vars, dark }
}

function buildDocument(html: string, generation: number): string {
  const { vars, dark } = themeVars()
  const inline = Object.entries(vars).map(([name, value]) => `${name}:${value}`).join(';')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${dark ? 'dark' : 'light'}">
<style>:root{${inline};--radius:6px;color-scheme:${dark ? 'dark' : 'light'}}${BASE_STYLE}</style>
<script>${bridgeScript(generation)}</script></head><body>${html}</body></html>`
}

function standaloneDocument(html: string): string {
  const { vars, dark } = themeVars()
  const inline = Object.entries(vars).map(([name, value]) => `${name}:${value}`).join(';')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{${inline};--radius:6px;color-scheme:${dark ? 'dark' : 'light'}}${BASE_STYLE}body{padding:16px}</style>
<script>window.askInkstone=window.sendPrompt=window.inkstoneSaveState=function(){}</script></head><body>${html}</body></html>`
}

const savedWidgetState = new Map<string, string>()
const SAVED_WIDGET_STATE_MAX = 32
let widgetGeneration = 0

function rememberWidgetState(key: string, text: string): void {
  savedWidgetState.delete(key)
  savedWidgetState.set(key, text)
  while (savedWidgetState.size > SAVED_WIDGET_STATE_MAX) {
    const oldest = savedWidgetState.keys().next()
    if (oldest.done) break
    savedWidgetState.delete(oldest.value)
  }
}

export interface WidgetBlockProps {
  html: string
  fallback: React.ReactNode
  blockId?: string
}

export function WidgetBlock({ html, fallback, blockId }: WidgetBlockProps): JSX.Element {
  const t = useT()
  const openLink = useStore((s) => s.openLink)
  const insertIntoComposer = useStore((s) => s.insertIntoComposer)
  const [form, setForm] = useState<ArtifactForm>('inline')
  const [ask, setAsk] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const widgetId = useId()
  const markdownIdentity = useWidgetIdentity()
  const tooLarge = html.length > VISUAL_WIDGET_MAX_CHARS
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const build = useMemo(() => {
    if (tooLarge) return null
    const generation = ++widgetGeneration
    return { doc: buildDocument(html, generation), generation }
  }, [html, tooLarge])

  const key = deriveWidgetIdentityKey({
    sessionId: markdownIdentity?.sessionId ?? null,
    messageId: markdownIdentity?.messageId ?? null,
    instanceId: markdownIdentity?.instanceId ?? '',
    localKey: blockId,
    widgetId
  })

  const [near, nearRef] = useNearViewport<HTMLElement>()
  const snapshot = usePreviewSnapshot({
    identityKey: key,
    source: build?.doc ?? null,
    active: near && !!build,
    prepare: (doc) => window.yan.prepareHtmlWidget(doc),
    release: (url) => window.yan.releaseHtmlArtifact(url)
  })
  const error = snapshot.status === 'error' ? (snapshot.error ?? 'read') : null
  const generation = build?.generation

  useEffect(() => {
    if (generation === undefined) return
    const push = (): void => {
      const frame = frameRef.current
      if (!frame) return
      const { vars, dark } = themeVars()
      frame.contentWindow?.postMessage({ yanHostContext: 1, generation, vars, dark }, '*')
    }
    const themes = new MutationObserver(push)
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    const scheme = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    scheme?.addEventListener('change', push)
    window.addEventListener(APPEARANCE_EVENT, push)
    return () => {
      themes.disconnect()
      scheme?.removeEventListener('change', push)
      window.removeEventListener(APPEARANCE_EVENT, push)
    }
  }, [generation])

  if (tooLarge || error) {
    return (
      <div className="v3-visual-invalid">
        {fallback}
        <Notice tone="fail" compact className="v3-visual-invalid-note">
          {t('vb.invalid', { error: tooLarge ? t('vb.widgetTooLarge') : t('vb.widgetFailed', { error: error ?? '' }) })}
        </Notice>
      </div>
    )
  }

  return (
    <figure ref={nearRef} className="v3-visual v3-visual-widget" data-testid="v3-visual-widget">
      <figcaption className="v3-visual-widget-head">
        <span className="v3-visual-title" title={t('vb.widgetNote')}>
          {t('vb.widgetTitle')}
        </span>
        <span className="v3-visual-widget-sp" />
        <span className="v3-visual-source">{t('vb.widgetNote')}</span>
        <SaveAsArtifactButton
          filename={`widget-${shortHash(html)}.html`}
          sourceKey={`widget:${blockId ?? shortHash(html)}`}
          content={() => standaloneDocument(html)}
        />
      </figcaption>
      {snapshot.url && build ? (
        <ArtifactFrame
          identity={{ sessionId: markdownIdentity?.sessionId ?? null, messageId: key, partIndex: 0 }}
          title={t('vb.widgetTitle')}
          src={snapshot.url}
          form={form}
          near={near}
          sandbox={HTML_ARTIFACT_SANDBOX}
          bridge
          bridgeGeneration={build.generation}
          onDisplayModeRequest={setForm}
          onOpenLink={(link) => void openLink(link)}
          onMessage={(text) => setAsk(text)}
          onStateSave={(text) => {
            rememberWidgetState(key, text)
            setSavedAt(Date.now())
          }}
          onFrameReady={(frame) => {
            frameRef.current = frame
            const { vars, dark } = themeVars()
            frame.contentWindow?.postMessage({ yanHostContext: 1, generation: build.generation, vars, dark }, '*')
            const saved = savedWidgetState.get(key)
            if (saved) frame.contentWindow?.postMessage({ yanRestore: 1, generation: build.generation, state: saved }, '*')
          }}
        />
      ) : snapshot.status === 'paused' ? (
        <div className="v3-visual-pending" role="status" data-testid="v3-visual-widget-paused">
          <span>{t('artifact.htmlBusy')}</span>
          <Button size="sm" variant="ghost" onPress={snapshot.resume}>
            {t('artifact.htmlRetry')}
          </Button>
        </div>
      ) : (
        <div className="v3-visual-pending" role="status">
          {t('vb.pending')}
        </div>
      )}
      {savedAt ? (
        <div className="v3-visual-source" role="status" data-testid="v3-visual-widget-saved">
          {t('widget.saved')}
        </div>
      ) : null}
      {ask ? (
        <div className="v3-visual-ask" role="status" data-testid="v3-visual-widget-ask">
          <span className="v3-visual-ask-label">{t('vb.askLabel')}</span>
          <span className="v3-visual-ask-text">{ask}</span>
          <Button
            size="sm"
            variant="primary"
            onPress={() => {
              insertIntoComposer(ask)
              setAsk(null)
            }}
          >
            {t('vb.askFill')}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setAsk(null)}>
            {t('vb.askDismiss')}
          </Button>
        </div>
      ) : null}
    </figure>
  )
}
