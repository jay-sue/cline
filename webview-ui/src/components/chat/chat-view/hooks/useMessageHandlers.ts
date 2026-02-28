/**
 * @fileoverview 消息处理器 Hook - 管理聊天消息的发送和任务操作
 *
 * 本文件实现了 ChatView 的核心消息处理逻辑，是用户输入与后端通信的桥梁。
 *
 * 主要功能：
 * 1. 消息发送 - 处理用户输入的文本、图片和文件
 * 2. 按钮操作 - 处理各种按钮点击事件（批准、拒绝、取消等）
 * 3. 任务管理 - 创建新任务、取消任务、清理状态
 *
 * 消息发送流程：
 * ┌─────────────────┐
 * │ handleSendMessage │
 * └────────┬────────┘
 *          │
 *    ┌─────┴─────┐
 *    │ 判断消息类型 │
 *    └─────┬─────┘
 *          │
 *    ┌─────┼─────────────────┐
 *    ▼     ▼                 ▼
 * 新任务  响应询问         中断任务
 * newTask() askResponse()  askResponse()
 */

// ==================== 外部依赖导入 ====================

import type { ClineMessage } from "@shared/ExtensionMessage"
// Protocol Buffers 消息类型
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { AskResponseRequest, NewTaskRequest } from "@shared/proto/cline/task"
// React Hooks
import { useCallback, useRef } from "react"
// 扩展状态上下文
import { useExtensionState } from "@/context/ExtensionStateContext"
// gRPC 服务客户端
import { SlashServiceClient, TaskServiceClient } from "@/services/grpc-client"
// 类型定义
import type { ButtonActionType } from "../shared/buttonConfig"
import type { ChatState, MessageHandlers } from "../types/chatTypes"

/**
 * 消息处理器自定义 Hook
 *
 * 提供聊天界面所需的所有消息处理功能，包括：
 * - 发送消息到后端
 * - 处理各种按钮操作
 * - 管理任务生命周期
 *
 * @param messages - 当前对话的消息列表
 * @param chatState - 聊天状态对象，包含各种状态和设置函数
 * @returns MessageHandlers - 包含所有消息处理函数的对象
 *
 * @example
 * ```typescript
 * const messageHandlers = useMessageHandlers(messages, chatState)
 * // 发送消息
 * messageHandlers.handleSendMessage("你好", [], [])
 * // 执行按钮操作
 * messageHandlers.executeButtonAction("approve")
 * ```
 */
