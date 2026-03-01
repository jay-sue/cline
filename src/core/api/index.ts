/**
 * @fileoverview API 处理器工厂 - 大模型 API 调用的抽象层
 *
 * 本文件是 Cline 与各种大模型 API 交互的核心抽象层。
 * 它定义了统一的 API 处理器接口，并提供工厂函数来创建具体的处理器实例。
 *
 * 架构说明：
 * ┌─────────────────┐
 * │  Task.attemptApiRequest()  │
 * └────────┬────────┘
 *          │ 调用
 *          ▼
 * ┌─────────────────┐
 * │  this.api.createMessage()  │  ← ApiHandler 接口
 * └────────┬────────┘
 *          │ 实际实现
 *          ▼
 * ┌─────────────────────────────────────────┐
 * │         具体 Provider Handler           │
 * │  (Anthropic/OpenAI/Gemini/Ollama/...)  │
 * └─────────────────────────────────────────┘
 *
 * 支持的 API 提供商：
 * - Anthropic (Claude 系列)
 * - OpenAI (GPT 系列)
 * - OpenRouter (多模型聚合)
 * - Google (Gemini 系列)
 * - Ollama (本地模型)
 * - 以及更多...
 *
 * 主要功能：
 * 1. 统一的 API 接口定义 (ApiHandler)
 * 2. 根据配置创建对应的处理器实例 (buildApiHandler)
 * 3. 支持 Plan/Act 双模式的模型配置
 * 4. 流式响应处理 (ApiStream)
 */

// ==================== 外部依赖导入 ====================

// API 配置和模型信息类型
import { ApiConfiguration, ModelInfo, QwenApiRegions } from "@shared/api"
// 模式类型（plan/act）
import { Mode } from "@shared/storage/types"
// 消息存储类型
import { ClineStorageMessage } from "@/shared/messages/content"
// 日志服务
import { Logger } from "@/shared/services/Logger"
// 工具定义类型
import { ClineTool } from "@/shared/tools"

// ==================== API 提供商处理器导入 ====================
// 每个处理器对应一个 API 提供商的具体实现

import { AIhubmixHandler } from "./providers/aihubmix"
import { AnthropicHandler } from "./providers/anthropic"
import { AskSageHandler } from "./providers/asksage"
import { BasetenHandler } from "./providers/baseten"
import { AwsBedrockHandler } from "./providers/bedrock"
import { CerebrasHandler } from "./providers/cerebras"
import { ClaudeCodeHandler } from "./providers/claude-code"
import { ClineHandler } from "./providers/cline"
import { DeepSeekHandler } from "./providers/deepseek"
import { DifyHandler } from "./providers/dify"
import { DoubaoHandler } from "./providers/doubao"
import { FireworksHandler } from "./providers/fireworks"
import { GeminiHandler } from "./providers/gemini"
import { GroqHandler } from "./providers/groq"
import { HicapHandler } from "./providers/hicap"
import { HuaweiCloudMaaSHandler } from "./providers/huawei-cloud-maas"
import { HuggingFaceHandler } from "./providers/huggingface"
import { LiteLlmHandler } from "./providers/litellm"
import { LmStudioHandler } from "./providers/lmstudio"
import { MinimaxHandler } from "./providers/minimax"
import { MistralHandler } from "./providers/mistral"
import { MoonshotHandler } from "./providers/moonshot"
import { NebiusHandler } from "./providers/nebius"
import { NousResearchHandler } from "./providers/nousresearch"
import { OcaHandler } from "./providers/oca"
import { OllamaHandler } from "./providers/ollama"
import { OpenAiHandler } from "./providers/openai"
import { OpenAiCodexHandler } from "./providers/openai-codex"
import { OpenAiNativeHandler } from "./providers/openai-native"
import { OpenRouterHandler } from "./providers/openrouter"
import { QwenHandler } from "./providers/qwen"
import { QwenCodeHandler } from "./providers/qwen-code"
import { RequestyHandler } from "./providers/requesty"
import { SambanovaHandler } from "./providers/sambanova"
import { SapAiCoreHandler } from "./providers/sapaicore"
import { TogetherHandler } from "./providers/together"
import { VercelAIGatewayHandler } from "./providers/vercel-ai-gateway"
import { VertexHandler } from "./providers/vertex"
import { VsCodeLmHandler } from "./providers/vscode-lm"
import { XAIHandler } from "./providers/xai"
import { ZAiHandler } from "./providers/zai"
// 流式响应类型
import { ApiStream, ApiStreamUsageChunk } from "./transform/stream"

