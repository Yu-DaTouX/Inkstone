/**
 * 本地文件 → `<img src>` 能直接用的 `file://` 地址。
 *
 * Windows 盘符要**补第三个斜杠**：`C:\a\b.png` → `file:///C:/a/b.png`。
 * 写成两个斜杠时 `C:` 会被当成主机名，图片静默加载失败。
 *
 * 放 shared 里是因为两边都要用：main 把用户贴的图落盘后把地址写进消息，
 * 渲染端给模型产物（artifacts）算预览地址 —— 各写一份迟早有一处漏掉
 * 转义（路径里有空格或中文就废了）。
 *
 * ⚠️ 逐段转义，不整串 `encodeURI`：`encodeURI` **不转义 `#`**，于是
 * `图#1.png` 会变成 `file:///…/图#1.png` —— `#` 之后被当成 fragment，
 * pathname 从那里被截断，预览加载的是另一个不存在的路径。`?` 与 `%`
 * 它同样不转义。盘符段要原样保留 `C:`（`encodeURIComponent` 会写成 `C%3A`）。
 */
export function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  const encoded = normalized
    .split('/')
    .map((segment, index) => (index === 0 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
  return `file:///${encoded}`
}
