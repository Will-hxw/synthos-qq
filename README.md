<p align="center">
  <h1 align="center">🔬 Synthos</h1>
  <p align="center"><strong>智能聊天记录全链路分析系统</strong></p>
  <p align="center">从原始 QQ 聊天记录导入 → 上下文理解 → AI 摘要 → 兴趣度排行 → 可视化日报，一站式全链路数据分析</p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/pnpm-10.15.0-orange.svg" alt="pnpm"></a>
  <a href="#"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

---

<!-- TOC: 可使用 GitHub 左上角 "Table of Contents" 按钮快速导航 -->

## 🚀 快速开始

> **前提：** 已安装 [Node.js](https://nodejs.org/)（≥ v20）、[pnpm](https://pnpm.io/)、[MongoDB](https://www.mongodb.com/try/download/community) 和 [Ollama](https://ollama.com/)。

```bash
# 1. 安装依赖
pnpm install

# 2. 创建配置文件
cp synthos_config.example.json synthos_config.json
# 🔴 编辑 synthos_config.json，填入你的 LLM API Key 等必要配置

# 3. 下载 Embedding 模型
ollama pull bge-m3

# 4. 一键启动 🎯
# Windows:
run.bat

# Linux / macOS:
bash run.sh
```

启动后访问 **`http://localhost:3011`** 即可看到 WebUI。

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
| `data-provider` | — | 从 QQ 本地数据库读取原始聊天记录（**仅限 Windows**） |
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

> **注意：** `data-provider` 模块依赖 Windows QQNT 数据库，**仅在 Windows 下可用**。Linux/macOS 用户暂未实现，仅支持手动导入聊天数据。

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

### 2. 安装 MongoDB

下载并安装 [MongoDB Community Edition](https://www.mongodb.com/try/download/community)，确保服务运行在 `localhost:27017`。

> 如果你的 MongoDB 使用不同地址，可通过环境变量覆盖（见[环境变量](#-环境变量)）。

### 3. 安装 Ollama 与 Embedding 模型

```bash
# 安装 Ollama：https://ollama.com/download

# 拉取 bge-m3 向量模型（1024 维）
ollama pull bge-m3

# 确认服务运行中
curl http://localhost:11434
```

### 4. 配置文件

从模板创建配置文件：

```bash
cp synthos_config.example.json synthos_config.json
```
完整字段格式参考：[`common/services/config/schemas/GlobalConfig.ts`](./common/services/config/schemas/GlobalConfig.ts)。

> 你也可以使用 **配置面板**（`pnpm dev:config`）在 WebUI 中可视化编辑配置，无需手动编辑 JSON。

### 5. 配置 LLM 模型

编辑 `synthos_config.json` 中的 `ai.models` 和 `ai.defaultModelConfig`：

```json
{
  "ai": {
    "models": {
      "my-model": {
        "apiKey": "sk-your-api-key-here",
        "baseURL": "https://api.openai.com/v1",
        "temperature": 0.7,
        "maxTokens": 100000
      }
    },
    "defaultModelName": "my-model",
    "pinnedModels": ["my-model"],
    "defaultModelConfig": {
      "apiKey": "sk-your-api-key-here",
      "baseURL": "https://api.openai.com/v1",
      "temperature": 0.7,
      "maxTokens": 100000
    }
  }
}
```

> 兼容任何 OpenAI 兼容 API（DeepSeek、MIMO、通义千问、GLM 等），只需修改 `baseURL` 和 `apiKey`。

### 7. 配置 QQ 数据源

```json
{
  "dataProviders": {
    "QQ": {
      "VFSExtPath": "./assets/sqlite_vfs_plugins/win_x86/sqlite_ext_ntqq_db.dll",
      "dbBasePath": "C:/Users/<用户名>/Documents/Tencent Files/<QQ号>/nt_qq/nt_db",
      "dbKey": "<数据库密钥>",
      "dbPatch": { "enabled": false }
    }
  }
}
```

- `dbBasePath`：QQ 本地数据库目录路径（不同用户路径不同，具体情况具体分析）
- `dbKey`：QQ 数据库加密密钥，获取方法详见 [QQ 数据库密钥文档](https://docs.aaqwq.top/)
- `VFSExtPath`：SQLite VFS 扩展 DLL 路径（项目已内置 `win_x86` 版本）

> ⚠️ `data-provider` 仅限 Windows 系统。Linux/macOS 暂未实现

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

## 🐳 Docker 部署

```bash
# 1. 准备配置目录
mkdir -p docker/config
cp synthos_config.json docker/config/

# 2. 按需编辑 docker/config/synthos_config.json
#    注意：MongoDB 地址应改为 mongodb://mongo:27017/synthos

# 3. 启动全部服务
docker compose up -d

# 4. （可选）使用内置 Ollama 容器
docker compose --profile ollama up -d
# 进入 Ollama 容器拉取模型：
docker exec -it synthos-ollama ollama pull bge-m3

# 5. 访问
#    前端：http://localhost:8080
#    后端 API：http://localhost:3002
```

> ⚠️ `data-provider` 无法在 Docker 中运行（依赖 Windows QQNT 数据库 + VFS DLL），请在宿主机单独启动。

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
│   ├── data-provider/     # QQ 数据源适配器（仅限 Windows）
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

### 端口被占用

默认端口 `3011` / `3002` / `7979` 被占用时，修改 `synthos_config.json` 中对应端口即可。

### `pnpm install` 失败（Windows）

确保满足以下条件：
- 已安装 Python 3 和 C++ 构建工具（`better-sqlite3` 等原生模块需要编译）
- 使用 PowerShell 或 cmd（不是 Git Bash）运行

```powershell
# 方法一：安装 Visual Studio Build Tools（推荐）
# 下载：https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
# 安装时勾选 "Desktop development with C++"

# 方法二：通过 npm 安装（需管理员）
npm install -g --production windows-build-tools@4.0.0

# 方法三：仅安装 Python（如已有 VS Build Tools）
npm config set python python3
```

### `data-provider` 无法启动（非 Windows）

`data-provider` 依赖 Windows QQNT 数据库，**仅支持 Windows**。Linux/macOS 用户请使用 `pnpm dev:webui` 跳过此模块。

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
