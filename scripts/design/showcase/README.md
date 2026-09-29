# Inkstone · 让想法成形

48 秒、1920 × 1080、30 fps 的代码生成品牌展示片。Canvas 2D 绘制画面，按绝对时间渲染；Electron 离屏导出帧，FFmpeg 编码 H.264 / AAC。无外部素材下载、无模型调用。

## 观看与编辑

用浏览器打开 `index.html`，点击播放。支持暂停、重播、时间轴、全屏；空格播放或暂停，方向键前后 1 秒。HTML 播放器无配乐，MP4 包含代码合成的轻音乐。

编辑 `film.js` 中六个场景及其时间范围即可调整文案、构图与动画。`renderAt(seconds)` 可确定性地定位任意帧。片中界面为依据设计规范绘制的演示，不是应用录屏或真实模型执行证明。

## 设计依据

- `docs/DESIGN_SYSTEM.md` v0.5 与 `docs/UI_REDESIGN.md`：墨色工作空间、内容优先、现代终端气质。
- `docs/BRAND.md`：品牌定位与「让想法成形」。
- `src/renderer/src/styles/tokens.css`：深浅主题色与靛蓝强调色。
- `build/prompt-stone.svg`：沿用石框与提示符的原始路径和比例。
- 排版使用系统 Segoe UI / 微软雅黑 UI，命令标签使用 Consolas；影片为独立宣传排版，不替代应用控件或字体实现。

| 时间 | 画面 |
| --- | --- |
| 00–06 秒 | 石框与提示符显现，品牌主张 |
| 06–15 秒 | 输入想法，工作空间展开 |
| 15–23 秒 | 文件读取、执行过程与改动审查 |
| 23–32 秒 | 纸白成果，可编辑正文、版本与导出 |
| 32–40 秒 | 资料、对话、成果的主题积累 |
| 40–48 秒 | 品牌落版与项目地址 |

## 重新导出

需要仓库现有 Electron 依赖，以及 PATH 中的 `ffmpeg`。在仓库根目录执行 PowerShell：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
Start-Process -FilePath '.\node_modules\electron\dist\electron.exe' -ArgumentList 'scripts/design/showcase/render.mjs' -WindowStyle Hidden -Wait
```

输出到 `.local-docs/showcase-2026-09-29/`，包括 MP4、配乐 WAV 和六张关键帧。输出目录已在仓库现有忽略规则内。只导出关键帧时，追加 `--stills` 参数。重新导出会覆盖本展示片的同名生成文件；需要保留另一版时先修改 `render.mjs` 中的输出目录。
