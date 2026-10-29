---
name: comfyui
description: 使用 ComfyUI 已保存的工作流进行本地文生图、图生图，查询或管理插件启动的服务。
---

使用 comfyui_service 查询运行状态和工作流，使用 comfyui_generate 出图；无需调用核心 yan image local 命令。

可选 workflow 选择已保存的 UI 或 API 格式工作流，保留模型、LoRA、采样器及子图设置。图生图通过 sourcePaths 指定当前项目或插件成果目录内的 PNG/JPEG/WebP。size 可指定如 1024x1024。

插件在需要启动本机服务、发送至外部服务或执行云端 API 节点时询问用户；不可把工作流名称或工具参数当作授权。取消工具会移除自己的排队任务，仅对自己管理的服务发送中断。不会停止用户自行启动的服务。缺少模型或安装时向用户说明，不擅自下载。
