/**
 * ============================================================================
 * Task 模块 - Cline AI 代理的核心任务执行引擎
 * ============================================================================
 *
 * 该模块是 Cline 扩展的核心，实现了 AI 代理的完整任务执行生命周期。
 * Task 类管理与 AI 模型的对话循环、工具执行、状态管理和用户交互。
 *
 * 主要职责：
 * - 任务生命周期管理（启动、恢复、暂停、取消）
 * - AI API 请求和响应流处理
 * - 工具调用解析和执行
 * - 消息状态管理和持久化
 * - 与 Webview UI 的双向通信
 * - 检查点管理（支持任务回滚）
 * - 钩子系统集成（任务前/后钩子）
 * - 上下文管理和压缩
 *
 * 核心概念：
 * - Task: 代表一次完整的 AI 对话会话
 * - API Conversation History: 发送给 AI 的对话历史
 * - Cline Messages: 显示在 UI 中的消息
 * - Tool Execution: AI 请求的工具操作
 * - Checkpoint: 任务状态快照，支持回滚
 *
 * 执行流程：
 * 1. 用户提交任务 → startTask()
 * 2. 构建系统提示词 → getSystemPrompt()
 * 3. 发送 API 请求 → recursivelyMakeClineRequests()
 * 4. 解析响应 → parseAssistantMessageV2()
 * 5. 执行工具 → ToolExecutor.execute()
 * 6. 收集反馈 → ask() / say()
 * 7. 循环直到完成或取消
 *
 * ============================================================================
 */

// ============================================================================
// Node.js 内置模块
// ============================================================================
import { setTimeout as setTimeoutPromise } from "node:timers/promises" // Promise 版本的 setTimeout

// ============================================================================
// 核心 API 模块
// ============================================================================
import { ApiHandler, ApiProviderInfo, buildApiHandler } from "@core/api" // API 处理器和构建器
import { ApiStream } from "@core/api/transform/stream" // API 响应流处理

// ============================================================================
// 助手消息解析
// ============================================================================
import { AssistantMessageContent, parseAssistantMessageV2, ToolUse } from "@core/assistant-message" // AI 响应解析

// ============================================================================
// 上下文管理模块
// ============================================================================
import { ContextManager } from "@core/context/context-management/ContextManager" // 上下文管理器
import { checkContextWindowExceededError } from "@core/context/context-management/context-error-handling" // 上下文窗口超限检查
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils" // 上下文窗口信息
import { EnvironmentContextTracker } from "@core/context/context-tracking/EnvironmentContextTracker" // 环境上下文追踪
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker" // 文件上下文追踪
import { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker" // 模型上下文追踪

// ============================================================================
// 规则和指令模块
// ============================================================================
import {
	getGlobalClineRules,
	getLocalClineRules,
	refreshClineRulesToggles,
} from "@core/context/instructions/user-instructions/cline-rules" // Cline 规则管理
import {
	getLocalAgentsRules,
	getLocalCursorRules,
	getLocalWindsurfRules,
	refreshExternalRulesToggles,
} from "@core/context/instructions/user-instructions/external-rules" // 外部规则集成

// ============================================================================
// 控制器通信
// ============================================================================
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage" // 部分消息事件发送

// ============================================================================
// 钩子系统
// ============================================================================
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils" // 钩子启用状态检查
import { executePreCompactHookWithCleanup, HookCancellationError, HookExecution } from "@core/hooks/precompact-executor" // 预压缩钩子执行

// ============================================================================
// 忽略和权限控制
// ============================================================================
import { ClineIgnoreController } from "@core/ignore/ClineIgnoreController" // .clineignore 文件控制
import { CommandPermissionController } from "@core/permissions" // 命令权限控制

// ============================================================================
// 提示词和响应格式化
// ============================================================================
import { parseMentions } from "@core/mentions" // @mentions 解析
import { summarizeTask } from "@core/prompts/contextManagement" // 任务摘要生成
import { formatResponse } from "@core/prompts/responses" // 响应格式化
import { parseSlashCommands } from "@core/slash-commands" // 斜杠命令解析

// ============================================================================
// 存储模块
// ============================================================================
import {
	ensureRulesDirectoryExists,
	ensureTaskDirectoryExists,
	GlobalFileNames,
	getSavedApiConversationHistory,
	getSavedClineMessages,
} from "@core/storage/disk" // 磁盘存储操作

// ============================================================================
// 任务锁定
// ============================================================================
import { releaseTaskLock } from "@core/task/TaskLockUtils" // 任务锁释放

// ============================================================================
// 工作区管理
// ============================================================================
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils" // 多根工作区检测
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager" // 工作区根管理器

// ============================================================================
// 检查点管理
// ============================================================================
import { buildCheckpointManager, shouldUseMultiRoot } from "@integrations/checkpoints/factory" // 检查点管理器工厂
import { ensureCheckpointInitialized } from "@integrations/checkpoints/initializer" // 检查点初始化
import { ICheckpointManager } from "@integrations/checkpoints/types" // 检查点管理器接口

// ============================================================================
// 编辑器集成
// ============================================================================
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider" // 差异视图提供者

// ============================================================================
// 其他集成
// ============================================================================
import { formatContentBlockToMarkdown } from "@integrations/misc/export-markdown" // Markdown 导出
import { processFilesIntoText } from "@integrations/misc/extract-text" // 文件内容提取
import { showSystemNotification } from "@integrations/notifications" // 系统通知
import { ITerminalManager } from "@integrations/terminal/types" // 终端管理器接口

// ============================================================================
// 服务层
// ============================================================================
import { BrowserSession } from "@services/browser/BrowserSession" // 浏览器会话管理
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher" // URL 内容获取
import { featureFlagsService } from "@services/feature-flags" // 功能标志服务
import { listFiles } from "@services/glob/list-files" // 文件列表服务
import { McpHub } from "@services/mcp/McpHub" // MCP 服务器中心

// ============================================================================
// 共享类型和工具
// ============================================================================
import { ApiConfiguration } from "@shared/api" // API 配置类型
import { findLast, findLastIndex } from "@shared/array" // 数组工具函数
import { combineApiRequests } from "@shared/combineApiRequests" // API 请求合并
import { combineCommandSequences } from "@shared/combineCommandSequences" // 命令序列合并
import { ClineApiReqCancelReason, ClineApiReqInfo, ClineAsk, ClineMessage, ClineSay } from "@shared/ExtensionMessage" // 消息类型
import { HistoryItem } from "@shared/HistoryItem" // 历史记录项类型
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay } from "@shared/Languages" // 语言设置
import { USER_CONTENT_TAGS } from "@shared/messages/constants" // 用户内容标签
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message" // Proto 消息转换
import { ClineDefaultTool, READ_ONLY_TOOLS } from "@shared/tools" // 工具定义
import { ClineAskResponse } from "@shared/WebviewMessage" // Webview 响应类型

// ============================================================================
// 模型工具函数
// ============================================================================
import {
	isClaude4PlusModelFamily,
	isGPT5ModelFamily,
	isLocalModel,
	isNextGenModelFamily,
	isParallelToolCallingEnabled,
} from "@utils/model-utils" // 模型检测工具
import { arePathsEqual, getDesktopDir } from "@utils/path" // 路径工具
import { filterExistingFiles } from "@utils/tabFiltering" // 标签页文件过滤

// ============================================================================
// 第三方库
// ============================================================================
import cloneDeep from "clone-deep" // 深拷贝
import fs from "fs/promises" // 文件系统异步操作
import Mutex from "p-mutex" // 互斥锁
import pWaitFor from "p-wait-for" // Promise 等待工具
import * as path from "path" // 路径处理
import { ulid } from "ulid" // ULID 生成器

// ============================================================================
// 内部模块
// ============================================================================
import type { SystemPromptContext } from "@/core/prompts/system-prompt" // 系统提示词上下文类型
import { getSystemPrompt } from "@/core/prompts/system-prompt" // 系统提示词生成
import { HostProvider } from "@/hosts/host-provider" // 宿主提供者
import { FileEditProvider } from "@/integrations/editor/FileEditProvider" // 文件编辑提供者
import {
	type CommandExecutionOptions,
	CommandExecutor,
	CommandExecutorCallbacks,
	FullCommandExecutorConfig,
	StandaloneTerminalManager,
} from "@/integrations/terminal" // 终端和命令执行
import { ClineError, ClineErrorType, ErrorService } from "@/services/error" // 错误服务
import { telemetryService } from "@/services/telemetry" // 遥测服务
import { ClineClient } from "@/shared/cline" // Cline 客户端

// ============================================================================
// 消息类型定义
// ============================================================================
import {
	ClineAssistantContent,
	ClineContent,
	ClineImageContentBlock,
	ClineMessageModelInfo,
	ClineStorageMessage,
	ClineTextContentBlock,
	ClineToolResponseContent,
	ClineUserContent,
} from "@/shared/messages" // 各种消息内容类型
import { ApiFormat } from "@/shared/proto/cline/models" // API 格式枚举
import { ShowMessageType } from "@/shared/proto/index.host" // 消息显示类型
import { Logger } from "@/shared/services/Logger" // 日志服务
import { Session } from "@/shared/services/Session" // 会话服务

// ============================================================================
// 本地模块
// ============================================================================
import { RuleContextBuilder } from "../context/instructions/user-instructions/RuleContextBuilder" // 规则上下文构建器
import { ensureLocalClineDirExists } from "../context/instructions/user-instructions/rule-helpers" // 规则目录辅助函数
import { discoverSkills, getAvailableSkills } from "../context/instructions/user-instructions/skills" // 技能发现和获取
import { refreshWorkflowToggles } from "../context/instructions/user-instructions/workflows" // 工作流开关刷新
import { Controller } from "../controller" // 控制器
import { executeHook } from "../hooks/hook-executor" // 钩子执行器
import { StateManager } from "../storage/StateManager" // 状态管理器
import { FocusChainManager } from "./focus-chain" // 焦点链管理器
import { MessageStateHandler } from "./message-state" // 消息状态处理器
import { StreamResponseHandler } from "./StreamResponseHandler" // 流响应处理器
import { TaskState } from "./TaskState" // 任务状态类
import { ToolExecutor } from "./ToolExecutor" // 工具执行器
import { detectAvailableCliTools, extractProviderDomainFromUrl, updateApiReqMsg } from "./utils" // 工具函数
import { buildUserFeedbackContent } from "./utils/buildUserFeedbackContent" // 用户反馈内容构建

// ============================================================================
// 类型导出
// ============================================================================

/**
 * 工具响应类型别名
 * 表示工具执行后返回给 AI 的响应内容
 */
export type ToolResponse = ClineToolResponseContent

/**
 * Task 构造函数参数类型
 *
 * 定义创建 Task 实例所需的所有参数，包括：
 * - 核心依赖（控制器、MCP 服务器中心）
 * - 回调函数（历史更新、状态通知等）
 * - 终端配置（超时、复用、输出限制等）
 * - 工作区信息
 * - 任务数据（提示词、图片、文件或历史记录）
 */
type TaskParams = {
	/** 主控制器实例，用于协调扩展各组件 */
	controller: Controller
	/** MCP 服务器中心，管理 MCP 服务器连接 */
	mcpHub: McpHub
	/** 任务历史更新回调 */
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	/** 状态更新到 Webview 的回调 */
	postStateToWebview: () => Promise<void>
	/** 从任务 ID 重新初始化任务的回调 */
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	/** 取消任务的回调 */
	cancelTask: () => Promise<void>
	/** Shell 集成超时时间（毫秒） */
	shellIntegrationTimeout: number
	/** 是否启用终端复用 */
	terminalReuseEnabled: boolean
	/** 终端输出行数限制 */
	terminalOutputLineLimit: number
	/** 默认终端配置文件 */
	defaultTerminalProfile: string
	/** VSCode 终端执行模式：vscodeTerminal（可见）或 backgroundExec（后台） */
	vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	/** 当前工作目录 */
	cwd: string
	/** 状态管理器实例 */
	stateManager: StateManager
	/** 工作区管理器（可选） */
	workspaceManager?: WorkspaceRootManager
	/** 任务描述文本（新任务时提供） */
	task?: string
	/** 附加图片路径数组（新任务时提供） */
	images?: string[]
	/** 附加文件路径数组（新任务时提供） */
	files?: string[]
	/** 历史记录项（恢复任务时提供） */
	historyItem?: HistoryItem
	/** 任务唯一标识符 */
	taskId: string
	/** 是否已获取任务锁 */
	taskLockAcquired: boolean
}

/**
 * Task 类 - Cline AI 代理的核心任务执行引擎
 *
 * 该类是 Cline 扩展最核心的组件，负责管理 AI 代理的完整执行生命周期。
 * 它协调 API 调用、工具执行、消息管理和用户交互。
 *
 * 主要功能：
 * - 任务启动和恢复
 * - AI API 请求管理
 * - 工具调用解析和执行
 * - 消息状态管理
 * - 检查点创建和回滚
 * - 钩子系统集成
 * - 上下文压缩和管理
 *
 * 线程安全：
 * - 使用 Mutex 保护所有状态修改
 * - 防止 TOCTOU（Time-of-Check-Time-of-Use）竞态条件
 *
 * 生命周期：
 * - 由 Controller.initTask() 创建
 * - 通过 startTask() 或 resumeTaskFromHistory() 启动
 * - 通过 abortTask() 终止
 * - 任务完成后由 Controller 清理
 */
export class Task {
	// ========================================================================
	// 核心任务变量
	// ========================================================================

	/**
	 * 任务唯一标识符
	 * 通常是时间戳，用于关联任务文件和历史记录
	 */
	readonly taskId: string

	/**
	 * ULID (Universally Unique Lexicographically Sortable Identifier)
	 * 用于遥测和日志追踪，按时间排序的唯一标识
	 */
	readonly ulid: string

	/**
	 * 任务是否被收藏
	 * 收藏的任务会在历史列表中置顶显示
	 */
	private taskIsFavorited?: boolean

	/**
	 * 当前工作目录
	 * 所有相对路径都基于此目录解析
	 */
	private cwd: string

	/**
	 * 任务初始化开始时间
	 * 用于性能监控和遥测
	 */
	private taskInitializationStartTime: number

	/**
	 * 任务状态对象
	 * 包含所有运行时状态（流式传输、中止、错误等）
	 */
	taskState: TaskState

	// ========================================================================
	// 并发控制
	// ========================================================================

	/**
	 * 状态修改互斥锁
	 * 所有状态修改都必须通过此锁，防止竞态条件
	 */
	private stateMutex = new Mutex()

	/**
	 * 使用独占锁执行函数
	 *
	 * 任何状态修改都应使用此方法，确保线程安全。
	 * 防止多个异步操作同时修改状态导致的竞态条件。
	 *
	 * @param fn - 要执行的函数
	 * @returns 函数执行结果
	 */
	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	// ========================================================================
	// 钩子执行状态管理（原子操作）
	// ========================================================================

	/**
	 * 原子设置活动钩子执行状态
	 *
	 * 使用互斥锁保护，防止设置钩子执行状态时的 TOCTOU 竞态条件。
	 * 公开给 ToolExecutor 使用。
	 *
	 * @param hookExecution - 钩子执行信息
	 */
	public async setActiveHookExecution(hookExecution: NonNullable<typeof this.taskState.activeHookExecution>): Promise<void> {
		await this.withStateLock(() => {
			this.taskState.activeHookExecution = hookExecution
		})
	}

	/**
	 * 原子清除活动钩子执行状态
	 *
	 * 使用互斥锁保护，防止清除钩子执行状态时的 TOCTOU 竞态条件。
	 * 公开给 ToolExecutor 使用。
	 */
	public async clearActiveHookExecution(): Promise<void> {
		await this.withStateLock(() => {
			this.taskState.activeHookExecution = undefined
		})
	}

	/**
	 * 原子读取活动钩子执行状态
	 *
	 * 使用互斥锁保护，返回当前状态的快照以防止 TOCTOU 竞态条件。
	 * 公开给 ToolExecutor 使用。
	 *
	 * @returns 当前钩子执行状态的快照
	 */
	public async getActiveHookExecution(): Promise<typeof this.taskState.activeHookExecution> {
		return await this.withStateLock(() => {
			return this.taskState.activeHookExecution
		})
	}

	// ========================================================================
	// 核心依赖
	// ========================================================================

	/**
	 * 主控制器引用
	 * 用于访问全局服务和协调扩展组件
	 */
	private controller: Controller

	/**
	 * MCP 服务器中心
	 * 管理所有 MCP (Model Context Protocol) 服务器连接
	 */
	private mcpHub: McpHub

	// ========================================================================
	// 服务处理器
	// ========================================================================

	/**
	 * API 处理器
	 * 负责与 AI 模型 API 的通信（OpenRouter、Anthropic、OpenAI 等）
	 */
	api: ApiHandler

	/**
	 * 终端管理器
	 * 管理命令执行的终端实例
	 */
	terminalManager: ITerminalManager

	/**
	 * URL 内容获取器
	 * 用于获取网页内容
	 */
	private urlContentFetcher: UrlContentFetcher

	/**
	 * 浏览器会话
	 * 管理浏览器自动化操作（截图、导航等）
	 */
	browserSession: BrowserSession

	/**
	 * 上下文管理器
	 * 管理对话上下文的压缩和截断
	 */
	contextManager: ContextManager

	/**
	 * 差异视图提供者
	 * 显示文件编辑的差异对比
	 */
	private diffViewProvider: DiffViewProvider

	/**
	 * 检查点管理器
	 * 创建和恢复任务状态快照
	 */
	public checkpointManager?: ICheckpointManager

	/**
	 * 初始检查点提交 Promise
	 * 用于等待初始检查点创建完成
	 */
	private initialCheckpointCommitPromise?: Promise<string | undefined>

	/**
	 * Cline 忽略控制器
	 * 处理 .clineignore 文件规则
	 */
	private clineIgnoreController: ClineIgnoreController

	/**
	 * 命令权限控制器
	 * 管理命令执行的权限检查
	 */
	private commandPermissionController: CommandPermissionController

	/**
	 * 工具执行器
	 * 执行 AI 请求的各种工具操作
	 */
	private toolExecutor: ToolExecutor

