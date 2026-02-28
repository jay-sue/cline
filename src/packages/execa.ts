/**
 * @fileoverview Execa 模块重导出
 *
 * 本文件是 execa 库的统一导出入口。Execa 是一个更好的 child_process 替代品，
 * 用于在 Node.js 中执行外部命令。
 *
 * 主要特性：
 * - Promise 风格的 API
 * - 跨平台命令执行
 * - 更好的错误处理
 * - 流式输出支持
 * - 信号处理和进程管理
 *
 * 使用场景：
 * - 执行 shell 命令
 * - 运行外部程序（如 git、npm 等）
 * - 管理子进程生命周期
 *
 * @see https://github.com/sindresorhus/execa
 *
 * @example
 * ```typescript
 * import { execa } from "@/packages/execa"
 *
 * // 执行命令并等待结果
 * const { stdout } = await execa("git", ["status"])
 * console.log(stdout)
 *
 * // 流式处理输出
 * const subprocess = execa("npm", ["install"])
 * subprocess.stdout?.pipe(process.stdout)
 * await subprocess
 * ```
 */
export { execa } from "execa"
