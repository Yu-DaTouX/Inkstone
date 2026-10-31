#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_VERSION = 1

const EXIT = { ok: 0, failed: 1, usage: 2, unavailable: 3 }

const RETIRED_GROUPS = {
  hub: '多 Agent 工作台命令（hub.*）已退役：请改用 yan subagent start|list|get|stop 派子代理。'
}

const USAGE = `yan — 砚宿主能力 CLI

用法：
  yan <组> <动作> [选项]

常用：
  yan operations status --id <操作ID>
  yan capabilities search --query-file query.json [--scope available]
  yan capabilities discover --query-text "<英文关键词>" [--repo owner/name]
  yan capabilities acquire --candidate <ID>
  yan skill read --id <技能ID>
  yan mcp list
  yan mcp describe --server <ID> --tool <名称>
  yan mcp call --request-file request.json
  yan tasks apply --request-file task-update.json     兼容入口：会话里有 todos 工具时优先用工具
  yan artifact attach --path <项目内文件> [--description <说明>]
  yan artifact preview --path <项目内 HTML> [--at 1.5,4]   截图自查（视频合成逐时间点截总览图）
  yan artifact export-video --path <项目内 HTML> [--fps 30] [--out <文件.mp4>]   导出 MP4（需要系统 FFmpeg）
  yan artifact export-image --path <项目内 HTML> [--selector <CSS>] [--scale 2] [--out <文件.png>]   导出 PNG（海报、长图）
  yan artifact style --kind <成果类型>                随机抽风格牌，用户没点名风格时开工前用
  yan artifact style --remote list [--query <词>]       远端设计系统清单（按需下载，不随包）
  yan artifact style --remote <id>                      拉取一套设计系统到本机后照它做
  yan image generate --request-file image.json
  yan question ask --request-file question.json      兼容入口：会话里有 question 工具时优先用工具
  yan office read --path <文件.docx|xlsx|pptx|pdf>
  yan file trash --path <文件或目录>     删除改为移到回收站（可恢复）
  yan session move --dir <文件夹> [--reason <原因>]   任务属于别的文件夹时，请用户批准把会话移过去
  yan consent request --capability <能力> --action <操作> [--resource <资源>] [--purpose <用途>]
  yan subagent start --request-file subagent.json
  yan schedule create --request-file schedule.json     新建定时任务（需用户在「定时任务」页确认后才运行）
  yan schedule list | delete --id <ID> | pause --id <ID>
  yan subagent list
  yan subagent get --id <子代理ID>
  yan subagent send --id <子代理ID> --message "追加信息"
  yan subagent stop --id <子代理ID>
  yan browser <动作> [选项]     内置浏览器（yan browser --help 看全部动作）
  yan search query --query-text "关键词"  联网搜索（--recent / --site 限时间和站点，可重复 --query-text 一次查多个）
  yan search fetch --url <网址>           读网页正文；yan search docs --library <库名> --query-text "问题" 查开发文档
  yan search doctor                       搜索后端诊断（未安装也能读）

选项：
  --query-file <文件>      UTF-8 JSON，作为请求参数（推荐，避免 shell 转义）
  --request-file <文件>    同上，用于写操作；写成 - 时从标准输入读（可配合 heredoc）
  --output <文件>          把结果另存一份到指定路径
  --help                   显示本帮助

说明：
  身份（会话 / 项目）由宿主通过环境变量注入，**不需要也不应该手工指定**。
  stdout 只回一段受限摘要；完整结果在 resultFile 指向的文件里，用 read/grep 取需要的片段。
  「tasks apply」的回执里有 operationId：要重试同一次提交时把它一起传回来
  （同一个 operationId 只会生效一次，不会重复添加）。
`