	/**
	 * 是否使用原生工具调用
	 *
	 * 用于确定如何格式化响应。
	 * 例如：使用原生工具调用时不添加 noToolsUsed 响应，
	 * 因为工具调用的预期格式不同。
	 */
	private useNativeToolCalls = false

	/**
	 * 流响应处理器
	 * 处理 AI API 的流式响应
	 */
	private streamHandler: StreamResponseHandler

	/**
	 * 终端执行模式
	 * - vscodeTerminal: 使用可见的 VSCode 终端
	 * - backgroundExec: 在后台执行命令
	 */
	private terminalExecutionMode: "vscodeTerminal" | "backgroundExec"

	// ========================================================================
	// 元数据追踪器
	// ========================================================================

	/**
	 * 文件上下文追踪器
	 * 追踪任务中访问和修改的文件
	 */
	private fileContextTracker: FileContextTracker

	/**
	 * 模型上下文追踪器
	 * 追踪使用的模型和 token 消耗
	 */
	private modelContextTracker: ModelContextTracker

	/**
	 * 环境上下文追踪器
	 * 记录运行环境信息（OS、工作区等）
	 */
	private environmentContextTracker: EnvironmentContextTracker

	// ========================================================================
	// 焦点链管理
	// ========================================================================

	/**
	 * 焦点链管理器
	 * 管理任务的焦点和进度追踪（可选功能）
	 */
	private FocusChainManager?: FocusChainManager

	// ========================================================================
	// 回调函数
	// ========================================================================

	/**
	 * 任务历史更新回调
	 * 将任务信息保存到历史记录
	 */
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>

	/**
	 * 状态推送到 Webview 的回调
	 * 通知 UI 更新显示
	 */
	private postStateToWebview: () => Promise<void>

	/**
	 * 从任务 ID 重新初始化任务的回调
	 * 用于任务切换
	 */
	private reinitExistingTaskFromId: (taskId: string) => Promise<void>

	/**
	 * 取消任务的回调
	 * 通知控制器执行取消流程
	 */
	private cancelTask: () => Promise<void>

	// ========================================================================
	// 状态管理
	// ========================================================================

	/**
	 * 状态管理器
	 * 管理全局状态、工作区状态和任务设置
	 */
	private stateManager: StateManager

	/**
	 * 消息状态处理器
	 * 管理 Cline 消息和 API 对话历史
	 */
	messageStateHandler: MessageStateHandler

	// ========================================================================
	// 工作区管理
	// ========================================================================

	/**
	 * 工作区管理器
	 * 管理多根工作区的检测和操作
	 */
	workspaceManager?: WorkspaceRootManager

	// ========================================================================
	// 任务锁定
	// ========================================================================

	/**
	 * 任务锁获取状态
	 * 标识是否成功获取了任务锁（SQLite 实现）
	 */
	private taskLockAcquired: boolean

	// ========================================================================
	// 命令执行
	// ========================================================================

	/**
	 * 命令执行器
	 * 运行 shell 命令，从 executeCommandTool 提取
	 */
	private commandExecutor!: CommandExecutor

	// ========================================================================
	// 构造函数
	// ========================================================================

