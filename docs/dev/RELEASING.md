# Windows 打包与数据

命令以 [package.json](../../package.json) 为准，产物配置见 [electron-builder.yml](../../electron-builder.yml)。发布内容以对应版本的 Release 说明为准。

## 产物

| 命令 | 产物 / 用途 |
|---|---|
| `npm run dist:dir` | 构建并生成 `release/win-unpacked/` |
| `npm run test:packaged` | 验已有目录包：包内 pi、**`yan` 能力入口（启动器 + CLI 真跑）** 与扩展 |
| `npm run dist:check` | 生成目录包并验收 |
| `npm run dist` | Windows 安装包 `*-setup.exe`、单文件 `*-portable.exe` 与快速免安装 ZIP |
| `npm run dist:portable-fast` | 快速免安装 `*-portable-fast.zip` |

单文件版每次启动会自解压；ZIP 版解压一次后运行 `砚.exe`。Windows 包内包含 pi runtime、随包 `yan` CLI 和自有扩展，最终用户无需安装 pi。

`extraResources` 里 `resources/yan-cli` 这一条**不能少**：模型在 bash 里敲的 `yan`
由主进程写成启动器（`YAN_DIR/bin/yan.cmd`）并前置到 pi 子进程的 PATH，
而启动器指向的脚本本体就在安装目录的 `resources/yan-cli/yan.mjs`。
少了它，开发态一切照旧、装出来的应用里模型只会得到「不是内部或外部命令」——
`npm run test:packaged` 现在会分别验「文件在不在」「启动器指向哪里」「CLI 真的能跑」。

## 自动更新

安装版在“设置 → 关于”检查 GitHub 最新发布，默认启动时检查。发现更新后由用户选择下载，下载完成后确认重启安装；有任务运行时拒绝安装。开发态与便携版提供发布页入口。更新偏好保存于应用用户目录，不随会话切换。

NSIS 自动更新需要将同一次构建的 `latest.yml`、安装程序及对应 `.blockmap` 一起上传到 GitHub Release。仅上传 EXE 或 ZIP 不足以启用自动安装。`electron-builder.yml` 配置了 GitHub 更新源；打包脚本显式 `--publish never`，不会自动创建或上传 Release。发布仍须单独授权。

上传时附件改用 ASCII 文件名（`Inkstone-<版本>-win-1-setup.exe`、`-win-2-portable.exe`、`-win-3-portable-fast.zip`，沿用历次 Release），`latest.yml` 的 `url` 与 `path` 必须同步改成上传后的安装包名：electron-builder 生成的 `latest.yml` 写的是按包名生成的 `yan-desktop-setup-<版本>.exe`，不改的话应用内下载会 404。只改文件名，`sha512` 与 `size` 保持本次构建的值；`.blockmap` 与安装包同名再加 `.blockmap`。应用先查 GitHub 的 `releases/latest`，所以 Release 必须正式发布（不是草稿或预发布），附件里还要有 `latest.yml`，否则安装版只会给出发布页入口。

上传可以用 `gh release create v<版本> --verify-tag --latest --title "Inkstone <版本>" --notes-file RELEASE-NOTES.md <附件…>`：带附件时 gh 先建草稿，全部附件传完才发布，应用内更新不会读到附件不全的版本。发布后核对 `releases/latest`、线上 `latest.yml` 与本地是否逐字一致，以及安装包与 `.blockmap` 的下载地址和大小。

## Android 手机端

手机端（`mobile/`）有自己的版本号（`mobile/package.json`，当前 0.1.0），和桌面版本分开。桌面构建不会编译这个目录，发布桌面版时按需单独打包手机端：

```powershell
cd mobile
npm install        # 首次或依赖变化后
npm run typecheck
npm run build:apk  # 构建并整理到 release/apk-<版本>-<提交>/，附 SHA256.txt
```

`build:apk` 直接调用 Gradle，Android SDK 取 `ANDROID_HOME` 或 `mobile/android/local.properties` 的 `sdk.dir`。

