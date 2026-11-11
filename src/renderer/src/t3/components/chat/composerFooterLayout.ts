export interface RestingComposerControlsMeasurement {
  gap: number
  naturalFixedWidth: number
  minimumFixedWidth: number
  blockWidths: readonly number[]
  overflowWidth: number
  iconOnlyBlockWidths?: readonly number[]
}

function restingComposerControlsWidth(
  input: RestingComposerControlsMeasurement,
  hiddenCount: number,
  fixedWidth = input.naturalFixedWidth,
  iconOnlyCount = 0
): number {
  const { blockWidths, gap } = input
  const visibleCount = blockWidths.length - hiddenCount
  return (
    fixedWidth +
    blockWidths
      .slice(0, visibleCount)
      .reduce(
        (sum, width, index) =>
          sum +
          (index >= blockWidths.length - iconOnlyCount
            ? (input.iconOnlyBlockWidths?.[index] ?? width)
            : width),
        0
      ) +
    (hiddenCount > 0 ? input.overflowWidth : 0) +
    gap * (visibleCount + (hiddenCount > 0 ? 1 : 0))
  )
}

const RESTING_CONTROLS_SLACK_PX = 1

export function resolveRestingComposerControlsLayout(
  input: RestingComposerControlsMeasurement & {
    hostWidth: number
    previous?: { hiddenCount: number; iconOnlyCount?: number; visible: boolean }
  }
): { hiddenCount: number; iconOnlyCount?: number; visible: boolean } {
  const { blockWidths, hostWidth, previous } = input
  const iconSteps = input.iconOnlyBlockWidths ? blockWidths.length : 0
  const previousStep = previous
    ? previous.hiddenCount > 0
      ? iconSteps + Math.min(previous.hiddenCount, blockWidths.length)
      : Math.min(previous.iconOnlyCount ?? 0, iconSteps)
    : 0
  let step = 0
  const widthAtStep = (candidate: number, fixedWidth = input.naturalFixedWidth) =>
    restingComposerControlsWidth(
      input,
      Math.max(0, candidate - iconSteps),
      fixedWidth,
      Math.min(candidate, iconSteps)
    )
  while (
    step < iconSteps + blockWidths.length &&
    widthAtStep(step) > hostWidth - (step < previousStep ? RESTING_CONTROLS_SLACK_PX : 0)
  ) {
    step += 1
  }
  const hiddenCount = Math.max(0, step - iconSteps)
  const iconOnlyCount = Math.min(step, iconSteps)
  const minimumWidth = widthAtStep(step, input.minimumFixedWidth)
  const visible =
    previous && !previous.visible
      ? minimumWidth <= hostWidth - RESTING_CONTROLS_SLACK_PX
      : minimumWidth <= hostWidth
  return { hiddenCount, ...(input.iconOnlyBlockWidths ? { iconOnlyCount } : {}), visible }
}