	/**
	 * 创建 Task 实例
	 *
	 * 初始化任务的所有组件和服务，包括：
	 * 1. 核心状态和依赖注入
	 * 2. 终端管理器配置
	 * 3. 浏览器和 URL 服务
	 * 4. 上下文追踪器
	 * 5. 检查点管理器
	 * 6. API 处理器
	 * 7. 命令执行器
	 * 8. 工具执行器
	 *
	 * 注意：任务启动（startTask/resumeTaskFromHistory）在构造后
	 * 由 Controller.initTask() 调用，防止竞态条件。
	 *
	 * @param params - 任务参数对象
	 */
	constructor(params: TaskParams) {
		// 解构参数
		const {
			controller,
			mcpHub,
			updateTaskHistory,
			postStateToWebview,
			reinitExistingTaskFromId,
			cancelTask,
			shellIntegrationTimeout,
			terminalReuseEnabled,
			terminalOutputLineLimit,
			defaultTerminalProfile,
			vscodeTerminalExecutionMode,
			cwd,
			stateManager,
			workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			taskLockAcquired,
		} = params

		// ====================================================================
		// 核心状态初始化
		// ====================================================================
		this.taskInitializationStartTime = performance.now()
		this.taskState = new TaskState()
		this.controller = controller
		this.mcpHub = mcpHub
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = postStateToWebview
		this.reinitExistingTaskFromId = reinitExistingTaskFromId
		this.cancelTask = cancelTask
		this.clineIgnoreController = new ClineIgnoreController(cwd)
		this.commandPermissionController = new CommandPermissionController()
		this.taskLockAcquired = taskLockAcquired

		// ====================================================================
		// 终端管理器配置
		// ====================================================================
		// 确定终端执行模式并创建相应的终端管理器
		this.terminalExecutionMode = vscodeTerminalExecutionMode || "vscodeTerminal"

		// 选择 backgroundExec 模式时，使用 StandaloneTerminalManager 进行隐藏执行
		// 否则，使用 HostProvider 的终端管理器（VSCode 环境中使用 VSCode 终端，CLI 中使用独立终端）
		if (this.terminalExecutionMode === "backgroundExec") {
			this.terminalManager = new StandaloneTerminalManager()
			Logger.info(`[Task ${taskId}] Using StandaloneTerminalManager for backgroundExec mode`)
		} else {
			this.terminalManager = HostProvider.get().createTerminalManager()
			Logger.info(`[Task ${taskId}] Using HostProvider terminal manager for vscodeTerminal mode`)
		}

		// 配置终端管理器参数
		this.terminalManager.setShellIntegrationTimeout(shellIntegrationTimeout)
		this.terminalManager.setTerminalReuseEnabled(terminalReuseEnabled ?? true)
		this.terminalManager.setTerminalOutputLineLimit(terminalOutputLineLimit)
		this.terminalManager.setDefaultTerminalProfile(defaultTerminalProfile)

		// ====================================================================
		// 服务初始化
		// ====================================================================
		this.urlContentFetcher = new UrlContentFetcher()
		this.browserSession = new BrowserSession(stateManager)
		this.contextManager = new ContextManager()
		this.streamHandler = new StreamResponseHandler()
		this.cwd = cwd
		this.stateManager = stateManager
		this.workspaceManager = workspaceManager

		// ====================================================================
		// 差异视图配置
		// ====================================================================
		// DiffViewProvider 在编辑时打开差异编辑器
		// FileEditProvider 在后台执行编辑，不抢占用户编辑器焦点
		const backgroundEditEnabled = this.stateManager.getGlobalSettingsKey("backgroundEditEnabled")
		this.diffViewProvider = backgroundEditEnabled ? new FileEditProvider() : HostProvider.get().createDiffViewProvider()

		// ====================================================================
		// MCP 通知回调设置
		// ====================================================================
		// 设置实时通知回调，在聊天中立即显示 MCP 服务器通知
		this.mcpHub.setNotificationCallback(async (serverName: string, _level: string, message: string) => {
			await this.say("mcp_notification", `[${serverName}] ${message}`)
		})

		// ====================================================================
		// 任务 ID 和 ULID 初始化
		// ====================================================================
		this.taskId = taskId

		// 首先初始化 taskId
		// 根据是恢复任务还是新任务，设置 ULID 和相关状态
		if (historyItem) {
			// 从历史记录恢复任务
			this.ulid = historyItem.ulid ?? ulid()
			this.taskIsFavorited = historyItem.isFavorited
			this.taskState.conversationHistoryDeletedRange = historyItem.conversationHistoryDeletedRange
			if (historyItem.checkpointManagerErrorMessage) {
				this.taskState.checkpointManagerErrorMessage = historyItem.checkpointManagerErrorMessage
			}
		} else if (task || images || files) {
			// 新任务
			this.ulid = ulid()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		// ====================================================================
		// 消息状态处理器初始化
		// ====================================================================
		this.messageStateHandler = new MessageStateHandler({
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			taskIsFavorited: this.taskIsFavorited,
			updateTaskHistory: this.updateTaskHistory,
		})

		// ====================================================================
		// 上下文追踪器初始化
		// ====================================================================
		this.fileContextTracker = new FileContextTracker(controller, this.taskId)
		this.modelContextTracker = new ModelContextTracker(this.taskId)
		this.environmentContextTracker = new EnvironmentContextTracker(this.taskId)

		// ====================================================================
		// 焦点链管理器初始化（仅当启用时）
		// ====================================================================
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		if (focusChainSettings.enabled) {
			this.FocusChainManager = new FocusChainManager({
				taskId: this.taskId,
				taskState: this.taskState,
				mode: this.stateManager.getGlobalSettingsKey("mode"),
				stateManager: this.stateManager,
				postStateToWebview: this.postStateToWebview,
				say: this.say.bind(this),
				focusChainSettings: focusChainSettings,
			})
		}

		// ====================================================================
		// 检查点管理器初始化
		// ====================================================================
		// 检查多根工作区并警告检查点限制
		const isMultiRootWorkspace = this.workspaceManager && this.workspaceManager.getRoots().length > 1
		const checkpointsEnabled = this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")

		if (isMultiRootWorkspace && checkpointsEnabled) {
			// 设置检查点管理器错误消息，在 TaskHeader 中显示警告
			this.taskState.checkpointManagerErrorMessage = "Checkpoints are not currently supported in multi-root workspaces."
		}

		// 根据工作区配置初始化检查点管理器
		if (!isMultiRootWorkspace) {
			try {
				this.checkpointManager = buildCheckpointManager({
					taskId: this.taskId,
					messageStateHandler: this.messageStateHandler,
					fileContextTracker: this.fileContextTracker,
					diffViewProvider: this.diffViewProvider,
					taskState: this.taskState,
					workspaceManager: this.workspaceManager,
					updateTaskHistory: this.updateTaskHistory,
					say: this.say.bind(this),
					cancelTask: this.cancelTask,
					postStateToWebview: this.postStateToWebview,
					initialConversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					initialCheckpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
					stateManager: this.stateManager,
				})

				// 如果是多根工作区，启动非阻塞初始化
				// 目前不可达，保留用于未来多根检查点支持
				if (
					shouldUseMultiRoot({
						workspaceManager: this.workspaceManager,
						enableCheckpoints: this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting"),
						stateManager: this.stateManager,
					})
				) {
					this.checkpointManager.initialize?.().catch((error: Error) => {
						Logger.error("Failed to initialize multi-root checkpoint manager:", error)
						this.taskState.checkpointManagerErrorMessage = error?.message || String(error)
					})
				}
			} catch (error) {
				Logger.error("Failed to initialize checkpoint manager:", error)
				if (this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Failed to initialize checkpoint manager: ${errorMessage}`,
					})
				}
			}
		}

		// ====================================================================
		// API 处理器初始化
		// ====================================================================
		// 准备有效的 API 配置
		const apiConfiguration = this.stateManager.getApiConfiguration()
		const effectiveApiConfiguration: ApiConfiguration = {
			...apiConfiguration,
			ulid: this.ulid,
			// API 重试回调：更新 UI 显示重试状态
			onRetryAttempt: async (attempt: number, maxRetries: number, delay: number, error: any) => {
				const clineMessages = this.messageStateHandler.getClineMessages()
				const lastApiReqStartedIndex = findLastIndex(clineMessages, (m) => m.say === "api_req_started")
				if (lastApiReqStartedIndex !== -1) {
					try {
						const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[lastApiReqStartedIndex].text || "{}")
						currentApiReqInfo.retryStatus = {
							attempt: attempt, // attempt 已经是从 retry.ts 来的 1 索引
							maxAttempts: maxRetries, // 总尝试次数
							delaySec: Math.round(delay / 1000),
							errorSnippet: error?.message ? `${String(error.message).substring(0, 50)}...` : undefined,
						}
						// 重试时清除之前的 cancelReason 和 streamingFailedMessage
						delete currentApiReqInfo.cancelReason
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateClineMessage(lastApiReqStartedIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})

						// 将更新后的状态发布到 webview，使 UI 反映重试尝试
						await this.postStateToWebview().catch((e) =>
							Logger.error("Error posting state to webview in onRetryAttempt:", e),
						)
					} catch (e) {
						Logger.error(`[Task ${this.taskId}] Error updating api_req_started with retryStatus:`, e)
					}
				}
			},
		}
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const currentProvider = mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider

		// ULID 初始化后，构建 API 处理器
		this.api = buildApiHandler(effectiveApiConfiguration, mode)

		// 在 browserSession 上设置 ulid 用于遥测追踪
		this.browserSession.setUlid(this.ulid)

		// 注意：任务初始化（startTask/resumeTaskFromHistory）现在在 Task 实例完全分配后
		// 由 Controller.initTask() 调用，防止竞态条件（钩子在 controller.task 准备好之前运行）
		// This prevents race conditions where hooks run before controller.task is ready.

		// Set up focus chain file watcher (async, runs in background) only if focus chain is enabled
		if (this.FocusChainManager) {
			this.FocusChainManager.setupFocusChainFileWatcher().catch((error) => {
				Logger.error(`[Task ${this.taskId}] Failed to setup focus chain file watcher:`, error)
			})
		}

		// initialize telemetry

		// Extract domain of the provider endpoint if using OpenAI Compatible provider
		let openAiCompatibleDomain: string | undefined
		if (currentProvider === "openai" && apiConfiguration.openAiBaseUrl) {
			openAiCompatibleDomain = extractProviderDomainFromUrl(apiConfiguration.openAiBaseUrl)
		}

		if (historyItem) {
			// Open task from history
			telemetryService.captureTaskRestarted(this.ulid, currentProvider, openAiCompatibleDomain)
		} else {
			// New task started
			telemetryService.captureTaskCreated(this.ulid, currentProvider, openAiCompatibleDomain)
		}

		// Initialize command executor with config and callbacks
		const commandExecutorConfig: FullCommandExecutorConfig = {
			cwd: this.cwd,
			terminalExecutionMode: this.terminalExecutionMode,
			terminalManager: this.terminalManager,
			taskId: this.taskId,
			ulid: this.ulid,
		}

		const commandExecutorCallbacks: CommandExecutorCallbacks = {
			say: this.say.bind(this) as CommandExecutorCallbacks["say"],
			ask: async (type: string, text?: string, partial?: boolean) => {
				const result = await this.ask(type as ClineAsk, text, partial)
				return {
					response: result.response,
					text: result.text,
					images: result.images,
					files: result.files,
				}
			},
			updateBackgroundCommandState: (isRunning: boolean) =>
				this.controller.updateBackgroundCommandState(isRunning, this.taskId),
			updateClineMessage: async (index: number, updates: { commandCompleted?: boolean; text?: string }) => {
				await this.messageStateHandler.updateClineMessage(index, updates)
			},
			getClineMessages: () => this.messageStateHandler.getClineMessages() as Array<{ ask?: string; say?: string }>,
			addToUserMessageContent: (content: { type: string; text: string }) => {
				// Cast to ClineTextContentBlock which is compatible with ClineContent
				this.taskState.userMessageContent.push({ type: "text", text: content.text } as ClineTextContentBlock)
			},
		}

		this.commandExecutor = new CommandExecutor(commandExecutorConfig, commandExecutorCallbacks)

		this.toolExecutor = new ToolExecutor(
			this.taskState,
			this.messageStateHandler,
			this.api,
			this.urlContentFetcher,
			this.browserSession,
			this.diffViewProvider,
			this.mcpHub,
			this.fileContextTracker,
			this.clineIgnoreController,
			this.commandPermissionController,
			this.contextManager,
			this.stateManager,
			cwd,
			this.taskId,
			this.ulid,
			this.terminalExecutionMode,
			this.workspaceManager,
			isMultiRootEnabled(this.stateManager),
			this.say.bind(this),
			this.ask.bind(this),
			this.saveCheckpointCallback.bind(this),
			this.sayAndCreateMissingParamError.bind(this),
			this.removeLastPartialMessageIfExistsWithType.bind(this),
			this.executeCommandTool.bind(this),
			this.cancelBackgroundCommand.bind(this),
			() => this.checkpointManager?.doesLatestTaskCompletionHaveNewChanges() ?? Promise.resolve(false),
			this.FocusChainManager?.updateFCListFromToolResponse.bind(this.FocusChainManager) || (async () => {}),
			this.switchToActModeCallback.bind(this),
			this.cancelTask,
			// Atomic hook state helpers for ToolExecutor
			this.setActiveHookExecution.bind(this),
			this.clearActiveHookExecution.bind(this),
			this.getActiveHookExecution.bind(this),
			this.runUserPromptSubmitHook.bind(this),
		)
	}

	// ========================================================================
	// Webview 通信方法
	// ========================================================================

	/**
	 * 向用户询问并等待响应
	 *
	 * 这是 AI 代理与用户交互的主要方法之一。当 AI 需要用户确认、
	 * 批准或输入时调用此方法。
	 *
	 * partial 参数有三种有效状态：
	 * - true: 部分消息（流式传输中）
	 * - false: 部分消息的完成版本
	 * - undefined: 独立的完整消息
	 *
	 * @param type - 询问类型（如 tool、command、followup 等）
	 * @param text - 询问文本内容
	 * @param partial - 是否为部分消息
	 * @returns 包含用户响应、文本、图片和文件的对象
	 * @throws 如果任务已中止（除恢复类型询问外）
	 */
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
	): Promise<{
		response: ClineAskResponse
		text?: string
		images?: string[]
		files?: string[]
		askTs?: number
	}> {
		// 允许恢复类型的询问即使任务已中止，以支持取消后的恢复按钮
		if (this.taskState.abort && type !== "resume_task" && type !== "resume_completed_task") {
			throw new Error("Cline instance aborted")
		}
		let askTs: number
		if (partial !== undefined) {
			const clineMessages = this.messageStateHandler.getClineMessages()
			const lastMessage = clineMessages.at(-1)
			const lastMessageIndex = clineMessages.length - 1

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					await this.messageStateHandler.updateClineMessage(lastMessageIndex, {
						text,
						partial,
					})
					// todo be more efficient about saving and posting only new data or one whole message at a time so ignore partial for saves, and only post parts of partial message instead of whole array in new listener
					// await this.saveClineMessagesAndUpdateHistory()
					// await this.postStateToWebview()
					const protoMessage = convertClineMessageToProto(lastMessage)
					await sendPartialMessageEvent(protoMessage)
					throw new Error("Current ask promise was ignored 1")
				}
				// this is a new partial message, so add it with partial state
				// this.askResponse = undefined
				// this.askResponseText = undefined
				// this.askResponseImages = undefined
				askTs = Date.now()
				this.taskState.lastMessageTs = askTs
				await this.messageStateHandler.addToClineMessages({
					ts: askTs,
					type: "ask",
					ask: type,
					text,
					partial,
				})
				await this.postStateToWebview()
				throw new Error("Current ask promise was ignored 2")
			}
			// partial=false means its a complete version of a previously partial message
			if (isUpdatingPreviousPartial) {
				// this is the complete version of a previously partial message, so replace the partial with the complete version
				this.taskState.askResponse = undefined
				this.taskState.askResponseText = undefined
				this.taskState.askResponseImages = undefined
				this.taskState.askResponseFiles = undefined

				/*
					Bug for the history books:
					In the webview we use the ts as the chatrow key for the virtuoso list. Since we would update this ts right at the end of streaming, it would cause the view to flicker. The key prop has to be stable otherwise react has trouble reconciling items between renders, causing unmounting and remounting of components (flickering).
					The lesson here is if you see flickering when rendering lists, it's likely because the key prop is not stable.
					So in this case we must make sure that the message ts is never altered after first setting it.
					*/
				askTs = lastMessage.ts
				this.taskState.lastMessageTs = askTs
				// lastMessage.ts = askTs
				await this.messageStateHandler.updateClineMessage(lastMessageIndex, {
					text,
					partial: false,
				})
				// await this.postStateToWebview()
				const protoMessage = convertClineMessageToProto(lastMessage)
				await sendPartialMessageEvent(protoMessage)
			} else {
				// this is a new partial=false message, so add it like normal
				this.taskState.askResponse = undefined
				this.taskState.askResponseText = undefined
				this.taskState.askResponseImages = undefined
				this.taskState.askResponseFiles = undefined
				askTs = Date.now()
				this.taskState.lastMessageTs = askTs
				await this.messageStateHandler.addToClineMessages({
					ts: askTs,
					type: "ask",
					ask: type,
					text,
				})
				await this.postStateToWebview()
			}
		} else {
			// this is a new non-partial message, so add it like normal
			// const lastMessage = this.clineMessages.at(-1)
			this.taskState.askResponse = undefined
			this.taskState.askResponseText = undefined
			this.taskState.askResponseImages = undefined
			this.taskState.askResponseFiles = undefined
			askTs = Date.now()
			this.taskState.lastMessageTs = askTs
			await this.messageStateHandler.addToClineMessages({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
			})
			await this.postStateToWebview()
		}

		await pWaitFor(() => this.taskState.askResponse !== undefined || this.taskState.lastMessageTs !== askTs, {
			interval: 100,
		})
		if (this.taskState.lastMessageTs !== askTs) {
			throw new Error("Current ask promise was ignored") // could happen if we send multiple asks in a row i.e. with command_output. It's important that when we know an ask could fail, it is handled gracefully
		}
		const result = {
			response: this.taskState.askResponse!,
			text: this.taskState.askResponseText,
			images: this.taskState.askResponseImages,
			files: this.taskState.askResponseFiles,
		}
		this.taskState.askResponse = undefined
		this.taskState.askResponseText = undefined
		this.taskState.askResponseImages = undefined
		this.taskState.askResponseFiles = undefined
		return result
	}

	/**
	 * 处理来自 Webview 的询问响应
	 *
	 * 当用户在 UI 中响应 ask 请求时调用此方法。
	 * 设置响应状态，使 ask 方法中的 pWaitFor 能够继续。
	 *
	 * @param askResponse - 用户的响应类型
	 * @param text - 用户输入的文本
	 * @param images - 用户附加的图片
	 * @param files - 用户附加的文件
	 */
	async handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[], files?: string[]) {
		this.taskState.askResponse = askResponse
		this.taskState.askResponseText = text
		this.taskState.askResponseImages = images
		this.taskState.askResponseFiles = files
	}

	/**
	 * 向 Webview 发送消息（不等待响应）
	 *
	 * 这是 AI 代理向用户显示信息的主要方法。与 ask 不同，
	 * say 不会等待用户响应，只是单向发送消息。
	 *
	 * 用于显示：
	 * - AI 的文本响应
	 * - 工具执行结果
	 * - 错误消息
	 * - 状态更新
	 *
	 * @param type - 消息类型（如 text、tool、error 等）
	 * @param text - 消息文本内容
	 * @param images - 附加的图片
	 * @param files - 附加的文件
	 * @param partial - 是否为部分消息
	 * @returns 消息时间戳，如果是更新现有消息则返回 undefined
	 * @throws 如果任务已中止（除钩子状态消息外）
	 */
	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
	): Promise<number | undefined> {
		// 允许钩子消息即使任务已中止，以支持正确的清理
		if (this.taskState.abort && type !== "hook_status" && type !== "hook_output_stream") {
			throw new Error("Cline instance aborted")
		}

		const providerInfo = this.getCurrentProviderInfo()
		const modelInfo: ClineMessageModelInfo = {
			providerId: providerInfo.providerId,
			modelId: providerInfo.model.id,
			mode: providerInfo.mode,
		}

		if (partial !== undefined) {
			const lastMessage = this.messageStateHandler.getClineMessages().at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					const lastIndex = this.messageStateHandler.getClineMessages().length - 1
					await this.messageStateHandler.updateClineMessage(lastIndex, {
						text,
						images,
						files,
						partial,
					})

					const protoMessage = convertClineMessageToProto(lastMessage)
					await sendPartialMessageEvent(protoMessage)
					return undefined
				}
				// this is a new partial message, so add it with partial state
				const sayTs = Date.now()
				this.taskState.lastMessageTs = sayTs
				await this.messageStateHandler.addToClineMessages({
					ts: sayTs,
					type: "say",
					say: type,
					text,
					images,
					files,
					partial,
					modelInfo,
				})
				await this.postStateToWebview()
				return sayTs
			}
			// partial=false means its a complete version of a previously partial message
			if (isUpdatingPreviousPartial) {
				// this is the complete version of a previously partial message, so replace the partial with the complete version
				this.taskState.lastMessageTs = lastMessage.ts
				const lastIndex = this.messageStateHandler.getClineMessages().length - 1
				// updateClineMessage emits the change event and saves to disk
				await this.messageStateHandler.updateClineMessage(lastIndex, {
					text,
					images,
					files,
					partial: false,
				})

				// await this.postStateToWebview()
				const protoMessage = convertClineMessageToProto(lastMessage)
				await sendPartialMessageEvent(protoMessage) // more performant than an entire postStateToWebview
				return undefined
			}
			// this is a new partial=false message, so add it like normal
			const sayTs = Date.now()
			this.taskState.lastMessageTs = sayTs
			await this.messageStateHandler.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				files,
				modelInfo,
			})
			await this.postStateToWebview()
			return sayTs
		}
		// this is a new non-partial message, so add it like normal
		const sayTs = Date.now()
		this.taskState.lastMessageTs = sayTs
		await this.messageStateHandler.addToClineMessages({
			ts: sayTs,
			type: "say",
			say: type,
			text,
			images,
			files,
			modelInfo,
		})
		await this.postStateToWebview()
		return sayTs
	}

	// ========================================================================
	// 消息辅助方法
	// ========================================================================

	/**
	 * 显示缺少参数错误并创建工具错误响应
	 *
	 * 当 AI 尝试使用工具但缺少必需参数时调用。
	 * 向用户显示错误消息并返回格式化的错误响应。
	 *
	 * @param toolName - 工具名称
	 * @param paramName - 缺少的参数名称
	 * @param relPath - 相关文件路径（可选）
	 * @returns 格式化的工具错误响应
	 */
	async sayAndCreateMissingParamError(toolName: ClineDefaultTool, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Cline tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	/**
	 * 如果存在指定类型的部分消息则移除
	 *
	 * 用于清理流式传输过程中创建的部分消息。
	 *
	 * @param type - 消息类型（ask 或 say）
	 * @param askOrSay - 具体的询问或说话类型
	 */
	async removeLastPartialMessageIfExistsWithType(type: "ask" | "say", askOrSay: ClineAsk | ClineSay) {
		const clineMessages = this.messageStateHandler.getClineMessages()
		const lastMessage = clineMessages.at(-1)
		if (lastMessage?.partial && lastMessage.type === type && (lastMessage.ask === askOrSay || lastMessage.say === askOrSay)) {
			this.messageStateHandler.setClineMessages(clineMessages.slice(0, -1))
			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
		}
	}

	// ========================================================================
	// 检查点和回调方法
	// ========================================================================

	/**
	 * 保存检查点回调
	 *
	 * 调用检查点管理器保存当前任务状态快照。
	 *
	 * @param isAttemptCompletionMessage - 是否为任务完成消息
	 * @param completionMessageTs - 完成消息的时间戳
	 */
	private async saveCheckpointCallback(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void> {
		return this.checkpointManager?.saveCheckpoint(isAttemptCompletionMessage, completionMessageTs) ?? Promise.resolve()
	}

	/**
	 * 检查并行工具调用是否启用
	 *
	 * 并行工具调用在以下情况下启用：
	 * 1. 用户在设置中启用了它，或
	 * 2. 当前模型/提供商支持原生工具调用且能良好处理并行工具
	 *
	 * @returns 是否启用并行工具调用
	 */
	private isParallelToolCallingEnabled(): boolean {
		const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
		const providerInfo = this.getCurrentProviderInfo()
		return isParallelToolCallingEnabled(enableParallelSetting, providerInfo)
	}

	/**
	 * 切换到 Act 模式的回调
	 *
	 * 用于 YOLO 模式自动切换到执行模式。
	 *
	 * @returns 切换是否成功
	 */
	private async switchToActModeCallback(): Promise<boolean> {
		return await this.controller.toggleActModeForYoloMode()
	}

	// ========================================================================
	// 钩子处理方法
	// ========================================================================

	/**
	 * 统一的钩子取消处理器
	 *
	 * 确保在中止之前始终保存状态，无论是用户点击取消
	 * 还是钩子返回 {cancel: true}。
	 *
	 * @param hookName - 钩子名称（用于日志记录）
	 * @param wasCancelled - 是否为用户点击取消（vs 钩子返回 cancel: true）
	 */
	private async handleHookCancellation(hookName: string, wasCancelled: boolean): Promise<void> {
		// 无论取消来源如何，始终保存状态
		this.taskState.didFinishAbortingStream = true

		// 将对话状态保存到磁盘
		await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
		await this.messageStateHandler.overwriteApiConversationHistory(this.messageStateHandler.getApiConversationHistory())

		// 更新 UI
		await this.postStateToWebview()

		// 记录日志用于调试/遥测
		Logger.log(`[Task ${this.taskId}] ${hookName} hook cancelled (userInitiated: ${wasCancelled})`)
	}

	/**
	 * 计算 PreCompact 钩子的新删除范围
	 *
	 * 用于确定在上下文压缩时应删除哪些历史消息。
	 *
	 * @param apiConversationHistory - 完整的 API 对话历史
	 * @returns 包含起始和结束索引的元组
	 */
	private calculatePreCompactDeletedRange(apiConversationHistory: ClineStorageMessage[]): [number, number] {
		const newDeletedRange = this.contextManager.getNextTruncationRange(
			apiConversationHistory,
			this.taskState.conversationHistoryDeletedRange,
			"quarter", // Force aggressive truncation on error
		)

		return newDeletedRange || [0, 0]
	}

	private async runUserPromptSubmitHook(
		userContent: ClineContent[],
		_context: "initial_task" | "resume" | "feedback",
	): Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }> {
		const hooksEnabled = getHooksEnabledSafe()

		if (!hooksEnabled) {
			return {}
		}

		const { extractUserPromptFromContent } = await import("./utils/extractUserPromptFromContent")

		// Extract clean user prompt from content, stripping system wrappers and metadata
		const promptText = extractUserPromptFromContent(userContent)

		const userPromptResult = await executeHook({
			hookName: "UserPromptSubmit",
			hookInput: {
				userPromptSubmit: {
					prompt: promptText,
					attachments: [],
				},
			},
			isCancellable: true,
			say: this.say.bind(this),
			setActiveHookExecution: this.setActiveHookExecution.bind(this),
			clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
			messageStateHandler: this.messageStateHandler,
			taskId: this.taskId,
			hooksEnabled,
		})

		// Handle cancellation from hook
		if (userPromptResult.cancel === true && userPromptResult.wasCancelled) {
			// Set flag to allow Controller.cancelTask() to proceed
			this.taskState.didFinishAbortingStream = true
			// Save BOTH files so Controller.cancelTask() can find the task
			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
			await this.messageStateHandler.overwriteApiConversationHistory(this.messageStateHandler.getApiConversationHistory())
			await this.postStateToWebview()
		}

		return {
			cancel: userPromptResult.cancel,
			contextModification: userPromptResult.contextModification,
			errorMessage: userPromptResult.errorMessage,
		}
	}

	// ========================================================================
	// 任务生命周期方法
	// ========================================================================

	/**
	 * 启动新任务
	 *
	 * 这是创建全新任务的入口点。执行流程：
	 * 1. 初始化 ClineIgnore 控制器
	 * 2. 清空对话历史和消息
	 * 3. 显示任务消息
	 * 4. 运行 TaskStart 钩子
	 * 5. 运行 UserPromptSubmit 钩子
	 * 6. 记录环境元数据
	 * 7. 进入任务循环
	 *
	 * @param task - 任务描述文本
	 * @param images - 附加的图片路径数组
	 * @param files - 附加的文件路径数组
	 */
	public async startTask(task?: string, images?: string[], files?: string[]): Promise<void> {
		try {
			await this.clineIgnoreController.initialize()
		} catch (error) {
			Logger.error("Failed to initialize ClineIgnoreController:", error)
			// 可选：通知用户或适当处理错误
		}

		// conversationHistory（用于 API）和 clineMessages（用于 webview）需要同步
		// 如果扩展进程被终止，重启时 clineMessages 可能不为空，
		// 所以创建新 Cline 客户端时需要将其设为 []（否则 webview 会显示上一会话的过时消息）
		this.messageStateHandler.setClineMessages([])
		this.messageStateHandler.setApiConversationHistory([])

		await this.postStateToWebview()

		// 显示任务消息
		await this.say("task", task, images, files)

		this.taskState.isInitialized = true

		// 格式化图片块
		const imageBlocks: ClineImageContentBlock[] = formatResponse.imageBlocks(images)

		const userContent: ClineUserContent[] = [
			{
				type: "text",
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		]

		if (files && files.length > 0) {
			const fileContentString = await processFilesIntoText(files)
			if (fileContentString) {
				userContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}

		// Add TaskStart hook context to the conversation if provided
		const hooksEnabled = getHooksEnabledSafe()
		if (hooksEnabled) {
			const taskStartResult = await executeHook({
				hookName: "TaskStart",
				hookInput: {
					taskStart: {
						taskMetadata: {
							taskId: this.taskId,
							ulid: this.ulid,
							initialTask: task || "",
						},
					},
				},
				isCancellable: true,
				say: this.say.bind(this),
				setActiveHookExecution: this.setActiveHookExecution.bind(this),
				clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
				messageStateHandler: this.messageStateHandler,
				taskId: this.taskId,
				hooksEnabled,
			})

			// Handle cancellation from hook
			if (taskStartResult.cancel === true) {
				// Always save state regardless of cancellation source
				await this.handleHookCancellation("TaskStart", taskStartResult.wasCancelled)

				// Let Controller handle the cancellation (it will call abortTask)
				await this.cancelTask()
				return
			}

			// Add context modification to the conversation if provided
			if (taskStartResult.contextModification) {
				const contextText = taskStartResult.contextModification.trim()
				if (contextText) {
					userContent.push({
						type: "text",
						text: `<hook_context source="TaskStart">\n${contextText}\n</hook_context>`,
					})
				}
			}
		}

		// Defensive check: Verify task wasn't aborted during hook execution before continuing
		// Must be OUTSIDE the hooksEnabled block to prevent UserPromptSubmit from running
		if (this.taskState.abort) {
			return
		}

		// Run UserPromptSubmit hook for initial task (after TaskStart for UI ordering)
		const userPromptHookResult = await this.runUserPromptSubmitHook(userContent, "initial_task")

		// Defensive check: Verify task wasn't aborted during hook execution (handles async cancellation)
		if (this.taskState.abort) {
			return
		}

		// Handle hook cancellation
		if (userPromptHookResult.cancel === true) {
			await this.handleHookCancellation("UserPromptSubmit", userPromptHookResult.wasCancelled ?? false)
			await this.cancelTask()
			return
		}

		// Add hook context if provided
		if (userPromptHookResult.contextModification) {
			userContent.push({
				type: "text",
				text: `<hook_context source="UserPromptSubmit">\n${userPromptHookResult.contextModification}\n</hook_context>`,
			})
		}

		// Record environment metadata for new task
		try {
			await this.environmentContextTracker.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata:", error)
		}

		await this.initiateTaskLoop(userContent)
	}

	/**
	 * 从历史记录恢复任务
	 *
	 * 这是恢复已有任务的入口点。执行流程：
	 * 1. 初始化 ClineIgnore 控制器
	 * 2. 加载保存的 Cline 消息和 API 对话历史
	 * 3. 清理之前的恢复消息
	 * 4. 显示恢复询问
	 * 5. 等待用户点击恢复按钮
	 * 6. 运行 TaskResume 和 UserPromptSubmit 钩子
	 * 7. 构建恢复上下文
	 * 8. 继续任务循环
	 */
	public async resumeTaskFromHistory() {
		try {
			await this.clineIgnoreController.initialize()
		} catch (error) {
			Logger.error("Failed to initialize ClineIgnoreController:", error)
			// 可选：通知用户或适当处理错误
		}

		// 加载保存的 Cline 消息
		const savedClineMessages = await getSavedClineMessages(this.taskId)

		// 移除之前可能添加的恢复消息
		const lastRelevantMessageIndex = findLastIndex(
			savedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)
		if (lastRelevantMessageIndex !== -1) {
			savedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// since we don't use api_req_finished anymore, we need to check if the last api_req_started has a cost value, if it doesn't and no cancellation reason to present, then we remove it since it indicates an api request without any partial content streamed
		const lastApiReqStartedIndex = findLastIndex(savedClineMessages, (m) => m.type === "say" && m.say === "api_req_started")
		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = savedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")
			if (cost === undefined && cancelReason === undefined) {
				savedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.messageStateHandler.overwriteClineMessages(savedClineMessages)
		this.messageStateHandler.setClineMessages(await getSavedClineMessages(this.taskId))

		// Now present the cline messages to the user and ask if they want to resume (NOTE: we ran into a bug before where the apiconversationhistory wouldn't be initialized when opening a old task, and it was because we were waiting for resume)
		// This is important in case the user deletes messages without resuming the task first
		const savedApiConversationHistory = await getSavedApiConversationHistory(this.taskId)

		this.messageStateHandler.setApiConversationHistory(savedApiConversationHistory)

		// load the context history state
		await ensureTaskDirectoryExists(this.taskId)
		await this.contextManager.initializeContextHistory(await ensureTaskDirectoryExists(this.taskId))

		const lastClineMessage = this.messageStateHandler
			.getClineMessages()
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // could be multiple resume tasks

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.taskState.isInitialized = true
		this.taskState.abort = false // Reset abort flag when resuming task

		const { response, text, images, files } = await this.ask(askType) // calls poststatetowebview

		// Initialize newUserContent array for hook context
		const newUserContent: ClineContent[] = []

		// Run TaskResume hook AFTER user clicks resume button
		const hooksEnabled = getHooksEnabledSafe()
		if (hooksEnabled) {
			const clineMessages = this.messageStateHandler.getClineMessages()
			const taskResumeResult = await executeHook({
				hookName: "TaskResume",
				hookInput: {
					taskResume: {
						taskMetadata: {
							taskId: this.taskId,
							ulid: this.ulid,
						},
						previousState: {
							lastMessageTs: lastClineMessage?.ts?.toString() || "",
							messageCount: clineMessages.length.toString(),
							conversationHistoryDeleted: (this.taskState.conversationHistoryDeletedRange !== undefined).toString(),
						},
					},
				},
				isCancellable: true,
				say: this.say.bind(this),
				setActiveHookExecution: this.setActiveHookExecution.bind(this),
				clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
				messageStateHandler: this.messageStateHandler,
				taskId: this.taskId,
				hooksEnabled,
			})

			// Handle cancellation from hook
			if (taskResumeResult.cancel === true) {
				// UNIFIED: Always save state regardless of cancellation source
				await this.handleHookCancellation("TaskResume", taskResumeResult.wasCancelled)

				// Let Controller handle the cancellation (it will call abortTask)
				await this.cancelTask()
				return
			}

			// Add context if provided
			if (taskResumeResult.contextModification) {
				newUserContent.push({
					type: "text",
					text: `<hook_context source="TaskResume" type="general">\n${taskResumeResult.contextModification}\n</hook_context>`,
				})
			}
		}

		// Defensive check: Verify task wasn't aborted during hook execution before continuing
		// Must be OUTSIDE the hooksEnabled block to prevent UserPromptSubmit from running
		if (this.taskState.abort) {
			return
		}

		let responseText: string | undefined
		let responseImages: string[] | undefined
		let responseFiles: string[] | undefined
		if (response === "messageResponse" || text || (images && images.length > 0) || (files && files.length > 0)) {
			await this.say("user_feedback", text, images, files)
			await this.checkpointManager?.saveCheckpoint()
			responseText = text
			responseImages = images
			responseFiles = files
		}

		// need to make sure that the api conversation history can be resumed by the api, even if it goes out of sync with cline messages

		// Use the already-loaded API conversation history from memory instead of reloading from disk
		// This prevents issues where the file might be empty or stale after hook execution
		const existingApiConversationHistory = this.messageStateHandler.getApiConversationHistory()

		// Remove the last user message so we can update it with the resume message
		let modifiedOldUserContent: ClineContent[] // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: ClineStorageMessage[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]
			if (lastMessage.role === "assistant") {
				modifiedApiConversationHistory = [...existingApiConversationHistory]
				modifiedOldUserContent = []
			} else if (lastMessage.role === "user") {
				const existingUserContent: ClineContent[] = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
				modifiedOldUserContent = [...existingUserContent]
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			// No API conversation history yet (e.g., cancelled during hook before first API request)
			// Start fresh with empty history and no previous content
			modifiedApiConversationHistory = []
			modifiedOldUserContent = []
		}

		// Add previous content to newUserContent array
		newUserContent.push(...modifiedOldUserContent)

		const agoText = (() => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		const wasRecent = lastClineMessage?.ts && Date.now() - lastClineMessage.ts < 30_000

		// Check if there are pending file context warnings before calling taskResumption
		const pendingContextWarning = await this.fileContextTracker.retrieveAndClearPendingFileContextWarning()
		const hasPendingFileContextWarnings = pendingContextWarning && pendingContextWarning.length > 0

		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const [taskResumptionMessage, userResponseMessage] = formatResponse.taskResumption(
			mode === "plan" ? "plan" : "act",
			agoText,
			this.cwd,
			wasRecent,
			responseText,
			hasPendingFileContextWarnings,
		)

		if (taskResumptionMessage !== "") {
			newUserContent.push({
				type: "text",
				text: taskResumptionMessage,
			})
		}

		if (userResponseMessage !== "") {
			newUserContent.push({
				type: "text",
				text: userResponseMessage,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		if (responseFiles && responseFiles.length > 0) {
			const fileContentString = await processFilesIntoText(responseFiles)
			if (fileContentString) {
				newUserContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}

		// Inject file context warning if there were pending warnings from message editing
		if (pendingContextWarning && pendingContextWarning.length > 0) {
			const fileContextWarning = formatResponse.fileContextWarning(pendingContextWarning)
			newUserContent.push({
				type: "text",
				text: fileContextWarning,
			})
		}

		// Run UserPromptSubmit hook for task resumption with ONLY the new user feedback
		// (not the entire conversation context that includes previous messages)
		const userFeedbackContent = await buildUserFeedbackContent(responseText, responseImages, responseFiles)

		const userPromptHookResult = await this.runUserPromptSubmitHook(userFeedbackContent, "resume")

		// Defensive check: Verify task wasn't aborted during hook execution (handles async cancellation)
		if (this.taskState.abort) {
			return
		}

		// Handle hook cancellation request
		if (userPromptHookResult.cancel === true) {
			// The hook already updated its status to "cancelled" internally and saved state
			await this.cancelTask()
			return
		}

		// Add hook context if provided (after all other content)
		if (userPromptHookResult.contextModification) {
			newUserContent.push({
				type: "text",
				text: `<hook_context source="UserPromptSubmit">\n${userPromptHookResult.contextModification}\n</hook_context>`,
			})
		}

		// Record environment metadata when resuming task (tracks cross-platform migrations)
		try {
			await this.environmentContextTracker.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata on resume:", error)
		}

		await this.messageStateHandler.overwriteApiConversationHistory(modifiedApiConversationHistory)
		await this.initiateTaskLoop(newUserContent)
	}

	/**
	 * 启动任务循环
	 *
	 * 这是 AI 代理的核心执行循环。工作方式：
	 * 1. 给 Cline 一个任务
	 * 2. Cline 调用工具来完成任务
	 * 3. 除非有 attempt_completion 调用，否则继续响应工具结果
	 * 4. 直到 Cline 调用 attempt_completion 或不再使用工具
	 * 5. 如果不再使用工具，提示 Cline 考虑是否完成任务
	 *
	 * @param userContent - 初始用户内容
	 */
	private async initiateTaskLoop(userContent: ClineContent[]): Promise<void> {
		let nextUserContent = userContent
		let includeFileDetails = true

		// 主循环：直到任务中止
		while (!this.taskState.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // 只在第一次需要文件详情

			// 代理循环的工作方式：
			// Cline 被给予一个任务，然后调用工具来完成。
			// 除非有 attempt_completion 调用，否则我们继续响应工具结果，
			// 直到 Cline 调用 attempt_completion 或不再使用工具。
			// 如果不再使用工具，我们要求他考虑是否完成任务，然后调用 attempt_completion，
			// 否则继续完成任务。

			if (didEndLoop) {
				// 目前任务永不"完成"。这只会在用户达到最大请求数并拒绝重置计数时发生。
				break
			}

			// 如果 Cline 只响应文本块但没有调用 attempt_completion，
			// 强制他继续任务
			nextUserContent = [
				{
					type: "text",
					text: formatResponse.noToolsUsed(this.useNativeToolCalls),
				},
			]
			this.taskState.consecutiveMistakeCount++
		}
	}

	/**
	 * 判断是否应运行 TaskCancel 钩子
	 *
	 * 只有在实际有活动工作进行中或本会话已开始工作时才运行。
	 * 仅显示恢复按钮或完成按钮（无活动工作）时不运行。
	 *
	 * 运行条件：
	 * - 有活动的钩子执行
	 * - API 正在流式传输
	 * - 正在等待首个块
	 * - 有活动的后台命令
	 *
	 * 不运行条件：
	 * - 仅显示按钮状态（resume_task、resume_completed_task、completion_result）
	 *
	 * @returns 是否应运行钩子
	 */
	private async shouldRunTaskCancelHook(): Promise<boolean> {
		// 原子检查活动钩子执行（当前正在进行工作）
		const activeHook = await this.getActiveHookExecution()
		if (activeHook) {
			return true
		}

		// 如果 API 正在流式传输（当前正在进行工作）
		if (this.taskState.isStreaming) {
			return true
		}

		// 如果正在等待首个块（当前正在进行工作）
		if (this.taskState.isWaitingForFirstChunk) {
			return true
		}

		// 如果有活动的后台命令（当前正在进行工作）
		if (this.commandExecutor.hasActiveBackgroundCommand()) {
			return true
		}

		// 检查是否处于仅按钮状态（无活动工作，只是等待用户操作）
		const clineMessages = this.messageStateHandler.getClineMessages()
		const lastMessage = clineMessages.at(-1)
		const isAtButtonOnlyState =
			lastMessage?.type === "ask" &&
			(lastMessage.ask === "resume_task" ||
				lastMessage.ask === "resume_completed_task" ||
				lastMessage.ask === "completion_result")

		if (isAtButtonOnlyState) {
			// At button-only state - DON'T run hook because we're just waiting for user input
			// These button states appear when:
			// 1. Opening from history (resume_task/resume_completed_task)
			// 2. After task completion (completion_result with "Start New Task" button)
			// 3. After cancelling during active work (but work already stopped)
			// In all cases, we shouldn't run TaskCancel hook
			return false
		}

		// Not at a button-only state - we're in the middle of work or just finished something
		// Run the hook since cancelling would interrupt actual work
		return true
	}

	/**
	 * 中止任务执行
	 *
	 * 这是任务取消的主要入口点。执行分为多个阶段：
	 *
	 * 阶段 1：检查 TaskCancel 钩子是否应运行（在任何清理之前）
	 * 阶段 2：设置中止标志以防止竞态条件
	 * 阶段 3：取消任何正在运行的钩子执行
	 * 阶段 4：运行 TaskCancel 钩子
	 * 阶段 5：立即更新 UI 以反映中止状态
	 * 阶段 6：检查未完成的进度（焦点链）
	 * 阶段 7：清理资源（终端、浏览器、差异视图等）
	 *
	 * 在 finally 块中释放任务锁并发送最终状态更新。
	 */
	async abortTask() {
		try {
			// 阶段 1：在任何清理之前检查 TaskCancel 是否应运行
			// 必须现在捕获此状态，因为后续清理会清除 shouldRunTaskCancelHook 检查的活动工作指示器
			const shouldRunTaskCancelHook = await this.shouldRunTaskCancelHook()

			// PHASE 2: Set abort flag to prevent race conditions
			// This must happen before canceling hooks so that hook catch blocks
			// can properly detect the abort state
			this.taskState.abort = true

			// PHASE 3: Cancel any running hook execution
			const activeHook = await this.getActiveHookExecution()
			if (activeHook) {
				try {
					await this.cancelHookExecution()
					// Clear activeHookExecution after hook is signaled
					await this.clearActiveHookExecution()
				} catch (error) {
					Logger.error("Failed to cancel hook during task abort", error)
					// Still clear state even on error to prevent stuck state
					await this.clearActiveHookExecution()
				}
			}

			if (this.commandExecutor.hasActiveBackgroundCommand()) {
				try {
					await this.commandExecutor.cancelBackgroundCommand()
				} catch (error) {
					Logger.error("Failed to cancel background command during task abort", error)
				}
			}

			// PHASE 4: Run TaskCancel hook
			// This allows the hook UI to appear in the webview
			// Use the shouldRunTaskCancelHook value we captured in Phase 1
			const hooksEnabled = getHooksEnabledSafe()
			if (hooksEnabled && shouldRunTaskCancelHook) {
				try {
					await executeHook({
						hookName: "TaskCancel",
						hookInput: {
							taskCancel: {
								taskMetadata: {
									taskId: this.taskId,
									ulid: this.ulid,
									completionStatus: this.taskState.abandoned ? "abandoned" : "cancelled",
								},
							},
						},
						isCancellable: false, // TaskCancel is NOT cancellable
						say: this.say.bind(this),
						// No setActiveHookExecution or clearActiveHookExecution for non-cancellable hooks
						messageStateHandler: this.messageStateHandler,
						taskId: this.taskId,
						hooksEnabled,
					})

					// TaskCancel completed successfully
					// Present resume button after successful TaskCancel hook
					const lastClineMessage = this.messageStateHandler
						.getClineMessages()
						.slice()
						.reverse()
						.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))

					let askType: ClineAsk
					if (lastClineMessage?.ask === "completion_result") {
						askType = "resume_completed_task"
					} else {
						askType = "resume_task"
					}

					// Present the resume ask - this will show the resume button in the UI
					// We don't await this because we want to set the abort flag immediately
					// The ask will be waiting when the user decides to resume
					this.ask(askType).catch((error) => {
						// If ask fails (e.g., task was cleared), that's okay - just log it
						Logger.log("[TaskCancel] Resume ask failed (task may have been cleared):", error)
					})
				} catch (error) {
					// TaskCancel hook failed - non-fatal, just log
					Logger.error("[TaskCancel Hook] Failed (non-fatal):", error)
				}
			}

			// PHASE 5: Immediately update UI to reflect abort state
			try {
				await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
				await this.postStateToWebview()
			} catch (error) {
				Logger.error("Failed to post state after setting abort flag", error)
			}

			// PHASE 6: Check for incomplete progress
			if (this.FocusChainManager) {
				// Extract current model and provider for telemetry
				const apiConfig = this.stateManager.getApiConfiguration()
				const currentMode = this.stateManager.getGlobalSettingsKey("mode")
				const currentProvider = (
					currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
				) as string
				const currentModelId = this.api.getModel().id

				this.FocusChainManager.checkIncompleteProgressOnCompletion(currentModelId, currentProvider)
			}

			// PHASE 7: Clean up resources
			this.terminalManager.disposeAll()
			this.urlContentFetcher.closeBrowser()
			await this.browserSession.dispose()
			this.clineIgnoreController.dispose()
			this.fileContextTracker.dispose()
			// need to await for when we want to make sure directories/files are reverted before
			// re-starting the task from a checkpoint
			await this.diffViewProvider.revertChanges()
			// Clear the notification callback when task is aborted
			this.mcpHub.clearNotificationCallback()
			if (this.FocusChainManager) {
				this.FocusChainManager.dispose()
			}
		} finally {
			// Release task folder lock
			if (this.taskLockAcquired) {
				try {
					await releaseTaskLock(this.taskId)
					this.taskLockAcquired = false
					Logger.info(`[Task ${this.taskId}] Task lock released`)
				} catch (error) {
					Logger.error(`[Task ${this.taskId}] Failed to release task lock:`, error)
				}
			}

			// Final state update to notify UI that abort is complete
			try {
				await this.postStateToWebview()
			} catch (error) {
				Logger.error("Failed to post final state after abort", error)
			}
		}
	}

	// ========================================================================
	// 工具执行方法
	// ========================================================================

	/**
	 * 执行命令工具
	 *
	 * 在终端中执行 shell 命令。
	 *
	 * @param command - 要执行的命令
	 * @param timeoutSeconds - 超时时间（秒）
	 * @param options - 命令执行选项
	 * @returns 元组 [是否成功, 工具响应内容]
	 */
	async executeCommandTool(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<[boolean, ClineToolResponseContent]> {
		return this.commandExecutor.execute(command, timeoutSeconds, options)
	}

	/**
	 * 取消在后台运行的命令
	 *
	 * @returns 如果命令被取消返回 true，如果没有命令在运行返回 false
	 */
	public async cancelBackgroundCommand(): Promise<boolean> {
		return this.commandExecutor.cancelBackgroundCommand()
	}

	/**
	 * 取消当前正在运行的钩子执行
	 *
	 * 中止钩子进程并更新钩子消息状态为"已取消"。
	 *
	 * @returns 如果钩子被取消返回 true，如果没有钩子在运行返回 false
	 */
	public async cancelHookExecution(): Promise<boolean> {
		const activeHook = await this.getActiveHookExecution()
		if (!activeHook) {
			return false
		}

		const { hookName, toolName, messageTs, abortController } = activeHook

		try {
			// 中止钩子进程
			abortController.abort()

			// 将钩子消息状态更新为"已取消"
			const clineMessages = this.messageStateHandler.getClineMessages()
			const hookMessageIndex = clineMessages.findIndex((m) => m.ts === messageTs)
			if (hookMessageIndex !== -1) {
				const cancelledMetadata = {
					hookName,
					toolName,
					status: "cancelled",
					exitCode: 130, // 标准 SIGTERM 退出码
				}
				await this.messageStateHandler.updateClineMessage(hookMessageIndex, {
					text: JSON.stringify(cancelledMetadata),
				})
			}

			// Notify UI that hook was cancelled
			await this.say("hook_output_stream", "\nHook execution cancelled by user")

			// Return success - let caller (abortTask) handle next steps
			// DON'T call abortTask() here to avoid infinite recursion
			return true
		} catch (error) {
			Logger.error("Failed to cancel hook execution", error)
			return false
		}
	}

	private getCurrentProviderInfo(): ApiProviderInfo {
		const model = this.api.getModel()
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const providerId = (mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		const customPrompt = this.stateManager.getGlobalSettingsKey("customPrompt")
		return { model, providerId, customPrompt, mode }
	}

	private async writePromptMetadataArtifacts(params: { systemPrompt: string; providerInfo: ApiProviderInfo }): Promise<void> {
		const enabledFlag = process.env.CLINE_WRITE_PROMPT_ARTIFACTS?.toLowerCase()
		const enabled = enabledFlag === "1" || enabledFlag === "true" || enabledFlag === "yes"
		if (!enabled) {
			return
		}

		try {
			const configuredDir = process.env.CLINE_PROMPT_ARTIFACT_DIR?.trim()
			const artifactDir = configuredDir
				? path.isAbsolute(configuredDir)
					? configuredDir
					: path.resolve(this.cwd, configuredDir)
				: path.resolve(this.cwd, ".cline-prompt-artifacts")

			await fs.mkdir(artifactDir, { recursive: true })

			const ts = new Date().toISOString()
			const safeTs = ts.replace(/[:.]/g, "-")
			const baseName = `task-${this.taskId}-req-${this.taskState.apiRequestCount}-${safeTs}`
			const manifestPath = path.join(artifactDir, `${baseName}.manifest.json`)
			const promptPath = path.join(artifactDir, `${baseName}.system_prompt.md`)

			const manifest = {
				taskId: this.taskId,
				ulid: this.ulid,
				apiRequestCount: this.taskState.apiRequestCount,
				ts,
				cwd: this.cwd,
				mode: params.providerInfo.mode,
				provider: params.providerInfo.providerId,
				model: params.providerInfo.model.id,
				apiRequestId: this.getApiRequestIdSafe(),
				systemPromptPath: promptPath,
			}

			await Promise.all([
				fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8"),
				fs.writeFile(promptPath, params.systemPrompt, "utf8"),
			])
		} catch (error) {
			Logger.error("Failed to write prompt metadata artifacts:", error)
		}
	}

	private getApiRequestIdSafe(): string | undefined {
		const apiLike = this.api as Partial<{
			getLastRequestId: () => string | undefined
			lastGenerationId?: string
		}>
		return apiLike.getLastRequestId?.() ?? apiLike.lastGenerationId
	}

	private async handleContextWindowExceededError(): Promise<void> {
		const apiConversationHistory = this.messageStateHandler.getApiConversationHistory()

		// Run PreCompact hook before truncation
		const hooksEnabled = getHooksEnabledSafe()
		if (hooksEnabled) {
			try {
				// Calculate what the new deleted range will be
				const deletedRange = this.calculatePreCompactDeletedRange(apiConversationHistory)

				// Execute hook - throws HookCancellationError if cancelled
				await executePreCompactHookWithCleanup({
					taskId: this.taskId,
					ulid: this.ulid,
					apiConversationHistory,
					conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					contextManager: this.contextManager,
					clineMessages: this.messageStateHandler.getClineMessages(),
					messageStateHandler: this.messageStateHandler,
					compactionStrategy: "standard-truncation-lastquarter",
					deletedRange,
					say: this.say.bind(this),
					setActiveHookExecution: async (hookExecution: HookExecution | undefined) => {
						if (hookExecution) {
							await this.setActiveHookExecution(hookExecution)
						}
					},
					clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
					postStateToWebview: this.postStateToWebview.bind(this),
					taskState: this.taskState,
					cancelTask: this.cancelTask.bind(this),
					hooksEnabled: true,
				})
			} catch (error) {
				// If hook was cancelled, re-throw to stop compaction
				if (error instanceof HookCancellationError) {
					throw error
				}

				// Graceful degradation: Log error but continue with truncation
				Logger.error("[PreCompact] Hook execution failed:", error)
			}
		}

		// Proceed with standard truncation
		const newDeletedRange = this.contextManager.getNextTruncationRange(
			apiConversationHistory,
			this.taskState.conversationHistoryDeletedRange,
			"quarter", // Force aggressive truncation
		)

		this.taskState.conversationHistoryDeletedRange = newDeletedRange

		await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
		await this.contextManager.triggerApplyStandardContextTruncationNoticeChange(
			Date.now(),
			await ensureTaskDirectoryExists(this.taskId),
			apiConversationHistory,
		)

		this.taskState.didAutomaticallyRetryFailedApiRequest = true
	}

	async *attemptApiRequest(previousApiReqIndex: number): ApiStream {
		// Wait for MCP servers to be connected before generating system prompt
		await pWaitFor(() => this.mcpHub.isConnecting !== true, {
			timeout: 10_000,
		}).catch(() => {
			Logger.error("MCP servers failed to connect in time")
		})

		const providerInfo = this.getCurrentProviderInfo()
		const host = await HostProvider.env.getHostVersion({})
		const ide = host?.platform || "Unknown"
		const isCliEnvironment = host.clineType === ClineClient.Cli
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const disableBrowserTool = browserSettings.disableToolUse ?? false
		// cline browser tool uses image recognition for navigation (requires model image support).
		const modelSupportsBrowserUse = providerInfo.model.info.supportsImages ?? false

		const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool // only enable browser use if the model supports it and the user hasn't disabled it
		const preferredLanguageRaw = this.stateManager.getGlobalSettingsKey("preferredLanguage")
		const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay)
		const preferredLanguageInstructions =
			preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
				? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
				: ""

		const { globalToggles, localToggles } = await refreshClineRulesToggles(this.controller, this.cwd)
		const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await refreshExternalRulesToggles(
			this.controller,
			this.cwd,
		)

		const evaluationContext = await RuleContextBuilder.buildEvaluationContext({
			cwd: this.cwd,
			messageStateHandler: this.messageStateHandler,
			workspaceManager: this.workspaceManager,
		})

		const globalClineRulesFilePath = await ensureRulesDirectoryExists()
		const globalRules = await getGlobalClineRules(globalClineRulesFilePath, globalToggles, { evaluationContext })
		const globalClineRulesFileInstructions = globalRules.instructions

		const localRules = await getLocalClineRules(this.cwd, localToggles, { evaluationContext })
		const localClineRulesFileInstructions = localRules.instructions
		const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
			this.cwd,
			cursorLocalToggles,
		)
		const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(this.cwd, windsurfLocalToggles)

		const localAgentsRulesFileInstructions = await getLocalAgentsRules(this.cwd, agentsLocalToggles)

		const clineIgnoreContent = this.clineIgnoreController.clineIgnoreContent
		let clineIgnoreInstructions: string | undefined
		if (clineIgnoreContent) {
			clineIgnoreInstructions = formatResponse.clineIgnoreInstructions(clineIgnoreContent)
		}

		// Prepare multi-root workspace information if enabled
		let workspaceRoots: Array<{ path: string; name: string; vcs?: string }> | undefined
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		if (multiRootEnabled && this.workspaceManager) {
			workspaceRoots = this.workspaceManager.getRoots().map((root) => ({
				path: root.path,
				name: root.name || path.basename(root.path), // Fallback to basename if name is undefined
				vcs: root.vcs as string | undefined, // Cast VcsType to string
			}))
		}

		// Discover and filter available skills
		const allSkills = await discoverSkills(this.cwd)
		const resolvedSkills = getAvailableSkills(allSkills)

		// Filter skills by toggle state (enabled by default)
		const globalSkillsToggles = this.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
		const localSkillsToggles = this.stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
		const availableSkills = resolvedSkills.filter((skill) => {
			const toggles = skill.source === "global" ? globalSkillsToggles : localSkillsToggles
			// If toggle exists, use it; otherwise default to enabled (true)
			return toggles[skill.path] !== false
		})

		// Snapshot editor tabs so prompt tools can decide whether to include
		// filetype-specific instructions (e.g. notebooks) without adding bespoke flags.
		const openTabPaths = (await HostProvider.window.getOpenTabs({})).paths || []
		const visibleTabPaths = (await HostProvider.window.getVisibleTabs({})).paths || []
		const cap = 50
		const editorTabs = {
			open: openTabPaths.slice(0, cap),
			visible: visibleTabPaths.slice(0, cap),
		}

		const promptContext: SystemPromptContext = {
			cwd: this.cwd,
			ide,
			providerInfo,
			editorTabs,
			supportsBrowserUse,
			mcpHub: this.mcpHub,
			skills: availableSkills,
			focusChainSettings: this.stateManager.getGlobalSettingsKey("focusChainSettings"),
			globalClineRulesFileInstructions,
			localClineRulesFileInstructions,
			localCursorRulesFileInstructions,
			localCursorRulesDirInstructions,
			localWindsurfRulesFileInstructions,
			localAgentsRulesFileInstructions,
			clineIgnoreInstructions,
			preferredLanguageInstructions,
			browserSettings: this.stateManager.getGlobalSettingsKey("browserSettings"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			subagentsEnabled: this.stateManager.getGlobalSettingsKey("subagentsEnabled"),
			clineWebToolsEnabled:
				this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") && featureFlagsService.getWebtoolsEnabled(),
			isMultiRootEnabled: multiRootEnabled,
			workspaceRoots,
			isSubagentRun: false,
			isCliEnvironment,
			enableNativeToolCalls:
				providerInfo.model.info.apiFormat === ApiFormat.OPENAI_RESPONSES ||
				this.stateManager.getGlobalStateKey("nativeToolCallEnabled"),
			enableParallelToolCalling: this.isParallelToolCallingEnabled(),
			terminalExecutionMode: this.terminalExecutionMode,
		}

		// Notify user if any conditional rules were applied for this request
		const activatedConditionalRules = [...globalRules.activatedConditionalRules, ...localRules.activatedConditionalRules]
		if (activatedConditionalRules.length > 0) {
			await this.say("conditional_rules_applied", JSON.stringify({ rules: activatedConditionalRules }))
		}

		const { systemPrompt, tools } = await getSystemPrompt(promptContext)
		this.useNativeToolCalls = !!tools?.length
		await this.writePromptMetadataArtifacts({ systemPrompt, providerInfo })

		const contextManagementMetadata = await this.contextManager.getNewContextMessagesAndMetadata(
			this.messageStateHandler.getApiConversationHistory(),
			this.messageStateHandler.getClineMessages(),
			this.api,
			this.taskState.conversationHistoryDeletedRange,
			previousApiReqIndex,
			await ensureTaskDirectoryExists(this.taskId),
			this.stateManager.getGlobalSettingsKey("useAutoCondense") && isNextGenModelFamily(this.api.getModel().id),
		)

		if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
			this.taskState.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
			// saves task history item which we use to keep track of conversation history deleted range
		}

		// Response API requires native tool calls to be enabled
		const stream = this.api.createMessage(systemPrompt, contextManagementMetadata.truncatedConversationHistory, tools)

		const iterator = stream[Symbol.asyncIterator]()

		try {
			// awaiting first chunk to see if it will throw an error
			this.taskState.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.taskState.isWaitingForFirstChunk = false
		} catch (error) {
			const isContextWindowExceededError = checkContextWindowExceededError(error)
			const { model, providerId } = this.getCurrentProviderInfo()
			const clineError = ErrorService.get().toClineError(error, model.id, providerId)

			// Capture provider failure telemetry using clineError
			ErrorService.get().logMessage(clineError.message)

			if (isContextWindowExceededError && !this.taskState.didAutomaticallyRetryFailedApiRequest) {
				await this.handleContextWindowExceededError()
			} else {
				// request failed after retrying automatically once, ask user if they want to retry again
				// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.

				if (isContextWindowExceededError) {
					const truncatedConversationHistory = this.contextManager.getTruncatedMessages(
						this.messageStateHandler.getApiConversationHistory(),
						this.taskState.conversationHistoryDeletedRange,
					)

					// If the conversation has more than 3 messages, we can truncate again. If not, then the conversation is bricked.
					// ToDo: Allow the user to change their input if this is the case.
					if (truncatedConversationHistory.length > 3) {
						clineError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
						this.taskState.didAutomaticallyRetryFailedApiRequest = false
					}
				}

				const streamingFailedMessage = clineError.serialize()

				// Update the 'api_req_started' message to reflect final failure before asking user to manually retry
				const lastApiReqStartedIndex = findLastIndex(
					this.messageStateHandler.getClineMessages(),
					(m) => m.say === "api_req_started",
				)
				if (lastApiReqStartedIndex !== -1) {
					const clineMessages = this.messageStateHandler.getClineMessages()
					const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[lastApiReqStartedIndex].text || "{}")
					delete currentApiReqInfo.retryStatus

					await this.messageStateHandler.updateClineMessage(lastApiReqStartedIndex, {
						text: JSON.stringify({
							...currentApiReqInfo, // Spread the modified info (with retryStatus removed)
							// cancelReason: "retries_exhausted", // Indicate that automatic retries failed
							streamingFailedMessage,
						} satisfies ClineApiReqInfo),
					})
					// this.ask will trigger postStateToWebview, so this change should be picked up.
				}

				const isAuthError = clineError.isErrorType(ClineErrorType.Auth)

				// Check if this is a Cline provider insufficient credits error - don't auto-retry these
				const isClineProviderInsufficientCredits = (() => {
					if (providerId !== "cline") {
						return false
					}
					try {
						const parsedError = ClineError.transform(error, model.id, providerId)
						return parsedError.isErrorType(ClineErrorType.Balance)
					} catch {
						return false
					}
				})()

				let response: ClineAskResponse
				// Skip auto-retry for Cline provider insufficient credits or auth errors
				if (!isClineProviderInsufficientCredits && !isAuthError && this.taskState.autoRetryAttempts < 3) {
					// Auto-retry enabled with max 3 attempts: automatically approve the retry
					this.taskState.autoRetryAttempts++

					// Calculate delay: 2s, 4s, 8s
					const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)

					await updateApiReqMsg({
						messageStateHandler: this.messageStateHandler,
						lastApiReqIndex: lastApiReqStartedIndex,
						inputTokens: 0,
						outputTokens: 0,
						cacheWriteTokens: 0,
						cacheReadTokens: 0,
						totalCost: undefined,
						api: this.api,
						cancelReason: "streaming_failed",
						streamingFailedMessage,
					})
					await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
					await this.postStateToWebview()

					response = "yesButtonClicked"
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: this.taskState.autoRetryAttempts,
							maxAttempts: 3,
							delaySeconds: delay / 1000,
							errorMessage: streamingFailedMessage,
						}),
					)

					// Clear streamingFailedMessage now that error_retry contains it
					// This prevents showing the error in both ErrorRow and error_retry
					const autoRetryApiReqIndex = findLastIndex(
						this.messageStateHandler.getClineMessages(),
						(m) => m.say === "api_req_started",
					)
					if (autoRetryApiReqIndex !== -1) {
						const clineMessages = this.messageStateHandler.getClineMessages()
						const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[autoRetryApiReqIndex].text || "{}")
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateClineMessage(autoRetryApiReqIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})
					}

					await setTimeoutPromise(delay)
				} else {
					// Show error_retry with failed flag to indicate all retries exhausted (but not for insufficient credits)
					if (!isClineProviderInsufficientCredits && !isAuthError) {
						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: 3,
								maxAttempts: 3,
								delaySeconds: 0,
								failed: true, // Special flag to indicate retries exhausted
								errorMessage: streamingFailedMessage,
							}),
						)
					}
					const askResult = await this.ask("api_req_failed", streamingFailedMessage)
					response = askResult.response
					if (response === "yesButtonClicked") {
						this.taskState.autoRetryAttempts = 0
					}
				}

				if (response !== "yesButtonClicked") {
					// this will never happen since if noButtonClicked, we will clear current task, aborting this instance
					throw new Error("API request failed")
				}

				// Clear streamingFailedMessage when user manually retries
				const manualRetryApiReqIndex = findLastIndex(
					this.messageStateHandler.getClineMessages(),
					(m) => m.say === "api_req_started",
				)
				if (manualRetryApiReqIndex !== -1) {
					const clineMessages = this.messageStateHandler.getClineMessages()
					const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[manualRetryApiReqIndex].text || "{}")
					delete currentApiReqInfo.streamingFailedMessage
					await this.messageStateHandler.updateClineMessage(manualRetryApiReqIndex, {
						text: JSON.stringify(currentApiReqInfo),
					})
				}

				await this.say("api_req_retried")

				// Reset the automatic retry flag so the request can proceed
				this.taskState.didAutomaticallyRetryFailedApiRequest = false
			}
			// delegate generator output from the recursive call
			yield* this.attemptApiRequest(previousApiReqIndex)
			return
		}

		// no error, so we can continue to yield all remaining chunks
		// (needs to be placed outside of try/catch since it we want caller to handle errors not with api_req_failed as that is reserved for first chunk failures only)
		// this delegates to another generator or iterable object. In this case, it's saying "yield all remaining values from this iterator". This effectively passes along all subsequent chunks from the original stream.
		yield* iterator
	}

	async presentAssistantMessage() {
		if (this.taskState.abort) {
			throw new Error("Cline instance aborted")
		}

		// If we're locked, mark pending and return
		// Complete tool blocks can proceed to acquire the lock and execute
		if (this.taskState.presentAssistantMessageLocked) {
			this.taskState.presentAssistantMessageHasPendingUpdates = true
			return
		}

		this.taskState.presentAssistantMessageLocked = true
		this.taskState.presentAssistantMessageHasPendingUpdates = false

		if (this.taskState.currentStreamingContentIndex >= this.taskState.assistantMessageContent.length) {
			// this may happen if the last content block was completed before streaming could finish. if streaming is finished, and we're out of bounds then this means we already presented/executed the last content block and are ready to continue to next request
			if (this.taskState.didCompleteReadingStream) {
				this.taskState.userMessageContentReady = true
			}
			this.taskState.presentAssistantMessageLocked = false
			return
			//throw new Error("No more content blocks to stream! This shouldn't happen...") // remove and just return after testing
		}

		const block = cloneDeep(this.taskState.assistantMessageContent[this.taskState.currentStreamingContentIndex]) // need to create copy bc while stream is updating the array, it could be updating the reference block properties too
		switch (block.type) {
			case "text": {
				// Skip text rendering if tool was rejected, or if a tool was already used and parallel calling is disabled
				if (this.taskState.didRejectTool || (!this.isParallelToolCallingEnabled() && this.taskState.didAlreadyUseTool)) {
					break
				}
				let content = block.content
				if (content) {
					// (have to do this for partial and complete since sending content in thinking tags to markdown renderer will automatically be removed)
					// Remove end substrings of <thinking or </thinking (below xml parsing is only for opening tags)
					// (this is done with the xml parsing below now, but keeping here for reference)
					// content = content.replace(/<\/?t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?$/, "")
					// Remove all instances of <thinking> (with optional line break after) and </thinking> (with optional line break before)
					// - Needs to be separate since we dont want to remove the line break before the first tag
					// - Needs to happen before the xml parsing below
					content = content.replace(/<thinking>\s?/g, "")
					content = content.replace(/\s?<\/thinking>/g, "")

					// Remove all instances of <think> tags (alternative to <thinking>, some models are trained to use this tag instead)
					content = content.replace(/<think>\s?/g, "")
					content = content.replace(/\s?<\/think>/g, "")

					// New claude models tend to output <function_calls> tags which we don't want to show in the chat
					content = content.replace(/<function_calls>\s?/g, "")
					content = content.replace(/\s?<\/function_calls>/g, "")

					// Remove partial XML tag at the very end of the content (for tool use and thinking tags)
					// (prevents scrollview from jumping when tags are automatically removed)
					const lastOpenBracketIndex = content.lastIndexOf("<")
					if (lastOpenBracketIndex !== -1) {
						const possibleTag = content.slice(lastOpenBracketIndex)
						// Check if there's a '>' after the last '<' (i.e., if the tag is complete) (complete thinking and tool tags will have been removed by now)
						const hasCloseBracket = possibleTag.includes(">")
						if (!hasCloseBracket) {
							// Extract the potential tag name
							let tagContent: string
							if (possibleTag.startsWith("</")) {
								tagContent = possibleTag.slice(2).trim()
							} else {
								tagContent = possibleTag.slice(1).trim()
							}
							// Check if tagContent is likely an incomplete tag name (letters and underscores only)
							const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
							// Preemptively remove < or </ to keep from these artifacts showing up in chat (also handles closing thinking tags)
							const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
							// If the tag is incomplete and at the end, remove it from the content
							if (isOpeningOrClosing || isLikelyTagName) {
								content = content.slice(0, lastOpenBracketIndex).trim()
							}
						}
					}
				}

				if (!block.partial) {
					// Some models add code block artifacts (around the tool calls) which show up at the end of text content
					// matches ``` with at least one char after the last backtick, at the end of the string
					const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
					if (match) {
						const matchLength = match[0].length
						content = content.trimEnd().slice(0, -matchLength)
					}
				}

				await this.say("text", content, undefined, undefined, block.partial)
				break
			}
			case "tool_use":
				// If we have a pending initial commit, we must block unsafe tools until it finishes.
				// Safe tools (read-only) can run in parallel.
				if (this.initialCheckpointCommitPromise) {
					if (!READ_ONLY_TOOLS.includes(block.name as any)) {
						await this.initialCheckpointCommitPromise
						this.initialCheckpointCommitPromise = undefined
					}
				}
				await this.toolExecutor.executeTool(block)
				if (block.call_id) {
					Session.get().updateToolCall(block.call_id, block.name)
				}
				break
		}

		/*
		Seeing out of bounds is fine, it means that the next tool call is being built up and ready to add to assistantMessageContent to present.
		When you see the UI inactive during this, it means that a tool is breaking without presenting any UI. For example the write_to_file tool was breaking when relpath was undefined, and for invalid relpath it never presented UI.
		*/
		this.taskState.presentAssistantMessageLocked = false // this needs to be placed here, if not then calling this.presentAssistantMessage below would fail (sometimes) since it's locked
		// NOTE: when tool is rejected, iterator stream is interrupted and it waits for userMessageContentReady to be true. Future calls to present will skip execution since didRejectTool and iterate until contentIndex is set to message length and it sets userMessageContentReady to true itself (instead of preemptively doing it in iterator)
		// Also advance when a tool was used and parallel calling is disabled
		if (
			!block.partial ||
			this.taskState.didRejectTool ||
			(!this.isParallelToolCallingEnabled() && this.taskState.didAlreadyUseTool)
		) {
			// block is finished streaming and executing
			if (this.taskState.currentStreamingContentIndex === this.taskState.assistantMessageContent.length - 1) {
				// its okay that we increment if !didCompleteReadingStream, it'll just return bc out of bounds and as streaming continues it will call presentAssistantMessage if a new block is ready. if streaming is finished then we set userMessageContentReady to true when out of bounds. This gracefully allows the stream to continue on and all potential content blocks be presented.
				// last block is complete and it is finished executing
				this.taskState.userMessageContentReady = true // will allow pwaitfor to continue
			}

			// call next block if it exists (if not then read stream will call it when its ready)
			this.taskState.currentStreamingContentIndex++ // need to increment regardless, so when read stream calls this function again it will be streaming the next block

			if (this.taskState.currentStreamingContentIndex < this.taskState.assistantMessageContent.length) {
				// there are already more content blocks to stream, so we'll call this function ourselves
				await this.presentAssistantMessage()
				return
			}
		}
		// block is partial, but the read stream may have finished
		if (this.taskState.presentAssistantMessageHasPendingUpdates) {
			await this.presentAssistantMessage()
		}
	}

	async recursivelyMakeClineRequests(userContent: ClineContent[], includeFileDetails = false): Promise<boolean> {
		// Check abort flag at the very start to prevent any execution after cancellation
		if (this.taskState.abort) {
			throw new Error("Task instance aborted")
		}

		// Increment API request counter for focus chain list management
		this.taskState.apiRequestCount++
		this.taskState.apiRequestsSinceLastTodoUpdate++

		// Used to know what models were used in the task if user wants to export metadata for error reporting purposes
		const { model, providerId, customPrompt, mode } = this.getCurrentProviderInfo()
		if (providerId && model.id) {
			try {
				await this.modelContextTracker.recordModelUsage(providerId, model.id, mode)
			} catch {}
		}

		const modelInfo: ClineMessageModelInfo = {
			modelId: model.id,
			providerId: providerId,
			mode: mode,
		}

		if (this.taskState.consecutiveMistakeCount >= this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")) {
			// In yolo mode, don't wait for user input - fail the task
			if (this.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
				const errorMessage =
					`[YOLO MODE] Task failed: Too many consecutive mistakes (${this.taskState.consecutiveMistakeCount}). ` +
					`The model may not be capable enough for this task. Consider using a more capable model.`
				await this.say("error", errorMessage)
				// End the task loop with failure
				return true // didEndLoop = true, signals task completion/failure
			}

			const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
			if (autoApprovalSettings.enableNotifications) {
				showSystemNotification({
					subtitle: "Error",
					message: "Cline is having trouble. Would you like to continue the task?",
				})
			}
			const { response, text, images, files } = await this.ask(
				"mistake_limit_reached",
				this.api.getModel().id.includes("claude")
					? `This may indicate a failure in Cline's thought process or inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`
					: "Cline uses complex prompts and iterative task execution that may be challenging for less capable models. For best results, it's recommended to use Claude 4.5 Sonnet for its advanced agentic coding capabilities.",
			)
			if (response === "messageResponse") {
				// Display the user's message in the chat UI
				await this.say("user_feedback", text, images, files)

				// This userContent is for the *next* API call.
				const feedbackUserContent: ClineUserContent[] = []
				feedbackUserContent.push({
					type: "text",
					text: formatResponse.tooManyMistakes(text),
				})
				if (images && images.length > 0) {
					feedbackUserContent.push(...formatResponse.imageBlocks(images))
				}

				let fileContentString = ""
				if (files && files.length > 0) {
					fileContentString = await processFilesIntoText(files)
				}

				if (fileContentString) {
					feedbackUserContent.push({
						type: "text",
						text: fileContentString,
					})
				}

				userContent = feedbackUserContent
			}
			this.taskState.consecutiveMistakeCount = 0
			this.taskState.autoRetryAttempts = 0 // need to reset this if the user chooses to manually retry after the mistake limit is reached
		}

		// get previous api req's index to check token usage and determine if we need to truncate conversation history
		const previousApiReqIndex = findLastIndex(this.messageStateHandler.getClineMessages(), (m) => m.say === "api_req_started")

		// Save checkpoint if this is the first API request
		const isFirstRequest = this.messageStateHandler.getClineMessages().filter((m) => m.say === "api_req_started").length === 0

		// Initialize checkpointManager first if enabled and it's the first request
		if (
			isFirstRequest &&
			this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") &&
			this.checkpointManager && // TODO REVIEW: may be able to implement a replacement for the 15s timer
			!this.taskState.checkpointManagerErrorMessage
		) {
			try {
				await ensureCheckpointInitialized({ checkpointManager: this.checkpointManager })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error"
				Logger.error("Failed to initialize checkpoint manager:", errorMessage)
				this.taskState.checkpointManagerErrorMessage = errorMessage // will be displayed right away since we saveClineMessages next which posts state to webview
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `Checkpoint initialization timed out: ${errorMessage}`,
				})
			}
		}

