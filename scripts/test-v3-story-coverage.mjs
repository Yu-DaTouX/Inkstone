#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UI_DIR = join(ROOT, 'src/renderer/src/ui')
const INDEX_FILE = join(UI_DIR, 'index.ts')
const STORY_FILES = [
  join(UI_DIR, 'V3StateMatrix.stories.tsx'),
  join(UI_DIR, 'V3FormStates.stories.tsx'),
  join(UI_DIR, 'Slider.stories.tsx'),
  join(UI_DIR, 'Tree.stories.tsx'),
  join(UI_DIR, 'Table.stories.tsx'),
  join(UI_DIR, 'Splitter.stories.tsx')
]

const ALLOWED_STATES = new Set([
  'default',
  'hover',
  'press',
  'focus',
  'disabled',
  'loading',
  'selected',
  'invalid',
  'required',
  'readonly',
  'indeterminate',
  'open',
  'closable',
  'empty',
  'visible',
  'value-known',
  'value-unknown',
  'tone-neutral',
  'tone-accent',
  'tone-run',
  'tone-ask',
  'tone-stall',
  'tone-fail',
  'tone-info',
  'tone-success',
  'tone-warning',
  'tone-danger',
  'shape-text',
  'shape-rect',
  'shape-circle',
  'orientation-horizontal',
  'orientation-vertical',
  'theme-light',
  'theme-dark',
  'density-compact',
  'density-standard',
  'density-comfortable'
])

const REQUIRED = {
  Button: ['default', 'hover', 'press', 'focus', 'disabled', 'loading'],
  IconButton: ['default', 'hover', 'focus', 'disabled', 'loading'],
  SearchField: ['default', 'focus', 'disabled', 'invalid', 'empty'],
  TextArea: ['default', 'focus', 'disabled', 'invalid', 'readonly'],
  TextField: ['default', 'hover', 'focus', 'disabled', 'invalid', 'required', 'readonly'],
  Checkbox: ['default', 'selected', 'indeterminate', 'focus', 'disabled', 'invalid'],
  CheckboxGroup: ['default', 'invalid', 'disabled'],
  Switch: ['default', 'selected', 'focus', 'disabled'],
  Radio: ['default', 'selected', 'focus', 'disabled'],
  RadioGroup: ['default', 'invalid', 'disabled'],
  Select: ['default', 'open', 'focus', 'disabled', 'invalid', 'required'],
  ComboBox: ['default', 'open', 'focus', 'disabled', 'invalid'],
  ListBox: ['default', 'selected', 'focus', 'disabled'],
  ListBoxItem: ['default', 'selected', 'focus', 'disabled'],
  ListBoxSection: ['default'],
  Dialog: ['default', 'open', 'focus'],
  DialogTrigger: ['default', 'open'],
  Modal: ['default', 'open'],
  ModalOverlay: ['default', 'open'],
  Popover: ['default', 'open'],
  Menu: ['default', 'focus', 'disabled'],
  MenuItem: ['default', 'focus', 'disabled'],
  MenuSection: ['default'],
  MenuTrigger: ['default', 'open'],
  SubmenuTrigger: ['default', 'open'],
  Tab: ['default', 'selected', 'focus', 'disabled', 'closable'],
  TabList: ['default'],
  TabPanel: ['default'],
  TabPanels: ['default'],
  Tabs: ['default', 'focus', 'disabled'],
  Tooltip: ['default', 'open'],
  TooltipTrigger: ['default', 'open'],
  ToastRegion: ['default', 'tone-info', 'tone-success', 'tone-warning', 'tone-danger'],
  showToast: ['default'],
  toastQueue: ['default'],
  Badge: [
    'default',
    'tone-neutral',
    'tone-accent',
    'tone-run',
    'tone-ask',
    'tone-stall',
    'tone-fail'
  ],
  Kbd: ['default'],
  Meter: ['default', 'value-known'],
  ProgressBar: ['default', 'value-known', 'value-unknown'],
  Spinner: ['default', 'loading'],
  Skeleton: ['default', 'shape-text', 'shape-rect', 'shape-circle'],
  ShimmerText: ['default', 'loading'],
  CompletionSweep: ['default', 'tone-success'],
  Separator: ['default', 'orientation-horizontal', 'orientation-vertical'],
  Slider: ['default', 'disabled', 'invalid', 'orientation-vertical'],
  Tree: ['default', 'selected', 'disabled', 'empty'],
  TreeItem: ['default', 'selected', 'disabled'],
  TreeItemContent: ['default'],
  TreeChevron: ['default'],
  TreeItemLabel: ['default'],
  TreeSection: ['default'],
  TreeHeader: ['default'],
  TreeEmptyState: ['empty'],
  Table: ['default', 'selected', 'empty', 'loading'],
  TableHeader: ['default'],
  Column: ['default'],
  TableBody: ['default', 'empty', 'loading'],
  Row: ['default', 'selected', 'disabled'],
  Cell: ['default'],
  TableFooter: ['default'],
  TableEmptyState: ['empty'],
  TableLoadingState: ['loading'],
  Splitter: ['default', 'disabled', 'orientation-horizontal', 'orientation-vertical'],
  FieldError: ['default', 'visible'],
  Header: ['default'],
  Heading: ['default', 'theme-light', 'theme-dark', 'density-compact', 'density-standard', 'density-comfortable'],
  Input: ['default', 'focus', 'disabled', 'invalid'],
  Label: ['default'],
  Text: ['default']
}

