import ts from 'typescript'

export function sliceDeclaration(source, marker, file = 'source.ts') {
  const at = source.indexOf(marker)
  if (at < 0) throw new Error(`source marker not found: ${marker}`)
  const pos = at + (marker.length - marker.trimStart().length)
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  let found
  const visit = (node) => {
    if (found) return
    if (node.getStart(sf) === pos && (ts.isStatement(node) || ts.isClassElement(node))) { found = node; return }
    if (node.pos <= pos && node.end > pos) ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  if (!found) throw new Error(`no declaration starts at marker: ${marker}`)
  return found.getText(sf)
}
