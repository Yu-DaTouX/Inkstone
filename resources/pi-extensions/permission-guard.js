/** 兼容旧扩展入口。两档权限统一由 danger-guard 负责，不再重定向删除。 */
export { hasDelete } from './danger-guard.js'
export function trashVerdict(_toolName, _input, _cwd, _prefs) { return null }
export default function permissionGuardExtension(_pi) {}