const EXCLUSIONS = [
  { test: (name) => name === 'cx', reason: '工具函数，不是可视控件，没有状态矩阵' },
  {
    test: (name) => name === 'sortRows',
    reason: '表格排序纯函数，不是可视控件；由 table-model 的纯逻辑核对覆盖'
  }
]

const ALLOWED_IMPORTS = new Set([
  './index',
  'react',
  'react-aria-components',
  '@storybook/react-vite',
  './Tree.css'
])

const problems = []
const notes = []
const fail = (message) => problems.push(message)

function readSource(file) {
  return readFileSync(file, 'utf8')
}

function parse(file) {
  if (!existsSync(file)) {
    fail(`缺少文件：${file}`)
    return null
  }
  const text = readSource(file)
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const diagnostics = [...sourceFile.parseDiagnostics]
  const transpiled = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }
  })
  for (const diagnostic of transpiled.diagnostics ?? []) {
    if (diagnostic.category === ts.DiagnosticCategory.Error) diagnostics.push(diagnostic)
  }
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      fail(`${sourceFile.fileName} 解析失败：${message}`)
    }
  }
  return sourceFile
}

function collectRuntimeExports(sourceFile) {
  const names = new Set()
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    const clause = statement.exportClause
    if (!clause || !ts.isNamedExports(clause)) continue
    for (const element of clause.elements) {
      if (element.isTypeOnly) continue
      names.add(element.name.text)
    }
  }
  return names
}

function collectImportSpecifiers(sourceFile) {
  const specifiers = []
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (ts.isStringLiteral(specifier)) specifiers.push(specifier.text)
  }
  return specifiers
}

function collectIndexImports(sourceFile) {
  const names = new Set()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (!ts.isStringLiteral(specifier) || specifier.text !== './index') continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      names.add((element.propertyName ?? element.name).text)
    }
  }
  return names
}

function unwrapExpression(node) {
  let current = node
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function readStringList(node, where) {
  const value = unwrapExpression(node)
  if (!value) return null
  if (ts.isArrayLiteralExpression(value)) {
    const items = []
    for (const element of value.elements) {
      if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) {
        fail(`${where} 只能包含字符串字面量。`)
        return null
      }
      items.push(element.text)
    }
    return items
  }
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'STATES') {
    const items = []
    for (const argument of value.arguments) {
      if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) {
        fail(`${where} 的 STATES(...) 只能包含字符串字面量。`)
        return null
      }
      items.push(argument.text)
    }
    return items
  }
  fail(`${where} 既不是字符串数组也不是 STATES(...)。`)
  return null
}

function readObjectProperty(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return null
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const key = property.name
    const keyName = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null
    if (keyName === name) return property.initializer
  }
  return null
}

function readMatrix(matrixNode, where) {
  const components = readStringList(readObjectProperty(matrixNode, 'components'), `${where}.components`) ?? []
  const states = readStringList(readObjectProperty(matrixNode, 'states'), `${where}.states`) ?? []
  const declared = readStringList(readObjectProperty(matrixNode, 'declared'), `${where}.declared`) ?? []
  if (components.length === 0) fail(`${where} 没有声明任何 component。`)
  if (states.length === 0) fail(`${where} 没有声明任何 state。`)
  for (const state of states) {
    if (!ALLOWED_STATES.has(state)) fail(`${where} 声明了未知状态 '${state}'。`)
  }
  for (const state of declared) {
    if (!ALLOWED_STATES.has(state)) fail(`${where} 的 declared 含未知状态 '${state}'。`)
    if (!states.includes(state)) fail(`${where} 把 '${state}' 标为 declared，但它不在 states 里。`)
  }
  return { components, states, declared }
}

function collectMetaMatrix(sourceFile) {
  let defaultName = null
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expr = unwrapExpression(statement.expression)
      if (expr && ts.isIdentifier(expr)) defaultName = expr.text
    }
  }
  if (!defaultName) return null
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== defaultName) continue
      const initializer = unwrapExpression(declaration.initializer)
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) return null
      const stateMatrix = readObjectProperty(readObjectProperty(initializer, 'parameters'), 'stateMatrix')
      if (!stateMatrix) return null
      const where = `${sourceFile.fileName.replace(ROOT + '\\', '').replace(ROOT + '/', '')} 的 meta`
      return readMatrix(stateMatrix, where)
    }
  }
  return null
}

