/**
 * ============================================================================
 * Controller 模块 - Cline 扩展的核心控制器
 * ============================================================================
 *
 * 该模块是 Cline VSCode 扩展的主控制器，负责协调和管理扩展的所有核心功能。
 * 它是扩展的"大脑"，连接用户界面、任务执行、状态管理和各种服务。
 *
 * 主要职责：
 * - 任务生命周期管理（创建、执行、取消、恢复）
 * - 用户认证和授权（Cline、OCA、OpenRouter 等）
 * - 状态管理和 Webview 通信
 * - MCP (Model Context Protocol) 服务器管理
 * - 工作区管理（支持多根工作区）
 * - 远程配置获取和同步
 * - 遥测和日志记录
 *
 * 架构说明：
 * - 采用单例模式管理全局状态
 * - 使用观察者模式通知 Webview 状态变化
 * - 支持异步初始化和懒加载
 *
 * 参考文档：
 * @see https://github.com/microsoft/vscode-webview-ui-toolkit-samples
 * @see https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
 * ============================================================================
 */

// ============================================================================
// 导入依赖
// ============================================================================

// Anthropic SDK 类型定义
import type { Anthropic } from "@anthropic-ai/sdk"

// 核心模块导入
import { buildApiHandler } from "@core/api" // API 处理器构建器
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils" // 钩子功能状态检查
import { tryAcquireTaskLockWithRetry } from "@core/task/TaskLockUtils" // 任务锁获取工具
import { detectWorkspaceRoots } from "@core/workspace/detection" // 工作区根目录检测
import { setupWorkspaceManager } from "@core/workspace/setup" // 工作区管理器设置
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager" // 工作区根管理器类型

// 集成模块导入
import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration" // 旧版检查点清理

// 服务层导入
import { ClineAccountService } from "@services/account/ClineAccountService" // Cline 账户服务
import { McpHub } from "@services/mcp/McpHub" // MCP 服务器中心

// 共享类型定义导入
import type { ApiProvider, ModelInfo } from "@shared/api" // API 提供商和模型信息类型
import type { ChatContent } from "@shared/ChatContent" // 聊天内容类型
import type { ExtensionState, Platform } from "@shared/ExtensionMessage" // 扩展状态和平台类型
import type { HistoryItem } from "@shared/HistoryItem" // 历史记录项类型
import type { McpMarketplaceCatalog, McpMarketplaceItem } from "@shared/mcp" // MCP 市场目录类型
import { type Settings } from "@shared/storage/state-keys" // 设置类型
import type { Mode } from "@shared/storage/types" // 模式类型（plan/act）
import type { TelemetrySetting } from "@shared/TelemetrySetting" // 遥测设置类型
import type { UserInfo } from "@shared/UserInfo" // 用户信息类型

// 工具函数导入
import { fileExistsAtPath } from "@utils/fs" // 文件存在性检查

// 第三方库导入
import axios from "axios" // HTTP 客户端
import fs from "fs/promises" // 文件系统异步操作
import open from "open" // 打开文件/URL
import pWaitFor from "p-wait-for" // Promise 等待工具
import * as path from "path" // 路径处理

// 内部模块导入
import { ClineEnv } from "@/config" // Cline 环境配置
import type { FolderLockWithRetryResult } from "@/core/locks/types" // 文件夹锁结果类型
import { HostProvider } from "@/hosts/host-provider" // 宿主提供者
import { ExtensionRegistryInfo } from "@/registry" // 扩展注册信息
import { AuthService } from "@/services/auth/AuthService" // 认证服务
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService" // OCA 认证服务
import { LogoutReason } from "@/services/auth/types" // 登出原因枚举
import { BannerService } from "@/services/banner/BannerService" // 横幅服务
import { featureFlagsService } from "@/services/feature-flags" // 功能标志服务
import { getDistinctId } from "@/services/logging/distinctId" // 获取用户唯一标识
import { telemetryService } from "@/services/telemetry" // 遥测服务
import { ClineExtensionContext } from "@/shared/cline" // Cline 扩展上下文
import { getAxiosSettings } from "@/shared/net" // Axios 网络设置
import { ShowMessageType } from "@/shared/proto/host/window" // 消息显示类型
import { Logger } from "@/shared/services/Logger" // 日志服务
import { Session } from "@/shared/services/Session" // 会话服务
import { getLatestAnnouncementId } from "@/utils/announcements" // 获取最新公告 ID
import { getCwd, getDesktopDir } from "@/utils/path" // 路径工具函数

// 本地模块导入
import { PromptRegistry } from "../prompts/system-prompt" // 提示词注册表
import {
	ensureCacheDirectoryExists,
	ensureMcpServersDirectoryExists,
	ensureSettingsDirectoryExists,
	GlobalFileNames,
	writeMcpMarketplaceCatalogToCache,
} from "../storage/disk" // 磁盘存储工具
import { fetchRemoteConfig } from "../storage/remote-config/fetch" // 远程配置获取
import { clearRemoteConfig } from "../storage/remote-config/utils" // 远程配置清除
import { type PersistenceErrorEvent, StateManager } from "../storage/StateManager" // 状态管理器
import { Task } from "../task" // 任务类
import { sendMcpMarketplaceCatalogEvent } from "./mcp/subscribeToMcpMarketplaceCatalog" // MCP 市场事件发送
import { getClineOnboardingModels } from "./models/getClineOnboardingModels" // 获取入门模型
import { appendClineStealthModels } from "./models/refreshOpenRouterModels" // 追加隐藏模型
import { checkCliInstallation } from "./state/checkCliInstallation" // CLI 安装检查
import { sendStateUpdate } from "./state/subscribeToState" // 状态更新发送
import { sendChatButtonClickedEvent } from "./ui/subscribeToChatButtonClicked" // 聊天按钮点击事件

// ============================================================================
// Controller 类定义
// ============================================================================

/**
 * Controller 类 - Cline 扩展的核心控制器
 *
 * 该类是整个扩展的中央协调器，管理：
 * 1. 任务的完整生命周期（创建、执行、暂停、恢复、取消）
 * 2. 多种认证服务（Cline、OCA、OpenRouter、Requesty、Hicap）
 * 3. 与 Webview 的双向通信
 * 4. MCP 服务器的连接和管理
 * 5. 工作区状态的维护
 * 6. 远程配置的定期同步
 *
 * 设计模式：
 * - 使用组合模式聚合多个服务
 * - 采用异步初始化模式
 * - 实现可释放模式（Disposable Pattern）用于资源清理
 */
export class Controller {
	// ========================================================================
	// 公共属性
	// ========================================================================

	/**
	 * 当前活动的任务实例
	 * 任务代表一次完整的 AI 对话会话，包含消息历史、上下文和执行状态
	 */
	task?: Task

	/**
	 * MCP (Model Context Protocol) 服务器中心
	 * 管理所有 MCP 服务器的连接、通信和生命周期
	 */
	mcpHub: McpHub

	/**
	 * Cline 账户服务
	 * 处理 Cline 平台的账户信息和订阅状态
	 */
	accountService: ClineAccountService

