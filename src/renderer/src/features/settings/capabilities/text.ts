import { useI18n } from '../../../i18n'

export type CapsTextKey =
  | 'extensions'
  | 'prompts'
  | 'sectionReload'
  | 'mcpNativeUnavailable'
  | 'mcpRunningBlock'
  | 'tabSkills'
  | 'tabMcp'
  | 'tabTools'
  | 'skillsLoadedNote'
  | 'skillDisabled'
  | 'skillReveal'
  | 'skillTrash'
  | 'skillTrashConfirm'
  | 'skillToggleLabel'
  | 'extensionsPackagesNote'
  | 'marketNoAutoNote'
  | 'promptsHiddenHint'
  | 'promptsNoSession'
  | 'promptHiddenTag'
  | 'promptsEmpty'
  | 'skillRemoveConfirm'
  | 'skillRemoveScopeChanged'
  | 'pkgStaleResult'
  | 'importFieldDescription'
  | 'importFieldTransport'
  | 'importFieldCommand'
  | 'importFieldArgs'
  | 'importFieldEnvKeys'
  | 'importFieldUrl'
  | 'installedNotLoaded'
  | 'loadFailed'
  | 'reloaded'
  | 'mcpListTitle'
  | 'mcpListDesc'
  | 'mcpDirectBadge'
  | 'mcpDirectNote'
  | 'mcpDirectOff'
  | 'mcpToggleLabel'
  | 'mcpRemove'
  | 'mcpRemoveTitle'
  | 'mcpRemoveBody'
  | 'mcpSaved'
  | 'mcpLegacyTitle'
  | 'mcpLegacyDesc'
  | 'codegraphTitle'
  | 'codegraphGuide'
  | 'voiceSetupTitle'
  | 'voiceSetupHint'

const ZH: Record<CapsTextKey, string> = {
  extensions: '扩展',
  prompts: '提示词',
  sectionReload: '重新读取',
  mcpNativeUnavailable:
    '当前无法读取 pi 原生 MCP 状态。',
  mcpRunningBlock: '有任务在运行，导入会断开旧连接，请空闲后再试。',
  tabSkills: '技能与扩展',
  tabMcp: 'MCP',
  tabTools: '本机工具',
  skillsLoadedNote:
    '停用、启用和新装的技能在新会话生效；随砚提供的技能不在这里列出。',
  skillDisabled: '已停用',
  skillReveal: '打开文件夹',
  skillTrash: '删除',
  skillTrashConfirm: '把这个技能的文件夹移到系统回收站，需要时可以从回收站找回。',
  skillToggleLabel: '启用技能 {name}',
  extensionsPackagesNote:
    '扩展以你的身份运行代码，无沙箱；对新会话生效。',
  marketNoAutoNote:
    '打开本页不联网；点「搜索」「下载」才请求。',
  promptsHiddenHint:
    '来自当前会话，只读，需在声明位置编辑；「隐藏于菜单」只是不进补全，并非停用，仍可调用。',
  promptsNoSession: '请先打开一个会话再查看提示词。',
  promptHiddenTag: '隐藏于菜单',
  promptsEmpty: '当前会话没有注册提示词。',
  skillRemoveConfirm:
    '将删除该技能文件，不能撤销；想保留先选「保留到我的技能」。',
  skillRemoveScopeChanged:
    '会话已变化，未执行移除，请重新确认。',
  pkgStaleResult:
    '项目已切换，结果未应用，请核对新项目。',
  importFieldDescription: '说明',
  importFieldTransport: '传输方式',
  importFieldCommand: '命令',
  importFieldArgs: '参数个数',
  importFieldEnvKeys: '环境变量（仅键名）',
  importFieldUrl: '服务地址（仅来源）',
  installedNotLoaded: '已安装，尚未加载',
  loadFailed: '读取失败',
  reloaded: '已重新读取',
  mcpListTitle: 'MCP 服务',
  mcpListDesc: 'pi 原生服务的停用、启用和删除写回所在的 mcp.json，新会话生效。',
  mcpDirectBadge: '砚直连',
  mcpDirectNote: '电脑操作需要排队与用户接管，所以由砚直接连接；开关在「本机工具 → 电脑操作」。',
  mcpDirectOff: '未开启',
  mcpToggleLabel: '启用 {name}',
  mcpRemove: '删除',
  mcpRemoveTitle: '删除 MCP 服务「{name}」',
  mcpRemoveBody: '从 {path} 移除这项配置，不能撤销；新会话生效。',
  mcpSaved: '已写入 {path}，新会话生效。',
  mcpLegacyTitle: '砚连接的旧服务',
  mcpLegacyDesc: '可以导入到 pi 原生配置；导入后由 pi 连接。',
  codegraphTitle: 'CodeGraph',
  codegraphGuide: '尚未加入 pi MCP；加入后可为项目建立代码索引。',
  voiceSetupTitle: '转写程序与模型',
  voiceSetupHint: '在下方「转写程序与模型」下载转写程序与模型。'
}

