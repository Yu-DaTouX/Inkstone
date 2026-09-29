# 长期记忆与其他 AI 工具互通

Inkstone 的长期记忆分两个范围，分开存放、分开确认：

| 范围 | 放什么 | 存放位置（数据目录下） |
| --- | --- | --- |
| 项目知识 | 某个项目的约定、架构决定、方法与任务背景 | `project-knowledge/<项目 ID>/` |
| 个人记忆 | 跨项目的偏好、长期习惯、你确认过的个人规则 | `personal-memory/personal/` |

砚里的模型按随包的 `memory` 技能，在任务收尾、读完说明项目约定的文档或你说出一条长期规则时，检查一次有没有值得记下的内容，并提交候选。

两者使用同一套规则：模型或外部工具只能提交**候选**，由你在「设置 → 上下文与记忆 → 项目知识」里切换范围后确认、修改、替代或删除。只有已确认的条目会被导出；打开「项目知识」开关后，它们还会在回答前按当前问题检索并作为参考材料。

数据目录默认是 `~/.pi/agent/yan`（便携版在程序旁的「砚数据/yan」里，开发与测试可用 `YAN_DATA_DIR` 指定）。

## 查询：读取导出文件

在设置页打开某个范围的列表、或确认 / 修改 / 删除条目后，该范围已确认的条目会写到 `memory-export/`：

- `personal.md` / `personal.json`：个人记忆；
- `project-<项目 ID>.md` / `.json`：对应项目的知识。

Markdown 适合直接放进其他工具的上下文（例如在其说明文件里引用路径）；JSON 带 `id`、`revision`、`kind`、`confidenceClass`、来源证据与时间，适合程序读取。导出文件由 Inkstone 维护，直接改它不会写回记忆库。

## 写回：向收件箱提交候选

把一个 UTF-8 JSON 文件放进 `memory-inbox/`（文件名自定，以 `.json` 结尾，单个文件不超过 256KB）：

```json
{
  "version": 1,
  "tool": "my-agent",
  "candidates": [
    {
      "scope": "personal",
      "kind": "fact",
      "text": "回复默认使用中文，代码与命令保持原样。",
      "tags": ["语言"],
      "source": { "ref": "会话 2026-09-28", "excerpt": "用户：始终用中文对话" }
    },
    {
      "scope": "project",
      "project": "C:\\Users\\me\\code\\app",
      "kind": "decision",
      "text": "移动端使用 React Native + TypeScript。",
      "source": { "ref": "docs/TECH_STACK_OPTIONS.md" }
    }
  ]
}
```

- `tool`：提交方名称，1–40 位字母、数字、`.`、`_`、`-`，会成为标签 `external:<tool>`。
- `scope`：`personal`（缺省）或 `project`。项目范围必须用 `project` 给出 Inkstone 里**已登记项目**的目录，写法与登记完全一致。
- `kind`：`fact`、`decision`、`constraint`、`procedure` 之一，缺省 `fact`。
- `source`：出处与原文摘录，合并后最多保留约 480 字，用于确认时判断。
- 一个文件最多处理 20 条候选。

打开「设置 → 上下文与记忆 → 项目知识」时，Inkstone 会读取收件箱：每条候选登记为待确认、可信度记为推断；处理过的文件连同结果移到 `memory-inbox/processed/`，结果文件 `<文件名>.result.json` 写明每条是否接收以及原因。

## 边界

- 外部工具提交的一律是候选。工具自报的「用户已同意」不会被采信，也不会提高自动调用权重。
- 同一段文字（按规范化后的指纹比较）已存在、或曾被删除时会被拒收；多个工具转述同一来源不算独立证据。
- 这里只是文件约定，暂不提供网络接口。Inkstone 不宣称已兼容所有 AI 工具，接入某个工具时由它自己读取导出文件、写入收件箱。