	/**
	 * Cline 认证服务
	 * 处理 Cline 平台的登录、登出和令牌管理
	 */
	authService: AuthService

	/**
	 * OCA (Open Cline API) 认证服务
	 * 处理企业级 OCA 平台的认证流程
	 */
	ocaAuthService: OcaAuthService

	/**
	 * 状态管理器（只读引用）
	 * 统一管理全局状态、工作区状态和任务设置
	 */
	readonly stateManager: StateManager

	// ========================================================================
	// 私有属性
	// ========================================================================

	/**
	 * 工作区管理器
	 * 处理多根工作区的检测和管理，支持懒加载初始化
	 */
	private workspaceManager?: WorkspaceRootManager

	/**
	 * 后台命令运行状态标志
	 * 用于追踪是否有命令在后台执行
	 */
	private backgroundCommandRunning = false

	/**
	 * 后台命令关联的任务 ID
	 * 用于将后台命令与特定任务关联
	 */
	private backgroundCommandTaskId?: string

	/**
	 * 取消操作进行中标志
	 * 防止用户快速点击导致重复取消请求
	 */
	private cancelInProgress = false

	/**
	 * 远程配置定时器
	 * 用于定期（每小时）获取最新的远程配置
	 */
	private remoteConfigTimer?: NodeJS.Timeout

	// ========================================================================
	// 工作区管理器方法
	// ========================================================================

	/**
	 * 确保工作区管理器已初始化（异步懒加载）
	 *
	 * 该方法用于在任务未初始化时获取工作区信息，
	 * 主要用于文件提及（file mentions）功能。
	 *
	 * @returns 工作区管理器实例，如果初始化失败则返回 undefined
	 */
	async ensureWorkspaceManager(): Promise<WorkspaceRootManager | undefined> {
		if (!this.workspaceManager) {
			try {
				this.workspaceManager = await setupWorkspaceManager({
					stateManager: this.stateManager,
					detectRoots: detectWorkspaceRoots,
				})
			} catch (error) {
				Logger.error("[Controller] Failed to initialize workspace manager:", error)
			}
		}
		return this.workspaceManager
	}

	/**
	 * 同步获取工作区管理器
	 *
	 * 直接返回当前的工作区管理器实例，不进行初始化。
	 * 适用于已知管理器已初始化的场景。
	 *
	 * @returns 工作区管理器实例或 undefined
	 */
	getWorkspaceManager(): WorkspaceRootManager | undefined {
		return this.workspaceManager
	}

	// ========================================================================
	// 远程配置管理
	// ========================================================================

	/**
	 * 启动远程配置定期获取定时器
	 *
	 * 该方法在控制器初始化时调用，会：
	 * 1. 立即执行一次远程配置获取
	 * 2. 设置每小时自动获取的定时器
	 *
	 * 远程配置包含企业策略、功能标志等重要设置。
	 */
	private startRemoteConfigTimer() {
		// 立即获取一次远程配置
		fetchRemoteConfig(this)
		// 设置每小时定期获取（3600000 毫秒 = 1 小时）
		this.remoteConfigTimer = setInterval(() => fetchRemoteConfig(this), 3600000)
	}

	// ========================================================================
	// 构造函数
	// ========================================================================

	/**
	 * 创建 Controller 实例
	 *
	 * 初始化过程：
	 * 1. 重置会话状态
	 * 2. 注册提示词和工具
	 * 3. 初始化状态管理器并注册回调
	 * 4. 初始化各种认证服务
	 * 5. 恢复认证令牌并启动远程配置定时器
	 * 6. 初始化 MCP 服务器中心
	 * 7. 清理旧版检查点
	 * 8. 检查 CLI 安装状态
	 *
	 * @param context - Cline 扩展上下文，包含扩展的全局状态和资源
	 */
	constructor(readonly context: ClineExtensionContext) {
		// 重置会话状态，确保干净的启动环境
		Session.reset()

		// 确保提示词和工具已注册到全局注册表
		PromptRegistry.getInstance()

		// 初始化状态管理器
		this.stateManager = StateManager.get()

		// 注册状态管理器回调
		StateManager.get().registerCallbacks({
			// 持久化错误处理回调
			// 仅记录日志，不中断运行中的任务
			// 数据在内存中是安全的，会在下次防抖持久化时自动重试
			onPersistenceError: async ({ error }: PersistenceErrorEvent) => {
				Logger.error("[Controller] Storage persistence failed (will retry):", error)
			},
			// 外部状态变化同步回调
			// 当其他实例修改状态时，同步更新 Webview
			onSyncExternalChange: async () => {
				await this.postStateToWebview()
			},
		})

		// 初始化认证服务
		this.authService = AuthService.getInstance(this)
		this.ocaAuthService = OcaAuthService.initialize(this)
		this.accountService = ClineAccountService.getInstance()

		// 初始化横幅服务
		BannerService.initialize(this)

		// 异步恢复认证令牌并启动远程配置定时器
		this.authService.restoreRefreshTokenAndRetrieveAuthInfo().then(() => {
			this.startRemoteConfigTimer()
		})

		// 初始化 MCP 服务器中心
		this.mcpHub = new McpHub(
			() => ensureMcpServersDirectoryExists(),
			() => ensureSettingsDirectoryExists(),
			ExtensionRegistryInfo.version,
			telemetryService,
		)

		// 异步清理旧版检查点文件
		cleanupLegacyCheckpoints().catch((error) => {
			Logger.error("Failed to cleanup legacy checkpoints:", error)
		})

		// 检查 CLI 工具安装状态（启动时执行一次）
		checkCliInstallation(this)

		Logger.log("[Controller] ClineProvider instantiated")
	}

	// ========================================================================
	// 资源释放方法
	// ========================================================================

	/**
	 * 释放控制器持有的所有资源
	 *
	 * VSCode 扩展使用可释放模式（Disposable Pattern）来清理资源，
	 * 当侧边栏或编辑器标签被用户或系统关闭时会调用此方法。
	 *
	 * 清理内容包括：
	 * - 远程配置定时器
	 * - 当前任务
	 * - MCP 服务器连接
	 *
	 * @see https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	 * @see https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	 */
	async dispose() {
		// 清除远程配置定时器
		if (this.remoteConfigTimer) {
			clearInterval(this.remoteConfigTimer)
			this.remoteConfigTimer = undefined
		}

		// 清理当前任务
		await this.clearTask()

		// 释放 MCP 服务器中心资源
		this.mcpHub.dispose()

		Logger.error("Controller disposed")
	}

	// ========================================================================
	// Cline 认证方法
	// ========================================================================

