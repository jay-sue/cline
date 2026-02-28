/**
 * @fileoverview gRPC 请求处理器 - WebView 与扩展后端的通信桥梁
 *
 * 本文件实现了后端对来自 WebView 的 gRPC 请求的处理逻辑。
 * 它是前后端通信的核心枢纽，负责请求路由、响应发送和错误处理。
 *
 * 架构说明：
 * ┌─────────────────┐    grpc_request    ┌─────────────────┐
 * │   WebView UI    │ ─────────────────> │  gRPC Handler   │
 * │                 │ <───────────────── │  (本文件)        │
 * └─────────────────┘   grpc_response    └────────┬────────┘
 *                                                 │
 *                                    ┌────────────┼────────────┐
 *                                    ▼            ▼            ▼
 *                               TaskService  StateService  FileService
 *                               (newTask)    (subscribe)   (search)
 *
 * 主要功能：
 * 1. 请求路由 - 根据服务名和方法名分发请求到对应处理器
 * 2. 一元请求处理 - 单次请求/响应模式
 * 3. 流式请求处理 - 支持多次响应的流式模式
 * 4. 请求取消 - 支持客户端主动取消请求
 * 5. 请求录制 - 记录请求和响应用于调试
 */

// ==================== 外部依赖导入 ====================

import { Controller } from "@core/controller/index"
// 自动生成的服务处理器映射
import { serviceHandlers } from "@generated/hosts/vscode/protobus-services"
// gRPC 请求录制器
import { GrpcRecorderBuilder } from "@/core/controller/grpc-recorder/grpc-recorder.builder"
// gRPC 请求注册表
import { GrpcRequestRegistry } from "@/core/controller/grpc-request-registry"
// 扩展消息类型
import { ExtensionMessage } from "@/shared/ExtensionMessage"
// 日志服务
import { Logger } from "@/shared/services/Logger"
// WebView 消息类型
import { GrpcCancel, GrpcRequest } from "@/shared/WebviewMessage"

// ==================== 类型定义 ====================

/**
 * 流式响应处理器类型
 *
 * 用于处理流式 gRPC 请求的响应回调函数。
 * 服务端可以多次调用此函数发送多条响应消息。
 *
 * @template TResponse - 响应数据类型
 * @param response - 响应数据
 * @param isLast - 是否为最后一条消息（true 表示流结束）
 * @param sequenceNumber - 消息序列号（用于保证消息顺序）
 */
export type StreamingResponseHandler<TResponse> = (
	response: TResponse,
	isLast?: boolean,
	sequenceNumber?: number,
) => Promise<void>

/**
 * 发送消息到 WebView 的函数类型
 *
 * 封装了 VS Code WebView 的 postMessage 方法
 */
export type PostMessageToWebview = (message: ExtensionMessage) => Thenable<boolean | undefined>

// ==================== 中间件函数 ====================

/**
 * 创建录制中间件包装器
 *
 * 在发送响应前记录 gRPC 响应，用于调试和日志分析。
 * 这是一个高阶函数，包装原始的 postMessage 函数。
 *
 * @param postMessage - 原始的消息发送函数
 * @param controller - 控制器实例
 * @returns 包装后的消息发送函数
 */
function withRecordingMiddleware(postMessage: PostMessageToWebview, controller: Controller): PostMessageToWebview {
	return async (response: ExtensionMessage) => {
		// 如果存在 gRPC 响应，尝试记录
		if (response?.grpc_response) {
			try {
				GrpcRecorderBuilder.getRecorder(controller).recordResponse(
					response.grpc_response.request_id,
					response.grpc_response,
				)
			} catch (e) {
				Logger.warn("Failed to record gRPC response:", e)
			}
		}
		// 继续发送消息
		return postMessage(response)
	}
}

/**
 * 记录 gRPC 请求
 *
 * 在处理请求前记录请求信息，用于调试和日志分析。
 *
 * @param request - gRPC 请求对象
 * @param controller - 控制器实例
 */
function recordRequest(request: GrpcRequest, controller: Controller): void {
	try {
		GrpcRecorderBuilder.getRecorder(controller).recordRequest(request)
	} catch (e) {
		Logger.warn("Failed to record gRPC request:", e)
	}
}

// ==================== 主要导出函数 ====================

/**
 * 处理来自 WebView 的 gRPC 请求
 *
 * 这是 gRPC 请求处理的入口函数，负责：
 * 1. 记录请求信息
 * 2. 根据请求类型（一元/流式）分发到对应处理器
 *
 * @param controller - 控制器实例，提供对应用状态和功能的访问
 * @param postMessageToWebview - 发送消息到 WebView 的函数
 * @param request - gRPC 请求对象，包含服务名、方法名、消息体等
 */
export async function handleGrpcRequest(
	controller: Controller,
	postMessageToWebview: PostMessageToWebview,
	request: GrpcRequest,
): Promise<void> {
	// 记录请求（用于调试）
	recordRequest(request, controller)

	// 创建带录制功能的消息发送中间件
	const postMessageWithRecording = withRecordingMiddleware(postMessageToWebview, controller)

	// 根据请求类型分发处理
	if (request.is_streaming) {
		// 流式请求：支持多次响应
		await handleStreamingRequest(controller, postMessageWithRecording, request)
	} else {
		// 一元请求：单次请求/响应
		await handleUnaryRequest(controller, postMessageWithRecording, request)
	}
}

// ==================== 请求处理函数 ====================

/**
 * 处理一元 gRPC 请求
 *
 * 一元请求是最常见的 RPC 模式：
 * - 客户端发送一个请求
 * - 服务端返回一个响应
 *
 * 处理流程：
 * 1. 从服务处理器映射中获取对应的处理函数
 * 2. 调用处理函数执行业务逻辑
 * 3. 将响应发送回 WebView
 * 4. 如有错误，发送错误响应
 *
 * @param controller - 控制器实例
 * @param postMessageToWebview - 消息发送函数
 * @param request - gRPC 请求
 */
