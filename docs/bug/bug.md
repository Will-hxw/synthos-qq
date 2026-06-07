# Synthos 开源使用阻塞 / Bug 阶段性审查结果

> 范围：只考虑功能正确性、性能效率、结果准确度和交互体验问题。安全、权限、泄露、敏感信息、成本控制类问题不纳入。

## 2026-06-07 修复状态

本报告中的真实问题已按当前决策完成修复：

1. Node v24.5.0 保留；已补充原生依赖安装说明，并通过本机 `pnpm install --frozen-lockfile` 与完整应用构建验证。
2. 配置面板不自动创建主配置；缺少 `synthos_config.json`、JSON 无效或模型引用无效时返回并展示明确错误。
3. `ai.models`、`ai.defaultModelName`、`ai.pinnedModels`、`groupConfigs.*.aiModels`、`report.generation.aiModels` 已加入交叉校验。
4. `reasoning` 默认关闭，只有模型配置显式启用时才透传给 `ChatOpenAI`。
5. QQ 原库对账会写入最近扫描状态，WebUI 新增 `/api/setup-status` 与空态提示。
6. 启动脚本已把 orchestrator 放到 worker 后面，orchestrator 启动时会等待 Pipeline worker 注册完成。
7. Ollama embedding 检查已从“服务可达”升级为“服务可达且配置模型存在”。
8. README、示例配置与 API 文档已同步更新。

下文保留原始审查内容，作为问题来源和证据记录。

## 总体判断

这个项目目前对作者本人本地环境是可用的，但对“别人 clone 后直接跑起来”仍有几类高风险问题：

1. **安装环境风险仍然偏高**

   特别是 Windows + Node 24 + `@journeyapps/sqlcipher` / `better-sqlite3` 这类 native 依赖，README 只简单提示 VS Build Tools，不足以覆盖实际失败场景。

2. **配置体验不够开箱即用**

   配置面板看起来能可视化编辑，但实际启动配置面板前仍要求存在完整且通过 schema 的 `synthos_config.json`。新用户如果还没配好模型、QQ 数据库路径、`dbKey`，可能连配置面板都进不去。

3. **模型配置容易“看起来配置了，实际跑不起来”**

   目前 `ai.models`、`pinnedModels`、`groupConfigs.*.aiModels` 之间没有交叉校验。用户填错模型名时不会在配置阶段报错，而是在运行 LLM 时才失败。

4. **新群导入 / 历史消息回填仍有边界问题**

   已经有 source 对账和历史 preprocessing backfill，但回填是分批渐进的，并且新群加入后是否能完整抓历史，依赖 `dataSeekTimeWindowInHours`、已有最新消息、source reconcile 光标等组合行为。对用户来说不透明。

5. **启动顺序和流水线就绪提示存在误导**

   orchestrator 注释说应在任务处理器之后启动，但启动脚本实际把 orchestrator 放在最前面。虽然 Agenda 可能最终等到 worker 接手，但首次启动体验会出现“看起来启动了，但流水线任务在等 worker”的不确定性。

---

## P1：高优先级问题

### P1-001：推荐 Node v24.5.0 可能放大 native 依赖安装失败

#### 证据

- `.nvmrc:1`

  ```text
  v24.5.0
  ```

- `README.md:102-103`

  ```text
  Node.js ≥ v20（推荐 v24.5.0）
  ```

- `applications/data-provider/package.json:16`

  ```json
  "@journeyapps/sqlcipher": "^5.3.1"
  ```

- `applications/ai-model/package.json:16-25`

  ```json
  "@journeyapps/sqlcipher": "^5.3.1",
  "better-sqlite3": "^12.10.0",
  "sqlite-vec": "^0.1.6"
  ```

- `docs/bug/bug3.md:87-89` 已记录过实际问题：

  ```text
  pnpm install --frozen-lockfile 在 Windows / Node.js 24.5.0 下被 @journeyapps/sqlcipher postinstall 的 Completion callback never invoked 阻断
  ```

#### 影响

开源用户按 README 推荐使用 Node 24.5.0，可能在 `pnpm install` 阶段直接失败。用户看到的是 native build / postinstall 异常，不知道是 Node 版本、VS 工具链、Python、还是包本身的问题。

这和你提到的“别人用了项目，说那几个模型跑不起来 / 配置环境有问题 / VS2022 工具链问题”高度相关。

