export const agentTestBuildOptions = {
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{
    name: 'unit-electron-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'unit-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'unit-electron' }, () => ({ contents: `
        export class BrowserWindow { constructor() { throw new Error('Native browser requires an Electron integration test') } }
        export const session = { fromPartition() { throw new Error('Native session requires an Electron integration test') } }
        export const app = {
          getLocale: () => 'zh-CN',
          getPath: (name) => {
            const root = process.env.YAN_TEST_APP_DIR || process.env.YAN_DATA_DIR || (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/inkstone-unit-app'
            return root + '/' + (name || 'documents')
          }
        }
      ` }))
    }
  }]
}
