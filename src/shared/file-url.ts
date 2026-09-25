/**
 * 本地文件 → `<img src>` 能直接用的 `file://` 地址。
 *
 * Windows 盘符要**补第三个斜杠**：`C:\a\b.png` → `file:///C:/a/b.png`。
 * 写成两个斜杠时 `C:` 会被当成主机名，图片静默加载失败。
 *
 * 放 shared 里是因为两边都要用：main 把用户贴的图落盘后把地址写进消息，
 * 渲染端给模型产物（artifacts）算预览地址 —— 各写一份迟早有一处漏掉
 * `encodeURI`（路径里有空格或中文就废了）。
 */
export function fileUrl(path: string): string {
  return `file:///${encodeURI(path.replace(/\\/g, '/').replace(/^\/+/, ''))}`
}
