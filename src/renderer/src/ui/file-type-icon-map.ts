export const FILE_TYPE_ICON_IDS = [
  'file',
  'doc',
  'table',
  'ts',
  'js',
  'py',
  'rs',
  'go',
  'css',
  'html',
  'code',
  'terminal',
  'json',
  'config',
  'git',
  'image',
  'video',
  'audio',
  'archive',
  'database',
  'lock'
] as const

export type FileTypeIconId = (typeof FILE_TYPE_ICON_IDS)[number]

export type FileTypeTone = 'gray' | 'green' | 'blue' | 'yellow' | 'orange' | 'red' | 'purple' | 'teal'

export const FILE_TYPE_ICON_TONES: Readonly<Record<FileTypeIconId, FileTypeTone>> = {
  file: 'gray',
  doc: 'green',
  table: 'green',
  ts: 'blue',
  js: 'yellow',
  py: 'blue',
  rs: 'orange',
  go: 'teal',
  css: 'purple',
  html: 'orange',
  code: 'purple',
  terminal: 'teal',
  json: 'orange',
  config: 'red',
  git: 'orange',
  image: 'teal',
  video: 'purple',
  audio: 'purple',
  archive: 'yellow',
  database: 'blue',
  lock: 'yellow'
}

function group(icon: FileTypeIconId, keys: string): Record<string, FileTypeIconId> {
  return Object.fromEntries(keys.split(' ').map((key) => [key, icon]))
}

export const FILE_TYPE_NAME_ICONS: Readonly<Record<string, FileTypeIconId>> = {
  ...group('git', '.gitignore .gitattributes .gitmodules .gitkeep .git-blame-ignore-revs .mailmap commit_editmsg'),
  ...group('file', 'license licence copying notice license.md license.txt licence.md licence.txt copying.md copying.txt'),
  ...group('doc', 'readme changelog authors contributing'),
  ...group('config', 'dockerfile containerfile .dockerignore .editorconfig .npmrc .nvmrc .yarnrc .prettierrc .eslintrc .babelrc .browserslistrc .env'),
  ...group('terminal', 'makefile justfile procfile'),
  ...group('lock', 'yarn.lock pnpm-lock.yaml cargo.lock poetry.lock composer.lock gemfile.lock bun.lockb uv.lock')
}

export const FILE_TYPE_EXTENSION_ICONS: Readonly<Record<string, FileTypeIconId>> = {
  ...group('doc', 'md markdown mdx txt text rst adoc org tex rtf pdf doc docx odt pages epub ppt pptx odp key log'),
  ...group('table', 'csv tsv xls xlsx ods numbers'),
  ...group('ts', 'ts tsx mts cts d.ts'),
  ...group('js', 'js jsx mjs cjs'),
  ...group('py', 'py pyi pyw ipynb'),
  ...group('rs', 'rs'),
  ...group('go', 'go'),
  ...group('css', 'css scss sass less styl'),
  ...group('html', 'html htm xhtml vue svelte astro'),
  ...group('code', 'c h cc cpp cxx hpp hh cs java kt kts swift m mm rb php lua dart scala clj ex exs erl hs ml zig nim r jl pl sql graphql gql proto wasm wat xml xsl'),
  ...group('terminal', 'sh bash zsh fish ps1 psm1 psd1'),
  ...group('json', 'json jsonc json5 jsonl ndjson geojson webmanifest'),
  ...group('config', 'yml yaml toml ini cfg conf properties env editorconfig dockerfile plist'),
  ...group('image', 'png jpg jpeg gif bmp webp svg ico icns avif tif tiff heic psd ai sketch fig'),
  ...group('video', 'mp4 mov webm mkv avi m4v wmv flv'),
  ...group('audio', 'mp3 wav flac ogg oga opus aac m4a wma aiff mid midi'),
  ...group('archive', 'zip tar gz tgz bz2 xz 7z rar zst lz4 jar war apk dmg iso'),
  ...group('database', 'db sqlite sqlite3 duckdb mdb accdb parquet'),
  ...group('lock', 'lock lockb')
}
