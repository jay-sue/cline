/**
 * @fileoverview 新任务处理器 - 处理来自 WebView 的新任务创建请求
 *
 * 本文件实现了 TaskService.newTask gRPC 方法的处理逻辑。
 * 当用户在聊天界面输入第一条消息时，前端会调用此方法创建新任务。
 *
 * 工作流程：
 * ┌─────────────────┐
 * │ 用户输入消息     │
 * └────────┬────────┘
 *          │
 *          ▼
 * ┌─────────────────┐
 * │ newTask()       │  ← 本文件
 * │ - 处理任务设置   │
 * │ - 合并全局配置   │
 * └────────┬────────┘
 *          │
 *          ▼
 * ┌─────────────────┐
 * │ Controller      │
 * │ .initTask()     │
 * └────────┬────────┘
 *          │
 *          ▼
 * ┌─────────────────┐
 * │ Task 实例创建    │
 * │ .startTask()    │
 * └─────────────────┘
 */

// ==================== 外部依赖导入 ====================

// Protocol Buffers 类型
import { String } from "@shared/proto/cline/common"
import { PlanActMode } from "@shared/proto/cline/state"
import { NewTaskRequest } from "@shared/proto/cline/task"
// 设置类型
import { Settings } from "@shared/storage/state-keys"
// Proto 转换工具
import { convertProtoToApiProvider } from "@/shared/proto-conversions/models/api-configuration-conversion"
// 默认浏览器设置
import { DEFAULT_BROWSER_SETTINGS } from "../../../shared/BrowserSettings"
// 控制器
import { Controller } from ".."
// 推理强度规范化
import { normalizeOpenaiReasoningEffort } from "../state/reasoningEffort"

/**
 * 创建新任务
 *
 * 这是 TaskService.newTask gRPC 方法的实现。
 * 处理用户的首次输入，创建一个新的 AI 任务。
 *
 * 主要职责：
 * 1. 解析请求中的任务设置
 * 2. 与全局设置合并，确保设置完整
 * 3. 调用 Controller.initTask 创建任务实例
 * 4. 返回任务 ID
 *
 * @param controller - 控制器实例，管理应用状态和任务生命周期
 * @param request - 新任务请求，包含：
 *   - text: 用户输入的文本
 *   - images: 用户附加的图片（Base64 格式）
 *   - files: 用户附加的文件路径
 *   - taskSettings: 可选的任务特定设置
 * @returns Promise<String> - 包含任务 ID 的响应
 *
 * @example
 * ```typescript
 * const response = await newTask(controller, {
 *   text: "帮我创建一个 React 组件",
 *   images: [],
 *   files: [],
 *   taskSettings: { mode: PlanActMode.ACT }
 * })
 * console.log(response.value) // "1234567890"
 * ```
 */
export async function newTask(controller: Controller, request: NewTaskRequest): Promise<String> {
	/**
	 * 转换 Plan/Act 模式枚举到字符串
	 *
	 * protobuf 使用枚举，但内部使用字符串表示模式
	 */
	const convertPlanActMode = (mode: PlanActMode): string => {
		return mode === PlanActMode.PLAN ? "plan" : "act"
	}

	/**
	 * 构建过滤后的任务设置
	 *
	 * 从请求中提取任务设置，并进行以下处理：
	 * 1. 与全局设置合并（确保设置完整）
	 * 2. 转换 Proto 类型到内部类型
	 * 3. 过滤掉 undefined 值
	 */
	const filteredTaskSettings: Partial<Settings> = Object.fromEntries(
		Object.entries({
			// 展开原始任务设置
			...request.taskSettings,

			// ==================== 自动审批设置 ====================
			// 与全局设置合并，确保新任务有完整的自动审批配置
			...(request.taskSettings?.autoApprovalSettings && {
				autoApprovalSettings: (() => {
					// 获取全局自动审批设置
					const globalSettings = controller.stateManager.getGlobalSettingsKey("autoApprovalSettings")
					const incomingSettings = request.taskSettings.autoApprovalSettings
					return {
						// 以全局设置为基础
						...globalSettings,
						// 覆盖版本号（如果提供）
						...(incomingSettings.version !== undefined && { version: incomingSettings.version }),
						// 覆盖通知设置（如果提供）
						...(incomingSettings.enableNotifications !== undefined && {
							enableNotifications: incomingSettings.enableNotifications,
						}),
						// 合并操作设置
						actions: {
							...globalSettings.actions,
							...(incomingSettings.actions
								? Object.fromEntries(Object.entries(incomingSettings.actions).filter(([_, v]) => v !== undefined))
								: {}),
						},
					}
				})(),
			}),

			// ==================== 浏览器设置 ====================
			...(request.taskSettings?.browserSettings && {
				browserSettings: {
					// 使用提供的视口或默认视口
					viewport: request.taskSettings.browserSettings.viewport || DEFAULT_BROWSER_SETTINGS.viewport,
					// 远程浏览器配置
					remoteBrowserHost: request.taskSettings.browserSettings.remoteBrowserHost,
					remoteBrowserEnabled: request.taskSettings.browserSettings.remoteBrowserEnabled,
					// Chrome 可执行文件路径
					chromeExecutablePath: request.taskSettings.browserSettings.chromeExecutablePath,
					// 禁用工具使用
					disableToolUse: request.taskSettings.browserSettings.disableToolUse,
					// 自定义启动参数
					customArgs: request.taskSettings.browserSettings.customArgs,
				},
			}),

			// ==================== 推理强度设置 ====================
			// 规范化 OpenAI 推理强度值
			...(request.taskSettings?.planModeReasoningEffort !== undefined && {
				planModeReasoningEffort: normalizeOpenaiReasoningEffort(request.taskSettings.planModeReasoningEffort),
			}),
			...(request.taskSettings?.actModeReasoningEffort !== undefined && {
				actModeReasoningEffort: normalizeOpenaiReasoningEffort(request.taskSettings.actModeReasoningEffort),
			}),

			// ==================== 模式设置 ====================
			...(request.taskSettings?.mode !== undefined && {
				mode: convertPlanActMode(request.taskSettings.mode),
			}),

			// ==================== 自定义提示词 ====================
			...(request.taskSettings?.customPrompt === "compact" && {
				customPrompt: "compact",
			}),

			// ==================== API 提供者设置 ====================
			// 转换 Proto 格式的 API 提供者配置
			...(request.taskSettings?.planModeApiProvider !== undefined && {
				planModeApiProvider: convertProtoToApiProvider(request.taskSettings.planModeApiProvider),
			}),
			...(request.taskSettings?.actModeApiProvider !== undefined && {
				actModeApiProvider: convertProtoToApiProvider(request.taskSettings.actModeApiProvider),
			}),
		}).filter(([_, value]) => value !== undefined), // 过滤掉 undefined 值
	)

	// 调用控制器初始化任务
	// 这将创建 Task 实例并开始执行
	const taskId = await controller.initTask(request.text, request.images, request.files, undefined, filteredTaskSettings)

	// 返回任务 ID
	return String.create({ value: taskId || "" })
}
