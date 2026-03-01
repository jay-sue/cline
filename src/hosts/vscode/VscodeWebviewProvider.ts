/**
 * @fileoverview VS Code Webview 提供者 - 扩展侧边栏的 WebView 容器
 *
 * 本文件实现了 VS Code 侧边栏 WebView 的提供者类，负责：
 * 1. 初始化和配置 WebView
 * 2. 监听来自 WebView 的消息并分发处理
 * 3. 向 WebView 发送消息
 * 4. 管理 WebView 的生命周期
 *
 * 通信架构：
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      VS Code 扩展                           │
 * │  ┌─────────────────┐    消息分发    ┌─────────────────────┐ │
 * │  │ VscodeWebview   │ ─────────────> │   grpc-handler.ts   │ │
 * │  │   Provider      │ <───────────── │   (处理 gRPC 请求)   │ │
 * │  └────────┬────────┘    响应返回    └─────────────────────┘ │
 * └───────────│─────────────────────────────────────────────────┘
 *             │ postMessage / onDidReceiveMessage
 *             │
 * ┌───────────▼─────────────────────────────────────────────────┐
 * │                      WebView (React UI)                     │
 * │  ┌─────────────────┐                ┌─────────────────────┐ │
 * │  │  ChatTextArea   │ ─────────────> │  grpc-client-base   │ │
 * │  │   (用户输入)     │                │   (发送 gRPC 请求)   │ │
 * │  └─────────────────┘                └─────────────────────┘ │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 参考实现：
 * @see https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * @see https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

import { sendShowWebviewEvent } from "@core/controller/ui/subscribeToShowWebview"
import { WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"

/**
 * VS Code Webview 提供者类
 *
 * 实现 vscode.WebviewViewProvider 接口，负责创建和管理侧边栏 WebView。
 * 这是 WebView UI 与扩展后端通信的桥梁。
 *
 * 主要职责：
 * - 创建并配置 WebView（HTML、CSP、资源路径）
 * - 监听并分发 WebView 消息到对应处理器
 * - 向 WebView 发送扩展消息
 * - 管理 WebView 可见性和生命周期
 */
export class VscodeWebviewProvider extends WebviewProvider implements vscode.WebviewViewProvider {
	// Used in package.json as the view's id. This value cannot be changed due to how vscode caches
	// views based on their id, and updating the id would break existing instances of the extension.
	public static readonly SIDEBAR_ID = ExtensionRegistryInfo.views.Sidebar

	private webview?: vscode.WebviewView
	private disposables: vscode.Disposable[] = []

	override getWebviewUrl(path: string) {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		const uri = this.webview.webview.asWebviewUri(vscode.Uri.file(path))
		return uri.toString()
	}

	override getCspSource() {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		return this.webview.webview.cspSource
	}

	override isVisible() {
		return this.webview?.visible || false
	}

	public getWebview(): vscode.WebviewView | undefined {
		return this.webview
	}

	/**
	 * Initializes and sets up the webview when it's first created.
	 *
	 * @param webviewView - The sidebar webview view instance to be resolved
	 * @returns A promise that resolves when the webview has been fully initialized
	 */
	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.webview = webviewView

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		}

		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent()
				: this.getHtmlContent()

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received
		this.setWebviewMessageListener(webviewView.webview)

		// Logs show up in bottom panel > Debug Console
		//Logger.log("registering listener")

		// Listen for when the sidebar becomes visible
		// https://github.com/microsoft/vscode-discussions/discussions/840

		// onDidChangeVisibility is only available on the sidebar webview
		// Otherwise WebviewView and WebviewPanel have all the same properties except for this visibility listener
		// WebviewPanel is not currently used in the extension
		webviewView.onDidChangeVisibility(
			async () => {
				if (this.webview?.visible) {
					// View becoming visible should not steal editor focus.
					await sendShowWebviewEvent(true)
				}
			},
			null,
			this.disposables,
		)

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is closed programmatically
		webviewView.onDidDispose(
			async () => {
				await this.dispose()
			},
			null,
			this.disposables,
		)

		// Listen for configuration changes
		vscode.workspace.onDidChangeConfiguration(
			async (e) => {
				if (e && e.affectsConfiguration("cline.mcpMarketplace.enabled")) {
					// Update state when marketplace tab setting changes
					await this.controller.postStateToWebview()
				}
			},
			null,
			this.disposables,
		)

		// if the extension is starting a new session, clear previous task state
		this.controller.clearTask()

		Logger.log("[VscodeWebviewProvider] Webview view resolved")

		// Title setting logic removed to allow VSCode to use the container title primarily.
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * IMPORTANT: When passing methods as callbacks in JavaScript/TypeScript, the method's
	 * 'this' context can be lost. This happens because the method is passed as a
	 * standalone function reference, detached from its original object.
	 *
	 * The Problem:
	 * Doing: webview.onDidReceiveMessage(this.controller.handleWebviewMessage)
	 * Would cause 'this' inside handleWebviewMessage to be undefined or wrong,
	 * leading to "TypeError: this.setUserInfo is not a function"
	 *
	 * The Solution:
	 * We wrap the method call in an arrow function, which:
	 * 1. Preserves the lexical scope's 'this' binding
	 * 2. Ensures handleWebviewMessage is called as a method on the controller instance
	 * 3. Maintains access to all controller methods and properties
	 *
	 * Alternative solutions could use .bind() or making handleWebviewMessage an arrow
	 * function property, but this approach is clean and explicit.
	 *
	 * @param webview The webview instance to attach the message listener to
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			(message) => {
				this.handleWebviewMessage(message)
			},
			null,
			this.disposables,
		)
	}

	/**
	 * 处理来自 WebView 的消息
	 *
	 * 这是 WebView 消息的主要入口点。所有来自 WebView 的消息都会经过这里，
	 * 然后根据消息类型分发到对应的处理器。
	 *
	 * 支持的消息类型：
	 * - grpc_request: gRPC 请求，转发到 handleGrpcRequest 处理
	 * - grpc_request_cancel: 取消 gRPC 请求，转发到 handleGrpcRequestCancel 处理
	 *
	 * @param message - 来自 WebView 的消息对象
	 */
	async handleWebviewMessage(message: WebviewMessage) {
		// 创建向 WebView 发送消息的函数，用于返回响应
		const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)

		switch (message.type) {
			// ==================== gRPC 请求处理 ====================
			// 这是最主要的消息类型，所有业务逻辑请求都通过这里
			case "grpc_request": {
				if (message.grpc_request) {
					// 将 gRPC 请求转发到专门的处理器
					// handleGrpcRequest 会根据 service 和 method 路由到具体的业务逻辑
					await handleGrpcRequest(this.controller, postMessageToWebview, message.grpc_request)
				}
				break
			}
			// ==================== gRPC 请求取消处理 ====================
			// 当用户取消操作时，WebView 会发送此消息
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			// ==================== 未知消息类型 ====================
			default: {
				Logger.error("Received unhandled WebviewMessage type:", JSON.stringify(message))
			}
		}
	}

	/**
	 * Sends a message from the extension to the webview.
	 *
	 * @param message - The message to send to the webview
	 * @returns A thenable that resolves to a boolean indicating success, or undefined if the webview is not available
	 */
	private async postMessageToWebview(message: ExtensionMessage): Promise<boolean | undefined> {
		return this.webview?.webview.postMessage(message)
	}

	override async dispose() {
		// WebviewView doesn't have a dispose method, it's managed by VSCode
		// We just need to clean up our disposables
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		super.dispose()
	}
}
