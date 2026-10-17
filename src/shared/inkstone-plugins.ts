import { OPENCODE_PROXY_BASE_URL } from './opencode-proxy'

export const INKSTONE_PLUGINS = [
  { id: 'hermes-inkstone', name: 'Hermes × Inkstone', version: '0.2.0', action: 'export', descriptionKey: 'market.hermesDesc',
    targetKey: 'market.hermesTarget', hintKey: 'market.installHint', url: 'https://github.com/Yu-DaTouX/Inkstone/tree/main/integrations/hermes-inkstone' },
  { id: 'opencode-proxy', name: 'OpenCode 反代', version: '按需下载', action: 'proxy', descriptionKey: 'market.opencodeDesc',
    targetKey: 'market.opencodeTarget', hintKey: 'market.opencodeHint', url: OPENCODE_PROXY_BASE_URL },
  { id: 'codegraph', name: 'CodeGraph', version: 'MCP', action: 'mcp', descriptionKey: 'market.codegraphDesc',
    targetKey: 'market.codegraphTarget', hintKey: 'market.codegraphHint', url: 'https://github.com/colbymchenry/codegraph' }
] as const