		// Now, if it's the first request AND checkpoints are enabled AND tracker was successfully initialized,
		// then say "checkpoint_created" and perform the commit.
		if (
			isFirstRequest &&
			this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") &&
			this.checkpointManager &&
			!this.taskState.checkpointManagerErrorMessage
		) {
			await this.say("checkpoint_created") // Now this is conditional
			const lastCheckpointMessageIndex = findLastIndex(
				this.messageStateHandler.getClineMessages(),
				(m) => m.say === "checkpoint_created",
			)
			if (lastCheckpointMessageIndex !== -1) {
				const commitPromise = this.checkpointManager?.commit()
				this.initialCheckpointCommitPromise = commitPromise
				commitPromise
					?.then(async (commitHash) => {
						if (commitHash) {
							await this.messageStateHandler.updateClineMessage(lastCheckpointMessageIndex, {
								lastCheckpointHash: commitHash,
							})
							// saveClineMessagesAndUpdateHistory will be called later after API response,
							// so no need to call it here unless this is the only modification to this message.
							// For now, assuming it's handled later.
						}
					})
					.catch((error) => {
						Logger.error(`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.taskId}:`, error)
					})
			}
		} else if (
			isFirstRequest &&
			this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") &&
			!this.checkpointManager &&
			this.taskState.checkpointManagerErrorMessage
		) {
			// Checkpoints are enabled, but tracker failed to initialize.
			// checkpointManagerErrorMessage is already set and will be part of the state.
			// No explicit UI message here, error message will be in ExtensionState.
		}

