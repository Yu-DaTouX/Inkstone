/** 目录名（路径最后一段）—— 侧栏放不下完整路径 */
export function shortProject(p: string): string {
  const parts = p.split(/[\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
}
