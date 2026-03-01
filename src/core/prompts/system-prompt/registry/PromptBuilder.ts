/**
 * @fileoverview 提示词构建器 - 系统提示词的组装引擎
 *
 * 本文件实现了系统提示词的实际构建逻辑，负责将变体配置、组件和占位符
 * 组装成完整的系统提示词字符串。
 *
 * 构建流程：
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    PromptBuilder.build()                    │
 * └──────────────────────────┬──────────────────────────────────┘
 *                            │
 *          ┌─────────────────┼─────────────────┐
 *          ▼                 ▼                 ▼
 * ┌────────────────┐ ┌────────────────┐ ┌────────────────────┐
 * │ buildComponents │ │preparePlaceholders│ │TemplateEngine    │
 * │ (构建组件内容)  │ │ (准备占位符值)    │ │.resolve()        │
 * └────────┬───────┘ └────────┬───────┘ │ (模板替换)         │
 *          │                  │         └─────────┬──────────┘
 *          └──────────────────┴───────────────────┘
 *                             │
 *                             ▼
 *                   ┌─────────────────┐
 *                   │   postProcess   │
 *                   │ (后处理：清理格式) │
 *                   └─────────────────┘
 *                             │
 *                             ▼
 *                   ┌─────────────────┐
 *                   │ 完整的系统提示词  │
 *                   └─────────────────┘
 *
 * 主要功能：
 * 1. 按顺序执行组件函数，收集各部分内容
 * 2. 准备和合并所有占位符值
 * 3. 使用模板引擎替换占位符
 * 4. 后处理清理多余空行和格式问题
 * 5. 生成工具使用说明的提示词
 */

// ==================== 外部依赖导入 ====================

// 日志服务
import { Logger } from "@/shared/services/Logger"
// 默认工具枚举类型
import type { ClineDefaultTool } from "@/shared/tools"
// Cline 工具集管理
import { ClineToolSet } from "../registry/ClineToolSet"
// 工具规格类型和指令解析函数
import { type ClineToolSpec, resolveInstruction } from "../spec"
// 标准占位符常量
import { STANDARD_PLACEHOLDERS } from "../templates/placeholders"
// 模板引擎
import { TemplateEngine } from "../templates/TemplateEngine"
// 类型定义
import type { ComponentRegistry, PromptVariant, SystemPromptContext } from "../types"

// ==================== 常量定义 ====================

/**
 * 预定义的标准占位符键列表
 *
 * 在模块加载时预先计算，避免每次构建时重复创建对象
 */
const STANDARD_PLACEHOLDER_KEYS = Object.values(STANDARD_PLACEHOLDERS)

/**
 * 提示词构建器类
 *
 * 负责将变体配置、组件和上下文信息组装成完整的系统提示词。
 * 每次构建系统提示词时都会创建一个新的实例。
 *
 * 使用流程：
 * 1. PromptRegistry.get() 创建 PromptBuilder 实例
 * 2. 调用 build() 方法构建完整提示词
 * 3. 返回构建好的字符串
 *
 * @example
 * ```typescript
 * const builder = new PromptBuilder(variant, context, components)
 * const systemPrompt = await builder.build()
 * ```
 */
export class PromptBuilder {
	/** 模板引擎实例，用于占位符替换 */
	private templateEngine: TemplateEngine

	/**
	 * 创建 PromptBuilder 实例
	 *
	 * @param variant - 提示词变体配置，定义了模板、组件顺序等
	 * @param context - 系统提示词上下文，包含运行时信息
	 * @param components - 组件注册表，ID 到组件函数的映射
	 */
	constructor(
		private variant: PromptVariant,
		private context: SystemPromptContext,
		private components: ComponentRegistry,
	) {
		this.templateEngine = new TemplateEngine()
	}

	// ========================================================================
	// 公共方法
	// ========================================================================

