/**
 * @fileoverview gRPC 客户端基类 - 基于 ProtoBus 的 WebView 与扩展通信层
 *
 * 本文件实现了一个抽象的 gRPC 客户端基类，用于在 WebView 环境中通过消息传递机制
 * 与 VS Code 扩展进行 Protocol Buffers (protobuf) 格式的通信。
 *
 * 架构说明：
 * ┌─────────────────┐    postMessage     ┌─────────────────┐
 * │   WebView UI    │ ─────────────────> │  VS Code 扩展   │
 * │  (ProtoBusClient) │ <───────────────── │  (gRPC 服务端)  │
 * └─────────────────┘   MessageEvent     └─────────────────┘
 *
 * biome-ignore-all lint/complexity/noThisInStatic:
 * 在静态方法中，this 指向调用该方法的构造函数（即子类），
 * 这样我们可以正确引用子类的 serviceName 属性。
 *
 * 注意：本文件直接导入 PLATFORM_CONFIG 而非使用 PlatformProvider，
 * 因为它包含的是可从多种上下文调用的静态工具方法，包括非 React 代码。
 * 由于配置是编译时常量，直接导入是安全的，
 * 并确保方法在任何 React 上下文中都能一致工作。
 */
import { v4 as uuidv4 } from "uuid"
import { PLATFORM_CONFIG } from "../config/platform.config"

/**
 * 流式响应回调函数接口
 *
 * 用于处理流式 gRPC 请求的响应、错误和完成事件。
 * 这是一个泛型接口，TResponse 表示响应数据的类型。
 *
 * @template TResponse - 响应数据的类型
 */
export interface Callbacks<TResponse> {
	/**
	 * 接收到响应数据时的回调
	 * 在流式请求中，每收到一条消息都会触发此回调
	 *
	 * @param response - 解码后的响应对象
	 */
	onResponse: (response: TResponse) => void

	/**
	 * 发生错误时的回调
	 *
	 * @param error - 包含错误信息的 Error 对象
	 */
	onError: (error: Error) => void

	/**
	 * 流式请求完成时的回调
	 * 当服务端明确结束流时触发
	 */
	onComplete: () => void
}

/**
 * ProtoBus 客户端抽象基类
 *
 * 提供与 VS Code 扩展进行 gRPC 风格通信的基础设施。
 * 子类需要实现具体的服务方法，并设置 serviceName 静态属性。
 *
 * 通信机制：
 * 1. 请求通过 window.postMessage 发送到扩展
 * 2. 响应通过 window.addEventListener("message") 接收
 * 3. 使用唯一的 requestId 匹配请求和响应
 *
 * 支持两种请求模式：
 * - 一元请求 (Unary): 发送一个请求，接收一个响应
 * - 流式请求 (Streaming): 发送一个请求，接收多个响应
 *
 * @example 子类实现示例
 * ```typescript
 * export class MyServiceClient extends ProtoBusClient {
 *   static serviceName = "MyService"
 *
 *   static async getData(request: GetDataRequest): Promise<GetDataResponse> {
 *     return this.makeUnaryRequest(
 *       "GetData",
 *       request,
 *       GetDataRequest.encode,
 *       GetDataResponse.decode
 *     )
 *   }
 * }
 * ```
 */
export abstract class ProtoBusClient {
	/**
	 * gRPC 服务名称
	 * 子类必须覆盖此属性以指定对应的服务
	 */
	static serviceName: string

	/**
	 * 发起一元 gRPC 请求
	 *
	 * 一元请求是最基本的 RPC 模式：客户端发送单个请求，服务端返回单个响应。
	 * 该方法返回一个 Promise，在收到响应或发生错误时解析。
	 *
	 * 工作流程：
	 * 1. 生成唯一的请求 ID (UUID)
	 * 2. 注册一次性消息监听器等待响应
	 * 3. 编码请求并发送到扩展
	 * 4. 收到匹配的响应后解码并返回
	 * 5. 自动清理消息监听器
	 *
	 * @template TRequest - 请求数据类型
	 * @template TResponse - 响应数据类型
	 *
	 * @param methodName - gRPC 方法名称（如 "GetUser", "CreateTask"）
	 * @param request - 请求对象，将被编码后发送
	 * @param encodeRequest - 请求编码函数，通常由 protobuf 生成
	 * @param decodeResponse - 响应解码函数，通常由 protobuf 生成
	 *
	 * @returns Promise<TResponse> - 解析为响应对象的 Promise
	 *
	 * @throws Error - 当服务端返回错误或通信失败时抛出
	 *
	 * @example
	 * ```typescript
	 * const user = await MyClient.makeUnaryRequest(
	 *   "GetUser",
	 *   { userId: "123" },
	 *   GetUserRequest.encode,
	 *   GetUserResponse.decode
	 * )
	 * ```
	 */
	static async makeUnaryRequest<TRequest, TResponse>(
		methodName: string,
		request: TRequest,
		encodeRequest: (_: TRequest) => unknown,
		decodeResponse: (_: { [key: string]: any }) => TResponse,
	): Promise<TResponse> {
		return new Promise((resolve, reject) => {
			// 生成唯一请求 ID，用于匹配请求和响应
			const requestId = uuidv4()

			/**
			 * 响应消息处理函数
			 * 监听所有 window message 事件，过滤出匹配当前请求的响应
			 */
			const handleResponse = (event: MessageEvent) => {
				const message = event.data

				// 验证消息类型和请求 ID 是否匹配
				if (message.type === "grpc_response" && message.grpc_response?.request_id === requestId) {
					// 收到响应后立即移除监听器，避免内存泄漏
					window.removeEventListener("message", handleResponse)

					if (message.grpc_response.message) {
						// 成功响应：使用平台配置解码消息并解析 Promise
						const response = PLATFORM_CONFIG.decodeMessage(message.grpc_response.message, decodeResponse)
						resolve(response)
					} else if (message.grpc_response.error) {
						// 错误响应：拒绝 Promise 并传递错误信息
						reject(new Error(message.grpc_response.error))
					} else {
						// 异常情况：响应既没有消息也没有错误
						console.error("Received ProtoBus message with no response or error ", JSON.stringify(message))
					}
				}
			}

			// 注册消息监听器
			window.addEventListener("message", handleResponse)

			// 发送 gRPC 请求到扩展
			PLATFORM_CONFIG.postMessage({
				type: "grpc_request",
				grpc_request: {
					service: this.serviceName, // 服务名称（来自子类）
					method: methodName, // 方法名称
					message: PLATFORM_CONFIG.encodeMessage(request, encodeRequest), // 编码后的请求体
					request_id: requestId, // 请求唯一标识
					is_streaming: false, // 标记为非流式请求
				},
			})
		})
	}

