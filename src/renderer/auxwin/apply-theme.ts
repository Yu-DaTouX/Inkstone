try {
  const t = localStorage.getItem('yan.theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch {
  /* 独立打开调试时 localStorage 可能不可用，保持默认深色 */
}
export {}
