import { useMemo, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { SortDescriptor } from 'react-aria-components'
import {
  Cell,
  Column,
  Row,
  sortRows,
  Table,
  TableBody,
  TableEmptyState,
  TableFooter,
  TableHeader,
  TableLoadingState
} from './index'

/**
 * Table 原语状态故事：排序、空态、加载、长表虚拟化与窄宽度。
 *
 * 只演示控件层行为，不含业务数据源；长表用 1000 行确认虚拟化只渲染可见行。
 */
const meta = {
  title: 'v3/Table',
  parameters: {
    layout: 'padded',
    stateMatrix: {
      components: [
        'Table',
        'TableHeader',
        'Column',
        'TableBody',
        'Row',
        'Cell',
        'TableFooter',
        'TableEmptyState',
        'TableLoadingState'
      ],
      states: ['default', 'selected', 'disabled', 'empty', 'loading'],
      declared: []
    }
  }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

interface SessionRow {
  id: string
  name: string
  status: string
  size: number
}

const COLUMNS = [
  { id: 'name', label: '会话', width: 220 },
  { id: 'status', label: '状态', width: 120 },
  { id: 'size', label: '大小', width: 96 }
] as const

const SESSIONS: SessionRow[] = [
  { id: 's1', name: '重构设计令牌', status: '运行中', size: 128 },
  { id: 's2', name: '验收 Storybook', status: '等你回答', size: 64 },
  { id: 's3', name: '修复窄窗溢出', status: '已完成', size: 256 },
  { id: 's4', name: '整理交接记录', status: '已完成', size: 32 },
  { id: 's5', name: '核对运行注册表', status: '运行中', size: 512 },
  { id: 's6', name: '归档旧截图', status: '已归档', size: 16 }
]

const LONG_ROWS: SessionRow[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `long-${index}`,
  name: `长表会话 ${String(index).padStart(4, '0')}`,
  status: index % 3 === 0 ? '运行中' : index % 3 === 1 ? '排队' : '已完成',
  size: (index * 7) % 4096
}))

function SessionHeader() {
  return (
    <TableHeader>
      {COLUMNS.map((column) => (
        <Column key={column.id} id={column.id} width={column.width} isRowHeader={column.id === 'name'}>
          {column.label}
        </Column>
      ))}
    </TableHeader>
  )
}

function SessionRowView({ row }: { row: SessionRow }) {
  return (
    <Row id={row.id}>
      <Cell>{row.name}</Cell>
      <Cell>{row.status}</Cell>
      <Cell>{row.size}</Cell>
    </Row>
  )
}

function SortableTable() {
  const [sort, setSort] = useState<SortDescriptor>({ column: 'name', direction: 'ascending' })
  const rows = useMemo(() => sortRows(SESSIONS, sort), [sort])
  return (
    <Table aria-label="会话" style={{ maxWidth: 640 }} onSortChange={setSort} sortDescriptor={sort}>
      <TableHeader>
        {COLUMNS.map((column) => (
          <Column
            key={column.id}
            id={column.id}
            width={column.width}
            allowsSorting
            isRowHeader={column.id === 'name'}
          >
            {column.label}
          </Column>
        ))}
      </TableHeader>
      <TableBody<SessionRow> items={rows}>{(row) => <SessionRowView row={row} />}</TableBody>
      <TableFooter>
        <Row>
          <Cell>共 {rows.length} 个会话</Cell>
          <Cell />
          <Cell />
        </Row>
      </TableFooter>
    </Table>
  )
}

export const Sortable: Story = {
  name: '排序 · 名称 / 状态 / 大小',
  render: () => <SortableTable />
}

export const Empty: Story = {
  name: '空态',
  render: () => (
    <Table aria-label="空表" style={{ maxWidth: 640 }}>
      <SessionHeader />
      <TableBody<SessionRow> items={[]} renderEmptyState={() => <TableEmptyState>还没有会话</TableEmptyState>}>
        {(row) => <SessionRowView row={row} />}
      </TableBody>
    </Table>
  )
}

export const Loading: Story = {
  name: '加载中',
  render: () => (
    <Table aria-label="加载中的表" style={{ maxWidth: 640 }}>
      <SessionHeader />
      <TableBody<SessionRow> items={[]} isLoading loadingState={<TableLoadingState>正在加载会话…</TableLoadingState>}>
        {(row) => <SessionRowView row={row} />}
      </TableBody>
    </Table>
  )
}

export const LongVirtualized: Story = {
  name: '长表 · 虚拟化 1000 行',
  render: () => (
    <Table
      aria-label="长表"
      isVirtualized
      layoutOptions={{ rowHeight: 32 }}
      style={{ width: 520, height: 320, maxWidth: '100%' }}
    >
      <SessionHeader />
      <TableBody<SessionRow> items={LONG_ROWS}>{(row) => <SessionRowView row={row} />}</TableBody>
    </Table>
  )
}

export const Narrow: Story = {
  name: '窄宽度 · 240px',
  render: () => (
    <div style={{ width: 240 }}>
      <Table aria-label="窄表">
        <TableHeader>
          {COLUMNS.map((column) => (
            <Column key={column.id} id={column.id} isRowHeader={column.id === 'name'}>
              {column.label}
            </Column>
          ))}
        </TableHeader>
        <TableBody<SessionRow> items={SESSIONS.slice(0, 4)}>
          {(row) => <SessionRowView row={row} />}
        </TableBody>
      </Table>
    </div>
  )
}

export const SelectionAndDisabled: Story = {
  name: '选中与禁用',
  render: () => (
    <Table
      aria-label="选中与禁用"
      selectionMode="multiple"
      defaultSelectedKeys={['s1', 's3']}
      disabledKeys={['s2']}
      style={{ maxWidth: 640 }}
    >
      <SessionHeader />
      <TableBody<SessionRow> items={SESSIONS}>{(row) => <SessionRowView row={row} />}</TableBody>
    </Table>
  )
}