const GROUP_USAGE = {
  capabilities: `yan capabilities <动作> [选项]

动作：
  search  列出 / 检索**已装**能力（砚内置命令 + pi 已加载技能 + 已登记 MCP 服务的工具），返回候选与来源；
          MCP 工具查到后用 yan mcp describe 看参数、yan mcp call 调用。两种写法：
            yan capabilities search --query-text "压缩上下文"
            yan capabilities search --query-file query.json
          query.json: {"queryText":"…","limit":12}
          只覆盖已装范围；缺能力要联网补齐走 discover。
  discover  联网检索**缺失**能力。技能主要来自 GitHub 技能仓库（默认 anthropics/skills，
            Claude Code 同款 SKILL.md 格式，描述是英文，检索词用英文短词），另查 npm 与官方 MCP Registry：
              yan capabilities discover --query-text "pdf form"
              yan capabilities discover --repo owner/name        # 用户点名的仓库：列出其中全部技能
              yan capabilities discover --query-file discover.json
            discover.json: {"queryText":"…","goalText":"…"}
            检索词先脱敏（去掉路径 / 密钥 / 文件名）再外发；返回候选与**每个源是否可用**。
            github: 开头的技能候选固定到提交，接入时逐文件核对 Git 哈希；其他候选只证明发布来源。
            源全挂时如实说「暂时无法搜索」，**不会**编造包名。
  prepare   由候选 ID 生成接入计划（acquire --candidate 会自动做这一步）：
              yan capabilities prepare --candidate "github:anthropics/skills/skills/pdf@…"
            候选由宿主在 discover 后短暂保留（10 分钟），模型只能回传 ID。
  acquire   接入：
              yan capabilities acquire --candidate <候选ID>
              yan capabilities acquire --plan <计划ID>
            技能：下载并做内容审查后，砚在电脑上弹出**限时批准面板**（2 分钟，用户可加时），
            用户选「仅本次会话使用」或「安装到我的技能」；跳过、回复别的话或超时都不安装。
            命令会等到用户选择或超时才返回：
              state=installed  → 立刻 read 返回的 skillFile 按说明继续（scope=session / user）
              state=skipped    → 不要再次请求同一个技能；有 userReply 时按用户的话调整
              state=blocked    → 内容审查发现疑似提示注入，已拒绝
            你不能替用户批准，也不需要先在对话里征求同意。
            新 MCP 服务由 pi 原生管理（/mcp），这里不登记 MCP；砚自己连接的服务（如电脑操作 windows-mcp）用 yan mcp list 查看。

`,
  skill: `yan skill <动作> [选项]

动作：
  read    读取一个已加载技能的正文（按需加载；返回 contentHash，正文变了要重读）。
            yan skill read --id skill:probe-skill
          技能来自 pi 的发现结果，id 形如 skill:<名称>（先用 capabilities search 找）。
  save    保存一个用户技能（用户自己的做法，例如办事模板）：
            yan skill save --request-file skill.json
          skill.json：{ "name": "weekly-report", "description": "什么时候用",
                        "body": "# 标题\\n步骤…", "replace": false }
          name 只能用小写字母、数字和连字符；不能与随包技能重名；已存在时需 replace: true。
          写到砚数据目录的 skills/<name>/SKILL.md，下一次启动会话时加载。
          保存前先把内容给用户看并得到同意（做法见 playbook 技能）。

`,
  mcp: `yan mcp <动作> [选项]

动作：
  list      列出砚连接的 MCP 服务及其工具名（首次会启动服务，电脑操作可能要十几秒）。
              yan mcp list
  describe  看一个已登记 MCP 工具的参数定义（返回 inputSchema 与 schemaRevision）。
              yan mcp describe --server <服务ID> --tool <工具名>
  call      调用一个 MCP 工具：
              yan mcp call --request-file call.json
            call.json: {"serverId":"…","toolName":"…","arguments":{…},
                        "schemaRevision":"<从 describe 拿的>"}
            传了 schemaRevision 且已变化时，回**可重试**的 schema-changed（不会拿旧参数硬调）。
            工具自己失败是 toolError:true 的结果（不是崩溃）；结果过大时会落盘，stdout 只回摘要。
            服务在宿主文件 YAN_DIR/mcp-servers.json 里登记——模型不能新增服务。

`,

  consent: `yan consent <动作> [选项]

动作：
  request  使用一个普通工具前先问宿主能不能用（例如本机发现的生图模型、转换工具）。
           yan consent request --capability image.local --action generate --resource "D:/models/sd" --purpose "给报告配图"
           结果的 allowed 为 true 才继续；decision 是 auto（权限档直接放行）、allow、deny 或 no-answer。
           常规操作直接放行；「自动批准」档对删除 / 覆盖、对外发送、付费、权限与凭证、安装等危险操作询问；你判断有风险时加 --dangerous true。
           「不受限制」档直接放行，包括危险操作；此命令不保证弹出确认框，不能代替用户明确要求的事前询问。
           宿主只记录用户在确认框里的真实答复。
           这不替代权限档位与远程授权的其他检查，也不能把危险操作标成安全。

`,
  office: `yan office <动作> [选项]

动作：
  read    读取 Word / Excel / PPT / PDF 的文字正文（只读，不改文件）。
          yan office read --path 报告.docx
          结果按节给出：Word 按段落、Excel 按工作表与单元格（含公式）、PPT 按页（含备注）、
          PDF 按正文。只有文字，不含版式与图片；路径按当前会话目录解析。

`,
  session: `yan session <动作> [选项]

动作：
  move    请求把这条会话移到另一个文件夹（用户在对话里的批准卡片中确认）。
          yan session move --dir C:\\Users\\me\\Desktop\\my-app --reason "要改的代码在 my-app 仓库"
          批准后**本轮结束时**才切换：对话保留，之后的命令在新文件夹里运行，并读取那里的
          AGENTS.md 与项目设置。所以批准后先简短说明下一步，然后结束本轮，不要在本轮继续改文件。
          用户发现你找错地方、或任务明显属于另一个仓库时用它；只是读几个外部文件不需要移动。

`,
  file: `yan file <动作> [选项]

动作：
  trash   把文件或目录移到系统回收站（用户可以从回收站恢复）。
          yan file trash --path 旧报告.docx
          yan file trash --request-file trash.json    trash.json: {"paths":["a.txt","旧目录"]}
          要让用户能找回时用它；rm / del / Remove-Item 等删除命令不会被自动改成移到回收站。
          路径按当前会话目录解析；系统临时目录里的文件可以直接删除，不必移到回收站。

`,
  tasks: `yan tasks apply --request-file task-update.json

维护会话栏里的待办清单（用户靠它看进度）。任务有 3 个以上独立步骤、会派子 Agent、或用户要计划时，动手前先建；一两步的事直接做。
会话里有 todos 工具时优先用工具，这个命令是兼容入口。
不想写文件时：yan tasks apply --request-file - <<'EOF' ... EOF
建的时候一次写全，之后只在完成一项或计划变化时更新，不要每做一步就更新一次。

task-update.json：
  {"action":"set","items":[{"text":"读现有实现","done":false},{"text":"改写","done":false}]}
  {"action":"add","items":[{"text":"补测试","done":false}]}
  {"action":"complete","index":1}        index 从 1 开始；uncomplete / remove 同样写法
  {"action":"clear"}
回执里有 operationId：重试同一次提交时把它一起传回来，同一个 operationId 只生效一次。
`,
  operations: `yan operations status --id <操作ID>

查看一次操作（之前某条 yan 命令回执里的 operationId）的状态与结果文件。
`,
  artifact: `yan artifact <动作> [选项]

动作：
  attach  将当前项目内已经生成的文件复制进受控 artifact 目录并挂到本轮消息，
          用法：yan artifact attach --path <文件> --description "可选说明"
          同一文件改完再 attach 就是这份成果的新版本（v2、v3…），用户能切换对比；
          修改已有成果时改原文件，不要另起文件名。内容没变的重复 attach 不会新增版本。
  preview 把项目内的 HTML 按砚的沙箱渲染成截图，返回截图路径、控制台错误、溢出和 lint；不挂到消息。
          lint 按 open-design 的反 AI 套路规则静态检查源码（紫色/信任感渐变、默认靛蓝、emoji 图标、
          左边框圆角卡片、编造指标、填充文案、网络资源、全大写无字距、散写色值、强调色过多），
          分 [必须改] 与 [建议改]。
          交付 HTML 前先用它自查。普通网页是浅色/深色 × 桌面/窄屏四张整页拼版；
          视频合成（带 data-composition-id 与 window.__timelines 控制器）改成按合成画幅、
          在每个片段中点和结尾帧逐时间点 seek 后截图，拼成一张带 t=秒 标注的总览图，
          并列出每个时间点超出画框的可见元素。
          用法：yan artifact preview --path <文件.html> [--at 1.5,4]
          --at 用逗号分隔的秒数覆盖默认取样时间点（每片段中点 + 结尾帧，最多 8 个，等分会删减）。
          预览会加载 HTML 同文件夹里相对路径的 .css / .js / 图片 / 字体，网络资源和 fetch 会被拦截；
          attach 只复制 HTML 本身，所以要挂到回复的成果页仍把样式、脚本和图片内联进 HTML。
  export-video
          把 hyperframes 合成（带 data-composition-id 与 window.__timelines 控制器的 HTML）
          逐帧 seek 后录成 MP4，默认输出到 HTML 同目录的同名 .mp4，已存在时加序号，不覆盖。
          用法：yan artifact export-video --path <文件.html> [--fps 30] [--scale 1] [--out <文件.mp4>]
          --out 只能写到当前项目目录里（相对路径按项目目录算），没写 .mp4 后缀时自动补上。
          需要系统里已经装好 FFmpeg（PATH 里的 ffmpeg，或用环境变量 YAN_FFMPEG 指定路径）；
          只录画面，合成里的 <audio>/<video> 不混音；时长上限 10 分钟、帧数上限 18000。
  export-image
          把 HTML 渲染成 PNG（海报、邀请函、长图，发朋友圈或打印用），默认输出到 HTML 同目录的同名 .png，已存在时加序号，不覆盖。
          用法：yan artifact export-image --path <文件.html> [--selector <CSS 选择器>] [--width 1280] [--height 800] [--scale 2] [--out <文件.png>]
          不写 --selector 和尺寸时：页面中央只有一个画面（如固定宽度的海报）就只截它，否则截整页；
          --selector 只截指定元素；--width/--height 指定视口并截整页；--scale 是像素倍数（默认 2，上限 4）。
          --out 只能写到当前项目目录里（相对路径按项目目录算），没写 .png 后缀时自动补上。
  style   随机抽几张风格牌（配色、字体、版式、母题），用户没点名风格时开工前用，
          用法：yan artifact style --kind <poster|dashboard|game|explainer|tool|landing|slides|video> [--count 3] [--theme light|dark]
          最近抽过的牌会尽量避开；取某一张：yan artifact style --id <牌 id 或中文名>；列出全部牌：yan artifact style --list
          当前目录（或用 --cwd <目录> 指定）有 DESIGN.md 时，优先按项目的 DESIGN.md 做、不抽牌；
          确实要换成随包风格牌时加 --ignore-project。
  style --remote list [--query <词>]
          列出远端设计系统（open-design，Apache-2.0，固定提交，不随包分发）：id、名称、类别、一句描述。
          清单缓存在数据目录，不重复联网；--query 按英文关键词过滤。
  style --remote <id>
          按需下载一套设计系统（DESIGN.md 与 tokens.css，附 NOTICE.txt 写明来源与许可）到数据目录，
          返回文件路径；之后读 DESIGN.md 并把 tokens.css 的 :root 变量写进成果。已下载过就直接用。
          用户点名某个设计系统 / 品牌风格、随包风格牌不够用时才用；id 只接受小写字母、数字和连字符。
          砚的预览离线，DESIGN.md 里引用的网络字体和外部链接不会生效，字体换系统字体栈。
`,
  image: `yan image generate [选项]

生成或编辑图片，并在对话中直接显示受控产物：
  yan image generate --prompt "深色圆角方形的砚应用图标"
  请求文件示例：
    {"prompt":"…","provider":"auto|codex|openai|compatible|google|doubao|local",
     "size":"1024x1024","quality":"auto",
     "background":"auto|transparent|opaque","format":"png"}
  编辑已有图片：加 "mode":"edit","sourcePaths":["项目内的图片.png"]（最多 4 张，
  只能是当前项目或砚产物目录里的 PNG/JPEG/WebP）。
  model 一般不填，由所选通道决定默认值（codex / openai 默认 gpt-image-2.5-flare，
  要细节更好、能多等一会时填 gpt-image-2.5-sunburst）。provider=local 用本机或设置里添加的
  SD WebUI 系服务。google / doubao 不填 model 时自动用服务商列表里最新的一档。

ComfyUI 出图与服务管理由插件市场的插件提供，使用插件注册的工具。

provider=auto 依次选：ChatGPT 登录（砚内或 Codex CLI）→ OpenAI 兼容端点 → OpenAI
→ Google Gemini → 火山方舟（豆包 Seedream）→ 本机 SD WebUI。
使用 OpenAI、兼容端点、Google、豆包前砚会弹出确认，拒绝后不会发送请求，也不会静默换供应商。
一条通道都没有时（image_provider_unavailable），把报错里的选项告诉用户并询问；
不要自己下载模型或安装生图软件。
生成结果会自动挂到当前助手消息并在对话中预览；输出的 summary.path 是图片文件的绝对路径，
要缩放、裁切或复制时直接用它。

codemode 脚本里也能生图：models.getAvailableOfType("image") 查可用的生图模型，
models.generateImages() 生成，image() 在结果里展示；生图可能要几分钟，别给脚本设短的 timeout_ms。
需要落成文件或挂到助手消息上时仍用 yan image generate。
`,
  question: `yan question <动作> [选项]

动作：
  ask     在砚的当前会话里向用户提出一个问题；会话里有 question 工具时优先用工具，这个命令是兼容入口。
          yan question ask --request-file question.json
          question.json: {"question":"…","options":["选项 A","选项 B"],"timeout":180000}
          options 为空或省略时显示文本输入；否则最多 3 个，面板另有一行「或自行撰写回复」直接回填。
          一次问清几项时改用 fields（1–5 项，与 options 二选一）：
          {"question":"…","fields":[{"name":"side","label":"你是哪一方？","kind":"choice","options":[{"label":"甲方","description":"…"},"乙方"]},
            {"name":"deadline","label":"什么时候要？","kind":"date"},{"name":"budget","label":"预算（元）","kind":"range","min":0,"max":5000,"step":100}]}
          kind：choice（单选，2–3 项）/ multi（多选，2–6 项）/ text / date / number / range（需 min、max）；optional:true 可不填。
          结果 data.answers 是按 name 的对象，data.answer 是一行摘要。
          完整答案落在 resultFile，stdout 只回摘要；取消 / 超时会如实返回，不猜答案。

`,
  schedule: `yan schedule <动作> [选项]

动作：
  create --request-file schedule.json
         {"name":"每日简报","prompt":"总结昨天的提交","daily":"09:00"}
         触发写法任选其一："daily":"09:00"（每天）/ "weekdays":"09:00"（工作日）/
         "every":60（每隔多少分钟，最小 5）/ "at":"2026-10-15 09:00"（只一次）/
         "trigger":{"kind":"weekly","days":[1,3],"time":"18:30"}（0 = 周日）
         可选："model":"provider/id"、"cwd":"工作文件夹"（默认当前会话目录）
  list   列出全部定时任务与状态
  delete --id <ID>   删除
  pause  --id <ID>   暂停（启用要用户在界面里点）

说明：
  · 到点会新开一条会话，用 prompt 当第一条消息；只在砚运行时触发，错过的 24 小时内补跑一次。
  · create 之后任务是「待确认」：必须由用户在「定时任务」页启用，所以创建后要告诉用户去确认。
  · prompt 要自足：新会话看不到当前对话，把需要的背景写进去。
`,
  subagent: `yan subagent <动作> [选项]

动作（结果都落成 JSON 文件；stdout 只回一段摘要）：
  start --task <任务> [--title <短标题>] [--model <模型>] [--thinking <档位>] [--read-only] [--isolation worktree] [--fork]
       或 --request-file subagent.json
       请求文件示例：{"task":"检查当前项目的测试入口","title":"查测试入口","readOnly":true}
       带上任务输入（并行的子任务建议都带，免得跑偏）：
       {"task":"查一下这两个模块的错误处理","title":"对比错误处理",
        "brief":{"goal":"摸清两个模块的错误处理是否一致",
                  "deliverables":["一段结论","不一致的具体位置"],
                  "sources":["src/main/agent.ts","src/main/index.ts"],
                  "boundary":"只读，不要改代码",
                  "timeoutMinutes":10}}
  list   [--transcript]          stdout 每个子代理一行 id / 状态 / 最新活动；结果文件默认不含转录
  get    --id <子代理ID> [--final] [--transcript]
                               查看状态、最终结论、改动过的文件与审阅状态；stdout 摘要里的结论只取前 400 字，
                               --final 直接把最终结论全文打到 stdout；
                               --transcript 额外附上完整转录（体积大，一般不需要）
  status --id <子代理ID>        get 的别名
  send   --id <子代理ID> --message <信息> [--mode steer|follow-up]
                               向本会话派出的子代理发信息；也可 --request-file send.json
                               运行中：steer（默认）在当前工具结束后送达，用来纠偏或补充资料；
                                       follow-up 等它做完原任务再处理
                               已结束：用它原来的会话续接，它记得之前做过的事（追问不用重派、不用重讲背景）
                               没启动成功、或 worktree 已合并/放弃的，不能续接
  merge  --id <子代理ID>        worktree 子代理的改动由你审阅处置：把补丁应用到当前项目目录；有冲突时报错、工作树保留，可 send 让它继续解决
  discard --id <子代理ID>       放弃 worktree 子代理尚未合并的改动并清理工作树
  stop   --id <子代理ID>        停止一个仍在运行的子代理

说明：
  · title 是界面上显示的 2–8 字短标题，并行派多个时每个都写，互相区分；
  · --model 写完整名称「供应商/模型」（例：commandcode/deepseek/deepseek-v4.1-flash）；只写模型名时按已登录模型匹配，优先当前会话的供应商，仍有歧义会列出候选；
  · --thinking（请求文件 "thinkingLevel"）取 off / minimal / low / medium / high / xhigh；不传时用 pi 对该模型的默认档（pi 设置里的 defaultThinkingLevel），fork 沿用当前会话的档位、不能再传；
  · start 默认在当前目录执行，可能直接改文件；未指定 --model 时优先使用设置中的默认子 Agent 模型，否则跟随当前会话；启用强制模型时由宿主按该设置选模；
    readOnly=true 开放 read/grep/find/ls/git_inspect/web_search/web_fetch/web_docs；只读不代表离线，联网搜索可能使用已配置的付费来源；需要代码隔离时显式传 --isolation worktree（要求 Git）；
  · --fork（请求文件 "fork":true）让子代理继承当前会话的全部历史，沿用当前会话的模型与推理档位，首个请求复用当前会话的提示缓存；
    任务依赖对话里已有的讨论或读过的文件时用 fork，能几句话讲清时用普通子代理；fork 只在当前目录运行，
    不能与 --read-only、--isolation worktree 或其他 --model 同用，当前上下文已用超过 60% 时会被拒绝；
  · 任务要窄（一个文件或一个问题，结论几行说完）；
  · 任务输入里的 goal 决定它做什么，deliverables / sources / boundary 决定它交回什么与不碰什么；
    工具调用次数由执行模型自主决定，旧 maxToolCalls 参数不再生效；全应用最多同时24个子代理。
    默认连续10分钟没有模型输出或工具事件才超时；timeoutMinutes（1–60）可选限总时长，不设置则没有总期限，写在 task 正文中不会设置宿主限额。
    超时先让它收尾交结论，75秒宽限内仍不结束才停止；
  · 派出后不要 sleep 轮询：结束时宿主会通知你（用户关掉通知时才需要自己 list / get）；
    继续做不依赖它的事，或结束本轮并告诉用户「子代理在跑，结束会通知」；
  · 子代理结束后，宿主会汇总「摘要 / 来源 / 成果」给主 agent ——
    摘要取的是它**最后一段话**（会在数据里标名），不是子代理自报的结论；
    「未决问题」不自动猜：那要主 agent 判断，宿主不替它下结论；
  · 启动后对话里以卡组显示子代理进度，用户点开后在右侧工作区查看转录、工具活动、耗时与变更；
  · 子代理的 worktree 变更不会自动合并，合并 / 放弃由用户在 UI 里审阅确认。
`,
  search: `yan search <动作> [选项]

动作：
  query   联网搜索。不写 --sources 时自动挑来源：有付费 key 时只用一个付费来源（中文 DeepSeek → Tavily → Brave，
          其余 Tavily → Brave → DeepSeek，按次计费）加 DuckDuckGo 兜底；付费来源出错才换下一个；
          没有 key 时只用 DuckDuckGo。DeepSeek 余额不足时暂停调用，充值后约 3 分钟内自动恢复。先到的来源已够用时，
          慢的来源会被提前停止（状态 skipped）。维基百科 / arXiv / Hacker News 不默认查，需要时用 --sources 点名。
          结果按各来源排名交错合并，多个来源都搜到的网址排前；10 分钟内同样的查询直接复用（cached）
            yan search query --query-text "flash attention"
            yan search query --query-text "Node.js 最新版本" --recent month
            yan search query --query-text "electron WebContentsView" --site github.com,electronjs.org
            yan search query --query-text "bun 基准" --query-text "deno 基准"     一次最多 5 个查询并行，结果在 data.queries
            yan search query --query-text "…" --sources wikipedia,arxiv --limit-per-source 5 --limit-total 12
          --recent day|week|month|year  尽量筛选这段时间内的结果；维基百科 / arXiv / HN 不支持严格时间过滤，须核对发布日期
          --site a.com,b.org             只搜这些站点（最多 5 个）
          --question "用户原问题"         把用户原话交给 DeepSeek，帮它理解查询
          --with-content                 DeepSeek 结果直接带正文（content，每条最多 3000 字），可省掉一次 fetch
          --language en --country AU     检索语言与地区偏好，与回答语言分开；来源不支持时会明示
          --after YYYY-MM-DD --before YYYY-MM-DD  尽量按发布日期范围筛选，须核对原文日期
          --exclude-sites a.com,b.org    排除这些域名（最多 5 个，返回结果再核对过滤）
          --coverage fast|broad          默认 fast；broad 同时查已配置来源，不按条数提前停止，可能增加费用
          --timeout-ms 20000             每个查询的总时限，来源回退共用；来源状态保留耗时与可取得的用量
  fetch   把一个网页读成正文文本（JS 渲染页也行；不共享用户浏览器登录态，不读本机/内网地址）。本地读不出正文时，
          依次改用用户配了 key 的 Firecrawl、DeepSeek（结果里 via 写明是谁读的）；--via local|firecrawl|deepseek 可强制；
          10 分钟内读过的同一网址直接复用（cached）；自动回退共用总时限（默认 30 秒，--timeout-ms 可设 5000–60000）
            yan search fetch --url https://example.com/post [--max-chars 12000] [--via firecrawl]
          结果带 pageRef、offset、endOffset、nextOffset、fetchedAt、sourceTruncated；续读与查找使用同一份快照（30 分钟有效）
            yan search fetch --page-ref <pageRef> --offset 12000
            yan search fetch --page-ref <pageRef> --action find --find "例外条件"
            yan search fetch --page-ref <pageRef> --action links
          --refresh 与 --url 一起使用会重新抓取；pageRef 固定指向原快照。PDF 读取带页号，扫描 PDF 可能需要 OCR。
  docs    查开发文档：按库名取该库最新版本的文档片段与示例（Context7）。库名有歧义时看结果里的 alternatives，
          用 --library-id 指定
            yan search docs --library react --query-text "useEffect 清理函数"
            yan search docs --library-id /vercel/next.js --query-text "middleware matcher" [--max-chars 12000]
  doctor  列出可点名的内置来源

说明：
  · stdout 只给摘要和 resultFile 路径；用 read 读取结果文件中所需的 items / queries / sources，不能把摘要当完整搜索结果；
  · query / fetch 支持 --refresh 跳过 10 分钟结果缓存；同参数的进行中请求会合并，不重复发起；
  · 结果非空、来源评分高都不等于可信：核对相关性和发布日期，事实结论先读来源原网页；必须来自某些站点时用 --site；
    结果不相关时缩短或换查询 / 来源，要最新信息时加 --refresh；
  · 所有来源都内置，无需安装外部后端；来源取不到时单独报错，不把「取不到」写成「没有结果」；
  · 逐来源状态是分开的：ok / empty / timeout / unavailable / error / skipped（已够用、提前停止）；
  · 网页来源（ddg / brave / tavily / deepseek）的 --sources 可以点名；没配 key 的来源会单独报 api_key_missing；某个来源弹验证或连不上会单独报错，其余照常；
  · 要读结果正文先用 fetch；要登录、点击、交互的页面再用内置浏览器：yan browser navigate --url <结果里的 url>；
  · 这个 search 是「联网找网页」；在已装能力里找工具用 yan capabilities search。
`,
  browser: `yan browser <动作> [选项]

动作（结果都落成 JSON 文件；stdout 只回一段摘要）：
  api                           读取脚本里 page / task 的接口说明
  run --file <路径>             执行 UTF-8 JavaScript 文件（async 函数体），提供 page、task、console、sleep
                                 例如 await page.goto('https://example.com'); return await page.title()
                                 return 的值和 console.log 都会带回；默认 120 秒超时
  navigate --url <地址>          打开 http(s) 页面（about:blank 也可以）
  navigate --file <路径>         打开本地 HTML（相对路径按当前目录；也接受 file:// 地址）：
                                 砚在 127.0.0.1 上临时托管它所在的项目目录，相对链接与样式照常加载
  open     --url <地址>          navigate 的别名（同样支持 --file）
  state                          当前状态：是否打开 / 标签列表 / 活动标签
  observe                        观察当前页面：URL / 标题 / 可交互元素 ref / 可见文本
  network                        最近 80 条请求的 URL / 方法 / 状态 / 资源类型（无请求头、正文或 Cookie）
  wait     [--ref <ref>] [--text <文本>] [--url <子串>] [--timeout <毫秒>]
                                 等条件成立（可叠加，是“且”）；--gone 配 --ref 等元素**消失**。
                                 默认 10000ms，上限 60000；超时回 code=wait_timeout +
                                 最后看到的样子（url / 元素数 / 文本片段）
  click    --ref <ref> [--dialog accept|dismiss]
                                 点击一个元素（ref 来自 observe）；网页弹窗：alert 自动确认，confirm 默认取消，
                                 --dialog accept 才确认；回执 dialogs 写明弹了什么、怎么处理；
                                 window.prompt 不支持：页面拿到 null，回执里记为 unsupported
  type     --ref <ref> --text <文本>
                                 清空后输入；回执 value 是写入后的实际值（日期 / 时间 / 颜色等控件直接写值）
  select   --ref <ref> --value <值>
                                 给下拉框选值（先按 value 匹配，再按可见文案）
  press    --key <键>            Enter / Tab / Escape / ArrowDown / 单个字符，或 Control+A、Shift+Tab 这类组合键
  scroll   --delta-y <像素> [--delta-x <像素>]   回执 scroll 给出滚动后的位置 { x, y, maxY }
  back / forward / reload        历史与刷新
  new-tab  [--url <地址> | --file <路径>]  新标签页
  switch-tab  --id <标签id>      切到某个标签（id 从 state 里取）
  close-tab   [--id <标签id>]    关闭标签（不带 --id 关当前活动标签），回执 closed 是被关的标签 id
  screenshot                     截图（PNG 落盘，摘要里给路径，用 read 看图）；右侧面板收起时也能截
  download [--wait] [--timeout <毫秒>]
                                 最近一次完成的下载；还在下载时回执 pending 列出文件名，--wait 等它下完（默认 30 秒）
  request-user-control [--reason <原因>]
                                 把浏览器交给用户处理密码 / 验证码 / 支付；之后结束本轮，用户发消息即交还
  connect-chrome [--url <地址>]  接入本机已安装的 Chrome（需要登录态时用）
  disconnect-chrome              断开并关闭砚启动的那个 Chrome

说明：
  · 先用 state 看标签与当前状态，操作前用 observe 拿元素 ref，不猜 ref；
  · screenshot 只是落盘截图：要判断外观，得用读取工具真正打开那张图；
  · 关键操作后读回执里的页面观察，必要时再 observe 或截图核对；没确认上次提交的结果前，不要重复提交；
  · 页面是异步渲染时，点完不要立刻 observe（容易读到中间态）：用 wait 等 ref / 文本 / 地址就绪；
  · 原生下拉框展开的选项不是 DOM 元素（observe 看不到）→ 选值用 select，不要先 click 再点选项；
    目标不是下拉框回 code=NOT_SELECT，没有这个可选值回 code=OPTION_NOT_FOUND（并附上可选值）；
  · 每个 click / type / select / press / scroll 的回执都是一次新观察；同一页面上没变的元素 ref 保持不变，
    页面导航或换了文档后 ref 才失效（报 STALE_ELEMENT 时用回执里的 elements[].ref 或重新 observe）；
  · 回执 openedTabs 表示点击打开了新标签（用 switch-tab 切过去），downloadStarted 表示开始下载（完成后用 download 取路径）；
  · 动作超时会回 code=browser_action_timeout：结果未确认，先 observe / state 核对，不要直接重放；
  · 浏览器还没打开时，除 navigate / open / run 外的动作回 code=browser_not_open；
  · type --text "" 清空输入框；
  · 多步操作或批量提取用 run --file；先用 api 查看 page / task 接口。
`
}

