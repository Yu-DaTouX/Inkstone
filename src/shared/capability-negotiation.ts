import type { ServiceCapability } from './agent-service'

/** Compatibility strings are callable capabilities; detail preserves unavailable states. */
export function negotiateCapabilities(implemented: string[], configured: string[], authorized: string[], unavailable: string[] = []): { capabilities: string[]; capabilityDetails: ServiceCapability[] } {
  const details = implemented.map(id => ({ id, implemented: true, configured: configured.includes(id), available: configured.includes(id) && !unavailable.includes(id), authorized: authorized.includes(id), ...(!authorized.includes(id) ? { reason: '当前身份未获授权' } : !configured.includes(id) ? { reason: '宿主尚未配置' } : unavailable.includes(id) ? { reason: '当前不可用' } : {}) }))
  return { capabilities: details.filter(c => c.available && c.authorized).map(c => c.id), capabilityDetails: details }
}
export function capabilityAllowed(info: { capabilities: string[]; capabilityDetails?: ServiceCapability[] } | null, id: string): boolean {
  if (!info) return false
  const detail = info.capabilityDetails?.find(c => c.id === id)
  return detail ? detail.implemented && detail.configured && detail.available && detail.authorized : info.capabilities.includes(id)
}
