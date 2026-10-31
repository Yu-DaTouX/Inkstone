import { useI18n } from '../../../i18n'

type CapsTextKey =
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
  | 'promptsRefresh'
  | 'promptUserDirectory'
  | 'promptProjectDirectory'
  | 'promptOpenDirectory'
  | 'promptOpenFailed'
  | 'promptCreate'
  | 'promptName'
  | 'promptNameHint'
  | 'promptContent'
  | 'promptContentPlaceholder'
  | 'promptCreateHint'
  | 'promptSave'
  | 'promptSaveFailed'
  | 'promptRetryReload'
  | 'promptSavedReloadFailed'
  | 'promptSavedNoSession'
  | 'promptSavedLocation'
  | 'promptCreated'
  | 'promptNotLoaded'
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
  prompts: '提示词模板',
  sectionReload: '重新读取',
  mcpNativeUnavailable:
    '当前无法读取 pi 原生 MCP 状态。',
  mcpRunningBlock: '有任务在运行，导入会断开旧连接，请空闲后再试。',
  tabSkills: '技能与扩展',
  tabMcp: 'MCP',
  tabTools: '本机工具',
  skillsLoadedNote: '停用、启用和新装的技能对新会话生效；内置技能不列出。',
  skillDisabled: '已停用',
  skillReveal: '打开文件夹',
  skillTrash: '删除',
  skillTrashConfirm: '技能文件夹会移到回收站，可找回。',
  skillToggleLabel: '启用技能 {name}',
  extensionsPackagesNote: '扩展以你的身份运行代码，无沙箱；对新会话生效。',
  marketNoAutoNote: '打开本页时目录可能联网更新；搜索与下载点击后才请求。',
  promptsHiddenHint: '新建模板，或编辑下方目录里的 .md 文件（translate.md 对应 /translate），再发送 /reload。',
  promptsNoSession: '请先打开一个会话再查看提示词。',
  promptHiddenTag: '隐藏于菜单',
  promptsEmpty: '当前会话还没有提示词模板，点「新建模板」创建。',
  promptsRefresh: '刷新列表',
  promptUserDirectory: '用户模板（所有项目）',
  promptProjectDirectory: '项目模板（当前会话）',
  promptOpenDirectory: '打开模板目录',
  promptOpenFailed: '无法打开模板目录',
  promptCreate: '新建模板',
  promptName: '命令名称',
  promptNameHint: '如 translate；英文、数字、-、_，首位为英文或数字。',
  promptContent: '提示词正文',
  promptContentPlaceholder: '例如：将后面的内容翻译成英文，只输出译文。',
  promptCreateHint: '保存到用户模板，所有项目可用，并加载到当前空闲会话。',
  promptSave: '保存',
  promptSaveFailed: '无法创建模板',
  promptRetryReload: '重试加载',
  promptSavedReloadFailed: '文件已保存，但未加载：{error}。可稍后重试。',
  promptSavedNoSession: '模板已保存，打开新会话后即可使用。',
  promptSavedLocation: '已保存至：{path}',
  promptCreated: '模板 /{name} 已创建并加载。',
  promptNotLoaded: '重载后未找到模板 /{name}，请检查同名命令或模板加载设置',
  skillRemoveConfirm: '将删除该技能文件，不能撤销。',
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
  mcpListDesc: '停用、启用和删除会写回对应 mcp.json，新会话生效。',
  mcpDirectBadge: '砚直连',
  mcpDirectNote: '电脑操作由砚直连；开关在「本机工具 → 电脑操作」。',
  mcpDirectOff: '未开启',
  mcpToggleLabel: '启用 {name}',
  mcpRemove: '删除',
  mcpRemoveTitle: '删除 MCP 服务「{name}」',
  mcpRemoveBody: '从 {path} 移除，不能撤销；新会话生效。',
  mcpSaved: '已写入 {path}，新会话生效。',
  mcpLegacyTitle: '砚连接的旧服务',
  mcpLegacyDesc: '可导入到 pi 原生配置，之后由 pi 连接。',
  codegraphTitle: 'CodeGraph',
  codegraphGuide: '尚未加入 pi MCP；加入后可为项目建代码索引。',
  voiceSetupTitle: '转写程序与模型',
  voiceSetupHint: '下载见下方「转写程序与模型」。'
}

