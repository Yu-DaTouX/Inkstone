import { useMemo, type JSX, type ReactNode } from 'react'
import { splitImageRefs } from '../composer/image-refs'
import { HighlightedCode } from '../../patterns/HighlightedCode'
import { parseUserInline, parseUserSegments, type UserInlineRun } from './user-text'
import './user-text.css'

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
          <div key={index} className="v3-user-code" data-lang={segment.lang}>
            <pre className="v3-user-pre">
              <HighlightedCode code={segment.text} lang={segment.lang} />
            </pre>
          </div>
        ) : (
          <p key={index} className="v3-user-p">
            <InlineRuns text={segment.text} />
          </p>
        )
      )}
    </div>
  )
}
