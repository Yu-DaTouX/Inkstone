---
name: subagent
description: 用户指定另一个模型完成任务，或需要独立上下文与并行分工时使用。
---

# 指定模型的子 Agent

当前会话负责整体任务，子 Agent 负责一个明确子任务，结果返回当前会话。

1. 用户指定了模型时使用该模型；没有指定时跟随当前会话模型，不按旧活动配置切换。
2. 任务说明写清目标、必要上下文、输入文件和期望结果。只传有用材料，子 Agent 不自动获得完整主会话历史。
3. 启动：`yan subagent start --task "任务" --model "provider/model"`。默认在当前文件夹执行，可能直接修改文件；只分析时加 `--read-only`。代码修改需要隔离时加 `--isolation worktree`，该选项才要求 Git。
4. 查询用 `yan subagent list` / `yan subagent get --id <ID>`，停止用 `yan subagent stop --id <ID>`。不用固定间隔 sleep 轮询；开启完成通知时结果会回到父会话。
5. 不让多个写入任务同时修改相同文件；需要用户选择的问题留给主会话。子 Agent 不再派出子 Agent。
6. 汇报时标明子 Agent 的模型、结论和未验证项；出错或部分完成不能称为任务成功。worktree 的改动仍需审阅与采用，当前文件夹任务已经直接写入，不假装有待合并补丁。

不要求任务模板、空间、资料库、预算配置或外部 CLI Hub。旧 Hub 的历史任务继续由原有后端读取。
