# Synthos - Bug 审查报告（第三轮，已处理）

更新时间：2026-06-02

本轮对原报告中的高严重度、中严重度和低严重度条目逐项复核。除已在前序 bug2 中修复或确认无需修改的条目外，其余需要处理的问题均已完成最小范围修复，并补充了与风险匹配的定向测试。

---

## 一、高严重度

| 编号 | 状态 | 处理结果 |
|------|------|----------|
| H1 | 已修复 | `GenerateEmbedding` 与 `VectorDBManagerService.filterWithoutEmbedding` 对 topicId 去重，避免重复嵌入同一 topic。 |
| H2 | 已修复 | `EmbeddingService` 和 `VectorDBManagerService` 增加 NaN/Infinity 校验，拒绝非法向量写入。 |
| H3 | 已修复 | `ReportService.checkReadStatus` 改为并发读取，避免逐条串行 KVStore N+1 等待。 |
| H4 | 已修复 | `SystemMonitorController` 统一返回 `{ success, data }`；`SystemMonitorService.getStatsHistory` 返回数组副本，避免暴露内部可变引用。 |
| H5 | 已修复 | `SemanticRater` 改为循环求最大相似度，不再对大数组使用 `Math.max(...arr)`。 |
| H6 | 已修复 | `LLMInterestEvaluationAndNotification` 的 KV get/put/del 改为批内并发执行。 |
| H7 | 已修复 | `GenerateReport` 不再 dispose DI 注入的 `TextGeneratorService` 单例。 |

---

## 二、中严重度

| 编号 | 状态 | 处理结果 |
|------|------|----------|
| M1 | 已修复 | `QQProvider.getMsgByTimeRange` 的 groupId 条件改为 SQL 参数绑定。 |
| M2 | 已修复 | 正文为空但引用内容有效的消息不再被静默丢弃。 |
| M3 | 已修复 | `ImDbAccessService.getSessionTimeDuration` 直接读取聚合查询结果，去掉无意义数组展开。 |
| M4 | 已确认 | `ChatMessageService.getSessionTimeDurations` 已在 bug2 修复为批量化，无需本轮修改。 |
| M5 | 已修复 | Agent SSE 并发拒绝返回 `event:error` 帧；前端非 2xx event-stream 错误可解析 `code/error`。 |
| M6 | 已修复 | `LogsService.nextBefore` 不再执行 `timestamp - 1`，避免分页游标额外收缩。 |
| M7 | 已修复 | `AgentChat` 仅在消息数量变化时触发通用自动滚动，流式 token 刷新时由 RAF 合并路径按需滚动。 |
| M8 | 已修复 | `useAskState` 使用 RAF 合并 content chunk，降低长回答时的 React 重渲染和 Markdown 重解析频率。 |
| M9 | 已修复 | `ResponsivePopover` 将 `setViewportScale` 移入 `useEffect`。 |
| M10 | 已修复 | ai-chat 的 `useTopicStatus` 收藏/已读操作调用后端 API 持久化，并在失败时回滚本地状态。 |
| M11 | 已修复 | `latest-topics` 过滤视图下标记已读/取消收藏后不再先乐观删除再回填，避免条目闪烁回弹。 |
| M12 | 已修复 | tRPC WebSocket 客户端增加 `retryDelayMs` 指数退避重连配置。 |
| M13 | 已修复 | `SearchInputBar` 移除 `parseInt(...) || 10`，非法输入不再静默改写为 10，合法值限制在 1-50。 |
| M14 | 已修复 | `NumberInput` 支持临时清空输入框，不再用 `NaN || 0` 立即归零。 |
| M15 | 已修复 | `ai-digest` 未实现的导出按钮改为禁用状态，避免点击无反馈。 |
| M16 | 已修复 | `getAgentConversationsPage` 改为复用 `getAgentConversations`，删除重复请求实现。 |
| M17 | 已修复 | QQ 群头像和用户头像 URL 改为 HTTPS。 |
| M18 | 已修复 | `useSemanticSearch` 增加 AbortController，避免旧搜索结果覆盖新搜索。 |
| M19 | 已修复 | `reports` 打开详情弹窗时不再先展示列表级摘要数据，等待详情接口返回后再填充。 |

