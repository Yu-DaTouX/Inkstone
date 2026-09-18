/**
 * 测试 fixture：**复刻用户本机 `left-info-panel.ts` 的关键行为**。
 *
 * ⚠️ 这不是用户那份扩展的拷贝，也不是要把它当成产品代码 —— 它只保留
 * 「会在任务工具迁移期里互相影响的那几件事」，让 `taskext` live 场景能
 * 在隔离 piDir 里复现「旧扩展与砚同时存在」：
 *
 *   1. 注册模型工具 `panel_todos`（**同名**：迁移期最容易撞的就是它）；
 *   2. 用 `pi.appendEntry('left-panel-tasks', {todos})` 写**旧标识**；
 *   3. 注册 `/panel` 命令（桌面端把它列为 compatibility，不能执行）；
 *   4. `session_start` 里从会话条目恢复清单 + 发一条 info 通知
 *      （真实扩展只在首次 announce；这里每次都发，好让探针稳定地看到它）。
 *
 * 为什么不直接复制用户那份：fixture 必须**自包含**（换一台机器、CI 上都要能跑），
 * 而且用户文件是 34KB 的 TUI 面板实现，与任务迁移无关的部分会把信号淹掉。
 */

const TASKS_ENTRY = 'left-panel-tasks'

export default function (pi) {
  /** 模块级全局 —— 真实扩展就是这样（迁移期「串会话」风险的来源，契约要能兜住）。 */
  let todos = []

  const persist = () => {
    try {
      pi.appendEntry(TASKS_ENTRY, { todos })
    } catch {
      /* 与真实扩展一致：非持久化会话下 appendEntry 会抛，不因此中断 */
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
      /* RPC 模式下 ui 一定存在；这里只是不让 fixture 自己炸掉场景 */
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
