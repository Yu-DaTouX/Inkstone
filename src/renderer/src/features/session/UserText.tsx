import { useMemo, useState, type JSX, type ReactNode } from 'react'
import { splitImageRefs } from '../composer/image-refs'
import { HighlightedCode } from '../../patterns/HighlightedCode'
import { IconButton } from '../../ui'
import { useT } from '../../i18n'
import { Icon } from './Icon'
import { parseUserInline, parseUserSegments, type UserInlineRun } from './user-text'
import './user-text.css'

function UserCode({ code, lang }: { code: string; lang: string }): JSX.Element {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(
      () => { setState('copied'); window.setTimeout(() => setState('idle'), 1600) },
      () => { setState('failed'); window.setTimeout(() => setState('idle'), 2000) }
    )
  }
  const label = state === 'copied' ? t('code.copied') : state === 'failed' ? t('code.copyFailed') : t('code.copy')
  return (
    <div className="v3-user-code" data-lang={lang || 'text'}>
      <div className="v3-user-code-head">
        <span className="v3-user-code-lang">{lang || 'text'}</span>
        <IconButton size="sm" className="v3-user-code-act" aria-label={label} tooltip={label} onPress={copy}>
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} />
        </IconButton>
      </div>
      <pre className="v3-user-pre">
        <HighlightedCode code={code} lang={lang} />
      </pre>
    </div>
  )
}

function ImageRefs({ text }: { text: string }): JSX.Element {
  const parts = useMemo(() => splitImageRefs(text), [text])
  return (
    <>
      {parts.map((part, index) =>
        part.ref ? <mark key={index} className="v3-image-ref">{part.text}</mark> : part.text
      )}
    </>
  )
}

function UserLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <a
      className="v3-user-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void window.yan.browser.openExternal(href)
      }}
      onAuxClick={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
    >
      {children}
    </a>
  )
}

function InlineRuns({ text }: { text: string }): JSX.Element {
  const runs = useMemo(() => parseUserInline(text), [text])
  return (
    <>
      {runs.map((run: UserInlineRun, index) => {
        if (run.kind === 'code') return <code key={index} className="v3-user-inline-code">{run.text}</code>
        if (run.kind === 'link') {
          return (
            <UserLink key={index} href={run.href}>
              <bdi>{run.text}</bdi>
            </UserLink>
          )
        }
        return <ImageRefs key={index} text={run.text} />
      })}
    </>
  )
}

export function UserText({ text }: { text: string }): JSX.Element {
  const segments = useMemo(() => parseUserSegments(text), [text])
  return (
    <div className="v3-user-text" data-user-text="">
      {segments.map((segment, index) =>
        segment.kind === 'code' ? (
          <UserCode key={index} code={segment.text} lang={segment.lang} />
        ) : (
          <p key={index} className="v3-user-p">
            <InlineRuns text={segment.text} />
          </p>
        )
      )}
    </div>
  )
}
