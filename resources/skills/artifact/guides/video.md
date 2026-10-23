# 视频 · 时间轴合成

适用：用户要一支能从头放到尾的短片——片头、动态海报、产品演示、讲解短片、社交短视频。一页 HTML 就是一整支片子：固定画幅、按秒推进、能跳到任意一秒取出那一帧。格式沿用 hyperframes（Apache-2.0，heygen-com/hyperframes）的合成约定，砚的画布预览、时间轴和导出 MP4 都读它。

## 什么时候用视频类型

- 画面按镜头推进（换构图、出现、消失），用户会想「从头放一遍」或者导出成视频。
- 要能检查节奏：把播放头拖到某一秒，画面必须等于那一刻的样子。
- 不是视频：页面上一次性的入场动效（写进 landing / slides 的成果里）、能点着玩的交互（`guides/game.md`）。

## 合成结构

根元素是一整个画面，属性名照抄，不要改名：

| 属性 | 位置 | 含义 |
| --- | --- | --- |
| `data-composition-id` | 根元素 `#stage` | 合成 id，同时是 `window.__timelines` 的键；画布靠它认出这页是视频 |
| `data-width` / `data-height` | 根元素 | 画幅，常用 1920×1080（横）与 1080×1920（竖） |
| `data-duration` | 根元素 | 总时长，单位秒，可以是小数 |
| `data-start` / `data-duration` | 每个片段元素 | 入场秒和长度，从合成开头算起，不是从上一镜结尾算 |
| `data-track-index` | 每个片段元素 | 轨道号，画布时间轴按它分行显示轨道 |

- 片段的可见区间是 `[data-start, data-start + data-duration)`；所有片段都要落在根 `data-duration` 以内，最后一镜的结束时间就是总时长。
- 画面叠放顺序由 CSS `z-index` 决定，与 `data-track-index` 无关。
- 根元素铺满视口，内部元素按 1920×1080 的比例摆放；不要用 `vh` 换算尺寸。

## 最小合成模板