#### 最小修复建议

1. README 把推荐版本改成当前验证最稳的 LTS，例如 Node 22，而不是 Node 24。
2. `.nvmrc` 同步改为稳定 LTS。
3. 在 README FAQ 增加明确矩阵：

   | 平台        | 推荐 Node  | 需要 VS Build Tools | native 依赖风险                         |
   | ----------- | ---------- | ------------------- | --------------------------------------- |
   | Windows x64 | Node 22 LTS | 是                  | `@journeyapps/sqlcipher`, `better-sqlite3` |
   | macOS ARM   | Node 22 LTS | 否 / Xcode CLI      | VFS dylib 路径                          |
   | Linux       | Node 22 LTS | `build-essential`   | data-provider 不支持                    |

4. 如果必须支持 Node 24，需要单独验证 `@journeyapps/sqlcipher` postinstall，并在文档中写清楚失败处理方式。

---

### P1-002：配置面板并不能真正解决“从零配置”问题，启动前仍要求完整有效配置

#### 证据

- `ConfigManagerService.ts:80-112`

  ```ts
  const configPath = await this.configPath;
  ASSERT(configPath, "未找到配置文件");

  const configContent = await readFile(configPath, "utf8");
  const baseConfig = JSON.parse(configContent);

  const mergedConfig = deepMerge(baseConfig, overrideConfig);

  const parsed = GlobalConfigSchema.safeParse(mergedConfig);

  if (!parsed.success) {
      throw new Error(`配置文件schema完整性校验失败:\n${errors}`);
  }
  ```

- `README.md:155`

  ```text
  你也可以使用 配置面板（pnpm dev:config）在 WebUI 中可视化编辑配置，无需手动编辑 JSON。
  ```

- `applications/webui-backend/src/configPanelIndex.ts` 未读，但从 `ConfigController` / `ConfigService` 看，配置面板仍依赖 `ConfigManagerService.getCurrentRawConfig()`。

#### 影响

新用户如果还没有创建 `synthos_config.json`，或者配置里 `baseURL`、`report`、`email`、`dataProviders.QQ` 等字段不完整，后端服务会在配置读取阶段失败，导致配置面板打不开。

这和 README 传达的“可以用配置面板可视化编辑，无需手动编辑 JSON”不一致。

#### 最小修复建议

1. 配置面板模式下允许没有 `synthos_config.json` 时自动读取 `synthos_config.example.json` 作为初始草稿。
2. 配置面板模式下不要强制 `GlobalConfigSchema` 全量校验才能进入页面；应允许加载草稿，并在保存时校验。
3. README 改成更准确的话：

   > 首次使用仍需复制 `synthos_config.example.json`；配置面板可用于后续可视化修改。若配置文件缺失或 JSON 格式错误，配置面板也无法启动。

---

### P1-004：OpenAI 兼容模型强制传 `reasoning.effort = "minimal"`，部分供应商 / 模型可能不支持

#### 证据

- `TextGeneratorService.ts:95-107`

  ```ts
  const chatModel = new ChatOpenAI({
      ...
      model: modelName,
      temperature: ...,
      maxTokens: ...,
      reasoning: {
          effort: "minimal"
      }
  });
  ```

- `TextGeneratorService.ts:763-779`

  ```ts
  const chatModel = new ChatOpenAI({
      ...
      reasoning: {
          effort: "minimal"
      }
  });
  ```

- `TextGeneratorService.ts:814-831`

  ```ts
  let chatModel = new ChatOpenAI({
      ...
      reasoning: {
          effort: "minimal"
      }
  });
  ```

#### 问题

README 说兼容任何 OpenAI 兼容 API：

- DeepSeek
- MIMO
- 通义千问
- GLM
- 等等

但实际所有 `ChatOpenAI` 实例都固定带：

```ts
reasoning: { effort: "minimal" }
```

很多 OpenAI-compatible 网关不一定接受这个字段，尤其是非 OpenAI 官方 reasoning 模型。某些供应商可能返回 400、unknown parameter、unsupported field。

#### 影响

用户会遇到“同一个 key/baseURL 在其他工具能跑，在 Synthos 跑不起来”的问题。

#### 最小修复建议

1. 把 reasoning 配置放入 `ModelConfigSchema`，默认关闭。
2. 只有明确配置支持 reasoning 的模型才传。
3. 或者增加供应商兼容模式：

   ```json
   "reasoning": {
     "enabled": false,
     "effort": "minimal"
   }
   ```