const EN: Record<CapsTextKey, string> = {
  extensions: 'Extensions',
  prompts: 'Prompt templates',
  sectionReload: 'Reload',
  mcpNativeUnavailable:
    'Native MCP status is unavailable.',
  mcpRunningBlock:
    'A task is running; importing drops connections. Retry when idle.',
  tabSkills: 'Skills & extensions',
  tabMcp: 'MCP',
  tabTools: 'Local tools',
  skillsLoadedNote: 'Changes apply to new sessions; bundled skills are not listed.',
  skillDisabled: 'Disabled',
  skillReveal: 'Open folder',
  skillTrash: 'Delete',
  skillTrashConfirm: 'The skill folder moves to the Recycle Bin.',
  skillToggleLabel: 'Enable skill {name}',
  extensionsPackagesNote: 'Extensions run code as you, with no sandbox; apply to new sessions.',
  marketNoAutoNote: 'The catalog may refresh on open; search and downloads run on click.',
  promptsHiddenHint: 'Create a template, or edit the .md files below (translate.md is /translate), then send /reload.',
  promptsNoSession:
    'Open a session to view prompts.',
  promptHiddenTag: 'Hidden from menu',
  promptsEmpty: 'No prompt templates yet; click New template.',
  promptsRefresh: 'Refresh list',
  promptUserDirectory: 'User templates (all projects)',
  promptProjectDirectory: 'Project templates (current session)',
  promptOpenDirectory: 'Open template folder',
  promptOpenFailed: 'Could not open the template folder',
  promptCreate: 'New template',
  promptName: 'Command name',
  promptNameHint: 'e.g. translate; letters, digits, - and _.',
  promptContent: 'Instructions',
  promptContentPlaceholder: 'For example: Translate the following text into English. Output only the translation.',
  promptCreateHint: 'Saved as a user template for all projects and loaded into the idle session.',
  promptSave: 'Save',
  promptSaveFailed: 'Could not create the template',
  promptRetryReload: 'Retry loading',
  promptSavedReloadFailed: 'Saved, but not loaded: {error}. Retry later.',
  promptSavedNoSession: 'Template saved. It will be available when you open a new session.',
  promptSavedLocation: 'Saved to: {path}',
  promptCreated: 'Template /{name} was created and loaded.',
  promptNotLoaded: 'Template /{name} was not found after reloading. Check for command conflicts or template loading settings',
  skillRemoveConfirm: 'Deletes the skill files; cannot be undone.',
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
  mcpListDesc: 'Changes are written to the owning mcp.json; new sessions apply.',
  mcpDirectBadge: 'Inkstone direct',
  mcpDirectNote: 'Computer use is direct; toggle it under Local tools.',
  mcpDirectOff: 'Off',
  mcpToggleLabel: 'Enable {name}',
  mcpRemove: 'Delete',
  mcpRemoveTitle: 'Delete MCP server “{name}”',
  mcpRemoveBody: 'Removed from {path}; cannot be undone.',
  mcpSaved: 'Written to {path}; applies to new sessions.',
  mcpLegacyTitle: 'Legacy Inkstone servers',
  mcpLegacyDesc: 'Import into native pi config; pi then connects.',
  codegraphTitle: 'CodeGraph',
  codegraphGuide: 'Not in pi MCP yet; add it to index projects.',
  voiceSetupTitle: 'Program & models',
  voiceSetupHint: 'Download below under Program & models.'
}

export function capsText(lang: string, key: CapsTextKey): string {
  return (lang === 'en-US' ? EN : ZH)[key]
}

export function fillCapsText(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)
}

export function useCapsText(): (key: CapsTextKey, values?: Record<string, string>) => string {
  const { lang } = useI18n()
  return (key, values) => values ? fillCapsText(capsText(lang, key), values) : capsText(lang, key)
}