function fail(code, message, extra) {
  process.stderr.write(JSON.stringify({ ok: false, error: message, ...(extra ?? {}) }) + '\n')
  process.exit(code)
}

const GROUP_SPECS = {
  capabilities: {
    actions: ['search', 'discover', 'prepare', 'acquire'],
    required: { prepare: ['candidate'] }
  },

  skill: {
    actions: ['read', 'save'],
    required: {
      read: ['id']
    }
  },

  mcp: {
    actions: ['list', 'describe', 'call'],
    required: {
      describe: ['server', 'tool']
    }
  },

  schedule: {
    actions: ['create', 'list', 'delete', 'pause'],
    required: { create: ['prompt'], delete: ['id'], pause: ['id'] }
  },
  subagent: {
    actions: ['start', 'list', 'get', 'status', 'send', 'merge', 'discard', 'stop'],
    required: {
      start: ['task'],
      get: ['id'],
      status: ['id'],
      send: ['id', 'message'],
      merge: ['id'],
      discard: ['id'],
      stop: ['id']
    }
  },
  artifact: {
    actions: ['attach', 'preview', 'export-video', 'export-image', 'style'],
    required: { attach: ['path'], preview: ['path'], 'export-video': ['path'], 'export-image': ['path'] }
  },
  image: {
    actions: ['generate', 'local'],
    required: { generate: ['prompt'] }
  },
  question: {
    actions: ['ask'],
    required: {}
  },
  consent: {
    actions: ['request'],
    required: { request: ['capability', 'action'] }
  },
  office: {
    actions: ['read'],
    required: { read: ['path'] }
  },
  file: {
    actions: ['trash'],
    required: {}
  },
  session: {
    actions: ['move'],
    required: { move: ['dir'] }
  },
  search: {
    actions: ['query', 'fetch', 'docs', 'doctor'],
    required: { query: ['query-text'], docs: ['query-text'] }
  },
  browser: {
    actions: [
      'api',
      'run',
      'navigate',
      'open',
      'state',
      'observe',
      'network',
      'wait',
      'click',
      'type',
      'select',
      'press',
      'scroll',
      'back',
      'forward',
      'reload',
      'new-tab',
      'switch-tab',
      'close-tab',
      'screenshot',
      'download',
      'request-user-control',
      'connect-chrome',
      'disconnect-chrome'
    ],
    required: {
      click: ['ref'],
      type: ['ref', 'text'],
      press: ['key'],
      scroll: ['delta-y'],
      'switch-tab': ['id'],
      run: ['file']
    }
  }
}

