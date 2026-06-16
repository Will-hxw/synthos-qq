#!/usr/bin/env node

/**
 * 构建前端 + 启动预览服务器（Windows 兼容包装）。
 *
 * 替代 shell 中的 `pnpm build && node startPublicPreviewServer.cjs`，
 * 避免 cmd.exe / PowerShell 环境下 && 链式操作符行为不一致导致
 * 预览服务器未被启动的问题。
 */

const { execSync, spawn } = require("child_process");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");

function log(message) {
    console.log(`[build-and-preview] ${message}`);
}

function main() {
    // Step 1: 构建前端
    log("开始构建前端 (vite-template)...");
    execSync("pnpm --filter vite-template build", {
        cwd: ROOT_DIR,
        stdio: "inherit"
    });
    log("前端构建完成");

    // Step 2: 启动静态预览服务器（该进程会持续运行，接管 stdio）
    log("启动静态预览服务器...");
    const child = spawn("node", ["scripts/startPublicPreviewServer.cjs"], {
        cwd: ROOT_DIR,
        stdio: "inherit",
        env: process.env
    });

    child.on("exit", code => {
        log(`预览服务器退出，code=${code}`);
        process.exit(code ?? 0);
    });

    child.on("error", err => {
        log(`无法启动预览服务器: ${err.message}`);
        process.exit(1);
    });
}

main();