照它改：三段结构（根、片段、控制器），一个新镜头就是再加一个带 `data-start` 的 `<section class="clip">` 和几行 `anim(...)`。

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>六秒小片</title>
<style>
  :root { --bg: #101014; --ink: #f4f1ea; --accent: #ff5a36; }
  html, body { margin: 0; height: 100%; background: #000; }
  #stage {
    position: relative; width: 100%; height: 100%; overflow: hidden;
    background: var(--bg); color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .clip { position: absolute; inset: 0; opacity: 0; display: grid; place-items: center; }
  .clip h2 { margin: 0; font-size: 88px; font-weight: 700; line-height: 1.35; letter-spacing: 0; }
  .bar { position: absolute; left: 18%; bottom: 24%; width: 40%; height: 16px; background: var(--accent); transform-origin: left center; transform: scaleX(0); }
</style>
</head>
<body>
  <div id="stage" data-composition-id="demo" data-width="1920" data-height="1080" data-duration="6">
    <section class="clip" data-start="0" data-duration="2.4" data-track-index="1">
      <h2 id="line1">第一镜：一句话</h2>
    </section>
    <section class="clip" data-start="2.4" data-duration="3.6" data-track-index="1">
      <h2 id="line2">第二镜：一个动作</h2>
      <div class="bar" id="bar"></div>
    </section>
  </div>
<script>
window.__timelines = window.__timelines || {};
(() => {
  const stage = document.getElementById('stage')
  const total = Number(stage.dataset.duration)
  const anims = []

  const anim = (el, frames, options, fill = 'both') => {
    const a = el.animate(frames, { fill, easing: 'linear', ...options })
    a.pause()
    anims.push(a)
    return a
  }

  stage.querySelectorAll('[data-start]').forEach((clip) => {
    const slot = { duration: Number(clip.dataset.duration) * 1000, delay: Number(clip.dataset.start) * 1000 }
    anim(clip, [{ opacity: 0, easing: 'steps(1, start)' }, { opacity: 1 }], slot, 'none')
  })

  const rise = (id, at) =>
    anim(document.getElementById(id), [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: at, easing: 'cubic-bezier(.2,.7,.2,1)' })

  rise('line1', 120)
  anim(document.getElementById('line1'), [{ opacity: 1 }, { opacity: 0 }], { duration: 280, delay: 1900 })
  rise('line2', 2560)
  anim(document.getElementById('bar'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 1600, delay: 3000, easing: 'cubic-bezier(.2,.7,.2,1)' })

  const seek = (t) => {
    const at = Math.min(Math.max(Number(t) || 0, 0), total - 0.001)
    anims.forEach((a) => {
      a.pause()
      a.currentTime = at * 1000
    })
  }

  const controller = {
    duration: () => total,
    seek,
    play: () => anims.forEach((a) => a.play()),
    pause: () => anims.forEach((a) => a.pause()),
    paused: () => !anims.some((a) => a.playState === 'running')
  }
  window.__timelines['demo'] = controller
  seek(0)
})()
</script>
</body>
</html>
```

时间都是绝对秒：动画的 `delay` 写起始秒，帧内容只由 `t` 决定。控制器把 `seek` 夹到 `data-duration - 0.001`，这样导出最后一帧不会黑屏。片段为什么在区间外不可见：给每个 `[data-start]` 生成的这条 `opacity` 阶梯动画住在片段的活跃区间里，`fill: 'none'` 让区间以外回到 CSS 的 `opacity: 0`。

## __timelines 控制器接口

页面加载后所有动画都是暂停的，由一个对象统一控制，挂在 `window.__timelines[<composition-id>]` 上（键与根元素 `data-composition-id` 相同）：

| 方法 | 语义 |
| --- | --- |
| `duration()` | 返回总时长（秒），等于根 `data-duration` |
| `seek(t)` | 跳到第 t 秒并立刻渲染该帧；同一个 t 每次渲染结果必须相同（导出 MP4 靠它逐帧取画面） |
| `play()` | 从当前帧开始播放，预览里用户点播放时调用 |
| `pause()` | 停在当前帧 |
| `paused()` | 返回布尔值：是否暂停中 |

- 用 WAAPI：创建动画后马上 `pause()`，`seek` 里把每个动画的 `currentTime` 设成 `t * 1000`；用 CSS 动画时同理，用 `document.getAnimations()` 拿到它们逐个设 `currentTime` 再 `pause()`。
- 用 GSAP：`gsap.timeline({ paused: true })` 本身就带 `duration() / seek() / play() / pause() / paused()`，把它直接挂到 `window.__timelines[id]` 即可；tween 全部用 `fromTo`，起始秒写成绝对位置。

## 动画写法

- 一个动画管一个元素的少数几个属性；时间用绝对秒，不要用「上一镜结束 + 0.5」推算。
- 进出场的起点都写进关键帧（`fromTo` 或首帧），不要依赖 CSS 里的初值：seek 回来时相对写法会漂。
- 需要随机就用种子伪随机（如 mulberry32），同一秒永远得到同一个数。
- 不用 `setTimeout`、`setInterval`、`requestAnimationFrame` 推进画面，也不读 `Date.now()`；画面只能由 `t` 决定。
- 有 `<video>` 时在 `seek` 里设 `currentTime = t - data-start`，不要 `play()`。
- 字体只用系统字体：`system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`；网络字体会被 CSP 拦掉。

## 声音

- 不自动播放：不要 `autoplay`，页面上也不放播放按钮。
- 音乐、配音写成同一时间轴上的元素：`<audio id="bgm" src="bgm.mp3" data-start="0" data-duration="8" data-track-index="2" data-volume="0.8"></audio>`。
- 预览里声音可能被静音；即使静音，`seek` 里也要把音频的 `currentTime` 设成 `t - data-start`。导出 MP4 目前只录画面，还不会混音。

## 离线沙箱

预览页的 CSP 是 `default-src 'none'`，只放行内联 `<script>` / `<style>` 和同目录的本地文件：CDN 脚本、网络字体、`fetch`、`XMLHttpRequest`、`<iframe>` 一律被拦。同目录素材必须落在 `HTML_ASSET_TYPES` 里（`.css .js .mjs .png .jpg .jpeg .gif .webp .avif .svg .ico .bmp .woff .woff2 .ttf .otf .mp3 .wav .ogg .mp4 .webm`），单个不超过 8MB。挂到回复时只复制 HTML 本身，同目录素材会丢：默认单文件写死，图形用内联 SVG，音频用 `data:` URI，只有用户明确要外部素材时才引用同目录文件。

GSAP 只在用户明确要求时用，且必须是项目本地文件：把 `node_modules/gsap/dist/gsap.min.js` 复制到成果同目录，用 `<script src="gsap.min.js"></script>` 引入，许可证由用户自行确认。

## 三维画面（three.js）

要 3D 镜头（立体物体、立体字、镜头推拉环绕、材质光照）时用砚随包的 three.js。在 `<head>` 里写一行占位标签，不写 `src`、不用 `import`：

```html
<script data-yan-lib="three"></script>
```

- 预览、画布、`yan artifact preview` 与导出 MP4 时，砚把它替换成内置库；挂到回复时存下来的副本会直接内联，单独打开也能播。不要自己复制、粘贴库代码，也不要引用 CDN。
- 全局对象是 `THREE`（three.js 0.186，经典脚本，不是 ES 模块）。除核心外只多带三件：`THREE.TextGeometry`、`THREE.FontLoader`（含 `THREE.Font`）、`THREE.RoomEnvironment`，以及一款内置字体 `THREE.fonts.helvetikerBold`。`OrbitControls`、`GLTFLoader`、后期处理等附加模块都没有；外部模型、贴图、HDR 也加载不了（`fetch` 被拦）。
- 立体字：`const font = new THREE.FontLoader().parse(THREE.fonts.helvetikerBold)`，再 `new THREE.TextGeometry('TEXT', { font, size, depth, bevelEnabled: true, ... })`。这款字体只有拉丁字母、数字和常用标点，中文立体字做不出来：中文标题放在 HTML 叠层里（照常是 `.clip` 片段），或者用 `<canvas>` 以系统字体画字后做成 `THREE.CanvasTexture` 贴到平面上。
- 光照：`scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new THREE.RoomEnvironment(), 0.04).texture`，金属、高光材质（`MeshStandardMaterial` / `MeshPhysicalMaterial`）就有反射；再按需加一两盏 `DirectionalLight`。

画面只能由 `t` 决定，规则比 DOM 动画更严：

- 渲染器必须 `new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })`，像素比 `Math.min(devicePixelRatio, 2)`。少了 `preserveDrawingBuffer`，导出逐帧截图可能拿到空白。
- `seek(t)` 里同步完成一整帧：按 t 算出所有物体、相机、材质参数，然后立刻 `renderer.render(scene, camera)`。不要在 `seek` 外面维持一个 `requestAnimationFrame` 渲染循环；`play()` 才起循环，循环里只做 `seek(当前播放秒)`。
- 不用 `THREE.Clock`、`getDelta()`、累加的 `rotation.y += 0.01`；角度、位置都写成 t 的函数。用 `AnimationMixer` 时调 `mixer.setTime(t)`，不要 `update(delta)`。随机数用种子伪随机。
- 尺寸跟舞台走：每次 `seek` 先 `renderer.setSize(stage.clientWidth, stage.clientHeight, false)` 并更新 `camera.aspect`，`<canvas>` 用 CSS 铺满根元素。
- 文字说明、字幕仍写成 HTML 片段叠在 `<canvas>` 上，它们的显隐照常由 `data-start` / `data-duration` 管；3D 物体的显隐在 `seek` 里按同样的秒数设 `visible`。
- 控制几何复杂度：每帧都要完整渲染一次，`TextGeometry` 的 `curveSegments` 6–10 足够，粒子不超过几万个，否则导出很慢。

最小 3D 合成（照它改：一镜一件事，镜头切换时同步切 3D 物体和 HTML 片段）：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>三维小片</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; }
  #stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0b0d12; color: #f4f1ea; font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  #gl { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .clip { position: absolute; left: 6%; bottom: 10%; opacity: 0; }
  .clip h2 { margin: 0; font-size: 56px; font-weight: 700; line-height: 1.35; letter-spacing: 0; }
</style>
<script data-yan-lib="three"></script>
</head>
<body>
  <div id="stage" data-composition-id="demo3d" data-width="1920" data-height="1080" data-duration="6">
    <canvas id="gl"></canvas>
    <section class="clip" data-start="0" data-duration="3" data-track-index="1"><h2>第一镜：立方体入场</h2></section>
    <section class="clip" data-start="3" data-duration="3" data-track-index="1"><h2>第二镜：立体字</h2></section>
  </div>
<script>
window.__timelines = window.__timelines || {};
(() => {
  const stage = document.getElementById('stage')
  const total = Number(stage.dataset.duration)
  const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('gl'), antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0d12)
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new THREE.RoomEnvironment(), 0.04).texture
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100)

  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshStandardMaterial({ color: 0xff5a36, metalness: 0.3, roughness: 0.35 }))
  scene.add(cube)
  const font = new THREE.FontLoader().parse(THREE.fonts.helvetikerBold)
  const textGeometry = new THREE.TextGeometry('HELLO 3D', { font, size: 0.7, depth: 0.25, curveSegments: 8, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.02, bevelSegments: 3 })
  textGeometry.center()
  const word = new THREE.Mesh(textGeometry, new THREE.MeshStandardMaterial({ color: 0xdfe6f0, metalness: 1, roughness: 0.18 }))
  scene.add(word)

  const clips = [...stage.querySelectorAll('[data-start]')].map((el) => ({ el, start: Number(el.dataset.start), end: Number(el.dataset.start) + Number(el.dataset.duration) }))
  const ease = (x) => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3)

  let now = 0
  const seek = (t) => {
    now = Math.min(Math.max(Number(t) || 0, 0), total - 0.001)
    renderer.setSize(stage.clientWidth, stage.clientHeight, false)
    camera.aspect = stage.clientWidth / stage.clientHeight
    camera.updateProjectionMatrix()
    clips.forEach((c) => { c.el.style.opacity = now >= c.start && now < c.end ? 1 : 0 })
    cube.visible = now < 3
    cube.position.y = (1 - ease(now / 1.2)) * -3
    cube.rotation.set(now * 0.6, now * 1.1, 0)
    word.visible = now >= 3
    const b = ease((now - 3) / 1.4)
    word.position.z = (1 - b) * -8
    word.rotation.y = (1 - b) * Math.PI * 0.8 + Math.sin(now * 1.2) * 0.12
    camera.position.set(Math.sin(now * 0.3) * 1.2, 0.6, 6.5 - now * 0.2)
    camera.lookAt(0, 0, 0)
    renderer.render(scene, camera)
  }

  let raf = 0, playing = false, origin = 0
  const tick = (ms) => {
    if (!playing) return
    const t = (ms - origin) / 1000
    if (t >= total) { playing = false; seek(total); return }
    seek(t)
    raf = requestAnimationFrame(tick)
  }
  window.__timelines['demo3d'] = {
    duration: () => total,
    seek,
    play: () => { if (playing) return; playing = true; origin = performance.now() - now * 1000; raf = requestAnimationFrame(tick) },
    pause: () => { playing = false; cancelAnimationFrame(raf) },
    paused: () => !playing
  }
  window.addEventListener('resize', () => seek(now))
  seek(0)
})()
</script>
</body>
</html>
```

