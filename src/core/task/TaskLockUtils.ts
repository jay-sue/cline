/**
 * ============================================================================
 * TaskLockUtils 模块 - 任务锁工具
 * ============================================================================
 *
 * 该模块提供任务级别的文件夹锁管理功能，用于防止多个 Cline 实例
 * 同时操作同一个任务，确保任务执行的原子性和数据一致性。
 *
 * 主要功能：
 * - 获取任务锁（带重试机制）
 * - 释放任务锁
 *
 * 使用场景：
 * - 任务初始化时获取锁，防止其他实例同时操作
 * - 任务完成或取消时释放锁
 * - 检测锁冲突，提示用户当前任务被其他实例占用
 *
 * 技术说明：
 * - 基于通用的文件夹锁工具（FolderLockUtils）封装
 * - 使用 SQLite 进行锁状态持久化
 * - 支持跨进程的锁同步
 *
 * ============================================================================
 */

// ============================================================================
// 导入依赖
// ============================================================================

// 通用文件夹锁工具函数
import { releaseFolderLock, tryAcquireFolderLockWithRetry } from "@/core/locks/FolderLockUtils"
// 文件夹锁相关类型定义
import type { FolderLockOptions, FolderLockWithRetryResult } from "@/core/locks/types"

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 任务文件夹的基础路径
 *
 * 所有任务数据都存储在此目录下，每个任务有独立的子目录。
 * 使用 ~ 表示用户主目录，实际路径会在运行时解析。
 *
 * 目录结构示例：
 * ~/.cline/data/tasks/
 *   ├── 1234567890/          # 任务 ID 为时间戳
 *   │   ├── api_conversation_history.json
 *   │   ├── ui_messages.json
 *   │   └── ...
 *   └── 1234567891/
 *       └── ...
 */
const TASKS_BASE_PATH = "~/.cline/data/tasks"

// ============================================================================
// 锁获取函数
// ============================================================================

/**
 * 尝试获取任务文件夹锁（带重试逻辑）
 *
 * 这是通用文件夹锁工具的便捷封装，使用 taskId 作为锁目标。
 * 当多个 Cline 实例尝试操作同一任务时，只有第一个能成功获取锁。
 *
 * 工作流程：
 * 1. 构建锁选项（目标路径和持有者标识）
 * 2. 调用通用锁工具尝试获取锁
 * 3. 如果获取失败，会自动重试
 * 4. 返回获取结果，包含冲突锁信息
 *
 * @param taskId - 任务的唯一标识符（通常是时间戳）
 * @returns Promise<FolderLockWithRetryResult> 包含以下字段：
 *   - acquired: 是否成功获取锁
 *   - skipped: 是否跳过锁获取（如在 VS Code 环境中）
 *   - conflictingLock: 冲突锁的信息（如果获取失败）
 *
 * @example
 * ```typescript
 * const result = await tryAcquireTaskLockWithRetry("1234567890")
 * if (result.acquired) {
 *   // 成功获取锁，可以安全操作任务
 * } else if (result.conflictingLock) {
 *   // 锁被其他实例持有
 *   console.log(`任务被实例 ${result.conflictingLock.held_by} 占用`)
 * }
 * ```
 */
export async function tryAcquireTaskLockWithRetry(taskId: string): Promise<FolderLockWithRetryResult> {
	// 构建锁选项
	const options: FolderLockOptions = {
		// 锁目标路径：任务基础路径 + 任务 ID
		lockTarget: `${TASKS_BASE_PATH}/${taskId}`,
		// 锁持有者标识：在 SqliteLockManager 中会自动替换为实例地址
		heldBy: taskId,
	}

	// 调用通用锁工具并返回结果
	const result = await tryAcquireFolderLockWithRetry(options)
	return {
		acquired: result.acquired,
		skipped: result.skipped,
		conflictingLock: result.conflictingLock,
	}
}

// ============================================================================
// 锁释放函数
// ============================================================================

/**
 * 安全释放任务文件夹锁
 *
 * 这是通用文件夹锁工具的便捷封装，使用 taskId 作为锁目标。
 * 应在任务完成、取消或发生错误时调用，确保锁被正确释放。
 *
 * 注意事项：
 * - 即使任务异常终止，也应确保调用此函数
 * - 如果锁不存在或已被释放，此函数不会抛出错误
 * - 只有锁的持有者才能释放锁
 *
 * @param taskId - 任务的唯一标识符
 *
 * @example
 * ```typescript
 * try {
 *   // 执行任务操作...
 * } finally {
 *   await releaseTaskLock("1234567890")
 * }
 * ```
 */
export async function releaseTaskLock(taskId: string): Promise<void> {
	await releaseFolderLock(taskId, `${TASKS_BASE_PATH}/${taskId}`)
}
