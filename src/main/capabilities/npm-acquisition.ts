/**
 * 把 prepare 固定的 npm 包落到 acquisition staging（实施-04 S6b-2）。
 *
 * 这里只下载、校验并复制普通文件；不运行 npm lifecycle、pi install 或包代码。
 * pi 包后续必须等目标项目的所有 runner 空闲后才可安装与激活。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AcquisitionService, stagingDirOf, type StagedManifest } from './acquisition-service'
import { fetchNpmArtifact, type FetchLike, type NpmArtifact } from './npm-artifact'

export class NpmAcquisitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NpmAcquisitionError'
  }
}

export type StageNpmAcquisitionInput = {
  root: string
  operationId: string
  candidateId: string
  digest: string
  projectId: string
  name: string
  version: string
  integrity: string
  expectedSha256?: string
  fetchImpl?: FetchLike
}

export type StagedNpmAcquisition = {
  artifact: NpmArtifact
  manifest: StagedManifest
  packageSourceDir: string
}

/** 拉取 exact npm tarball，并确认事务、候选与文件指纹仍与 prepare 一致。 */
export async function stageNpmAcquisition(input: StageNpmAcquisitionInput): Promise<StagedNpmAcquisition> {
  if (!input.integrity?.startsWith('sha512-')) {
    throw new NpmAcquisitionError('prepare-integrity-missing', 'npm 候选缺少 prepare 阶段固定的 SHA-512，拒绝下载')
  }
  const service = new AcquisitionService({ root: input.root })
  const transaction = await service.get(input.operationId)
  if (!transaction) throw new NpmAcquisitionError('unknown-operation', '下载前没有对应的接入事务')
  if (
    transaction.state !== 'prepared' ||
    transaction.candidateId !== input.candidateId ||
    transaction.digest !== input.digest ||
    transaction.projectId !== input.projectId
  ) {
    throw new NpmAcquisitionError('transaction-mismatch', '接入事务状态或固定候选身份已变化，拒绝继续下载')
  }

  const artifact = await fetchNpmArtifact({
    root: input.root,
    operationId: input.operationId,
    name: input.name,
    version: input.version,
    expectedIntegrity: input.integrity,
    ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  })

  const stagedFiles = await Promise.all(artifact.files.map(async (file) => {
    const content = await readFile(join(artifact.packageDir, ...file.path.split('/')))
    if (
      content.byteLength !== file.bytes ||
      createHash('sha256').update(content).digest('hex') !== file.sha256
    ) {
      throw new NpmAcquisitionError('artifact-changed', `npm 解包文件在 staging 前发生变化：${file.path}`)
    }
    return { path: `package/${file.path}`, content }
  }))

  const manifest = await service.stage({ operationId: input.operationId, files: stagedFiles })
  const checked = await service.verifyStaged(input.operationId)
  if (!checked.ok) {
    throw new NpmAcquisitionError('staging-verification-failed', checked.problems.join('；'))
  }

  return {
    artifact,
    manifest,
    packageSourceDir: join(stagingDirOf(input.root, input.operationId), 'payload', 'package')
  }
}
