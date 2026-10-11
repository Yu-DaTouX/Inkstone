# 旧记忆文件与外部工具互通（兼容参考）

> 当前默认界面已撤下「项目知识 / 个人记忆」页面，默认随包技能也不加载 `memory`。本文保留旧数据和兼容接口的格式说明，不是现行设置页操作指南；不要仅向收件箱写文件就期待自动确认或生效。当前产品范围见[产品方向](PRODUCT_DIRECTION.md)。

既有记忆存储分两个范围：

| 范围 | 放什么 | 存放位置（数据目录下） |
| --- | --- | --- |
| 项目知识 | 某个项目的约定、架构决定、方法与任务背景 | `project-knowledge/<项目 ID>/` |
| 个人记忆 | 跨项目的偏好、长期习惯、你确认过的个人规则 | `personal-memory/personal/` |

模型或外部工具在兼容接口中只能提交**候选**，确认与修改仍受用户操作和版本校验约束；接口保留不等于存在可用页面。只有已确认条目进入导出。砚不再在回答前自动检索并注入这些资料；已有导出文件可由用户主动发送或由 Agent 读取。

数据目录默认是 `~/.pi/agent/yan`（便携版在程序旁的「砚数据/yan」里，开发与测试可用 `YAN_DATA_DIR` 指定）。

## 查询：读取导出文件

兼容知识 IPC 的列表查询与条目操作会刷新 `memory-export/`；当前无对应设置页入口。既有导出文件包括：

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

保留的 `yan:knowledge:list` IPC 会触发收件箱读取，但当前设置页面不再调用它，不承诺自动消费。该兼容路径将候选登记为待确认、可信度记为推断；已处理文件及结果放入 `memory-inbox/processed/`，`<文件名>.result.json` 写明是否接收及原因。文件被接收不等于被用户确认。

## 边界

- 外部工具提交的一律是候选。工具自报的「用户已同意」不会被采信，也不会提高自动调用权重。
- 同一段文字（按规范化后的指纹比较）已存在、或曾被删除时会被拒收；多个工具转述同一来源不算独立证据。
- 这里只是文件约定，暂不提供网络接口。Inkstone 不宣称已兼容所有 AI 工具，接入某个工具时由它自己读取导出文件、写入收件箱。
