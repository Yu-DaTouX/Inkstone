import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { INTERACTION_FILE_LIMIT, INTERACTION_VALUE_LIMIT, validInteractionKey, type InteractionValues } from '../shared/interaction-state'

export class InteractionStore {
  constructor(private readonly root = join(YAN_DIR, 'interaction-state')) {}

  private path(session: string): string {
    if (!validInteractionKey(session)) throw new Error('Invalid session identity')
    return join(this.root, createHash('sha256').update(session).digest('hex') + '.json')
  }

  get(session: string): InteractionValues {
    const file = this.path(session)
    if (!existsSync(file)) return {}
    const recover = (): InteractionValues => {
      const backup = `${file}.corrupt-${randomUUID()}`
      renameSync(file, backup)
      console.warn('[interaction-state] 已隔离损坏的交互状态', backup)
      return {}
    }
    if (statSync(file).size > INTERACTION_FILE_LIMIT) return recover()
    let data
    try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
      if (error instanceof SyntaxError) return recover()
      throw error
    }
    if (data?.version !== 1 || data.session !== session || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) return recover()
    const values: InteractionValues = Object.create(null)
    for (const [key, value] of Object.entries(data.values)) {
      if (!validInteractionKey(key) || typeof value !== 'string' || Buffer.byteLength(value) > INTERACTION_VALUE_LIMIT) return recover()
      values[key] = value
    }
    return values
  }

  set(session: string, key: string, value: string | null): InteractionValues {
    if (!validInteractionKey(key) || (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > INTERACTION_VALUE_LIMIT))) throw new Error('Invalid interaction value')
    const values = this.get(session)
    if (value === null) delete values[key]
    else values[key] = value
    const text = JSON.stringify({ version: 1, session, values })
    if (Buffer.byteLength(text) > INTERACTION_FILE_LIMIT) throw new Error('Interaction state is full')
    mkdirSync(this.root, { recursive: true })
    const file = this.path(session)
    const temp = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, text, { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
    return values
  }
}
