/*
 * 首帧主题：在样式与启动画面绘制前把 <html data-theme> 设成上次用的主题，
 * 免得浅色用户先看到一帧深色启动画面。真源仍是设置里的 theme，这里只读 App 落下的缓存。
 * 放成外部经典脚本是因为 CSP 不允许内联脚本（index.html 的 script-src 'self'）。
 */
try {
  var t = localStorage.getItem('yan.theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) {
  /* file:// 或存储被禁用时保持默认深色 */
}
