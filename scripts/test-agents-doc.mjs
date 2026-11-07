import { existsSync, readFileSync } from 'node:fs'

const MAX_LINES = 60
const TRACKED_ROOTS = /^(src|scripts|resources|debug|integrations|mobile|assets|build)\//
const GENERATED = /^resources\/pi-runtime\//

export function agentsDocProblems(text, { pathExists, scripts }) {
  const problems = []
  const lines = text.split('\n')
  if (lines.length > MAX_LINES) problems.push(`超过 ${MAX_LINES} 行：${lines.length}`)
  if (/[A-Za-z]:[\\/]/.test(text)) problems.push('含本机盘符路径，本机约定放 .local-docs/README.md')
  for (const [, code] of text.matchAll(/`([^`\n]+)`/g)) {
    if (TRACKED_ROOTS.test(code) && !GENERATED.test(code) && !/[<*]/.test(code) && !pathExists(code)) problems.push(`路径不存在：${code}`)
    const script = /^npm run ([\w:.-]+)/.exec(code)?.[1]
    if (script && !scripts.has(script)) problems.push(`npm 脚本不存在：${script}`)
  }
  return problems
}

export function runAgentsDocTests(ok) {
  const scripts = new Set(Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts))
  const real = { pathExists: existsSync, scripts }
  const problems = agentsDocProblems(readFileSync('AGENTS.md', 'utf8'), real)
  ok(problems.length === 0, 'AGENTS.md 提到的路径和 npm 脚本都存在、没有本机路径、长度在上限内', problems.join('；'))

  const fake = { pathExists: () => false, scripts: new Set(['build']) }
  ok(agentsDocProblems('`src/gone.ts`', fake).some((item) => item.includes('src/gone.ts')), '能发现不存在的路径')
  ok(agentsDocProblems('`npm run gone`', fake).some((item) => item.includes('gone')), '能发现不存在的 npm 脚本')
  ok(agentsDocProblems('`npm run build`', fake).length === 0, '存在的 npm 脚本不报')
  ok(agentsDocProblems('`release/<版本>/` `resources/pi-runtime/` `.local-docs/STATUS.md`', fake).length === 0, '占位路径、生成目录和被忽略的本地资料不报')
  ok(agentsDocProblems('E:/Inkstone/refs', fake).some((item) => item.includes('盘符')), '能发现本机盘符路径')
  ok(agentsDocProblems(Array(MAX_LINES + 1).fill('x').join('\n'), fake).some((item) => item.includes('超过')), '能发现超长')
}
