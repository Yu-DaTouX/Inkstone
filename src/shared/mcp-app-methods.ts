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
  toolsCall: 'tools/call',
  resourcesRead: 'resources/read'
} as const

export type McpAppMethodName = (typeof MCP_APP_METHODS)[keyof typeof MCP_APP_METHODS]
