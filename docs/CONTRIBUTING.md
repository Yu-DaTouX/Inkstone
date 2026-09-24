# 参与 Inkstone 开发

[文档索引](README.md) · [项目主页](../README.md)

## 环境与启动

准备 Windows、Git、Node.js（建议 24）和 npm。具体依赖与命令以 [package.json](../package.json) 为准。

```powershell
git clone https://github.com/Yu-DaTouX/Inkstone.git
cd Inkstone
npm install -g @earendil-works/pi-coding-agent
npm run launch
```

启动器检查依赖与内置运行时，并按需构建。开发模式用 `npm run launch:dev`；已有工作区可使用根目录的两个启动脚本。

## 修改前

阅读 [架构简介](ARCHITECTURE.md)、[代码导览](PROJECT.md) 与 [AGENTS.md](../AGENTS.md)。检查工作区已有改动，只提交当前任务相关内容。提案与历史记录不代表执行授权。

## 常用检查

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | TypeScript、CSS 布局与样式层约定 |
| `npm run build` | 构建当前源码 |
| `npm run test:unit` | 单元检查，依赖当前构建 |
| `npm run test:live -- <场景>` | Electron 场景检查，不自动构建 |
| `npm run audit:refs` | 引用一致性审计 |
| `npm run check:css-docs` | CSS 生成清单一致性 |
| `npm run icons` | 从维护用原型生成图标模块 |

按改动范围选择检查。live 场景配置见 `scripts/test-live.mjs`；涉及远程模型的场景可能产生费用，运行前确认 provider、模型和授权。测试使用独立数据目录，禁止复用真实用户凭证、会话或发布目录中的用户数据。

视觉改动同时关注深浅主题、窄窗口、缩放、键盘操作与实际截图。生成截图保留在本地，不批量提交到仓库；主页配图单独维护。

## 提交与反馈

Issue 应包含版本、复现步骤及必要截图；移除密钥、私人对话和个人路径。提交说明应写清修改原因、检查范围和剩余限制。构建成功、模拟数据和真实运行是不同的证据，不互相替代。

新增公开文档应有稳定用途，并从 [文档索引](README.md) 可达。内部计划、验收流水与一次性报告保存在本地忽略目录。发布步骤见 [Windows 打包与数据](dev/RELEASING.md)。
