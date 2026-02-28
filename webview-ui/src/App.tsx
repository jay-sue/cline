/**
 * @fileoverview Cline WebView 应用入口 - React 应用根组件
 *
 * 本文件是 Cline WebView 的根组件，负责：
 * 1. 提供全局状态上下文（通过 Providers）
 * 2. 管理不同视图之间的切换
 * 3. 处理公告显示逻辑
 *
 * 视图层次结构：
 * ┌─────────────────────────────────────────────────────────┐
 * │  App (根组件)                                           │
 * │  └── Providers (上下文提供者)                            │
 * │      └── AppContent (应用内容)                          │
 * │          ├── WelcomeView (欢迎/首次设置)                 │
 * │          ├── OnboardingView (新手引导)                   │
 * │          ├── SettingsView (设置)                        │
 * │          ├── HistoryView (历史记录)                      │
 * │          ├── McpView (MCP 服务器配置)                    │
 * │          ├── AccountView (账户管理)                      │
 * │          ├── WorktreesView (工作树管理)                  │
 * │          └── ChatView (聊天视图 - 主视图)                │
 * └─────────────────────────────────────────────────────────┘
 */

// ==================== 外部依赖导入 ====================

// Protocol Buffers 消息类型
import type { Boolean, EmptyRequest } from "@shared/proto/cline/common"
// React 核心
import { useEffect } from "react"

// ==================== 视图组件导入 ====================

import AccountView from "./components/account/AccountView" // 账户视图
import ChatView from "./components/chat/ChatView" // 聊天视图（主视图）
import HistoryView from "./components/history/HistoryView" // 历史记录视图
import McpView from "./components/mcp/configuration/McpConfigurationView" // MCP 配置视图
import OnboardingView from "./components/onboarding/OnboardingView" // 新手引导视图
import SettingsView from "./components/settings/SettingsView" // 设置视图
import WelcomeView from "./components/welcome/WelcomeView" // 欢迎视图
import WorktreesView from "./components/worktrees/WorktreesView" // 工作树视图

// ==================== 上下文和服务导入 ====================

import { useClineAuth } from "./context/ClineAuthContext" // Cline 认证上下文
import { useExtensionState } from "./context/ExtensionStateContext" // 扩展状态上下文
import { Providers } from "./Providers" // 全局上下文提供者
import { UiServiceClient } from "./services/grpc-client" // UI 服务 gRPC 客户端

// ==================== 组件定义 ====================

/**
 * AppContent 应用内容组件
 *
 * 管理应用的主要内容和视图切换逻辑。
 * 根据扩展状态决定显示哪个视图。
 *
 * 视图优先级：
 * 1. 欢迎视图（首次使用或未配置时）
 * 2. 新手引导视图（有可选模型时）
 * 3. 设置/历史/MCP/账户/工作树视图（覆盖层）
 * 4. 聊天视图（主视图，始终渲染但可能隐藏）
 */
const AppContent = () => {
	// ==================== 从上下文获取状态 ====================
	const {
		didHydrateState, // 状态是否已从扩展加载完成
		showWelcome, // 是否显示欢迎视图
		shouldShowAnnouncement, // 是否应该显示公告
		showMcp, // 是否显示 MCP 配置视图
		mcpTab, // MCP 视图的初始标签页
		showSettings, // 是否显示设置视图
		settingsTargetSection, // 设置视图的目标区域
		showHistory, // 是否显示历史视图
		showAccount, // 是否显示账户视图
		showWorktrees, // 是否显示工作树视图
		showAnnouncement, // 是否显示公告
		onboardingModels, // 新手引导可用的模型列表
		setShowAnnouncement, // 设置公告显示状态
		setShouldShowAnnouncement, // 设置是否应该显示公告
		closeMcpView, // 关闭 MCP 视图
		navigateToHistory, // 导航到历史视图
		hideSettings, // 隐藏设置视图
		hideHistory, // 隐藏历史视图
		hideAccount, // 隐藏账户视图
		hideWorktrees, // 隐藏工作树视图
		hideAnnouncement, // 隐藏公告
	} = useExtensionState()

	// 获取 Cline 认证信息
	const { clineUser, organizations, activeOrganization } = useClineAuth()

	// ==================== 副作用 ====================

	/**
	 * 处理公告显示逻辑
	 *
	 * 当需要显示公告时：
	 * 1. 设置公告显示状态
	 * 2. 通知扩展公告已显示
	 * 3. 根据响应更新是否继续显示
	 */
	useEffect(() => {
		if (shouldShowAnnouncement) {
			setShowAnnouncement(true)

			// 使用 gRPC 客户端通知扩展（而非直接 WebviewMessage）
			UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
				.then((response: Boolean) => {
					setShouldShowAnnouncement(response.value)
				})
				.catch((error) => {
					console.error("Failed to acknowledge announcement:", error)
				})
		}
	}, [shouldShowAnnouncement, setShouldShowAnnouncement, setShowAnnouncement])

	// ==================== 条件渲染 ====================

	// 状态未加载完成时不渲染任何内容
	if (!didHydrateState) {
		return null
	}

	// 显示欢迎视图或新手引导视图
	if (showWelcome) {
		return onboardingModels ? <OnboardingView onboardingModels={onboardingModels} /> : <WelcomeView />
	}

	// ==================== 主渲染 ====================

	return (
		<div className="flex h-screen w-full flex-col">
			{/* 覆盖层视图 - 根据状态条件渲染 */}
			{showSettings && <SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />}
			{showHistory && <HistoryView onDone={hideHistory} />}
			{showMcp && <McpView initialTab={mcpTab} onDone={closeMcpView} />}
			{showAccount && (
				<AccountView
					activeOrganization={activeOrganization}
					clineUser={clineUser}
					onDone={hideAccount}
					organizations={organizations}
				/>
			)}
			{showWorktrees && <WorktreesView onDone={hideWorktrees} />}

			{/*
			 * 聊天视图 - 始终渲染，通过 isHidden 控制可见性
			 * 原因：ChatView 初始化成本高，且有不能丢失的状态
			 * （用户输入、disableInput、askResponse promise 等）
			 */}
			<ChatView
				hideAnnouncement={hideAnnouncement}
				isHidden={showSettings || showHistory || showMcp || showAccount || showWorktrees}
				showAnnouncement={showAnnouncement}
				showHistoryView={navigateToHistory}
			/>
		</div>
	)
}

/**
 * App 根组件
 *
 * 应用的最顶层组件，负责：
 * 1. 包装 Providers 提供全局上下文
 * 2. 渲染 AppContent
 *
 * Providers 包含：
 * - ExtensionStateProvider：扩展状态管理
 * - ClineAuthProvider：Cline 认证状态
 * - PlatformProvider：平台相关配置
 * - ThemeProvider：主题管理
 * - TooltipProvider：工具提示管理
 */
const App = () => {
	return (
		<Providers>
			<AppContent />
		</Providers>
	)
}

export default App