const EN: Record<CapsTextKey, string> = {
  extensions: 'Extensions',
  prompts: 'Prompts',
  sectionReload: 'Reload',
  mcpNativeUnavailable:
    'Native MCP status is unavailable.',
  mcpRunningBlock:
    'A task is running; importing drops connections. Retry when idle.',
  tabSkills: 'Skills & extensions',
  tabMcp: 'MCP',
  tabTools: 'Local tools',
  skillsLoadedNote:
    'Disabling, enabling and new skills apply in a new session; skills shipped with Inkstone are not listed.',
  skillDisabled: 'Disabled',
  skillReveal: 'Open folder',
  skillTrash: 'Delete',
  skillTrashConfirm: 'Moves this skill folder to the system trash; you can restore it from there.',
  skillToggleLabel: 'Enable skill {name}',
  extensionsPackagesNote:
    'Extensions run code as you, with no sandbox; apply to new sessions.',
  marketNoAutoNote:
    'No network until you click Search or Download.',
  promptsHiddenHint:
    'From the current session; read-only, edit them where declared. “Hidden from menu” only skips completion; it is not disabled.',
  promptsNoSession:
    'Open a session to view prompts.',
  promptHiddenTag: 'Hidden from menu',
  promptsEmpty: 'No prompts are registered in the current session.',
  skillRemoveConfirm:
    'Deletes the skill files and cannot be undone; to keep, choose “Keep in my skills” first.',
  skillRemoveScopeChanged:
    'Session changed; nothing removed. Confirm again.',
  pkgStaleResult:
    'Project changed; result not applied. Check the new project.',
  importFieldDescription: 'Description',
  importFieldTransport: 'Transport',
  importFieldCommand: 'Command',
  importFieldArgs: 'Argument count',
  importFieldEnvKeys: 'Environment keys (names only)',
  importFieldUrl: 'Server URL (origin only)',
  installedNotLoaded: 'Installed, not loaded',
  loadFailed: 'Load failed',
  reloaded: 'Reloaded',
  mcpListTitle: 'MCP servers',
  mcpListDesc: 'Disabling, enabling or deleting a pi server writes its mcp.json; applies to new sessions.',
  mcpDirectBadge: 'Inkstone direct',
  mcpDirectNote:
    'Computer use needs queuing and user takeover, so Inkstone connects it directly; switch it in Local tools → Computer use.',
  mcpDirectOff: 'Off',
  mcpToggleLabel: 'Enable {name}',
  mcpRemove: 'Delete',
  mcpRemoveTitle: 'Delete MCP server “{name}”',
  mcpRemoveBody: 'Removes this entry from {path}; cannot be undone. Applies to new sessions.',
  mcpSaved: 'Written to {path}; applies to new sessions.',
  mcpLegacyTitle: 'Legacy Inkstone servers',
  mcpLegacyDesc: 'Can be imported into pi’s native config; pi connects them afterwards.',
  codegraphTitle: 'CodeGraph',
  codegraphGuide: 'Not added to pi MCP yet; once added you can index the project.',
  voiceSetupTitle: 'Program & models',
  voiceSetupHint: 'Download the program and a model under Program & models below.'
}

export function capsText(lang: string, key: CapsTextKey): string {
  return (lang === 'en-US' ? EN : ZH)[key]
}

export function fillCapsText(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)
}

export function useCapsText(): (key: CapsTextKey) => string {
  const { lang } = useI18n()
  return (key) => capsText(lang, key)
}