		// Determine if we should compact context window
		// Note: We delay context loading until we know if we're compacting (performance optimization)
		const useCompactPrompt = customPrompt === "compact" && isLocalModel(this.getCurrentProviderInfo())
		let shouldCompact = false
		const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")

		if (useAutoCondense && isNextGenModelFamily(this.api.getModel().id)) {
			// When we initially trigger context cleanup, we increase the context window size, so we need state `currentlySummarizing`
			// to track if we've already started the context summarization flow. After summarizing, we increment
			// conversationHistoryDeletedRange to mask out the summarization-trigger user & assistant response messages
			if (this.taskState.currentlySummarizing) {
				this.taskState.currentlySummarizing = false

				if (this.taskState.conversationHistoryDeletedRange) {
					const [start, end] = this.taskState.conversationHistoryDeletedRange
					const apiHistory = this.messageStateHandler.getApiConversationHistory()

					// we want to increment the deleted range to remove the pre-summarization tool call output, with additional safety check
					const safeEnd = Math.min(end + 2, apiHistory.length - 1)
					if (end + 2 <= safeEnd) {
						this.taskState.conversationHistoryDeletedRange = [start, end + 2]
						await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
					}
				}
			} else {
				shouldCompact = this.contextManager.shouldCompactContextWindow(
					this.messageStateHandler.getClineMessages(),
					this.api,
					previousApiReqIndex,
				)

				// Edge case: summarize_task tool call completes but user cancels next request before it finishes.
				// This results in currentlySummarizing being false, and we fail to update the context window token estimate.
				// Check active message count to avoid summarizing a summary (bad UX but doesn't break logic).
				if (shouldCompact && this.taskState.conversationHistoryDeletedRange) {
					const apiHistory = this.messageStateHandler.getApiConversationHistory()
					const activeMessageCount = apiHistory.length - this.taskState.conversationHistoryDeletedRange[1] - 1

					// IMPORTANT: We haven't appended the next user message yet, so the last message is an assistant message.
					// That's why we compare to even numbers (0, 2) rather than odd (1, 3).
					if (activeMessageCount <= 2) {
						shouldCompact = false
					}
				}

				// Determine whether we can save enough tokens from context rewriting to skip auto-compact
				if (shouldCompact) {
					shouldCompact = await this.contextManager.attemptFileReadOptimization(
						this.messageStateHandler.getApiConversationHistory(),
						this.taskState.conversationHistoryDeletedRange,
						this.messageStateHandler.getClineMessages(),
						previousApiReqIndex,
						await ensureTaskDirectoryExists(this.taskId),
					)
				}
			}
		}

