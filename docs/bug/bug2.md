# Synthos — 全面 Bug 审查报告

---

## 二、高严重度（影响数据完整性 / 系统性丢数据）

### H1. QQ 引用消息解析空指针，一条坏数据可让整批入库崩溃 [已核验]

`applications/data-provider/src/providers/QQProvider/QQProvider.ts:542-559`

- `parseMessageSegment(extraData).extraMessage.messages`：protobufjs `toObject(defaults:true)` 对缺失的 message 字段会置为 null。当某条 REPLY 消息的 `extraData` 能解码、但不含 `extraMessage` 子消息时，`.extraMessage.messages` 抛 TypeError。
- catch 只吞 `PROTOBUF_ERROR`/`EMPTY_VALUE_ERROR`，TypeError 走 `throw error`（:557）→ 冒泡出 `getMsgByTimeRange` → ProvideData 任务失败 → 整个 Pipeline 终止。
- 即一条畸形引用消息就能阻断该群（乃至整轮）消息摄取。类别 1。

### H2. ProvideData 缺 try/finally，失败时泄漏 sqlcipher 连接 [已核验]

`applications/data-provider/src/tasks/ProvideDataTask.ts:63-92`

- `activeProvider.init()` 打开加密 DB，`dispose()` 仅在循环正常结束后（:92）调用；中途任何抛错（如 H1）都跳过 dispose。
- QQProvider 是非单例（每轮新实例），若坏数据长期处于 24h 窗口，则每轮 Pipeline 都泄漏一个打开的数据库连接，长期累积句柄泄漏。与 H1 叠加放大。类别 1/2。

### H3. AISummarize 并发回调中事务交错，丢 session 摘要 [已核验]

`AISummarize.ts:181-234` + `common/services/database/AgcDbAccessService.ts:197-232` + `common/util/promisify/PromisifiedSQLite.ts`

- `submitTasks` 以 `config.ai.maxConcurrentRequests` 并发，每个回调 `await storeAIDigestResults()`，内部裸 `BEGIN IMMEDIATE … COMMIT`。
- `PromisifiedSQLite` 无应用层串行队列（已通读确认），且 Im/Agc/... 多个服务共用同一个 `common_database.db` 连接（CommonDBService）。并发回调 A 的事务未 COMMIT 时，回调 B 的 `BEGIN IMMEDIATE` 在同一连接上触发 "cannot start a transaction within a transaction" → B 抛错被 :228 吞掉 → 该 session 摘要丢失。并发度越高丢得越多。类别 1。

### H4. 空话题结果导致 session 永久"未摘要"，无限重复调用 LLM [已核验]

`AISummarize.ts:203-226` + `AgcDbAccessService.storeAIDigestResults`（空数组直接 return）+ `ImDbAccessService.getUnsummarizedSessionStatsByGroupId`

- 提示词允许 LLM 对"无价值话题"返回 `[]`（合法）。但 `[]` 不写任何行，而"是否已摘要"靠 `ai_digest_results` 是否存在该 sessionId 的行判断 → 该 session 永远算未摘要。
- 每轮都会被 `getUnsummarizedSessionStatsByGroupId`（LIMIT 10）重新捞起、重建上下文、重新调 LLM，永不收敛。还会持续占用回填配额，挤掉真正需要处理的 session。类别 1/2。
- 附带：`if (resultStr.length < 30)` 短长度判断位于 `JSON.parse` 之后（:204），逻辑顺序错误，且判的是 JSON 串长度而非摘要正文长度。

### H5. 向量库默认 L2 距离，relevance 按 cosine 公式算 → 展示相关性几乎恒为 0 [已核验]

`applications/ai-model/src/services/embedding/VectorDBManagerService.ts:70-74`（建表未指定 `distance_metric`，sqlite-vec 默认 L2）+ `applications/ai-model/src/rag/RagRPCImpl.ts:193,260`

- `relevance = Math.max(0, 1 - (r.distance ?? 1))` 只对 cosine 距离成立。bge-m3 向量已 L2 归一化，其 L2 距离 ∈ [0,2]，相似文本常 >1 → relevance 被 clamp 成 0。
- topK 排序因 L2 与 cosine 对归一化向量单调一致仍正确，但对用户展示的"相关性"数值失真。系重构（旧版用 `vec_distance_cosine`，新版改隐式 MATCH k）引入的回归。类别 3/4。

### H8. webui getSessionTimeDurations 逐条查询（N+1）

`applications/webui-backend/src/services/ChatMessageService.ts:34-48`

- 对 sessionIds 数组逐个 `await getSessionTimeDuration`，而 `ImDbAccessService` 无批量版本（同文件其他统计均已批量化）。sessionIds 多时大量串行 DB 往返，拖慢消息查询接口。类别 2。

---

## 三、中严重度

