import { useMemo, useState, type KeyboardEvent, type ReactElement } from 'react'
import { FolderPlus, Import, RefreshCw, Settings2 } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { ListBoxItem } from '@yan/ui/ListBox'
import { Notice } from '@yan/ui/Notice'
import { SearchField } from '@yan/ui/TextField'
import { Select } from '@yan/ui/Select'
import { Skeleton } from '@yan/ui/Skeleton'
import type { GameFolder, InstanceInfo } from '../../shared/api.ts'
import { InstanceIcon } from './InstanceIcon.tsx'
import { instanceMeta } from './labels.ts'
import { EmptyBlock, PageHead } from './SubNavLayout.tsx'

interface Props {
  folders: GameFolder[]
  folder: string | null
  instances: InstanceInfo[] | null
  error: string | null
  selectedId: string | null
  onFolder(path: string): void
  onSelect(id: string): void
  onLaunch(id: string): void
  onManage(id: string): void
  onPickFolder(): void
  onImport(): void
  onRefresh(): void
}

export function VersionList({ folders, folder, instances, error, selectedId, onFolder, onSelect, onLaunch, onManage, onPickFolder, onImport, onRefresh }: Props): ReactElement {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!instances || !needle) return instances
    return instances.filter((item) => item.id.toLowerCase().includes(needle) || (item.minecraftVersion ?? '').includes(needle) || item.loader.includes(needle))
  }, [instances, query])

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End' && event.key !== 'Enter') return
    const picks = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.version__pick')].filter((pick) => !pick.disabled)
    if (picks.length === 0) return
    const index = picks.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Enter') {
      const id = picks[index]?.dataset.versionId
      if (!id) return
      event.preventDefault()
      onManage(id)
      return
    }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? picks.length - 1 : event.key === 'ArrowDown' ? Math.min(index + 1, picks.length - 1) : Math.max(index - 1, 0)
    picks[next]?.focus()
    event.preventDefault()
  }

  if (folders.length === 0) {
    return (
      <div className="versions versions--empty">
        <EmptyBlock
          icon={<FolderPlus size={20} />}
          title="还没有游戏目录"
          actions={
            <>
              <Button variant="primary" icon={<Import size={14} />} onPress={onImport}>
                从 PCL 迁移
              </Button>
              <Button icon={<FolderPlus size={14} />} onPress={onPickFolder}>
                选择游戏目录
              </Button>
            </>
          }
        >
          可以把 PCL 的目录、账号和 Java 一起带过来，也可以直接选一个 .minecraft 文件夹。
        </EmptyBlock>
      </div>
    )
  }

  return (
    <div className="versions">
      <div className="versions__pagehead">
        <PageHead
          title="版本"
          description="双击一行直接启动，回车打开版本详情，上下方向键在列表里移动。"
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onPress={onRefresh}>
                刷新
              </Button>
              <Button size="sm" icon={<FolderPlus size={14} />} onPress={onPickFolder}>
                添加目录
              </Button>
            </>
          }
        />
      </div>
      <div className="versions__head">
        <Select aria-label="游戏目录" className="versions__folder" selectedKey={folder} onSelectionChange={(key) => key != null && onFolder(String(key))}>
          {folders.map((item) => (
            <ListBoxItem key={item.path} id={item.path} textValue={item.name}>
              {item.name}
            </ListBoxItem>
          ))}
        </Select>
        <SearchField aria-label="搜索版本" className="versions__search" placeholder="搜索版本" value={query} onChange={setQuery} />
      </div>
      <div className="versions__path" title={folder ?? undefined}>
        {folder}
      </div>
      {error ? (
        <div className="versions__notice">
          <Notice tone="fail" compact title="读取版本列表失败" action={<Button size="sm" variant="ghost" onPress={onRefresh}>重试</Button>}>
            {error}
          </Notice>
        </div>
      ) : visible === null ? (
        <div className="versions__skeletons" aria-busy="true">
          <span className="sr-only">正在扫描版本…</span>
          {[0, 1, 2].map((row) => (
            <div key={row} className="version version--skeleton">
              <Skeleton shape="rect" width={32} height={32} />
              <span className="version__main">
                <Skeleton width="58%" height={12} />
                <Skeleton width="34%" height={10} />
              </span>
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="versions__empty">
          <EmptyBlock
            title={query ? '没有匹配的版本' : '这个目录里没有可启动的版本'}
            actions={
              query ? (
                <Button size="sm" onPress={() => setQuery('')}>
                  清空搜索
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onPress={onRefresh}>
                  重新扫描
                </Button>
              )
            }
          >
            {query ? '换个关键词试试。' : '用下载页装一个，或换一个游戏目录。'}
          </EmptyBlock>
        </div>
      ) : (
        <ul className="versions__list" aria-label="版本" onKeyDown={onListKeyDown}>
          {visible.map((item) => {
            const broken = !!item.error && !item.minecraftVersion
            return (
              <li key={item.id} className="version" data-selected={selectedId === item.id ? '1' : undefined} data-broken={broken ? '1' : undefined}>
                <button
                  type="button"
                  className="version__pick"
                  data-version-id={item.id}
                  aria-pressed={selectedId === item.id}
                  disabled={broken}
                  onClick={() => onSelect(item.id)}
                  onDoubleClick={() => onLaunch(item.id)}
                  title={broken ? undefined : '双击直接启动'}
                >
                  <InstanceIcon folder={item.folder} versionId={item.id} />
                  <span className="version__main">
                    <span className="version__name">{item.id}</span>
                    <span className="version__meta">{broken ? item.error : instanceMeta(item)}</span>
                  </span>
                  {broken ? <Badge tone="fail">无法启动</Badge> : selectedId === item.id ? <Badge tone="accent">当前</Badge> : null}
                </button>
                <Button variant="ghost" size="sm" className="version__manage" icon={<Settings2 size={14} />} aria-label={`管理 ${item.id}`} onPress={() => onManage(item.id)}>
                  管理
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
