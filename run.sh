#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PUBLIC_TUNNEL_PID=""
PUBLIC_TUNNEL_READY_FILE=""

cleanup() {
    local exit_code=$?

    trap - EXIT INT TERM

    if [ -n "$PUBLIC_TUNNEL_PID" ] && kill -0 "$PUBLIC_TUNNEL_PID" 2>/dev/null; then
        echo "[run.sh] 正在关闭公网转发..."
        kill "$PUBLIC_TUNNEL_PID" 2>/dev/null || true
        wait "$PUBLIC_TUNNEL_PID" 2>/dev/null || true
    fi

    if [ -n "$PUBLIC_TUNNEL_READY_FILE" ]; then
        rm -f "$PUBLIC_TUNNEL_READY_FILE"
    fi

    exit "$exit_code"
}

trap cleanup EXIT
trap "exit 130" INT
trap "exit 143" TERM

if ! command -v ollama &>/dev/null; then
    echo "[run.sh] 错误：未检测到 Ollama，请先安装 Ollama。"
    echo "[run.sh] 下载地址：https://ollama.com/download"
    exit 1
fi

if ! command -v ngrok &>/dev/null; then
    echo "[run.sh] 错误：未检测到 ngrok，请先安装并配置 ngrok。"
    exit 1
fi

if ! curl -s http://localhost:11434 &>/dev/null; then
    echo "[run.sh] Ollama 服务未运行，正在启动..."
    ollama serve &

    while ! curl -s http://localhost:11434 &>/dev/null; do
        echo "[run.sh] 等待 Ollama 启动..."
        sleep 2
    done

    echo "[run.sh] Ollama 服务已就绪"
else
    echo "[run.sh] Ollama 服务已运行"
fi

if command -v mktemp &>/dev/null; then
    PUBLIC_TUNNEL_READY_FILE="$(mktemp -t synthos-public-tunnel.XXXXXX)"
else
    PUBLIC_TUNNEL_READY_FILE="${TMPDIR:-/tmp}/synthos-public-tunnel-$$.txt"
fi
rm -f "$PUBLIC_TUNNEL_READY_FILE"

echo "[run.sh] 正在启动公网转发..."
SYNTHOS_PUBLIC_TUNNEL_READY_FILE="$PUBLIC_TUNNEL_READY_FILE" node scripts/startPublicTunnel.cjs &
PUBLIC_TUNNEL_PID=$!

for ((i = 0; i < 60; i += 1)); do
    if [ -s "$PUBLIC_TUNNEL_READY_FILE" ]; then
        PUBLIC_URL="$(cat "$PUBLIC_TUNNEL_READY_FILE")"
        echo "[run.sh] 公网访问地址：$PUBLIC_URL"
        break
    fi

    if ! kill -0 "$PUBLIC_TUNNEL_PID" 2>/dev/null; then
        wait "$PUBLIC_TUNNEL_PID"
        exit 1
    fi

    sleep 1
done

if [ ! -s "$PUBLIC_TUNNEL_READY_FILE" ]; then
    echo "[run.sh] 错误：公网转发启动超时。"
    kill "$PUBLIC_TUNNEL_PID" 2>/dev/null || true
    exit 1
fi

pnpm dev:all
