export const SKIP_MARKER = '[skip]'

export function reportSkip(message) {
  console.log(`${SKIP_MARKER} ${message}`)
}
