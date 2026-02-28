/**
 * @fileoverview 聊天视图组件 - Cline WebView 的主聊天界面
 *
 * 本文件实现了 Cline 的核心聊天界面，用于展示用户与 AI 助手之间的对话。
 *
 * 主要功能：
 * 1. 展示任务信息和 API 消耗指标
 * 2. 渲染消息列表（支持虚拟滚动）
 * 3. 处理用户输入和消息发送
 * 4. 管理聊天状态和滚动行为
 *
 * 组件架构：
 * ┌─────────────────────────────────────────────────────────┐
 * │  ChatView (主容器)                                       │
 * │  ├── Navbar (导航栏，可选)                               │
 * │  ├── TaskSection (任务信息区) 或 WelcomeSection (欢迎区)  │
 * │  ├── MessagesArea (消息列表区，虚拟滚动)                  │
 * │  └── Footer (底部区域)                                   │
 * │      ├── AutoApproveBar (自动审批设置)                   │
 * │      ├── ActionButtons (操作按钮)                        │
 * │      └── InputSection (输入区域)                         │
 * └─────────────────────────────────────────────────────────┘
 */

// ==================== 外部依赖导入 ====================

// 消息处理工具 - 合并和优化消息显示
import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineErrorRetryMessages } from "@shared/combineErrorRetryMessages"
import { combineHookSequences } from "@shared/combineHookSequences"
// API 指标计算工具
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
// Protocol Buffers 消息类型
import { BooleanRequest, StringRequest } from "@shared/proto/cline/common"
// React 核心
import { useCallback, useEffect, useMemo } from "react"
import { useMount } from "react-use"

// ==================== 内部组件和工具导入 ====================

// 设置相关工具函数
import { normalizeApiConfiguration } from "@/components/settings/utils/providerUtils"
// 状态上下文
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useShowNavbar } from "@/context/PlatformContext"
// gRPC 客户端服务
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
// 导航栏组件
import { Navbar } from "../menu/Navbar"
// 自动审批工具栏
import AutoApproveBar from "./auto-approve-menu/AutoApproveBar"

// 从 chat-view 模块导入子组件和工具
import {
	ActionButtons, // 操作按钮（取消、继续等）
	CHAT_CONSTANTS, // 聊天相关常量
	ChatLayout, // 聊天布局容器
	convertHtmlToMarkdown, // HTML 转 Markdown 工具
	filterVisibleMessages, // 过滤可见消息
	groupLowStakesTools, // 分组低风险工具调用
	groupMessages, // 消息分组
	InputSection, // 输入区域
	MessagesArea, // 消息列表区域
	TaskSection, // 任务信息区域
	useChatState, // 聊天状态 Hook
	useMessageHandlers, // 消息处理器 Hook
	useScrollBehavior, // 滚动行为 Hook
	WelcomeSection, // 欢迎区域
} from "./chat-view"

// ==================== 类型定义 ====================

/**
 * ChatView 组件属性接口
 */
interface ChatViewProps {
	/** 是否隐藏聊天视图（当显示设置/历史等其他视图时） */
	isHidden: boolean
	/** 是否显示公告 */
	showAnnouncement: boolean
	/** 隐藏公告的回调函数 */
	hideAnnouncement: () => void
	/** 显示历史视图的回调函数 */
	showHistoryView: () => void
}

// ==================== 常量定义 ====================

/** 每条消息允许的最大图片和文件数量 */
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
/** 显示快速入门提示的历史任务阈值（少于此数量时显示） */
const QUICK_WINS_HISTORY_THRESHOLD = 3

// ==================== 主组件定义 ====================

/**
 * ChatView 聊天视图组件
 *
 * 这是 Cline 的核心聊天界面组件，负责：
 * - 展示任务信息和进度
 * - 渲染消息列表（使用虚拟滚动优化性能）
 * - 管理用户输入和消息发送
 * - 处理滚动行为和自动滚动
 *
 * 注意：为避免状态丢失（用户输入、禁用状态、askResponse promise 等），
 * 即使在显示其他视图时，此组件也不会被条件卸载，而是通过 isHidden 控制可见性。
 *
 * @param props - ChatViewProps
 */
