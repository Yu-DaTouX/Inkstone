export type JsonSchema = Record<string, unknown>

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const VALIDATING = new Set(['type', 'required', 'properties', 'items', 'enum', 'additionalProperties'])
const ANNOTATIONS = new Set(['description', 'title', '$schema', '$comment', 'examples', 'default'])
const MAX_ERRORS = 8

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function typesOf(schema: JsonSchema): string[] | null {
  const raw = schema.type
  if (raw === undefined) return null
  return Array.isArray(raw) ? raw.map(String) : [String(raw)]
}

export function schemaProblem(schema: unknown, path = 'schema'): string | null {
  if (!isObject(schema)) return `${path} 必须是对象`
  for (const key of Object.keys(schema)) {
    if (!VALIDATING.has(key) && !ANNOTATIONS.has(key)) {
      return `${path}.${key} 不支持：schema 只支持 type / required / properties / items / enum / additionalProperties（description、title 这类说明可以写）`
    }
  }
  const types = typesOf(schema)
  if (types) {
    if (!types.length) return `${path}.type 不能是空数组`
    const unknown = types.find((type) => !TYPES.has(type))
    if (unknown) return `${path}.type 不认识「${unknown}」，只能是 ${[...TYPES].join(' / ')}`
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return `${path}.enum 必须是非空数组`
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string')) return `${path}.required 必须是字符串数组`
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) return `${path}.properties 必须是对象`
    for (const [key, child] of Object.entries(schema.properties)) {
      const problem = schemaProblem(child, `${path}.properties.${key}`)
      if (problem) return problem
    }
  }
  if (schema.items !== undefined) {
    const problem = schemaProblem(schema.items, `${path}.items`)
    if (problem) return problem
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    const problem = schemaProblem(schema.additionalProperties, `${path}.additionalProperties`)
    if (problem) return problem
  }
  if (schema.additionalProperties === false && Array.isArray(schema.required)) {
    const properties = isObject(schema.properties) ? schema.properties : {}
    const missing = (schema.required as string[]).find((key) => !Object.hasOwn(properties, key))
    if (missing) return `${path} 自相矛盾：required 里的「${missing}」被 additionalProperties: false 排除了（properties 里没有它）`
  }
  if (types && !types.includes('object') && (schema.properties !== undefined || schema.required !== undefined)) {
    return `${path} 自相矛盾：type 不含 object，却写了 properties / required`
  }
  return null
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, i) => sameJson(item, (b as unknown[])[i]))
  const left = Object.keys(a as object)
  const right = Object.keys(b as object)
  return left.length === right.length && left.every((key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  return typeof value
}

function walk(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return
  const types = typesOf(schema)
  if (types && !types.some((type) => typeMatches(value, type))) {
    errors.push(`${path} 应为 ${types.join(' 或 ')}，实际是 ${describe(value)}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) {
    errors.push(`${path} 只能取 ${schema.enum.map((option) => JSON.stringify(option)).join(' / ')}`)
    return
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!Object.hasOwn(value, key)) errors.push(`${path} 缺少必填字段「${key}」`)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`
      if (Object.hasOwn(properties, key)) walk(child, properties[key] as JsonSchema, childPath, errors)
      else if (schema.additionalProperties === false) errors.push(`${path} 不允许多出的字段「${key}」`)
      else if (isObject(schema.additionalProperties)) walk(child, schema.additionalProperties, childPath, errors)
      if (errors.length >= MAX_ERRORS) return
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) {
    for (let i = 0; i < value.length && errors.length < MAX_ERRORS; i += 1) walk(value[i], schema.items, `${path}[${i}]`, errors)
  }
}

export function validateJson(value: unknown, schema: JsonSchema): string[] {
  const errors: string[] = []
  walk(value, schema, '$', errors)
  return errors
}

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g

export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const blocks = [...text.matchAll(FENCE)].map((match) => ({ lang: match[1].toLowerCase(), body: match[2] }))
  const candidates = blocks.length ? [...blocks].reverse().filter((block) => !block.lang || block.lang === 'json').map((block) => block.body) : [text]
  if (!candidates.length) return { ok: false, error: '最后的回复里没有 ```json 代码块' }
  try {
    return { ok: true, value: JSON.parse(candidates[0].trim()) }
  } catch (error) {
    return { ok: false, error: `JSON 代码块解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export function schemaInstruction(schema: JsonSchema): string {
  return [
    '',
    '',
    'Output format: when you finish, your last message must contain only one ```json code block whose content is JSON matching this JSON Schema, with nothing outside the block:',
    '```json',
    JSON.stringify(schema),
    '```'
  ].join('\n')
}

export function schemaCorrection(errors: string[], schema: JsonSchema): string {
  return [
    `【工作流】你的最终回复没有通过 JSON 结构校验：${errors.join('；').slice(0, 1500)}。`,
    'Reply again with only one ```json code block containing JSON that matches this JSON Schema, with nothing outside the block:',
    '```json',
    JSON.stringify(schema),
    '```'
  ].join('\n')
}
