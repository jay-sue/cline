/**
 * @fileoverview 询问响应处理器 - 处理用户对 AI 询问的响应
 *
 * 本文件实现了 TaskService.askResponse gRPC 方法的处理逻辑。
 * 当 AI 向用户提问（如确认执行命令、请求反馈等）后，
 * 用户的响应通过此处理器传递给正在等待的 Task 实例。
 *
 * 交互流程：
 * ┌─────────────────┐
 * │ Task.ask()      │  AI 发起询问
 * │ 等待用户响应... │
 * └────────┬────────┘
 *          │
 *          │ pWaitFor 轮询等待
 *          │
 * ┌────────▼────────┐
 * │ 用户在 UI 响应   │
 * │ (按钮/输入文本)  │
 * └────────┬────────┘
 *          │
 *          ▼
 * ┌─────────────────┐
 * │ askResponse()   │  ← 本文件
 * │ 设置响应状态     │
 * └────────┬────────┘
 *          │
 *          ▼
 * ┌─────────────────┐
 * │ Task.ask()      │
 * │ 检测到响应，继续 │
 * └─────────────────┘
 *
 * 响应类型说明：
 * - yesButtonClicked: 用户点击了确认/批准按钮
 * - noButtonClicked: 用户点击了拒绝/取消按钮
 * - messageResponse: 用户输入了文本响应
 */

// ==================== 外部依赖导入 ====================

// Protocol Buffers 类型
import { Empty } from "@shared/proto/cline/common"
import { AskResponseRequest } from "@shared/proto/cline/task"
// 日志服务
import { Logger } from "@/shared/services/Logger"
// 响应类型定义
import { ClineAskResponse } from "../../../shared/WebviewMessage"
// 控制器
import { Controller } from ".."

/**
 * 处理用户对 AI 询问的响应
 *
 * 这是 TaskService.askResponse gRPC 方法的实现。
 * 当 Task 调用 ask() 方法向用户提问时，会进入等待状态。
 * 用户响应后，此函数将响应传递给 Task，使其继续执行。
 *
 * 主要职责：
 * 1. 验证是否存在活跃任务
 * 2. 映射响应类型字符串到内部枚举
 * 3. 调用 Task.handleWebviewAskResponse 传递响应
 *
 * @param controller - 控制器实例，通过它访问当前 Task
 * @param request - 响应请求，包含：
 *   - responseType: 响应类型（"yesButtonClicked" | "noButtonClicked" | "messageResponse"）
 *   - text: 可选的文本响应
 *   - images: 可选的图片（Base64 格式）
 *   - files: 可选的文件路径
 * @returns Promise<Empty> - 空响应
 *
 * @example
 * ```typescript
 * // 用户点击批准按钮
 * await askResponse(controller, {
 *   responseType: "yesButtonClicked",
 *   text: "",
 *   images: [],
 *   files: []
 * })
 *
 * // 用户输入反馈
 * await askResponse(controller, {
 *   responseType: "messageResponse",
 *   text: "请改用 TypeScript",
 *   images: [],
 *   files: []
 * })
 * ```
 */
export async function askResponse(controller: Controller, request: AskResponseRequest): Promise<Empty> {
	try {
		// ==================== 验证任务状态 ====================
		// 确保存在活跃任务可以接收响应
		if (!controller.task) {
			Logger.warn("askResponse: No active task to receive response")
			return Empty.create()
		}

		// ==================== 映射响应类型 ====================
		// 将字符串类型的 responseType 映射到内部枚举
		let responseType: ClineAskResponse
		switch (request.responseType) {
			case "yesButtonClicked":
				// 用户确认/批准操作
				responseType = "yesButtonClicked"
				break
			case "noButtonClicked":
				// 用户拒绝/取消操作
				responseType = "noButtonClicked"
				break
			case "messageResponse":
				// 用户提供文本反馈
				responseType = "messageResponse"
				break
			default:
				// 未知响应类型，记录警告并返回
				Logger.warn(`askResponse: Unknown response type: ${request.responseType}`)
				return Empty.create()
		}

		// ==================== 传递响应给 Task ====================
		// 调用 Task 的响应处理方法
		// 这将设置 taskState 中的响应字段，使 ask() 方法的等待循环能够检测到
		await controller.task.handleWebviewAskResponse(responseType, request.text, request.images, request.files)

		return Empty.create()
	} catch (error) {
		// 记录错误并重新抛出
		Logger.error("Error in askResponse handler:", error)
		throw error
	}
}
