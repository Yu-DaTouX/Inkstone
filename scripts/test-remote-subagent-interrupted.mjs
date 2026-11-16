import { runSuite } from './lib/test-suite.mjs'

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      loader: 'js',
      contents: [
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
        'export const shell = { openPath: async () => "" }',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (value) => Buffer.from(String(value)), decryptString: (value) => Buffer.from(value).toString() }',
        'export const BrowserWindow = class {}',
        'export const ipcMain = { handle: () => undefined }',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
        'export const session = { defaultSession: {}, fromPartition: () => ({}) }',
        'export default {}'
      ].join('\n')
    }))
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { remoteSubagentRun } = await compile('src/main/remote-host.ts', { plugins: [electronStub], external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'] })
  const base = { id: 'sub-1', task: '整理', status: 'cancelled', isolation: 'worktree', startedAt: 1, endedAt: 2, transcript: [], toolCalls: 0, review: 'pending' }
  const resumable = remoteSubagentRun({ ...base, endReason: 'interrupted', resumable: { ok: true } })
  ok(resumable.endReason === 'interrupted' && resumable.resumable === true, '退出时中断的子代理：手机端拿到中断原因和可续接标记', JSON.stringify(resumable))
  const blocked = remoteSubagentRun({ ...base, endReason: 'interrupted', resumable: { ok: false, reason: '工作树已不在' } })
  ok(blocked.resumable === false && !JSON.stringify(blocked).includes('工作树已不在'), '不能续接时如实标为 false，不带内部原因', JSON.stringify(blocked))
  const stopped = remoteSubagentRun({ ...base, endReason: 'stopped' })
  ok(stopped.endReason === 'stopped' && !('resumable' in stopped), '没有续接判定的记录不凭空加可续接标记', JSON.stringify(stopped))
})
