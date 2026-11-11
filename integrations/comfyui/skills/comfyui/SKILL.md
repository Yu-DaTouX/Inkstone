---
name: comfyui
description: 用户要用本机 ComfyUI 出图或生成视频（文生图、图生图、文生视频、图生视频、视频转视频），或查看、改装、运行 ComfyUI 工作流时使用；工具默认未加载，调用前先读。
---

ComfyUI 的 8 个工具默认不在工具列表里：先调用一次 `tool_search`，query 写 `comfyui`，会一次加载 comfyui_service、comfyui_generate、comfyui_video、comfyui_job、comfyui_nodes、comfyui_workflow、comfyui_upload、comfyui_run，从下一次调用起直接使用，参数以加载后的工具说明为准。无需调用核心 yan image local 命令。

出图用 comfyui_generate，视频用 comfyui_video。不确定有哪些工作流时先 comfyui_service status，按任务选同类型的填入 workflow；不填则按输入自动选。素材须在当前项目或插件成果目录内：图片 PNG/JPEG/WebP，视频 MP4/MOV/WebM/MKV；size 写成 1024x1024 这样的「宽x高」。到 waitSeconds 还没完成会返回 jobId，用 comfyui_job 继续等，按返回的步数和已用时间判断还要多久；卡在同一阶段很久或用户改了主意时取消。

需要时插件会直接启动本机 ComfyUI，不必先问用户。发送至外部服务或执行云端 API 节点（可能付费）时询问用户，不可把工作流名称或工具参数当作授权，也不要为绕开确认去掉云端节点，除非用户要求。缺少模型或安装时向用户说明，不擅自下载。取消只移除自己的排队任务，只对插件自己启动的服务发中断，不会停止用户自行启动的服务。

已保存的工作流不合用（缺功能、要换模型或 LoRA、加放大等）时自己改装，必要时从头拼装：
1. comfyui_workflow 读取最接近的已保存工作流；JSON 长就传 outPath 存到项目里，用文件工具改。
2. 节点名、输入名、模型与 LoRA 文件名都用 comfyui_nodes 查实，不凭记忆写；下拉选项里没有的模型告诉用户，不要下载。
3. 输入图或视频先用 comfyui_upload 上传，把返回的文件名填进 LoadImage、LoadVideo 等节点。
4. comfyui_workflow 的 mode: "validate" 通过后再 comfyui_run；失败按返回的节点和原因改完再跑。每次运行改一个 seed，避免命中缓存无输出。