| 编号 | 位置 | 问题 | 类别 |
|------|------|------|------|
| M1 | `LLMInterestEvaluationAndNotification.ts` / `SemanticRater.ts:140` / `EmbeddingService.ts:56-77` | `embedBatch` 不校验"返回向量条数 == 输入条数"，Ollama 少返回一条会使 scores 错位、写入 undefined/NaN 分数 | 1/3 |
| M2 | `AISummarize.ts:219` | `contributors` 缺失时 `JSON.stringify(undefined)` 写入字面 `undefined` 污染库（H6 的源头之一） | 1/3 |
| M3 | `TextGeneratorService.ts:316-343` | JSON 校验/修复只 `JSON.parse` 不校验"必须为数组且字段齐全"，`{}`/`{"error":...}` 也通过，下游产脏数据/空写 | 1 |
| M4 | `GenerateEmbedding.ts:108-112` vs `RagRPCImpl.ts:92-94` | 存储用裸文本、检索查询额外加英文 Instruct 前缀且领域硬编码（CS/AI/university），query/passage 嵌入不对称，降低召回 | 3 |
| M5 | `RagRPCImpl.ts:106-118` / `:144-149,225-229` | RAG search 逐条查 digest（N+1）；Multi-Query 多次 search 完全串行（本可 `Promise.all`），放大首字延迟 | 2 |
| M6 | `QueryRewriter.ts:50-52` + `RagRPCImpl.ts:135-153` | 查询重写失败直接中断 ask，未降级回原始查询 | 1/4 |
| M7 | `ReportService.ts:53-70` | 日报详情逐个 topicId 查 digest（N+1） | 2 |
| M8 | `webui-backend ChatMessageController.ts:23-32` + `schemas/index.ts:43` | chat-messages 的 timeStart/timeEnd 仅 `z.string()`，`parseInt` 得 NaN 静默查空，无校验（其他接口用 UnixMsSchema） | 1 |
| M9 | `AgentController.ts:50-63` | SSE 端点并发 409 用 `res.json` 返回普通 JSON，与 `event:error` SSE 帧结构不一致，前端按流解析会失败/无反馈 | 4 |
| M10 | `AgentController.ts:82-142` | SSE 无整体超时，上游 tRPC 卡死则心跳无限发、连接永不结束、conversationId 锁不释放 → 后续一直 409 | 4 |
| M11 | `webui-frontend groups.tsx:82-227,277-322` | ECharts 实例无 dispose 清理（卸载泄漏）、排序后图表不重渲染导致"走势图与群号错位"、无 resize 自适应 | 2/3 |
| M12 | `webui-frontend AgentChat.tsx:131-140` + `MarkdownRenderer.tsx` | 每个流式 token 都触发 smooth 滚动且无"用户上滑则不跟随"判断；AgentMessageItem/MarkdownRenderer 未 memo，每 token 整列表重解析 Markdown → 抖动+卡顿 | 2/4 |
| M13 | `latest-topics.tsx:350-370,624-668` | 标记已读/收藏"乐观删除 + 立即整页重拉"产生闪烁；最后一页整页标已读会先渲染空页再纠正 | 1/4 |
| M14 | `inputs/AskInputBar.tsx:51` | Top-K `parseInt(v)||100`：删空/非法输入瞬间跳成 100，无法顺畅改小 | 3/4 |
| M15 | `reportScheduler.ts:32-34` [已核验] | `calculateHalfDailyTimeRange` 的 `findIndex` 用 `parseTimeStr(t).hour === triggerTime.getHours()` 兜底，同小时多个时间点（如 08:00/08:30）会错配到第一个，半日报时间范围算错 | 1/3 |

---

## 四、低严重度（健壮性 / 轻微体验，择机处理）

- `AISummarize.ts:176`：日志硬编码"并行度=5"，实际取 `maxConcurrentRequests`，误导运维。类别 4。
- `AISummarize.ts:290` / `ImDbAccessService.ts:257`：`Math.max(...arr)` 超大 session 有参数展开 RangeError 风险，建议 reduce。类别 1。
- `GenerateEmbedding.ts:71-93,116-131`：`allTopicIds` 未对 topicId 去重 → 重复 topic 二次嵌入；批内单条坏向量使整批 10 条全跳过（靠下轮增量重试，不丢但低效）。类别 1/2。
- `QQProvider.ts:540` `ASSERT(!!replyMsgSeq)`：REPLY 消息若 `replyMsgSeq` 为 0 触发 fatal assert，崩整批（与 H1 同类脆弱）。类别 1。
- QQProvider 消息体为空即整条丢弃（:575-582）：纯不支持元素/空 emojiText 的消息被丢，session 内可能缺消息。类别 3。
- InterestEvaluation/ReportService 多处 KV 逐条 `await`（`LLMInterest…:211-258`、`ReportService.ts:154-162`）：本可 `Promise.all`。类别 2。
- `SystemMonitorController.ts:13,19` / `Service.ts:28-30`：返回裸对象破坏全局 `{success,data}` 约定；history 返回内部可变数组引用且无分页。类别 2/4。
- `LogsService.ts:48-91`：同毫秒日志跨分页边界 `nextBefore = oldest.timestamp - 1` 可能漏读同戳剩余行。类别 1。
- `EnhancedDetail.tsx:21-22`：contributors 为空时 `new RegExp("()")` 退化为大量空匹配，长 detail 有无谓开销。类别 2。
- 前端 409 无专门提示、ask 流式结果区无自动跟随滚动（`ai-chat.tsx:365-391`）、agentTrpcClient WS 单例无重连。类别 4/1。

---

## 五、死代码 / 清理项（非运行期 bug）

- `applications/data-provider/src/providers/QQProvider/parsers/parseMsgContentFromPB.ts` 整文件已废弃且仅自引用（活跃解析器是 MessagePBParser）；其 V2 内 `i>0` 才追加逗号，导致 `A B, C,` 式错位拼接——但不被任何地方调用，无运行期影响，建议删除。
- `QQProvider._getMsgIdByGroupNumberAndMsgSeq` / `_getMsgByMsgId` 未被引用（已改为直接解析 extraData）。
