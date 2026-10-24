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
    '打开本页时，插件目录可能联网更新；搜索与下载仅在点击后请求。',
  promptsHiddenHint:
    '点击「新建模板」，填写名称和正文，保存后自动加载到当前空闲会话。也可在下方目录编辑 .md 文件（如 translate.md 对应 /translate），编辑后发送 /reload。插件模板需修改原文件。「隐藏于菜单」只是不进补全，并非停用。',
  promptsNoSession: '请先打开一个会话再查看提示词。',
  promptHiddenTag: '隐藏于菜单',
  promptsEmpty: '当前会话尚未加载提示词模板，点击「新建模板」即可创建。',
  promptsRefresh: '刷新列表',
  promptUserDirectory: '用户模板（所有项目）',
  promptProjectDirectory: '项目模板（当前会话）',
  promptOpenDirectory: '打开模板目录',
  promptOpenFailed: '无法打开模板目录',
  promptCreate: '新建模板',
  promptName: '命令名称',
  promptNameHint: '例如 translate。只用英文、数字、-、_，首位为英文或数字，不带 / 或 .md。',
  promptContent: '提示词正文',
  promptContentPlaceholder: '例如：将后面的内容翻译成英文，只输出译文。',
  promptCreateHint: '保存到用户模板，所有项目可用。命令后的内容会自动接到正文后面；已有参数占位符会保留。保存后自动加载到当前空闲会话。',
  promptSave: '保存',
  promptSaveFailed: '无法创建模板',
  promptRetryReload: '重试加载',
  promptSavedReloadFailed: '文件已保存，但暂未加载：{error}。无需重复创建，可稍后重试加载。',
  promptSavedNoSession: '模板已保存，打开新会话后即可使用。',
  promptSavedLocation: '已保存至：{path}',
  promptCreated: '模板 /{name} 已创建并加载。',
  promptNotLoaded: '重载后未找到模板 /{name}，请检查同名命令或模板加载设置',
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
  prompts: 'Prompt templates',
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
    'The plugin catalog may refresh online when this page opens. Search and downloads run only when clicked.',
  promptsHiddenHint:
    'Click “New template”, enter its name and instructions, and save to load it into the current idle session. You can also edit .md files below (e.g. translate.md defines /translate), then send /reload. Edit plugin templates in their original files. “Hidden from menu” only skips completion; it is not disabled.',
  promptsNoSession:
    'Open a session to view prompts.',
  promptHiddenTag: 'Hidden from menu',
  promptsEmpty: 'No prompt templates are loaded in this session. Click “New template” to create one.',
  promptsRefresh: 'Refresh list',
  promptUserDirectory: 'User templates (all projects)',
  promptProjectDirectory: 'Project templates (current session)',
  promptOpenDirectory: 'Open template folder',
  promptOpenFailed: 'Could not open the template folder',
  promptCreate: 'New template',
  promptName: 'Command name',
  promptNameHint: 'For example, translate. Use English letters, digits, - or _, starting with a letter or digit. Do not include / or .md.',
  promptContent: 'Instructions',
  promptContentPlaceholder: 'For example: Translate the following text into English. Output only the translation.',
  promptCreateHint: 'Saved to user templates, available in all projects. Command arguments are appended automatically unless argument placeholders are already present. Saving loads the template into the current idle session.',
  promptSave: 'Save',
  promptSaveFailed: 'Could not create the template',
  promptRetryReload: 'Retry loading',
  promptSavedReloadFailed: 'The file is saved, but not loaded yet: {error}. No need to create it again; retry loading later.',
  promptSavedNoSession: 'Template saved. It will be available when you open a new session.',
  promptSavedLocation: 'Saved to: {path}',
  promptCreated: 'Template /{name} was created and loaded.',
  promptNotLoaded: 'Template /{name} was not found after reloading. Check for command conflicts or template loading settings',
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

export function useCapsText(): (key: CapsTextKey, values?: Record<string, string>) => string {
  const { lang } = useI18n()
  return (key, values) => values ? fillCapsText(capsText(lang, key), values) : capsText(lang, key)
}
