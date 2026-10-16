# 设置 → 模型与服务（S1，v3）

v3 设置里「模型与服务」分区。把 v2「接入」页（`components/settings/AuthTab.tsx` +
`components/ModelCatalog.tsx`）的两件事重做成 v3 页面：**服务凭证**与**模型目录**。

## 文件

| 文件 | 职责 |
| --- | --- |
| `ModelsSettings.tsx` | 页面组件，导出 `ModelsSettings(): ReactElement`（无 props） |
| `CustomEndpointSettings.tsx` | 自定义端点卡片：复用 v2 `CustomProviderForm` 的 `window.yan` 接口与校验，v3 版面 |
| `index.ts` | 只重导出 `ModelsSettings`，供设置根懒加载 |
| `models-model.ts` | 纯逻辑：服务状态、凭证门禁、目录过滤 / 排序 / 收藏、思考档位展示、模型选择器分组 / 价格 / 最近使用 |
| `models-text.ts` | 本页新增的 v3 短文案（不加进共享 i18n） |
| `models-settings.css` | 版面（`@layer features`），颜色 / 间距只取 `design/tokens.css` |

## 权威边界

- **服务是否可用**只看主进程 `authProviders`（`credentials.ts` 读 `auth.json` +
  环境变量）。`lastMainModel` / `modelFavorites` 是偏好，**不当作已登录**。
- **模型能力**来自 pi 的模型目录（`ModelInfo`）；**思考档位**来自当前会话的
  `get_available_thinking_levels`（store `thinkingLevels` + `session.thinkingLevelsStatus`），
  不按模型名硬编码「支持思考」。`unknown` 与 `unsupported` 分别显示。
- 服务商没有应用内登录模块（`inAppLogin !== true`）时，显示真实入口 `pi → /login`，
  不做假成功的登录按钮。

## 接的真实接口

读（打开页面即本地读取，不联网）：

- `window.yan.authProviders(false)`（经 store `loadAuthProviders`）、`authFileInfo()`
- store：`models` / `thinkingLevels` / `authProviders` / `session` / `settings`

写（**只在用户点击后**，代理不实际执行）：

- `setApiKey(provider, key)`、`clearAuth(id)`（先弹确认）
- `codexLogin()` / `codexLoginCancel()`（openai-codex）
- `oauthLogin(provider)` / `oauthLoginAnswer()` / `oauthLoginCancel()` + `onOAuthEvent`
- `store.setModel(provider, id)`（前后核对运行实例 / 会话 id，视图切走时不冒充成功）
- `store.patchSettings({ modelFavorites })`
- 「重新检测」`authProviders(true)`（用户点击才深查，不自动探测）

自定义端点（`CustomEndpointSettings.tsx`，02 §10.4）复用 v2 的既有接口：
`customProviders()` / `saveCustomProvider()` / `removeCustomProvider()`（先弹确认）/
`discoverCustomModels()` / `detectLocalModels()` / `testCustomProvider()`。密钥只去不回，
列表只显示「已设置 / 未设置」，输入框不回显已存密钥；获取列表 / 检测本机 / 测试连接
都是用户点击后才联网。

## 未做（明确不谎称）

- 自定义端点的「额外探测地址」与「下载本地模型工具」未迁移；不做自动探测 / 安装。
- ChatGPT 多账号管理（添加账号 / 额度磁贴）未迁移。
- 模型选择器的价格提示依赖模型自带的 `cost`；当前 `ModelInfo` 不带该字段，所以界面
  只在模型自带报价时显示，否则不显示 —— 要让它对全部模型生效需在 `ModelInfo` 归一化时
  补 `cost`（见交付说明）。
- 没有真实窗口截图与发行包验收；本目录只跑了纯逻辑单测与 TS 检查。

## 检查

```
node scripts/test-v3-model-settings.mjs
```
