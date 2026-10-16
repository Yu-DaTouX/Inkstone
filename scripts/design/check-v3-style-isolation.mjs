#!/usr/bin/env node
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = resolve(root, 'src/renderer/src')
const legacyStyles = resolve(renderer, 'styles') + sep
const legacyControls = resolve(renderer, 'components/ui') + sep
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.css']
const normalize = (path) => relative(root, path).split(sep).join('/')

function resolveLocal(from, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, ...extensions.map((extension) => base + extension), ...extensions.map((extension) => resolve(base, 'index' + extension))]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

export function checkV3StyleIsolation(entry = resolve(renderer, 'app/ShellV3.tsx')) {
  const seen = new Set()
  const violations = []
  const unresolved = []
  const visit = (file, chain) => {
    if (seen.has(file)) return
    seen.add(file)
    if (file.startsWith(legacyStyles) || file.startsWith(legacyControls)) {
      violations.push({ file: normalize(file), chain: chain.map(normalize) })
      return
    }
    if (extname(file) === '.json') return
    const follow = (specifier) => {
      if (specifier.startsWith('@fontsource/')) {
        violations.push({ file: specifier, chain: chain.map(normalize) })
        return
      }
      const target = resolveLocal(file, specifier)
      if (target) visit(target, [...chain, target])
      else if (specifier.startsWith('.')) unresolved.push({ from: normalize(file), specifier })
    }
    const followGlob = (argument) => {
      const nodes = argument && ts.isArrayLiteralExpression(argument) ? [...argument.elements] : [argument]
      if (nodes.some((item) => !item || !ts.isStringLiteralLike(item))) {
        unresolved.push({ from: normalize(file), specifier: '[non-literal import.meta.glob]' })
        return
      }
      const patterns = nodes.map((item) => item.text)
      if (patterns.some((pattern) => !(pattern.startsWith('!') ? pattern.slice(1) : pattern).startsWith('.'))) {
        unresolved.push({ from: normalize(file), specifier: '[non-relative import.meta.glob]' })
        return
      }
      const matches = (pattern) => [...globSync(pattern, { cwd: dirname(file) })].map((path) => resolve(dirname(file), path))
      const excluded = new Set(patterns.filter((pattern) => pattern.startsWith('!')).flatMap((pattern) => matches(pattern.slice(1))))
      for (const target of patterns.filter((pattern) => !pattern.startsWith('!')).flatMap(matches)) {
        if (!excluded.has(target) && statSync(target).isFile()) visit(target, [...chain, target])
      }
    }
    const content = readFileSync(file, 'utf8')
    if (extname(file) === '.css') {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content)
      let token
      while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
        if (token !== ts.SyntaxKind.AtToken || scanner.scan() !== ts.SyntaxKind.ImportKeyword) continue
        token = scanner.scan()
        if (scanner.getTokenText() === 'url') {
          if (scanner.scan() === ts.SyntaxKind.OpenParenToken) token = scanner.scan()
        }
        if (token === ts.SyntaxKind.StringLiteral) follow(scanner.getTokenValue())
        else unresolved.push({ from: normalize(file), specifier: '[non-string CSS @import]' })
      }
      return
    }
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
    const walk = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const clause = node.importClause
        const bindings = clause?.namedBindings
        const typesOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every((binding) => binding.isTypeOnly))
        if (!typesOnly) follow(node.moduleSpecifier.text)
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const typesOnly = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((binding) => binding.isTypeOnly)
        if (!typesOnly) follow(node.moduleSpecifier.text)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        follow(node.arguments[0].text)
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'glob' && ts.isMetaProperty(node.expression.expression)
        && node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
        followGlob(node.arguments[0])
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
  }
  visit(entry, [entry])
  return { visited: seen.size, violations, unresolved }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkV3StyleIsolation()
  for (const violation of result.violations) {
    console.error(`禁止的 v3 值依赖：${violation.file}\n  ${violation.chain.join(' → ')}`)
  }
  for (const missing of result.unresolved) {
    console.warn(`未解析的本地依赖：${missing.from} → ${missing.specifier}`)
  }
  console.log(`v3 样式依赖检查：访问 ${result.visited} 个仓库文件，违规 ${result.violations.length}，未解析 ${result.unresolved.length}`)
  process.exitCode = result.violations.length || result.unresolved.length ? 1 : 0
}
