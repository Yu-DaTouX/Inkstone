export interface FileResourceIdentity {
  projectId?: string | null
  workspaceRoot?: string | null
  canonicalPath: string
}

const SEP = '|'
const EMPTY = '-'

function encodePart(value: string | null | undefined): string {
  const v = (value ?? '').trim()
  return v ? encodeURIComponent(v) : EMPTY
}

export function fileResourceKey(identity: FileResourceIdentity): string {
  return [
    encodePart(identity.projectId),
    encodePart(identity.workspaceRoot),
    encodePart(identity.canonicalPath)
  ].join(SEP)
}