const REPEATABLE_FLAGS = new Set(['query-text'])

function parseArgs(argv) {
  const flags = {}
  const positional = []
  const setFlag = (name, value) => {
    const prev = flags[name]
    if (REPEATABLE_FLAGS.has(name) && typeof value === 'string' && prev !== undefined && prev !== true) {
      flags[name] = [...(Array.isArray(prev) ? prev : [prev]), value]
    } else flags[name] = value
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') flags.help = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) setFlag(a.slice(2, eq), a.slice(eq + 1))
      else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          setFlag(a.slice(2), next)
          i++
        } else setFlag(a.slice(2), true)
      }
    } else positional.push(a)
  }
  return { flags, positional }
}

function readJsonFile(path, label) {
  let text
  try {
    text = readFileSync(['-', '/dev/stdin', '/proc/self/fd/0'].includes(path) ? 0 : path, 'utf8')
  } catch (err) {
    fail(EXIT.usage, `${label} 读不到：${path}`, { detail: String(err?.message ?? err) })
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    fail(EXIT.usage, `${label} 不是合法 JSON：${path}`, { detail: String(err?.message ?? err) })
  }
}

const { flags, positional } = parseArgs(process.argv.slice(2))

if (positional[0] && RETIRED_GROUPS[positional[0]]) {
  fail(EXIT.usage, RETIRED_GROUPS[positional[0]], {
    detail: '普通会话请改用 yan subagent start|list|get|stop；用 yan --help 看当前可用命令'
  })
}

