/**
 * @fileoverview 聊天输入框组件 - Cline WebView 的核心输入组件
 *
 * 本文件实现了 Cline 聊天界面的文本输入区域，是用户与 AI 助手交互的主要入口。
 *
 * 主要功能：
 * 1. 文本输入与自动调整大小
 * 2. @ 提及功能 - 引用文件、文件夹、Git 提交等上下文
 * 3. / 斜杠命令 - 快速执行预定义的工作流命令
 * 4. 图片/文件拖放与粘贴支持
 * 5. Plan/Act 模式切换 - 切换计划模式和执行模式
 * 6. 语法高亮 - 高亮显示 @提及 和 /命令
 *
 * 组件架构：
 * ┌─────────────────────────────────────────────────────────┐
 * │  ChatTextArea (主组件)                                   │
 * │  ├── ContextMenu (@ 提及下拉菜单)                        │
 * │  ├── SlashCommandMenu (/ 命令下拉菜单)                   │
 * │  ├── DynamicTextArea (自动调整高度的文本框)               │
 * │  ├── Thumbnails (已选择的图片/文件缩略图)                 │
 * │  └── Plan/Act 模式切换开关                               │
 * └─────────────────────────────────────────────────────────┘
 */

// ==================== 外部依赖导入 ====================

// 共享模块 - 上下文提及相关正则表达式
import { mentionRegex, mentionRegexGlobal } from "@shared/context-mentions"
// 共享模块 - Protocol Buffers 消息类型
import { StringRequest } from "@shared/proto/cline/common"
import { FileSearchRequest, FileSearchType, RelativePathsRequest } from "@shared/proto/cline/file"
import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/cline/state"
// 共享模块 - 斜杠命令和模式类型
import { type SlashCommand } from "@shared/slashCommands"
import { Mode } from "@shared/storage/types"

// VS Code WebView UI 工具包
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
// 图标库
import { AtSignIcon, PlusIcon } from "lucide-react"
// React 核心
import type React from "react"
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
// 自动调整大小的文本框组件
import DynamicTextArea from "react-textarea-autosize"
// CSS-in-JS 样式库
import styled from "styled-components"

// ==================== 内部组件导入 ====================

// 上下文菜单 - 显示 @ 提及选项
import ContextMenu from "@/components/chat/ContextMenu"
// 聊天常量配置
import { CHAT_CONSTANTS } from "@/components/chat/chat-view/constants"
// 斜杠命令菜单 - 显示 / 命令选项
import SlashCommandMenu from "@/components/chat/SlashCommandMenu"
// 缩略图组件 - 显示已选择的图片和文件
import Thumbnails from "@/components/common/Thumbnails"
// 设置相关工具函数
import { getModeSpecificFields, normalizeApiConfiguration } from "@/components/settings/utils/providerUtils"
// 工具提示组件
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
// 扩展状态上下文
import { useExtensionState } from "@/context/ExtensionStateContext"
// 平台上下文
import { usePlatform } from "@/context/PlatformContext"
// 样式工具函数
import { cn } from "@/lib/utils"
// gRPC 客户端服务
import { FileServiceClient, StateServiceClient } from "@/services/grpc-client"

// ==================== 工具函数导入 ====================

// 上下文提及相关工具
import {
	ContextMenuOptionType,
	getContextMenuOptionIndex,
	getContextMenuOptions,
	insertMention,
	insertMentionDirectly,
	removeMention,
	type SearchResult,
	shouldShowContextMenu,
} from "@/utils/context-mentions"
// 快捷键相关 hooks
import { useMetaKeyDetection, useShortcut } from "@/utils/hooks"
// 平台检测工具
import { isSafari } from "@/utils/platformUtils"
// 斜杠命令相关工具
import {
	getMatchingSlashCommands,
	insertSlashCommand,
	removeSlashCommand,
	shouldShowSlashCommandsMenu,
	slashCommandDeleteRegex,
	slashCommandRegexGlobal,
	validateSlashCommand,
} from "@/utils/slash-commands"

// ==================== 子组件导入 ====================

// Cline 规则切换模态框
import ClineRulesToggleModal from "../cline-rules/ClineRulesToggleModal"
// 服务器切换模态框
import ServersToggleModal from "./ServersToggleModal"

// ==================== 常量定义 ====================

/** 每条消息允许的最大图片和文件数量 */
const { MAX_IMAGES_AND_FILES_PER_MESSAGE } = CHAT_CONSTANTS

/**
 * 获取图片尺寸并验证是否超出限制
 *
 * Anthropic API 对图片尺寸有限制，超过 7500px 的图片会导致请求失败。
 * 此函数在图片被添加到消息前进行预检查。
 *
 * @param dataUrl - 图片的 Base64 Data URL
 * @returns Promise<{width, height}> - 图片尺寸
 * @throws Error - 当图片尺寸超过 7500px 或加载失败时
 */
const getImageDimensions = (dataUrl: string): Promise<{ width: number; height: number }> => {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => {
			// 检查图片尺寸是否超过 API 限制
			if (img.naturalWidth > 7500 || img.naturalHeight > 7500) {
				reject(new Error("Image dimensions exceed maximum allowed size of 7500px."))
			} else {
				resolve({ width: img.naturalWidth, height: img.naturalHeight })
			}
		}
		img.onerror = (err) => {
			console.error("Failed to load image for dimension check:", err)
			reject(new Error("Failed to load image to check dimensions."))
		}
		img.src = dataUrl
	})
}

/** 上下文菜单默认选中"文件"选项 */
const DEFAULT_CONTEXT_MENU_OPTION = getContextMenuOptionIndex(ContextMenuOptionType.File)

// ==================== 类型定义 ====================

/**
 * ChatTextArea 组件属性接口
 *
 * 定义了聊天输入框所需的所有属性，包括：
 * - 输入状态管理
 * - 文件/图片选择
 * - 发送控制
 * - 高度变化回调
 */
interface ChatTextAreaProps {
	/** 当前输入框的文本值 */
	inputValue: string
	/** 当前激活的引用文本（用于引用消息功能） */
	activeQuote: string | null
	/** 更新输入值的函数 */
	setInputValue: (value: string) => void
	/** 是否禁用发送按钮 */
	sendingDisabled: boolean
	/** 输入框占位符文本 */
	placeholderText: string
	/** 已选择的文件路径列表 */
	selectedFiles: string[]
	/** 已选择的图片 Data URL 列表 */
	selectedImages: string[]
	/** 更新已选图片的函数 */
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	/** 更新已选文件的函数 */
	setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
	/** 发送消息的回调函数 */
	onSend: () => void
	/** 打开文件/图片选择对话框的回调 */
	onSelectFilesAndImages: () => void
	/** 是否禁用文件/图片选择（达到数量上限时） */
	shouldDisableFilesAndImages: boolean
	/** 输入框高度变化时的回调 */
	onHeightChange?: (height: number) => void
	/** 输入框焦点状态变化时的回调 */
	onFocusChange?: (isFocused: boolean) => void
}

/**
 * Git 提交信息接口
 *
 * 用于在上下文菜单中显示 Git 提交记录
 */
interface GitCommit {
	/** 选项类型标识 */
	type: ContextMenuOptionType.Git
	/** 完整的提交哈希值 */
	value: string
	/** 提交标题（显示在菜单中） */
	label: string
	/** 提交描述（短哈希、作者、日期） */
	description: string
}

// ==================== 样式常量 ====================

/** Plan 模式的主题颜色（警告色/橙色） */
const PLAN_MODE_COLOR = "var(--vscode-activityWarningBadge-background)"
/** Act 模式的主题颜色（焦点边框色/蓝色） */
const ACT_MODE_COLOR = "var(--vscode-focusBorder)"

// ==================== Styled Components 样式组件 ====================

/**
 * Plan/Act 模式切换开关容器
 * 包含两个模式选项和滑动指示器
 */
const SwitchContainer = styled.div<{ disabled: boolean }>`
	display: flex;
	align-items: center;
	background-color: transparent;
	border: 1px solid var(--vscode-input-border);
	border-radius: 12px;
	overflow: hidden;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	transform: scale(1);
	transform-origin: right center;
	margin-left: 0;
	user-select: none; /* 防止文本被选中 */
`

