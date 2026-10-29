export function installHairline(root: HTMLElement = document.documentElement): void {
  let query: MediaQueryList | null = null
  const apply = (): void => {
    const ratio = window.devicePixelRatio || 1
    root.style.setProperty('--hair', `${Math.max(1, Math.floor(ratio)) / ratio}px`)
    query?.removeEventListener('change', apply)
    query = window.matchMedia(`(resolution: ${ratio}dppx)`)
    query.addEventListener('change', apply)
  }
  apply()
}
