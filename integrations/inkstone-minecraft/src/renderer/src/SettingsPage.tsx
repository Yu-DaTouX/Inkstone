import { useEffect, useState, type ReactElement } from 'react'
import { Coffee, Download, FolderOpen, FolderPlus, Gamepad2, Import, Info, Palette, Trash2, UserRound } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'
import { ListBoxItem } from '@yan/ui/ListBox'
import { Select } from '@yan/ui/Select'
import { SettingRow, SettingSection } from '@yan/ui/SettingRow'
import { Slider } from '@yan/ui/Slider'
import { version } from '../../../package.json'
import type { DownloadSource, JavaEntry, LauncherSettings, ThemePreference } from '../../shared/api.ts'
import { ImportPage } from './ImportPage.tsx'
import { accountKindLabel, accountKindTone, accountStatus, memoryLabel } from './labels.ts'
import { ConfirmDialog } from './overlays.tsx'
import { PageHead, SubNavLayout, type SubNavGroup } from './SubNavLayout.tsx'

export type SettingsSection = 'accounts' | 'folders' | 'java' | 'game' | 'download' | 'appearance' | 'import' | 'about'

const GROUPS: SubNavGroup<SettingsSection>[] = [
  {
    label: '启动',
    items: [
      { id: 'accounts', label: '账号', icon: <UserRound size={16} /> },
      { id: 'folders', label: '游戏目录', icon: <FolderOpen size={16} /> },
      { id: 'java', label: 'Java', icon: <Coffee size={16} /> },
      { id: 'game', label: '启动默认值', icon: <Gamepad2 size={16} /> }
    ]
  },
  {
    label: '启动器',
    items: [
      { id: 'download', label: '下载', icon: <Download size={16} /> },
      { id: 'appearance', label: '外观', icon: <Palette size={16} /> },
      { id: 'import', label: '导入', icon: <Import size={16} /> },
      { id: 'about', label: '关于', icon: <Info size={16} /> }
    ]
  }
]

const MEMORY_STEPS = [2048, 3072, 4096, 6144, 8192, 12288, 16384]

const DOWNLOAD_SOURCES: { id: DownloadSource; label: string; description: string }[] = [
  { id: 'auto', label: '自动', description: '先用 BMCLAPI，失败时换官方源' },
  { id: 'bmclapi', label: 'BMCLAPI', description: '国内镜像，速度通常更快' },
  { id: 'official', label: '官方', description: 'Mojang 与各加载器的官方地址' }
]

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' }
]

const CREDITS = [
  { name: '@xmcl/core、@xmcl/user', note: 'MIT · 启动参数与离线账号' },
  { name: 'Prism Launcher、HMCL', note: 'GPL · 只参考功能结构，没有使用代码' },
  { name: 'PCL', note: '只读取它的配置用于迁移，没有使用代码与素材' },
  { name: 'BMCLAPI', note: '国内下载镜像' },
  { name: 'Modrinth', note: '社区资源' }
]

interface Pending {
  title: string
  text: string
  run(): Promise<void>
}

interface Props {
  settings: LauncherSettings
  apply(next: Promise<LauncherSettings>): Promise<void>
  section: SettingsSection
  onSection(section: SettingsSection): void
  onImported(): void
}