		// NOW load context based on compaction decision
		// This optimization avoids expensive context loading when using summarize_task
		let parsedUserContent: ClineContent[]
		let environmentDetails: string
		let clinerulesError: boolean

		if (shouldCompact) {
			// When compacting, skip full context loading (use summarize_task instead)
			parsedUserContent = userContent
			environmentDetails = ""
			clinerulesError = false
			this.taskState.lastAutoCompactTriggerIndex = previousApiReqIndex
		} else {
			// When NOT compacting, load full context with mentions parsing and slash commands
			;[parsedUserContent, environmentDetails, clinerulesError] = await this.loadContext(
				userContent,
				includeFileDetails,
				useCompactPrompt,
			)
		}

		// error handling if the user uses the /newrule command & their .clinerules is a file, for file read operations didnt work properly
		if (clinerulesError === true) {
			await this.say(
				"error",
				"Issue with processing the /newrule command. Double check that, if '.clinerules' already exists, it's a directory and not a file. Otherwise there was an issue referencing this file/directory.",
			)
		}

		// Replace userContent with parsed content that includes file details and command instructions.
		userContent = parsedUserContent

		// add environment details as its own text block, separate from tool results
		// do not add environment details to the message which we are compacting the context window
		if (environmentDetails) {
			userContent.push({ type: "text", text: environmentDetails })
		}

		if (shouldCompact) {
			userContent.push({
				type: "text",
				text: summarizeTask(
					this.stateManager.getGlobalSettingsKey("focusChainSettings"),
					this.cwd,
					isMultiRootEnabled(this.stateManager),
				),
			})
		}

		// getting verbose details is an expensive operation, it uses globby to top-down build file structure of project which for large projects can take a few seconds
		// for the best UX we show a placeholder api_req_started message with a loading spinner as this happens
		await this.say(
			"api_req_started",
			JSON.stringify({
				request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
			}),
		)

		await this.messageStateHandler.addToApiConversationHistory({
			role: "user",
			content: userContent,
			ts: Date.now(),
		})

		telemetryService.captureConversationTurnEvent(this.ulid, providerId, model.id, "user", modelInfo.mode)

		// Capture task initialization timing telemetry for the first API request
		if (isFirstRequest) {
			const durationMs = Math.round(performance.now() - this.taskInitializationStartTime)
			telemetryService.captureTaskInitialization(
				this.ulid,
				this.taskId,
				durationMs,
				this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting"),
			)
		}

		// since we sent off a placeholder api_req_started message to update the webview while waiting to actually start the API request (to load potential details for example), we need to update the text of that message
		const lastApiReqIndex = findLastIndex(this.messageStateHandler.getClineMessages(), (m) => m.say === "api_req_started")
		await this.messageStateHandler.updateClineMessage(lastApiReqIndex, {
			text: JSON.stringify({
				request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
			} satisfies ClineApiReqInfo),
		})
		await this.postStateToWebview()

		try {
			const taskMetrics: {
				cacheWriteTokens: number
				cacheReadTokens: number
				inputTokens: number
				outputTokens: number
				totalCost: number | undefined
			} = { cacheWriteTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: undefined }

			const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				Session.get().finalizeRequest()

				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges() // closes diff view
				}

				// if last message is a partial we need to update and save it
				const lastMessage = this.messageStateHandler.getClineMessages().at(-1)
				if (lastMessage?.partial) {
					// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
					lastMessage.partial = false
					// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					Logger.log("updating partial message", lastMessage)
					// await this.saveClineMessagesAndUpdateHistory()
				}
				// update api_req_started to have cancelled and cost, so that we can display the cost of the partial stream
				await updateApiReqMsg({
					messageStateHandler: this.messageStateHandler,
					lastApiReqIndex,
					inputTokens: taskMetrics.inputTokens,
					outputTokens: taskMetrics.outputTokens,
					cacheWriteTokens: taskMetrics.cacheWriteTokens,
					cacheReadTokens: taskMetrics.cacheReadTokens,
					totalCost: taskMetrics.totalCost,
					api: this.api,
					cancelReason,
					streamingFailedMessage,
				})
				await this.messageStateHandler.saveClineMessagesAndUpdateHistory()

