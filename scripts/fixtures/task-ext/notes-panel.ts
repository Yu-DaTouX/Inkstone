/**
 * 测试 fixture：**与任务无关**的用户扩展（实施-02 S5）。
 *
 * 为什么要单独放一个「无关」扩展：`taskext` 只放旧任务扩展时，
 * 「无关扩展会不会被任务迁移影响」这件事根本没被验过 —— 而真实用户目录里
 * 通常还有别的扩展。它能验三件事：
 *
 *   1. 来源诊断数的是**全部**用户扩展（不是只挑跟任务有关的）；
 *   2. 无关扩展注册的命令照常出现在命令列表里（砚不因为迁移任务就吞掉谁）；
 *   3. 任务清单来源判定不受它影响（第 3 节那 4 条仍只来自 fixture 会话）。
 *
 * ⚠️ 它**不**注册任务工具、不写任何任务标识 —— 一旦它碰了 `left-panel-tasks`，
 * 这个 fixture 就失去意义了（那样验的又是「旧任务扩展」，不是「无关扩展」）。
 */

export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    try {
      ctx.ui.notify('笔记面板已启用（与任务无关）', 'info')
    } catch {
      /* RPC 模式下 ui 一定存在；这里只是不让 fixture 自己炸掉场景 */
    }
  })

  pi.registerCommand('notes', {
    description: '笔记面板（TUI 命令，与任务无关）',
    handler: async () => {}
  })
}