async function handleUnaryRequest(
	controller: Controller,
	postMessageToWebview: PostMessageToWebview,
	request: GrpcRequest,
): Promise<void> {
	try {
		// 从配置中获取服务处理器
		const handler = getHandler(request.service, request.method)

		// 调用处理器执行请求
		const response = await handler(controller, request.message)

		// 将响应发送回 WebView
		await postMessageToWebview({
			type: "grpc_response",
			grpc_response: {
				message: response,
				request_id: request.request_id,
			},
		})
	} catch (error) {
		// 发送错误响应
		Logger.log("Protobus error:", error)
		await postMessageToWebview({
			type: "grpc_response",
			grpc_response: {
				error: error instanceof Error ? error.message : String(error),
				request_id: request.request_id,
				is_streaming: false,
			},
		})
	}
}

/**
 * 处理流式 gRPC 请求
 *
 * 流式请求允许服务端返回多个响应，适用于：
 * - 实时状态更新（如任务进度）
 * - 大数据分块传输
 * - 长连接订阅
 *
 * 处理流程：
 * 1. 创建流式响应处理函数
 * 2. 调用处理器，传入响应流函数
 * 3. 处理器可多次调用响应流函数发送数据
 * 4. 流保持打开直到客户端断开或服务端明确结束
 *
 * @param controller - 控制器实例
 * @param postMessageToWebview - 消息发送函数
 * @param request - gRPC 请求
 */
async function handleStreamingRequest(
	controller: Controller,
	postMessageToWebview: PostMessageToWebview,
	request: GrpcRequest,
): Promise<void> {
	/**
	 * 创建流式响应函数
	 *
	 * 服务端处理器通过调用此函数向客户端发送数据。
	 * 每次调用都会发送一条消息到 WebView。
	 *
	 * @param response - 响应数据
	 * @param isLast - 是否为最后一条消息
	 * @param sequenceNumber - 消息序列号
	 */
	const responseStream: StreamingResponseHandler<any> = async (
		response: any,
		isLast: boolean = false,
		sequenceNumber?: number,
	) => {
		await postMessageToWebview({
			type: "grpc_response",
			grpc_response: {
				message: response,
				request_id: request.request_id,
				is_streaming: !isLast, // isLast=true 时 is_streaming=false，表示流结束
				sequence_number: sequenceNumber,
			},
		})
	}

	try {
		// 从配置中获取服务处理器
		const handler = getHandler(request.service, request.method)

		// 调用处理器，传入响应流函数和请求 ID
		// 处理器可以保存这些引用，在未来发送更多消息
		await handler(controller, request.message, responseStream, request.request_id)

		// 注意：不在这里发送最终消息 - 流应该保持打开以便将来更新
		// 流将在客户端断开连接或服务端明确结束时关闭
	} catch (error) {
		// 发送错误响应
		Logger.log("Protobus error:", error)
		await postMessageToWebview({
			type: "grpc_response",
			grpc_response: {
				error: error instanceof Error ? error.message : String(error),
				request_id: request.request_id,
				is_streaming: false, // 错误时关闭流
			},
		})
	}
}

/**
 * 处理 gRPC 请求取消
 *
 * 当客户端主动取消请求时调用此函数。
 * 从注册表中移除请求并执行清理操作。
 *
 * @param postMessageToWebview - 消息发送函数
 * @param request - 取消请求，包含要取消的请求 ID
 */
export async function handleGrpcRequestCancel(postMessageToWebview: PostMessageToWebview, request: GrpcCancel) {
	// 尝试取消请求
	const cancelled = requestRegistry.cancelRequest(request.request_id)

	if (cancelled) {
		// 发送取消确认
		await postMessageToWebview({
			type: "grpc_response",
			grpc_response: {
				message: { cancelled: true },
				request_id: request.request_id,
				is_streaming: false,
			},
		})
	} else {
		// 请求未找到（可能已完成或不存在）
		Logger.log(`[DEBUG] Request not found for cancellation: ${request.request_id}`)
	}
}

// ==================== 请求注册表 ====================

/**
 * gRPC 请求注册表实例
 *
 * 用于跟踪所有活跃的 gRPC 请求及其清理函数。
 * 这允许在需要时取消请求并释放资源。
 */
const requestRegistry = new GrpcRequestRegistry()

/**
 * 获取请求注册表实例
 *
 * 允许代码的其他部分访问注册表，
 * 例如在任务取消时清理相关请求。
 *
 * @returns GrpcRequestRegistry - 请求注册表实例
 */
export function getRequestRegistry(): GrpcRequestRegistry {
	return requestRegistry
}

// ==================== 辅助函数 ====================

/**
 * 获取服务处理器
 *
 * 从自动生成的服务处理器映射中查找对应的处理函数。
 * 服务处理器映射由 protobuf 编译器生成。
 *
 * @param serviceName - 服务名称（如 "TaskService"）
 * @param methodName - 方法名称（如 "newTask"）
 * @returns 对应的处理函数
 * @throws Error - 当服务或方法不存在时
 */
function getHandler(serviceName: string, methodName: string): any {
	// 查找服务配置
	const serviceConfig = serviceHandlers[serviceName]
	if (!serviceConfig) {
		throw new Error(`Unknown service: ${serviceName}`)
	}

	// 查找方法处理器
	const handler = serviceConfig[methodName]
	if (!handler) {
		throw new Error(`Unknown rpc: ${serviceName}.${methodName}`)
	}

	return handler
}
