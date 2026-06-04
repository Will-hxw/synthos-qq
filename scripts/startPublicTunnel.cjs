#!/usr/bin/env node

const { spawn } = require("child_process");
const { writeFileSync } = require("fs");

const TARGET_PORT = Number(process.env.SYNTHOS_PUBLIC_TUNNEL_TARGET_PORT || "3011");
const READY_FILE = process.env.SYNTHOS_PUBLIC_TUNNEL_READY_FILE || "";
const START_TIMEOUT_MS = 60 * 1000;
const PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy"
];

function log(message) {
    console.log(`[public-tunnel] ${message}`);
}

function createNgrokEnv() {
    const env = { ...process.env };

    for (const key of PROXY_ENV_KEYS) {
        delete env[key];
    }

    return env;
}

function writeReadyFile(publicUrl) {
    if (!READY_FILE) {
        return;
    }

    writeFileSync(READY_FILE, `${publicUrl}\n`, "utf8");
}

function parseNgrokLogLine(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function startNgrok() {
    const args = [
        "http",
        String(TARGET_PORT),
        "--log=stdout",
        "--log-format=json",
        "--log-level=info"
    ];

    return spawn("ngrok", args, {
        env: createNgrokEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });
}

let isReady = false;
let stdoutBuffer = "";
const ngrokProcess = startNgrok();

const startupTimer = setTimeout(() => {
    if (isReady) {
        return;
    }

    log("ngrok 启动超时，未拿到公网 URL。");
    ngrokProcess.kill();
    process.exit(1);
}, START_TIMEOUT_MS);

ngrokProcess.stdout.on("data", chunk => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");

    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        const parsed = parseNgrokLogLine(trimmed);

        if (!parsed) {
            log(trimmed);
            continue;
        }

        if (parsed.msg === "started tunnel" && parsed.url) {
            isReady = true;
            clearTimeout(startupTimer);
            writeReadyFile(parsed.url);
            log(`公网地址: ${parsed.url}`);
            continue;
        }

        const message = String(parsed.msg || "");
        const isFailureLog = parsed.lvl === "crit" || message.includes("failed") || message.includes("terminating");

        if (isFailureLog && parsed.err) {
            log(`ngrok 错误: ${parsed.err}`);
        }
    }
});

ngrokProcess.stderr.on("data", chunk => {
    process.stderr.write(chunk);
});

ngrokProcess.on("error", error => {
    clearTimeout(startupTimer);
    log(`无法启动 ngrok: ${error.message}`);
    process.exit(1);
});

ngrokProcess.on("exit", code => {
    clearTimeout(startupTimer);

    if (!isReady) {
        process.exit(code ?? 1);
        return;
    }

    log("ngrok 已退出。");
    process.exit(code ?? 0);
});

function stopNgrok() {
    if (ngrokProcess.exitCode !== null) {
        return;
    }

    ngrokProcess.kill();
}

process.on("SIGINT", () => {
    stopNgrok();
});

process.on("SIGTERM", () => {
    stopNgrok();
});
