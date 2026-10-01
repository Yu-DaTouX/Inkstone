/* Shared UI actions for probes using the current workspace launcher. */
window.__yanOpenWorkspaceTool = async (title, id) => {
  const wait = async predicate => {
    const end = Date.now() + 8000
    while (Date.now() < end) {
      if (predicate()) return true
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  }
  const visible = () => document.querySelector(`[data-workspace-pane="${id}"]:not([hidden])`)
  if (visible()) return visible()
  document.querySelector('[data-testid="right-tool-menu"]')?.click()
  if (!await wait(() => document.querySelector('[data-testid="right-tool-menu-popover"]'))) throw new Error('工作区工具菜单未打开')
  const item = [...document.querySelectorAll('[data-testid="right-tool-menu-popover"] [role="menuitem"]')].find(el => el.textContent.trim() === title)
  if (!item) throw new Error(`工作区缺少工具 ${title}`)
  item.click()
  if (!await wait(visible)) throw new Error(`工具磁贴未打开 ${id}`)
  return visible()
}
void 0
