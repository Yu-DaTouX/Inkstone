export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    try {
      ctx.ui.notify('笔记面板已启用（与任务无关）', 'info')
    } catch {
    }
  })

  pi.registerCommand('notes', {
    description: '笔记面板（TUI 命令，与任务无关）',
    handler: async () => {}
  })
}