if (flags.help || positional.length === 0) {
  if (flags.help && positional.length >= 1 && GROUP_USAGE[positional[0]]) {
    process.stdout.write(GROUP_USAGE[positional[0]])
    process.exit(EXIT.ok)
  }
  process.stdout.write(USAGE)
  process.exit(positional.length === 0 && !flags.help ? EXIT.usage : EXIT.ok)
}

if (positional.length < 2) {
  fail(EXIT.usage, '命令要写成「组 动作」两段，例如 capabilities search。用 --help 看全部。')
}

const groupSpec = GROUP_SPECS[positional[0]]
if (groupSpec && !groupSpec.actions.includes(positional[1])) {
  fail(EXIT.usage, `未知的 ${positional[0]} 子命令：${positional[1]}`, {
    detail: `可用：${groupSpec.actions.join(' / ')}（或 yan ${positional[0]} --help）`
  })
}

let command
if (positional[0] === 'image' && positional[1] === 'local') {
  const action = positional[2] ?? 'status'
  if (!['status', 'start', 'stop'].includes(action)) {
    fail(EXIT.usage, '用法：yan image local status | start | stop')
  }
  command = `image.local.${action}`
} else {
  command = `${positional[0]}.${positional[1]}`
}
if (command === 'artifact.export-video') command = 'artifact.exportVideo'
if (command === 'artifact.export-image') command = 'artifact.exportImage'
if (command === 'subagent.status') command = 'subagent.get'

