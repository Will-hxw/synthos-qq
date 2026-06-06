# Synthos：智能聊天记录全链路分析系统

## 项目简介

Synthos 是一个基于 `Node.js` 和 `TypeScript` 构建的智能聊天记录分析系统，专注于 QQ 聊天记录的全链路数据处理与 AI 总结功能。项目采用现代化的 Monorepo 架构，融合自然语言处理、向量模型、任务调度与 Web 前端展示，为用户提供从原始聊天记录导入、上下文理解、兴趣度分析到可视化摘要输出的一站式解决方案。

---

## 系统架构

![系统架构图](./docs/assets/Synthos架构7.drawio.png)

---

## 核心功能特性

- **智能预处理**：自动分组、上下文拼接、引用消息追踪
- **AI 摘要生成**：基于云端/本地模型生成高质量对话摘要
- **兴趣度指数**：用户可设置关键词偏好，系统为每个话题打分排序（支持负向反馈）
- **历史记录自动拉取**：支持增量同步与历史回溯
- **日报自动生成**：每日汇总高价值讨论内容
- **多群组管理**：灵活配置不同群组的分析策略

### Agent 对话（流式）

- WebUI 对外提供 Agent 问答能力，并支持 **REST SSE（`POST /api/agent/ask/stream`）** 全流式输出。
- 事件协议为稳定业务事件：`token` / `tool_call` / `tool_result` / `done` / `error`（用于前端展示 token 与工具调用过程）。
- 单实例并发保护：同一 `conversationId` 不允许并发双发（冲突时返回 HTTP `409`）。

接口细节（请求参数、事件格式、time-travel 接口等）见：[docs/接口文档/API文档.md](./docs/接口文档/API文档.md)

---

## 技术架构

### 核心技术栈

- **🧑‍💻语言**：纯 TypeScript + Node
- **🎯项目管理**：Pnpm + Monorepo
- **🐳容器化/部署（WIP）**：Docker Compose + Nginx（前端静态托管 & /api 反代；`data-provider` 仍需在宿主机运行）
- **💬RPC库**：tRPC
- **💉依赖注入框架**：TSyringe
- **🕗任务调度与编排框架**：Agenda
- **📚数据库**：MongoDB（任务调度） + SQLite（聊天记录 & ai生成数据存储） + LevelDB（KV元数据存储） + sqlite-vec（向量索引存储）
- **📦向量数据库**：基于 better-sqlite3 + sqlite-vec 的轻量级向量存储方案
- **🤖LLM框架**：Langchain，支持任意云端 LLM or 本地的 Ollama
- **🧪测试框架**：Vitest  
- **🌏Web 后端框架**：Express
- **⚛️Web 前端框架**：React + ECharts + HeroUI + Tailwind CSS

### 模块划分

| 模块 | 职责 |
|------|------|
| `data-provider` | 从 QQ 等 IM 平台获取原始聊天记录 |
| `preprocessing` | 清洗、分组、上下文拼接、引用解析 |
| `ai-model` | 文本向量化、主题提取、摘要生成、兴趣度计算、向量嵌入存储与检索（RAG） |
| `orchestrator` | Pipeline 调度器，按顺序串联执行各数据处理任务（ProvideData → Preprocess → AISummarize → GenerateEmbedding → InterestScore） |
| `webui-backend` | 提供 RESTful API，支持群组管理、消息查询、结果获取 |
| `common` | 共享类型定义、配置管理、数据库工具、日志系统 |

---

## 快速开始

### 1. 环境准备

#### 安装 Node.js 与 pnpm

项目当前以 `.nvmrc` 中的 `v24.5.0` 为 Node.js 版本基准，并使用 `pnpm@10.15.0` 管理 monorepo 依赖。请在仓库根目录执行所有依赖安装和启动命令，不要在子项目目录单独安装依赖。

#### 安装 MongoDB

