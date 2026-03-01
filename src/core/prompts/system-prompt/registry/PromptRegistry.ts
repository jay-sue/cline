/**
 * @fileoverview 提示词注册表 - 系统提示词的核心管理中心
 *
 * 本文件实现了 Cline 系统提示词的注册、管理和获取逻辑。
 * 它是 AI 代理行为定义的核心组件，负责根据不同模型生成适配的系统提示词。
 *
 * 核心概念：
 * - Variant（变体）: 针对特定模型家族优化的提示词配置
 * - Component（组件）: 可复用的提示词片段，如工具说明、规则等
 * - PromptBuilder: 根据变体配置组装完整提示词
 *
 * 架构说明：
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    PromptRegistry (单例)                     │
 * │  ┌─────────────────┐         ┌─────────────────────────┐   │
 * │  │    Variants     │         │      Components         │   │
 * │  │  ┌───────────┐  │         │  ┌─────────────────┐    │   │
 * │  │  │  Generic  │  │         │  │  tool_use       │    │   │
 * │  │  │  Claude   │  │         │  │  rules          │    │   │
 * │  │  │  Gemini   │  │         │  │  capabilities   │    │   │
 * │  │  │  NextGen  │  │         │  │  mcp_servers    │    │   │
 * │  │  │   ...     │  │         │  │     ...         │    │   │
 * │  │  └───────────┘  │         │  └─────────────────┘    │   │
 * │  └─────────────────┘         └─────────────────────────┘   │
 * └──────────────────────────────┬──────────────────────────────┘
 *                                │
 *                                ▼
 *                   ┌─────────────────────┐
 *                   │    PromptBuilder    │
 *                   │ (组装完整系统提示词)  │
 *                   └─────────────────────┘
 *
 * 工作流程：
 * 1. 初始化时加载所有变体配置和组件函数
 * 2. 根据当前模型匹配最合适的变体
 * 3. 使用 PromptBuilder 组装变体中定义的组件
 * 4. 返回完整的系统提示词字符串
 */

// ==================== 外部依赖导入 ====================

// 模型家族枚举（generic、claude、gemini 等）
import { ModelFamily } from "@/shared/prompts"
// 日志服务
import { Logger } from "@/shared/services/Logger"
// 工具定义类型
import type { ClineTool } from "@/shared/tools"
// Cline 工具集管理
import { ClineToolSet } from ".."
// 系统提示词组件获取函数
import { getSystemPromptComponents } from "../components"
// 工具集注册函数
import { registerClineToolSets } from "../tools"
// 类型定义
import type { ComponentFunction, ComponentRegistry, PromptVariant, SystemPromptContext } from "../types"
// 变体配置加载函数
import { loadAllVariantConfigs } from "../variants"
// 通用变体配置（作为后备）
import { config as genericConfig } from "../variants/generic/config"
// 提示词构建器
import { PromptBuilder } from "./PromptBuilder"

/**
 * 提示词注册表类
 *
 * 单例模式实现，管理所有系统提示词变体和组件。
 * 在 Controller 初始化时被实例化，提供系统提示词的获取服务。
 *
 * 主要职责：
 * - 管理不同模型家族的提示词变体
 * - 管理可复用的提示词组件
 * - 根据上下文匹配最合适的变体
 * - 构建完整的系统提示词
 *
 * @example
 * ```typescript
 * // 获取注册表实例
 * const registry = PromptRegistry.getInstance()
 *
 * // 根据上下文获取系统提示词
 * const systemPrompt = await registry.get(promptContext)
 * ```
 */
export class PromptRegistry {
	/** 单例实例 */
	private static instance: PromptRegistry

	/**
	 * 变体映射表
	 * Key: 变体 ID（如 "generic", "claude", "gemini"）
	 * Value: 变体配置对象
	 */
	private variants: Map<string, PromptVariant> = new Map()

	/**
	 * 组件注册表
	 * Key: 组件 ID（如 "tool_use", "rules"）
	 * Value: 组件生成函数
	 */
	private components: ComponentRegistry = {}

	/**
	 * 当前变体的原生工具列表
	 * 用于支持原生函数调用的 API（如 OpenAI Function Calling）
	 */
	public nativeTools: ClineTool[] | undefined = undefined