	/**
	 * 处理 Cline 平台用户登出
	 *
	 * 登出流程：
	 * 1. 清除用户信息
	 * 2. 清除远程配置
	 * 3. 将 API 提供商重置为 OpenRouter
	 * 4. 更新 Webview 状态
	 * 5. 显示操作结果通知
	 */
	async handleSignOut() {
		try {
			// AuthService 现在在 handleDeauth() 中处理自己的存储清理
			this.stateManager.setGlobalState("userInfo", undefined)
			clearRemoteConfig()

			// 通过缓存服务更新 API 提供商配置
			const apiConfiguration = this.stateManager.getApiConfiguration()
			const updatedConfig = {
				...apiConfiguration,
				planModeApiProvider: "openrouter" as ApiProvider,
				actModeApiProvider: "openrouter" as ApiProvider,
			}
			this.stateManager.setApiConfiguration(updatedConfig)

			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Successfully logged out of Cline",
			})
		} catch (_error) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Logout failed",
			})
		}
	}

	// ========================================================================
	// OCA 认证方法
	// ========================================================================

	/**
	 * 处理 OCA (Open Cline API) 平台用户登出
	 *
	 * 调用 OCA 认证服务执行登出操作，并更新 UI 状态。
	 */
	async handleOcaSignOut() {
		try {
			await this.ocaAuthService.handleDeauth(LogoutReason.USER_INITIATED)
			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Successfully logged out of OCA",
			})
		} catch (_error) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "OCA Logout failed",
			})
		}
	}

	/**
	 * 设置用户信息
	 *
	 * @param info - 用户信息对象，传入 undefined 表示清除用户信息
	 */
	async setUserInfo(info?: UserInfo) {
		this.stateManager.setGlobalState("userInfo", info)
	}

	// ========================================================================
	// 任务生命周期管理
	// ========================================================================

	/**
	 * 初始化新任务或恢复已有任务
	 *
	 * 这是任务生命周期的核心入口点，处理：
	 * 1. 远程配置同步（非阻塞）
	 * 2. 清理现有任务
	 * 3. 新用户状态检测和更新
	 * 4. 自动审批设置版本更新
	 * 5. 工作区管理器初始化
	 * 6. 任务锁获取（防止多实例冲突）
	 * 7. 任务设置加载
	 * 8. Task 实例创建
	 * 9. 启动或恢复任务执行
	 *
	 * @param task - 任务描述文本（用户输入的提示词）
	 * @param images - 附加的图片路径数组
	 * @param files - 附加的文件路径数组
	 * @param historyItem - 历史任务记录（用于恢复任务）
	 * @param taskSettings - 任务特定的设置覆盖
	 * @returns 创建的任务 ID
	 */
	async initTask(
		task?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
	) {
		// Fire-and-forget: 故意不等待 fetchRemoteConfig 完成
		// 远程配置已在构造函数的 startRemoteConfigTimer() 中获取，
		// 企业策略（yoloModeAllowed、allowedMCPServers 等）已经应用。
		// 这个调用只是确保获取最新状态，但不应阻塞 UI。
		// getGlobalSettingsKey() 每次调用都从 remoteConfigCache 读取，
		// 所以一旦获取完成，更新就会立即应用。
		// 该函数完成后会调用 postStateToWebview() 并在内部捕获所有错误。
		fetchRemoteConfig(this)

		// 确保在开始新任务前不存在现有任务
		// 虽然用户必须清除任务才能开始新任务，但这是额外的安全保障
		await this.clearTask()

		// 从状态管理器获取各项配置
		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		const vscodeTerminalExecutionMode = this.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
		const terminalOutputLineLimit = this.stateManager.getGlobalSettingsKey("terminalOutputLineLimit")
		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		const isNewUser = this.stateManager.getGlobalStateKey("isNewUser")
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")

		// 新用户任务数量阈值
		const NEW_USER_TASK_COUNT_THRESHOLD = 10

		// 检查用户是否已完成足够多的任务，不再被视为"新用户"
		if (isNewUser && !historyItem && taskHistory && taskHistory.length >= NEW_USER_TASK_COUNT_THRESHOLD) {
			this.stateManager.setGlobalState("isNewUser", false)
			await this.postStateToWebview()
		}

		// 更新自动审批设置的版本号
		if (autoApprovalSettings) {
			const updatedAutoApprovalSettings = {
				...autoApprovalSettings,
				version: (autoApprovalSettings.version ?? 1) + 1,
			}
			this.stateManager.setGlobalState("autoApprovalSettings", updatedAutoApprovalSettings)
		}

		// 初始化并持久化工作区管理器（支持多根或单根工作区）
		// 包含遥测和降级处理
		this.workspaceManager = await setupWorkspaceManager({
			stateManager: this.stateManager,
			detectRoots: detectWorkspaceRoots,
		})

		// 获取当前工作目录，优先使用主工作区根目录，否则使用桌面目录
		const cwd = this.workspaceManager?.getPrimaryRoot()?.path || (await getCwd(getDesktopDir()))

		// 生成任务 ID：使用历史记录 ID 或当前时间戳
		const taskId = historyItem?.id || Date.now().toString()

		// 获取任务锁，防止多个扩展实例同时操作同一任务
		let taskLockAcquired = false
		const lockResult: FolderLockWithRetryResult = await tryAcquireTaskLockWithRetry(taskId)

		// 如果锁获取失败且未跳过，则抛出错误阻止任务初始化
		if (!lockResult.acquired && !lockResult.skipped) {
			const errorMessage = lockResult.conflictingLock
				? `Task locked by instance (${lockResult.conflictingLock.held_by})`
				: "Failed to acquire task lock"
			throw new Error(errorMessage)
		}

		taskLockAcquired = lockResult.acquired
		if (lockResult.acquired) {
			Logger.debug(`[Task ${taskId}] Task lock acquired`)
		} else {
			Logger.debug(`[Task ${taskId}] Task lock skipped (VS Code)`)
		}

		// 加载任务特定设置
		await this.stateManager.loadTaskSettings(taskId)
		if (taskSettings) {
			this.stateManager.setTaskSettingsBatch(taskId, taskSettings)
		}

		// 创建新的 Task 实例
		this.task = new Task({
			controller: this,
			mcpHub: this.mcpHub,
			updateTaskHistory: (historyItem) => this.updateTaskHistory(historyItem),
			postStateToWebview: () => this.postStateToWebview(),
			reinitExistingTaskFromId: (taskId) => this.reinitExistingTaskFromId(taskId),
			cancelTask: () => this.cancelTask(),
			shellIntegrationTimeout,
			terminalReuseEnabled: terminalReuseEnabled ?? true,
			terminalOutputLineLimit: terminalOutputLineLimit ?? 500,
			defaultTerminalProfile: defaultTerminalProfile ?? "default",
			vscodeTerminalExecutionMode,
			cwd,
			stateManager: this.stateManager,
			workspaceManager: this.workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			taskLockAcquired,
		})

		// 根据情况启动或恢复任务
		if (historyItem) {
			// 从历史记录恢复任务
			this.task.resumeTaskFromHistory()
		} else if (task || images || files) {
			// 启动新任务
			this.task.startTask(task, images, files)
		}

		return this.task.taskId
	}

	/**
	 * 根据任务 ID 重新初始化已有任务
	 *
	 * 从任务历史中查找指定 ID 的任务并重新初始化。
	 *
	 * @param taskId - 要恢复的任务 ID
	 */
	async reinitExistingTaskFromId(taskId: string) {
		const history = await this.getTaskWithId(taskId)
		if (history) {
			await this.initTask(undefined, undefined, undefined, history.historyItem)
		}
	}

	// ========================================================================
	// 遥测设置管理
	// ========================================================================

	/**
	 * 更新遥测设置
	 *
	 * 处理用户选择加入或退出遥测收集的逻辑。
	 * 关键点是在正确的时机捕获 opt-in/opt-out 事件：
	 * - 退出事件在更新前捕获（此时遥测仍启用，可以发送）
	 * - 加入事件在更新后捕获（此时遥测已启用，可以接收）
	 *
	 * @param telemetrySetting - 新的遥测设置值
	 */
	async updateTelemetrySetting(telemetrySetting: TelemetrySetting) {
		// 获取之前的设置以检测状态变化
		const previousSetting = this.stateManager.getGlobalSettingsKey("telemetrySetting")
		const wasOptedIn = previousSetting !== "disabled"
		const isOptedIn = telemetrySetting !== "disabled"

		// 在更新前捕获退出事件（此时遥测仍启用，可以发送事件）
		if (wasOptedIn && !isOptedIn) {
			telemetryService.captureUserOptOut()
		}

		// 更新遥测设置
		this.stateManager.setGlobalState("telemetrySetting", telemetrySetting)
		telemetryService.updateTelemetryState(isOptedIn)

		// 在更新后捕获加入事件（此时遥测已启用，可以接收事件）
		if (!wasOptedIn && isOptedIn) {
			telemetryService.captureUserOptIn()
		}

		await this.postStateToWebview()
	}

	// ========================================================================
	// 模式切换方法
	// ========================================================================

	/**
	 * 为 YOLO 模式切换到 Act 模式
	 *
	 * YOLO 模式是一种快速执行模式，会自动切换到 Act 模式。
	 *
	 * @returns 如果存在活动任务则返回 true，否则返回 false
	 */
	async toggleActModeForYoloMode(): Promise<boolean> {
		const modeToSwitchTo: Mode = "act"

		// 切换到 Act 模式
		this.stateManager.setGlobalState("mode", modeToSwitchTo)

		// 使用新模式更新 API 处理器
		// buildApiHandler 现在根据模式选择提供商
		if (this.task) {
			const apiConfiguration = this.stateManager.getApiConfiguration()
			this.task.api = buildApiHandler({ ...apiConfiguration, ulid: this.task.ulid }, modeToSwitchTo)
		}

		await this.postStateToWebview()

		// 额外的安全检查
		if (this.task) {
			return true
		}
		return false
	}

	/**
	 * 切换 Plan/Act 模式
	 *
	 * Plan 模式用于规划和讨论，Act 模式用于实际执行操作。
	 * 此方法处理模式切换的完整逻辑，包括：
	 * - 状态更新
	 * - 遥测捕获
	 * - API 处理器更新
	 * - 任务状态响应
	 *
	 * @param modeToSwitchTo - 目标模式（"plan" 或 "act"）
	 * @param chatContent - 可选的聊天内容（用于响应 Plan 模式的询问）
	 * @returns 如果成功响应了 Plan 模式询问则返回 true，否则返回 false
	 */
	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		const didSwitchToActMode = modeToSwitchTo === "act"

		// 将模式保存到全局状态
		this.stateManager.setGlobalState("mode", modeToSwitchTo)

		// 捕获模式切换遥测，无论是否知道 taskId 都记录
		telemetryService.captureModeSwitch(this.task?.ulid ?? "0", modeToSwitchTo)

		// 使用新模式更新 API 处理器
		// buildApiHandler 现在根据模式选择提供商
		if (this.task) {
			const apiConfiguration = this.stateManager.getApiConfiguration()
			this.task.api = buildApiHandler({ ...apiConfiguration, ulid: this.task.ulid }, modeToSwitchTo)
		}

		await this.postStateToWebview()

		if (this.task) {
			// 如果任务正在等待 Plan 响应，且用户切换到 Act 模式
			if (this.task.taskState.isAwaitingPlanResponse && didSwitchToActMode) {
				this.task.taskState.didRespondToPlanAskBySwitchingMode = true
				// 使用提供的 chatContent，否则使用默认消息
				await this.task.handleWebviewAskResponse(
					"messageResponse",
					chatContent?.message || "PLAN_MODE_TOGGLE_RESPONSE",
					chatContent?.images || [],
					chatContent?.files || [],
				)

				return true
			}
			// 其他情况取消任务
			this.cancelTask()
			return false
		}

		return false
	}

	// ========================================================================
	// 任务取消和后台命令管理
	// ========================================================================

	/**
	 * 取消当前任务
	 *
	 * 完整的任务取消流程：
	 * 1. 防重复检查（防止快速点击导致重复取消）
	 * 2. 更新后台命令状态
	 * 3. 中止任务执行
	 * 4. 等待流式传输结束
	 * 5. 标记任务为已废弃
	 * 6. 尝试从历史中恢复任务（保留 UI 显示）
	 * 7. 更新 Webview 状态
	 *
	 * 注意：此方法使用 finally 块确保 cancelInProgress 标志总是被清除
	 */
	async cancelTask() {
		// 防止快速点击导致重复取消
		if (this.cancelInProgress) {
			Logger.log(`[Controller.cancelTask] Cancellation already in progress, ignoring duplicate request`)
			return
		}

		if (!this.task) {
			return
		}

		// 设置标志防止并发取消
		this.cancelInProgress = true

		try {
			// 更新后台命令状态
			this.updateBackgroundCommandState(false)

			// 尝试中止任务
			try {
				await this.task.abortTask()
			} catch (error) {
				Logger.error("Failed to abort task", error)
			}

			// 等待任务完全停止
			// 条件：任务不存在、停止流式传输、完成中止流程、或等待首个块
			await pWaitFor(
				() =>
					this.task === undefined ||
					this.task.taskState.isStreaming === false ||
					this.task.taskState.didFinishAbortingStream ||
					// 如果只处理了首个块，则无需等待优雅中止
					// （关闭编辑器、浏览器等）
					this.task.taskState.isWaitingForFirstChunk,
				{
					timeout: 3_000,
				},
			).catch(() => {
				Logger.error("Failed to abort task")
			})

			if (this.task) {
				// 'abandoned' 状态将阻止此 Cline 实例影响未来的 Cline 实例 GUI
				// 这可能发生在流式请求挂起的情况下
				this.task.taskState.abandoned = true
			}

			// 在中止完成后尝试获取历史记录（钩子可能已保存消息）
			let historyItem: HistoryItem | undefined
			try {
				const result = await this.getTaskWithId(this.task.taskId)
				historyItem = result.historyItem
			} catch (error) {
				// 任务尚未在历史中（新任务无消息）
				// 捕获错误以允许代理继续进行
				Logger.log(`[Controller.cancelTask] Task not found in history: ${error}`)
			}

			// 如果找到历史记录则重新初始化，否则直接清除
			if (historyItem) {
				// 重新初始化任务以在 UI 中保持可见，显示恢复按钮
				await this.initTask(undefined, undefined, undefined, historyItem, undefined)
			} else {
				await this.clearTask()
			}

			await this.postStateToWebview()
		} finally {
			// 始终清除标志，即使取消失败
			this.cancelInProgress = false
		}
	}

	/**
	 * 更新后台命令状态
	 *
	 * 用于追踪是否有命令在后台运行，并关联到特定任务。
	 * 仅当状态实际改变时才更新 Webview。
	 *
	 * @param running - 是否正在运行
	 * @param taskId - 关联的任务 ID（可选）
	 */
	updateBackgroundCommandState(running: boolean, taskId?: string) {
		const nextTaskId = running ? taskId : undefined
		// 状态未改变时直接返回
		if (this.backgroundCommandRunning === running && this.backgroundCommandTaskId === nextTaskId) {
			return
		}
		this.backgroundCommandRunning = running
		this.backgroundCommandTaskId = nextTaskId
		void this.postStateToWebview()
	}

	/**
	 * 取消后台命令
	 *
	 * 尝试取消当前任务的后台命令。
	 * 如果取消失败，则更新后台命令状态为未运行。
	 */
	async cancelBackgroundCommand(): Promise<void> {
		const didCancel = await this.task?.cancelBackgroundCommand()
		if (!didCancel) {
			this.updateBackgroundCommandState(false)
		}
	}

	// ========================================================================
	// 认证回调处理
	// ========================================================================

	/**
	 * 处理 Cline 认证回调
	 *
	 * 当用户完成 OAuth 流程后调用此方法。
	 * 处理流程：
	 * 1. 调用认证服务完成回调处理
	 * 2. 根据设置更新 API 提供商配置
	 * 3. 标记欢迎页面为已完成
	 * 4. 获取远程配置
	 * 5. 更新当前任务的 API 处理器
	 * 6. 更新 Webview 状态
	 *
	 * @param customToken - OAuth 返回的自定义令牌
	 * @param provider - 认证提供商（默认为 "google"）
	 */
	async handleAuthCallback(customToken: string, provider: string | null = null) {
		try {
			await this.authService.handleAuthCallback(customToken, provider ? provider : "google")

			const clineProvider: ApiProvider = "cline"

			// 获取当前设置以确定如何更新提供商
			const planActSeparateModelsSetting = this.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
			const currentMode = this.stateManager.getGlobalSettingsKey("mode")

			// 从缓存获取当前 API 配置
			const currentApiConfiguration = this.stateManager.getApiConfiguration()
			const updatedConfig = { ...currentApiConfiguration }

			if (planActSeparateModelsSetting) {
				// 仅更新当前模式的提供商
				if (currentMode === "plan") {
					updatedConfig.planModeApiProvider = clineProvider
				} else {
					updatedConfig.actModeApiProvider = clineProvider
				}
			} else {
				// 更新两个模式以保持同步
				updatedConfig.planModeApiProvider = clineProvider
				updatedConfig.actModeApiProvider = clineProvider
			}

			// 通过缓存服务更新 API 配置
			this.stateManager.setApiConfiguration(updatedConfig)

			// 标记欢迎页面为已完成（用户已成功登录）
			this.stateManager.setGlobalState("welcomeViewCompleted", true)

			// 获取远程配置
			await fetchRemoteConfig(this)

			// 更新当前任务的 API 处理器
			if (this.task) {
				this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
			}

			await this.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to handle auth callback:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to log in to Cline",
			})
			// 即使登录失败，也保留现有令牌
			// 仅在显式登出时清除令牌
		}
	}

	/**
	 * 处理 OCA (Open Cline API) 认证回调
	 *
	 * 与 handleAuthCallback 类似，但用于企业级 OCA 认证。
	 *
	 * @param code - OAuth 授权码
	 * @param state - OAuth 状态参数（用于防止 CSRF 攻击）
	 */
	async handleOcaAuthCallback(code: string, state: string) {
		try {
			await this.ocaAuthService.handleAuthCallback(code, state)

			const ocaProvider: ApiProvider = "oca"

			// 获取当前设置以确定如何更新提供商
			const planActSeparateModelsSetting = this.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
			const currentMode = this.stateManager.getGlobalSettingsKey("mode")

			// 从缓存获取当前 API 配置
			const currentApiConfiguration = this.stateManager.getApiConfiguration()
			const updatedConfig = { ...currentApiConfiguration }

			if (planActSeparateModelsSetting) {
				// 仅更新当前模式的提供商
				if (currentMode === "plan") {
					updatedConfig.planModeApiProvider = ocaProvider
				} else {
					updatedConfig.actModeApiProvider = ocaProvider
				}
			} else {
				// 更新两个模式以保持同步
				updatedConfig.planModeApiProvider = ocaProvider
				updatedConfig.actModeApiProvider = ocaProvider
			}

			// 通过缓存服务更新 API 配置
			this.stateManager.setApiConfiguration(updatedConfig)

			// 标记欢迎页面为已完成（用户已成功登录）
			this.stateManager.setGlobalState("welcomeViewCompleted", true)

			// 更新当前任务的 API 处理器
			if (this.task) {
				this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
			}

			await this.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to handle auth callback:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to log in to OCA",
			})
			// 即使登录失败，也保留现有令牌
			// 仅在显式登出时清除令牌
		}
	}

	/**
	 * 处理 MCP 服务器 OAuth 回调
	 *
	 * 用于完成 MCP 服务器的 OAuth 认证流程。
	 *
	 * @param serverHash - MCP 服务器的哈希标识
	 * @param code - OAuth 授权码
	 * @param state - OAuth 状态参数（可为 null）
	 */
	async handleMcpOAuthCallback(serverHash: string, code: string, state: string | null) {
		try {
			await this.mcpHub.completeOAuth(serverHash, code, state)
			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Successfully authenticated MCP server`,
			})
		} catch (error) {
			Logger.error("Failed to complete MCP OAuth:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to authenticate MCP server`,
			})
		}
	}

	// ========================================================================
	// 任务创建
	// ========================================================================

	/**
	 * 处理任务创建请求
	 *
	 * 当用户点击聊天按钮发送消息时调用。
	 * 发送按钮点击事件并初始化新任务。
	 *
	 * @param prompt - 用户输入的提示词
	 */
	async handleTaskCreation(prompt: string) {
		await sendChatButtonClickedEvent()
		await this.initTask(prompt)
	}

	// ========================================================================
	// MCP 市场管理
	// ========================================================================

	/**
	 * 从 API 获取 MCP 市场目录
	 *
	 * 获取并处理 MCP 市场的服务器列表：
	 * 1. 从 API 获取原始数据
	 * 2. 规范化数据字段（设置默认值）
	 * 3. 根据企业允许列表过滤
	 * 4. 缓存到本地文件
	 *
	 * @returns MCP 市场目录
	 * @throws 如果 API 响应无效
	 */
	private async fetchMcpMarketplaceFromApi(): Promise<McpMarketplaceCatalog> {
		const response = await axios.get(`${ClineEnv.config().mcpBaseUrl}/marketplace`, {
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "cline-vscode-extension",
			},
			...getAxiosSettings(),
		})

		if (!response.data) {
			throw new Error("Invalid response from MCP marketplace API")
		}

		// 从远程配置获取允许列表
		const allowedMCPServers = this.stateManager.getRemoteConfigSettings().allowedMCPServers

		// 规范化市场项目数据
		let items: McpMarketplaceItem[] = (response.data || []).map((item: McpMarketplaceItem) => ({
			...item,
			githubStars: item.githubStars ?? 0,
			downloadCount: item.downloadCount ?? 0,
			tags: item.tags ?? [],
		}))

		// 如果配置了允许列表，则按列表过滤
		if (allowedMCPServers) {
			const allowedIds = new Set(allowedMCPServers.map((server) => server.id))
			items = items.filter((item: McpMarketplaceItem) => allowedIds.has(item.mcpId))
		}

		const catalog: McpMarketplaceCatalog = { items }

		// 存储到缓存文件
		await writeMcpMarketplaceCatalogToCache(catalog)
		return catalog
	}

	/**
	 * 刷新 MCP 市场目录
	 *
	 * 从 API 获取最新的市场目录，并可选地发送目录事件。
	 *
	 * @param sendCatalogEvent - 是否发送目录更新事件
	 * @returns MCP 市场目录，如果获取失败则返回 undefined
	 */
	async refreshMcpMarketplace(sendCatalogEvent: boolean): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const catalog = await this.fetchMcpMarketplaceFromApi()
			if (catalog && sendCatalogEvent) {
				await sendMcpMarketplaceCatalogEvent(catalog)
			}
			return catalog
		} catch (error) {
			Logger.error("Failed to refresh MCP marketplace:", error)
			return undefined
		}
	}

	// ========================================================================
	// 第三方 API 提供商回调处理
	// ========================================================================

	/**
	 * 处理 OpenRouter 认证回调
	 *
	 * OpenRouter 是一个 AI 模型聚合平台，支持多种模型。
	 * 此方法使用授权码交换 API 密钥并配置提供商。
	 *
	 * @param code - OAuth 授权码
	 * @throws 如果交换 API 密钥失败
	 */
	async handleOpenRouterCallback(code: string) {
		let apiKey: string
		try {
			// 使用授权码交换 API 密钥
			const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code }, getAxiosSettings())
			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			Logger.error("Error exchanging code for API key:", error)
			throw error
		}

		const openrouter: ApiProvider = "openrouter"
		const currentMode = this.stateManager.getGlobalSettingsKey("mode")

		// 通过缓存服务更新 API 配置
		const currentApiConfiguration = this.stateManager.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: openrouter,
			actModeApiProvider: openrouter,
			openRouterApiKey: apiKey,
		}
		this.stateManager.setApiConfiguration(updatedConfig)

		await this.postStateToWebview()
		if (this.task) {
			this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
		}
		// 不发送 settingsButtonClicked 事件，因为如果用户在欢迎页面会影响体验
	}

	/**
	 * 处理 Requesty 认证回调
	 *
	 * Requesty 是另一个 AI API 提供商。
	 * 此方法直接使用提供的代码作为 API 密钥。
	 *
	 * @param code - API 密钥
	 */
	async handleRequestyCallback(code: string) {
		const requesty: ApiProvider = "requesty"
		const currentMode = this.stateManager.getGlobalSettingsKey("mode")
		const currentApiConfiguration = this.stateManager.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: requesty,
			actModeApiProvider: requesty,
			requestyApiKey: code,
		}
		this.stateManager.setApiConfiguration(updatedConfig)
		await this.postStateToWebview()
		if (this.task) {
			this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
		}
	}

	/**
	 * 从磁盘缓存读取 OpenRouter 模型列表
	 *
	 * 从本地缓存文件读取 OpenRouter 支持的模型列表，
	 * 并追加 Cline 专属的隐藏模型。
	 *
	 * @returns 模型信息映射表，如果读取失败则返回 undefined
	 */
	async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
		const openRouterModelsFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)
		try {
			if (await fileExistsAtPath(openRouterModelsFilePath)) {
				const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8")
				const models = JSON.parse(fileContents)
				// 追加隐藏模型
				return appendClineStealthModels(models)
			}
		} catch (error) {
			Logger.error("Error reading cached OpenRouter models:", error)
		}
		return undefined
	}

	/**
	 * 处理 Hicap 认证回调
	 *
	 * Hicap 是一个 AI API 提供商。
	 * 此方法直接使用提供的代码作为 API 密钥。
	 *
	 * @param code - API 密钥
	 */
	async handleHicapCallback(code: string) {
		const apiKey: string = code

		const hicap: ApiProvider = "hicap"
		const currentMode = this.stateManager.getGlobalSettingsKey("mode")

		// 通过缓存服务更新 API 配置
		const currentApiConfiguration = this.stateManager.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: hicap,
			actModeApiProvider: hicap,
			hicapApiKey: apiKey,
		}
		this.stateManager.setApiConfiguration(updatedConfig)

		await this.postStateToWebview()
		this.accountService
		if (this.task) {
			this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
		}
	}

	// ========================================================================
	// 任务历史管理
	// ========================================================================

	/**
	 * 根据 ID 获取任务的完整信息
	 *
	 * 获取任务的历史记录项和所有相关文件路径，
	 * 包括 API 对话历史、UI 消息、上下文历史等。
	 *
	 * @param id - 任务 ID
	 * @returns 包含任务信息和文件路径的对象
	 * @throws 如果任务不存在或文件不存在
	 */
	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		contextHistoryFilePath: string
		taskMetadataFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const history = this.stateManager.getGlobalStateKey("taskHistory")
		const historyItem = history.find((item) => item.id === id)
		if (historyItem) {
			// 构建任务目录和各文件路径
			const taskDirPath = path.join(HostProvider.get().globalStorageFsPath, "tasks", id)
			const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
			const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
			const contextHistoryFilePath = path.join(taskDirPath, GlobalFileNames.contextHistory)
			const taskMetadataFilePath = path.join(taskDirPath, GlobalFileNames.taskMetadata)

			// 检查 API 对话历史文件是否存在
			const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
			if (fileExists) {
				const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
				return {
					historyItem,
					taskDirPath,
					apiConversationHistoryFilePath,
					uiMessagesFilePath,
					contextHistoryFilePath,
					taskMetadataFilePath,
					apiConversationHistory,
				}
			}
		}
		// 如果尝试获取不存在的任务，从状态中移除它
		// FIXME: 这种情况有时会发生，可能是因为 JSON 文件未能保存到磁盘
		await this.deleteTaskFromState(id)
		throw new Error("Task not found")
	}

	/**
	 * 导出指定 ID 的任务
	 *
	 * 打开任务目录，允许用户查看和导出任务文件。
	 *
	 * @param id - 任务 ID
	 */
	async exportTaskWithId(id: string) {
		const { taskDirPath } = await this.getTaskWithId(id)
		Logger.log(`[EXPORT] Opening task directory: ${taskDirPath}`)
		await open(taskDirPath)
	}

	/**
	 * 从状态中删除任务
	 *
	 * 从任务历史列表中移除指定任务，并通知 Webview 更新。
	 *
	 * @param id - 要删除的任务 ID
	 * @returns 更新后的任务历史列表
	 */
	async deleteTaskFromState(id: string) {
		// 从历史记录中移除任务
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")
		const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
		this.stateManager.setGlobalState("taskHistory", updatedTaskHistory)

		// 通知 Webview 任务已删除
		await this.postStateToWebview()

		return updatedTaskHistory
	}

	// ========================================================================
	// Webview 状态通信
	// ========================================================================

	/**
	 * 将当前状态发送到 Webview
	 *
	 * 这是控制器与 UI 通信的主要方法。
	 * 每当状态发生变化时调用此方法通知 Webview 更新。
	 */
	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		await sendStateUpdate(state)
	}

	/**
	 * 获取要发送到 Webview 的完整状态对象
	 *
	 * 此方法聚合所有需要在 UI 中显示的状态数据，包括：
	 * - API 配置和模型信息
	 * - 当前任务状态和消息
	 * - 用户设置和偏好
	 * - 工作区信息
	 * - 功能标志和远程配置
	 * - 各种 UI 状态（横幅、公告等）
	 *
	 * @returns 完整的扩展状态对象
	 */
	async getStateToPostToWebview(): Promise<ExtensionState> {
		// ====================================================================
		// 从缓存获取 API 配置以实现即时访问
		// ====================================================================
		const onboardingModels = getClineOnboardingModels()
		const apiConfiguration = this.stateManager.getApiConfiguration()

		// ====================================================================
		// 全局状态获取
		// ====================================================================
		const lastShownAnnouncementId = this.stateManager.getGlobalStateKey("lastShownAnnouncementId")
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")
		const userInfo = this.stateManager.getGlobalStateKey("userInfo")
		const mcpMarketplaceEnabled = this.stateManager.getGlobalStateKey("mcpMarketplaceEnabled")
		const mcpDisplayMode = this.stateManager.getGlobalStateKey("mcpDisplayMode")
		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		const vscodeTerminalExecutionMode = this.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
		const isNewUser = this.stateManager.getGlobalStateKey("isNewUser")
		const mcpResponsesCollapsed = this.stateManager.getGlobalStateKey("mcpResponsesCollapsed")
		const favoritedModelIds = this.stateManager.getGlobalStateKey("favoritedModelIds")
		const lastDismissedInfoBannerVersion = this.stateManager.getGlobalStateKey("lastDismissedInfoBannerVersion") || 0
		const lastDismissedModelBannerVersion = this.stateManager.getGlobalStateKey("lastDismissedModelBannerVersion") || 0
		const lastDismissedCliBannerVersion = this.stateManager.getGlobalStateKey("lastDismissedCliBannerVersion") || 0
		const dismissedBanners = this.stateManager.getGlobalStateKey("dismissedBanners")
		const remoteRulesToggles = this.stateManager.getGlobalStateKey("remoteRulesToggles")
		const remoteWorkflowToggles = this.stateManager.getGlobalStateKey("remoteWorkflowToggles")

		// ====================================================================
		// 全局设置获取
		// ====================================================================
		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		const preferredLanguage = this.stateManager.getGlobalSettingsKey("preferredLanguage")
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const strictPlanModeEnabled = this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled")
		const yoloModeToggled = this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")
		const subagentsEnabled = this.stateManager.getGlobalSettingsKey("subagentsEnabled")
		const telemetrySetting = this.stateManager.getGlobalSettingsKey("telemetrySetting")
		const planActSeparateModelsSetting = this.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
		const enableCheckpointsSetting = this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
		const globalClineRulesToggles = this.stateManager.getGlobalSettingsKey("globalClineRulesToggles")
		const globalWorkflowToggles = this.stateManager.getGlobalSettingsKey("globalWorkflowToggles")
		const globalSkillsToggles = this.stateManager.getGlobalSettingsKey("globalSkillsToggles")
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		const customPrompt = this.stateManager.getGlobalSettingsKey("customPrompt")
		const terminalOutputLineLimit = this.stateManager.getGlobalSettingsKey("terminalOutputLineLimit")
		const maxConsecutiveMistakes = this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")
		const doubleCheckCompletionEnabled = this.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled")

		// ====================================================================
		// 工作区状态获取
		// ====================================================================
		const localSkillsToggles = this.stateManager.getWorkspaceStateKey("localSkillsToggles")
		const localClineRulesToggles = this.stateManager.getWorkspaceStateKey("localClineRulesToggles")
		const localWindsurfRulesToggles = this.stateManager.getWorkspaceStateKey("localWindsurfRulesToggles")
		const localCursorRulesToggles = this.stateManager.getWorkspaceStateKey("localCursorRulesToggles")
		const localAgentsRulesToggles = this.stateManager.getWorkspaceStateKey("localAgentsRulesToggles")
		const workflowToggles = this.stateManager.getWorkspaceStateKey("workflowToggles")

		// ====================================================================
		// 欢迎页面状态
		// 可能为 undefined，但会在 extension.ts 的迁移中设置为 true 或 false
		// ====================================================================
		const welcomeViewCompleted = !!this.stateManager.getGlobalStateKey("welcomeViewCompleted")

		// ====================================================================
		// 当前任务状态
		// ====================================================================
		const currentTaskItem = this.task?.taskId ? (taskHistory || []).find((item) => item.id === this.task?.taskId) : undefined
		// 展开创建新数组引用 - React 需要这样来检测 useEffect 依赖中的变化
		const clineMessages = [...(this.task?.messageStateHandler.getClineMessages() || [])]
		const checkpointManagerErrorMessage = this.task?.taskState.checkpointManagerErrorMessage

		// ====================================================================
		// 处理任务历史
		// 目前只获取最新的 100 个任务
		// 更好的方案是只传递 3 个用于最近任务历史，
		// 然后在进入任务历史视图时按需获取完整历史（可能带分页）
		// ====================================================================
		const processedTaskHistory = (taskHistory || [])
			.filter((item) => item.ts && item.task)
			.sort((a, b) => b.ts - a.ts)
			.slice(0, 100)

		// ====================================================================
		// 公告和平台信息
		// ====================================================================
		const latestAnnouncementId = getLatestAnnouncementId()
		const shouldShowAnnouncement = lastShownAnnouncementId !== latestAnnouncementId
		const platform = process.platform as Platform
		const distinctId = getDistinctId()
		const version = ExtensionRegistryInfo.version
		const clineConfig = ClineEnv.config()
		const environment = clineConfig.environment

		// ====================================================================
		// 横幅服务
		// ====================================================================
		const banners = BannerService.get().getActiveBanners() ?? []
		const welcomeBanners = BannerService.get().getWelcomeBanners() ?? []

		// ====================================================================
		// 检查 OpenAI Codex 认证状态
		// ====================================================================
		const { openAiCodexOAuthManager } = await import("@/integrations/openai-codex/oauth")
		const openAiCodexIsAuthenticated = await openAiCodexOAuthManager.isAuthenticated()

		// ====================================================================
		// 构建并返回完整的扩展状态对象
		// ====================================================================
		return {
			// 版本和 API 配置
			version,
			apiConfiguration,

			// 当前任务信息
			currentTaskItem,
			clineMessages,
			currentFocusChainChecklist: this.task?.taskState.currentFocusChainChecklist || null,
			checkpointManagerErrorMessage,

			// 自动审批和浏览器设置
			autoApprovalSettings,
			browserSettings,
			focusChainSettings,
			preferredLanguage,

			// 模式设置
			mode,
			strictPlanModeEnabled,
			yoloModeToggled,
			useAutoCondense,
			subagentsEnabled,

			// 用户和账户信息
			userInfo,

			// MCP 设置
			mcpMarketplaceEnabled,
			mcpDisplayMode,

			// 遥测和模型设置
			telemetrySetting,
			planActSeparateModelsSetting,
			enableCheckpointsSetting: enableCheckpointsSetting ?? true,

			// 平台信息
			platform,
			environment,
			distinctId,

			// 规则和工作流开关
			globalClineRulesToggles: globalClineRulesToggles || {},
			localClineRulesToggles: localClineRulesToggles || {},
			localWindsurfRulesToggles: localWindsurfRulesToggles || {},
			localCursorRulesToggles: localCursorRulesToggles || {},
			localAgentsRulesToggles: localAgentsRulesToggles || {},
			localWorkflowToggles: workflowToggles || {},
			globalWorkflowToggles: globalWorkflowToggles || {},
			globalSkillsToggles: globalSkillsToggles || {},
			localSkillsToggles: localSkillsToggles || {},
			remoteRulesToggles: remoteRulesToggles,
			remoteWorkflowToggles: remoteWorkflowToggles,

			// 终端设置
			shellIntegrationTimeout,
			terminalReuseEnabled,
			vscodeTerminalExecutionMode: vscodeTerminalExecutionMode,
			defaultTerminalProfile,

			// 用户状态
			isNewUser,
			welcomeViewCompleted,
			onboardingModels,

			// UI 设置
			mcpResponsesCollapsed,
			terminalOutputLineLimit,
			maxConsecutiveMistakes,
			customPrompt,

			// 任务历史
			taskHistory: processedTaskHistory,

			// 公告
			shouldShowAnnouncement,
			favoritedModelIds,

			// 后台命令状态
			backgroundCommandRunning: this.backgroundCommandRunning,
			backgroundCommandTaskId: this.backgroundCommandTaskId,

			// 工作区信息
			workspaceRoots: this.workspaceManager?.getRoots() ?? [],
			primaryRootIndex: this.workspaceManager?.getPrimaryIndex() ?? 0,
			isMultiRootWorkspace: (this.workspaceManager?.getRoots().length ?? 0) > 1,
			multiRootSetting: {
				user: this.stateManager.getGlobalStateKey("multiRootEnabled"),
				featureFlag: true, // 多根工作区现在始终启用
			},

			// 功能标志
			clineWebToolsEnabled: {
				user: this.stateManager.getGlobalSettingsKey("clineWebToolsEnabled"),
				featureFlag: featureFlagsService.getWebtoolsEnabled(),
			},
			worktreesEnabled: {
				user: this.stateManager.getGlobalSettingsKey("worktreesEnabled"),
				featureFlag: featureFlagsService.getWorktreesEnabled(),
			},
			hooksEnabled: getHooksEnabledSafe(),

			// 横幅版本
			lastDismissedInfoBannerVersion,
			lastDismissedModelBannerVersion,
			lastDismissedCliBannerVersion,
			dismissedBanners,

			// 远程配置
			remoteConfigSettings: this.stateManager.getRemoteConfigSettings(),

			// 工具调用设置
			nativeToolCallSetting: this.stateManager.getGlobalStateKey("nativeToolCallEnabled"),
			enableParallelToolCalling: this.stateManager.getGlobalSettingsKey("enableParallelToolCalling"),
			backgroundEditEnabled: this.stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
			optOutOfRemoteConfig: this.stateManager.getGlobalSettingsKey("optOutOfRemoteConfig"),
			doubleCheckCompletionEnabled,

			// 横幅
			banners,
			welcomeBanners,

			// OpenAI Codex 状态
			openAiCodexIsAuthenticated,
		}
	}

	// ========================================================================
	// 任务清理和历史更新
	// ========================================================================

	/**
	 * 清理当前任务
	 *
	 * 执行任务清理流程：
	 * 1. 清除任务设置缓存
	 * 2. 中止任务执行
	 * 3. 移除任务引用（允许垃圾回收）
	 */
	async clearTask() {
		if (this.task) {
			// 任务结束时清除任务设置缓存
			await this.stateManager.clearTaskSettings()
		}
		await this.task?.abortTask()
		// 移除引用，一旦 Promise 结束就会被垃圾回收
		this.task = undefined
	}

	// ========================================================================
	// 缓存机制说明
	// ========================================================================

	/**
	 * 缓存机制 - 用于跟踪每个提供商实例的 Webview 消息和 API 对话历史
	 *
	 * 现在使用 retainContextWhenHidden，我们不必在用户状态中存储 Cline 消息的缓存，
	 * 但可以这样做以减少长对话中的内存占用。
	 *
	 * 注意事项：
	 * - 必须小心 ClineProvider 实例之间共享的状态，因为可能同时运行多个扩展实例。
	 *   例如，当使用相同的键缓存 Cline 消息时，两个扩展实例可能会使用相同的键
	 *   并覆盖彼此的消息。
	 * - 某些状态确实需要在实例之间共享，如 API 密钥，
	 *   但似乎没有好的方法通知其他实例 API 密钥已更改。
	 *
	 * 我们需要为每个 ClineProvider 实例的消息缓存使用唯一标识符，
	 * 因为我们可能在侧边栏之外运行多个扩展实例（如在编辑器面板中）。
	 *
	 * 关于 API 请求中的对话历史：
	 * 某些 API 消息似乎不符合 VSCode 状态要求。
	 * Anthropic 库可能以某种方式在后端操作这些值，创建循环引用，
	 * 或者 API 返回函数或 Symbol 作为消息内容的一部分。
	 *
	 * VSCode 关于状态的文档："值必须是可 JSON 字符串化的...值 — 一个值。不能包含循环引用。"
	 *
	 * 目前我们将对话历史存储在内存中，如果需要直接存储到状态中，
	 * 需要手动转换以确保正确的 JSON 字符串化。
	 */

	/**
	 * 更新任务历史记录
	 *
	 * 将任务项添加到历史记录中，如果已存在则更新，否则添加新项。
	 *
	 * @param item - 要更新或添加的历史记录项
	 * @returns 更新后的历史记录数组
	 */
	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		const history = this.stateManager.getGlobalStateKey("taskHistory")
		const existingItemIndex = history.findIndex((h) => h.id === item.id)
		if (existingItemIndex !== -1) {
			// 更新现有项
			history[existingItemIndex] = item
		} else {
			// 添加新项
			history.push(item)
		}
		this.stateManager.setGlobalState("taskHistory", history)
		return history
	}
}