const flagParams = {}
for (const [k, v] of Object.entries(flags)) {
  if (['output', 'help', 'query-file', 'request-file'].includes(k)) continue
  flagParams[k] = v
}
let params = { ...flagParams }
if (typeof flags['query-file'] === 'string') params = { ...params, ...readJsonFile(flags['query-file'], '参数文件') }
else if (typeof flags['request-file'] === 'string') params = { ...params, ...readJsonFile(flags['request-file'], '请求文件') }

if (params.readOnly === undefined && params['read-only'] !== undefined) {
  params.readOnly = params['read-only']
}

if (positional[0] === 'browser' && positional[1] === 'run' && typeof params.file === 'string' && params.file.trim()) {
  params.file = resolvePath(process.cwd(), params.file.trim())
}

if (positional[0] === 'browser' && ['navigate', 'open', 'new-tab'].includes(positional[1])) {
  const rawUrl = typeof params.url === 'string' ? params.url.trim() : ''
  let localPath = typeof params.file === 'string' && params.file.trim() ? params.file.trim() : ''
  if (!localPath && /^file:/i.test(rawUrl)) {
    try {
      localPath = fileURLToPath(rawUrl)
    } catch (err) {
      fail(EXIT.usage, `file:// 地址无法解析：${rawUrl}`, { detail: String(err?.message ?? err) })
    }
  }
  if (localPath) {
    if (process.platform === 'win32') localPath = localPath.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:')
    params.file = resolvePath(process.cwd(), localPath)
    delete params.url
  } else if (positional[1] !== 'new-tab' && !rawUrl) {
    fail(EXIT.usage, `browser ${positional[1]} 缺少参数：--url <地址> 或 --file <本地路径>`, { detail: '用 yan browser --help 看用法' })
  }
}

