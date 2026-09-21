/** 按精确候选 / 指纹 / 项目持久化本地代码执行授权；调用入口只应来自宿主 UI。 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  packageExecutionGrantCovers,
  validPackageExecutionGrant,
  type PackageExecutionGrant
} from '../../shared/package-authorization'
import { acquisitionRoot } from './acquisition-service'

const MAX_GRANTS = 1000
const MAX_STORE_BYTES = 512 * 1024

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, path)
}

export class PackageAuthorizationService {
  private readonly file: string
  private readonly dir: string
  private tail: Promise<void> = Promise.resolve()

  constructor(root: string) {
    this.dir = acquisitionRoot(root)
    this.file = join(this.dir, 'package-authorizations.json')
  }

  async list(): Promise<PackageExecutionGrant[]> {
    try {
      const info = await stat(this.file)
      if (info.size > MAX_STORE_BYTES) throw new Error('本地包授权文件超过大小上限，拒绝读取 / 覆盖')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      throw new Error(`本地包授权文件损坏，拒绝按空授权覆盖：${error instanceof Error ? error.message : String(error)}`)
    }
    const items = parsed && typeof parsed === 'object' ? (parsed as { items?: unknown }).items : null
    if (!Array.isArray(items)) throw new Error('本地包授权文件结构无效，拒绝按空授权覆盖')
    return items
      .filter((item): item is PackageExecutionGrant => !!item && typeof item === 'object' && validPackageExecutionGrant(item as PackageExecutionGrant))
      .slice(-MAX_GRANTS)
  }

  async find(input: { candidateId: string; digest: string; projectId: string }): Promise<PackageExecutionGrant | null> {
    const grants = await this.list()
    return grants.find((grant) => packageExecutionGrantCovers(grant, input)) ?? null
  }

  /** 只供主进程的显式授权 UI 调用；CLI / 模型参数不得直接映射到这里。 */
  async grant(input: {
    candidateId: string
    digest: string
    projectId: string
    allowLifecycleScripts: boolean
    at?: string
  }): Promise<PackageExecutionGrant> {
    return this.serialize(async () => {
    const grant: PackageExecutionGrant = {
      candidateId: input.candidateId,
      digest: input.digest,
      projectId: input.projectId,
      allowLifecycleScripts: input.allowLifecycleScripts,
      grantedAt: input.at ?? new Date().toISOString(),
      via: 'settings-ui'
    }
    if (!validPackageExecutionGrant(grant)) throw new Error('本地包授权字段不合法')
    const items = await this.list()
    const next = items.filter((item) => !(item.candidateId === grant.candidateId && item.digest === grant.digest && item.projectId === grant.projectId))
    next.push(grant)
    await mkdir(this.dir, { recursive: true })
    await writeAtomic(this.file, JSON.stringify({ version: 1, items: next.slice(-MAX_GRANTS) }, null, 2))
    return grant
    })
  }

  async revoke(input: { candidateId: string; digest: string; projectId: string }): Promise<boolean> {
    return this.serialize(async () => {
    const items = await this.list()
    const next = items.filter((item) => !(item.candidateId === input.candidateId && item.digest === input.digest && item.projectId === input.projectId))
    if (next.length === items.length) return false
    await mkdir(this.dir, { recursive: true })
    await writeAtomic(this.file, JSON.stringify({ version: 1, items: next }, null, 2))
    return true
    })
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
