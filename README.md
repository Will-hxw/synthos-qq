<p align="center">
  <h1 align="center">🔬 Synthos-QQ</h1>
  <p align="center"><strong>智能聊天记录全链路分析系统</strong></p>
  <p align="center">从原始 QQ 聊天记录导入 → 上下文理解 → AI 摘要 → 兴趣度排行 → 可视化日报，一站式全链路数据分析 </p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/pnpm-10.15.0-orange.svg" alt="pnpm"></a>
  <a href="#-贡献指南"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

---

<!-- TOC: 可使用 GitHub 左上角 "Table of Contents" 按钮快速导航 -->

## 🚀 快速开始

> **前提：** 已安装 [Node.js](https://nodejs.org/)（≥ v20）、[pnpm](https://pnpm.io/)、[MongoDB](https://www.mongodb.com/try/download/community) 和 [Ollama](https://ollama.com/)。

```bash
# 1. 克隆项目
git clone https://github.com/Will-hxw/synthos.git
cd synthos

# 2. 安装依赖
pnpm install

# 3. 创建配置文件
cp synthos_config.example.json synthos_config.json
# 🔴 编辑 synthos_config.json，填入你的 LLM API Key 等必要配置

# 4. 下载 Embedding 模型
ollama pull bge-m3

# 5. 一键启动
# Windows:
run.bat

# Linux / macOS:
bash run.sh
```

启动后访问 **`http://localhost:3011`** 即可看到 WebUI。若“最新话题”或“群组管理”为空，可查看空态中的启动状态提示，或直接访问后端诊断接口 **`http://localhost:3002/api/setup-status`**。

### 项目截图

<p align="center">
  <img src="docs/assets/前端白色.png" alt="WebUI 截图 1" width="45%">
  <img src="docs/assets/前端暗黑.png" alt="WebUI 截图 2" width="45%">
  <br>
  <em>WebUI 界面预览</em>
</p>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🤖 **AI 摘要生成** | 基于云端/本地 LLM 自动生成高质量对话摘要 |
| 📊 **兴趣度指数** | 自定义正/负向关键词，系统为每个话题智能打分排序 |
| 🔍 **语义搜索** | 基于 `bge-m3` 向量嵌入的全文语义检索（RAG） |
| 💬 **Agent 问答** | WebUI 内置 AI Agent，支持流式 SSE 输出与工具调用 |
| 📰 **日报自动生成** | 半日/周/月报自动生成，支持邮件推送 |
| 📥 **历史记录拉取** | 自动增量同步 QQ 聊天记录，支持历史回溯 |
| 👥 **多群组管理** | 灵活配置不同群组的分析策略与 AI 模型 |
| ⚙️ **可视化配置面板** | WebUI 内置配置编辑器，支持 Schema 校验 |

---

## 🏗 系统架构

![系统架构图](./docs/assets/Synthos架构7.drawio.png)

### 数据流

```
QQ 本地数据库 → [data-provider] → [preprocessing] → [ai-model] → [webui-backend] → [webui-frontend]
                                     │                    │
                                     └─ 清洗/分组/拼接 ───┴─ 摘要/向量化/兴趣度/日报
```

### 模块职责

| 模块 | 端口 | 职责 |
|------|------|------|
| `data-provider` | — | 从 QQ 本地数据库读取原始聊天记录（Windows / macOS ARM） |
| `preprocessing` | — | 清洗、分组、上下文拼接、引用消息解析 |
| `ai-model` | `7979` | 文本向量化、摘要生成、兴趣度计算、RAG 检索 |
| `orchestrator` | — | Pipeline 调度器，按时序编排各数据处理任务 |
| `webui-backend` | `3002` | RESTful API 服务，群组管理、消息查询、配置管理 |
| `webui-frontend` | `3011` | React SPA，数据可视化与交互界面 |
| `webui-forwarder` | — | 内网穿透转发（可选，调试用） |

---

## 📋 环境要求

| 依赖 | 版本要求 | 用途 | 必需？ |
|------|----------|------|--------|
| **Node.js** | ≥ v20（推荐 `v24.5.0`） | 运行时 | ✅ |
| **pnpm** | `10.15.0` | 包管理器 | ✅ |
| **MongoDB** | ≥ 7.0 | 任务调度（Agenda）| ✅ |
| **Ollama** | 最新版 | 本地 Embedding 模型服务 | ✅ |
| **bge-m3** | — | 1024 维向量嵌入模型 | ✅ |

> **注意：** `data-provider` 模块支持 Windows x86_64 和 macOS Apple Silicon（需 QQ NT 桌面版）。Linux 暂未支持，可跳过此模块使用其他功能。

---

## 🔧 安装与配置

### 1. 安装 Node.js 与 pnpm

项目以 `.nvmrc` 中的 `v24.5.0` 为基准，使用 `pnpm@10.15.0` 管理 monorepo。

```bash
# 使用 nvm（推荐）
nvm install 24.5.0
nvm use 24.5.0

# 启用 pnpm（Node.js 16.13+ 自带 corepack）
corepack enable
corepack prepare pnpm@10.15.0 --activate
```

本项目包含 `better-sqlite3`、`@journeyapps/sqlcipher`、`sqlite-vec` 等原生依赖。请始终在仓库根目录使用 `pnpm install` 或 `pnpm install --frozen-lockfile` 安装依赖，不要在子项目目录执行安装命令。

### 2. 安装 MongoDB

下载并安装 [MongoDB Community Edition](https://www.mongodb.com/try/download/community)，确保服务运行在 `localhost:27017`。

> 如果你的 MongoDB 使用不同地址，可通过 `SYNTHOS_MONGODB_URL` 环境变量覆盖（见[环境变量](#-环境变量)表格）。

### 3. 安装 Ollama 与 Embedding 模型

```bash
# 安装 Ollama：https://ollama.com/download

# 拉取 bge-m3 向量模型（1024 维）
ollama pull bge-m3

# 确认服务运行中
curl http://localhost:11434

# 确认模型已安装
ollama list
curl http://localhost:11434/api/tags
```

### 4. 配置文件

从模板创建配置文件：

```bash
cp synthos_config.example.json synthos_config.json
```
完整字段格式参考：[`common/services/config/schemas/GlobalConfig.ts`](./common/services/config/schemas/GlobalConfig.ts)。

> **配置面板不会自动创建主配置文件。** 首次使用仍需先复制 `synthos_config.example.json`。如果 `synthos_config.json` 缺失、JSON 格式错误或模型引用无效，配置面板会显示明确错误；修复后可继续使用 `pnpm dev:config` 可视化编辑。

### 5. 配置 LLM 模型

编辑 `synthos_config.json` 中的 `ai.models` 和 `ai.defaultModelConfig`：

```json
{
  "ai": {
    "models": {
      "my-model": {
        "apiKey": "sk-your-api-key-here",
        "baseURL": "https://api.example.com/v1",
        "temperature": 0.7,
        "maxTokens": 100000,
        "reasoning": {
          "enabled": false,
          "effort": "minimal"
        }
      }
    },
    "defaultModelNames": ["my-model"],
    "defaultModelConfig": {
      "apiKey": "sk-your-api-key-here",
      "baseURL": "https://api.example.com/v1",
      "temperature": 0.7,
      "maxTokens": 100000,
      "reasoning": {
        "enabled": false,
        "effort": "minimal"
      }
    }
  }
}
```

> 兼容任何 OpenAI 兼容 API（DeepSeek、MIMO、通义千问、GLM 等），只需修改 `baseURL` 和 `apiKey`。`reasoning.enabled` 默认关闭；只有确认上游模型支持对应参数时才开启。

### 6. 配置图片理解（可选）

图片理解默认关闭。启用后，系统会在 `ProvideData` 后异步处理新入库图片：先用 OCR.space 提取文字，再用 DashScope OpenAI-compatible 视觉模型生成中文理解文本，最终仍以纯文本进入摘要上下文。系统只保存 QQ 原始图片 URL 和元信息，不缓存原图、不保存 base64。

```json
{
  "ai": {
    "imageUnderstanding": {
      "enabled": false,
      "ocr": {
        "provider": "ocrspace",
        "apiKey": "replace-with-ocrspace-api-key",
        "endpoint": "https://api.ocr.space/parse/image",
        "language": "chs",
        "ocrEngine": 2,
        "scale": true,
        "detectOrientation": true,
        "isOverlayRequired": false,
        "maxImageBytes": 1048576
      },
      "vision": {
        "provider": "dashscope-openai-compatible",
        "apiKey": "replace-with-dashscope-api-key",
        "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "modelName": "qwen3.6-flash-2026-04-16",
        "temperature": 0,
        "maxTokens": 2048
      },
      "maxImagesPerRun": 50,
      "retryCount": 2,
      "requestTimeoutMs": 30000,
      "processOnlyNewMessages": true
    }
  }
}
```

请把真实 OCR.space 和 DashScope API Key 放在本地 `synthos_config.json` 或 ignored override 配置中，不要提交到仓库。`processOnlyNewMessages` 默认开启，v1 不做历史图片全量回填。

### 7. 配置 QQ 数据源

若需自动拉取 QQ 聊天记录，配置 `dataProviders.QQ`：

```json
{
  "dataProviders": {
    "QQ": {
      // Windows x86_64
      "VFSExtPath": "./assets/sqlite_vfs_plugins/win_x86/sqlite_ext_ntqq_db.dll",
      "dbBasePath": "C:/Users/<用户名>/Documents/Tencent Files/<QQ号>/nt_qq/nt_db",

      // macOS Apple Silicon（使用下面两行替换上面两行）
      // "VFSExtPath": "./assets/sqlite_vfs_plugins/mac_arm64/libsqlite_ext_ntqq_db.dylib",
      // "dbBasePath": "/Users/<用户名>/Library/Containers/com.tencent.qq/Data/Documents/nt_qq/nt_db",

      "dbKey": "<数据库密钥>",
      "dbPatch": { "enabled": false, "patchSQL": "" },
      "sourceReconcile": { "enabled": false, "batchSize": 50000 },
      "groupFile": { "includePathInMessageContent": true }
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `VFSExtPath` | SQLite VFS 扩展路径，项目内置 `win_x86`（`.dll`）和 `mac_arm64`（`.dylib`）两个版本 |
| `dbBasePath` | QQ 本地数据库目录，不同操作系统路径不同，具体情况具体分析 |
| `dbKey` | QQ 数据库加密密钥 |
| `sourceReconcile.enabled` | 是否启用 QQ 原库回填；设为 `false` 时跳过原库扫描 |
| `sourceReconcile.batchSize` | QQ 原库每个群每轮扫描的业务消息数量，默认 50000，最大 50000；`enabled=false` 时可为 0 |
| `groupFile.includePathInMessageContent` | 是否在群文件消息正文中追加完整文件路径，用于本地排查 |

历史数据是分批渐进处理的：`dataProviders.QQ.sourceReconcile.enabled` 控制是否启用 QQ 原库扫描；启用时 `dataProviders.QQ.sourceReconcile.batchSize` 控制每轮从 QQ 原库扫描多少业务消息，`preprocessors.historicalBackfill.messageLimit` 控制每轮对已落库但尚未分配 `sessionId` 的历史消息做多少候选回填，默认 10000。

**数据库密钥获取方式：**

- **Windows**：可直接使用 `QQDatabaseKey.exe`。在 QQ 已登录状态下运行 `QQDatabaseKey.exe`，程序会自动退出 QQ；此时重新登录 QQ，程序会获取数据库密钥并写入 `password.txt`，从该文件复制密钥填入 `dbKey`。
- **其他操作系统**：沿用原参考资料获取：[QQ 数据库密钥文档](https://docs.aaqwq.top/)、[qq-win-db-key](https://github.com/QQBackup/qq-win-db-key)。

> ⚠️ `data-provider` 支持 **Windows x86_64** 和 **macOS Apple Silicon**。Linux 暂未实现。如果不需要自动拉取 QQ 数据，可跳过此模块。

### 8. 配置群组

```json
{
  "groupConfigs": {
    "<群号>": {
      "IM": "QQ",
      "groupName": "群聊显示名称",
      "splitStrategy": "accumulative",
      "groupIntroduction": "群简介（可选，会加入 AI 上下文）",
      "aiModels": ["my-model"]
    }
  }
}
```

- `splitStrategy`：`"accumulative"`（按字数累计分割）或 `"realtime"`（按时间实时分割）
- `aiModels`：该群使用的 AI 模型列表，按优先级排序

---

## ⚡ 启动项目

### 方式一：一键启动（推荐）

```bash
# Windows
run.bat

# Linux / macOS
bash run.sh
```

`run.bat` / `run.sh` 会自动检查 Ollama 服务状态，然后启动全部开发服务。

### 方式二：pnpm 命令

| 命令 | 包含的服务 | 适用场景 |
|------|-----------|----------|
| `pnpm dev:all` | 全部 6 个服务 | **完整开发环境** |
| `pnpm dev:backend` | orchestrator, preprocessing, ai-model, data-provider, webui-backend | 仅后端开发 |
| `pnpm dev:webui` | ai-model, webui-backend, webui-frontend | 前端 + AI 开发 |
| `pnpm dev:config` | webui-backend (配置模式), webui-frontend | **可视化配置面板** |
| `pnpm dev:public-preview` | 全部服务 + 静态预览 + 公网转发 | 公网演示 |

> 除 `pnpm dev:config` 外，所有命令启动前会自动检查 MongoDB 是否可达。

### 服务端口

| 服务 | 默认端口 |
|------|----------|
| WebUI 前端 | `3011` |
| WebUI 后端 API | `3002` |
| AI RPC 服务 | `7979` |
| Ollama | `11434` |
| MongoDB | `27017` |

---

## 🐳 Docker 部署（不成熟）

项目提供 Docker Compose 编排，包含 MongoDB、后端服务、Nginx 前端。

> ⚠️ Docker 模式默认不会抓取 QQ 数据。`data-provider` 必须在宿主机单独启动，因为它需要访问宿主机 QQ NT 数据库和平台特定 VFS 插件。只执行 `docker compose up -d` 时，WebUI 可以打开，但不会自动导入新的 QQ 消息。

### 前置条件

- 已安装 [Docker](https://docs.docker.com/get-docker/) 和 Docker Compose
- 宿主机已安装 [Ollama](https://ollama.com/) 并拉取 `bge-m3` 模型（或用 `--profile ollama` 使用内置 Ollama 容器）

### 快速启动

```bash
# 1. 复制 Docker 专用配置模板
cp docker/config/synthos_config.docker.example.json docker/config/synthos_config.json

# 2. 编辑配置，填入 LLM API Key（其余字段已针对 Docker 环境预配置好）
#    🔴 必改：ai.models.<name>.apiKey 和 ai.defaultModelConfig.apiKey

# 3. 启动全部服务
docker compose up -d

# 4. 访问
#    前端：http://localhost:8080
#    后端 API：http://localhost:3002
```

如需自动拉取 QQ 数据，请另开一个宿主机 PowerShell，在仓库根目录执行：

```powershell
$env:SYNTHOS_CONFIG_PATH="D:\path\to\synthos\docker\config\synthos_config.json"
$env:SYNTHOS_MONGODB_URL="mongodb://localhost:27017/synthos"
pnpm --filter data-provider dev
```

如果 WebUI 没有话题数据，优先检查：

- 宿主机 `data-provider` 是否正在运行；
- `docker/config/synthos_config.json` 是否配置了目标群号；
- QQ `dbKey`、`dbBasePath`、`VFSExtPath` 是否指向宿主机真实路径；
- 宿主机 `data-provider` 是否连接到了 Docker 暴露的 `mongodb://localhost:27017/synthos`。

### 使用内置 Ollama（可选）

如果不希望依赖宿主机 Ollama，可启用内置容器：

```bash
docker compose --profile ollama up -d
docker exec -it synthos-ollama ollama pull bge-m3

# 同时修改 docker/config/synthos_config.json：
# "ollamaBaseURL": "http://ollama:11434"  ← 改为 Ollama 服务名
```

### 服务说明

| 服务 | 容器名 | 端口 |
|------|--------|------|
| MongoDB | `synthos-mongo` | `27017` |
| AI Model | `synthos-ai-model` | `7979` |
| WebUI Backend | `synthos-webui-backend` | `3002` |
| WebUI Frontend (Nginx) | `synthos-webui-frontend` | `8080` |
| Ollama（需 `--profile ollama`） | `synthos-ollama` | `11434` |

> Docker 部署仍受 `data-provider` 的宿主机约束影响：QQ NT 数据库目录、数据库密钥和 SQLite VFS 原生扩展必须来自宿主机环境。仅部署 WebUI、后端、AI Model 和 MongoDB 不会自动产生 QQ 聊天数据；需要确认 `dataProviders.QQ.dbBasePath`、`VFSExtPath` 和挂载路径都指向真实可读位置。

### 数据持久化

| 宿主机目录 | 容器内路径 | 用途 |
|-----------|-----------|------|
| `./docker/config/` | `/config`（只读） | 配置文件 |
| `./docker/data/` | `/app/data` | SQLite / LevelDB / 向量数据库 |
| `./docker/logs/` | `/app/logs` | 日志文件 |
| `./docker/volumes/mongo/` | `/data/db` | MongoDB 数据 |
| `./docker/volumes/ollama/` | `/root/.ollama` | Ollama 模型文件 |

> ⚠️ `data-provider` 无法在容器中运行（需访问宿主机 QQ 桌面客户端本地数据库 + 平台特定 VFS 插件）。Docker Compose 中的 `data-provider` 只是 host-only 占位说明，真实抓取必须按上面的宿主机命令启动。

---

## 🔐 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `SYNTHOS_CONFIG_PATH` | `./synthos_config.json` | 配置文件路径 |
| `SYNTHOS_MONGODB_URL` | `mongodb://localhost:27017/synthos` | MongoDB 连接地址（优先于 `MONGODB_URL`） |
| `MONGODB_URL` | — | MongoDB 连接地址（备选） |
| `SYNTHOS_AI_RPC_BASE_URL` | `http://localhost:7979` | AI RPC 服务地址 |
| `CONFIG_PANEL_MODE` | `false` | 启用配置面板模式 |
| `CONFIG_PANEL_PORT` | `3002` | 配置面板模式下的后端端口 |
| `VITE_CONFIG_PANEL_MODE` | `false` | 前端配置面板模式 |
| `DEV_RUNNER_DEBUG` | `0` | 开发运行器调试日志（`1` / `true`） |
| `SYNTHOS_PUBLIC_TUNNEL_TARGET_PORT` | `3011` | 公网隧道目标端口 |
| `SYNTHOS_PUBLIC_TUNNEL_TARGET_HOST` | `127.0.0.1` | 公网隧道目标主机 |
| `SYNTHOS_NGROK_BIN` | - | ngrok 可执行文件路径；未设置时优先使用仓库内依赖，再回退到 `PATH` |
| `SYNTHOS_PUBLIC_PREVIEW_HOST` | `127.0.0.1` | 静态预览服务主机 |
| `SYNTHOS_PUBLIC_PREVIEW_PORT` | `3012` | 静态预览服务端口 |
| `SYNTHOS_WEBUI_BACKEND_HOST` | `127.0.0.1` | 后端服务主机（公网转发用） |
| `SYNTHOS_WEBUI_BACKEND_PORT` | `3002` | 后端服务端口（公网转发用） |

---

## 📡 API 接口

完整 API 文档：[`docs/接口文档/API文档.md`](./docs/接口文档/API文档.md)

### 核心接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/group-details` | 群组列表 |
| `GET` | `/api/chat-messages-by-group-id` | 按群查询消息 |
| `GET` | `/api/ai-digest-result-by-topic-id` | AI 摘要结果 |
| `POST` | `/api/search` | 语义搜索 |
| `POST` | `/api/ask` | RAG 问答 |
| `POST` | `/api/agent/ask` | Agent 对话 |
| `POST` | `/api/agent/ask/stream` | Agent 流式对话（SSE） |
| `POST` | `/api/reports` | 日报列表 |
| `POST` | `/api/latest-topics` | 最新话题（含兴趣度排序） |
| `POST` | `/api/topic/favorite/mark` | 收藏话题 |

### 配置面板接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/config/schema` | 获取配置 Schema |
| `GET` | `/api/config/current` | 当前完整配置 |
| `GET/POST` | `/api/config/base` | 基础配置读写 |
| `GET/POST` | `/api/config/override` | Override 配置读写 |
| `POST` | `/api/config/validate` | 配置校验 |

> 前端开发指引详见 [`docs/接口文档/前端开发指引文档.md`](./docs/接口文档/前端开发指引文档.md)。

---

## 📂 项目结构

```
synthos/
├── applications/
│   ├── ai-model/          # AI 模型服务：摘要、向量化、兴趣度、RAG
│   ├── data-provider/     # QQ 数据源适配器（Win / macOS ARM）
│   ├── db-cli/            # 数据库命令行工具
│   ├── orchestrator/      # Pipeline 调度编排
│   ├── preprocessing/     # 数据预处理与清洗
│   ├── webui-backend/     # WebUI RESTful API 后端
│   ├── webui-forwarder/   # 内网穿透转发服务
│   └── webui-frontend/    # React SPA 前端
├── common/                # 共享模块：类型、配置、数据库、日志
│   ├── contracts/         # 数据契约与类型定义
│   ├── di/                # 依赖注入容器
│   ├── rpc/               # tRPC 通信
│   ├── scheduler/         # Agenda 任务调度
│   ├── services/          # 公共服务：配置管理、数据库访问、邮件
│   └── util/              # 工具函数
├── docker/                # Docker 构建文件与 Nginx 配置
├── docs/                  # 文档与截图
├── scripts/               # 构建与开发脚本
├── assets/                # 静态资源（SQLite VFS 插件等）
├── synthos_config.example.json  # 配置模板
├── docker-compose.yml     # Docker 编排
├── run.bat                # Windows 一键启动
├── run.sh                 # Linux/macOS 一键启动
└── package.json           # Monorepo 根配置
```

---

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js |
| 包管理 | pnpm (Monorepo) |
| 后端框架 | Express 5 |
| 前端框架 | React 18 + Vite |
| UI 组件库 | HeroUI + Tailwind CSS 4 |
| 图表 | ECharts |
| RPC | tRPC |
| 依赖注入 | TSyringe |
| 任务调度 | Agenda + MongoDB |
| 数据库 | SQLite (better-sqlite3) + LevelDB + sqlite-vec |
| LLM 框架 | LangChain |
| 向量模型 | bge-m3 (via Ollama) |
| 测试 | Vitest |
| 容器化 | Docker Compose + Nginx |

---

## ❓ 常见问题

### MongoDB 未启动

```
[MongoDB 检查] MongoDB 不可达，启动已中止。
```

**解决：** 确保 MongoDB 服务正在运行，或设置 `SYNTHOS_MONGODB_URL` 指向你的 MongoDB 实例。

```bash
# Windows
net start MongoDB

# macOS (Homebrew)
brew services start mongodb-community

# Linux
sudo systemctl start mongod
```

### Ollama 未运行

**解决：** `run.bat` / `run.sh` 会自动检测并启动 Ollama。若手动操作：

```bash
ollama serve
```

若语义搜索或 RAG 没有结果，还需要确认 embedding 模型已安装：

```bash
ollama list
ollama pull bge-m3
curl http://localhost:11434/api/tags
```

### 端口被占用

默认端口 `3011` / `3002` / `7979` 被占用时，修改 `synthos_config.json` 中对应端口即可。

### Windows native 依赖安装失败排查

`@journeyapps/sqlcipher`、`better-sqlite3`、`sqlite3` 等原生模块可能触发编译或 postinstall。Windows 上建议先确认以下环境：

```powershell
node -v
pnpm -v
python --version
npm config get msvs_version
```

推荐组合：

- Node.js 22 LTS（如果 Node 24 安装 native 依赖失败，先切回 Node 22 LTS 复试）
- pnpm 10.15.0
- Python 3.11+
- Visual Studio Build Tools 2022
  - Desktop development with C++
  - MSVC v143
  - Windows 10/11 SDK

常见处理：

| 现象 | 处理 |
|------|------|
| `node-gyp` 找不到编译工具 | 安装 Visual Studio Build Tools 2022，并勾选 C++ 桌面开发、MSVC v143、Windows SDK |
| 找不到 Python | 安装 Python 3.11+，必要时执行 `npm config set python <python.exe路径>` |
| `@journeyapps/sqlcipher` postinstall 卡住或失败 | 优先切到 Node 22 LTS 后重新 `pnpm install` |
| `better-sqlite3` bindings 缺失 | 重新执行 `pnpm install`，必要时再执行 `pnpm rebuild better-sqlite3` |
| pnpm 提示构建脚本未批准 | 确认根目录 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`，必要时执行 `pnpm approve-builds` |

注意：不要在子项目目录单独执行 `pnpm install`。新增或修复依赖后，应回到 monorepo 根目录执行。

```powershell
pnpm install
```

### `data-provider` 无法启动

`data-provider` 需要本地安装 QQ NT 桌面版。支持的平台：
- **Windows x86_64** — `VFSExtPath` 使用 `win_x86/sqlite_ext_ntqq_db.dll`
- **macOS Apple Silicon** — `VFSExtPath` 使用 `mac_arm64/libsqlite_ext_ntqq_db.dylib`
- **Linux** — 暂不支持

如不需要自动拉取 QQ 数据，使用 `pnpm dev:webui` 跳过此模块即可。

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/your-feature`
3. 提交代码：`git commit -m "feat(scope): description"`
4. 推送分支：`git push origin feat/your-feature`
5. 创建 Pull Request

> 提交信息请遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范。

---

## 📄 许可证

[MIT](./LICENSE) © 2025-present Synthos
