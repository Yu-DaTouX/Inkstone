export type ComposerDispatchMode = 'auto' | 'queue' | 'steer'
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, 'auto'>

export function resolveComposerDispatchMode(input: {
  readonly running: boolean
  readonly alternateModifier: boolean
  readonly activeTurnDefault?: ActiveTurnComposerAction
  readonly canSteer?: boolean
}): ComposerDispatchMode {
  if (!input.running) return 'auto'
  if (input.canSteer === false) return 'queue'
  const defaultAction = input.activeTurnDefault ?? 'steer'
  if (input.alternateModifier) return defaultAction === 'queue' ? 'steer' : 'queue'
  return defaultAction
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault })
  }) as ActiveTurnComposerAction
}
