const TASKS_ENTRY = 'left-panel-tasks'

export default function (pi) {
  let todos = []

  const persist = () => {
    try {
      pi.appendEntry(TASKS_ENTRY, { todos })
    } catch {
    }
  }

  pi.on('session_start', (_event, ctx) => {
    todos = []
    for (const entry of ctx.sessionManager.getEntries()) {
      const e = entry
      if (e.type === 'custom' && e.customType === TASKS_ENTRY && Array.isArray(e.data?.todos)) {
        todos = e.data.todos.map((t) => ({ text: String(t.text ?? ''), done: Boolean(t.done) }))
      }
    }
    try {
      ctx.ui.notify('信息面板已启用（overlay 44 列）· /panel 隐藏 · /panel side left|right 换边', 'info')
    } catch {
    }
  })

  pi.registerCommand('panel', {
    description: '信息面板（TUI 命令，桌面端不适用）',
    handler: async () => {}
  })

  pi.registerTool({
    name: 'panel_todos',
    label: 'Panel Todos',
    description: '维护左侧信息面板里的任务进度列表。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        items: { type: 'array', items: { type: 'object' } },
        index: { type: 'number' }
      },
      required: ['action']
    },
    async execute() {
      persist()
      return {
        content: [{ type: 'text', text: `任务进度 ${todos.filter((t) => t.done).length}/${todos.length}` }]
      }
    }
  })
}
