export type PackageExecutionGrant = {
  candidateId: string
  digest: string
  projectId: string
  allowLifecycleScripts: boolean
  grantedAt: string
  via: 'settings-ui'
}

export function validPackageExecutionGrant(input: PackageExecutionGrant): boolean {
  return (
    typeof input.candidateId === 'string' && input.candidateId.length > 0 && input.candidateId.length <= 512 &&
    /^[a-f0-9]{16}$/i.test(input.digest) &&
    typeof input.projectId === 'string' && input.projectId.length > 0 && input.projectId.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(input.projectId) &&
    typeof input.allowLifecycleScripts === 'boolean' &&
    Number.isFinite(Date.parse(input.grantedAt)) &&
    input.via === 'settings-ui'
  )
}

export function packageExecutionGrantCovers(
  grant: PackageExecutionGrant,
  input: { candidateId: string; digest: string; projectId: string }
): boolean {
  return (
    validPackageExecutionGrant(grant) &&
    grant.candidateId === input.candidateId &&
    grant.digest === input.digest &&
    grant.projectId === input.projectId
  )
}
