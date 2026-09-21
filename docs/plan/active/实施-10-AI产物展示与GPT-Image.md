# 实施-10 · AI 文件产物展示与 GPT Image

> 2026-09-21 建立。本文记录砚内的生图与文件产物展示契约；Android 客户端不在本片范围内。

## 目标

让模型生成的 SVG、PNG、代码文件和其它文件成为当前助手消息的一部分，而不是只在正文里吐一个路径：

1. 主进程接收模型请求并把文件复制到按会话隔离的受控 artifact 目录；空响应和 0 字节文件在进入界面前拒绝。
2. assistant 消息携带 artifact 元数据，重启后由 manifest 恢复。
3. 渲染端对图片直接预览、对代码展示片段，并提供下载、定位和复制路径；生图期间显示一条类似 Codex 的阶段 / 用时 / 进度条目，失败时保留可读错误。
4. 生图默认优先使用当前 ChatGPT/Codex 登录态的订阅通道。
5. 任何 OpenAI 或 OpenAI-compatible API 请求必须先弹出可见确认；取消时不发网络请求、不自动降级。

## 模型如何调用

模型通过随包 `yan` CLI 使用，不新增 pi 模型工具：

```text
写 image.json：
{"prompt":"深色圆角方形的砚应用图标","size":"1024x1024","quality":"auto","format":"png"}

调用：yan image generate --request-file image.json
```

成功后宿主会把结果复制到受控目录并挂到当前 assistant 消息，界面会显示图片卡片；模型只需要把结果摘要告诉用户，不必把 base64 或整个文件读回上下文。

已有项目内文件使用：

```text
yan artifact attach --path build/icon.svg --description "砚应用图标"
```

路径必须是当前项目内普通文件，宿主会拒绝项目外路径、目录、符号链接解析后的越界路径和超过大小上限的文件。SVG 在进入预览前会移除脚本、foreignObject、事件属性及外部 href。

## Provider 顺序与确认

`provider=auto` 的顺序是：

1. 当前 `~/.codex/auth.json` 有效时走 Codex/ChatGPT 图像通道；
2. 配置了 `YAN_IMAGE_API_BASE` 与 `YAN_IMAGE_API_KEY` 时才考虑 compatible；
3. 配置了 `OPENAI_API_KEY` 时才考虑 OpenAI API；
4. 都不可用则明确返回不可用，不静默使用 mock。

显式选择 `openai` 或 `compatible` 仍必须弹出确认。确认内容包括供应商、端点、模型、项目 cwd 和 prompt，并提醒 prompt / 参考数据可能离开本机且可能产生 API 费用。取消错误码为 `external_api_denied`，确认回调发生在 `fetch` 之前。

## 生图进度与失败语义

进度条挂在当前 assistant 回合上，阶段依次为「已排队 / 准备请求 / 等待确认 / 请求模型 / 生成中 / 保存文件 / 已完成」。服务端没有真实百分比时使用不确定进度动画，不伪造百分比；条目会持续显示已用时。失败会进入「失败」态并留下原因，网络响应为空、base64 解码为空、保存后字节数为 0 的结果都按失败处理。

`artifact.attach` 同样拒绝 0 字节文件；历史 manifest 恢复时会跳过丢失、不可读或空文件，所以旧的空附件不会再渲染成破损图片卡。

## 当前实现与验收

| 六栏 | 口径 |
|---|---|
| 实现 | `src/main/artifacts.ts`、`src/main/image-generation.ts`、`src/main/agent.ts`、`src/shared/turns.ts`、`yan` CLI、主进程 artifact push、assistant 历史恢复、renderer artifact card 与生图进度条。右侧文件预览改为显式 grid 行，左侧模式开关和图片 / 代码预览均有紧凑限高。 |
| 自动检查 | `npm run typecheck`、`npm run build`、`npm run test:unit` 均通过；单测 **4160/4160**。新增覆盖 mock 生图阶段更新、同一进度 id 的终态替换、空文件拒绝和空历史附件过滤；既有覆盖 manifest 恢复、SVG 清理、项目路径边界、provider 选择，以及“兼容 API 被拒后 `fetch` 不调用”。 |
| 真实运行 | 当前构建已实际走 Codex OAuth 图像通道，返回 `provider=codex`、`model=gpt-image-2` 的 PNG，完成受控目录落盘和 assistant artifact push；不记录 token。Codex Responses 图像工具要求 `store=false`，已按服务端实际错误修正并复验。 |
| 视觉验收 | 已有产物卡视觉证据：`docs/design/preview/matrix-artifact-1440x900-100-dark-2026-09-21-artifact.png`。本轮 CSS 已将图片限制到 240px、代码区域限制到 220px，并新增进度条视觉状态脚本；本次隔离视觉矩阵因 Electron 无进一步输出而中止，不能把新截图验收误报为已完成。 |
| 应用与包 | `启动-砚.cmd` 强制构建启动通过；`npm run dist:dir` / `npm run test:packaged` 通过。打包态确认内置 pi、CLI、能力设置页和用户数据隔离；artifact 根目录绑定 `YAN_DIR/artifacts`，不写安装目录。 |
| 剩余限制 | OpenAI-compatible 编辑模式尚未接入参考图上传；PDF 当前作为文件产物而非内嵌 PDF 阅读器；真实 Codex 图像通道依赖登录态与套餐额度，第三方服务错误会如实显示；本轮新 UI 仍需在视觉矩阵恢复后补一张最终截图。 |
