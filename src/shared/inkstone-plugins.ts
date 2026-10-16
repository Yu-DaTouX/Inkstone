export const INKSTONE_PLUGINS = [
  { id: 'hermes-inkstone', name: 'Hermes × Inkstone', version: '0.2.0', action: 'export', descriptionKey: 'market.hermesDesc',
    targetKey: 'market.hermesTarget', hintKey: 'market.installHint', url: 'https://github.com/Yu-DaTouX/Inkstone/tree/main/integrations/hermes-inkstone' },
  { id: 'codegraph', name: 'CodeGraph', version: 'MCP', action: 'mcp', descriptionKey: 'market.codegraphDesc',
    targetKey: 'market.codegraphTarget', hintKey: 'market.codegraphHint', url: 'https://github.com/colbymchenry/codegraph' }
] as const
