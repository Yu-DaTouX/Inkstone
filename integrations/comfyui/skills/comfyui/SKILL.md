---
name: comfyui
description: 使用 ComfyUI 已保存的工作流进行本地文生图、图生图、文生视频、图生视频与视频转视频，查询或管理插件启动的服务。
---

使用 comfyui_service 查询运行状态和工作流，comfyui_generate 出图，comfyui_video 生成视频；无需调用核心 yan image local 命令。

status 列出每个工作流的类型（text-to-image、image-to-image、text-to-video、image-to-video、video-to-video），服务未运行时也从安装目录读取。按任务选同类型的工作流填入 workflow；不填时按输入自动选：comfyui_video 给 videoPath 走 video-to-video，给 sourcePaths 走 image-to-video，都不给走 text-to-video。

工作流里的模型、LoRA、采样器及子图设置保持原样。图生图和图生视频用 sourcePaths 指定当前项目或插件成果目录内的 PNG/JPEG/WebP；视频转视频用 videoPath 指定同样范围内的 MP4/MOV/WebM/MKV。size 如 1024x1024 或 672x384；MiniMax H3 Director 工作流不给 size 时按源视频比例保持原像素量，seconds 限制生成时长（默认 10 秒，最多 30 秒）。

视频生成在后台任务里跑，工具卡片实时显示阶段、排队位置、当前节点和步数。comfyui_video 最多等 waitSeconds（默认 240 秒），到时没完成就返回进度和 jobId；用 comfyui_job 传 jobId 继续等待，按返回的步数和已用时间判断还要多久。卡在同一阶段很久、或用户改了主意时用 cancel: true 取消。完成后视频自动挂到回复。

需要时插件会直接启动本机 ComfyUI，不必先问用户；发送至外部服务或执行云端 API 节点时询问用户；不可把工作流名称或工具参数当作授权。取消工具会移除自己的排队任务，仅对自己管理的服务发送中断。不会停止用户自行启动的服务。缺少模型或安装时向用户说明，不擅自下载。
