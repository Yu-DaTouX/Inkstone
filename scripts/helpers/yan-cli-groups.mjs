import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const GROUP_HEAD = /^ {2}([a-z][a-z-]*): \{$/
const ACTIONS_HEAD = /^ {4}actions: \[(.*)$/
const QUOTED = /'([^']+)'/g

export function readYanCliGroups(root = process.cwd()) {
  const source = readFileSync(join(root, 'resources', 'yan-cli', 'yan.mjs'), 'utf8')
  const start = source.indexOf('const GROUP_SPECS = {')
  if (start < 0) throw new Error('yan.mjs 里找不到 GROUP_SPECS')
  const lines = source.slice(start).split(/\r?\n/)
  const groups = []
  let current = null
  let pending = null
  const collect = () => {
    for (const match of pending.matchAll(QUOTED)) current.actions.push(match[1])
    pending = null
  }
  for (const line of lines.slice(1)) {
    if (line === '}') break
    const head = GROUP_HEAD.exec(line)
    if (head) {
      current = { group: head[1], actions: [] }
      groups.push(current)
      continue
    }
    if (!current) continue
    const actionsHead = ACTIONS_HEAD.exec(line)
    if (actionsHead) {
      pending = actionsHead[1]
      if (pending.includes(']')) collect()
      continue
    }
    if (pending === null) continue
    pending += ` ${line}`
    if (line.includes(']')) collect()
  }
  if (groups.length === 0) throw new Error('GROUP_SPECS 解析不到任何命令组')
  return groups
}

export function commandsOf(group, action) {
  if (group === 'image' && action === 'local') return ['image.local.status', 'image.local.start', 'image.local.stop']
  if (group === 'artifact' && action === 'style') return []
  if (group === 'artifact' && action === 'export-video') return ['artifact.exportVideo']
  return [`${group}.${action}`]
}