4. README 明确说明哪些模型支持，哪些不支持。

---

### P1-005：新群加入后的历史抓取行为对用户不透明，可能以为“没有抓历史消息”

#### 证据

- `orchestrator/index.ts:77`

  ```ts
  startTimeStamp: -1,
  ```

- `ProvideDataTask.ts:89-98`

  ```ts
  if (attrs.startTimeStamp < 0) {
      const newestMsg = await this.imDbAccessService.getNewestRawChatMessageByGroupId(groupId);
      const startTimeStamp = newestMsg ? newestMsg.timestamp - 1000 : 0;

      results = await activeProvider.getMsgByTimeRange(
          startTimeStamp,
          attrs.endTimeStamp,
          groupId
      );
  }
  ```

- `ProvideDataTask.ts:109-110`

  ```ts
  await this._reconcileQQSourceMessages(activeProvider, qqSourceCursorStore, groupId);
  ```

- `dataProviders.QQ.sourceReconcile.batchSize`

  ```json
  {
    "sourceReconcile": { "batchSize": 50000 }
  }
  ```

#### 问题

新群第一次导入时，如果库里没有该群消息，会从 timestamp 0 开始抓；这理论上可以抓历史。

后续 source reconcile 每轮扫描条数由 `dataProviders.QQ.sourceReconcile.batchSize` 控制；已落库但尚未分配 `sessionId` 的历史消息，每轮预处理回填候选数量由 `preprocessors.historicalBackfill.messageLimit` 控制。对很多大群来说，历史消息可能需要很多轮 pipeline 才补完。用户看到前端可能短时间内只有部分数据，会认为“历史信息没有去抓捕”。

#### 影响

- 新群导入后，历史数据不是即时完整；
- WebUI 启动状态提示会展示最近 QQ 原库回填状态；
- 没有日志汇总告诉用户“当前已扫描到哪里，还剩多少未知”。

#### 当前处理

1. `/api/setup-status` 和 WebUI 启动状态提示展示 QQ 原库回填状态：
   - 当前群号；
   - 当前 cursor；
   - 本轮扫描条数；
   - 缺失补入条数；
   - 是否 reachedEnd。
2. 配置面板通过 schema 暴露 `dataProviders.QQ.sourceReconcile.batchSize` 和 `preprocessors.historicalBackfill.messageLimit`。
3. README 明确说明：大群历史消息不是一次完成，两个回填批大小均可在配置面板调整。

---

## P2：中优先级问题

### P2-001：README 的 Windows native 依赖故障处理过于简略

#### 证据

- `README.md:480-494`

  ```text
  pnpm install 失败（Windows）

  better-sqlite3 等原生模块需要编译，确保已安装 Visual Studio Build Tools：

  npm config set python python3
  ```

#### 问题

这里没有覆盖实际关键点：

- Visual Studio Build Tools 需要 C++ 桌面开发工作负载；
- 需要 MSVC、Windows SDK；
- Python 版本；
- Node 版本；
- `@journeyapps/sqlcipher` 也会触发 native 相关问题；
- `pnpm approve-builds` / `onlyBuiltDependencies` 相关行为；
- Node 24 的已知失败。

#### 影响

用户遇到安装失败时，只能靠猜。你提到的“VS2022 控制链 / 二进制 / native 编译”就是这个问题。

#### 最小修复建议

README 增加专门章节：

```markdown
### Windows native 依赖安装失败排查
```

推荐环境：

- Node.js 22 LTS
- pnpm 10.15.0
- Python 3.11+
- Visual Studio Build Tools 2022
  - Desktop development with C++
  - MSVC v143
  - Windows 10/11 SDK

验证命令：

```bash
node -v
pnpm -v
python --version
npm config get msvs_version
```

并列出常见错误到解决方法。

---

### P2-002：QQ 数据库路径和 VFS 插件路径对 Docker 用户存在误导

#### 证据

- `docker-compose.yml:121-135`

  ```text
  data-provider cannot be containerized because it needs access to the host's local
  QQ NT database files + a platform-specific VFS plugin.
  ```

- `README.md:276`

  ```text
  Docker 部署（不成熟）
  ```

- `README.md:334`

  ```text
  data-provider 无法在容器中运行，请在宿主机通过 pnpm --filter data-provider dev 单独启动
  ```