				// Let assistant know their response was interrupted for when task is resumed
				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${
									cancelReason === "streaming_failed"
										? "Response interrupted by API Error"
										: "Response interrupted by user"
								}]`,
						},
					],
					modelInfo,
					metrics: {
						tokens: {
							prompt: taskMetrics.inputTokens,
							completion: taskMetrics.outputTokens,
							cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
						},
						cost: taskMetrics.totalCost,
					},
					ts: Date.now(),
				})

				telemetryService.captureConversationTurnEvent(
					this.ulid,
					providerId,
					modelInfo.modelId,
					"assistant",
					modelInfo.mode,
					{
						tokensIn: taskMetrics.inputTokens,
						tokensOut: taskMetrics.outputTokens,
						cacheWriteTokens: taskMetrics.cacheWriteTokens,
						cacheReadTokens: taskMetrics.cacheReadTokens,
						totalCost: taskMetrics.totalCost,
					},
					this.useNativeToolCalls, // For assistant turn only.
				)

				// signals to provider that it can retrieve the saved messages from disk, as abortTask can not be awaited on in nature
				this.taskState.didFinishAbortingStream = true
			}

			// reset streaming state
			this.taskState.currentStreamingContentIndex = 0
			this.taskState.assistantMessageContent = []
			this.taskState.didCompleteReadingStream = false
			this.taskState.userMessageContent = []
			this.taskState.userMessageContentReady = false
			this.taskState.didRejectTool = false
			this.taskState.didAlreadyUseTool = false
			this.taskState.presentAssistantMessageLocked = false
			this.taskState.presentAssistantMessageHasPendingUpdates = false
			this.taskState.didAutomaticallyRetryFailedApiRequest = false
			await this.diffViewProvider.reset()
			this.streamHandler.reset()
			this.taskState.toolUseIdMap.clear()

			const { toolUseHandler, reasonsHandler } = this.streamHandler.getHandlers()
			const stream = this.attemptApiRequest(previousApiReqIndex) // yields only if the first chunk is successful, otherwise will allow the user to retry the request (most likely due to rate limit error, which gets thrown on the first chunk)

			let assistantMessageId = ""
			let assistantMessage = "" // For UI display (includes XML)
			let assistantTextOnly = "" // For API history (text only, no tool XML)
			let assistantTextSignature: string | undefined

			this.taskState.isStreaming = true
			let didReceiveUsageChunk = false
			let didFinalizeReasoningForUi = false

			const finalizePendingReasoningMessage = async (thinking: string): Promise<boolean> => {
				const pendingReasoningIndex = findLastIndex(
					this.messageStateHandler.getClineMessages(),
					(message) => message.type === "say" && message.say === "reasoning" && message.partial === true,
				)

				if (pendingReasoningIndex === -1) {
					return false
				}

				await this.messageStateHandler.updateClineMessage(pendingReasoningIndex, {
					text: thinking,
					partial: false,
				})
				const completedReasoning = this.messageStateHandler.getClineMessages()[pendingReasoningIndex]
				if (completedReasoning) {
					await sendPartialMessageEvent(convertClineMessageToProto(completedReasoning))
				}
				return true
			}

			// Track API call time for session statistics
			Session.get().startApiCall()

			try {
				for await (const chunk of stream) {
					if (
						!this.taskState.taskFirstTokenTimeMs &&
						(chunk.type === "text" || chunk.type === "reasoning" || chunk.type === "tool_calls")
					) {
						this.taskState.taskFirstTokenTimeMs = Math.max(0, Date.now() - this.taskState.taskStartTimeMs)
					}

					switch (chunk.type) {
						case "usage":
							this.streamHandler.setRequestId(chunk.id)
							didReceiveUsageChunk = true
							taskMetrics.inputTokens += chunk.inputTokens
							taskMetrics.outputTokens += chunk.outputTokens
							taskMetrics.cacheWriteTokens += chunk.cacheWriteTokens ?? 0
							taskMetrics.cacheReadTokens += chunk.cacheReadTokens ?? 0
							taskMetrics.totalCost = chunk.totalCost ?? taskMetrics.totalCost
							break
						case "reasoning": {
							// Process the reasoning delta through the handler
							// Ensure details is always an array
							const details = chunk.details ? (Array.isArray(chunk.details) ? chunk.details : [chunk.details]) : []
							reasonsHandler.processReasoningDelta({
								id: chunk.id,
								reasoning: chunk.reasoning,
								signature: chunk.signature,
								details,
								redacted_data: chunk.redacted_data,
							})

							// fixes bug where cancelling task > aborts task > for loop may be in middle of streaming reasoning > say function throws error before we get a chance to properly clean up and cancel the task.
							if (!this.taskState.abort) {
								const thinkingBlock = reasonsHandler.getCurrentReasoning()
								// Some providers can interleave reasoning after text has started.
								// Keep rendering stable by only streaming reasoning UI before the first text chunk.
								if (thinkingBlock?.thinking && chunk.reasoning && assistantMessage.length === 0) {
									await this.say("reasoning", thinkingBlock.thinking, undefined, undefined, true)
								}
							}

							break
						}
						case "tool_calls": {
							// Accumulate tool use blocks in proper Anthropic format
							toolUseHandler.processToolUseDelta(
								{
									id: chunk.tool_call.function?.id,
									type: "tool_use",
									name: chunk.tool_call.function?.name,
									input: chunk.tool_call.function?.arguments,
									signature: chunk?.signature,
								},
								chunk.tool_call.call_id,
							)
							// Extract and store tool_use_id for creating proper ToolResultBlockParam
							// Use call_id as key to support multiple calls to the same tool
							if (chunk.tool_call.function?.id && chunk.tool_call.call_id) {
								this.taskState.toolUseIdMap.set(chunk.tool_call.call_id, chunk.tool_call.function.id)
							}

							await this.processNativeToolCalls(assistantTextOnly, toolUseHandler.getPartialToolUsesAsContent())
							break
						}
						case "text": {
							// If we have reasoning content, finalize it before processing text (only once)
							const currentReasoning = reasonsHandler.getCurrentReasoning()
							if (currentReasoning?.thinking && !didFinalizeReasoningForUi) {
								const finalizedReasoning = await finalizePendingReasoningMessage(currentReasoning.thinking)
								if (finalizedReasoning) {
									didFinalizeReasoningForUi = true
								}
							}
							if (chunk.signature) {
								assistantTextSignature = chunk.signature
							}
							if (chunk.id) {
								assistantMessageId = chunk.id
							}
							assistantMessage += chunk.text
							assistantTextOnly += chunk.text // Accumulate text separately
							// parse raw assistant message into content blocks
							const prevLength = this.taskState.assistantMessageContent.length

							this.taskState.assistantMessageContent = parseAssistantMessageV2(assistantMessage)

							if (this.taskState.assistantMessageContent.length > prevLength) {
								this.taskState.userMessageContentReady = false // new content we need to present, reset to false in case previous content set this to true
							}
							break
						}
					}

					// Present content once per chunk. Calling this from multiple case branches can
					// race partial updates and duplicate text rows in the chat.
					await this.presentAssistantMessage().catch((error) =>
						Logger.debug("[Task] Failed to present message: " + error),
					)

					if (this.taskState.abort) {
						this.api.abort?.()
						if (!this.taskState.abandoned) {
							// only need to gracefully abort if this instance isn't abandoned (sometimes openrouter stream hangs, in which case this would affect future instances of cline)
							await abortStream("user_cancelled")
						}
						break // aborts the stream
					}

					if (this.taskState.didRejectTool) {
						// userContent has a tool rejection, so interrupt the assistant's response to present the user's feedback
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						// this.userMessageContentReady = true // instead of setting this preemptively, we allow the present iterator to finish and set userMessageContentReady when its ready
						break
					}

					// Interrupt stream if a tool was used and parallel calling is disabled
					// PREV: we need to let the request finish for openrouter to get generation details
					// UPDATE: it's better UX to interrupt the request at the cost of the api cost not being retrieved
					if (!this.isParallelToolCallingEnabled() && this.taskState.didAlreadyUseTool) {
						assistantMessage +=
							"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
						break
					}
				}

				if (!this.taskState.abort && !didFinalizeReasoningForUi) {
					const finalReasoning = reasonsHandler.getCurrentReasoning()
					if (finalReasoning?.thinking) {
						const finalizedPendingReasoning = await finalizePendingReasoningMessage(finalReasoning.thinking)
						if (!finalizedPendingReasoning) {
							await this.say("reasoning", finalReasoning.thinking, undefined, undefined, false)
						}
						didFinalizeReasoningForUi = true
					}
				}
			} catch (error) {
				// abandoned happens when extension is no longer waiting for the cline instance to finish aborting (error is thrown here when any function in the for loop throws due to this.abort)
				if (!this.taskState.abandoned) {
					const clineError = ErrorService.get().toClineError(error, this.api.getModel().id)
					const errorMessage = clineError.serialize()
					// Auto-retry for streaming failures (always enabled)
					if (this.taskState.autoRetryAttempts < 3) {
						this.taskState.autoRetryAttempts++

						// Calculate exponential backoff for streaming failures: 2s, 4s, 8s
						const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)

						// API Request component is updated to show error message, we then display retry information underneath that...
						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: this.taskState.autoRetryAttempts,
								maxAttempts: 3,
								delaySeconds: delay / 1000,
								errorMessage,
							}),
						)

						// Wait with exponential backoff before auto-resuming
						setTimeoutPromise(delay).then(async () => {
							// Programmatically click the resume button on the new task instance
							if (this.controller.task) {
								// Pass retry state to the new task instance
								this.controller.task.taskState.autoRetryAttempts = this.taskState.autoRetryAttempts
								await this.controller.task.handleWebviewAskResponse("yesButtonClicked", "", [])
							}
						})
					} else if (this.taskState.autoRetryAttempts >= 3) {
						// Show error_retry with failed flag to indicate all retries exhausted
						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: 3,
								maxAttempts: 3,
								delaySeconds: 0,
								failed: true, // Special flag to indicate retries exhausted
								errorMessage,
							}),
						)
					}

					// needs to happen after the say, otherwise the say would fail
					this.abortTask() // if the stream failed, there's various states the task could be in (i.e. could have streamed some tools the user may have executed), so we just resort to replicating a cancel task

					await abortStream("streaming_failed", errorMessage)
					await this.reinitExistingTaskFromId(this.taskId)
				}
			} finally {
				this.taskState.isStreaming = false
				// End API call tracking for session statistics
				Session.get().endApiCall()
			}

			// Finalize any remaining tool calls at the end of the stream

			// OpenRouter/Cline may not return token usage as part of the stream (since it may abort early), so we fetch after the stream is finished
			// (updateApiReq below will update the api_req_started message with the usage details. we do this async so it updates the api_req_started message in the background)
			if (!didReceiveUsageChunk) {
				this.api.getApiStreamUsage?.().then(async (apiStreamUsage) => {
					if (apiStreamUsage) {
						taskMetrics.inputTokens += apiStreamUsage.inputTokens
						taskMetrics.outputTokens += apiStreamUsage.outputTokens
						taskMetrics.cacheWriteTokens += apiStreamUsage.cacheWriteTokens ?? 0
						taskMetrics.cacheReadTokens += apiStreamUsage.cacheReadTokens ?? 0
						taskMetrics.totalCost = apiStreamUsage.totalCost ?? taskMetrics.totalCost
					}
				})
			}

			// Update the api_req_started message with final usage and cost details
			await updateApiReqMsg({
				messageStateHandler: this.messageStateHandler,
				lastApiReqIndex,
				inputTokens: taskMetrics.inputTokens,
				outputTokens: taskMetrics.outputTokens,
				cacheWriteTokens: taskMetrics.cacheWriteTokens,
				cacheReadTokens: taskMetrics.cacheReadTokens,
				api: this.api,
				totalCost: taskMetrics.totalCost,
			})
			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
			await this.postStateToWebview()

			// need to call here in case the stream was aborted
			if (this.taskState.abort) {
				throw new Error("Cline instance aborted")
			}

			// Stored the assistant API response immediately after the stream finishes in the same turn
			const assistantHasContent = assistantMessage.length > 0 || this.useNativeToolCalls
			if (assistantHasContent) {
				telemetryService.captureConversationTurnEvent(
					this.ulid,
					providerId,
					model.id,
					"assistant",
					modelInfo.mode,
					{
						tokensIn: taskMetrics.inputTokens,
						tokensOut: taskMetrics.outputTokens,
						cacheWriteTokens: taskMetrics.cacheWriteTokens,
						cacheReadTokens: taskMetrics.cacheReadTokens,
						totalCost: taskMetrics.totalCost,
					},
					this.useNativeToolCalls,
				)

				const { reasonsHandler } = this.streamHandler.getHandlers()
				const redactedThinkingContent = reasonsHandler.getRedactedThinking()

				const requestId = this.streamHandler.requestId

				// Build content array with thinking blocks, text (if any), and tool use blocks
				const assistantContent: Array<ClineAssistantContent> = [
					// This is critical for maintaining the model's reasoning flow and conversation integrity.
					// "When providing thinking blocks, the entire sequence of consecutive thinking blocks must match the outputs generated by the model during the original request; you cannot rearrange or modify the sequence of these blocks." The signature_delta is used to verify that the thinking was generated by Claude, and the thinking blocks will be ignored if it's incorrect or missing.
					// https://docs.claude.com/en/docs/build-with-claude/extended-thinking#preserving-thinking-blocks
					...redactedThinkingContent,
				]
				// Add thinking block from the reasoning handler if available
				const thinkingBlock = reasonsHandler.getCurrentReasoning()
				if (thinkingBlock) {
					assistantContent.push({ ...thinkingBlock })
				}

				// Only add text block if there's actual text (not just tool XML)
				const hasAssistantText = assistantTextOnly.trim().length > 0
				if (hasAssistantText) {
					assistantContent.push({
						type: "text",
						text: assistantTextOnly,
						// reasoning_details only exists for cline/openrouter providers
						reasoning_details: thinkingBlock?.summary as any[],
						signature: assistantTextSignature,
						call_id: assistantMessageId,
					})
				}

				// Get finalized tool use blocks from the handler
				const toolUseBlocks = toolUseHandler.getAllFinalizedToolUses(
					// NOTE: If there is no assistant text but there is a thinking block, we attach the summary to the tool use blocks
					// for providers that required reasoning traces included with assistant content.
					hasAssistantText ? undefined : thinkingBlock?.summary,
				)
				// Append tool use blocks if any exist
				if (toolUseBlocks.length > 0) {
					assistantContent.push(...toolUseBlocks)
				}

				// Append the assistant's content to the API conversation history only if there's content
				if (assistantContent.length > 0) {
					await this.messageStateHandler.addToApiConversationHistory({
						role: "assistant",
						content: assistantContent,
						modelInfo,
						id: requestId,
						metrics: {
							tokens: {
								prompt: taskMetrics.inputTokens,
								completion: taskMetrics.outputTokens,
								cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
							},
							cost: taskMetrics.totalCost,
						},
						ts: Date.now(),
					})
				}
			}

			this.taskState.didCompleteReadingStream = true

			// set any blocks to be complete to allow presentAssistantMessage to finish and set userMessageContentReady to true
			// (could be a text block that had no subsequent tool uses, or a text block at the very end, or an invalid tool use, etc. whatever the case, presentAssistantMessage relies on these blocks either to be completed or the user to reject a block in order to proceed and eventually set userMessageContentReady to true)
			const partialBlocks = this.taskState.assistantMessageContent.filter((block) => block.partial)
			partialBlocks.forEach((block) => {
				block.partial = false
			})
			// in case there are native tool calls pending
			const partialToolBlocks = toolUseHandler.getPartialToolUsesAsContent()?.map((block) => ({ ...block, partial: false }))
			await this.processNativeToolCalls(assistantTextOnly, partialToolBlocks)

			if (partialBlocks.length > 0) {
				await this.presentAssistantMessage() // if there is content to update then it will complete and update this.userMessageContentReady to true, which we pwaitfor before making the next request. all this is really doing is presenting the last partial message that we just set to complete
			}

			// now add to apiconversationhistory
			// need to save assistant responses to file before proceeding to tool use since user can exit at any moment and we wouldn't be able to save the assistant's response
			let didEndLoop = false
			if (assistantHasContent) {
				// NOTE: this comment is here for future reference - this was a workaround for userMessageContent not getting set to true. It was due to it not recursively calling for partial blocks when didRejectTool, so it would get stuck waiting for a partial block to complete before it could continue.
				// in case the content blocks finished
				// it may be the api stream finished after the last parsed content block was executed, so  we are able to detect out of bounds and set userMessageContentReady to true (note you should not call presentAssistantMessage since if the last block is completed it will be presented again)
				// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // if there are any partial blocks after the stream ended we can consider them invalid
				// if (this.currentStreamingContentIndex >= completeBlocks.length) {
				// 	this.userMessageContentReady = true
				// }

				await pWaitFor(() => this.taskState.userMessageContentReady)

				// Save checkpoint after all tools in this response have finished executing
				await this.checkpointManager?.saveCheckpoint()

				// if the model did not tool use, then we need to tell it to either use a tool or attempt_completion
				const didToolUse = this.taskState.assistantMessageContent.some((block) => block.type === "tool_use")

				if (!didToolUse) {
					// normal request where tool use is required
					this.taskState.userMessageContent.push({
						type: "text",
						text: formatResponse.noToolsUsed(this.useNativeToolCalls),
					})
					this.taskState.consecutiveMistakeCount++
				}

				// Reset auto-retry counter for each new API request
				this.taskState.autoRetryAttempts = 0

				const recDidEndLoop = await this.recursivelyMakeClineRequests(this.taskState.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				// if there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				const { model, providerId } = this.getCurrentProviderInfo()
				const reqId = this.getApiRequestIdSafe()

				// Minimal diagnostics: structured log and telemetry
				telemetryService.captureProviderApiError({
					ulid: this.ulid,
					model: model.id,
					provider: providerId,
					errorMessage: "empty_assistant_message",
					requestId: reqId,
					isNativeToolCall: this.useNativeToolCalls,
				})

				const baseErrorMessage =
					"Invalid API Response: The provider returned an empty or unparsable response. This is a provider-side issue where the model failed to generate valid output or returned tool calls that Cline cannot process. Retrying the request may help resolve this issue."
				const errorText = reqId ? `${baseErrorMessage} (Request ID: ${reqId})` : baseErrorMessage

				await this.say("error", errorText)
				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Failure: I did not provide a response.",
						},
					],
					modelInfo,
					id: this.streamHandler.requestId,
					metrics: {
						tokens: {
							prompt: taskMetrics.inputTokens,
							completion: taskMetrics.outputTokens,
							cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
						},
						cost: taskMetrics.totalCost,
					},
					ts: Date.now(),
				})

				let response: ClineAskResponse

				const noResponseErrorMessage = "No assistant message was received. Would you like to retry the request?"

				if (this.taskState.autoRetryAttempts < 3) {
					// Auto-retry enabled with max 3 attempts: automatically approve the retry
					this.taskState.autoRetryAttempts++

					// Calculate delay: 2s, 4s, 8s
					const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)
					response = "yesButtonClicked"
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: this.taskState.autoRetryAttempts,
							maxAttempts: 3,
							delaySeconds: delay / 1000,
							errorMessage: noResponseErrorMessage,
						}),
					)
					await setTimeoutPromise(delay)
				} else {
					// Max retries exhausted (>= 3 attempts), ask user
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: 3,
							maxAttempts: 3,
							delaySeconds: 0,
							failed: true, // Special flag to indicate retries exhausted
							errorMessage: noResponseErrorMessage,
						}),
					)
					const askResult = await this.ask("api_req_failed", noResponseErrorMessage)
					response = askResult.response
					// Reset retry counter if user chooses to manually retry
					if (response === "yesButtonClicked") {
						this.taskState.autoRetryAttempts = 0
					}
				}

				if (response === "yesButtonClicked") {
					// Signal the loop to continue (i.e., do not end), so it will attempt again
					return false
				}

				// Returns early to avoid retry since user dismissed
				return true
			}

			return didEndLoop // will always be false for now
		} catch (_error) {
			// this should never happen since the only thing that can throw an error is the attemptApiRequest, which is wrapped in a try catch that sends an ask where if noButtonClicked, will clear current task and destroy this instance. However to avoid unhandled promise rejection, we will end this loop which will end execution of this instance (see startTask)
			return true // needs to be true so parent loop knows to end task
		}
	}

	async loadContext(
		userContent: ClineContent[],
		includeFileDetails = false,
		useCompactPrompt = false,
	): Promise<[ClineContent[], string, boolean]> {
		let needsClinerulesFileCheck = false

		// Pre-fetch necessary data to avoid redundant calls within loops
		const ulid = this.ulid
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		const useNativeToolCalls = this.stateManager.getGlobalStateKey("nativeToolCallEnabled")
		const providerInfo = this.getCurrentProviderInfo()
		const cwd = this.cwd
		const { localWorkflowToggles, globalWorkflowToggles } = await refreshWorkflowToggles(this.controller, cwd)

		const hasUserContentTag = (text: string): boolean => {
			return USER_CONTENT_TAGS.some((tag) => text.includes(tag))
		}

		const parseTextBlock = async (text: string): Promise<string> => {
			const parsedText = await parseMentions(
				text,
				cwd,
				this.urlContentFetcher,
				this.fileContextTracker,
				this.workspaceManager,
			)

			// Create MCP prompt fetcher callback that wraps mcpHub.getPrompt
			const mcpPromptFetcher = async (serverName: string, promptName: string) => {
				try {
					return await this.mcpHub.getPrompt(serverName, promptName)
				} catch {
					return null
				}
			}

			const { processedText, needsClinerulesFileCheck: needsCheck } = await parseSlashCommands(
				parsedText,
				localWorkflowToggles,
				globalWorkflowToggles,
				ulid,
				focusChainSettings,
				useNativeToolCalls,
				providerInfo,
				mcpPromptFetcher,
			)

			if (needsCheck) {
				needsClinerulesFileCheck = true
			}

			return processedText
		}

		const processTextContent = async (block: ClineTextContentBlock): Promise<ClineTextContentBlock> => {
			if (block.type !== "text" || !hasUserContentTag(block.text)) {
				return block
			}

			const processedText = await parseTextBlock(block.text)
			return { ...block, text: processedText }
		}

		const processContentBlock = async (block: ClineContent): Promise<ClineContent> => {
			if (block.type === "text") {
				return processTextContent(block)
			}

			if (block.type === "tool_result") {
				if (!block.content) {
					return block
				}

				// Handle string content
				if (typeof block.content === "string") {
					const processed = await processTextContent({ type: "text", text: block.content })
					// Creates NEW object and turns the string content as array
					return { ...block, content: [processed] }
				}

				// Handle array content
				if (Array.isArray(block.content)) {
					const processedContent = await Promise.all(
						block.content.map(async (contentBlock) => {
							return contentBlock.type === "text" ? processTextContent(contentBlock) : contentBlock
						}),
					)

					return { ...block, content: processedContent }
				}
			}

			return block
		}

		// Process all content and environment details in parallel
		// NOTE: (Ara) This is a temporary solution to dynamically load context mentions from tool results. It checks for the presence of tags that indicate that the tool was rejected and feedback was provided (see formatToolDeniedFeedback, attemptCompletion, executeCommand, and consecutiveMistakeCount >= 3) or "<answer>" (see askFollowupQuestion), we place all user generated content in these tags so they can effectively be used as markers for when we should parse mentions). However if we allow multiple tools responses in the future, we will need to parse mentions specifically within the user content tags.
		// (Note: this caused the @/ import alias bug where file contents were being parsed as well, since v2 converted tool results to text blocks)
		const [processedUserContent, environmentDetails] = await Promise.all([
			Promise.all(userContent.map(processContentBlock)),
			this.getEnvironmentDetails(includeFileDetails),
		])

		// Check clinerulesData if needed
		const clinerulesError = needsClinerulesFileCheck
			? await ensureLocalClineDirExists(this.cwd, GlobalFileNames.clineRules)
			: false

		// Add focus chain instructions if needed
		if (!useCompactPrompt && this.FocusChainManager?.shouldIncludeFocusChainInstructions()) {
			const focusChainInstructions = this.FocusChainManager.generateFocusChainInstructions()
			if (focusChainInstructions.trim()) {
				processedUserContent.push({
					type: "text",
					text: focusChainInstructions,
				})

				this.taskState.apiRequestsSinceLastTodoUpdate = 0
				this.taskState.todoListWasUpdatedByUser = false
			}
		}

		return [processedUserContent, environmentDetails, clinerulesError]
	}

	async processNativeToolCalls(assistantTextOnly: string, toolBlocks: ToolUse[]) {
		if (!toolBlocks?.length) {
			return
		}
		// For native tool calls, mark all pending tool uses as complete
		const prevLength = this.taskState.assistantMessageContent.length

		// Get finalized tool uses and mark them as complete
		const textContent = assistantTextOnly.trim()
		const textBlocks: AssistantMessageContent[] = textContent ? [{ type: "text", content: textContent, partial: false }] : []

		// IMPORTANT: Finalize any partial text ClineMessage before we skip over it.
		//
		// When native tool calls are processed, we set currentStreamingContentIndex to skip
		// the text block (line below sets it to textBlocks.length). This means presentAssistantMessage
		// will never call say("text", content, false) for this text block.
		//
		// Without this fix, the partial text ClineMessage remains with partial=true. In the UI
		// (ChatView), partial messages that are not the last message don't get displayed anywhere:
		// - Not in completedMessages (because partial=true)
		// - Not in currentMessage (because it's not the last message - tool message came after)
		//
		// The text appears to "disappear" when tool calls start, even though it's still in the array.
		const clineMessages = this.messageStateHandler.getClineMessages()
		const lastMessage = clineMessages.at(-1)
		const shouldFinalizePartialText = textBlocks.length > 0
		if (shouldFinalizePartialText && lastMessage?.partial && lastMessage.type === "say" && lastMessage.say === "text") {
			lastMessage.text = textContent
			lastMessage.partial = false
			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
			const protoMessage = convertClineMessageToProto(lastMessage)
			await sendPartialMessageEvent(protoMessage)
		}

		this.taskState.assistantMessageContent = [...textBlocks, ...toolBlocks]

		// Reset index to the first tool block position so they can be executed
		// This fixes the issue where tools remain unexecuted because the index
		// advanced past them or was out of bounds during streaming
		if (toolBlocks.length > 0) {
			this.taskState.currentStreamingContentIndex = textBlocks.length
			this.taskState.userMessageContentReady = false
		} else if (this.taskState.assistantMessageContent.length > prevLength) {
			this.taskState.userMessageContentReady = false
		}
	}

	/**
	 * Format workspace roots section for multi-root workspaces
	 */
	private formatWorkspaceRootsSection(): string {
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		const hasWorkspaceManager = !!this.workspaceManager
		const roots = hasWorkspaceManager ? this.workspaceManager!.getRoots() : []

		// Only show workspace roots if multi-root is enabled and there are multiple roots
		if (!multiRootEnabled || roots.length <= 1) {
			return ""
		}

		let section = "\n\n# Workspace Roots"

		// Format each root with its name, path, and VCS info
		for (const root of roots) {
			const name = root.name || path.basename(root.path)
			const vcs = root.vcs ? ` (${String(root.vcs)})` : ""
			section += `\n- ${name}: ${root.path}${vcs}`
		}

		// Add primary workspace information
		const primary = this.workspaceManager!.getPrimaryRoot()
		const primaryName = this.getPrimaryWorkspaceName(primary)
		section += `\n\nPrimary workspace: ${primaryName}`

		return section
	}

	/**
	 * Get the display name for the primary workspace
	 */
	private getPrimaryWorkspaceName(primary?: ReturnType<WorkspaceRootManager["getRoots"]>[0]): string {
		if (primary?.name) {
			return primary.name
		}
		if (primary?.path) {
			return path.basename(primary.path)
		}
		return path.basename(this.cwd)
	}

	/**
	 * Format the file details header based on workspace configuration
	 */
	private formatFileDetailsHeader(): string {
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		const roots = this.workspaceManager?.getRoots() || []

		if (multiRootEnabled && roots.length > 1) {
			const primary = this.workspaceManager?.getPrimaryRoot()
			const primaryName = this.getPrimaryWorkspaceName(primary)
			return `\n\n# Current Working Directory (Primary: ${primaryName}) Files\n`
		}
		return `\n\n# Current Working Directory (${this.cwd.toPosix()}) Files\n`
	}

	async getEnvironmentDetails(includeFileDetails = false) {
		const host = await HostProvider.env.getHostVersion({})
		let details = ""

		// Workspace roots (multi-root)
		details += this.formatWorkspaceRootsSection()

		// It could be useful for cline to know if the user went from one or no file to another between messages, so we always include this context
		details += `\n\n# ${host.platform} Visible Files`
		const rawVisiblePaths = (await HostProvider.window.getVisibleTabs({})).paths
		const filteredVisiblePaths = await filterExistingFiles(rawVisiblePaths)
		const visibleFilePaths = filteredVisiblePaths.map((absolutePath) => path.relative(this.cwd, absolutePath))

		// Filter paths through clineIgnoreController
		const allowedVisibleFiles = this.clineIgnoreController
			.filterPaths(visibleFilePaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedVisibleFiles) {
			details += `\n${allowedVisibleFiles}`
		} else {
			details += "\n(No visible files)"
		}

		details += `\n\n# ${host.platform} Open Tabs`
		const rawOpenTabPaths = (await HostProvider.window.getOpenTabs({})).paths
		const filteredOpenTabPaths = await filterExistingFiles(rawOpenTabPaths)
		const openTabPaths = filteredOpenTabPaths.map((absolutePath) => path.relative(this.cwd, absolutePath))

		// Filter paths through clineIgnoreController
		const allowedOpenTabs = this.clineIgnoreController
			.filterPaths(openTabPaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedOpenTabs) {
			details += `\n${allowedOpenTabs}`
		} else {
			details += "\n(No open tabs)"
		}

		const busyTerminals = this.terminalManager.getTerminals(true)
		const inactiveTerminals = this.terminalManager.getTerminals(false)
		// const allTerminals = [...busyTerminals, ...inactiveTerminals]

		if (busyTerminals.length > 0 && this.taskState.didEditFile) {
			//  || this.didEditFile
			await setTimeoutPromise(300) // delay after saving file to let terminals catch up
		}
		// let terminalWasBusy = false
		if (busyTerminals.length > 0) {
			// wait for terminals to cool down
			// terminalWasBusy = allTerminals.some((t) => this.terminalManager.isProcessHot(t.id))
			await pWaitFor(() => busyTerminals.every((t) => !this.terminalManager.isProcessHot(t.id)), {
				interval: 100,
				timeout: 15_000,
			}).catch(() => {})
		}

		this.taskState.didEditFile = false // reset, this lets us know when to wait for saved files to update terminals

		// waiting for updated diagnostics lets terminal output be the most up-to-date possible
		let terminalDetails = ""
		if (busyTerminals.length > 0) {
			// terminals are cool, let's retrieve their output
			terminalDetails += "\n\n# Actively Running Terminals"
			for (const busyTerminal of busyTerminals) {
				terminalDetails += `\n## Original command: \`${busyTerminal.lastCommand}\``
				const newOutput = this.terminalManager.getUnretrievedOutput(busyTerminal.id)
				if (newOutput) {
					terminalDetails += `\n### New Output\n${newOutput}`
				} else {
					// details += `\n(Still running, no new output)` // don't want to show this right after running the command
				}
			}
		}
		// only show inactive terminals if there's output to show
		if (inactiveTerminals.length > 0) {
			const inactiveTerminalOutputs = new Map<number, string>()
			for (const inactiveTerminal of inactiveTerminals) {
				const newOutput = this.terminalManager.getUnretrievedOutput(inactiveTerminal.id)
				if (newOutput) {
					inactiveTerminalOutputs.set(inactiveTerminal.id, newOutput)
				}
			}
			if (inactiveTerminalOutputs.size > 0) {
				terminalDetails += "\n\n# Inactive Terminals"
				for (const [terminalId, newOutput] of inactiveTerminalOutputs) {
					const inactiveTerminal = inactiveTerminals.find((t) => t.id === terminalId)
					if (inactiveTerminal) {
						terminalDetails += `\n## ${inactiveTerminal.lastCommand}`
						terminalDetails += `\n### New Output\n${newOutput}`
					}
				}
			}
		}

		if (terminalDetails) {
			details += terminalDetails
		}

		// Add recently modified files section
		const recentlyModifiedFiles = this.fileContextTracker.getAndClearRecentlyModifiedFiles()
		if (recentlyModifiedFiles.length > 0) {
			details +=
				"\n\n# Recently Modified Files\nThese files have been modified since you last accessed them (file was just edited so you may need to re-read it before editing):"
			for (const filePath of recentlyModifiedFiles) {
				details += `\n${filePath}`
			}
		}

		// Add current time information with timezone
		const now = new Date()
		const formatter = new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: true,
		})
		const timeZone = formatter.resolvedOptions().timeZone
		const timeZoneOffset = -now.getTimezoneOffset() / 60 // Convert to hours and invert sign to match conventional notation
		const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : ""}${timeZoneOffset}:00`
		details += `\n\n# Current Time\n${formatter.format(now)} (${timeZone}, UTC${timeZoneOffsetStr})`

		if (includeFileDetails) {
			details += this.formatFileDetailsHeader()
			const isDesktop = arePathsEqual(this.cwd, getDesktopDir())
			if (isDesktop) {
				// don't want to immediately access desktop since it would show permission popup
				details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
			} else {
				const [files, didHitLimit] = await listFiles(this.cwd, true, 200)
				const result = formatResponse.formatFilesList(this.cwd, files, didHitLimit, this.clineIgnoreController)
				details += result
			}

			// Add workspace information in JSON format
			if (this.workspaceManager) {
				const workspacesJson = await this.workspaceManager.buildWorkspacesJson()
				if (workspacesJson) {
					details += `\n\n# Workspace Configuration\n${workspacesJson}`
				}
			}

			// Add detected CLI tools
			const availableCliTools = await detectAvailableCliTools()
			if (availableCliTools.length > 0) {
				details += `\n\n# Detected CLI Tools\nThese are some of the tools on the user's machine, and may be useful if needed to accomplish the task: ${availableCliTools.join(", ")}. This list is not exhaustive, and other tools may be available.`
			}
		}

		// Add context window usage information (conditionally for some models)
		const { contextWindow } = getContextWindowInfo(this.api)

		// Get the token count from the most recent API request to accurately reflect context management
		const getTotalTokensFromApiReqMessage = (msg: ClineMessage) => {
			if (!msg.text) {
				return 0
			}
			try {
				const { tokensIn, tokensOut, cacheWrites, cacheReads } = JSON.parse(msg.text)
				return (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
			} catch (_e) {
				return 0
			}
		}

		const clineMessages = this.messageStateHandler.getClineMessages()
		const modifiedMessages = combineApiRequests(combineCommandSequences(clineMessages.slice(1)))
		const lastApiReqMessage = findLast(modifiedMessages, (msg) => {
			if (msg.say !== "api_req_started") {
				return false
			}
			return getTotalTokensFromApiReqMessage(msg) > 0
		})

		const lastApiReqTotalTokens = lastApiReqMessage ? getTotalTokensFromApiReqMessage(lastApiReqMessage) : 0
		const usagePercentage = Math.round((lastApiReqTotalTokens / contextWindow) * 100)

		// Determine if context window info should be displayed
		const currentModelId = this.api.getModel().id
		const isNextGenModel = isClaude4PlusModelFamily(currentModelId) || isGPT5ModelFamily(currentModelId)

		let shouldShowContextWindow = true
		// For next-gen models, only show context window usage if it exceeds a certain threshold
		if (isNextGenModel) {
			const autoCondenseThreshold = 0.75
			const displayThreshold = autoCondenseThreshold - 0.15
			const currentUsageRatio = lastApiReqTotalTokens / contextWindow
			shouldShowContextWindow = currentUsageRatio >= displayThreshold
		}

		if (shouldShowContextWindow) {
			details += "\n\n# Context Window Usage"
			details += `\n${lastApiReqTotalTokens.toLocaleString()} / ${(contextWindow / 1000).toLocaleString()}K tokens used (${usagePercentage}%)`
		}

		details += "\n\n# Current Mode"
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		if (mode === "plan") {
			details += `\nPLAN MODE\n${formatResponse.planModeInstructions()}`
		} else {
			details += "\nACT MODE"
		}

		return `<environment_details>\n${details.trim()}\n</environment_details>`
	}
}
