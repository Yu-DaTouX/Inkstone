import { useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Tree,
  TreeChevron,
  TreeEmptyState,
  TreeHeader,
  TreeItem,
  TreeItemContent,
  TreeItemLabel,
  TreeSection
} from './index'
import './Tree.css'

/**
 * v3 Tree 原语（WP-05）的状态故事。
 *
 * 外观一律来自 `Tree.css` 与 `design/tokens.css`，本文件不写控件样式；主题与密度
 * 由 `.storybook/preview.ts` 的全局装饰器切换。故事覆盖：层级、展开、禁用、空态、
 * 长名称，以及分组与多选。行内容用函数返回 `TreeItemContent`（RAC 的静态集合只认识
 * 直接的 `TreeItemContent` / `TreeItem` 子节点，不能包一层自定义组件）。
 */
const meta = {
  title: 'v3/Tree',
  parameters: {
    layout: 'padded',
    stateMatrix: {
      components: [
        'Tree',
        'TreeItem',
        'TreeItemContent',
        'TreeChevron',
        'TreeItemLabel',
        'TreeSection',
        'TreeHeader',
        'TreeEmptyState'
      ],
      states: ['default', 'selected', 'disabled', 'empty', 'open'],
      declared: ['open']
    }
  }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** 与产品一致的树表面：原语本身不含底色，交给所在面板。 */
function TreeSurface({ children, width = 320 }: { children: ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        maxWidth: '100%',
        padding: 'var(--s-8)',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)'
      }}
    >
      {children}
    </div>
  )
}

/** RAC 的行内容：chevron 由 slot 接入展开；叶子行由 CSS 隐藏箭头但保留对齐。 */
const rowContent = (label: string, title?: string) => (
  <TreeItemContent>
    <TreeChevron />
    <TreeItemLabel title={title ?? label}>{label}</TreeItemLabel>
  </TreeItemContent>
)

/* ---------- 层级 ---------- */

export const Hierarchy: Story = {
  name: '层级 · 三级目录',
  render: () => (
    <TreeSurface>
      <Tree
        aria-label="项目文件"
        selectionMode="single"
        defaultExpandedKeys={['src', 'components']}
        defaultSelectedKeys={['button']}
      >
        <TreeItem id="src" textValue="src">
          {rowContent('src')}
          <TreeItem id="components" textValue="components">
            {rowContent('components')}
            <TreeItem id="button" textValue="Button.tsx">
              {rowContent('Button.tsx')}
            </TreeItem>
            <TreeItem id="tree" textValue="Tree.tsx">
              {rowContent('Tree.tsx')}
            </TreeItem>
          </TreeItem>
          <TreeItem id="index" textValue="index.ts">
            {rowContent('index.ts')}
          </TreeItem>
        </TreeItem>
        <TreeItem id="readme" textValue="README.md">
          {rowContent('README.md')}
        </TreeItem>
      </Tree>
    </TreeSurface>
  )
}

/* ---------- 展开 ---------- */

function ExpansionDemo() {
  const [expanded, setExpanded] = useState<Set<string | number>>(new Set(['a']))
  return (
    <TreeSurface>
      <Tree aria-label="展开状态" expandedKeys={expanded} onExpandedChange={setExpanded}>
        <TreeItem id="a" textValue="设计令牌">
          {rowContent('设计令牌')}
          <TreeItem id="a1" textValue="tokens.json">
            {rowContent('tokens.json')}
          </TreeItem>
          <TreeItem id="a2" textValue="tokens.css">
            {rowContent('tokens.css')}
          </TreeItem>
        </TreeItem>
        <TreeItem id="b" textValue="组件原语">
          {rowContent('组件原语')}
          <TreeItem id="b1" textValue="Tree.tsx">
            {rowContent('Tree.tsx')}
          </TreeItem>
        </TreeItem>
      </Tree>
    </TreeSurface>
  )
}

export const Expansion: Story = {
  name: '展开 · 受控展开与收起',
  render: () => <ExpansionDemo />
}

/* ---------- 禁用 ---------- */

export const Disabled: Story = {
  name: '禁用 · 单行与整组',
  render: () => (
    <TreeSurface>
      <Tree aria-label="依赖" selectionMode="single" defaultExpandedKeys={['deps']} disabledKeys={['lodash', 'moment']}>
        <TreeItem id="deps" textValue="依赖">
          {rowContent('依赖')}
          <TreeItem id="react" textValue="react">
            {rowContent('react')}
          </TreeItem>
          <TreeItem id="lodash" textValue="lodash">
            {rowContent('lodash')}
          </TreeItem>
          <TreeItem id="moment" textValue="moment">
            {rowContent('moment')}
          </TreeItem>
        </TreeItem>
        <TreeItem id="locked" textValue="已锁定" isDisabled>
          {rowContent('已锁定')}
        </TreeItem>
      </Tree>
    </TreeSurface>
  )
}

/* ---------- 空态 ---------- */

export const Empty: Story = {
  name: '空态 · 没有任何文件',
  render: () => (
    <TreeSurface>
      <Tree aria-label="空项目" renderEmptyState={() => <TreeEmptyState>这个项目还没有文件</TreeEmptyState>} />
    </TreeSurface>
  )
}

/* ---------- 长名称 ---------- */

export const LongNames: Story = {
  name: '长名称 · 单行省略',
  render: () => (
    <TreeSurface width={280}>
      <Tree aria-label="长名称" defaultExpandedKeys={['deep']}>
        <TreeItem id="deep" textValue="超长目录">
          {rowContent('超长目录', '超长目录')}
          <TreeItem
            id="long"
            textValue="a-very-long-generated-file-name-that-must-be-truncated-in-the-row.tsx"
          >
            {rowContent(
              'a-very-long-generated-file-name-that-must-be-truncated-in-the-row.tsx',
              'a-very-long-generated-file-name-that-must-be-truncated-in-the-row.tsx'
            )}
          </TreeItem>
        </TreeItem>
      </Tree>
    </TreeSurface>
  )
}

/* ---------- 分组与多选 ---------- */

export const Sections: Story = {
  name: '分组与多选',
  render: () => (
    <TreeSurface>
      <Tree aria-label="分组多选" selectionMode="multiple" defaultExpandedKeys={['g1', 'g2']} defaultSelectedKeys={['one']}>
        <TreeSection>
          <TreeHeader>第一组</TreeHeader>
          <TreeItem id="g1" textValue="可展开组">
            {rowContent('可展开组')}
            <TreeItem id="one" textValue="one.txt">
              {rowContent('one.txt')}
            </TreeItem>
          </TreeItem>
        </TreeSection>
        <TreeSection>
          <TreeHeader>第二组</TreeHeader>
          <TreeItem id="two" textValue="two.txt">
            {rowContent('two.txt')}
          </TreeItem>
        </TreeSection>
      </Tree>
    </TreeSurface>
  )
}
