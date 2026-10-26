try {
  var t = localStorage.getItem('yan.theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) {
}
try {
  var m = window.yan && window.yan.windowMaterial
  if (m) document.documentElement.dataset.material = m
} catch (e) {
}