	/**
	 * 构建完整的系统提示词
	 *
	 * 这是主要的构建入口，执行以下步骤：
	 * 1. 构建所有组件内容
	 * 2. 准备占位符值
	 * 3. 使用模板引擎替换占位符
	 * 4. 后处理清理格式
	 *
	 * @returns 构建完成的系统提示词字符串
	 */
	async build(): Promise<string> {
		// 步骤 1：构建所有组件，获取各部分内容
		const componentSections = await this.buildComponents()

		// 步骤 2：准备占位符值（变体占位符 + 系统占位符 + 组件内容）
		const placeholderValues = this.preparePlaceholders(componentSections)

		// 步骤 3：使用模板引擎替换基础模板中的占位符
		const prompt = this.templateEngine.resolve(this.variant.baseTemplate, this.context, placeholderValues)

		// 步骤 4：后处理，清理多余空行等格式问题
		return this.postProcess(prompt)
	}

	// ========================================================================
	// 私有方法 - 组件构建
	// ========================================================================

	/**
	 * 构建所有组件内容
	 *
	 * 按照变体配置中定义的 componentOrder 顺序，
	 * 依次调用每个组件函数生成对应的提示词片段。
	 *
	 * 组件示例：
	 * - AGENT_ROLE: "You are Cline, a highly skilled software engineer..."
	 * - TOOL_USE: "# Tool Use\n\nYou have access to the following tools..."
	 * - RULES: "# Rules\n\n- Always read files before editing..."
	 *
	 * @returns 组件 ID 到内容的映射对象
	 */
	private async buildComponents(): Promise<Record<string, string>> {
		const sections: Record<string, string> = {}
		const { componentOrder } = this.variant

		// 按顺序处理组件以保持内容顺序
		for (const componentId of componentOrder) {
			const componentFn = this.components[componentId]
			if (!componentFn) {
				Logger.warn(`Warning: Component '${componentId}' not found`)
				continue
			}

			try {
				// 调用组件函数生成内容
				const result = await componentFn(this.variant, this.context)
				// 只保留非空内容
				if (result?.trim()) {
					sections[componentId] = result
				}
			} catch (error) {
				Logger.warn(`Warning: Failed to build component '${componentId}':`, error)
			}
		}

		return sections
	}

	// ========================================================================
	// 私有方法 - 占位符处理
	// ========================================================================

	/**
	 * 准备所有占位符值
	 *
	 * 合并多个来源的占位符值，优先级从低到高：
	 * 1. 变体定义的占位符（variant.placeholders）
	 * 2. 标准系统占位符（CWD、日期等）
	 * 3. 组件生成的内容
	 * 4. 运行时占位符（最高优先级）
	 *
	 * @param componentSections - 组件生成的内容映射
	 * @returns 完整的占位符值对象
	 */
	private preparePlaceholders(componentSections: Record<string, string>): Record<string, unknown> {
		// 创建占位符对象
		const placeholders: Record<string, unknown> = {}

		// 1. 添加变体定义的占位符（最低优先级）
		Object.assign(placeholders, this.variant.placeholders)

		// 2. 添加标准系统占位符
		placeholders[STANDARD_PLACEHOLDERS.CWD] = this.context.cwd || process.cwd()
		placeholders[STANDARD_PLACEHOLDERS.SUPPORTS_BROWSER] = this.context.supportsBrowserUse || false
		placeholders[STANDARD_PLACEHOLDERS.MODEL_FAMILY] = this.variant.family
		placeholders[STANDARD_PLACEHOLDERS.CURRENT_DATE] = new Date().toISOString().split("T")[0]

		// 3. 添加所有组件内容
		Object.assign(placeholders, componentSections)

		// 将组件内容映射到标准占位符键（单次循环优化性能）
		for (const key of STANDARD_PLACEHOLDER_KEYS) {
			if (!placeholders[key]) {
				placeholders[key] = componentSections[key] || ""
			}
		}

		// 4. 添加运行时占位符（最高优先级，会覆盖之前的值）
		const runtimePlaceholders = (this.context as any).runtimePlaceholders
		if (runtimePlaceholders) {
			Object.assign(placeholders, runtimePlaceholders)
		}
		return placeholders
	}

	// ========================================================================
	// 私有方法 - 后处理
	// ========================================================================