// ==================== 类型定义 ====================

/**
 * 通用 API 处理器选项
 *
 * 所有 API 处理器共享的配置选项
 */
export type CommonApiHandlerOptions = {
	/** 重试尝试回调，用于记录重试信息 */
	onRetryAttempt?: ApiConfiguration["onRetryAttempt"]
}

/**
 * API 处理器接口
 *
 * 定义了所有 API 提供商必须实现的统一接口。
 * 这是与大模型交互的核心抽象。
 */
export interface ApiHandler {
	/**
	 * 创建消息并获取模型响应
	 *
	 * 这是调用大模型 API 的核心方法。发送系统提示词、对话历史和可用工具，
	 * 返回一个异步迭代器用于流式接收响应。
	 *
	 * @param systemPrompt - 系统提示词，定义 AI 的行为和能力
	 * @param messages - 对话历史消息列表
	 * @param tools - 可选的工具列表，AI 可以调用这些工具
	 * @param useResponseApi - 是否使用 Response API（OpenAI 特有）
	 * @returns ApiStream - 异步迭代器，产生流式响应块
	 */
	createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: ClineTool[], useResponseApi?: boolean): ApiStream

	/**
	 * 获取当前使用的模型信息
	 *
	 * @returns 包含模型 ID 和详细信息的对象
	 */
	getModel(): ApiHandlerModel

	/**
	 * 获取 API 流的使用情况统计
	 *
	 * @returns Token 使用统计信息
	 */
	getApiStreamUsage?(): Promise<ApiStreamUsageChunk | undefined>

	/**
	 * 中止当前 API 请求
	 *
	 * 用于用户取消操作时立即停止 API 调用
	 */
	abort?(): void
}

/**
 * API 处理器模型信息
 *
 * 描述当前使用的模型
 */
export interface ApiHandlerModel {
	/** 模型 ID（如 "claude-4-opus-20250514"） */
	id: string
	/** 模型详细信息（上下文窗口大小、价格等） */
	info: ModelInfo
}

/**
 * API 提供商信息
 *
 * 描述当前使用的 API 提供商和模型配置
 */
export interface ApiProviderInfo {
	/** 提供商 ID（如 "anthropic", "openai"） */
	providerId: string
	/** 模型信息 */
	model: ApiHandlerModel
	/** 当前模式（"plan" 或 "act"） */
	mode: Mode
	/** 自定义提示词类型（如 "compact"） */
	customPrompt?: string
}

/**
 * 单次补全处理器接口
 *
 * 用于简单的单次补全请求，不涉及对话历史
 */
export interface SingleCompletionHandler {
	/**
	 * 完成提示词
	 *
	 * @param prompt - 输入提示词
	 * @returns 模型生成的响应文本
	 */
	completePrompt(prompt: string): Promise<string>
}

/**
 * 根据提供商创建对应的 API 处理器
 *
 * 这是一个工厂函数，根据 apiProvider 参数创建对应的处理器实例。
 * 每个提供商都有自己的处理器类，实现了 ApiHandler 接口。
 *
 * 支持的提供商包括：
 * - anthropic: Anthropic Claude 系列模型
 * - openrouter: OpenRouter 多模型聚合平台
 * - bedrock: AWS Bedrock 服务
 * - vertex: Google Cloud Vertex AI
 * - openai: OpenAI GPT 系列模型
 * - ollama: 本地 Ollama 模型
 * - gemini: Google Gemini 模型
 * - deepseek: DeepSeek 模型
 * - 以及更多...
 *
 * @param apiProvider - API 提供商标识符
 * @param options - API 配置选项（不包含 apiProvider）
 * @param mode - 当前模式（"plan" 或 "act"）
 * @returns ApiHandler - 对应提供商的处理器实例
 */