## 镜头与节奏

- 一镜一个画面事件：这一镜只让一件事发生（出现一个词、推进一个图形、翻一次数字）。两件事挤在一镜里，两件都看不清。
- 文字停留够读完：一行字至少 1.2 秒，长句按字数往上加；掠过去不算停留。
- 相邻镜头换构图：这一镜居中大字，下一镜就换左文右图或满版图形；同一种构图连着两镜，看起来像没切换。
- 结尾落在动作上：最后一镜停在还在变化或移动的元素上，不要停在一句静止的总结。
- 时长按镜头数定：8 秒 2–3 镜，15 秒 4–5 镜，30 秒 6–8 镜。
- 配色、字体、母题照选定的风格牌，全片一套；镜头之间靠构图和节奏变化，不要靠换色。风格牌抽 `yan artifact style --kind video`：video 和幻灯片一样是整屏 16:9 画面，能用于 video 的牌就是适合整屏画面那一批。

## 自检清单

- `seek(0)`、`seek(总时长 / 2)`、`seek(总时长)` 三个时刻画面都正确：不空白、不重叠、文字没被裁掉；结尾那一帧不能是黑屏，控制器的 clamp 到位才成立。
- 没有 `http://`、`https://` 外链，没有网络字体，没有 `@import`。
- 用了 3D 的：`<head>` 里有 `<script data-yan-lib="three"></script>`，渲染器带 `preserveDrawingBuffer: true`，总览图里每一格 3D 画面都不是空白或纯色；往回 seek 同一秒画面相同。
- 每个片段的 `data-start + data-duration` 都 ≤ 根 `data-duration`，最后一镜正好结束在总时长。
- 页面加载后不自播放：第一帧静止，没有播放按钮。
- `yan artifact preview --path <文件>` 是主要自检：视频合成会按合成画幅、在「每个片段的中点 + 结尾帧（总时长 - 0.001 秒）」逐时间点 seek 后截图，拼成一张带 `t=秒` 标注的总览图（从左到右、从上到下按时间先后）。用 read 打开总览图逐格看：不空白、不重叠、文字没被裁掉、结尾那一帧不是黑屏；候选时间点会去重，超过 8 个时会分散抽样，最多 8 格，不保证每镜都有；以返回的 `samples` 为准，未采到的镜头需另行检查。
- 摘要里的 `overflow` 列出包围盒超出画框的可见元素：有就说明那一镜的构图或字号超了，回去改版式，不要靠 `overflow: hidden` 把问题藏起来。
- 摘要里 `consoleErrors` 不为 0 不能交付；报告里还会写有没有等到 `window.__timelines` 控制器，等到超时说明 seek 没生效，这时的截图不代表各时间点画面。
- 想看别的时刻就用 `--at` 覆盖默认取样：`yan artifact preview --path <文件> --at 0,1.5,总时长-0.001`（实际参数须填逗号分隔的非负秒数，末项先算成数字；`--at` 也会去重，超过 8 个时抽样至最多 8 格）；控制器的 `seek(0)` 与 `seek(总时长 - 0.001)` 必须都夹在有效区间内。
- 用户要 MP4 视频文件时运行 `yan artifact export-video --path <文件>`：逐帧 seek 录成 MP4，输出在 HTML 同目录的同名 .mp4；只录画面、不混音，FFmpeg 是外部前提，须已在 PATH 中或通过 `YAN_FFMPEG` 指定可执行文件；缺失时如实说明，不承诺无需安装，也不自行安装。
