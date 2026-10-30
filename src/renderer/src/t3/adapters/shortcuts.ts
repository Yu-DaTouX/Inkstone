export function shortcutLabelForCommand(): string | null {
  return null
}

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '')
}

export function modelJumpLabel(index: number): string | null {
  if (index < 0 || index > 8) return null
  return isMacPlatform() ? `⌘${index + 1}` : `Ctrl+${index + 1}`
}

export const MODEL_JUMP_LIMIT = 9