function createHandlerForProvider(
	apiProvider: string | undefined,
	options: Omit<ApiConfiguration, "apiProvider">,
	mode: Mode,
): ApiHandler {
	switch (apiProvider) {
		case "anthropic":
			return new AnthropicHandler({
				onRetryAttempt: options.onRetryAttempt,
				apiKey: options.apiKey,
				anthropicBaseUrl: options.anthropicBaseUrl,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
		case "openrouter":
			return new OpenRouterHandler({
				onRetryAttempt: options.onRetryAttempt,
				openRouterApiKey: options.openRouterApiKey,
				openRouterModelId: mode === "plan" ? options.planModeOpenRouterModelId : options.actModeOpenRouterModelId,
				openRouterModelInfo: mode === "plan" ? options.planModeOpenRouterModelInfo : options.actModeOpenRouterModelInfo,
				openRouterProviderSorting: options.openRouterProviderSorting,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
		case "bedrock":
			return new AwsBedrockHandler({
				onRetryAttempt: options.onRetryAttempt,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				awsAccessKey: options.awsAccessKey,
				awsSecretKey: options.awsSecretKey,
				awsSessionToken: options.awsSessionToken,
				awsRegion: options.awsRegion,
				awsAuthentication: options.awsAuthentication,
				awsBedrockApiKey: options.awsBedrockApiKey,
				awsUseCrossRegionInference: options.awsUseCrossRegionInference,
				awsUseGlobalInference: options.awsUseGlobalInference,
				awsBedrockUsePromptCache: options.awsBedrockUsePromptCache,
				awsUseProfile: options.awsUseProfile,
				awsProfile: options.awsProfile,
				awsBedrockEndpoint: options.awsBedrockEndpoint,
				awsBedrockCustomSelected:
					mode === "plan" ? options.planModeAwsBedrockCustomSelected : options.actModeAwsBedrockCustomSelected,
				awsBedrockCustomModelBaseId:
					mode === "plan" ? options.planModeAwsBedrockCustomModelBaseId : options.actModeAwsBedrockCustomModelBaseId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
		case "vertex":
			return new VertexHandler({
				onRetryAttempt: options.onRetryAttempt,
				vertexProjectId: options.vertexProjectId,
				vertexRegion: options.vertexRegion,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
				geminiApiKey: options.geminiApiKey,
				geminiBaseUrl: options.geminiBaseUrl,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				ulid: options.ulid,
			})
		case "openai":
			return new OpenAiHandler({
				onRetryAttempt: options.onRetryAttempt,
				openAiApiKey: options.openAiApiKey,
				openAiBaseUrl: options.openAiBaseUrl,
				azureApiVersion: options.azureApiVersion,
				azureIdentity: options.azureIdentity,
				openAiHeaders: options.openAiHeaders,
				openAiModelId: mode === "plan" ? options.planModeOpenAiModelId : options.actModeOpenAiModelId,
				openAiModelInfo: mode === "plan" ? options.planModeOpenAiModelInfo : options.actModeOpenAiModelInfo,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
			})
		case "ollama":
			return new OllamaHandler({
				onRetryAttempt: options.onRetryAttempt,
				ollamaBaseUrl: options.ollamaBaseUrl,
				ollamaApiKey: options.ollamaApiKey,
				ollamaModelId: mode === "plan" ? options.planModeOllamaModelId : options.actModeOllamaModelId,
				ollamaApiOptionsCtxNum: options.ollamaApiOptionsCtxNum,
				requestTimeoutMs: options.requestTimeoutMs,
			})
		case "lmstudio":
			return new LmStudioHandler({
				onRetryAttempt: options.onRetryAttempt,
				lmStudioBaseUrl: options.lmStudioBaseUrl,
				lmStudioModelId: mode === "plan" ? options.planModeLmStudioModelId : options.actModeLmStudioModelId,
				lmStudioMaxTokens: options.lmStudioMaxTokens,
			})
		case "gemini":
			return new GeminiHandler({
				onRetryAttempt: options.onRetryAttempt,
				vertexProjectId: options.vertexProjectId,
				vertexRegion: options.vertexRegion,
				geminiApiKey: options.geminiApiKey,
				geminiBaseUrl: options.geminiBaseUrl,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				ulid: options.ulid,
			})
		case "openai-native":
			return new OpenAiNativeHandler({
				onRetryAttempt: options.onRetryAttempt,
				openAiNativeApiKey: options.openAiNativeApiKey,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
		case "openai-codex":
			return new OpenAiCodexHandler({
				onRetryAttempt: options.onRetryAttempt,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "deepseek":
			return new DeepSeekHandler({
				onRetryAttempt: options.onRetryAttempt,
				deepSeekApiKey: options.deepSeekApiKey,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "requesty":
			return new RequestyHandler({
				onRetryAttempt: options.onRetryAttempt,
				requestyBaseUrl: options.requestyBaseUrl,
				requestyApiKey: options.requestyApiKey,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
				requestyModelId: mode === "plan" ? options.planModeRequestyModelId : options.actModeRequestyModelId,
				requestyModelInfo: mode === "plan" ? options.planModeRequestyModelInfo : options.actModeRequestyModelInfo,
			})
		case "fireworks":
			return new FireworksHandler({
				onRetryAttempt: options.onRetryAttempt,
				fireworksApiKey: options.fireworksApiKey,
				fireworksModelId: mode === "plan" ? options.planModeFireworksModelId : options.actModeFireworksModelId,
			})
		case "together":
			return new TogetherHandler({
				onRetryAttempt: options.onRetryAttempt,
				togetherApiKey: options.togetherApiKey,
				togetherModelId: mode === "plan" ? options.planModeTogetherModelId : options.actModeTogetherModelId,
			})
		case "qwen":
			return new QwenHandler({
				onRetryAttempt: options.onRetryAttempt,
				qwenApiKey: options.qwenApiKey,
				qwenApiLine:
					options.qwenApiLine === QwenApiRegions.INTERNATIONAL ? QwenApiRegions.INTERNATIONAL : QwenApiRegions.CHINA,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
		case "qwen-code":
			return new QwenCodeHandler({
				onRetryAttempt: options.onRetryAttempt,
				qwenCodeOauthPath: options.qwenCodeOauthPath,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "doubao":
			return new DoubaoHandler({
				onRetryAttempt: options.onRetryAttempt,
				doubaoApiKey: options.doubaoApiKey,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "mistral":
			return new MistralHandler({
				onRetryAttempt: options.onRetryAttempt,
				mistralApiKey: options.mistralApiKey,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "vscode-lm":
			return new VsCodeLmHandler({
				onRetryAttempt: options.onRetryAttempt,
				vsCodeLmModelSelector:
					mode === "plan" ? options.planModeVsCodeLmModelSelector : options.actModeVsCodeLmModelSelector,
			})
		case "cline": {
			const clineModelId =
				(mode === "plan" ? options.planModeClineModelId : options.actModeClineModelId) ||
				(mode === "plan" ? options.planModeOpenRouterModelId : options.actModeOpenRouterModelId)
			const clineModelInfo =
				(mode === "plan" ? options.planModeClineModelInfo : options.actModeClineModelInfo) ||
				(mode === "plan" ? options.planModeOpenRouterModelInfo : options.actModeOpenRouterModelInfo)
			return new ClineHandler({
				onRetryAttempt: options.onRetryAttempt,
				clineAccountId: options.clineAccountId,
				clineApiKey: options.clineApiKey,
				ulid: options.ulid,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
				openRouterProviderSorting: options.openRouterProviderSorting,
				openRouterModelId: clineModelId,
				openRouterModelInfo: clineModelInfo,
			})
		}
		case "litellm":
			return new LiteLlmHandler({
				onRetryAttempt: options.onRetryAttempt,
				liteLlmApiKey: options.liteLlmApiKey,
				liteLlmBaseUrl: options.liteLlmBaseUrl,
				liteLlmModelId: mode === "plan" ? options.planModeLiteLlmModelId : options.actModeLiteLlmModelId,
				liteLlmModelInfo: mode === "plan" ? options.planModeLiteLlmModelInfo : options.actModeLiteLlmModelInfo,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
				liteLlmUsePromptCache: options.liteLlmUsePromptCache,
				ulid: options.ulid,
			})
		case "moonshot":
			return new MoonshotHandler({
				onRetryAttempt: options.onRetryAttempt,
				moonshotApiKey: options.moonshotApiKey,
				moonshotApiLine: options.moonshotApiLine,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "huggingface":
			return new HuggingFaceHandler({
				onRetryAttempt: options.onRetryAttempt,
				huggingFaceApiKey: options.huggingFaceApiKey,
				huggingFaceModelId: mode === "plan" ? options.planModeHuggingFaceModelId : options.actModeHuggingFaceModelId,
				huggingFaceModelInfo:
					mode === "plan" ? options.planModeHuggingFaceModelInfo : options.actModeHuggingFaceModelInfo,
			})
		case "nebius":
			return new NebiusHandler({
				onRetryAttempt: options.onRetryAttempt,
				nebiusApiKey: options.nebiusApiKey,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "asksage":
			return new AskSageHandler({
				onRetryAttempt: options.onRetryAttempt,
				asksageApiKey: options.asksageApiKey,
				asksageApiUrl: options.asksageApiUrl,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "xai":
			return new XAIHandler({
				onRetryAttempt: options.onRetryAttempt,
				xaiApiKey: options.xaiApiKey,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "sambanova":
			return new SambanovaHandler({
				onRetryAttempt: options.onRetryAttempt,
				sambanovaApiKey: options.sambanovaApiKey,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "cerebras":
			return new CerebrasHandler({
				onRetryAttempt: options.onRetryAttempt,
				cerebrasApiKey: options.cerebrasApiKey,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "groq":
			return new GroqHandler({
				onRetryAttempt: options.onRetryAttempt,
				groqApiKey: options.groqApiKey,
				groqModelId: mode === "plan" ? options.planModeGroqModelId : options.actModeGroqModelId,
				groqModelInfo: mode === "plan" ? options.planModeGroqModelInfo : options.actModeGroqModelInfo,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "baseten":
			return new BasetenHandler({
				onRetryAttempt: options.onRetryAttempt,
				basetenApiKey: options.basetenApiKey,
				basetenModelId: mode === "plan" ? options.planModeBasetenModelId : options.actModeBasetenModelId,
				basetenModelInfo: mode === "plan" ? options.planModeBasetenModelInfo : options.actModeBasetenModelInfo,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "sapaicore":
			return new SapAiCoreHandler({
				onRetryAttempt: options.onRetryAttempt,
				sapAiCoreClientId: options.sapAiCoreClientId,
				sapAiCoreClientSecret: options.sapAiCoreClientSecret,
				sapAiCoreTokenUrl: options.sapAiCoreTokenUrl,
				sapAiResourceGroup: options.sapAiResourceGroup,
				sapAiCoreBaseUrl: options.sapAiCoreBaseUrl,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				deploymentId: mode === "plan" ? options.planModeSapAiCoreDeploymentId : options.actModeSapAiCoreDeploymentId,
				sapAiCoreUseOrchestrationMode: options.sapAiCoreUseOrchestrationMode,
			})
		case "claude-code":
			return new ClaudeCodeHandler({
				onRetryAttempt: options.onRetryAttempt,
				claudeCodePath: options.claudeCodePath,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
		case "huawei-cloud-maas":
			return new HuaweiCloudMaaSHandler({
				onRetryAttempt: options.onRetryAttempt,
				huaweiCloudMaasApiKey: options.huaweiCloudMaasApiKey,
				huaweiCloudMaasModelId:
					mode === "plan" ? options.planModeHuaweiCloudMaasModelId : options.actModeHuaweiCloudMaasModelId,
				huaweiCloudMaasModelInfo:
					mode === "plan" ? options.planModeHuaweiCloudMaasModelInfo : options.actModeHuaweiCloudMaasModelInfo,
			})
		case "dify": // Add Dify.ai handler
			return new DifyHandler({
				difyApiKey: options.difyApiKey,
				difyBaseUrl: options.difyBaseUrl,
			})
		case "vercel-ai-gateway":
			return new VercelAIGatewayHandler({
				onRetryAttempt: options.onRetryAttempt,
				vercelAiGatewayApiKey: options.vercelAiGatewayApiKey,
				openRouterModelId:
					mode === "plan" ? options.planModeVercelAiGatewayModelId : options.actModeVercelAiGatewayModelId,
				openRouterModelInfo:
					mode === "plan" ? options.planModeVercelAiGatewayModelInfo : options.actModeVercelAiGatewayModelInfo,
				reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
		case "zai":
			return new ZAiHandler({
				onRetryAttempt: options.onRetryAttempt,
				zaiApiLine: options.zaiApiLine,
				zaiApiKey: options.zaiApiKey,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			})
		case "oca":
			return new OcaHandler({
				ocaMode: options.ocaMode || "internal",
				ocaBaseUrl: options.ocaBaseUrl,
				ocaModelId: mode === "plan" ? options.planModeOcaModelId : options.actModeOcaModelId,
				ocaModelInfo: mode === "plan" ? options.planModeOcaModelInfo : options.actModeOcaModelInfo,
				ocaReasoningEffort: mode === "plan" ? options.planModeOcaReasoningEffort : options.actModeOcaReasoningEffort,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
				ocaUsePromptCache:
					mode === "plan"
						? options.planModeOcaModelInfo?.supportsPromptCache
						: options.actModeOcaModelInfo?.supportsPromptCache,
				taskId: options.ulid,
			})
		case "aihubmix":
			return new AIhubmixHandler({
				onRetryAttempt: options.onRetryAttempt,
				apiKey: options.aihubmixApiKey,
				baseURL: options.aihubmixBaseUrl,
				appCode: options.aihubmixAppCode,
				modelId: mode === "plan" ? (options as any).planModeAihubmixModelId : (options as any).actModeAihubmixModelId,
				modelInfo:
					mode === "plan" ? (options as any).planModeAihubmixModelInfo : (options as any).actModeAihubmixModelInfo,
			})
		case "minimax":
			return new MinimaxHandler({
				onRetryAttempt: options.onRetryAttempt,
				minimaxApiKey: options.minimaxApiKey,
				minimaxApiLine: options.minimaxApiLine,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
		case "hicap":
			return new HicapHandler({
				onRetryAttempt: options.onRetryAttempt,
				hicapApiKey: options.hicapApiKey,
				hicapModelId: mode === "plan" ? options.planModeHicapModelId : options.actModeHicapModelId,
			})
		case "nousResearch":
			return new NousResearchHandler({
				onRetryAttempt: options.onRetryAttempt,
				nousResearchApiKey: options.nousResearchApiKey,
				apiModelId: mode === "plan" ? options.planModeNousResearchModelId : options.actModeNousResearchModelId,
			})
		default:
			return new AnthropicHandler({
				onRetryAttempt: options.onRetryAttempt,
				apiKey: options.apiKey,
				anthropicBaseUrl: options.anthropicBaseUrl,
				apiModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
				thinkingBudgetTokens:
					mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			})
	}
}

/**
 * 构建 API 处理器
 *
 * 这是创建 API 处理器的主要入口函数。根据配置选择合适的提供商处理器，
 * 并进行必要的参数验证和调整。
 *
 * 工作流程：
 * 1. 根据模式（plan/act）选择对应的 API 提供商
 * 2. 验证思考预算 tokens 不超过模型最大 tokens
 * 3. 创建并返回对应的处理器实例
 *
 * @param configuration - API 配置，包含所有提供商的配置信息
 * @param mode - 当前模式，"plan"（规划模式）或 "act"（执行模式）
 * @returns ApiHandler - 对应提供商的处理器实例
 *
 * @example
 * ```typescript
 * const handler = buildApiHandler(apiConfig, "act")
 * const stream = handler.createMessage(systemPrompt, messages, tools)
 * for await (const chunk of stream) {
 *   // 处理流式响应
 * }
 * ```
 */
export function buildApiHandler(configuration: ApiConfiguration, mode: Mode): ApiHandler {
	// 解构配置，分离提供商信息和其他选项
	const { planModeApiProvider, actModeApiProvider, ...options } = configuration

	// 根据模式选择对应的 API 提供商
	const apiProvider = mode === "plan" ? planModeApiProvider : actModeApiProvider

	// 验证思考预算 tokens，防止超过模型最大 tokens 导致 API 错误
	// 使用 try-catch 包装以确保安全，但正常情况下不应抛出异常
	try {
		const thinkingBudgetTokens = mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens
		if (thinkingBudgetTokens && thinkingBudgetTokens > 0) {
			// 创建临时处理器以获取模型信息
			const handler = createHandlerForProvider(apiProvider, options, mode)

			const modelInfo = handler.getModel().info
			// 如果思考预算超过模型最大 tokens，进行裁剪
			if (modelInfo?.maxTokens && modelInfo.maxTokens > 0 && thinkingBudgetTokens > modelInfo.maxTokens) {
				const clippedValue = modelInfo.maxTokens - 1
				if (mode === "plan") {
					options.planModeThinkingBudgetTokens = clippedValue
				} else {
					options.actModeThinkingBudgetTokens = clippedValue
				}
			} else {
				// 如果无需调整，直接返回已创建的处理器，避免重复创建
				return handler
			}
		}
	} catch (error) {
		Logger.error("buildApiHandler error:", error)
	}

	// 创建并返回最终的处理器实例
	return createHandlerForProvider(apiProvider, options, mode)
}
