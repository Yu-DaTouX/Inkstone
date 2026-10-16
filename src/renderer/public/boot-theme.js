try {
  var t = localStorage.getItem('yan.theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) {
}
