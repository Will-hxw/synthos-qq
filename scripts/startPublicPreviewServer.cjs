#!/usr/bin/env node

const fs = require("fs");
const { execFileSync } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const zlib = require("zlib");

const ROOT_DIR = path.resolve(__dirname, "..");
const HOST = process.env.SYNTHOS_PUBLIC_PREVIEW_HOST || "127.0.0.1";
const PORT = Number(process.env.SYNTHOS_PUBLIC_PREVIEW_PORT || "3012");
const DIST_DIR = path.resolve(
    ROOT_DIR,
    process.env.SYNTHOS_PUBLIC_PREVIEW_DIST_DIR || "applications/webui-frontend/dist"
);
const BACKEND_HOST = process.env.SYNTHOS_WEBUI_BACKEND_HOST || "127.0.0.1";
const BACKEND_PORT = Number(process.env.SYNTHOS_WEBUI_BACKEND_PORT || "3002");
const CURRENT_PID = process.pid;
const PREVIEW_SCRIPT_NAME = "startPublicPreviewServer.cjs";
const PORT_CLEANUP_TIMEOUT_MS = 8000;

const LONG_CACHE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";
const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
]);

const MIME_TYPES = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".ico", "image/x-icon"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
    [".map", "application/json; charset=utf-8"],
    [".txt", "text/plain; charset=utf-8"]
]);

const COMPRESSIBLE_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".svg", ".txt", ".map"]);