/**
 * 模式切换滑块
 * 根据当前模式在 Plan 和 Act 之间滑动
 */
const Slider = styled.div.withConfig({
	// 过滤自定义属性，避免传递到 DOM
	shouldForwardProp: (prop) => !["isAct", "isPlan"].includes(prop),
})<{ isAct: boolean; isPlan?: boolean }>`
	position: absolute;
	height: 100%;
	width: 50%;
	background-color: ${(props) => (props.isPlan ? PLAN_MODE_COLOR : ACT_MODE_COLOR)};
	transition: transform 0.2s ease;
	transform: translateX(${(props) => (props.isAct ? "100%" : "0%")});
`

/** 底部按钮组容器 - 包含 @、+、服务器、规则等按钮 */
const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px;
	flex: 1;
	min-width: 0;
`

/** 单个按钮内容容器 */
const ButtonContainer = styled.div`
	display: flex;
	align-items: center;
	gap: 3px;
	font-size: 10px;
	white-space: nowrap;
	min-width: 0;
	width: 100%;
`

/** 模型显示区域容器 */
const ModelContainer = styled.div`
	position: relative;
	display: flex;
	flex: 1;
	min-width: 0;
`

/** 模型按钮包装器 - 控制收缩行为 */
const ModelButtonWrapper = styled.div`
	display: inline-flex; /* 收缩到内容大小 */
	min-width: 0; /* 允许收缩 */
	max-width: 100%; /* 不溢出父容器 */