export function SettingsPage({ settings, apply, section, onSection, onImported }: Props): ReactElement {
  const [javas, setJavas] = useState<JavaEntry[] | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [concurrency, setConcurrency] = useState(settings.downloadConcurrency)
  const update = (patch: Partial<LauncherSettings>): void => void apply(window.craft.updateSettings(patch))

  useEffect(() => setConcurrency(settings.downloadConcurrency), [settings.downloadConcurrency])

  useEffect(() => {
    if (section !== 'java') return
    let alive = true
    setJavas(null)
    void window.craft.javas().then(
      (list) => alive && setJavas(list),
      () => alive && setJavas([])
    )
    return () => {
      alive = false
    }
  }, [section, settings.extraJavaPaths])

  const addFolder = async (): Promise<void> => {
    const path = await window.craft.pickFolder()
    if (!path || settings.folders.some((item) => item.path.toLowerCase() === path.toLowerCase())) return
    update({ folders: [...settings.folders, { name: path, path }] })
  }

  const confirm = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    try {
      await pending.run()
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  const memoryOptions = [...new Set([...MEMORY_STEPS, settings.maxMemoryMb])].sort((a, b) => a - b)
  const currentFolder = settings.selectedFolder ?? settings.folders[0]?.path

  return (
    <SubNavLayout label="设置" groups={GROUPS} active={section} onChange={onSection}>
      {section === 'import' ? (
        <ImportPage settings={settings} apply={apply} onDone={onImported} />
      ) : (
        <div className="subpage">
          {section === 'accounts' ? (
            <>
              <PageHead title="账号" description="在启动页左侧左右滑动头像切换账号。" />
              <SettingSection title="已添加">
                {settings.accounts.length === 0 ? <SettingRow label="还没有账号" description="在启动页左侧添加。" /> : null}
                {settings.accounts.map((account) => (
                  <SettingRow
                    key={account.id}
                    label={
                      <span className="settings-account">
                        {account.name}
                        <Badge tone={accountKindTone(account)}>{accountKindLabel(account)}</Badge>
                        {account.id === settings.selectedAccountId ? <Badge tone="accent">当前</Badge> : null}
                      </span>
                    }
                    description={accountStatus(account)}
                  >
                    <IconButton
                      aria-label={`移除 ${account.name}`}
                      size="sm"
                      onPress={() =>
                        setPending({
                          title: `移除账号 ${account.name}？`,
                          text: account.kind === 'offline' ? '离线账号随时可以重新添加。' : '移除后需要重新登录才能再用这个账号。',
                          run: () => apply(window.craft.removeAccount(account.id))
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </SettingRow>
                ))}
              </SettingSection>
              <SettingSection title="登录方式">
                <SettingRow label="离线" description="输入名字即可，只能进单机和离线服务器。">
                  <Badge tone="ok">可用</Badge>
                </SettingRow>
                <SettingRow label="Microsoft 正版" description="设备码登录。">
                  <Badge>开发中</Badge>
                </SettingRow>
                <SettingRow label="外置登录" description="LittleSkin 等 authlib-injector 皮肤站。">
                  <Badge>开发中</Badge>
                </SettingRow>
              </SettingSection>
            </>
          ) : section === 'folders' ? (
            <>
              <PageHead
                title="游戏目录"
                description="每个目录是一个 .minecraft 文件夹，里面的版本会出现在启动页。"
                actions={
                  <Button size="sm" icon={<FolderPlus size={14} />} onPress={() => void addFolder()}>
                    添加目录
                  </Button>
                }
              />
              <SettingSection title="已添加">
                {settings.folders.length === 0 ? <SettingRow label="还没有游戏目录" /> : null}
                {settings.folders.map((folder) => (
                  <SettingRow key={folder.path} label={folder.name} description={folder.path}>
                    {currentFolder === folder.path ? (
                      <Badge tone="accent">当前</Badge>
                    ) : (
                      <Button size="sm" variant="ghost" onPress={() => update({ selectedFolder: folder.path, selectedVersion: null })}>
                        设为当前
                      </Button>
                    )}
                    <IconButton
                      aria-label={`移除 ${folder.name}`}
                      size="sm"
                      onPress={() =>
                        setPending({
                          title: `移除目录 ${folder.name}？`,
                          text: '只是不再在启动器里显示，文件夹和里面的游戏都不会删除。',
                          run: () => {
                            const folders = settings.folders.filter((item) => item.path !== folder.path)
                            return apply(
                              window.craft.updateSettings({ folders, selectedFolder: settings.selectedFolder === folder.path ? (folders[0]?.path ?? null) : settings.selectedFolder })
                            )
                          }
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </SettingRow>
                ))}
              </SettingSection>
            </>
          ) : section === 'java' ? (
            <>
              <PageHead title="Java" description="启动时按版本要求自动挑选；PCL 为单个版本指定的 Java 优先使用。" />
              <SettingSection title="找到的 Java">
                {javas === null ? <SettingRow label="正在检测…" /> : null}
                {javas?.length === 0 ? <SettingRow label="没有找到 Java" description="安装功能完成后可以在这里一键下载。" /> : null}
                {javas?.map((java) => (
                  <SettingRow key={java.path} label={`Java ${java.majorVersion}`} description={java.path}>
                    <span className="page__muted">{java.version}</span>
                  </SettingRow>
                ))}
              </SettingSection>
            </>
          ) : section === 'game' ? (
            <>
              <PageHead title="启动默认值" description="所有版本默认使用这些值。" />
              <SettingSection title="内存">
                <SettingRow label="最大内存" description="分给游戏的 Java 堆内存上限。">
                  <Select aria-label="最大内存" selectedKey={String(settings.maxMemoryMb)} onSelectionChange={(key) => key != null && update({ maxMemoryMb: Number(key) })}>
                    {memoryOptions.map((value) => (
                      <ListBoxItem key={value} id={String(value)} textValue={memoryLabel(value)}>
                        {memoryLabel(value)}
                      </ListBoxItem>
                    ))}
                  </Select>
                </SettingRow>
              </SettingSection>
            </>
          ) : section === 'download' ? (
            <>
              <PageHead title="下载" description="安装游戏、加载器和资源时使用。" />
              <SettingSection title="下载源">
                <SettingRow label="下载源" description={DOWNLOAD_SOURCES.find((item) => item.id === settings.downloadSource)?.description}>
                  <Select aria-label="下载源" selectedKey={settings.downloadSource} onSelectionChange={(key) => key != null && update({ downloadSource: key as DownloadSource })}>
                    {DOWNLOAD_SOURCES.map((item) => (
                      <ListBoxItem key={item.id} id={item.id} textValue={item.label}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </Select>
                </SettingRow>
                <SettingRow label="同时下载" description="网络不稳定时调低。" block>
                  <Slider
                    aria-label="同时下载数"
                    className="settings-slider"
                    minValue={4}
                    maxValue={64}
                    step={4}
                    showValue
                    value={concurrency}
                    onChange={(value) => setConcurrency(Array.isArray(value) ? (value[0] ?? 16) : value)}
                    onChangeEnd={(value) => update({ downloadConcurrency: Array.isArray(value) ? (value[0] ?? 16) : value })}
                  />
                </SettingRow>
              </SettingSection>
            </>
          ) : section === 'appearance' ? (
            <>
              <PageHead title="外观" />
              <SettingSection title="主题">
                <SettingRow label="颜色主题">
                  <Select aria-label="颜色主题" selectedKey={settings.theme} onSelectionChange={(key) => key != null && update({ theme: key as ThemePreference })}>
                    {THEMES.map((item) => (
                      <ListBoxItem key={item.id} id={item.id} textValue={item.label}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </Select>
                </SettingRow>
              </SettingSection>
            </>
          ) : (
            <>
              <PageHead title="Inkstone Minecraft" description={`版本 ${version} · 可独立运行，也可作为砚的插件。`} />
              <SettingSection title="数据">
                <SettingRow label="账号" description="只保存类型、名字、UUID 与皮肤站地址；正版与外置登录的令牌接入后会加密保存。" />
                <SettingRow label="删除" description="删除版本、Mod 与存档时移到回收站。" />
              </SettingSection>
              <SettingSection title="致谢与许可">
                {CREDITS.map((item) => (
                  <SettingRow key={item.name} label={item.name} description={item.note} />
                ))}
              </SettingSection>
            </>
          )}
        </div>
      )}
      <ConfirmDialog open={!!pending} title={pending?.title ?? ''} confirmLabel="移除" danger busy={busy} onConfirm={() => void confirm()} onCancel={() => !busy && setPending(null)}>
        {pending?.text}
      </ConfirmDialog>
    </SubNavLayout>
  )
}