function collectStoryDeclarations(sourceFile, fileMatrix) {
  const stories = []
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const initializer = unwrapExpression(declaration.initializer)
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue
      const where = `${sourceFile.fileName.replace(ROOT + '\\', '').replace(ROOT + '/', '')}#${declaration.name.text}`
      const storyNameNode = readObjectProperty(initializer, 'name')
      const storyName = ts.isStringLiteral(storyNameNode) ? storyNameNode.text : declaration.name.text
      const ownMatrix = readObjectProperty(readObjectProperty(initializer, 'parameters'), 'stateMatrix')
      let matrix
      if (ownMatrix) {
        matrix = readMatrix(ownMatrix, where)
      } else if (fileMatrix) {
        matrix = fileMatrix
      } else {
        fail(`${where} 缺少 parameters.stateMatrix（故事自身或 meta 都必须声明覆盖的组件与状态）。`)
        continue
      }
      stories.push({ where, storyName, ...matrix })
    }
  }
  return stories
}

const indexSource = parse(INDEX_FILE)
if (!indexSource) {
  console.error('✗ 找不到 ui/index.ts，无法核对覆盖清单。')
  process.exit(1)
}
const runtimeExports = collectRuntimeExports(indexSource)

const coverage = new Map()
const declaredOnly = new Map()
for (const file of STORY_FILES) {
  const sourceFile = parse(file)
  if (!sourceFile) continue
  for (const specifier of collectImportSpecifiers(sourceFile)) {
    if (!ALLOWED_IMPORTS.has(specifier)) {
      fail(`${file} 导入了不允许的模块 '${specifier}'；状态矩阵故事不得依赖宿主或其它功能模块。`)
    }
  }
  const imported = collectIndexImports(sourceFile)
  const fileMatrix = collectMetaMatrix(sourceFile)
  for (const story of collectStoryDeclarations(sourceFile, fileMatrix)) {
    for (const component of story.components) {
      if (!imported.has(component)) {
        fail(`${story.where} 声明了 '${component}'，但没有从 './index' 导入它。`)
      }
      if (!coverage.has(component)) coverage.set(component, new Set())
      for (const state of story.states) coverage.get(component).add(state)
      if (!declaredOnly.has(component)) declaredOnly.set(component, new Set())
      for (const state of story.declared) declaredOnly.get(component).add(state)
    }
  }
}

for (const [component, states] of Object.entries(REQUIRED)) {
  if (!runtimeExports.has(component)) fail(`覆盖清单里的 '${component}' 不在 ui/index.ts 的正式导出中。`)
  const have = coverage.get(component)
  if (!have) {
    fail(`'${component}' 在覆盖清单里，但没有故事声明它。`)
    continue
  }
  const missing = states.filter((state) => !have.has(state))
  if (missing.length > 0) fail(`'${component}' 缺少状态：${missing.join(', ')}。`)
}

for (const [component, declared] of declaredOnly) {
  const have = coverage.get(component) ?? new Set()
  for (const state of declared) {
    if (!have.has(state)) fail(`'${component}' 的 declared 状态 '${state}' 不在它的 states 里。`)
  }
}

const excludedNames = new Set()
for (const name of runtimeExports) {
  if (coverage.has(name)) continue
  const exclusion = EXCLUSIONS.find((entry) => entry.test(name))
  if (exclusion) {
    excludedNames.add(name)
    continue
  }
  fail(`正式导出 '${name}' 既没有被状态矩阵覆盖，也没有排除理由。`)
}
for (const name of excludedNames) {
  const exclusion = EXCLUSIONS.find((entry) => entry.test(name))
  notes.push(`排除 '${name}'：${exclusion.reason}`)
}

const declaredTotal = [...declaredOnly.values()].reduce((sum, set) => sum + set.size, 0)

if (problems.length > 0) {
  console.error(`✗ v3 故事状态矩阵核对失败，共 ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('✓ v3 故事状态矩阵静态核对通过')
console.log(`  正式导出 ${runtimeExports.size} 个；状态矩阵覆盖 ${coverage.size} 个组件。`)
console.log(`  状态清单（覆盖清单）共 ${Object.keys(REQUIRED).length} 项，全部满足。`)
console.log(`  其中 ${declaredTotal} 个状态标记为「仅声明，未实测」（hover / focus / open 等）。`)
for (const note of notes) console.log(`  · ${note}`)
console.log('  边界：仅 CSF/结构状态声明的静态守卫，不做 play 交互、a11y 扫描或截图；外观请以 npm run storybook 的人工/浏览器结果为准。')
