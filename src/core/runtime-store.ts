import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServiceApproval, ServiceReceipt, ServiceTask, TaskApplyItem } from '../shared/agent-service'

export interface RuntimeDocument {
  version: 1
  tasks: ServiceTask[]
  approvals: ServiceApproval[]
  receipts: ServiceReceipt[]
  applyPlans: Record<string, TaskApplyItem[]>
}

/** Single-writer durable facts. Writes are serialized and replaced atomically. */
export class RuntimeStore {
  document: RuntimeDocument = { version: 1, tasks: [], approvals: [], receipts: [], applyPlans: {} }
  private tail: Promise<unknown> = Promise.resolve()
  failure: Error | null = null
  constructor(readonly root: string) {}
  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    try {
      const value = JSON.parse(await readFile(join(this.root, 'runtime.json'), 'utf8')) as RuntimeDocument
      if (value.version !== 1 || !Array.isArray(value.tasks) || !Array.isArray(value.approvals) || !Array.isArray(value.receipts) || !value.applyPlans) throw new Error('不支持的运行记录格式')
      this.document = value
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // Restart is reconciliation, never an implicit retry of side effects.
    for (const task of this.document.tasks) if (task.status === 'running') { task.status = 'uncertain'; task.error = '服务已重启，执行结果需核实' }
    for (const receipt of this.document.receipts) if (receipt.state === 'started') receipt.state = 'uncertain'
    await this.save()
  }
  save(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    const serialized = JSON.stringify(this.document, null, 2)
    const next = this.tail.then(async () => {
      const temporary = join(this.root, 'runtime.json.next')
      await writeFile(temporary, serialized, 'utf8')
      await rename(temporary, join(this.root, 'runtime.json'))
    })
    this.tail = next.catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)) })
    return next
  }
}