#### 问题

Docker Compose 可以启动后端、前端、AI，但 QQ 自动拉取必须宿主机额外启动。这个分裂模式对用户来说很容易误解：

- `docker compose up` 后 WebUI 能打开；
- 但没有 QQ 数据；
- 用户不知道还要宿主机启动 data-provider；
- 宿主机 data-provider 还要连 Docker MongoDB。

#### 影响

开源用户可能认为 Docker 部署“跑起来了但没数据”。

#### 最小修复建议

1. Docker README 单独标红：
   - Docker 模式默认不抓 QQ 数据；
   - 必须宿主机启动 data-provider；
   - 必须设置 `SYNTHOS_MONGODB_URL=mongodb://localhost:27017/synthos`。
2. WebUI 空数据页面提示：
   - 当前没有消息；
   - 是否已启动 data-provider；
   - 是否已配置群号；
   - 是否完成 QQ `dbKey`。
3. 提供一条宿主机启动命令：

   ```powershell
   $env:SYNTHOS_CONFIG_PATH="D:\...\docker\config\synthos_config.json"
   $env:SYNTHOS_MONGODB_URL="mongodb://localhost:27017/synthos"
   pnpm --filter data-provider dev
   ```

---

### P2-003：Embedding 模型未安装时，只跳过任务，没有前端可见提示

#### 证据

- `GenerateEmbedding.ts:53-58`

  ```ts
  if (!(await this.embeddingService.isAvailable())) {
      this.LOGGER.error("Ollama 服务不可用，跳过当前任务");
      return;
  }
  ```

- `EmbeddingService.ts:113-120`

  ```ts
  async isAvailable(): Promise<boolean> {
      try {
          await this.client.get("/api/tags");
          return true;
      } catch {
          return false;
      }
  }
  ```

#### 问题

这里只检查 Ollama 服务是否可用，不检查 `bge-m3` 是否真的已 pull。若 Ollama 运行但模型未安装，实际 embed 时才失败。

#### 影响

用户会遇到：

- 摘要可能生成了；
- 搜索 / RAG 没结果；
- 日志里有批次失败；
- WebUI 没有明确告诉“bge-m3 未安装”。

#### 最小修复建议

1. `isAvailable()` 增加模型存在检查，确认 `/api/tags` 中是否包含配置模型。
2. WebUI 系统状态或空状态提示：
   - Ollama 是否可达；
   - embedding model 是否存在；
   - 向量库 topic 数。
3. README 增加验证命令：

   ```bash
   ollama list
   ollama pull bge-m3
   curl http://localhost:11434/api/tags
   ```

---

## P3：低优先级 / 体验问题

### P3-001：README 快速开始里的仓库地址仍是占位符（已修复）

#### 原证据

- `README.md:21-24`

  ```bash
  git clone https://github.com/<your-org>/synthos.git
  cd synthos
  ```

#### 影响

开源用户直接复制会失败。

#### 建议

改成真实仓库地址。

#### 修复

已改为 `https://github.com/Will-hxw/synthos.git`。

---

### P3-002：项目截图使用 Windows 反斜杠路径，GitHub Markdown 跨平台显示可能不稳定（已修复）

#### 原证据

- `README.md:49-50`

  ```html
  <img src="docs\assets\前端白色.png">
  <img src="docs\assets\前端暗黑.png">
  ```

#### 建议

改成：

```html
<img src="docs/assets/前端白色.png">
```

#### 修复

已将根 README 中的项目截图路径统一改为正斜杠路径。

---

### P3-003：配置保存提示与实际行为不一致（已修复）

#### 原证据

- `ConfigController.ts:96-100`

  ```ts
  message: "配置保存成功，请手动重启服务以使配置生效"
  ```

- `config.tsx:433-434`

  ```ts
  Notification.success({ title: "保存成功", description: "基础配置已成功更新" });
  ```

#### 问题

后端提醒要重启，前端提示只是保存成功，没有强调重启。

#### 影响

用户保存模型或群号后，以为立即生效；实际多个服务已缓存配置或初始化服务，需要重启才稳定生效。

#### 建议

前端保存成功提示明确写：

> 配置已保存。请重启相关服务后生效。

#### 修复

已统一 `POST /api/config/base`、`POST /api/config/override` 和前端保存成功提示文案，保存配置后明确提醒需要重启相关服务。