	/**
	 * 私有构造函数（单例模式）
	 *
	 * 初始化时执行：
	 * 1. 注册 Cline 工具集
	 * 2. 加载所有变体和组件
	 */
	private constructor() {
		// 注册所有 Cline 工具集（read_file、write_file、execute_command 等）
		registerClineToolSets()
		// 加载变体配置和组件函数
		this.load()
	}

	/**
	 * 获取注册表单例实例
	 *
	 * @returns PromptRegistry 实例
	 */
	static getInstance(): PromptRegistry {
		if (!PromptRegistry.instance) {
			PromptRegistry.instance = new PromptRegistry()
		}
		return PromptRegistry.instance
	}

	/**
	 * 加载所有提示词和组件
	 *
	 * 在初始化时调用，加载：
	 * - 所有变体配置（从 variants 目录）
	 * - 所有组件函数（从 components 目录）
	 */
	load(): void {
		this.loadVariants()
		this.loadComponents()
	}

	/**
	 * 根据上下文获取模型家族
	 *
	 * 遍历所有注册的变体，使用各变体的 matcher 函数判断是否匹配当前模型。
	 * 如果没有匹配的变体，返回通用变体（GENERIC）。
	 *
	 * @param context - 系统提示词上下文，包含模型信息
	 * @returns 匹配的模型家族标识符
	 */
	getModelFamily(context: SystemPromptContext) {
		// 确保提供者信息和模型 ID 可用
		if (context.providerInfo?.model?.id) {
			const modelId = context.providerInfo.model.id
			// 遍历所有注册的变体，找到第一个匹配的
			for (const [_, v] of this.variants.entries()) {
				try {
					if (v.matcher(context)) {
						Logger.log(`[Prompt variant] Selected: ${v.family} (model: ${modelId})`)
						return v.family
					}
				} catch {
					// 如果 matcher 抛出异常，继续检查下一个变体
				}
			}
		}
		// 如果没有匹配的变体，回退到通用变体
		const modelId = context.providerInfo?.model?.id ?? "unknown"
		Logger.log(`[Prompt variant] No matching variant found for model: ${modelId}, falling back to generic`)
		return ModelFamily.GENERIC
	}

	/**
	 * 根据上下文获取变体配置
	 *
	 * @param context - 系统提示词上下文
	 * @returns 匹配的变体配置对象
	 * @throws Error - 当找不到变体且没有通用后备时
	 */
	getVariant(context: SystemPromptContext): PromptVariant {
		const family = this.getModelFamily(context)
		const variant = this.variants.get(family) || this.variants.get(ModelFamily.GENERIC)
		if (!variant) {
			// 增强的错误信息，包含调试信息
			const availableVariants = Array.from(this.variants.keys())
			const errorDetails = {
				requestedModel: context.providerInfo.model.id,
				availableVariants,
				variantsCount: this.variants.size,
				componentsCount: Object.keys(this.components).length,
			}

			Logger.error("Prompt variant lookup failed:", errorDetails)

			throw new Error(
				`No prompt variant found for model '${context.providerInfo.model.id}' and no generic fallback available. ` +
					`Available variants: [${availableVariants.join(", ")}]. ` +
					`Registry state: variants=${this.variants.size}, components=${Object.keys(this.components).length}`,
			)
		}
		return variant
	}

	/**
	 * 获取系统提示词
	 *
	 * 这是获取系统提示词的主要方法。根据上下文：
	 * 1. 匹配合适的变体
	 * 2. 获取变体的原生工具列表
	 * 3. 使用 PromptBuilder 构建完整提示词
	 *
	 * @param context - 系统提示词上下文，包含：
	 *   - providerInfo: API 提供者和模型信息
	 *   - cwd: 当前工作目录
	 *   - mcpHub: MCP 服务器中心
	 *   - 各种规则和设置
	 * @returns 构建完成的系统提示词字符串
	 *
	 * @example
	 * ```typescript
	 * const systemPrompt = await registry.get({
	 *   providerInfo: { model: { id: "claude-4-opus" }, ... },
	 *   cwd: "/path/to/project",
	 *   ...
	 * })
	 * ```
	 */
	async get(context: SystemPromptContext): Promise<string> {
		const variant = this.getVariant(context)

		// 获取当前变体的原生工具列表
		// 注意：这种方式不太优雅，但目前可行
		this.nativeTools = ClineToolSet.getNativeTools(variant, context)

		// 使用 PromptBuilder 组装完整的系统提示词
		const builder = new PromptBuilder(variant, context, this.components)
		return await builder.build()
	}

