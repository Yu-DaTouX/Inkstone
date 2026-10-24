import type { LoaderKind } from '../../shared/api.ts'
import type { CrashActionKind, CrashConfidence } from '../../shared/crash-api.ts'
import { modLabel } from './mods.ts'

export interface RuleContext {
  text: string
  names: Map<string, string>
}

export interface RuleOutcome {
  summary: string
  missing: string[]
}

export interface CrashRule {
  id: string
  title: string
  loaders: 'all' | LoaderKind[]
  confidence: CrashConfidence
  match: RegExp[]
  evidence: RegExp
  actions: CrashActionKind[]
  describe(context: RuleContext): RuleOutcome
}

const IGNORED_MISSING = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'forge', 'neoforge'])

function label(names: Map<string, string>, id: string): string {
  return modLabel(names, id)
}

function javaMajorOfClassVersion(classVersion: number): number {
  return classVersion - 44
}

function classVersionIn(text: string): number | null {
  const match = /class file version (\d+)\.\d+/.exec(text)
  return match ? Number(match[1]) : null
}

function uniq(list: string[]): string[] {
  return [...new Set(list)]
}

export const CRASH_RULES: CrashRule[] = [
  {
    id: 'java-version',
    title: 'Java 版本不符',
    loaders: 'all',
    confidence: 'high',
    match: [
      /UnsupportedClassVersionError/,
      /has been compiled by a more recent version of the Java Runtime/,
      /Unsupported major\.minor version/,
      /ClassVersionError/,
      /requires Java (?:SE )?\d+/i,
      /unsupported (?:major|class file) version/i
    ],
    evidence: /UnsupportedClassVersionError|Unsupported major\.minor version|ClassVersionError|requires Java|class file version/i,
    actions: ['java', 'export'],
    describe({ text }) {
      const needed = classVersionIn(text) ?? Number(/(?:requires Java(?: SE)? |requires Java )(\d+)/i.exec(text)?.[1] ?? 0)
      const needMajor = needed > 44 ? javaMajorOfClassVersion(needed) : needed
      const limited = /recognizes class file versions up to (\d+)\.\d+/.exec(text)?.[1]
      const current = limited ? javaMajorOfClassVersion(Number(limited)) : null
      const parts: string[] = []
      if (needMajor) parts.push(`这个版本要用 Java ${needMajor}`)
      if (current) parts.push(`当前 Java 是 ${current}`)
      parts.push('换一个 Java 再启动')
      return { summary: `Java 版本不符：${parts.join('，')}。`, missing: [] }
    }
  },
  {
    id: 'out-of-memory',
    title: '内存不足',
    loaders: 'all',
    confidence: 'high',
    match: [
      /OutOfMemoryError/,
      /insufficient memory for the Java Runtime Environment/,
      /Could not reserve enough space for object heap/,
      /Native memory allocation \(malloc\) failed/,
      /Out of memory/i
    ],
    evidence: /OutOfMemoryError|insufficient memory|Could not reserve|malloc|Out of memory/i,
    actions: ['memory', 'export'],
    describe() {
      return { summary: '内存不足：给游戏的内存不够用，调高内存或减少 Mod 再启动。', missing: [] }
    }
  },
  {
    id: 'corrupt-file',
    title: '文件损坏',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge', 'unknown'],
    confidence: 'high',
    match: [/ZipException/, /invalid (?:LOC|CEN) header/i, /Invalid or corrupted jarfile/i, /bad signature/i, /Failed to load mod file .*\.jar/i],
    evidence: /ZipException|invalid (?:LOC|CEN) header|corrupted jarfile|bad signature|Failed to load mod file/i,
    actions: ['disable-mod', 'mods', 'export'],
    describe({ text }) {
      const file = /Failed to load mod file ([^\s:]+\.jar)/i.exec(text)?.[1] ?? null
      return { summary: `文件损坏：${file ? `${file} 读不出来，` : '某个 jar 读不出来，'}重新下载它或去版本页「修复」。`, missing: [] }
    }
  },
  {
    id: 'missing-dependency',
    title: '缺少前置 Mod 或依赖版本不符',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge', 'unknown'],
    confidence: 'high',
    match: [
      /requires any version of [\w.-]+, which is missing/i,
      /requires [\w.-]+ [^\n]*which is missing/i,
      /Missing or unsupported mandatory dependencies/i,
      /Mod resolution (?:failed|encountered an incompatible mod set)/i,
      /MissingDependencyException/,
      /Incompatible mod set/i,
      /incompatible mod set for game/i
    ],
    evidence: /requires .*which is missing|Missing or unsupported mandatory dependencies|Mod resolution|MissingDependencyException|Incompatible mod set/i,
    actions: ['install-deps', 'disable-mod', 'mods', 'export'],
    describe({ text, names }) {
      const missing = uniq(
        [
          ...Array.from(text.matchAll(/requires any version of ([\w.-]+), which is missing/gi), (hit) => hit[1]),
          ...Array.from(text.matchAll(/Mod ID: '([\w.-]+)',\s*Requested by: '([\w.-]+)'/g), (hit) => hit[1]),
          ...Array.from(text.matchAll(/Install ([\w.-]+), any version/gi), (hit) => hit[1])
        ].filter((id) => !IGNORED_MISSING.has(id.toLowerCase()))
      )
      const who = uniq(Array.from(text.matchAll(/Requested by: '([\w.-]+)'/g), (hit) => hit[1])).find((id) => !missing.includes(id)) ?? null
      if (missing.length === 0) return { summary: '缺少前置 Mod 或依赖版本不符：按日志里列出的 modid 补齐前置。', missing }
      const list = missing.map((id) => label(names, id)).join('、')
      return { summary: `缺少前置 Mod：${list}${who ? `（${label(names, who)} 需要）` : ''}。`, missing }
    }
  },
  {
    id: 'duplicate-mod',
    title: '重复安装了同一个 Mod',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge', 'unknown'],
    confidence: 'high',
    match: [/Duplicate mod/i, /duplicate mods? found/i, /Found duplicate mod id/i, /DuplicateMod/],
    evidence: /Duplicate mod|duplicate mods? found|Found duplicate mod id/i,
    actions: ['disable-mod', 'mods', 'export'],
    describe({ text, names }) {
      const id = /Duplicate mod id:?\s*'?([\w.-]+)'?/i.exec(text)?.[1] ?? /Duplicate mod (\w[\w.-]*)/i.exec(text)?.[1] ?? null
      return { summary: id ? `重复安装了同一个 Mod：${label(names, id)} 装了两份，删掉一份再启动。` : '重复安装了同一个 Mod：删掉重复的 jar 再启动。', missing: [] }
    }
  },
  {
    id: 'entrypoint-crash',
    title: 'Mod 初始化时崩溃',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge', 'unknown'],
    confidence: 'high',
    match: [
      /Could not execute entrypoint stage/i,
      /provided by '[\w.-]+' at /,
      /EntrypointException/,
      /LanguageAdapterException/,
      /Failed to create mod instance/i,
      /A mod crashed on startup/i,
      /Exception while loading entries for entrypoint/i
    ],
    evidence: /Could not execute entrypoint stage|provided by '[\w.-]+' at |EntrypointException|LanguageAdapterException|Failed to create mod instance|A mod crashed on startup|Exception while loading entries/i,
    actions: ['disable-mod', 'mods', 'export'],
    describe({ text, names }) {
      const mod = /provided by '([\w.-]+)'/.exec(text)?.[1] ?? /Failed to create mod instance[^\n]*?(\b[\w.-]+\b)/i.exec(text)?.[1] ?? null
      const target = mod ? label(names, mod) : '某个 Mod'
      const cause = /Caused by: java\.lang\.(?:ClassNotFoundException|NoClassDefFoundError|AbstractMethodError)[^\n]*/.exec(text)?.[0] ?? null
      return {
        summary: `Mod 初始化时崩溃：${target} 的入口点抛了异常${cause ? `（${cause.replace(/^Caused by: /, '').slice(0, 80)}）` : ''}，先停用它或换对应版本。`,
        missing: []
      }
    }
  },
  {
    id: 'mixin-failure',
    title: 'Mixin 注入失败',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge', 'unknown'],
    confidence: 'high',
    match: [
      /Mixin apply for mod .* failed/i,
      /Mixin apply failed/i,
      /InvalidInjectionException/,
      /InvalidMixinException/,
      /MixinTransformerError/,
      /Critical injection failure/i,
      /Mixin apply for .* failed/i
    ],
    evidence: /Mixin apply|InvalidInjectionException|InvalidMixinException|MixinTransformerError|Critical injection failure/i,
    actions: ['disable-mod', 'mods', 'export'],
    describe({ text, names }) {
      const mod = /Mixin apply for mod ([\w.-]+) failed/i.exec(text)?.[1] ?? /mixin config ([\w.-]+)/i.exec(text)?.[1] ?? null
      const config = /([\w.-]+\.mixins?(?:\.\w+)?\.json)/i.exec(text)?.[1] ?? null
      const target = mod ? label(names, mod) : (config ?? '某个 Mod')
      return { summary: `Mixin 注入失败：${target} 和当前游戏或加载器版本不匹配，停用它或换对应版本。`, missing: [] }
    }
  },
  {
    id: 'forge-incomplete',
    title: 'Forge / NeoForge 安装不完整',
    loaders: ['forge', 'neoforge'],
    confidence: 'high',
    match: [
      /Missing patched client/i,
      /Failed to find patched client/i,
      /patched client jar/i,
      /Missing or absent processor output/i,
      /processor (?:output|failed)/i,
      /Could not find or load main class (?:net\.minecraftforge|cpw\.mods)/,
      /FMLLoadingException/
    ],
    evidence: /patched client|processor output|Could not find or load main class|FMLLoadingException/i,
    actions: ['repair', 'export'],
    describe() {
      return { summary: 'Forge/NeoForge 安装不完整：处理器产物或 patched client 缺失，去版本页「修复」补文件。', missing: [] }
    }
  },
  {
    id: 'coremod',
    title: 'coremod / transformer 失败',
    loaders: ['forge', 'neoforge'],
    confidence: 'medium',
    match: [/Coremod/i, /FMLCorePlugin/, /TransformerException/, /CoreModLoader/i, /transformer .* failed/i, /transformation service/i],
    evidence: /Coremod|FMLCorePlugin|TransformerException|transformer .* failed|transformation service/i,
    actions: ['disable-mod', 'mods', 'export'],
    describe({ text }) {
      const name = /(?:coremod|Coremod) ([\w.$-]+)/.exec(text)?.[1] ?? null
      return { summary: `coremod / transformer 加载失败：${name ? `${name} ` : ''}跟当前加载器版本不兼容，停用它或换版本。`, missing: [] }
    }
  },
  {
    id: 'native-library',
    title: '原生库缺失或位数不符',
    loaders: 'all',
    confidence: 'medium',
    match: [/UnsatisfiedLinkError/, /no lwjgl in java\.library\.path/, /Failed to locate library/, /Failed to load native/, /natives? (?:directory|path).*(?:missing|not found)/i],
    evidence: /UnsatisfiedLinkError|no lwjgl|Failed to locate library|Failed to load native|natives? (?:directory|path)/i,
    actions: ['repair', 'java', 'export'],
    describe() {
      return { summary: '原生库缺失或位数不对：去版本页「修复」重新解压 natives，并确认 Java 位数与系统一致。', missing: [] }
    }
  },
  {
    id: 'gpu-driver',
    title: '显卡驱动或 OpenGL 不可用',
    loaders: 'all',
    confidence: 'medium',
    match: [
      /Failed to create GLFW window/i,
      /The driver does not appear to support OpenGL/i,
      /GLFW error/i,
      /Pixel format not accelerated/i,
      /org\.lwjgl\.opengl\.OpenGLException/,
      /OpenGL (?:version|profile) .* (?:not supported|unsupported)/i,
      /WGL: (?:The driver|Failed)/i
    ],
    evidence: /Failed to create GLFW window|does not appear to support OpenGL|GLFW error|Pixel format not accelerated|OpenGLException|WGL:/i,
    actions: ['java', 'export'],
    describe() {
      return { summary: '显卡驱动或 OpenGL 不可用：更新显卡驱动，或换一个官方 Java 再启动。', missing: [] }
    }
  }
]

export function applicableRules(loader: LoaderKind): CrashRule[] {
  return CRASH_RULES.filter((rule) => rule.loaders === 'all' || rule.loaders.includes(loader))
}

export function ruleById(id: string): CrashRule | null {
  return CRASH_RULES.find((rule) => rule.id === id) ?? null
}
