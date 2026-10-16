/**
 * MCP Apps 方法名的**唯一纯常量源**（主进程宿主 / 渲染端 / 单测共用）。
 *
 * 渲染端不能 import `src/main`，此前它在 `mcp-app-frame-model.ts` 里放了一份
 * `MCP_APP_METHODS` 离线镜像，容易与 `src/main/mcp/app-spec.ts` 漂移。这里把
 * 常量提成共享纯模块：`app-spec.ts` re-export，渲染端直接 import，前后端只剩
 * 一份定义。
 *
 * ⚠️ 规范字段名仍**待按稳定版规范核对**：本机 `@modelcontextprotocol/sdk` 不
 * 含 MCP Apps 扩展，开发期禁止联网，方法名来自设计稿与公开草案。规范定稿后只
 * 改这一个模块（形状判定仍留在 `app-spec.ts`）。
 *
 * 只放常量，不做 IO，不 import 任何运行时模块。
 */

/** `ui/*` 与 App 域内的方法名。 */
export const MCP_APP_METHODS = {
  initialize: 'ui/initialize',
  initialized: 'ui/notifications/initialized',
  sizeChanged: 'ui/notifications/size-changed',
  hostContextChanged: 'ui/notifications/host-context-changed',
  toolResult: 'ui/notifications/tool-result',
  requestDisplayMode: 'ui/request-display-mode',
  updateModelContext: 'ui/update-model-context',
  message: 'ui/message',
  openLink: 'ui/open-link',
  resourceTeardown: 'ui/resource-teardown',
  /** App 视图发起的工具调用（走宿主桥的 MCP 命令族）。 */
  toolsCall: 'tools/call',
  /** App 视图发起的资源读取。 */
  resourcesRead: 'resources/read'
} as const

export type McpAppMethodName = (typeof MCP_APP_METHODS)[keyof typeof MCP_APP_METHODS]
