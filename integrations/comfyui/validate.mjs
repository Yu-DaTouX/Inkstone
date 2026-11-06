const MAX_OPTIONS = 40
const NUMERIC = new Set(['INT', 'FLOAT'])

export function isLink(value) {
  return Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number') && Number.isInteger(value[1])
}

export function comboOptions(spec) {
  if (Array.isArray(spec?.[0])) return spec[0]
  if (spec?.[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options
  return null
}

export function inputType(spec) {
  return comboOptions(spec) ? 'COMBO' : typeof spec?.[0] === 'string' ? spec[0] : '*'
}

function typesMatch(output, input) {
  if (output === '*' || input === '*') return true
  const wanted = String(input).split(',')
  return String(output).split(',').some(type => wanted.includes(type))
}

function previewOptions(options, value) {
  const needle = String(value ?? '').toLowerCase().replace(/\.[a-z0-9]+$/, '')
  const close = needle ? options.filter(option => String(option).toLowerCase().includes(needle) || needle.includes(String(option).toLowerCase().replace(/\.[a-z0-9]+$/, ''))) : []
  const shown = (close.length ? close : options).slice(0, MAX_OPTIONS)
  return `可选值${close.length ? '（最接近的）' : ''}：${JSON.stringify(shown)}${options.length > shown.length ? `，共 ${options.length} 项，用 comfyui_nodes 的 type 查看全部` : ''}`
}

function checkValue(spec, value) {
  const type = inputType(spec)
  const options = comboOptions(spec)
  if (options) return options.includes(value) ? null : `值 ${JSON.stringify(value)} 不在可选项里。${previewOptions(options, value)}`
  if (NUMERIC.has(type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `需要${type === 'INT' ? '整数' : '数字'}，收到 ${JSON.stringify(value)}`
    if (type === 'INT' && !Number.isInteger(value)) return `需要整数，收到 ${value}`
    const { min, max } = spec[1] ?? {}
    if (typeof min === 'number' && value < min) return `值 ${value} 小于最小值 ${min}`
    if (typeof max === 'number' && value > max) return `值 ${value} 大于最大值 ${max}`
    return null
  }
  if (type === 'STRING') return typeof value === 'string' ? null : `需要字符串，收到 ${JSON.stringify(value)}`
  if (type === 'BOOLEAN') return typeof value === 'boolean' ? null : `需要 true 或 false，收到 ${JSON.stringify(value)}`
  return `这个输入的类型是 ${type}，必须连线到输出该类型的节点（写成 ["节点编号", 输出序号]），不能填字面值`
}

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

export function suggestTypes(name, allTypes, limit = 5) {
  const needle = String(name).toLowerCase()
  const scored = allTypes.map(type => {
    const lower = type.toLowerCase()
    const near = 1 - distance(needle, lower) / Math.max(needle.length, lower.length)
    const score = lower.includes(needle) || needle.includes(lower) ? 2 : near >= 0.7 ? near : 0
    return { type, score }
  }).filter(item => item.score > 0).sort((x, y) => y.score - x.score)
  return scored.slice(0, limit).map(item => item.type)
}

export function validatePrompt(prompt, info, allTypes = []) {
  const problems = []
  const warnings = []
  const add = (node, input, message) => problems.push({ node, class_type: prompt[node]?.class_type, ...(input ? { input } : {}), message })
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt) || !Object.keys(prompt).length) return { ok: false, problems: [{ message: '工作流必须是 {节点编号: {class_type, inputs}} 对象，且不能为空' }], warnings, outputNodes: [], apiNodes: [] }
  const outputNodes = []
  const apiNodes = []
  for (const [id, node] of Object.entries(prompt)) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') { problems.push({ node: id, message: '节点缺少 class_type' }); continue }
    const entry = info[node.class_type]
    if (!entry) {
      const hint = suggestTypes(node.class_type, allTypes)
      add(id, undefined, `节点类型 ${node.class_type} 在这台 ComfyUI 上不存在（未安装或拼错）${hint.length ? `。相近：${hint.join('、')}` : '。用 comfyui_nodes 的 search 查找'}`)
      continue
    }
    if (entry.output_node) outputNodes.push(id)
    if (entry.api_node) apiNodes.push(id)
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {}
    const declared = { ...(entry.input?.optional ?? {}), ...(entry.input?.required ?? {}) }
    for (const [name, spec] of Object.entries(entry.input?.required ?? {})) {
      if (!(name in inputs)) add(id, name, `缺少必填输入 ${name}（类型 ${inputType(spec)}${comboOptions(spec) ? `；${previewOptions(comboOptions(spec))}` : ''}）`)
    }
    for (const [name, value] of Object.entries(inputs)) {
      const spec = declared[name]
      if (!spec) { warnings.push({ node: id, class_type: node.class_type, input: name, message: `输入 ${name} 不是这个节点声明的输入，会被忽略。可用：${Object.keys(declared).join('、')}` }); continue }
      if (isLink(value)) {
        const source = prompt[String(value[0])]
        if (!source) { add(id, name, `连线指向不存在的节点 ${value[0]}`); continue }
        const sourceInfo = info[source.class_type]
        if (!sourceInfo) continue
        const outputs = sourceInfo.output ?? []
        if (value[1] < 0 || value[1] >= outputs.length) { add(id, name, `节点 ${value[0]}（${source.class_type}）只有 ${outputs.length} 个输出，没有序号 ${value[1]}。输出：${JSON.stringify((sourceInfo.output_name ?? outputs).map((label, index) => `${index}:${label}`))}`); continue }
        const type = inputType(spec)
        if (type !== 'COMBO' && !typesMatch(outputs[value[1]], type)) add(id, name, `类型不匹配：需要 ${type}，但节点 ${value[0]}（${source.class_type}）输出 ${value[1]} 是 ${outputs[value[1]]}`)
        continue
      }
      const problem = checkValue(spec, value)
      if (problem) add(id, name, problem)
    }
  }
  const visiting = new Set()
  const done = new Set()
  const walk = id => {
    if (done.has(id)) return false
    if (visiting.has(id)) return true
    visiting.add(id)
    for (const value of Object.values(prompt[id]?.inputs ?? {})) {
      if (isLink(value) && prompt[String(value[0])] && walk(String(value[0]))) return true
    }
    visiting.delete(id)
    done.add(id)
    return false
  }
  for (const id of Object.keys(prompt)) if (walk(id)) { problems.push({ node: id, message: '连线形成了环，工作流必须是有向无环图' }); break }
  if (!outputNodes.length && !problems.some(problem => problem.message.startsWith('节点类型'))) problems.push({ message: '没有输出节点（如 SaveImage、SaveVideo、PreviewImage），ComfyUI 不会执行任何内容' })
  return { ok: problems.length === 0, problems, warnings, outputNodes, apiNodes }
}

export function formatNodeErrors(body) {
  const lines = []
  const top = body?.error
  if (top) lines.push(`${top.type ?? 'error'}：${top.message ?? ''}${top.details ? `（${top.details}）` : ''}`)
  for (const [id, item] of Object.entries(body?.node_errors ?? {})) {
    for (const error of item.errors ?? []) {
      const input = error.extra_info?.input_name
      lines.push(`节点 ${id}（${item.class_type ?? '?'}）${input ? ` 输入 ${input}` : ''}：${error.message ?? error.type}${error.details ? `，${error.details}` : ''}`)
    }
  }
  return lines.join('\n')
}