**签名**：正式签名密钥和密码放在仓库之外，默认 `~/.inkstone-signing/`（`inkstone-release.jks` 与 `keystore.properties`，或用环境变量 `INKSTONE_SIGNING` 指向别处的 properties 文件）。存在时 Gradle 用它签名，产物文件名为 `Inkstone-mobile-<版本>.apk`，证书 DN 为 `CN=Inkstone, O=Yu-DaTouX`，SHA-256 指纹 `4D:95:19:9D:2F:E4:16:34:A7:FA:FF:23:3C:E4:2F:DA:6F:72:9E:CF:3A:35:79:34:AE:75:F7:63:80:F4:A4:B6`；不存在时退回仓库里的调试密钥，文件名带 `-debug-signed`，只供本机验证，**不能公开发布**。**这个密钥丢了，已安装的用户就无法再收到可覆盖安装的更新**：请把 `~/.inkstone-signing/` 整个目录备份到安全位置，不要提交、不要上传。用不同密钥签名的包不能互相覆盖，从调试版换成正式版要先卸载（会丢掉手机上的配对，需要重新配对）。验证签名：`apksigner verify --print-certs <apk>`（在 SDK 的 `build-tools/<版本>/` 下）。手机端与桌面端的协议兼容性以 `src/shared/remote-protocol.ts` 为准；修改手机端终端页面要改 `mobile/scripts/sync-terminal.mjs`（`assets/inkstone-terminal/` 是生成物）。

## 数据位置与备份

以下是未设置 YAN_* 覆盖变量时的默认行为，依据 [paths.ts](../../src/main/paths.ts)。

| 形态 | pi 凭证 / 会话 | 桌面端设置 | Electron 数据 |
|---|---|---|---|
| 单文件 portable.exe | EXE 旁 `砚数据/pi-agent/` | `砚数据/yan/` | `砚数据/electron/` |
| ZIP / 安装版 / 开发态 | `~/.pi/agent/` | `~/.pi/agent/yan/` | Electron 的 userData 目录 |

单文件版由包装器设置 `PORTABLE_EXECUTABLE_DIR`；ZIP 没有该包装器，默认数据随本机用户目录保存。

- 单文件版迁移时连同自己的 `砚数据/` 备份；里面包含凭证、会话和浏览器状态，不能作为公开产物。
- 工作区 `release/砚数据/` 是真实用户数据，**只读**；升级验证只用备份副本。
- Yan 会保存自身设置、管理会话，并在模型接入时写入对应凭证；不要再宣称应用绝不写 pi 用户目录。

## 发布检查

1. 按 [贡献指南](../CONTRIBUTING.md) 检查最终源码，记录实际运行与视觉结果。
2. 用 `npm run vendor:pi:check` 核对内置运行时；升级使用 `npm run upgrade:pi`。运行时按独立生成目录保存，验证成功后通过 `resources/pi-runtime/current.json` 切换新进程的入口；旧目录保留给仍在运行的进程。打包前的 hook 只提取当前选中的运行时，发行包内仍使用稳定的 `resources/pi-runtime/` 路径，不携带旧版本。
3. 生成目录包并运行 `npm run test:packaged`，核对包内 pi、CLI、配置与路径。独立输出目录用 `YAN_PACKAGED_DIR` 指向对应的 `win-unpacked`；单文件便携版用 `npm run test:packaged -- --exe=<便携 EXE 路径>`。验收包括 Codemode 的 WASM / worker / 桌面薄层落位、默认开启及开关保存、原生自动压缩 RPC 往返、真实 PTY 和隔离数据完整性，不调用远程模型。
4. 升级验证使用数据备份副本；发布产物中不得包含测试凭证、私人会话、日志或本机用户数据。
5. 按发布范围生成安装包与 ZIP，核对版本、文件名、大小和 SHA-256，并附发布说明。
6. 分别验证安装、启动和卸载结果，注明平台、签名状态与已知限制。Windows 检查不能替代其他平台验收。

只上传明确选定的发行文件，不要整体上传 `release/`。正式发布需要维护者授权。