export function useMessageHandlers(messages: ClineMessage[], chatState: ChatState): MessageHandlers {
	// 获取后台命令运行状态
	const { backgroundCommandRunning } = useExtensionState()

	// 从聊天状态中解构所需的状态和函数
	const {
		setInputValue, // 设置输入框值
		activeQuote, // 当前激活的引用文本
		setActiveQuote, // 设置引用文本
		setSelectedImages, // 设置已选图片
		setSelectedFiles, // 设置已选文件
		setSendingDisabled, // 设置发送禁用状态
		setEnableButtons, // 设置按钮启用状态
		clineAsk, // 当前的 AI 询问类型
		lastMessage, // 最后一条消息
	} = chatState

	// 取消操作进行中的标志，防止重复取消
	const cancelInFlightRef = useRef(false)

	/**
	 * 处理消息发送
	 *
	 * 这是消息发送的核心函数，根据当前状态决定如何处理用户输入：
	 * 1. 如果是第一条消息（messages.length === 0），创建新任务
	 * 2. 如果存在 clineAsk，作为对 AI 询问的响应
	 * 3. 如果任务正在运行，作为中断/反馈发送
	 *
	 * @param text - 用户输入的文本
	 * @param images - 用户选择的图片（Base64 格式）
	 * @param files - 用户选择的文件路径
	 */
	const handleSendMessage = useCallback(
		async (text: string, images: string[], files: string[]) => {
			// 去除首尾空白
			let messageToSend = text.trim()
			// 检查是否有实际内容
			const hasContent = messageToSend || images.length > 0 || files.length > 0

			// 如果存在引用文本，将其添加到消息前面
			if (activeQuote && hasContent) {
				const prefix = "[context] \n> "
				const formattedQuote = activeQuote
				const suffix = "\n[/context] \n\n"
				messageToSend = `${prefix} ${formattedQuote} ${suffix} ${messageToSend}`
			}

			if (hasContent) {
				console.log("[ChatView] handleSendMessage - Sending message:", messageToSend)
				// 标记消息是否成功发送
				let messageSent = false

				// ==================== 情况 1: 创建新任务 ====================
				// 当消息列表为空时，说明这是一个全新的对话
				if (messages.length === 0) {
					await TaskServiceClient.newTask(
						NewTaskRequest.create({
							text: messageToSend,
							images,
							files,
						}),
					)
					messageSent = true
				}
				// ==================== 情况 2: 响应 AI 的询问 ====================
				else if (clineAsk) {
					// 对于恢复任务的询问，使用 yesButtonClicked 以与恢复按钮行为一致
					// 这确保了 Enter 键和恢复按钮的行为完全相同
					if (clineAsk === "resume_task" || clineAsk === "resume_completed_task") {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
								text: messageToSend,
								images,
								files,
							}),
						)
						messageSent = true
					} else {
						// 其他类型的询问使用 messageResponse
						switch (clineAsk) {
							case "followup": // 后续问题
							case "plan_mode_respond": // 计划模式响应
							case "tool": // 工具使用确认
							case "browser_action_launch": // 浏览器操作启动
							case "command": // 命令执行确认
							case "command_output": // 命令输出反馈
							case "use_mcp_server": // MCP 服务器使用
							case "use_subagents": // 子代理使用
							case "completion_result": // 完成结果
							case "mistake_limit_reached": // 错误次数限制
							case "api_req_failed": // API 请求失败
							case "new_task": // 新任务建议
							case "condense": // 压缩对话
							case "report_bug": // 报告 Bug
								await TaskServiceClient.askResponse(
									AskResponseRequest.create({
										responseType: "messageResponse",
										text: messageToSend,
										images,
										files,
									}),
								)
								messageSent = true
								break
						}
					}
				}
				// ==================== 情况 3: 中断正在运行的任务 ====================
				else if (messages.length > 0) {
					// 没有设置 clineAsk - 检查任务是否正在运行
					// 如果是，允许用中断/反馈打断它
					const lastMessage = messages[messages.length - 1]
					const isTaskRunning =
						lastMessage.partial === true || (lastMessage.type === "say" && lastMessage.say === "api_req_started")

					if (isTaskRunning) {
						// 任务正在运行 - 作为中断/反馈发送消息
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "messageResponse",
								text: messageToSend,
								images,
								files,
							}),
						)
						messageSent = true
					}
				}

				// 只有在消息成功发送后才清理输入状态和禁用 UI
				if (messageSent) {
					setInputValue("") // 清空输入框
					setActiveQuote(null) // 清除引用
					setSendingDisabled(true) // 禁用发送
					setSelectedImages([]) // 清空图片
					setSelectedFiles([]) // 清空文件
					setEnableButtons(false) // 禁用按钮

					// 重置自动滚动
					if ("disableAutoScrollRef" in chatState) {
						;(chatState as any).disableAutoScrollRef.current = false
					}
				}
			}
		},
		[
			messages.length,
			clineAsk,
			activeQuote,
			setInputValue,
			setActiveQuote,
			setSendingDisabled,
			setSelectedImages,
			setSelectedFiles,
			setEnableButtons,
			chatState,
		],
	)

	/**
	 * 开始新任务
	 *
	 * 清除当前任务状态，准备接收新的用户输入。
	 * 调用后端 clearTask 方法清理任务。
	 */
	const startNewTask = useCallback(async () => {
		setActiveQuote(null)
		await TaskServiceClient.clearTask(EmptyRequest.create({}))
	}, [setActiveQuote])

	/**
	 * 清理输入状态辅助函数
	 *
	 * 重置所有输入相关的状态：
	 * - 清空输入框
	 * - 清除引用
	 * - 清空已选图片和文件
	 */
	const clearInputState = useCallback(() => {
		setInputValue("")
		setActiveQuote(null)
		setSelectedImages([])
		setSelectedFiles([])
	}, [setInputValue, setActiveQuote, setSelectedImages, setSelectedFiles])

	/**
	 * 执行按钮操作
	 *
	 * 根据按钮类型执行相应的操作，支持的操作类型：
	 * - retry: 重试失败的 API 请求
	 * - approve: 批准/确认操作
	 * - reject: 拒绝操作
	 * - proceed: 继续执行
	 * - new_task: 创建新任务
	 * - cancel: 取消当前任务
	 * - utility: 工具类操作（压缩、报告 Bug）
	 *
	 * @param actionType - 按钮操作类型
	 * @param text - 可选的附加文本
	 * @param images - 可选的附加图片
	 * @param files - 可选的附加文件
	 */
	const executeButtonAction = useCallback(
		async (actionType: ButtonActionType, text?: string, images?: string[], files?: string[]) => {
			const trimmedInput = text?.trim()
			const hasContent = trimmedInput || (images && images.length > 0) || (files && files.length > 0)

			switch (actionType) {
				// ==================== 重试操作 ====================
				case "retry":
					// 对于 API 重试（api_req_failed），总是发送简单的批准，不带内容
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							responseType: "yesButtonClicked",
						}),
					)
					clearInputState()
					break

				// ==================== 批准操作 ====================
				case "approve":
					if (hasContent) {
						// 带内容的批准
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						// 简单批准
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				// ==================== 拒绝操作 ====================
				case "reject":
					if (hasContent) {
						// 带反馈的拒绝
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "noButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						// 简单拒绝
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "noButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				// ==================== 继续操作 ====================
				case "proceed":
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				// ==================== 新任务操作 ====================
				case "new_task":
					if (clineAsk === "new_task") {
						// 如果是 AI 建议的新任务，使用建议的文本
						await TaskServiceClient.newTask(
							NewTaskRequest.create({
								text: lastMessage?.text,
								images: [],
								files: [],
							}),
						)
					} else {
						// 否则清空当前任务
						await startNewTask()
					}
					break

				// ==================== 取消操作 ====================
				case "cancel": {
					// 防止重复取消
					if (cancelInFlightRef.current) {
						return
					}
					cancelInFlightRef.current = true
					setSendingDisabled(true)
					setEnableButtons(false)
					try {
						// 如果有后台命令在运行，先取消它
						if (backgroundCommandRunning) {
							await TaskServiceClient.cancelBackgroundCommand(EmptyRequest.create({})).catch((err) =>
								console.error("Failed to cancel background command:", err),
							)
						}
						// 取消主任务
						await TaskServiceClient.cancelTask(EmptyRequest.create({}))
					} finally {
						cancelInFlightRef.current = false
						// 清除可能干扰恢复的待处理状态
						setSendingDisabled(false)
						setEnableButtons(true)
					}
					break
				}

				// ==================== 工具类操作 ====================
				case "utility":
					switch (clineAsk) {
						case "condense":
							// 压缩对话历史
							await SlashServiceClient.condense(StringRequest.create({ value: lastMessage?.text })).catch((err) =>
								console.error(err),
							)
							break
						case "report_bug":
							// 报告 Bug
							await SlashServiceClient.reportBug(StringRequest.create({ value: lastMessage?.text })).catch((err) =>
								console.error(err),
							)
							break
					}
					break
			}

			// 重置自动滚动
			if ("disableAutoScrollRef" in chatState) {
				;(chatState as any).disableAutoScrollRef.current = false
			}
		},
		[
			clineAsk,
			lastMessage,
			messages,
			clearInputState,
			handleSendMessage,
			startNewTask,
			chatState,
			backgroundCommandRunning,
			setSendingDisabled,
			setEnableButtons,
		],
	)

	/**
	 * 处理任务关闭按钮点击
	 *
	 * 点击关闭按钮时开始新任务，清理当前状态
	 */
	const handleTaskCloseButtonClick = useCallback(() => {
		startNewTask()
	}, [startNewTask])

	// 返回所有消息处理函数
	return {
		handleSendMessage, // 发送消息
		executeButtonAction, // 执行按钮操作
		handleTaskCloseButtonClick, // 关闭任务
		startNewTask, // 开始新任务
	}
}