---

## 三、低严重度

| 条目 | 状态 | 处理结果 |
|------|------|----------|
| `formatBytes` 负数输入 | 已修复 | 非有限数和非正数统一返回 `0 B`。 |
| `SessionItem.formatTime` 跨年日期 | 已修复 | 旧会话日期展示包含年份。 |
| `TopicPopover.handleOpenChange` 非 memoized | 已修复 | `loadTopicDetail` 与 `handleOpenChange` 均改为 `useCallback`。 |
| `AgentChat.toolTraces` 大体积渲染 | 已修复 | 限制工具记录数量，并截断超长 args/result 文本。 |
| `generateColorFromInterestScore` 不限范围 | 已修复 | hue 计算前 clamp 到稳定范围。 |
| `AskPanel.handleSaveAsImage` 手动改 DOM style | 已修复 | 改用 dom-to-image 的 clone style 配置，不直接修改真实 DOM。 |
| `EnhancedDetail.names.indexOf` 线性查找 | 已修复 | 改用 `Set` 判断参与者名称。 |
| `baseUrl` 仅识别 localhost | 已修复 | 覆盖 `localhost`、`127.0.0.1`、`0.0.0.0`、`::1` 和 Vite 3011 直连场景。 |
| `ChatHistorySidebar.loadSessions` 依赖 `sessions.length` | 已修复 | 使用 ref 记录当前长度，避免 callback 随追加重建。 |
| `TypingText` 依赖内联 `onComplete` | 已修复 | 使用 ref 保存最新回调，打字 effect 不再受父组件内联函数影响。 |
| `AISummarize.ts` 并行度日志 | 已确认 | 已在前序修复为动态读取 `maxConcurrentRequests`。 |
| `SystemMonitorService.getStatsHistory` 可变引用 | 已修复 | 与 H4 一并修复为返回数组副本。 |
| `PromisifiedSQLite` 写事务串行化 | 已确认 | bug2 已通过 `AgcDbAccessService.runExclusive` 修复相关写事务串行化问题。 |
| `GenerateReport.ts dispose` | 已修复 | 与 H7 一并处理。 |

---

## 四、验证记录

- TypeScript 检查通过：
  - `node C:\Users\HuaXW\.codex\worktrees\2e69\synthos\node_modules\.pnpm\typescript@5.9.3\node_modules\typescript\bin\tsc --noEmit`（`applications/ai-model`）
  - `node C:\Users\HuaXW\.codex\worktrees\2e69\synthos\node_modules\.pnpm\typescript@5.9.3\node_modules\typescript\bin\tsc --noEmit`（`applications/webui-backend`）
  - `node C:\Users\HuaXW\.codex\worktrees\2e69\synthos\node_modules\.pnpm\typescript@5.9.3\node_modules\typescript\bin\tsc --noEmit`（`applications/data-provider`）
  - `node C:\Users\HuaXW\.codex\worktrees\2e69\synthos\node_modules\.pnpm\typescript@5.9.3\node_modules\typescript\bin\tsc --noEmit`（`applications/webui-frontend`）
- 定向测试通过：
  - `OllamaEmbeddingService.test.ts`
  - `SemanticRater.test.ts`
  - `LLMInterestEvaluationAndNotification.test.ts`
  - `VectorDBManager.test.ts`
  - `AgentController.test.ts`
  - `QQProvider.unit.test.ts`
- 代码格式检查通过：
  - `git diff --check`

## 五、验证限制

- `pnpm install --frozen-lockfile` 在 Windows / Node.js 24.5.0 下被 `@journeyapps/sqlcipher` postinstall 的 `Completion callback never invoked` 阻断，但依赖已足够完成上述 TypeScript 与 Vitest 定向验证。
- 根目录 `common` 的整体 `tsc --build common/tsconfig.json` 仍暴露多处既有 strict/nullability 类型问题，本轮未扩大范围修复这些无关历史问题。