function log(message) {
    console.log(`[public-preview] ${message}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeProcessList(raw) {
    if (!raw) {
        return [];
    }

    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const dedupedByPid = new Map();

    for (const item of list) {
        const pid = Number(item.pid);

        if (!Number.isFinite(pid) || pid <= 0) {
            continue;
        }

        if (!dedupedByPid.has(pid)) {
            dedupedByPid.set(pid, {
                pid,
                commandLine: String(item.commandLine || ""),
                executablePath: String(item.executablePath || "")
            });
        }
    }

    return [...dedupedByPid.values()];
}

function getListeningProcessesOnWindows(port) {
    const command = `
$ErrorActionPreference = 'SilentlyContinue'
$connections = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue
$connections | ForEach-Object {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        pid = $_.OwningProcess
        commandLine = $process.CommandLine
        executablePath = $process.ExecutablePath
    }
} | ConvertTo-Json -Compress
`;

    try {
        const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();

        return normalizeProcessList(raw);
    } catch {
        return [];
    }
}

function getCommandLineOnUnix(pid) {
    try {
        return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();
    } catch {
        return "";
    }
}

function getListeningProcessesOnUnix(port) {
    try {
        const raw = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();

        return raw
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.startsWith("p"))
            .map(line => Number(line.slice(1)))
            .filter(pid => Number.isFinite(pid) && pid > 0)
            .filter((pid, index, pids) => pids.indexOf(pid) === index)
            .map(pid => ({
                pid,
                commandLine: getCommandLineOnUnix(pid),
                executablePath: ""
            }));
    } catch {
        return [];
    }
}

function getListeningProcesses(port) {
    if (process.platform === "win32") {
        return getListeningProcessesOnWindows(port);
    }

    return getListeningProcessesOnUnix(port);
}

function isPreviewServerProcess(processInfo) {
    return processInfo.commandLine.includes(PREVIEW_SCRIPT_NAME);
}

function stopProcess(pid) {
    if (pid === CURRENT_PID) {
        return;
    }

    try {
        process.kill(pid);
    } catch (error) {
        if (error?.code !== "ESRCH") {
            throw error;
        }
    }
}

async function waitForPortFree(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const listeners = getListeningProcesses(port).filter(item => item.pid !== CURRENT_PID);

        if (listeners.length === 0) {
            return true;
        }

        await sleep(200);
    }

    return getListeningProcesses(port).filter(item => item.pid !== CURRENT_PID).length === 0;
}

async function cleanupExistingPreviewServer() {
    const listeners = getListeningProcesses(PORT).filter(item => item.pid !== CURRENT_PID);

    if (listeners.length === 0) {
        return true;
    }

    const previewProcesses = listeners.filter(isPreviewServerProcess);
    const otherProcesses = listeners.filter(item => !isPreviewServerProcess(item));

    if (otherProcesses.length > 0) {
        for (const processInfo of otherProcesses) {
            log(`端口 ${PORT} 已被其他进程占用，pid=${processInfo.pid}，命令=${processInfo.commandLine || "未知"}`);
        }

        return false;
    }

    for (const processInfo of previewProcesses) {
        log(`发现旧的静态预览服务，准备清理 pid=${processInfo.pid}`);
        stopProcess(processInfo.pid);
    }

    const portFree = await waitForPortFree(PORT, PORT_CLEANUP_TIMEOUT_MS);

    if (!portFree) {
        log(`旧的静态预览服务清理后端口 ${PORT} 仍被占用`);
    }

    return portFree;
}

function isProxyPath(pathname) {
    return pathname === "/health" || pathname === "/trpc" || pathname.startsWith("/api/");
}

function cleanHeaders(headers) {
    const result = {};

    for (const [key, value] of Object.entries(headers)) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || value === undefined) {
            continue;
        }

        result[key] = value;
    }

    return result;
}

function getContentType(filePath) {
    return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function acceptsGzip(req) {
    return String(req.headers["accept-encoding"] || "")
        .split(",")
        .map(item => item.trim().toLowerCase())
        .some(item => item === "gzip" || item.startsWith("gzip;"));
}

function resolveStaticPath(pathname) {
    let decodedPathname;

    try {
        decodedPathname = decodeURIComponent(pathname);
    } catch {
        return null;
    }

    const relativePath = decodedPathname === "/" ? "index.html" : decodedPathname.replace(/^\/+/, "");
    const resolved = path.resolve(DIST_DIR, relativePath);
    const distPrefix = `${DIST_DIR}${path.sep}`.toLowerCase();
    const normalizedResolved = resolved.toLowerCase();

    if (normalizedResolved !== DIST_DIR.toLowerCase() && !normalizedResolved.startsWith(distPrefix)) {
        return null;
    }

    return resolved;
}

async function fileExists(filePath) {
    try {
        const stat = await fs.promises.stat(filePath);

        return stat.isFile();
    } catch {
        return false;
    }
}

async function sendStatic(req, res, filePath, cacheControl) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = getContentType(filePath);
    const headers = {
        "Cache-Control": cacheControl,
        "Content-Type": contentType
    };

    if (req.method === "HEAD") {
        const stat = await fs.promises.stat(filePath);

        res.writeHead(200, {
            ...headers,
            "Content-Length": stat.size
        });
        res.end();
        return;
    }

    const body = await fs.promises.readFile(filePath);

    if (COMPRESSIBLE_EXTENSIONS.has(ext) && acceptsGzip(req)) {
        const gzipped = zlib.gzipSync(body);

        res.writeHead(200, {
            ...headers,
            "Content-Encoding": "gzip",
            "Content-Length": gzipped.length,
            Vary: "Accept-Encoding"
        });
        res.end(gzipped);
        return;
    }

    res.writeHead(200, {
        ...headers,
        "Content-Length": body.length
    });
    res.end(body);
}

function proxyHttp(req, res) {
    const headers = cleanHeaders(req.headers);

    headers.host = `${BACKEND_HOST}:${BACKEND_PORT}`;

    const proxyReq = http.request(
        {
            host: BACKEND_HOST,
            port: BACKEND_PORT,
            method: req.method,
            path: req.url,
            headers,
            timeout: 0
        },
        proxyRes => {
            res.writeHead(proxyRes.statusCode || 502, cleanHeaders(proxyRes.headers));
            proxyRes.pipe(res);
        }
    );

    proxyReq.on("error", error => {
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        }

        res.end(JSON.stringify({ success: false, message: `后端代理失败: ${error.message}` }));
    });

    req.pipe(proxyReq);
}

async function handleRequest(req, res) {
    const requestUrl = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (isProxyPath(requestUrl.pathname)) {
        proxyHttp(req, res);
        return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method Not Allowed");
        return;
    }

    const requestedPath = resolveStaticPath(requestUrl.pathname);

    if (!requestedPath) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad Request");
        return;
    }

    const isAssetPath = requestUrl.pathname.startsWith("/assets/");

    if (await fileExists(requestedPath)) {
        await sendStatic(req, res, requestedPath, isAssetPath ? LONG_CACHE : NO_CACHE);
        return;
    }

    if (isAssetPath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_CACHE });
        res.end("Not Found");
        return;
    }

    await sendStatic(req, res, path.join(DIST_DIR, "index.html"), NO_CACHE);
}

function proxyUpgrade(req, clientSocket, head) {
    const requestUrl = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (requestUrl.pathname !== "/trpc") {
        clientSocket.destroy();
        return;
    }

    const backendSocket = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
        const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
        const headerLines = [requestLine, `Host: ${BACKEND_HOST}:${BACKEND_PORT}`];

        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const name = req.rawHeaders[i];
            const value = req.rawHeaders[i + 1];

            if (name.toLowerCase() === "host") {
                continue;
            }

            headerLines.push(`${name}: ${value}`);
        }

        backendSocket.write(`${headerLines.join("\r\n")}\r\n\r\n`);

        if (head.length > 0) {
            backendSocket.write(head);
        }

        clientSocket.pipe(backendSocket);
        backendSocket.pipe(clientSocket);
    });

    const closeBoth = () => {
        clientSocket.destroy();
        backendSocket.destroy();
    };

    backendSocket.on("error", closeBoth);
    clientSocket.on("error", closeBoth);
}

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
        if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }

        res.end(`Internal Server Error: ${error.message}`);
    });
});

server.timeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;
server.on("upgrade", proxyUpgrade);

server.on("error", error => {
    if (error?.code === "EADDRINUSE") {
        log(`端口 ${PORT} 已被占用，静态预览服务无法启动。请释放该端口，或设置 SYNTHOS_PUBLIC_PREVIEW_PORT 使用其他端口。`);
        process.exit(1);
    }

    log(`静态预览服务启动失败: ${error?.message || String(error)}`);
    process.exit(1);
});

async function main() {
    const canStart = await cleanupExistingPreviewServer();

    if (!canStart) {
        log(`静态预览服务未启动: ${HOST}:${PORT} 不可用`);
        process.exit(1);
    }

    server.listen(PORT, HOST, () => {
        log(`静态预览服务已启动: http://${HOST}:${PORT}`);
        log(`静态目录: ${DIST_DIR}`);
        log(`后端代理: http://${BACKEND_HOST}:${BACKEND_PORT}`);
    });
}

main().catch(error => {
    log(`静态预览服务启动失败: ${error?.message || String(error)}`);
    process.exit(1);
});
