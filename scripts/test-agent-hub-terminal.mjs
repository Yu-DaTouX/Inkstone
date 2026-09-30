import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import Headless from '@xterm/headless'

await mkdir('out/test', { recursive: true })
const file = resolve('out/test/agent-hub-terminal.mjs')
await build({ entryPoints: ['src/main/agent-hub/terminal-screen.ts'], outfile: file, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
const { TerminalScreen } = await import(pathToFileURL(file))
const screen = new TerminalScreen(40, 8)
screen.write('old output\r\n'.repeat(20000), 1)
screen.write('\x1b[2J\x1b[H\x1b[', 2)
screen.write('32mGREEN\x1b[0m\x1b[3;5HCURSOR', 3)
const snapshot = await screen.snapshot()
assert.equal(snapshot.seq, 3)
const recovered = new Headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true })
await new Promise((done) => recovered.write(snapshot.data, done))
assert.equal(recovered.buffer.active.getLine(recovered.buffer.active.baseY).translateToString(true), 'GREEN')
assert.equal(recovered.buffer.active.getLine(recovered.buffer.active.baseY + 2).translateToString(true), '    CURSOR')
assert.equal(recovered.buffer.active.getLine(recovered.buffer.active.baseY).getCell(0).getFgColor(), 2)
assert.equal(recovered.buffer.active.cursorX, 10)
assert.equal(recovered.buffer.active.cursorY, 2)
screen.write('\x1b[?1049h\x1b[HAPP', 4)
const alternate = await screen.snapshot()
const altRecovered = new Headless.Terminal({ cols: 40, rows: 8, allowProposedApi: true })
await new Promise((done) => altRecovered.write(alternate.data, done))
assert.equal(altRecovered.buffer.active.type, 'alternate')
assert.equal(altRecovered.buffer.active.getLine(0).translateToString(true), 'APP')
screen.resize(20, 6, 5)
screen.write('\x1b[?1049l', 6)
const resized = await screen.snapshot()
assert.equal(resized.seq, 6); assert.equal(resized.cols, 20); assert.equal(resized.rows, 6)
screen.dispose(); recovered.dispose(); altRecovered.dispose()
console.log('Agent Hub terminal screen checks passed: parser barrier, split escape, truncated-history recovery, color, cursor, alternate screen and ordered resize.')