项目依赖 Agenda 进行任务调度，需提前安装 [MongoDB 社区版](https://www.mongodb.com/try/download/community) 并确保服务正在运行。

#### 安装 Ollama 并下载 bge-m3 模型（用于 RAG 向量检索）

项目使用 Ollama 部署 `bge-m3` 模型生成 1024 维嵌入向量，用于话题的语义检索。

1. **安装 Ollama**：访问 [Ollama 官网](https://ollama.ai/) 下载并安装

2. **拉取 bge-m3 模型**：

```bash
ollama pull bge-m3
```

1. **确保 Ollama 服务运行**：默认监听 `http://localhost:11434`

> 💡 **提示**：Ollama 服务会在系统启动时自动运行。如需手动启动，执行 `ollama serve`。

#### 准备配置文件

从示例文件复制生成本地配置：

```bash
cp synthos_config.example.json synthos_config.json
```
完整字段格式请参考 [`common/services/config/schemas/GlobalConfig.ts`](./common/services/config/schemas/GlobalConfig.ts)。

QQ 数据库密钥配置方法详见：[https://docs.aaqwq.top/](https://docs.aaqwq.top/)

### 2. 启动项目

#### 方式一：使用开发模式（推荐）

`pnpm dev:all`、`pnpm dev:backend`、`pnpm dev:webui`、`pnpm dev:forwarder` 和 `pnpm dev:public-preview` 启动前会只读检查 MongoDB TCP 可达性，地址读取顺序为 `SYNTHOS_MONGODB_URL` → `MONGODB_URL` → `mongodb://localhost:27017/synthos`。`pnpm dev:config` 是配置面板轻量模式，不强制检查 MongoDB。

```bash
# 1. 安装monorepo依赖
pnpm i # 这不仅会安装根目录下的依赖，还会自动安装所有子项目的依赖

# 2. 启动所有服务（含前后端，支持热重载）
pnpm dev:all

# 或者，检查 Ollama 后启动全部开发服务
bash run.sh

# 或者，仅启动后端服务（不含前端）
pnpm dev:backend

# 或者，仅启动配置面板（轻量级模式）
pnpm dev:config

# 或者，启动完整服务 + 公网静态预览转发（需配置内网穿透）
pnpm dev:public-preview

# 或者，启动完整服务 + 开发服务器公网转发（仅用于调试 forwarder）
pnpm dev:forwarder
```

服务启动后可通过以下地址访问：

- WebUI 前端：`http://localhost:3011`
- WebUI 后端健康检查：`http://localhost:3002/health`
- AI RPC 服务：`http://localhost:7979`

公网转发目标端口统一通过 `SYNTHOS_PUBLIC_TUNNEL_TARGET_PORT` 覆盖。`pnpm dev:public-preview` 会自动把隧道目标设置为静态预览端口 `3012`；`pnpm dev:forwarder` 默认仍转发开发服务器端口 `3011`，调试其他前端目标时可使用同一变量覆盖。
---

**可用的启动脚本：**

| 命令 | 说明 | 包含的服务 |
|------|------|-----------|
| `pnpm dev:all` | 完整开发环境（推荐） | orchestrator, preprocessing, ai-model, data-provider, webui-backend, webui-frontend |
| `bash run.sh` | 检查 Ollama 后启动完整开发环境 | orchestrator, preprocessing, ai-model, data-provider, webui-backend, webui-frontend |
| `pnpm dev:backend` | 仅后端服务 | orchestrator, preprocessing, ai-model, data-provider, webui-backend |
| `pnpm dev:webui` | WebUI 开发模式 | ai-model, webui-backend, webui-frontend |
| `pnpm dev:config` | 配置面板模式 | webui-backend (配置模式), webui-frontend |
| `pnpm dev:public-preview` | 完整服务 + 生产构建静态预览 + 公网转发（推荐用于公网访问） | 所有服务 + static webui preview + ngrok |
| `pnpm dev:forwarder` | 完整服务 + 开发服务器公网转发（仅用于调试 forwarder） | 所有服务 + webui-forwarder |

---

## API 与前端开发

- **API 文档**：详见 [`docs/接口文档/API文档.md`](./docs/接口文档/API文档.md)
- **前端开发指引**：详见 [`docs/接口文档/前端开发指引文档.md`](./docs/接口文档/前端开发指引文档.md)

核心接口包括：

- `GET /api/group-details`：获取群组列表
- `GET /api/chat-messages-by-group-id`：按群组查询消息
- `GET /api/ai-digest-result-by-topic-id`：获取 AI 摘要结果
- `GET /api/is-session-summarized`：检查会话是否已总结

---