	/**
	 * 获取指定版本的提示词
	 *
	 * 用于获取特定版本的提示词变体，支持版本回溯和测试。
	 *
	 * @param modelId - 模型标识符
	 * @param version - 版本号
	 * @param context - 系统提示词上下文
	 * @param isNextGenModelFamily - 是否优先使用下一代变体
	 * @returns 指定版本的系统提示词
	 * @throws Error - 当找不到指定版本时
	 */
	async getVersion(
		modelId: string,
		version: number,
		context: SystemPromptContext,
		isNextGenModelFamily?: boolean,
	): Promise<string> {
		// 如果是下一代模型家族，优先使用下一代变体
		if (isNextGenModelFamily) {
			const nextGenVariant = this.variants.get(ModelFamily.NEXT_GEN)
			if (nextGenVariant && nextGenVariant.version === version) {
				const builder = new PromptBuilder(nextGenVariant, context, this.components)
				return await builder.build()
			}
		}

		// 查找指定版本的变体
		const variantKey = `${modelId}@${version}`
		let variant = this.variants.get(variantKey)

		if (!variant) {
			// 遍历查找匹配版本号的变体
			for (const [key, v] of this.variants.entries()) {
				if (key.startsWith(modelId) && v.version === version) {
					variant = v
					break
				}
			}
		}

		if (!variant) {
			throw new Error(`No prompt variant found for model '${modelId}' version ${version}`)
		}

		const builder = new PromptBuilder(variant, context, this.components)
		return await builder.build()
	}

	/**
	 * 根据标签或标注获取提示词
	 *
	 * 支持通过 tag（标签）或 label（标注）查找特定变体。
	 * 标签用于分类，标注用于更细粒度的标识。
	 *
	 * @param modelId - 模型标识符
	 * @param tag - 可选的标签（如 "experimental", "stable"）
	 * @param label - 可选的标注（如 "v2", "beta"）
	 * @param context - 系统提示词上下文
	 * @param isNextGenModelFamily - 是否优先使用下一代变体
	 * @returns 匹配的系统提示词
	 * @throws Error - 当找不到匹配的变体或缺少上下文时
	 */
	async getByTag(
		modelId: string,
		tag?: string,
		label?: string,
		context?: SystemPromptContext,
		isNextGenModelFamily?: boolean,
	): Promise<string> {
		if (!context) {
			throw new Error("Context is required for prompt building")
		}

		let variant: PromptVariant | undefined

		// 如果是下一代模型家族，优先使用匹配的下一代变体
		if (isNextGenModelFamily) {
			const nextGenVariant = this.variants.get(ModelFamily.NEXT_GEN)
			if (nextGenVariant) {
				// 检查下一代变体是否匹配标准
				const matchesLabel = label && nextGenVariant.labels[label] !== undefined
				const matchesTag = tag && nextGenVariant.tags.includes(tag)
				if (matchesLabel || matchesTag) {
					variant = nextGenVariant
				}
			}
		}

		// 优先按 label 查找（更具体）
		if (!variant && label) {
			for (const v of this.variants.values()) {
				if (v.id === modelId && v.labels[label] !== undefined) {
					variant = v
					break
				}
			}
		}

		// 其次按 tag 查找
		if (!variant && tag) {
			for (const v of this.variants.values()) {
				if (v.id === modelId && v.tags.includes(tag)) {
					variant = v
					break
				}
			}
		}

		if (!variant) {
			throw new Error(`No prompt variant found for model '${modelId}' with tag '${tag}' or label '${label}'`)
		}

		const builder = new PromptBuilder(variant, context, this.components)
		return await builder.build()
	}

	/**
	 * 注册组件函数
	 *
	 * 组件是可复用的提示词片段生成函数。
	 * 变体配置中引用组件 ID，构建时调用对应函数生成内容。
	 *
	 * @param id - 组件唯一标识符（如 "tool_use", "rules"）
	 * @param componentFn - 组件生成函数，接收上下文返回提示词片段
	 */
	registerComponent(id: string, componentFn: ComponentFunction): void {
		this.components[id] = componentFn
	}

