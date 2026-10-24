export interface RenameInstanceResult {
  id: string
  jarRenamed: boolean
}

export interface CopyInstanceResult {
  id: string
  size: number
}

export interface InstanceTrashRecord {
  id: string
  versionId: string
  at: number
  size: number
}

export interface ResourcePackEntry {
  file: string
  name: string
  size: number
  enabled: boolean
  format: number | null
  description: string | null
  icon: string | null
}

export interface ShaderPackEntry {
  file: string
  name: string
  size: number
}

export interface SaveEntry {
  folder: string
  name: string
  size: number
  lastPlayed: number | null
  icon: string | null
  gameVersion: string | null
}

export interface ScreenshotEntry {
  file: string
  at: number
  size: number
  width: number | null
  height: number | null
  dataUrl: string
}

export interface ServerEntry {
  name: string
  ip: string
  icon: string | null
}

export interface VersionResources {
  resourcepacks: ResourcePackEntry[]
  shaderpacks: ShaderPackEntry[]
  saves: SaveEntry[]
  servers: ServerEntry[]
}

export type InstanceIconKind = 'mod' | 'save' | 'server'

export interface InstanceIconOption {
  kind: InstanceIconKind
  ref: string
  label: string
  preview: string
}

export type ResourceKind = 'resourcepacks' | 'shaderpacks' | 'saves'
