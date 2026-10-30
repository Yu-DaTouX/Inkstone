export function resolveComposerControlsOwnership(input: {
  readonly matchesDefault: boolean
  readonly hasTraits: boolean
  readonly collapsed: boolean
  readonly measuredHiddenBlockCount: number
}) {
  const accessDisplay = !input.matchesDefault
    ? input.collapsed
      ? ('icon' as const)
      : ('label' as const)
    : input.hasTraits
      ? ('hidden' as const)
      : ('icon' as const)
  const showModeBlock = accessDisplay !== 'hidden'
  const blockIds = [
    ...(input.hasTraits ? ['traits' as const] : []),
    ...(showModeBlock ? ['mode' as const] : [])
  ]
  const hiddenFor = (count: number) => blockIds.slice(blockIds.length - count)
  const overflowShowsPermissionsFor = (hidden: ReadonlyArray<string>) =>
    hidden.includes(input.hasTraits ? 'traits' : 'mode')
  const overflowHasContent = (hidden: ReadonlyArray<string>) =>
    hidden.includes('traits') || overflowShowsPermissionsFor(hidden)

  let hiddenBlockCount = Math.min(Math.max(0, input.measuredHiddenBlockCount), blockIds.length)
  while (
    hiddenBlockCount > 0 &&
    hiddenBlockCount < blockIds.length &&
    !overflowHasContent(hiddenFor(hiddenBlockCount))
  ) {
    hiddenBlockCount += 1
  }
  const hiddenBlockIds = hiddenFor(hiddenBlockCount)
  const modeHidden = hiddenBlockIds.includes('mode')
  const traitsHidden = hiddenBlockIds.includes('traits')
  return {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount,
    hiddenBlockIds,
    traitsHidden,
    modeHidden,
    effortOwnsModeShortcut: (input.matchesDefault || modeHidden) && !traitsHidden,
    overflowShowsPermissions: overflowShowsPermissionsFor(hiddenBlockIds)
  }
}
