import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { pruneWindowsSnapshot } = await compile('src/main/mcp/windows-mcp-tree.ts', { packages: 'external' })
  const tree = [
    'Focused Window:',
    'Name  Depth',
    '',
    'UI Tree:',
    'desktop',
    '├── window "Editor"',
    '├── window ""',
    '├── window ""',
    '│   └── (10,20) 按钮 "Child"  [action: click]',
    '├── window "任务栏"',
    '│   └── 窗格 "任务栏"',
    '│       └── (974,1410) 按钮 "开始"  [action: click]',
    '├── window " "',
    '└── window ""'
  ].join('\n')
  const out = pruneWindowsSnapshot(tree).split('\n')
  ok(out.filter((line) => line.includes('window ""')).length === 1, '去掉没有子元素的无名窗口，保留有子元素的', out.join(' | '))
  ok(out.includes('│   └── (10,20) 按钮 "Child"  [action: click]') && out.includes('├── window "Editor"') && out.includes('│       └── (974,1410) 按钮 "开始"  [action: click]'), '有名窗口和子元素原样保留')
  ok(!out.includes('├── window " "') && !out.includes('└── window ""'), '只有空白名的窗口与末尾空窗口也去掉')
  ok(out[out.indexOf('UI Tree:') + 1] === '    (3 unnamed empty windows omitted)', '树开头注明省略数量', out.join(' | '))
  const wrapped = JSON.stringify(['UI Tree:\ndesktop\n├── window ""\n└── window "A"'])
  ok(pruneWindowsSnapshot(wrapped) === 'UI Tree:\n    (1 unnamed empty windows omitted)\ndesktop\n└── window "A"', 'JSON 数组包装的文本先展开再过滤')
  ok(pruneWindowsSnapshot('no tree here') === 'no tree here', '没有可过滤内容时原样返回')
})
