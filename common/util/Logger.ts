// logger.ts
import "reflect-metadata";
import { appendFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { nextTick } from "process";

import { rainbow, pastel, atlas } from "gradient-string";

import ConfigManagerService from "../services/config/ConfigManagerService";

import { getCurrentFunctionName } from "./core/getCurrentFunctionName";

class Logger {
    private tag: string | null = null;
    private logLevel: "debug" | "info" | "success" | "warning" | "error" = "info";
    private logDirectory: string = ""; // 日志目录
    private logBuffer: string[] = []; // 日志缓冲区
    private isTestEnv: boolean = false; // 是否为测试环境

    constructor(tag: string | null = null) {
        this.tag = tag;
        // 检测是否在 vitest 测试环境中运行
        this.isTestEnv = process.env.VITEST === "true";
        if (this.isTestEnv) {
            return;
        }

        // 由于ConfigManagerService间接引用了Logger，为避免循环引用带来的Temporal Dead Zone问题，使用nextTick延迟初始化
        nextTick(() => {
            ConfigManagerService.getCurrentConfig().then(config => {
                this.logLevel = config.logger.logLevel;
                this.logDirectory = config.logger.logDirectory;
                // 启动定时器，每1秒将缓冲区中的日志写入文件
                setInterval(() => this._flushLogBuffer(), 1000);
            });
        });
    }

    // 工厂方法：创建带 tag 的新 logger
    public withTag(tag: string): Logger {
        return new Logger(`[${tag}]`);
    }

    private _getPrefix(level: string): string {
        const time = this._getTimeString();
        const emojiMap: Record<string, string> = {
            debug: "🐞",
            info: "ℹ️",
            success: "✅",
            warning: "⚠️",
            error: "❌"
        };

        return `${emojiMap[level]} ${time}${("[" + level.toUpperCase() + "]").padEnd(9, " ")}${this.tag ? `${this.tag} ` : ""}[${getCurrentFunctionName()}] `;
    }

    private _getTimeString(): string {
        const now = new Date();
        // 生成yyyy-MM-dd HH:mm:ss.SSS格式的时间字符串
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0"); // 月份从0开始，所以要加1
        const day = String(now.getDate()).padStart(2, "0");
        const hours = String(now.getHours()).padStart(2, "0");
        const minutes = String(now.getMinutes()).padStart(2, "0");
        const seconds = String(now.getSeconds()).padStart(2, "0");
        const milliseconds = String(now.getMilliseconds()).padStart(3, "0");

        return `[${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}]`;
    }

    private async _addLineToLogBuffer(line: string) {
        // 测试环境下不写入缓冲区，日志不落盘
        if (this.isTestEnv) return;
        this.logBuffer.push(line);
    }

    private async _flushLogBuffer() {
        if (this.logBuffer.length === 0) return;
        // 使用交换缓冲区策略避免极端并发下日志丢失问题
        const bufferToFlush = [...this.logBuffer]; // 复制当前内容

        this.logBuffer = []; // 立即清空，新日志进新数组
        for (const line of bufferToFlush) {
            const date = new Date();
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0"); // 月份从0开始，所以要加1
            const day = String(date.getDate()).padStart(2, "0");
            const fileName = `${year}-${month}-${day}.log`;
            const filePath = join(this.logDirectory, fileName);

            // 确保目录存在
            try {
                await access(this.logDirectory);
            } catch {
                await mkdir(this.logDirectory, { recursive: true }); // 创建目录（如果不存在）
            }
            // 追加日志到文件
            await appendFile(filePath, line + "\n", "utf8");
        }
        // 清空缓冲区
        this.logBuffer = [];
    }

    // ANSI color log helper
    private _logWithColor(colorCode: string, message: string, level: string): void {
        // 输出到控制台
        console.log(`${colorCode}${this._getPrefix(level)}${message}\x1b[0m`);
        // 输出到文件
        this._addLineToLogBuffer(`${this._getPrefix(level)}${message}`);
    }

    // Gradient log helper
    private _logWithGradient(fn: (msg: string) => string, message: string, level: string): void {
        // 输出到控制台
        console.log(fn(`${this._getPrefix(level)}${message}`));
        // 输出到文件
        this._addLineToLogBuffer(`${this._getPrefix(level)}${message}`);
    }

    // --- 颜色方法 ---
    public blue(message: string, level: string = "info") {
        this._logWithColor("\x1b[34m", message, level);
    }
    public brightCyan(message: string, level: string = "info") {
        this._logWithColor("\x1b[96m", message, level);
    }
    public green(message: string, level: string = "success") {
        this._logWithColor("\x1b[32m", message, level);
    }
    public yellow(message: string, level: string = "warning") {
        this._logWithColor("\x1b[33m", message, level);
    }
    public red(message: string, level: string = "error") {
        this._logWithColor("\x1b[31m", message, level);
    }
    public gray(message: string, level: string = "debug") {
        this._logWithColor("\x1b[30m", message, level);
    }

    public bgRed(message: string, level: string = "error") {
        this._logWithColor("\x1b[41m", message, level);
    }
    public bgGreen(message: string, level: string = "success") {
        this._logWithColor("\x1b[42m", message, level);
    }
    public bgYellow(message: string, level: string = "warning") {
        this._logWithColor("\x1b[43m", message, level);
    }
    public bgBlue(message: string, level: string = "info") {
        this._logWithColor("\x1b[44m", message, level);
    }

    // --- 语义化方法 ---
    public debug(message: string) {
        if (["debug"].includes(this.logLevel)) {
            this.gray(message);
        }
    }
    public info(message: string) {
        if (["debug", "info"].includes(this.logLevel)) {
            this.brightCyan(message);
        }
    }
    public success(message: string) {
        if (["debug", "info", "success"].includes(this.logLevel)) {
            this.green(message);
        }
    }
    public warning(message: string) {
        if (["debug", "info", "success", "warning"].includes(this.logLevel)) {
            this.yellow(message);
        }
    }
    public warn(message: string) {
        this.warning(message);
    }
    public error(message: string) {
        if (["debug", "info", "success", "warning", "error"].includes(this.logLevel)) {
            this.red(message);
        }
    }

    // --- 渐变方法 ---
    public gradientWithPastel(message: string, level: string = "info") {
        this._logWithGradient(pastel, message, level);
    }
    public gradientWithAtlas(message: string, level: string = "info") {
        this._logWithGradient(atlas, message, level);
    }
    public gradientWithRainbow(message: string, level: string = "info") {
        this._logWithGradient(rainbow, message, level);
    }
}

// 默认导出一个无 tag 的全局 logger（可用于临时日志）
export default new Logger();
