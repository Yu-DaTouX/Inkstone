/** Compare release versions without relying on npm's transitive dependencies. */
export function comparePiVersions(left, right) {
  const parse = (value) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value ?? '')
    if (!match) throw new Error(`无效的 pi 版本：${String(value)}`)
    if (match[4]?.split('.').some(id => !id || (/^\d+$/.test(id) && id.length > 1 && id.startsWith('0')))) {
      throw new Error(`无效的 pi 版本：${String(value)}`)
    }
    return { numbers: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') }
  }
  const a = parse(left), b = parse(right)
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1
  }
  if (!a.pre && !b.pre) return 0
  if (!a.pre || !b.pre) return a.pre ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1
    if (nx !== ny) return nx ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export function requirePiUpgrade(current, next, allowDowngrade = false) {
  comparePiVersions(next, next)
  if (current && comparePiVersions(next, current) < 0 && !allowDowngrade) {
    throw new Error(`拒绝将内置 pi ${current} 降级为 ${next}。请更新源 pi 或设置 YAN_PI_SRC；明确需要回退时使用 --allow-downgrade（--force 不允许降级）。`)
  }
}
