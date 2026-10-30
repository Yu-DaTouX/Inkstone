import { useMemo } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { isComposerImage } from './composer-attachments'
import { brokenImageRefs, imageRefLabel, imageRefPrefix } from '../../features/composer/image-refs'

export type ComposerNoticeTone = 'warning' | 'destructive'

export interface ComposerNoticeState {
  readonly tone: ComposerNoticeTone
  readonly message: string
}

export function useComposerNotice(text: string): ComposerNoticeState | null {
  const t = useT()
  const { lang } = useI18n()
  const imageCount = useStore((s) => s.attachments.filter(isComposerImage).length)
  return useMemo(() => {
    const { missing, removed } = brokenImageRefs(text, imageCount)
    if (missing.length === 0 && removed === 0) return null
    const prefix = imageRefPrefix(lang)
    const labels = [...missing.map((n) => `@${imageRefLabel(prefix, n)}`), ...(removed ? [`@${prefix}?`] : [])]
    return { tone: 'warning' as const, message: t('composer.imageRefBroken', { list: labels.join(' ') }) }
  }, [text, imageCount, lang, t])
}
