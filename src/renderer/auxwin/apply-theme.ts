try {
  const t = localStorage.getItem('yan.theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch {
}
export {}
