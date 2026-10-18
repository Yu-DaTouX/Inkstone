import type { SettingsSearchEntry } from './search-model'

export const DATA_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  { id: 'devices-enable', section: 'devices', zh: '手机接入', en: 'Phone access', keywords: ['远程', '手机', 'remote', 'phone', 'mobile'] },
  {
    id: 'devices-pair',
    section: 'devices',
    zh: '配对新手机',
    en: 'Pair a new phone',
    keywords: ['配对码', '二维码', '生成配对码', '经中继配对', '连接手机', 'pairing code', 'QR', 'relay pairing']
  },
  {
    id: 'devices-list',
    section: 'devices',
    zh: '已配对设备',
    en: 'Paired devices',
    keywords: ['撤销', '移除记录', '中继设备', '直连', 'revoke', 'forget', 'devices']
  },
  {
    id: 'devices-bind',
    section: 'devices',
    zh: '监听地址',
    en: 'Listen address',
    keywords: ['Tailscale', 'Radmin VPN', '局域网', '仅本机', 'LAN', 'loopback', 'bind', '网络'],
    more: true
  },
  {
    id: 'devices-relay',
    section: 'devices',
    zh: '中继接入（不用 Tailscale）',
    en: 'Relay access (no Tailscale)',
    keywords: ['中继', 'relay', '礁石', 'reef'],
    more: true
  },
  { id: 'devices-relay-url', section: 'devices', zh: '中继地址', en: 'Relay URL', keywords: ['relay url', '中继服务器'], more: true },
  {
    id: 'devices-peer',
    section: 'devices',
    zh: '砚对砚授权',
    en: 'Peer links',
    keywords: ['peer', '其他砚', '断开', 'disconnect'],
    more: true
  },
  { id: 'data-backup-create', section: 'data', zh: '创建备份', en: 'Create backup', keywords: ['备份', 'backup'] },
  {
    id: 'data-location',
    section: 'data',
    zh: '数据位置',
    en: 'Data location',
    keywords: ['数据目录', '打开位置', '占用', 'data folder', 'storage']
  },
  { id: 'data-sync-folder', section: 'data', zh: '同步文件夹', en: 'Sync folder', keywords: ['同步', '云盘', 'sync', 'cloud drive'] },
  { id: 'data-sync-mode', section: 'data', zh: '同步方式', en: 'Sync mode', keywords: ['自动同步', '手动同步', 'auto sync', 'manual'] },
  { id: 'data-sync-now', section: 'data', zh: '立即同步', en: 'Sync now', keywords: ['同步状态', '上次同步', 'last sync', 'sync status'] },
  {
    id: 'data-sync-scope',
    section: 'data',
    zh: '同步哪些内容',
    en: 'What gets synced',
    keywords: ['同步范围', '同步内容', 'sync scope', 'credentials']
  },
  {
    id: 'data-move',
    section: 'data',
    zh: '移动到其它盘',
    en: 'Move to another drive',
    keywords: ['数据迁移', '迁移并重启', 'migrate', 'relocate'],
    more: true
  },
  { id: 'data-backup-verify', section: 'data', zh: '校验备份', en: 'Verify backup', keywords: ['备份校验', 'verify', 'check backup'], more: true },
  {
    id: 'data-sync-conflicts',
    section: 'data',
    zh: '同步冲突',
    en: 'Sync conflicts',
    keywords: ['冲突', '保留本机', '保留他端', 'conflict', 'resolve'],
    more: true
  },
  {
    id: 'data-session-export',
    section: 'data',
    zh: '导出当前会话',
    en: 'Export current session',
    keywords: ['导出会话', '会话包', 'export session', 'bundle'],
    more: true
  },
  {
    id: 'data-session-import',
    section: 'data',
    zh: '导入会话包',
    en: 'Import session bundle',
    keywords: ['导入会话', 'import session'],
    more: true
  },
  {
    id: 'data-share-destination',
    section: 'data',
    zh: '会话分享',
    en: 'Session sharing',
    keywords: ['分享目的地', 'gist', 'radius', 'share'],
    more: true
  }
]
