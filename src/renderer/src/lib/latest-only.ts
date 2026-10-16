export interface LatestOnly {
  begin(): number
  isCurrent(token: number): boolean
  invalidate(): void
}

export function createLatestOnly(): LatestOnly {
  let seq = 0
  return {
    begin: () => ++seq,
    isCurrent: (token) => token === seq,
    invalidate: () => {
      seq += 1
    }
  }
}