if (groupSpec?.required?.[positional[1]]) {
  const missing = groupSpec.required[positional[1]].filter((key) => {
    const value = params[key]
    if (command === 'browser.type' && key === 'text' && value === '') return false
    return value === undefined || value === '' || value === true
  })
  if (missing.length) {
    fail(
      EXIT.usage,
      `${positional[0]} ${positional[1]} 缺少参数：${missing.map((k) => `--${k}`).join(' ')}`,
      { detail: `用 yan ${positional[0]} --help 看用法` }
    )
  }
}

if (command === 'artifact.style') {
  const { runArtifactStyle } = await import('./artifact-style.mjs')
  let result
  try {
    result = await runArtifactStyle(flags)
  } catch (err) {
    result = { ok: false, error: err?.code ?? 'style_failed', message: String(err?.message ?? err) }
  }
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? EXIT.ok : EXIT.failed)
}

const url = process.env.YAN_CLI_URL
const token = process.env.YAN_CLI_TOKEN
const sessionId = process.env.YAN_SESSION_ID
const projectId = process.env.YAN_PROJECT_ID

if (!url || !token || !sessionId || !projectId) {
  fail(EXIT.unavailable, '宿主能力服务不可用', {
    detail:
      '缺少 YAN_CLI_URL / YAN_CLI_TOKEN / YAN_SESSION_ID / YAN_PROJECT_ID。' +
      '这通常意味着 yan 不是在砚启动的会话里运行的。'
  })
}