	/**
	 * 获取所有可用的模型 ID 列表
	 *
	 * @returns 所有注册变体的模型 ID 数组（去重）
	 */
	getAvailableModels(): string[] {
		const models = new Set<string>()
		for (const variant of this.variants.values()) {
			models.add(variant.id)
		}
		return Array.from(models)
	}

	/**
	 * 获取变体元数据
	 *
	 * @param modelId - 模型标识符
	 * @returns 变体配置对象，如果不存在则返回 undefined
	 */
	getVariantMetadata(modelId: string): PromptVariant | undefined {
		return this.variants.get(modelId)
	}

	// ========================================================================
	// 私有方法 - 变体加载
	// ========================================================================

	/**
	 * 从 variants 目录加载所有变体配置
	 *
	 * 遍历 loadAllVariantConfigs() 返回的所有配置，
	 * 将它们注册到 variants Map 中。
	 *
	 * 如果加载失败，会创建一个最小的通用后备变体。
	 */
	private loadVariants(): void {
		try {
			this.variants = new Map<string, PromptVariant>()

			// 加载所有变体配置
			for (const [id, config] of Object.entries(loadAllVariantConfigs())) {
				this.variants.set(id, { ...config, id })
			}

			// 确保通用变体始终可用作安全后备
			this.ensureGenericFallback()
		} catch (error) {
			Logger.warn("Warning: Could not load variants:", error)
			// 即使变体加载完全失败，也创建一个最小的通用后备
			this.createMinimalGenericFallback()
		}
	}

	/**
	 * 确保通用变体可用
	 *
	 * 如果通用变体不存在，创建一个最小版本。
	 * 这是防止系统完全无法工作的安全措施。
	 */
	private ensureGenericFallback(): void {
		if (!this.variants.has(ModelFamily.GENERIC)) {
			Logger.warn("Generic variant not found, creating minimal fallback")
			this.createMinimalGenericFallback()
		}
	}

	/**
	 * 创建最小的通用后备变体
	 *
	 * 使用预定义的通用配置创建一个基本可用的变体。
	 * 这是绝对的最后手段，确保系统始终能工作。
	 */
	private createMinimalGenericFallback(): void {
		this.loadVariantFromConfig(ModelFamily.GENERIC, genericConfig)
	}

	/**
	 * 从 TypeScript 配置加载单个变体
	 *
	 * @param variantId - 变体唯一标识符
	 * @param config - 变体配置对象（不包含 id）
	 */
	private loadVariantFromConfig(variantId: string, config: Omit<PromptVariant, "id">): void {
		try {
			const variant: PromptVariant = {
				...config,
				id: variantId,
			}

			this.variants.set(variantId, variant)

			// 如果版本号大于 1，也注册带版本后缀的键
			// 这允许通过 "modelId@version" 格式访问特定版本
			if (variant.version > 1) {
				this.variants.set(`${variantId}@${variant.version}`, variant)
			}
		} catch (error) {
			Logger.warn(`Warning: Could not load variant '${variantId}':`, error)
		}
	}

	// ========================================================================
	// 私有方法 - 组件加载
	// ========================================================================

	/**
	 * 从 components 目录加载所有组件
	 *
	 * 组件是提示词的构建块，每个组件负责生成特定部分的内容。
	 * 例如：tool_use 组件生成工具使用说明，rules 组件生成规则内容。
	 */
	private loadComponents(): void {
		try {
			// 获取所有组件映射
			const componentMappings = getSystemPromptComponents()

			// 注册每个组件函数
			for (const { id, fn } of componentMappings) {
				if (fn) {
					this.components[id] = fn
				}
			}
		} catch (error) {
			Logger.warn("Warning: Could not load some components:", error)
		}
	}

	// ========================================================================
	// 静态方法
	// ========================================================================

	/**
	 * 销毁注册表实例
	 *
	 * 用于测试或需要重置状态的场景。
	 * 调用后下次 getInstance() 会创建新实例。
	 */
	public static dispose(): void {
		PromptRegistry.instance = null as unknown as PromptRegistry
	}
}
