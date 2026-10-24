import { useMemo, useState, type ReactElement } from 'react'
import { FolderPlus, Import, Settings2 } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { ListBoxItem } from '@yan/ui/ListBox'
import { SearchField } from '@yan/ui/TextField'
import { Select } from '@yan/ui/Select'
import type { GameFolder, InstanceInfo } from '../../shared/api.ts'
import { InstanceIcon } from './InstanceIcon.tsx'
import { instanceMeta } from './labels.ts'

interface Props {
  folders: GameFolder[]
  folder: string | null
  instances: InstanceInfo[] | null
  selectedId: string | null
  onFolder(path: string): void
  onSelect(id: string): void
  onLaunch(id: string): void
  onManage(id: string): void
  onPickFolder(): void
  onImport(): void
}

export function VersionList({ folders, folder, instances, selectedId, onFolder, onSelect, onLaunch, onManage, onPickFolder, onImport }: Props): ReactElement {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!instances || !needle) return instances
    return instances.filter((item) => item.id.toLowerCase().includes(needle) || (item.minecraftVersion ?? '').includes(needle) || item.loader.includes(needle))
  }, [instances, query])

  if (folders.length === 0) {
    return (
      <div className="versions versions--empty">
        <div className="empty">
          <h2 className="empty__title">还没有游戏目录</h2>
          <p className="empty__text">可以把 PCL 的目录、账号和 Java 一起带过来，也可以直接选一个 .minecraft 文件夹。</p>
          <div className="empty__actions">
            <Button variant="primary" icon={<Import size={14} />} onPress={onImport}>
              从 PCL 迁移
            </Button>
            <Button icon={<FolderPlus size={14} />} onPress={onPickFolder}>
              选择游戏目录
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="versions">
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
      {visible === null ? (
        <p className="versions__note">正在扫描版本…</p>
      ) : visible.length === 0 ? (
        <p className="versions__note">{query ? '没有匹配的版本。' : '这个目录里没有可启动的版本。'}</p>
      ) : (
        <ul className="versions__list" aria-label="版本">
          {visible.map((item) => {
            const broken = !!item.error && !item.minecraftVersion
            return (
              <li key={item.id} className="version" data-selected={selectedId === item.id ? '1' : undefined} data-broken={broken ? '1' : undefined}>
                <button
                  type="button"
                  className="version__pick"
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
                  {broken ? <Badge tone="fail">无法启动</Badge> : null}
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