const ChatView = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }: ChatViewProps) => {
	// 是否显示导航栏（根据平台配置）
	const showNavbar = useShowNavbar()

	// ==================== 从扩展状态获取数据 ====================
	const {
		version, // 扩展版本号
		clineMessages: messages, // 聊天消息列表
		taskHistory, // 历史任务列表
		apiConfiguration, // API 配置
		telemetrySetting, // 遥测设置
		mode, // 当前模式（plan/act）
		userInfo, // 用户信息
		currentFocusChainChecklist, // 当前焦点链检查列表
		focusChainSettings, // 焦点链设置
		hooksEnabled, // 是否启用钩子
	} = useExtensionState()

	// 判断是否为生产环境托管应用
	const isProdHostedApp = userInfo?.apiBaseUrl === "https://app.cline.bot"
	// 是否显示快速入门提示（新用户且任务历史少于阈值）
	const shouldShowQuickWins = isProdHostedApp && (!taskHistory || taskHistory.length < QUICK_WINS_HISTORY_THRESHOLD)

	// ==================== 消息处理和计算 ====================

	/**
	 * 获取当前任务
	 * 消息列表的第一条消息应该是任务消息
	 * 如果第一条不是任务消息，说明扩展处于异常状态（参见 Cline.abort）
	 */
	const task = useMemo(() => messages.at(0), [messages])

	/**
	 * 处理后的消息列表
	 *
	 * 对原始消息进行多层处理以优化显示：
	 * 1. 移除第一条任务消息
	 * 2. 合并钩子序列（如果启用）
	 * 3. 合并命令序列
	 * 4. 合并 API 请求
	 * 5. 合并错误重试消息
	 */
	const modifiedMessages = useMemo(() => {
		const slicedMessages = messages.slice(1)
		// 只有在启用钩子时才合并钩子序列
		const withHooks = hooksEnabled ? combineHookSequences(slicedMessages) : slicedMessages
		return combineErrorRetryMessages(combineApiRequests(combineCommandSequences(withHooks)))
	}, [messages, hooksEnabled])

	/**
	 * API 使用指标
	 * 必须在 api_req_finished 被合并到 api_req_started 之后计算
	 */
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])

	/** 最后一次 API 请求的总 token 数 */
	const lastApiReqTotalTokens = useMemo(() => getLastApiReqTotalTokens(modifiedMessages) || undefined, [modifiedMessages])

	// ==================== 自定义 Hooks ====================

	/**
	 * 聊天状态管理 Hook
	 * 管理输入值、选中的图片/文件、发送状态、展开的行等
	 */
	const chatState = useChatState(messages)
	const {
		setInputValue, // 设置输入值
		selectedImages, // 已选择的图片列表
		setSelectedImages, // 设置已选图片
		selectedFiles, // 已选择的文件列表
		setSelectedFiles, // 设置已选文件
		sendingDisabled, // 是否禁用发送
		enableButtons, // 是否启用按钮
		expandedRows, // 展开的消息行
		setExpandedRows, // 设置展开的行
		textAreaRef, // 输入框 DOM 引用
	} = chatState

	// ==================== 副作用 Hooks ====================

	/**
	 * 自定义复制行为
	 *
	 * 拦截复制事件，根据内容类型选择不同的处理方式：
	 * - 代码块或预格式化内容：使用纯文本复制
	 * - 其他内容：转换 HTML 为 Markdown 后复制
	 *
	 * 这确保用户复制的内容格式正确，便于在其他地方使用
	 */
	useEffect(() => {
		const handleCopy = async (e: ClipboardEvent) => {
			const targetElement = e.target as HTMLElement | null
			// 如果复制事件来自输入框或文本域，使用浏览器默认行为
			if (
				targetElement &&
				(targetElement.tagName === "INPUT" || targetElement.tagName === "TEXTAREA" || targetElement.isContentEditable)
			) {
				return
			}

			if (window.getSelection) {
				const selection = window.getSelection()
				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0)
					const commonAncestor = range.commonAncestorContainer
					let textToCopy: string | null = null

					// 检查选区是否在需要纯文本复制的元素内
					let currentElement =
						commonAncestor.nodeType === Node.ELEMENT_NODE
							? (commonAncestor as HTMLElement)
							: commonAncestor.parentElement
					let preferPlainTextCopy = false
					while (currentElement) {
						// 检查是否在代码块内
						if (currentElement.tagName === "PRE" && currentElement.querySelector("code")) {
							preferPlainTextCopy = true
							break
						}
						// 检查计算后的 white-space 样式
						const computedStyle = window.getComputedStyle(currentElement)
						if (
							computedStyle.whiteSpace === "pre" ||
							computedStyle.whiteSpace === "pre-wrap" ||
							computedStyle.whiteSpace === "pre-line"
						) {
							// 如果元素或其祖先有预格式化的空白样式，优先使用纯文本
							// 这有助于处理 TaskHeader 的文本显示等元素
							preferPlainTextCopy = true
							break
						}

						// 如果到达聊天消息边界或 body，停止搜索
						if (
							currentElement.classList.contains("chat-row-assistant-message-container") ||
							currentElement.classList.contains("chat-row-user-message-container") ||
							currentElement.tagName === "BODY"
						) {
							break
						}
						currentElement = currentElement.parentElement
					}

					if (preferPlainTextCopy) {
						// 对于代码块或预格式化元素，获取纯文本
						textToCopy = selection.toString()
					} else {
						// 对于其他内容，将 HTML 转换为 Markdown
						const clonedSelection = range.cloneContents()
						const div = document.createElement("div")
						div.appendChild(clonedSelection)
						const selectedHtml = div.innerHTML
						textToCopy = await convertHtmlToMarkdown(selectedHtml)
					}

					if (textToCopy !== null) {
						try {
							// 通过扩展复制到剪贴板（支持更多格式）
							FileServiceClient.copyToClipboard(StringRequest.create({ value: textToCopy })).catch((err) => {
								console.error("Error copying to clipboard:", err)
							})
							e.preventDefault()
						} catch (error) {
							console.error("Error copying to clipboard:", error)
						}
					}
				}
			}
		}
		document.addEventListener("copy", handleCopy)

		return () => {
			document.removeEventListener("copy", handleCopy)
		}
	}, [])

	// 按钮状态现在由 useButtonState hook 管理
	// handleFocusChange 已由 chatState 提供

	/** 消息处理器 Hook - 处理消息发送、取消等操作 */
	const messageHandlers = useMessageHandlers(messages, chatState)

	/** 获取当前选中模型的信息 */
	const { selectedModelInfo } = useMemo(() => {
		return normalizeApiConfiguration(apiConfiguration, mode)
	}, [apiConfiguration, mode])

	/**
	 * 选择文件和图片
	 *
	 * 打开文件选择对话框，让用户选择要附加到消息的文件和图片。
	 * 图片优先添加，然后添加文件，直到达到数量上限。
	 */
	const selectFilesAndImages = useCallback(async () => {
		try {
			const response = await FileServiceClient.selectFiles(
				BooleanRequest.create({
					value: selectedModelInfo.supportsImages, // 根据模型能力决定是否允许选择图片
				}),
			)
			if (
				response &&
				response.values1 &&
				response.values2 &&
				(response.values1.length > 0 || response.values2.length > 0)
			) {
				const currentTotal = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal

				if (availableSlots > 0) {
					// 优先添加图片
					const imagesToAdd = Math.min(response.values1.length, availableSlots)
					if (imagesToAdd > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...response.values1.slice(0, imagesToAdd)])
					}

					// 用剩余槽位添加文件
					const remainingSlots = availableSlots - imagesToAdd
					if (remainingSlots > 0) {
						setSelectedFiles((prevFiles) => [...prevFiles, ...response.values2.slice(0, remainingSlots)])
					}
				}
			}
		} catch (error) {
			console.error("Error selecting images & files:", error)
		}
	}, [selectedModelInfo.supportsImages])

	/** 是否禁用文件和图片选择（已达到数量上限） */
	const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE

	/**
	 * 订阅 WebView 显示事件
	 *
	 * 当后端请求显示 WebView 时，自动聚焦输入框
	 * （除非设置了保持编辑器焦点）
	 */
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToShowWebview(
			{},
			{
				onResponse: (event) => {
					// 只在未隐藏且不保持编辑器焦点时聚焦
					if (!isHidden && !event.preserveEditorFocus) {
						textAreaRef.current?.focus()
					}
				},
				onError: (error) => {
					console.error("Error in showWebview subscription:", error)
				},
				onComplete: () => {
					console.log("showWebview subscription completed")
				},
			},
		)

		return cleanup
	}, [isHidden])

	/**
	 * 订阅添加到输入框事件
	 *
	 * 当用户通过编辑器右键菜单"添加到 Cline"时，
	 * 将选中的内容添加到输入框
	 */
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput(
			{},
			{
				onResponse: (event) => {
					if (event.value) {
						setInputValue((prevValue) => {
							const newText = event.value
							const newTextWithNewline = newText + "\n"
							return prevValue ? `${prevValue}\n${newTextWithNewline}` : newTextWithNewline
						})
						// 状态更新后滚动到底部
						// 自动聚焦输入框并将光标放在新行，方便继续输入
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight
								textAreaRef.current.focus()
							}
						}, 0)
					}
				},
				onError: (error) => {
					console.error("Error in addToInput subscription:", error)
				},
				onComplete: () => {
					console.log("addToInput subscription completed")
				},
			},
		)

		return cleanup
	}, [])

	/**
	 * 组件挂载时聚焦输入框
	 * 注意：需要 VS Code 窗口处于焦点状态才能生效
	 */
	useMount(() => {
		textAreaRef.current?.focus()
	})

	/**
	 * 在适当的时机自动聚焦输入框
	 *
	 * 当视图可见、发送未禁用且没有等待用户点击按钮时，
	 * 自动聚焦输入框以便用户继续输入
	 */
	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !sendingDisabled && !enableButtons) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, sendingDisabled, enableButtons])

	// ==================== 消息处理和分组 ====================

	/** 过滤后的可见消息列表 */
	const visibleMessages = useMemo(() => {
		return filterVisibleMessages(modifiedMessages)
	}, [modifiedMessages])

	/**
	 * 获取最后的进度消息文本
	 *
	 * 用于显示焦点链（Focus Chain）检查列表，
	 * 优先使用扩展状态中的检查列表，否则回退到最后的 task_progress 消息
	 */
	const lastProgressMessageText = useMemo(() => {
		if (!focusChainSettings.enabled) {
			return undefined
		}

		// 首先检查扩展状态中是否有当前焦点链检查列表
		if (currentFocusChainChecklist) {
			return currentFocusChainChecklist
		}

		// 回退到最后的 task_progress 消息
		const lastProgressMessage = [...modifiedMessages].reverse().find((message) => message.say === "task_progress")
		return lastProgressMessage?.text
	}, [focusChainSettings.enabled, modifiedMessages, currentFocusChainChecklist])

	/** 是否显示焦点链占位符（启用但尚无检查列表时） */
	const showFocusChainPlaceholder = useMemo(() => {
		return focusChainSettings.enabled && !lastProgressMessageText
	}, [focusChainSettings.enabled, lastProgressMessageText])

	/**
	 * 分组后的消息列表
	 *
	 * 对消息进行两层分组：
	 * 1. groupMessages：按逻辑分组（如连续的工具调用）
	 * 2. groupLowStakesTools：将低风险工具调用折叠
	 */
	const groupedMessages = useMemo(() => {
		return groupLowStakesTools(groupMessages(visibleMessages))
	}, [visibleMessages])

	/** 滚动行为 Hook - 管理自动滚动、滚动到底部按钮等 */
	const scrollBehavior = useScrollBehavior(messages, visibleMessages, groupedMessages, expandedRows, setExpandedRows)

	/** 输入框占位符文本 */
	const placeholderText = useMemo(() => {
		const text = task ? "Type a message..." : "Type your task here..."
		return text
	}, [task])

	// ==================== 渲染 ====================

	return (
		<ChatLayout isHidden={isHidden}>
			{/* 主内容区域 */}
			<div className="flex flex-col flex-1 overflow-hidden">
				{/* 导航栏（根据平台配置显示） */}
				{showNavbar && <Navbar />}

				{/* 任务区域或欢迎区域（二选一） */}
				{task ? (
					// 有任务时显示任务信息区
					<TaskSection
						apiMetrics={apiMetrics}
						lastApiReqTotalTokens={lastApiReqTotalTokens}
						lastProgressMessageText={lastProgressMessageText}
						messageHandlers={messageHandlers}
						selectedModelInfo={{
							supportsPromptCache: selectedModelInfo.supportsPromptCache,
							supportsImages: selectedModelInfo.supportsImages || false,
						}}
						showFocusChainPlaceholder={showFocusChainPlaceholder}
						task={task}
					/>
				) : (
					// 无任务时显示欢迎区
					<WelcomeSection
						hideAnnouncement={hideAnnouncement}
						shouldShowQuickWins={shouldShowQuickWins}
						showAnnouncement={showAnnouncement}
						showHistoryView={showHistoryView}
						taskHistory={taskHistory}
						telemetrySetting={telemetrySetting}
						version={version}
					/>
				)}

				{/* 消息列表区域（只在有任务时显示） */}
				{task && (
					<MessagesArea
						chatState={chatState}
						groupedMessages={groupedMessages}
						messageHandlers={messageHandlers}
						modifiedMessages={modifiedMessages}
						scrollBehavior={scrollBehavior}
						task={task}
					/>
				)}
			</div>

			{/* 底部区域 */}
			<footer className="bg-(--vscode-sidebar-background)" style={{ gridRow: "2" }}>
				{/* 自动审批设置栏 */}
				<AutoApproveBar />

				{/* 操作按钮区（取消、继续、重试等） */}
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={messages}
					mode={mode}
					scrollBehavior={{
						scrollToBottomSmooth: scrollBehavior.scrollToBottomSmooth,
						disableAutoScrollRef: scrollBehavior.disableAutoScrollRef,
						showScrollToBottom: scrollBehavior.showScrollToBottom,
						virtuosoRef: scrollBehavior.virtuosoRef,
					}}
					task={task}
				/>

				{/* 输入区域（包含 ChatTextArea） */}
				<InputSection
					chatState={chatState}
					messageHandlers={messageHandlers}
					placeholderText={placeholderText}
					scrollBehavior={scrollBehavior}
					selectFilesAndImages={selectFilesAndImages}
					shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				/>
			</footer>
		</ChatLayout>
	)
}

export default ChatView
