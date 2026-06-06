@echo off
chcp 65001 >nul 2>&1

REM 检查 Ollama 是否已安装
where ollama >nul 2>&1
if errorlevel 1 (
    echo [run.bat] 错误：未检测到 Ollama，请先安装 Ollama。
    echo [run.bat] 下载地址：https://ollama.com/download
    pause
    exit /b 1
)

REM 检查 Ollama 服务是否已启动
curl -s http://localhost:11434 >nul 2>&1
if errorlevel 1 (
    echo [run.bat] Ollama 服务未运行，正在启动...
    start "" ollama serve
    :wait_ollama
    timeout /t 2 /nobreak >nul
    curl -s http://localhost:11434 >nul 2>&1
    if errorlevel 1 (
        echo [run.bat] 等待 Ollama 启动...
        goto wait_ollama
    )
    echo [run.bat] Ollama 服务已就绪
) else (
    echo [run.bat] Ollama 服务已运行
)

pnpm dev:all
pause