function post(target, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

let response
try {
  response = await post(
    url,
    { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    JSON.stringify({ apiVersion: API_VERSION, command, params, sessionId, projectId })
  )
} catch (err) {
  fail(EXIT.unavailable, '连不上宿主能力服务', { detail: String(err?.message ?? err) })
}

const text = response.text
let payload
try {
  payload = JSON.parse(text)
} catch {
  fail(EXIT.failed, `宿主返回了非 JSON 响应（HTTP ${response.status}）`, {
    detail: text.slice(0, 300)
  })
}

if (payload?.ok && typeof flags.output === 'string' && typeof payload.resultFile === 'string') {
  try {
    const { copyFileSync, constants } = await import('node:fs')
    copyFileSync(payload.resultFile, flags.output, constants.COPYFILE_EXCL)
    payload.copiedTo = flags.output
  } catch (err) {
    payload.copyError = String(err?.message ?? err)
  }
}

if (payload?.ok && command === 'subagent.get' && flags.final === true && typeof payload.resultFile === 'string') {
  try {
    const { readFileSync } = await import('node:fs')
    const final = JSON.parse(readFileSync(payload.resultFile, 'utf8'))?.finalMessage
    if (typeof final === 'string') {
      process.stdout.write(final.endsWith('\n') ? final : `${final}\n`)
      process.exit(EXIT.ok)
    }
  } catch {
  }
}

process.stdout.write(JSON.stringify(payload) + '\n')
process.exit(payload?.ok ? EXIT.ok : EXIT.failed)
