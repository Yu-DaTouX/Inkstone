import type { TFunc } from '../i18n'
import type { WorkspaceFit } from '../../../shared/checkpoints'
import { useStore } from '../state/store'

function sizeLabel(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

export function workspaceFitWarning(fit: WorkspaceFit | null, t: TFunc): string | null {
  if (!fit || fit.fits) return null
  const reasons: string[] = []
  if (fit.tooManyFiles) reasons.push(t('workspaceFit.tooMany'))
  if (fit.oversizedFiles > 0 && fit.largest) {
    reasons.push(t('workspaceFit.oversized', { count: fit.oversizedFiles, path: fit.largest.path, size: sizeLabel(fit.largest.bytes) }))
  }
  if (fit.tooLarge) reasons.push(t('workspaceFit.total', { size: sizeLabel(fit.totalBytes) }))
  if (!reasons.length) return null
  return t('workspaceFit.warning', { reasons: reasons.join(t('workspaceFit.separator')) })
}

export function warnIfWorkspaceUnfit(cwd: string, t: TFunc): void {
  void window.yan.checkpoints
    .assess(cwd)
    .then((fit) => {
      const text = workspaceFitWarning(fit, t)
      if (text) useStore.getState().notify('warning', text)
    })
    .catch(() => undefined)
}
