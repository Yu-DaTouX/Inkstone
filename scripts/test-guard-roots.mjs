import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/main/guard-roots.ts', import.meta.url))
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm' })
const { isBroadAllowRoot } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

if (process.platform === 'win32') {
  const home = 'C:\\Users\\me'
  const broad = (dir) => isBroadAllowRoot(dir, home)
  for (const dir of ['C:\\', 'C:\\Users', 'C:\\Users\\me', 'C:\\Users\\other', 'C:\\Windows\\System32', 'D:\\Program Files\\x', 'C:\\ProgramData', 'C:\\Users\\me\\.ssh', 'C:\\Users\\me\\.pi\\agent', 'C:\\Users\\me\\AppData', 'C:\\Users\\me\\AppData\\Local', 'C:\\Users\\me\\AppData\\Roaming']) {
    assert.equal(broad(dir), true, `${dir} 过宽，不该被记住`)
  }
  for (const dir of ['C:\\Users\\me\\Desktop', 'C:\\Users\\me\\Documents\\proj', 'E:\\work\\out', 'E:\\pi-desktop\\.tmp\\x', 'C:\\Users\\me\\AppData\\Local\\Temp\\yan-x']) {
    assert.equal(broad(dir), false, `${dir} 是具体目录，可以记住`)
  }
}
console.log('guard-roots: ok')
