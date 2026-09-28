import { NativeModules } from 'react-native'
import type { RemoteImageInput } from '../../src/shared/remote-protocol'

export interface PhotoDraft extends RemoteImageInput { id: string; width: number; height: number }
export interface ReadMark { id: string; at: number }
const native = NativeModules.InkstoneMobileDevice as {
  info(): Promise<{ name: string; model: string }>
  pickImages(limit: number): Promise<PhotoDraft[] | null>
  readMarks(scope: string): Promise<string>
  writeMarks(scope: string, json: string): Promise<void>
}
export const deviceInfo = () => native.info()
export const pickImages = (limit: number) => native.pickImages(limit)
export async function readMarks(scope: string): Promise<Record<string, ReadMark>> {
  try { return JSON.parse(await native.readMarks(scope)) as Record<string, ReadMark> } catch { return {} }
}
export async function writeMarks(scope: string, marks: Record<string, ReadMark>): Promise<void> {
  await native.writeMarks(scope, JSON.stringify(Object.fromEntries(Object.entries(marks).sort((a, b) => b[1].at - a[1].at).slice(0, 500))))
}
