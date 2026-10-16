import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const probePath = join(here, 'probe', 'v3-shell.js')
const source = readFileSync(probePath, 'utf8')

const failures = []
const check = (ok, label) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(label)
}

const syntax = spawnSync(process.execPath, ['--check', probePath], { encoding: 'utf8' })
check(syntax.status === 0, `node --check 通过${syntax.status === 0 ? '' : `：${syntax.stderr.trim()}`}`)

let compiled = true
try {
  new vm.Script(source, { filename: probePath })
} catch (error) {
  compiled = false
  console.log(`    编译错误：${error.message}`)
}
check(compiled, 'vm.Script 编译通过')

const blockStart = source.indexOf('const asciiToggle = query(')
const blockEnd = source.indexOf('恢复缺省后空态重新挂载 ASCII 背景')
const block = blockStart >= 0 && blockEnd > blockStart ? source.slice(blockStart, blockEnd) : ''
check(block.length > 0, '定位到 ASCII 开关块')
check(!source.includes('asciiToggle?.click()'), '全文件不再直接点击 asciiToggle 可见 label')
check(/input\[role="switch"\]/.test(block), 'ASCII 块经内部 input[role="switch"] 定位开关')
const toggleClicks = block.match(/asciiSwitch\(\)\?\.click\(\)/g) ?? []
check(toggleClicks.length === 2, `ASCII 块恰好两次内部 input 切换（实际 ${toggleClicks.length}）`)
const restoreIdx = block.indexOf('恢复前确认开关实际已关闭')
const firstClickIdx = block.indexOf('asciiSwitch()?.click()')
const secondClickIdx = block.indexOf('asciiSwitch()?.click()', firstClickIdx + 1)
check(
  restoreIdx >= 0 && firstClickIdx >= 0 && secondClickIdx > restoreIdx,
  '关闭前置断言位于第二次（恢复）切换之前'
)
check(
  /asciiBackground === false/.test(block.slice(0, restoreIdx >= 0 ? restoreIdx : 0)),
  '关闭断言要求主进程回显 false'
)
check(
  /asciiBackground === undefined/.test(block.slice(secondClickIdx >= 0 ? secondClickIdx : block.length)),
  '恢复后仍断言回落缺省（不写 true）'
)

console.log(failures.length === 0 ? '\nPASS' : `\nFAIL（${failures.length}）`)
process.exit(failures.length === 0 ? 0 : 1)