	/**
	 * 后处理提示词字符串
	 *
	 * 清理模板替换后可能出现的格式问题：
	 * - 移除多余的连续空行
	 * - 移除空的章节标题
	 * - 处理分隔符（====）前后的空行
	 * - 保留 diff 格式的特殊分隔符
	 *
	 * @param prompt - 原始提示词字符串
	 * @returns 清理后的提示词字符串
	 */
	private postProcess(prompt: string): string {
		if (!prompt) {
			return ""
		}

		// 组合多个正则操作以提高性能
		return prompt
			// 移除多余的连续空行（3 行及以上空行变为 2 行）
			.replace(/\n\s*\n\s*\n/g, "\n\n")
			// 移除首尾空白
			.trim()
			// 移除末尾的 ==== 分隔符
			.replace(/====+\s*$/, "")
			// 移除分隔符之间的空内容
			.replace(/\n====+\s*\n+\s*====+\n/g, "\n====\n")
			// 移除连续的空章节
			.replace(/====\s*\n\s*====\s*\n/g, "====\n")
			// 移除空的章节标题（独立的 ##）
			.replace(/^##\s*$[\r\n]*/gm, "")
			// 移除文档中间的空章节标题
			.replace(/\n##\s*$[\r\n]*/gm, "")
			// 在 ==== 分隔符后添加额外空行（除非是 diff 格式）
			.replace(/====+\n(?!\n)([^\n])/g, (match, _nextChar, offset, string) => {
				// 检查上下文是否为 diff 格式
				const beforeContext = string.substring(Math.max(0, offset - 50), offset)
				const afterContext = string.substring(offset, Math.min(string.length, offset + 50))
				const isDiffLike = /SEARCH|REPLACE|\+\+\+\+\+\+\+|-------/.test(beforeContext + afterContext)
				return isDiffLike ? match : match.replace(/\n/, "\n\n")
			})
			// 在 ==== 分隔符前添加额外空行（除非是 diff 格式）
			.replace(/([^\n])\n(?!\n)====+/g, (match, prevChar, offset, string) => {
				const beforeContext = string.substring(Math.max(0, offset - 50), offset)
				const afterContext = string.substring(offset, Math.min(string.length, offset + 50))
				const isDiffLike = /SEARCH|REPLACE|\+\+\+\+\+\+\+|-------/.test(beforeContext + afterContext)
				return isDiffLike ? match : prevChar + "\n\n" + match.substring(1).replace(/\n/, "")
			})
			// 再次清理可能产生的多余空行
			.replace(/\n\s*\n\s*\n/g, "\n\n")
			// 最终去除首尾空白
			.trim()
	}

	// ========================================================================
	// 元数据方法
	// ========================================================================

	/**
	 * 获取构建元数据
	 *
	 * 返回本次构建的详细信息，用于调试和日志记录。
	 *
	 * @returns 构建元数据对象
	 */
	getBuildMetadata(): {
		variantId: string
		version: number
		componentsUsed: string[]
		placeholdersResolved: string[]
	} {
		return {
			variantId: this.variant.id,
			version: this.variant.version,
			componentsUsed: [...this.variant.componentOrder],
			placeholdersResolved: this.templateEngine.extractPlaceholders(this.variant.baseTemplate),
		}
	}

	// ========================================================================
	// 静态方法 - 工具提示词生成
	// ========================================================================

	/**
	 * 获取启用的工具列表
	 *
	 * 根据变体配置和上下文，返回当前可用的工具规格列表。
	 *
	 * @param variant - 提示词变体配置
	 * @param context - 系统提示词上下文
	 * @returns 启用的工具规格数组
	 */
	private static getEnabledTools(variant: PromptVariant, context: SystemPromptContext): ClineToolSpec[] {
		return ClineToolSet.getEnabledToolSpecs(variant, context)
	}

	/**
	 * 生成所有工具的提示词
	 *
	 * 遍历所有启用的工具，为每个工具生成使用说明的提示词。
	 *
	 * @param variant - 提示词变体配置
	 * @param context - 系统提示词上下文
	 * @returns 所有工具提示词的数组
	 */
	public static async getToolsPrompts(variant: PromptVariant, context: SystemPromptContext) {
		const enabledTools = PromptBuilder.getEnabledTools(variant, context)

		const ids = enabledTools.map((tool) => tool.id)
		return Promise.all(enabledTools.map((tool) => PromptBuilder.tool(tool, ids, context)))
	}

	/**
	 * 生成单个工具的提示词
	 *
	 * 根据工具规格生成格式化的工具使用说明，包括：
	 * - 工具名称和描述
	 * - 参数列表（必需/可选）
	 * - 使用示例（XML 格式）
	 *
	 * 输出示例：
	 * ```
	 * ## read_file
	 * Description: Read the contents of a file at the specified path.
	 * Parameters:
	 * - path: (required) The path of the file to read
	 * Usage:
	 * <read_file>
	 * <path>File path here</path>
	 * </read_file>
	 * ```
	 *
	 * @param config - 工具规格配置
	 * @param registry - 已注册的工具 ID 列表（用于检查依赖）
	 * @param context - 系统提示词上下文
	 * @returns 工具的提示词字符串
	 */
	public static tool(config: ClineToolSpec, registry: ClineDefaultTool[], context: SystemPromptContext): string {
		// 跳过没有参数和描述的占位符工具
		if (!config.parameters?.length && !config.description?.length) {
			return ""
		}
		const displayName = config.name || config.id
		const title = `## ${displayName}`
		const description = [`Description: ${config.description}`]

		if (!config.parameters?.length) {
			config.parameters = []
		}

		// 克隆参数数组以避免修改原始数据
		const params = [...config.parameters]

		// 根据依赖和上下文要求过滤参数
		const filteredParams = params.filter((p) => {
			// 检查依赖关系（现有行为）
			// 如果参数依赖的工具未在注册表中，则跳过该参数
			if (p.dependencies?.length) {
				if (!p.dependencies.every((d) => registry.includes(d))) {
					return false
				}
			}

			// 检查上下文要求（新行为）
			// 参数可以定义一个函数，根据上下文决定是否显示
			if (p.contextRequirements) {
				return p.contextRequirements(context)
			}

			return true
		})

		// 仅从过滤后的参数中收集附加描述
		const additionalDesc = filteredParams.map((p) => p.description).filter((desc): desc is string => Boolean(desc))
		if (additionalDesc.length) {
			description.push(...additionalDesc)
		}

		// 高效构建提示词各部分
		const sections = [
			title,
			description.join("\n"),
			PromptBuilder.buildParametersSection(filteredParams, context),
			PromptBuilder.buildUsageSection(displayName, filteredParams),
		]

		return sections.filter(Boolean).join("\n")
	}

	/**
	 * 构建参数部分的提示词
	 *
	 * 生成参数列表的格式化文本。
	 *
	 * @param params - 参数配置数组
	 * @param context - 系统提示词上下文
	 * @returns 参数部分的字符串
	 */
	private static buildParametersSection(params: any[], context: SystemPromptContext): string {
		if (!params.length) {
			return "Parameters: None"
		}

		const paramList = params.map((p) => {
			const requiredText = p.required ? "required" : "optional"
			// 解析参数指令（可能包含动态内容）
			const instruction = resolveInstruction(p.instruction, context)
			return `- ${p.name}: (${requiredText}) ${instruction}`
		})

		return ["Parameters:", ...paramList].join("\n")
	}

	/**
	 * 构建使用示例部分的提示词
	 *
	 * 生成 XML 格式的工具调用示例。
	 *
	 * @param toolId - 工具标识符
	 * @param params - 参数配置数组
	 * @returns 使用示例部分的字符串
	 */
	private static buildUsageSection(toolId: string, params: any[]): string {
		const usageSection = ["Usage:"]
		const usageTag = `<${toolId}>`
		const usageEndTag = `</${toolId}>`

		usageSection.push(usageTag)

		// 添加参数使用标签
		for (const param of params) {
			const usage = param.usage || ""
			usageSection.push(`<${param.name}>${usage}</${param.name}>`)
		}

		usageSection.push(usageEndTag)
		return usageSection.join("\n")
	}
}