`

/**
 * 模型显示按钮
 * 点击后跳转到 API 设置页面选择模型
 */
const ModelDisplayButton = styled.a<{ isActive?: boolean; disabled?: boolean }>`
	padding: 0px 0px;
	height: 20px;
	width: 100%;
	min-width: 0;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	text-decoration: ${(props) => (props.isActive ? "underline" : "none")};
	color: ${(props) => (props.isActive ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)")};
	display: flex;
	align-items: center;
	font-size: 10px;
	outline: none;
	user-select: none;
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	pointer-events: ${(props) => (props.disabled ? "none" : "auto")};

	&:hover,
	&:focus {
		color: ${(props) => (props.disabled ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
		text-decoration: ${(props) => (props.disabled ? "none" : "underline")};
		outline: none;
	}

	&:active {
		color: ${(props) => (props.disabled ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
		text-decoration: ${(props) => (props.disabled ? "none" : "underline")};
		outline: none;
	}

	&:focus-visible {
		outline: none;
	}
`

/** 模型名称文本内容 - 处理文本溢出 */
const ModelButtonContent = styled.div`
	width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`

// ==================== 主组件定义 ====================

/**
 * ChatTextArea 聊天输入框组件
 *
 * 这是 Cline 聊天界面的核心输入组件，支持：
 * - 多行文本输入与自动高度调整
 * - @ 提及（文件、文件夹、Git 提交、终端输出等）
 * - / 斜杠命令（预定义工作流）
 * - 图片/文件拖放和粘贴
 * - Plan/Act 模式切换
 * - 语法高亮显示
 *
 * 使用 forwardRef 以支持父组件获取 textarea 引用
 */
const ChatTextArea = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
	(
		{
			inputValue,
			setInputValue,
			sendingDisabled,
			placeholderText,
			selectedFiles,
			selectedImages,
			setSelectedImages,
			setSelectedFiles,
			onSend,
			onSelectFilesAndImages,
			shouldDisableFilesAndImages,
			onHeightChange,
			onFocusChange,
		},
		ref,
	) => {
		// ==================== 扩展状态获取 ====================
		const {
			mode, // 当前模式：plan 或 act
			apiConfiguration, // API 配置信息
			openRouterModels, // OpenRouter 可用模型列表
			platform, // 当前运行平台
			localWorkflowToggles, // 本地工作流开关状态
			globalWorkflowToggles, // 全局工作流开关状态
			remoteWorkflowToggles, // 远程工作流开关状态
			remoteConfigSettings, // 远程配置设置
			navigateToSettingsModelPicker, // 导航到模型选择器的函数
			mcpServers, // MCP 服务器列表
		} = useExtensionState()

		// ==================== 组件状态定义 ====================

		// 文本框焦点状态
		const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)
		// 拖放状态 - 是否有文件正在拖动到输入区域
		const [isDraggingOver, setIsDraggingOver] = useState(false)
		// Git 提交记录列表 - 用于 @ 提及 Git 提交
		const [gitCommits, setGitCommits] = useState<GitCommit[]>([])

		// ===== 斜杠命令菜单状态 =====
		/** 是否显示斜杠命令菜单 */
		const [showSlashCommandsMenu, setShowSlashCommandsMenu] = useState(false)
		/** 当前选中的斜杠命令索引 */
		const [selectedSlashCommandsIndex, setSelectedSlashCommandsIndex] = useState(0)
		/** 斜杠命令搜索查询 */
		const [slashCommandsQuery, setSlashCommandsQuery] = useState("")
		/** 斜杠命令菜单容器引用 */
		const slashCommandsMenuContainerRef = useRef<HTMLDivElement>(null)

		// ===== 布局相关状态 =====
		/** 缩略图区域高度 - 用于计算文本框 padding */
		const [thumbnailsHeight, setThumbnailsHeight] = useState(0)
		/** 文本框基础高度 - 用于定位发送按钮 */
		const [textAreaBaseHeight, setTextAreaBaseHeight] = useState<number | undefined>(undefined)

		// ===== 上下文菜单状态 =====
		/** 是否显示上下文菜单（@ 提及） */
		const [showContextMenu, setShowContextMenu] = useState(false)
		/** 当前光标位置 */
		const [cursorPosition, setCursorPosition] = useState(0)
		/** 搜索查询文本 */
		const [searchQuery, setSearchQuery] = useState("")
		/** 文本框 DOM 引用 */
		const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
		/** 鼠标是否按下在菜单上 - 防止失焦关闭菜单 */
		const [isMouseDownOnMenu, setIsMouseDownOnMenu] = useState(false)
		/** 高亮层 DOM 引用 - 用于渲染语法高亮 */
		const highlightLayerRef = useRef<HTMLDivElement>(null)
		/** 当前选中的菜单项索引 */
		const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
		/** 当前选中的上下文类型（文件/文件夹/Git 等） */
		const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)

		// ===== 删除行为追踪状态 =====
		/** 是否刚删除了 @提及 后的空格 - 用于实现两次退格删除提及 */
		const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
		/** 是否刚删除了 /命令 后的空格 */
		const [justDeletedSpaceAfterSlashCommand, setJustDeletedSpaceAfterSlashCommand] = useState(false)
		/** 预期的光标位置 - 用于在状态更新后设置光标 */
		const [intendedCursorPosition, setIntendedCursorPosition] = useState<number | null>(null)
		/** 上下文菜单容器引用 */
		const contextMenuContainerRef = useRef<HTMLDivElement>(null)

		// ===== 工具提示和待处理状态 =====
		/** 当前显示工具提示的模式 */
		const [shownTooltipMode, setShownTooltipMode] = useState<Mode | null>(null)
		/** 待插入的文件路径队列 - 用于批量拖放文件 */
		const [pendingInsertions, setPendingInsertions] = useState<string[]>([])
		/** Shift 键长按计时器引用 */
		const _shiftHoldTimerRef = useRef<NodeJS.Timeout | null>(null)

		// ===== 错误提示状态 =====
		/** 是否显示不支持文件类型的错误 */
		const [showUnsupportedFileError, setShowUnsupportedFileError] = useState(false)
		/** 不支持文件错误计时器引用 */
		const unsupportedFileTimerRef = useRef<NodeJS.Timeout | null>(null)
		/** 是否显示图片尺寸超限错误 */
		const [showDimensionError, setShowDimensionError] = useState(false)
		/** 图片尺寸错误计时器引用 */
		const dimensionErrorTimerRef = useRef<NodeJS.Timeout | null>(null)

		// ===== 文件搜索状态 =====
		/** 文件搜索结果列表 */
		const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
		/** 搜索加载中状态 */
		const [searchLoading, setSearchLoading] = useState(false)
		/** 获取平台特定的 Meta 键字符（⌘ 或 Ctrl） */
		const [, metaKeyChar] = useMetaKeyDetection(platform)

		// ==================== 副作用 Hooks ====================

		/**
		 * 获取 Git 提交记录
		 *
		 * 当用户选择 Git 类型或输入看起来像 Git 哈希的内容时，
		 * 从后端获取匹配的 Git 提交记录用于上下文菜单显示。
		 */
		useEffect(() => {
			// 检查是否选择了 Git 类型，或者输入内容匹配十六进制哈希格式
			if (selectedType === ContextMenuOptionType.Git || /^[a-f0-9]+$/i.test(searchQuery)) {
				FileServiceClient.searchCommits(StringRequest.create({ value: searchQuery || "" }))
					.then((response) => {
						if (response.commits) {
							// 将后端响应转换为 GitCommit 格式
							const commits: GitCommit[] = response.commits.map(
								(commit: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
									type: ContextMenuOptionType.Git,
									value: commit.hash,
									label: commit.subject,
									description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
								}),
							)
							setGitCommits(commits)
						}
					})
					.catch((error) => {
						console.error("Error searching commits:", error)
					})
			}
		}, [selectedType, searchQuery])

		/**
		 * 上下文菜单的查询项列表
		 *
		 * 合并固定选项（Problems、Terminal）和动态获取的 Git 提交记录
		 */
		const queryItems = useMemo(() => {
			return [
				{ type: ContextMenuOptionType.Problems, value: "problems" }, // 诊断问题
				{ type: ContextMenuOptionType.Terminal, value: "terminal" }, // 终端输出
				...gitCommits, // Git 提交记录
			]
		}, [gitCommits])

		/**
		 * 点击外部关闭上下文菜单
		 *
		 * 当用户点击上下文菜单外部区域时，自动关闭菜单
		 */
		useEffect(() => {
			const handleClickOutside = (event: MouseEvent) => {
				if (contextMenuContainerRef.current && !contextMenuContainerRef.current.contains(event.target as Node)) {
					setShowContextMenu(false)
				}
			}

			if (showContextMenu) {
				document.addEventListener("mousedown", handleClickOutside)
			}

			return () => {
				document.removeEventListener("mousedown", handleClickOutside)
			}
		}, [showContextMenu, setShowContextMenu])

		/**
		 * 点击外部关闭斜杠命令菜单
		 *
		 * 当用户点击斜杠命令菜单外部区域时，自动关闭菜单
		 */
		useEffect(() => {
			const handleClickOutsideSlashMenu = (event: MouseEvent) => {
				if (
					slashCommandsMenuContainerRef.current &&
					!slashCommandsMenuContainerRef.current.contains(event.target as Node)
				) {
					setShowSlashCommandsMenu(false)
				}
			}

			if (showSlashCommandsMenu) {
				document.addEventListener("mousedown", handleClickOutsideSlashMenu)
			}

			return () => {
				document.removeEventListener("mousedown", handleClickOutsideSlashMenu)
			}
		}, [showSlashCommandsMenu])

		// ==================== 回调函数定义 ====================

		/**
		 * 处理上下文菜单项选择
		 *
		 * 当用户从 @ 提及菜单中选择一个选项时调用。
		 * 根据选项类型执行不同的操作：
		 * - 文件/文件夹/Git：如果没有具体值，进入该类型的搜索模式；否则插入提及
		 * - URL/Problems/Terminal：直接插入对应的提及
		 *
		 * @param type - 选择的选项类型
		 * @param value - 选项的具体值（可选）
		 */
		const handleMentionSelect = useCallback(
			(type: ContextMenuOptionType, value?: string) => {
				// 忽略"无结果"选项的点击
				if (type === ContextMenuOptionType.NoResults) {
					return
				}

				// 处理需要进一步选择的类型（文件、文件夹、Git）
				if (
					type === ContextMenuOptionType.File ||
					type === ContextMenuOptionType.Folder ||
					type === ContextMenuOptionType.Git
				) {
					// 如果没有具体值，进入该类型的搜索模式
					if (!value) {
						setSelectedType(type)
						setSearchQuery("")
						setSelectedMenuIndex(0)

						// 触发文件搜索以显示初始结果
						if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
							setSearchLoading(true)

							// 将上下文菜单类型映射到文件搜索类型枚举
							let searchType: FileSearchType | undefined
							if (type === ContextMenuOptionType.File) {
								searchType = FileSearchType.FILE
							} else if (type === ContextMenuOptionType.Folder) {
								searchType = FileSearchType.FOLDER
							}

							FileServiceClient.searchFiles(
								FileSearchRequest.create({
									query: "",
									mentionsRequestId: "",
									selectedType: searchType,
								}),
							)
								.then((results) => {
									setFileSearchResults((results.results || []) as SearchResult[])
									setSearchLoading(false)
								})
								.catch((error) => {
									console.error("Error searching files:", error)
									setFileSearchResults([])
									setSearchLoading(false)
								})
						}
						return
					}
				}

				// 关闭菜单并重置状态
				setShowContextMenu(false)
				setSelectedType(null)
				const queryLength = searchQuery.length
				setSearchQuery("")

				if (textAreaRef.current) {
					// 根据类型确定要插入的值
					let insertValue = value || ""
					if (type === ContextMenuOptionType.URL) {
						insertValue = value || ""
					} else if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
						insertValue = value || ""
					} else if (type === ContextMenuOptionType.Problems) {
						insertValue = "problems"
					} else if (type === ContextMenuOptionType.Terminal) {
						insertValue = "terminal"
					} else if (type === ContextMenuOptionType.Git) {
						insertValue = value || ""
					}

					// 在文本中插入提及
					const { newValue, mentionIndex } = insertMention(
						textAreaRef.current.value,
						cursorPosition,
						insertValue,
						queryLength,
					)

					// 更新输入值和光标位置
					setInputValue(newValue)
					const newCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)

					// 滚动到光标位置（通过失焦再聚焦实现）
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus()
						}
					}, 0)
				}
			},
			[setInputValue, cursorPosition, searchQuery],
		)

		/**
		 * 处理斜杠命令选择
		 *
		 * 当用户从 / 命令菜单中选择一个命令时调用。
		 * 将选中的命令插入到输入框中，并设置光标到命令末尾。
		 *
		 * @param command - 选中的斜杠命令对象
		 */
		const handleSlashCommandsSelect = useCallback(
			(command: SlashCommand) => {
				// 关闭菜单并重置状态
				setShowSlashCommandsMenu(false)
				const queryLength = slashCommandsQuery.length
				setSlashCommandsQuery("")

				if (textAreaRef.current) {
					// 在文本中插入斜杠命令
					const { newValue, commandIndex } = insertSlashCommand(
						textAreaRef.current.value,
						command.name,
						queryLength,
						cursorPosition,
					)
					// 将光标移动到命令后的空格之后
					const newCursorPosition = newValue.indexOf(" ", commandIndex + 1 + command.name.length) + 1

					setInputValue(newValue)
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)

					// 滚动到光标位置
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus()
						}
					}, 0)
				}
			},
			[setInputValue, slashCommandsQuery, cursorPosition],
		)
		/**
		 * 处理键盘按下事件
		 *
		 * 这是输入框的核心键盘事件处理器，负责处理：
		 * - Cmd/Ctrl+A：全选文本
		 * - 方向键：在菜单中导航
		 * - Enter/Tab：选择菜单项或发送消息
		 * - Escape：关闭菜单
		 * - Backspace：删除 @提及 或 /命令
		 *
		 * @param event - React 键盘事件
		 */
		const handleKeyDown = useCallback(
			(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
				// 处理 Cmd/Ctrl+A 全选快捷键
				const isSelectAllShortcut =
					(event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a"
				if (isSelectAllShortcut) {
					event.preventDefault()
					event.stopPropagation()
					const textArea = event.currentTarget
					textArea.setSelectionRange(0, textArea.value.length)
					setCursorPosition(0)
					return
				}

				// ===== 斜杠命令菜单的键盘导航 =====
				if (showSlashCommandsMenu) {
					// Escape 键关闭菜单
					if (event.key === "Escape") {
						setShowSlashCommandsMenu(false)
						setSlashCommandsQuery("")
						return
					}

					// 上下方向键在命令列表中导航
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						setSelectedSlashCommandsIndex((prevIndex) => {
							const direction = event.key === "ArrowUp" ? -1 : 1
							// 获取匹配当前查询的所有命令
							const allCommands = getMatchingSlashCommands(
								slashCommandsQuery,
								localWorkflowToggles,
								globalWorkflowToggles,
								remoteWorkflowToggles,
								remoteConfigSettings?.remoteGlobalWorkflows,
								mcpServers,
							)

							if (allCommands.length === 0) {
								return prevIndex
							}

							const totalCommandCount = allCommands.length

							// 循环导航 - 从最后一项到第一项，反之亦然
							const newIndex = (prevIndex + direction + totalCommandCount) % totalCommandCount
							return newIndex
						})
						return
					}

					// Enter 或 Tab 键选择当前高亮的命令
					if ((event.key === "Enter" || event.key === "Tab") && selectedSlashCommandsIndex !== -1) {
						event.preventDefault()
						const commands = getMatchingSlashCommands(
							slashCommandsQuery,
							localWorkflowToggles,
							globalWorkflowToggles,
							remoteWorkflowToggles,
							remoteConfigSettings?.remoteGlobalWorkflows,
							mcpServers,
						)
						if (commands.length > 0) {
							handleSlashCommandsSelect(commands[selectedSlashCommandsIndex])
						}
						return
					}
				}
				// ===== 上下文菜单（@ 提及）的键盘导航 =====
				if (showContextMenu) {
					// Escape 键关闭菜单并重置状态
					if (event.key === "Escape") {
						setShowContextMenu(false)
						setSelectedType(null)
						setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
						setSearchQuery("")
						return
					}

					// 上下方向键在选项列表中导航
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						setSelectedMenuIndex((prevIndex) => {
							const direction = event.key === "ArrowUp" ? -1 : 1
							const options = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)
							const optionsLength = options.length

							if (optionsLength === 0) {
								return prevIndex
							}

							// 找出可选择的选项（排除 URL 和无结果提示）
							const selectableOptions = options.filter(
								(option) =>
									option.type !== ContextMenuOptionType.URL && option.type !== ContextMenuOptionType.NoResults,
							)

							if (selectableOptions.length === 0) {
								return -1 // 没有可选择的选项
							}

							// 计算下一个可选择选项的索引
							const currentSelectableIndex = selectableOptions.indexOf(options[prevIndex])

							const newSelectableIndex =
								(currentSelectableIndex + direction + selectableOptions.length) % selectableOptions.length

							// 返回选中选项在原始数组中的索引
							return options.indexOf(selectableOptions[newSelectableIndex])
						})
						return
					}

					// Enter 或 Tab 键选择当前高亮的选项
					if ((event.key === "Enter" || event.key === "Tab") && selectedMenuIndex !== -1) {
						event.preventDefault()
						const selectedOption = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)[
							selectedMenuIndex
						]
						if (
							selectedOption &&
							selectedOption.type !== ContextMenuOptionType.URL &&
							selectedOption.type !== ContextMenuOptionType.NoResults
						) {
							// 如果 label 包含工作区前缀，使用 label；否则使用 value
							const mentionValue = selectedOption.label?.includes(":") ? selectedOption.label : selectedOption.value
							handleMentionSelect(selectedOption.type, mentionValue)
						}
						return
					}
				}

				// ===== Enter 键发送消息 =====
				// Safari 不支持 InputEvent.isComposing（始终为 false），所以需要使用 keyCode === 229 作为后备方案
				// keyCode 229 表示正在使用输入法编辑器（IME）输入
				const isComposing = isSafari ? event.nativeEvent.keyCode === 229 : (event.nativeEvent?.isComposing ?? false)
				if (event.key === "Enter" && !event.shiftKey && !isComposing) {
					event.preventDefault()

					// 只有在发送未被禁用时才发送消息
					if (!sendingDisabled) {
						setIsTextAreaFocused(false)
						onSend()
					}
				}

				// ===== Backspace 键删除 @提及 或 /命令 =====
				// 实现两次退格删除整个提及/命令的行为：
				// 第一次退格删除提及后的空格，第二次退格删除整个提及
				if (event.key === "Backspace" && !isComposing) {
					const charBeforeCursor = inputValue[cursorPosition - 1]
					const charAfterCursor = inputValue[cursorPosition + 1]

					// 检查光标前后是否为空白字符
					const charBeforeIsWhitespace =
						charBeforeCursor === " " || charBeforeCursor === "\n" || charBeforeCursor === "\r\n"
					const charAfterIsWhitespace =
						charAfterCursor === " " || charAfterCursor === "\n" || charAfterCursor === "\r\n"

					// 检查是否正好在 @提及 后的空格位置
					if (
						charBeforeIsWhitespace &&
						inputValue.slice(0, cursorPosition - 1).match(new RegExp(mentionRegex.source + "$"))
					) {
						// 处理 @提及 - 第一次退格：删除空格并标记
						const newCursorPosition = cursorPosition - 1
						if (!charAfterIsWhitespace) {
							event.preventDefault()
							textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
							setCursorPosition(newCursorPosition)
						}
						setCursorPosition(newCursorPosition)
						setJustDeletedSpaceAfterMention(true)
						setJustDeletedSpaceAfterSlashCommand(false)
					} else if (charBeforeIsWhitespace && inputValue.slice(0, cursorPosition - 1).match(slashCommandDeleteRegex)) {
						// 处理 /命令 - 第一次退格：删除空格并标记
						const newCursorPosition = cursorPosition - 1
						if (!charAfterIsWhitespace) {
							event.preventDefault()
							textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
							setCursorPosition(newCursorPosition)
						}
						setCursorPosition(newCursorPosition)
						setJustDeletedSpaceAfterSlashCommand(true)
						setJustDeletedSpaceAfterMention(false)
					}
					// 第二次退格：删除整个 @提及
					else if (justDeletedSpaceAfterMention) {
						const { newText, newPosition } = removeMention(inputValue, cursorPosition)
						if (newText !== inputValue) {
							event.preventDefault()
							setInputValue(newText)
							setIntendedCursorPosition(newPosition)
						}
						setJustDeletedSpaceAfterMention(false)
						setShowContextMenu(false)
					}
					// 第二次退格：删除整个 /命令
					else if (justDeletedSpaceAfterSlashCommand) {
						const { newText, newPosition } = removeSlashCommand(inputValue, cursorPosition)
						if (newText !== inputValue) {
							event.preventDefault()
							setInputValue(newText)
							setIntendedCursorPosition(newPosition)
						}
						setJustDeletedSpaceAfterSlashCommand(false)
						setShowSlashCommandsMenu(false)
					}
					// 默认情况 - 重置标记
					else {
						setJustDeletedSpaceAfterMention(false)
						setJustDeletedSpaceAfterSlashCommand(false)
					}
				}
			},
			[
				onSend,
				showContextMenu,
				searchQuery,
				selectedMenuIndex,
				handleMentionSelect,
				selectedType,
				inputValue,
				cursorPosition,
				setInputValue,
				justDeletedSpaceAfterMention,
				queryItems,
				fileSearchResults,
				showSlashCommandsMenu,
				selectedSlashCommandsIndex,
				slashCommandsQuery,
				handleSlashCommandsSelect,
				sendingDisabled,
			],
		)

		/**
		 * 在状态更新后设置光标位置
		 *
		 * 由于 React 的状态更新是异步的，我们需要在 DOM 更新后
		 * 手动设置光标位置到预期位置
		 */
		useLayoutEffect(() => {
			if (intendedCursorPosition !== null && textAreaRef.current) {
				textAreaRef.current.setSelectionRange(intendedCursorPosition, intendedCursorPosition)
				setIntendedCursorPosition(null) // 应用后重置状态
			}
		}, [inputValue, intendedCursorPosition])

		/**
		 * 处理待插入的文件路径队列
		 *
		 * 当用户批量拖放多个文件时，文件路径会被加入队列，
		 * 然后逐个插入到输入框中
		 */
		useEffect(() => {
			if (pendingInsertions.length === 0 || !textAreaRef.current) {
				return
			}

			// 取出队列中的第一个路径
			const path = pendingInsertions[0]
			const currentTextArea = textAreaRef.current
			const currentValue = currentTextArea.value
			const currentCursorPos =
				intendedCursorPosition ??
				(currentTextArea.selectionStart >= 0 ? currentTextArea.selectionStart : currentValue.length)

			// 直接插入 @提及
			const { newValue, mentionIndex } = insertMentionDirectly(currentValue, currentCursorPos, path)

			setInputValue(newValue)

			// 计算新的光标位置（提及末尾 + 空格）
			const newCursorPosition = mentionIndex + path.length + 2
			setIntendedCursorPosition(newCursorPosition)

			// 从队列中移除已处理的路径
			setPendingInsertions((prev) => prev.slice(1))
		}, [pendingInsertions, setInputValue])

		/** 搜索防抖计时器引用 */
		const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

		/** 当前搜索查询引用 - 用于在异步回调中获取最新值 */
		const currentSearchQueryRef = useRef<string>("")

		/**
		 * 处理输入框内容变化
		 *
		 * 这是输入框的核心变化处理器，负责：
		 * - 更新输入值和光标位置
		 * - 检测是否需要显示 @ 上下文菜单或 / 命令菜单
		 * - 触发文件搜索（带防抖）
		 * - 更新搜索查询
		 *
		 * @param e - React 变化事件
		 */
		const handleInputChange = useCallback(
			(e: React.ChangeEvent<HTMLTextAreaElement>) => {
				const newValue = e.target.value
				const newCursorPosition = e.target.selectionStart
				setInputValue(newValue)
				setCursorPosition(newCursorPosition)

				// 检测是否应该显示上下文菜单或斜杠命令菜单
				let showMenu = shouldShowContextMenu(newValue, newCursorPosition)
				const showSlashCommandsMenu = shouldShowSlashCommandsMenu(newValue, newCursorPosition)

				// 不允许同时显示两个菜单
				// 斜杠命令菜单优先级更高（因为它是更具体的组件）
				if (showSlashCommandsMenu) {
					showMenu = false
				}

				setShowSlashCommandsMenu(showSlashCommandsMenu)
				setShowContextMenu(showMenu)

				if (showSlashCommandsMenu) {
					// Find the slash nearest to cursor (before cursor position)
					const beforeCursor = newValue.slice(0, newCursorPosition)
					const slashIndex = beforeCursor.lastIndexOf("/")
					const query = newValue.slice(slashIndex + 1, newCursorPosition)
					setSlashCommandsQuery(query)
					setSelectedSlashCommandsIndex(0)
				} else {
					setSlashCommandsQuery("")
					setSelectedSlashCommandsIndex(0)
				}

				if (showMenu) {
					const lastAtIndex = newValue.lastIndexOf("@", newCursorPosition - 1)
					const query = newValue.slice(lastAtIndex + 1, newCursorPosition)
					setSearchQuery(query)
					currentSearchQueryRef.current = query

					if (query.length > 0) {
						setSelectedMenuIndex(0)

						// Clear any existing timeout
						if (searchTimeoutRef.current) {
							clearTimeout(searchTimeoutRef.current)
						}

						setSearchLoading(true)

						const searchType =
							selectedType === ContextMenuOptionType.File
								? FileSearchType.FILE
								: selectedType === ContextMenuOptionType.Folder
									? FileSearchType.FOLDER
									: undefined

						// Parse workspace hint from query (e.g., "@frontend:/filename")
						let workspaceHint: string | undefined
						let searchQuery = query
						const workspaceHintMatch = query.match(/^([\w-]+):\/(.*)$/)
						if (workspaceHintMatch) {
							workspaceHint = workspaceHintMatch[1]
							searchQuery = workspaceHintMatch[2]
						}

						// Set a timeout to debounce the search requests
						searchTimeoutRef.current = setTimeout(() => {
							FileServiceClient.searchFiles(
								FileSearchRequest.create({
									query: searchQuery,
									mentionsRequestId: query,
									selectedType: searchType,
									workspaceHint: workspaceHint,
								}),
							)
								.then((results) => {
									setFileSearchResults((results.results || []) as SearchResult[])
									setSearchLoading(false)
								})
								.catch((error) => {
									console.error("Error searching files:", error)
									setFileSearchResults([])
									setSearchLoading(false)
								})
						}, 200) // 200ms debounce
					} else {
						setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
					}
				} else {
					setSearchQuery("")
					setSelectedMenuIndex(-1)
					setFileSearchResults([])
				}
			},
			[setInputValue, setFileSearchResults, selectedType],
		)

		useEffect(() => {
			if (!showContextMenu) {
				setSelectedType(null)
			}
		}, [showContextMenu])

		const handleBlur = useCallback(() => {
			// Only hide the context menu if the user didn't click on it
			if (!isMouseDownOnMenu) {
				setShowContextMenu(false)
				setShowSlashCommandsMenu(false)
			}
			setIsTextAreaFocused(false)
			onFocusChange?.(false) // Call prop on blur
		}, [isMouseDownOnMenu, onFocusChange])

		const showDimensionErrorMessage = useCallback(() => {
			setShowDimensionError(true)
			if (dimensionErrorTimerRef.current) {
				clearTimeout(dimensionErrorTimerRef.current)
			}
			dimensionErrorTimerRef.current = setTimeout(() => {
				setShowDimensionError(false)
				dimensionErrorTimerRef.current = null
			}, 3000)
		}, [])

		const handlePaste = useCallback(
			async (e: React.ClipboardEvent) => {
				const items = e.clipboardData.items

				const pastedText = e.clipboardData.getData("text")
				// Check if the pasted content is a URL, add space after so user can easily delete if they don't want it
				const urlRegex = /^\S+:\/\/\S+$/
				if (urlRegex.test(pastedText.trim())) {
					e.preventDefault()
					const trimmedUrl = pastedText.trim()
					const newValue = inputValue.slice(0, cursorPosition) + trimmedUrl + " " + inputValue.slice(cursorPosition)
					setInputValue(newValue)
					const newCursorPosition = cursorPosition + trimmedUrl.length + 1
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)
					setShowContextMenu(false)

					// Scroll to new cursor position
					// https://stackoverflow.com/questions/29899364/how-do-you-scroll-to-the-position-of-the-cursor-in-a-textarea/40951875#40951875
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus()
						}
					}, 0)
					// NOTE: callbacks dont utilize return function to cleanup, but it's fine since this timeout immediately executes and will be cleaned up by the browser (no chance component unmounts before it executes)

					return
				}

				const acceptedTypes = ["png", "jpeg", "webp"] // supported by anthropic and openrouter (jpg is just a file extension but the image will be recognized as jpeg)
				const imageItems = Array.from(items).filter((item) => {
					const [type, subtype] = item.type.split("/")
					return type === "image" && acceptedTypes.includes(subtype)
				})
				if (!shouldDisableFilesAndImages && imageItems.length > 0) {
					e.preventDefault()
					const imagePromises = imageItems.map((item) => {
						return new Promise<string | null>((resolve) => {
							const blob = item.getAsFile()
							if (!blob) {
								resolve(null)
								return
							}
							const reader = new FileReader()
							reader.onloadend = async () => {
								if (reader.error) {
									console.error("Error reading file:", reader.error)
									resolve(null)
								} else {
									const result = reader.result
									if (typeof result === "string") {
										try {
											await getImageDimensions(result)
											resolve(result)
										} catch (error) {
											console.warn((error as Error).message)
											showDimensionErrorMessage()
											resolve(null)
										}
									} else {
										resolve(null)
									}
								}
							}
							reader.readAsDataURL(blob)
						})
					})
					const imageDataArray = await Promise.all(imagePromises)
					const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)
					//.map((dataUrl) => dataUrl.split(",")[1]) // strip the mime type prefix, sharp doesn't need it
					if (dataUrls.length > 0) {
						const filesAndImagesLength = selectedImages.length + selectedFiles.length
						const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

						if (availableSlots > 0) {
							const imagesToAdd = Math.min(dataUrls.length, availableSlots)
							setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
						}
					} else {
						console.warn("No valid images were processed")
					}
				}
			},
			[
				shouldDisableFilesAndImages,
				setSelectedImages,
				selectedImages,
				selectedFiles,
				cursorPosition,
				setInputValue,
				inputValue,
				showDimensionErrorMessage,
			],
		)

		const handleThumbnailsHeightChange = useCallback((height: number) => {
			setThumbnailsHeight(height)
		}, [])

		useEffect(() => {
			if (selectedImages.length === 0 && selectedFiles.length === 0) {
				setThumbnailsHeight(0)
			}
		}, [selectedImages, selectedFiles])

		const handleMenuMouseDown = useCallback(() => {
			setIsMouseDownOnMenu(true)
		}, [])

		const updateHighlights = useCallback(() => {
			if (!textAreaRef.current || !highlightLayerRef.current) {
				return
			}

			let processedText = textAreaRef.current.value

			processedText = processedText
				.replace(/\n$/, "\n\n")
				.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)
				// highlight @mentions
				.replace(mentionRegexGlobal, '<mark class="mention-context-textarea-highlight">$&</mark>')

			// Highlight only the FIRST valid /slash-command in the text
			// Only one slash command is processed per message, so we only highlight the first one
			slashCommandRegexGlobal.lastIndex = 0
			let hasHighlightedSlashCommand = false
			processedText = processedText.replace(slashCommandRegexGlobal, (match, prefix, command) => {
				// Only highlight the first valid slash command
				if (hasHighlightedSlashCommand) {
					return match
				}

				// Extract just the command name (without the slash)
				const commandName = command.substring(1)
				const isValidCommand = validateSlashCommand(
					commandName,
					localWorkflowToggles,
					globalWorkflowToggles,
					remoteWorkflowToggles,
					remoteConfigSettings?.remoteGlobalWorkflows,
				)

				if (isValidCommand) {
					hasHighlightedSlashCommand = true
					// Keep the prefix (whitespace or empty) and wrap the command in highlight
					return `${prefix}<mark class="mention-context-textarea-highlight">${command}</mark>`
				}
				return match
			})

			highlightLayerRef.current.innerHTML = processedText
			highlightLayerRef.current.scrollTop = textAreaRef.current.scrollTop
			highlightLayerRef.current.scrollLeft = textAreaRef.current.scrollLeft
		}, [localWorkflowToggles, globalWorkflowToggles, remoteWorkflowToggles, remoteConfigSettings])

		useLayoutEffect(() => {
			updateHighlights()
		}, [inputValue, updateHighlights])

		const updateCursorPosition = useCallback(() => {
			if (textAreaRef.current) {
				setCursorPosition(textAreaRef.current.selectionStart)
			}
		}, [])

		const handleKeyUp = useCallback(
			(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
				if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
					updateCursorPosition()
				}
			},
			[updateCursorPosition],
		)

		/**
		 * 切换 Plan/Act 模式
		 *
		 * Plan 模式：Cline 会收集信息并制定计划，但不会直接执行
		 * Act 模式：Cline 会直接执行任务
		 *
		 * 切换时会将当前输入内容一并发送给后端
		 */
		const onModeToggle = useCallback(() => {
			void (async () => {
				// 将当前模式取反
				const convertedProtoMode = mode === "plan" ? PlanActMode.ACT : PlanActMode.PLAN
				const response = await StateServiceClient.togglePlanActModeProto(
					TogglePlanActModeRequest.create({
						mode: convertedProtoMode,
						chatContent: {
							message: inputValue.trim() ? inputValue : undefined,
							images: selectedImages,
							files: selectedFiles,
						},
					}),
				)
				// 模式切换后聚焦输入框
				setTimeout(() => {
					if (response.value) {
						setInputValue("")
					}
					textAreaRef.current?.focus()
				}, 100)
			})()
		}, [mode, inputValue, selectedImages, selectedFiles, setInputValue])

		// 注册 Plan/Act 切换快捷键（重要：不禁用文本输入，允许在输入框中使用）
		useShortcut(usePlatform().togglePlanActKeys, onModeToggle, { disableTextInputs: false })

		const handleContextButtonClick = useCallback(() => {
			// Focus the textarea first
			textAreaRef.current?.focus()

			// If input is empty, just insert @
			if (!inputValue.trim()) {
				const event = {
					target: {
						value: "@",
						selectionStart: 1,
					},
				} as React.ChangeEvent<HTMLTextAreaElement>
				handleInputChange(event)
				updateHighlights()
				return
			}

			// If input ends with space or is empty, just append @
			if (inputValue.endsWith(" ")) {
				const event = {
					target: {
						value: inputValue + "@",
						selectionStart: inputValue.length + 1,
					},
				} as React.ChangeEvent<HTMLTextAreaElement>
				handleInputChange(event)
				updateHighlights()
				return
			}

			// Otherwise add space then @
			const event = {
				target: {
					value: inputValue + " @",
					selectionStart: inputValue.length + 2,
				},
			} as React.ChangeEvent<HTMLTextAreaElement>
			handleInputChange(event)
			updateHighlights()
		}, [inputValue, handleInputChange, updateHighlights])

		const handleModelButtonClick = () => {
			navigateToSettingsModelPicker({ targetSection: "api-config" })
		}

		/**
		 * 计算当前模型的显示名称
		 *
		 * 根据不同的 API 提供商和模型配置，
		 * 生成格式为 "提供商:模型ID" 的显示字符串
		 */
		const modelDisplayName = useMemo(() => {
			const { selectedProvider, selectedModelId } = normalizeApiConfiguration(apiConfiguration, mode)
			const {
				vsCodeLmModelSelector,
				togetherModelId,
				lmStudioModelId,
				ollamaModelId,
				liteLlmModelId,
				requestyModelId,
				vercelAiGatewayModelId,
			} = getModeSpecificFields(apiConfiguration, mode)
			const unknownModel = "unknown"

			if (!apiConfiguration) {
				return unknownModel
			}

			// 根据不同提供商返回相应的模型名称格式
			switch (selectedProvider) {
				case "cline":
					return `${selectedProvider}:${selectedModelId}`
				case "openai":
					return `openai-compat:${selectedModelId}`
				case "vscode-lm":
					return `vscode-lm:${vsCodeLmModelSelector ? `${vsCodeLmModelSelector.vendor ?? ""}/${vsCodeLmModelSelector.family ?? ""}` : unknownModel}`
				case "together":
					return `${selectedProvider}:${togetherModelId}`
				case "lmstudio":
					return `${selectedProvider}:${lmStudioModelId}`
				case "ollama":
					return `${selectedProvider}:${ollamaModelId}`
				case "litellm":
					return `${selectedProvider}:${liteLlmModelId}`
				case "requesty":
					return `${selectedProvider}:${requestyModelId}`
				case "vercel-ai-gateway":
					return `${selectedProvider}:${vercelAiGatewayModelId || selectedModelId}`
				case "anthropic":
				case "openrouter":
				default:
					return `${selectedProvider}:${selectedModelId}`
			}
		}, [apiConfiguration, mode])

		// Function to show error message for unsupported files for drag and drop
		const showUnsupportedFileErrorMessage = () => {
			// Show error message for unsupported files
			setShowUnsupportedFileError(true)

			// Clear any existing timer
			if (unsupportedFileTimerRef.current) {
				clearTimeout(unsupportedFileTimerRef.current)
			}

			// Set timer to hide error after 3 seconds
			unsupportedFileTimerRef.current = setTimeout(() => {
				setShowUnsupportedFileError(false)
				unsupportedFileTimerRef.current = null
			}, 3000)
		}

		const handleDragEnter = (e: React.DragEvent) => {
			e.preventDefault()
			setIsDraggingOver(true)

			// Check if files are being dragged
			if (e.dataTransfer.types.includes("Files")) {
				// Check if any of the files are not images
				const items = Array.from(e.dataTransfer.items)
				const hasNonImageFile = items.some((item) => {
					if (item.kind === "file") {
						const type = item.type.split("/")[0]
						return type !== "image"
					}
					return false
				})

				if (hasNonImageFile) {
					showUnsupportedFileErrorMessage()
				}
			}
		}
		/**
		 * Handles the drag over event to allow dropping.
		 * Prevents the default behavior to enable drop.
		 *
		 * @param {React.DragEvent} e - The drag event.
		 */
		const onDragOver = (e: React.DragEvent) => {
			e.preventDefault()
			// Ensure state remains true if dragging continues over the element
			if (!isDraggingOver) {
				setIsDraggingOver(true)
			}
		}

		const handleDragLeave = (e: React.DragEvent) => {
			e.preventDefault()
			// Check if the related target is still within the drop zone; prevents flickering
			const dropZone = e.currentTarget as HTMLElement
			if (!dropZone.contains(e.relatedTarget as Node)) {
				setIsDraggingOver(false)
				// Don't clear the error message here, let it time out naturally
			}
		}

		// Effect to detect when drag operation ends outside the component
		useEffect(() => {
			const handleGlobalDragEnd = () => {
				// This will be triggered when the drag operation ends anywhere
				setIsDraggingOver(false)
				// Don't clear error message, let it time out naturally
			}

			document.addEventListener("dragend", handleGlobalDragEnd)

			return () => {
				document.removeEventListener("dragend", handleGlobalDragEnd)
			}
		}, [])

		/**
		 * Handles the drop event for files and text.
		 * Processes dropped images and text, updating the state accordingly.
		 *
		 * @param {React.DragEvent} e - The drop event.
		 */
		const onDrop = async (e: React.DragEvent) => {
			e.preventDefault()
			setIsDraggingOver(false) // Reset state on drop

			// Clear any error message when something is actually dropped
			setShowUnsupportedFileError(false)
			if (unsupportedFileTimerRef.current) {
				clearTimeout(unsupportedFileTimerRef.current)
				unsupportedFileTimerRef.current = null
			}

			// --- 1. VSCode Explorer Drop Handling ---
			let uris: string[] = []
			const resourceUrlsData = e.dataTransfer.getData("resourceurls")
			const vscodeUriListData = e.dataTransfer.getData("application/vnd.code.uri-list")

			// 1a. Try 'resourceurls' first (used for multi-select)
			if (resourceUrlsData) {
				try {
					uris = JSON.parse(resourceUrlsData)
					uris = uris.map((uri) => decodeURIComponent(uri))
				} catch (error) {
					console.error("Failed to parse resourceurls JSON:", error)
					uris = [] // Reset if parsing failed
				}
			}

			// 1b. Fallback to 'application/vnd.code.uri-list' (newline separated)
			if (uris.length === 0 && vscodeUriListData) {
				uris = vscodeUriListData.split("\n").map((uri) => uri.trim())
			}

			// 1c. Filter for valid schemes (file or vscode-file) and non-empty strings
			const validUris = uris.filter(
				(uri) => uri && (uri.startsWith("vscode-file:") || uri.startsWith("file:") || uri.startsWith("vscode-remote:")),
			)

			if (validUris.length > 0) {
				setPendingInsertions([])
				let initialCursorPos = inputValue.length
				if (textAreaRef.current) {
					initialCursorPos = textAreaRef.current.selectionStart
				}
				setIntendedCursorPosition(initialCursorPos)

				FileServiceClient.getRelativePaths(RelativePathsRequest.create({ uris: validUris }))
					.then((response) => {
						if (response.paths.length > 0) {
							setPendingInsertions((prev) => [...prev, ...response.paths])
						}
					})
					.catch((error) => {
						console.error("Error getting relative paths:", error)
					})
				return
			}

			const text = e.dataTransfer.getData("text")
			if (text) {
				handleTextDrop(text)
				return
			}

			// --- 3. Image Drop Handling ---
			// Only proceed if it wasn't a VSCode resource or plain text drop
			const files = Array.from(e.dataTransfer.files)
			const acceptedTypes = ["png", "jpeg", "webp"]
			const imageFiles = files.filter((file) => {
				const [type, subtype] = file.type.split("/")
				return type === "image" && acceptedTypes.includes(subtype)
			})

			if (shouldDisableFilesAndImages || imageFiles.length === 0) {
				return
			}

			const imageDataArray = await readImageFiles(imageFiles)
			const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

			if (dataUrls.length > 0) {
				const filesAndImagesLength = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

				if (availableSlots > 0) {
					const imagesToAdd = Math.min(dataUrls.length, availableSlots)
					setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
				}
			} else {
				console.warn("No valid images were processed")
			}
		}

		/**
		 * Handles the drop event for text.
		 * Inserts the dropped text at the current cursor position.
		 *
		 * @param {string} text - The dropped text.
		 */
		const handleTextDrop = (text: string) => {
			const newValue = inputValue.slice(0, cursorPosition) + text + inputValue.slice(cursorPosition)
			setInputValue(newValue)
			const newCursorPosition = cursorPosition + text.length
			setCursorPosition(newCursorPosition)
			setIntendedCursorPosition(newCursorPosition)
		}

		/**
		 * Reads image files and returns their data URLs.
		 * Uses FileReader to read the files as data URLs.
		 *
		 * @param {File[]} imageFiles - The image files to read.
		 * @returns {Promise<(string | null)[]>} - A promise that resolves to an array of data URLs or null values.
		 */
		const readImageFiles = (imageFiles: File[]): Promise<(string | null)[]> => {
			return Promise.all(
				imageFiles.map(
					(file) =>
						new Promise<string | null>((resolve) => {
							const reader = new FileReader()
							reader.onloadend = async () => {
								// Make async
								if (reader.error) {
									console.error("Error reading file:", reader.error)
									resolve(null)
								} else {
									const result = reader.result
									if (typeof result === "string") {
										try {
											await getImageDimensions(result) // Check dimensions
											resolve(result)
										} catch (error) {
											console.warn((error as Error).message)
											showDimensionErrorMessage() // Show error to user
											resolve(null) // Don't add this image
										}
									} else {
										resolve(null)
									}
								}
							}
							reader.readAsDataURL(file)
						}),
				),
			)
		}
		// Replace Meta with the platform specific key and uppercase the command letter.
		const togglePlanActKeys = usePlatform()
			.togglePlanActKeys.replace("Meta", metaKeyChar)
			.replace(/.$/, (match) => match.toUpperCase())

		return (
			<div>
				<div
					className="relative flex transition-colors ease-in-out duration-100 px-3.5 py-2.5"
					onDragEnter={handleDragEnter}
					onDragLeave={handleDragLeave}
					onDragOver={onDragOver}
					onDrop={onDrop}>
					{showDimensionError && (
						<div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
							<span className="text-error font-bold text-xs text-center">Image dimensions exceed 7500px</span>
						</div>
					)}
					{showUnsupportedFileError && (
						<div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
							<span className="text-error font-bold text-xs">Files other than images are currently disabled</span>
						</div>
					)}
					{showSlashCommandsMenu && (
						<div ref={slashCommandsMenuContainerRef}>
							<SlashCommandMenu
								globalWorkflowToggles={globalWorkflowToggles}
								localWorkflowToggles={localWorkflowToggles}
								mcpServers={mcpServers}
								onMouseDown={handleMenuMouseDown}
								onSelect={handleSlashCommandsSelect}
								query={slashCommandsQuery}
								remoteWorkflows={remoteConfigSettings?.remoteGlobalWorkflows}
								remoteWorkflowToggles={remoteWorkflowToggles}
								selectedIndex={selectedSlashCommandsIndex}
								setSelectedIndex={setSelectedSlashCommandsIndex}
							/>
						</div>
					)}

					{showContextMenu && (
						<div ref={contextMenuContainerRef}>
							<ContextMenu
								dynamicSearchResults={fileSearchResults}
								isLoading={searchLoading}
								onMouseDown={handleMenuMouseDown}
								onSelect={handleMentionSelect}
								queryItems={queryItems}
								searchQuery={searchQuery}
								selectedIndex={selectedMenuIndex}
								selectedType={selectedType}
								setSelectedIndex={setSelectedMenuIndex}
							/>
						</div>
					)}
					<div
						className={cn(
							"absolute bottom-2.5 top-2.5 whitespace-pre-wrap break-words rounded-xs overflow-hidden bg-input-background",
							isTextAreaFocused ? "left-3.5 right-3.5" : "left-3.5 right-3.5 border border-input-border",
						)}
						ref={highlightLayerRef}
						style={{
							position: "absolute",
							pointerEvents: "none",
							whiteSpace: "pre-wrap",
							wordWrap: "break-word",
							color: "transparent",
							overflow: "hidden",
							fontFamily: "var(--vscode-font-family)",
							fontSize: "var(--vscode-editor-font-size)",
							lineHeight: "var(--vscode-editor-line-height)",
							borderRadius: 2,
							borderLeft: isTextAreaFocused ? 0 : undefined,
							borderRight: isTextAreaFocused ? 0 : undefined,
							borderTop: isTextAreaFocused ? 0 : undefined,
							borderBottom: isTextAreaFocused ? 0 : undefined,
							padding: `9px 28px ${9 + thumbnailsHeight}px 9px`,
						}}
					/>
					<DynamicTextArea
						autoFocus={true}
						data-testid="chat-input"
						maxRows={10}
						minRows={3}
						onBlur={handleBlur}
						onChange={(e) => {
							handleInputChange(e)
							updateHighlights()
						}}
						onFocus={() => {
							setIsTextAreaFocused(true)
							onFocusChange?.(true) // Call prop on focus
						}}
						onHeightChange={(height) => {
							if (textAreaBaseHeight === undefined || height < textAreaBaseHeight) {
								setTextAreaBaseHeight(height)
							}
							onHeightChange?.(height)
						}}
						onKeyDown={handleKeyDown}
						onKeyUp={handleKeyUp}
						onMouseUp={updateCursorPosition}
						onPaste={handlePaste}
						onScroll={() => updateHighlights()}
						onSelect={updateCursorPosition}
						placeholder={showUnsupportedFileError || showDimensionError ? "" : placeholderText}
						ref={(el) => {
							if (typeof ref === "function") {
								ref(el)
							} else if (ref) {
								ref.current = el
							}
							textAreaRef.current = el
						}}
						style={{
							width: "100%",
							boxSizing: "border-box",
							backgroundColor: "transparent",
							color: "var(--vscode-input-foreground)",
							//border: "1px solid var(--vscode-input-border)",
							borderRadius: 2,
							fontFamily: "var(--vscode-font-family)",
							fontSize: "var(--vscode-editor-font-size)",
							lineHeight: "var(--vscode-editor-line-height)",
							resize: "none",
							overflowX: "hidden",
							overflowY: "scroll",
							scrollbarWidth: "none",
							// Since we have maxRows, when text is long enough it starts to overflow the bottom padding, appearing behind the thumbnails. To fix this, we use a transparent border to push the text up instead. (https://stackoverflow.com/questions/42631947/maintaining-a-padding-inside-of-text-area/52538410#52538410)
							// borderTop: "9px solid transparent",
							borderLeft: 0,
							borderRight: 0,
							borderTop: 0,
							borderBottom: `${thumbnailsHeight}px solid transparent`,
							borderColor: "transparent",
							// borderRight: "54px solid transparent",
							// borderLeft: "9px solid transparent", // NOTE: react-textarea-autosize doesn't calculate correct height when using borderLeft/borderRight so we need to use horizontal padding instead
							// Instead of using boxShadow, we use a div with a border to better replicate the behavior when the textarea is focused
							// boxShadow: "0px 0px 0px 1px var(--vscode-input-border)",
							padding: "9px 28px 9px 9px",
							cursor: "text",
							flex: 1,
							zIndex: 1,
							outline:
								isDraggingOver && !showUnsupportedFileError // Only show drag outline if not showing error
									? "2px dashed var(--vscode-focusBorder)"
									: isTextAreaFocused
										? `1px solid ${mode === "plan" ? PLAN_MODE_COLOR : "var(--vscode-focusBorder)"}`
										: "none",
							outlineOffset: isDraggingOver && !showUnsupportedFileError ? "1px" : "0px", // Add offset for drag-over outline
						}}
						value={inputValue}
					/>
					{!inputValue && selectedImages.length === 0 && selectedFiles.length === 0 && (
						<div className="text-xs absolute bottom-5 left-6.5 right-16 text-(--vscode-input-placeholderForeground)/50 whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none z-1">
							Type @ for context, / for slash commands & workflows, hold shift to drag in files/images
						</div>
					)}
					{(selectedImages.length > 0 || selectedFiles.length > 0) && (
						<Thumbnails
							files={selectedFiles}
							images={selectedImages}
							onHeightChange={handleThumbnailsHeightChange}
							setFiles={setSelectedFiles}
							setImages={setSelectedImages}
							style={{
								position: "absolute",
								paddingTop: 4,
								bottom: 14,
								left: 22,
								right: 47, // (54 + 9) + 4 extra padding
								zIndex: 2,
							}}
						/>
					)}
					<div
						className="absolute flex items-end bottom-4.5 right-5 z-10 h-8 text-xs"
						style={{ height: textAreaBaseHeight }}>
						<div className="flex flex-row items-center">
							<div
								className={cn("input-icon-button", { disabled: sendingDisabled }, "codicon codicon-send text-sm")}
								data-testid="send-button"
								onClick={() => {
									if (!sendingDisabled) {
										setIsTextAreaFocused(false)
										onSend()
									}
								}}
							/>
						</div>
					</div>
				</div>
				<div className="flex justify-between items-center -mt-[2px] px-3 pb-2">
					{/* Always render both components, but control visibility with CSS */}
					<div className="relative flex-1 min-w-0 h-5">
						{/* ButtonGroup - always in DOM but visibility controlled */}
						<ButtonGroup className="absolute top-0 left-0 right-0 ease-in-out w-full h-5 z-10 flex items-center">
							<Tooltip>
								<TooltipContent>Add Context</TooltipContent>
								<TooltipTrigger>
									<VSCodeButton
										appearance="icon"
										aria-label="Add Context"
										className="p-0 m-0 flex items-center"
										data-testid="context-button"
										onClick={handleContextButtonClick}>
										<ButtonContainer>
											<AtSignIcon size={12} />
										</ButtonContainer>
									</VSCodeButton>
								</TooltipTrigger>
							</Tooltip>

							<Tooltip>
								<TooltipContent>Add Files & Images</TooltipContent>
								<TooltipTrigger>
									<VSCodeButton
										appearance="icon"
										aria-label="Add Files & Images"
										className="p-0 m-0 flex items-center"
										data-testid="files-button"
										disabled={shouldDisableFilesAndImages}
										onClick={() => {
											if (!shouldDisableFilesAndImages) {
												onSelectFilesAndImages()
											}
										}}>
										<ButtonContainer>
											<PlusIcon size={13} />
										</ButtonContainer>
									</VSCodeButton>
								</TooltipTrigger>
							</Tooltip>

							<ServersToggleModal />

							<ClineRulesToggleModal />

							<ModelContainer>
								<ModelButtonWrapper>
									<ModelDisplayButton
										disabled={false}
										onClick={handleModelButtonClick}
										role="button"
										tabIndex={0}
										title="Open API Settings">
										<ModelButtonContent className="text-xs">{modelDisplayName}</ModelButtonContent>
									</ModelDisplayButton>
								</ModelButtonWrapper>
							</ModelContainer>
						</ButtonGroup>
					</div>
					{/* Tooltip for Plan/Act toggle remains outside the conditional rendering */}
					<Tooltip>
						<TooltipContent
							className="text-xs px-2 flex flex-col gap-1"
							hidden={shownTooltipMode === null}
							side="top">
							{`In ${shownTooltipMode === "act" ? "Act" : "Plan"}  mode, Cline will ${shownTooltipMode === "act" ? "complete the task immediately" : "gather information to architect a plan"}`}
							<p className="text-description/80 text-xs mb-0">
								Toggle w/ <kbd className="text-muted-foreground mx-1">{togglePlanActKeys}</kbd>
							</p>
						</TooltipContent>
						<TooltipTrigger>
							<SwitchContainer data-testid="mode-switch" disabled={false} onClick={onModeToggle}>
								<Slider isAct={mode === "act"} isPlan={mode === "plan"} />
								{["Plan", "Act"].map((m) => (
									<div
										aria-checked={mode === m.toLowerCase()}
										className={cn(
											"pt-0.5 pb-px px-2 z-10 text-xs w-1/2 text-center bg-transparent",
											mode === m.toLowerCase() ? "text-white" : "text-input-foreground",
										)}
										onMouseLeave={() => setShownTooltipMode(null)}
										onMouseOver={() => setShownTooltipMode(m.toLowerCase() === "plan" ? "plan" : "act")}
										role="switch">
										{m}
									</div>
								))}
							</SwitchContainer>
						</TooltipTrigger>
					</Tooltip>
				</div>
			</div>
		)
	},
)

export default ChatTextArea