	/**
	 * 发起流式 gRPC 请求
	 *
	 * 流式请求允许服务端返回多个响应消息，适用于：
	 * - 实时数据推送
	 * - 大数据集分块传输
	 * - 长时间运行的任务进度更新
	 *
	 * 与一元请求不同，流式请求：
	 * 1. 使用回调函数而非 Promise 处理响应
	 * 2. 可以接收多个响应消息
	 * 3. 返回取消函数，允许客户端主动终止流
	 *
	 * 工作流程：
	 * 1. 生成唯一的请求 ID
	 * 2. 注册持久消息监听器处理多个响应
	 * 3. 编码请求并发送到扩展
	 * 4. 每收到一条消息调用 onResponse 回调
	 * 5. 流结束时调用 onComplete 并清理监听器
	 * 6. 错误时调用 onError 并清理监听器
	 *
	 * @template TRequest - 请求数据类型
	 * @template TResponse - 响应数据类型
	 *
	 * @param methodName - gRPC 方法名称
	 * @param request - 请求对象
	 * @param encodeRequest - 请求编码函数
	 * @param decodeResponse - 响应解码函数
	 * @param callbacks - 回调函数集合，包含 onResponse、onError、onComplete
	 *
	 * @returns () => void - 取消函数，调用后终止流并清理资源
	 *
	 * @example
	 * ```typescript
	 * const cancel = MyClient.makeStreamingRequest(
	 *   "WatchUpdates",
	 *   { watchId: "xyz" },
	 *   WatchRequest.encode,
	 *   WatchResponse.decode,
	 *   {
	 *     onResponse: (data) => console.log("收到更新:", data),
	 *     onError: (err) => console.error("发生错误:", err),
	 *     onComplete: () => console.log("流已结束")
	 *   }
	 * )
	 *
	 * // 需要时取消流
	 * cancel()
	 * ```
	 */
	static makeStreamingRequest<TRequest, TResponse>(
		methodName: string,
		request: TRequest,
		encodeRequest: (_: TRequest) => unknown,
		decodeResponse: (_: { [key: string]: any }) => TResponse,
		callbacks: Callbacks<TResponse>,
	): () => void {
		// 生成唯一请求 ID
		const requestId = uuidv4()

		/**
		 * 流式响应消息处理函数
		 * 与一元请求不同，此监听器会持续监听直到流结束或发生错误
		 */
		const handleResponse = (event: MessageEvent) => {
			const message = event.data

			// 验证消息类型和请求 ID
			if (message.type === "grpc_response" && message.grpc_response?.request_id === requestId) {
				if (message.grpc_response.message) {
					// 处理流式消息：解码并触发 onResponse 回调
					const response = PLATFORM_CONFIG.decodeMessage(message.grpc_response.message, decodeResponse)
					callbacks.onResponse(response)
				} else if (message.grpc_response.error) {
					// 处理错误：触发 onError 回调并清理监听器
					if (callbacks.onError) {
						callbacks.onError(new Error(message.grpc_response.error))
					}
					// 错误发生时移除事件监听器
					window.removeEventListener("message", handleResponse)
				} else {
					// 异常情况日志
					console.error("Received ProtoBus message with no response or error ", JSON.stringify(message))
				}

				// 检查流是否已结束
				// 服务端通过 is_streaming: false 标记流的最后一条消息
				if (message.grpc_response.is_streaming === false) {
					if (callbacks.onComplete) {
						callbacks.onComplete()
					}
					// 流明确结束时移除事件监听器
					window.removeEventListener("message", handleResponse)
				}
			}
		}

		// 注册消息监听器
		window.addEventListener("message", handleResponse)

		// 发送流式 gRPC 请求到扩展
		PLATFORM_CONFIG.postMessage({
			type: "grpc_request",
			grpc_request: {
				service: this.serviceName, // 服务名称（来自子类）
				method: methodName, // 方法名称
				message: PLATFORM_CONFIG.encodeMessage(request, encodeRequest), // 编码后的请求体
				request_id: requestId, // 请求唯一标识
				is_streaming: true, // 标记为流式请求
			},
		})

		/**
		 * 返回取消函数
		 * 调用此函数可以：
		 * 1. 移除消息监听器，停止处理后续响应
		 * 2. 发送取消请求到扩展，通知服务端停止发送数据
		 */
		return () => {
			window.removeEventListener("message", handleResponse)
			PLATFORM_CONFIG.postMessage({
				type: "grpc_request_cancel",
				grpc_request_cancel: {
					request_id: requestId,
				},
			})
			console.log(`[DEBUG] Sent cancellation for request: ${requestId}`)
		}
	}
}
