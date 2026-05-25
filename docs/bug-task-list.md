# Bug Task 清单

生成时间：2026-05-25

## 范围说明

本清单只覆盖功能正确性、性能效率、结果准确度和交互体验问题。安全、权限、泄露、敏感信息、成本控制类问题不纳入本清单。

状态约定：

- `待处理`：已确认需要进入修复队列。
- `待复现`：已有用户现象或代码风险，需要修复前补充运行态复现。
- `已验证`：修复后需要满足的验收标准。

优先级约定：

- `P1`：会导致核心功能错误、明显卡顿、错误结果或任务无法自动恢复。
- `P2`：会影响重要功能体验、准确度或中长期性能。
- `P3`：局部交互、易用性、维护体验或低频路径问题。

## 总览

| ID | 优先级 | 状态 | 模块 | 问题摘要 |
| --- | --- | --- | --- | --- |
| BUG-001 | P1 | 待处理 | 最新话题 | `/latest-topics` 查询链路在后端全量取数后内存过滤、排序、分页，且逐条查已读/收藏，导致页面慢 |
| BUG-002 | P1 | 待处理 | 报告生成 | 日报/周报按摘要更新时间过滤 topic，导致报告时间范围不准确 |
| BUG-003 | P1 | 待处理 | 报告生成 | `pending`/`failed` 报告会永久阻止同周期自动重试 |
| BUG-004 | P1 | 待处理 | 兴趣分 | 兴趣分读取把 `0` 当缺失，且无法正确读取非 V1 分数 |
| BUG-005 | P1 | 待处理 | 报告统计 | 报告用随机 `sessionId` 猜 `groupId`，群统计不可信 |
| BUG-006 | P1 | 待处理 | 前端路由 | 去除首页、聊天记录、系统监控相关前端页面入口和路由 |
| BUG-007 | P1 | 待复现 | AI 聊天 | `/ai-chat` 三个 tab URL/按钮切换不稳定，出现切换失败或页面抖动 |
| BUG-008 | P2 | 待处理 | Agent | 取消/切换会话没有真正中止 ai-model 执行，可能写入过期回复 |
| BUG-009 | P2 | 待处理 | 最新话题 | `endDate` 只包含当天 00:00，用户语义上应包含整天 |
| BUG-010 | P2 | 待处理 | AI 流水线 | 多处 group/session/topic 串行 DB 查询和逐条写入，数据稍多会拖慢任务 |
| BUG-011 | P2 | 待处理 | 数据接入/摘要 | 图片、语音、文件消息多数只是占位符，影响总结和搜索准确度 |
| BUG-012 | P2 | 待处理 | 配置页 | `/config` 左侧导航栏太短，需要拉长，避免用户额外滚动导航栏 |
| BUG-013 | P3 | 待处理 | 前端构建 | 主 chunk 过大，首屏加载体验差 |
| BUG-014 | P3 | 待处理 | 报告页 | 报告页 URL 深链分页可能被初始化副作用重置 |
| BUG-015 | P3 | 待处理 | AI 聊天 | 侧边栏“分享/导出”按钮是空功能 |

## BUG-001 `/latest-topics` 查询链路过重

优先级：P1

状态：待处理

### 问题现象

访问 `http://localhost:3011/latest-topics` 或带时间范围的 URL 时，即使最终只有几百条 topic，页面仍可能长时间转圈。

### 证据位置

- `applications/webui-backend/src/services/LatestTopicsService.ts:37`：先取时间范围内全部 records。
- `applications/webui-backend/src/services/LatestTopicsService.ts:43`：搜索在内存中执行。
- `applications/webui-backend/src/services/LatestTopicsService.ts:63`：排序在内存中执行。
- `applications/webui-backend/src/services/LatestTopicsService.ts:65`：分页在内存中执行。
- `applications/webui-backend/src/services/TopicStatusService.ts:35`：收藏状态逐条查询。
- `applications/webui-backend/src/services/TopicStatusService.ts:61`：已读状态逐条查询。

### 期望行为

页面首屏应只查询当前页所需数据；总数、搜索、排序、筛选、分页应尽量由数据库或批量查询完成。

### 建议修复

1. 在 `AgcDbAccessService` 增加面向最新话题页的分页查询接口。
2. 将时间范围、groupId、搜索、已读/收藏筛选、排序、limit/offset 下推到数据库或批量状态读取。
3. 为 `TopicStatusService` 增加批量读取实现，避免逐条 await。
4. 保留返回结构不变，避免破坏前端契约。

### 验收标准

- 全时间范围、一天范围、多年范围均能稳定快速返回。
- `filterRead`、`filterFavorite`、`sortByInterest`、`search`、`groupId` 与当前语义一致。
- 后端不再为了返回 3 条数据加载全量 records 后分页。
- 增加覆盖分页、筛选、搜索、排序组合的测试。

## BUG-002 报告生成时间范围使用摘要更新时间

优先级：P1

状态：待处理

### 问题现象

日报/周报可能把不属于该时间段的聊天 topic 纳入报告，或者漏掉实际发生在该时间段的 topic。

### 证据位置

- `applications/ai-model/src/tasks/GenerateReport.ts:77`：`selectAll()` 读取全部摘要。
- `applications/ai-model/src/tasks/GenerateReport.ts:78`：用 `result.updateTime` 过滤报告时间范围。
- `common/services/database/AgcDbAccessService.ts:130`：已有按聊天消息时间关联 session 的查询模式。

### 期望行为

报告时间范围应按聊天消息或 session 的实际发生时间判断，而不是按摘要生成时间判断。

### 建议修复

新增报告专用查询，返回 digest 与 session 的 `timeStart`、`timeEnd`、`groupId`，用 session 时间判断是否属于报告周期。

### 验收标准

- 延迟摘要不会把旧聊天归入新报告。
- 本期聊天即使摘要在之后生成，也能进入正确周期报告。
- 报告生成不再依赖 `selectAll()` 后内存过滤。

## BUG-003 失败报告阻止自动重试

优先级：P1

状态：待处理

### 问题现象

报告生成失败或网络不可用时，会保存 `pending` 或 `failed` 报告；后续同周期任务检测到报告已存在后直接跳过，导致永远不再自动生成成功。

### 证据位置

- `applications/ai-model/src/tasks/GenerateReport.ts:63`：报告存在则跳过。
- `applications/ai-model/src/tasks/GenerateReport.ts:176`：网络不可用时保存 `pending` 报告。
- `applications/ai-model/src/tasks/GenerateReport.ts:237`：LLM 重试失败后保存 `failed` 报告。
- `common/services/database/ReportDbAccessService.ts:146`：存在性判断只看 type/timeStart/timeEnd，不看 `summaryStatus`。

### 期望行为

只有 `success` 报告才阻止重复生成；`pending`/`failed` 应允许重试或被原地更新。

### 建议修复

将存在性判断改为只判断成功报告，或让 `GenerateReport` 对同周期非成功报告执行更新重试。

### 验收标准

- 构造一个 `failed` 报告后，同周期任务可以重新生成成功。
- 构造一个 `pending` 报告后，同周期任务不会永久跳过。
- 成功报告仍不会重复生成。

## BUG-004 兴趣分读取逻辑错误

优先级：P1

状态：待处理

### 问题现象

合法兴趣分 `0` 会被当成缺失；配置读取 V2 到 V5 分数时仍硬读 V1，导致报告筛选结果不准确。

### 证据位置

- `common/services/database/InterestScoreDbAccessService.ts:43`：查询 `scoreV${version}`。
- `common/services/database/InterestScoreDbAccessService.ts:44`：返回类型硬编码为 `scoreV1`。
- `common/services/database/InterestScoreDbAccessService.ts:50`：`result?.scoreV1 || null` 会把 `0` 转成 `null`。
- `common/services/config/schemas/GlobalConfig.ts:68`：兴趣分阈值允许 `-1` 到 `1`，默认值为 `0`。

### 期望行为

`0` 是合法分数，不应被当作缺失；配置选择不同版本时应读取对应版本列。

### 建议修复

SQL 使用别名：`SELECT scoreV${version} AS score ...`，返回 `result?.score ?? null`。

### 验收标准

- `score = 0` 时返回 `0`。
- `version = 2` 时读取 `scoreV2`。
- 报告过滤逻辑能正确过滤低于阈值的 topic。

## BUG-005 报告群统计不可信

优先级：P1

状态：待处理

### 问题现象

报告中的最活跃群、群 topic 统计可能显示 `unknown` 或错误群。

### 证据位置

- `applications/ai-model/src/tasks/GenerateReport.ts:145`：手动构建 `sessionGroupMap`。
- `applications/ai-model/src/tasks/GenerateReport.ts:153`：用 `result.sessionId.includes(groupId)` 猜群。
- `applications/preprocessing/src/splitters/TimeoutSplitter.ts:59`：sessionId 是随机 hash。
- `applications/preprocessing/src/splitters/AccumulativeSplitter.ts:58`：sessionId 是随机 hash。

### 期望行为

报告统计应使用数据库中真实的 `chat_messages.groupId`。

### 建议修复

通过 sessionId 批量查询真实 groupId，或在 digest 查询时联表带出 groupId。

### 验收标准

- 报告统计中的 groupId 与原始聊天消息一致。
- 无法匹配 groupId 的 topic 有明确降级策略。
- 删除 `sessionId.includes(groupId)` 这类猜测逻辑。

## BUG-006 去除首页、聊天记录、系统监控前端页面

优先级：P1

状态：待处理

### 问题现象

用户不需要首页、聊天记录、系统监控这些前端页面，希望只在前端移除，不动后端接口、数据库和数据处理能力。

### 证据位置

- `applications/webui-frontend/src/App.tsx:19`：`/chat-messages` 路由。
- `applications/webui-frontend/src/App.tsx:27`：`/system-monitor` 路由。
- `applications/webui-frontend/src/App.tsx:28`：`/system-monitor/logs` 路由。
- `applications/webui-frontend/src/config/site.ts:8`：首页导航入口。
- `applications/webui-frontend/src/config/site.ts:12`：聊天记录导航入口。
- `applications/webui-frontend/src/config/site.ts:40`：系统监控导航入口。
- `applications/webui-frontend/src/pages/index.tsx`：首页页面文件。
- `applications/webui-frontend/src/pages/chat-messages.tsx`：聊天记录页面文件。
- `applications/webui-frontend/src/pages/system-monitor/index.tsx`：系统监控页面文件。

### 期望行为

前端不再展示这些入口，直接访问对应 URL 时不再进入这些页面。

### 建议修复

1. 移除导航配置中的首页、聊天记录、系统监控入口。
2. 移除或重定向对应前端路由。
3. 清理这些页面在前端的直接 import。
4. 不删除后端接口、数据库表、任务逻辑和历史数据。

### 验收标准

- 顶部或侧边导航不再出现首页、聊天记录、系统监控。
- `/`、`/chat-messages`、`/system-monitor`、`/system-monitor/logs` 有明确重定向或 404 策略。
- 前端构建通过。
- 后端不发生任何功能删除。

## BUG-007 AI 聊天 tab URL/按钮切换不稳定

优先级：P1

状态：待复现

### 问题现象

在 `http://localhost:3011/ai-chat?tab=search`、`http://localhost:3011/ai-chat?tab=agent`、`http://localhost:3011/ai-chat` 之间通过页面按钮切换时，可能出现切换不了或页面抖动。

### 证据位置

- `applications/webui-frontend/src/pages/ai-chat/ai-chat.tsx:127`：从 URL 恢复 `tab`。
- `applications/webui-frontend/src/pages/ai-chat/ai-chat.tsx:234`：状态变化后同步 URL。
- `applications/webui-frontend/src/pages/ai-chat/components/ChatHistorySidebar/ChatHistorySidebar.tsx:343`：侧边栏 tab 按钮切换 `activeTab`。
- `applications/webui-frontend/src/pages/ai-chat/ai-chat.tsx:310`：Agent 面板和普通内容区域使用不同渲染分支。

### 期望行为

三个 URL 都能稳定直达对应视图；点击 tab 只切换一次状态，URL 与主内容保持一致，不闪烁、不反复重置。

### 建议修复

1. 复现并记录当前状态变更顺序。
2. 将 URL 初始化和后续 URL 同步拆开，避免初始化阶段反向覆盖。
3. 将 tab 切换集中到单一 handler，统一清理不适用于目标 tab 的 query 参数。
4. 切换到 Agent 时不要触发普通 ask/search 侧栏状态的副作用；切出 Agent 时不要保留无效 conversation 参数。

### 验收标准

- 直接打开 `/ai-chat` 默认进入稳定默认 tab。
- 直接打开 `/ai-chat?tab=search` 稳定进入语义搜索。
- 直接打开 `/ai-chat?tab=agent` 稳定进入 Agent。
- 连续点击三个 tab 20 次无抖动、无切换失败、无控制台错误。
- URL 中 `tab` 与页面展示始终一致。

## BUG-008 Agent 取消/切换不会真正中止执行

优先级：P2

状态：待处理

### 问题现象

用户切换会话或取消当前 Agent 请求后，后端 ai-model 仍可能继续执行并写入过期 assistant 消息。

### 证据位置

- `applications/webui-backend/src/services/AgentService.ts:138`：只执行 `sub.unsubscribe()`。
- `common/rpc/ai-model/router.ts:313`：取消时只设置 `isStopped = true`。
- `applications/ai-model/src/rag/RagRPCImpl.ts:530`：仍执行完整 `agentExecutor.executeStream()`。
- `applications/ai-model/src/rag/RagRPCImpl.ts:557`：执行完成后写入 assistant 消息。
- `applications/ai-model/src/agent-langgraph/LangGraphAgentExecutor.ts:417`：底层已经支持 `abortSignal`。

### 期望行为

前端取消、切换会话或关闭连接时，应真正中止 ai-model 执行，并避免写入过期回复。

### 建议修复

将 AbortSignal 从前端/backend 贯穿到 ai-model RPC input/context，再传入 `LangGraphAgentExecutor.executeStream`。

### 验收标准

- 切换会话后，旧请求不会继续写入消息。
- 取消请求后，ai-model 不再继续执行后续工具调用。
- 历史记录中不出现用户已经离开的过期回答。

## BUG-009 `/latest-topics` 结束日期不包含整天

优先级：P2

状态：待处理

### 问题现象

`endDate=2026-02-06` 从用户直觉看应包含 2 月 6 日整天，但当前实现只包含当天 00:00:00。

### 证据位置

- `applications/webui-frontend/src/pages/latest-topics/latest-topics.tsx:222`：`dateRange.end.toDate(getLocalTimeZone())` 直接作为结束时间。
- `applications/webui-backend/src/schemas/index.ts:85`：后端接收精确 UNIX 毫秒。
- `common/services/database/AgcDbAccessService.ts:147`：SQL 使用 `BETWEEN ? AND ?`。

### 期望行为

用户选择的结束日期应包含该日期整天，或 UI 明确表达为精确时间。

### 建议修复

前端将用户选择的结束日期转换为次日 00:00 的排他边界，或当天 23:59:59.999。

### 验收标准

- `startDate=2026-02-06&endDate=2026-02-06` 能包含 2 月 6 日全天数据。
- URL、日期控件、接口请求时间语义一致。

## BUG-010 AI 流水线存在多处串行查询和逐条写入

优先级：P2

状态：待处理

### 问题现象

数据稍多时，摘要、嵌入、兴趣分、通知等任务会因为串行 DB 查询和逐条写入变慢。

### 证据位置

- `applications/ai-model/src/tasks/GenerateEmbedding.ts:64`：按 group 串行取 session。
- `applications/ai-model/src/tasks/GenerateEmbedding.ts:77`：按 session 串行取 digest。
- `applications/ai-model/src/tasks/InterestScore.ts:60`：按 group 串行取 session。
- `applications/ai-model/src/tasks/InterestScore.ts:72`：按 session 串行取 digest。
- `applications/ai-model/src/tasks/LLMInterestEvaluationAndNotification.ts:76`：按 group 串行取 session。
- `applications/ai-model/src/tasks/LLMInterestEvaluationAndNotification.ts:88`：按 session 串行取 digest。
- `common/services/database/AgcDbAccessService.ts:71`：摘要结果逐条插入。

### 期望行为

独立查询应批量化或有限并发执行；批量写入应使用事务，避免大量小 IO。

### 建议修复

增加批量 DB 方法，例如 `getSessionIdsByGroupIdsAndTimeRange`、`getDigestResultsBySessionIds`、`getInterestScoresByTopicIds`，并用事务批量插入摘要。

### 验收标准

- 同样数据量下 pipeline 耗时明显下降。
- 不改变任务输出结果。
- 增加批量查询/写入的回归测试。

## BUG-011 媒体消息无法准确进入摘要和搜索

优先级：P2

状态：待处理

### 问题现象

图片、语音、文件、外链、小程序分享、转发聊天记录等消息多数不能进入摘要和搜索语义，只以占位符出现或被忽略。

### 证据位置

- `applications/data-provider/src/providers/QQProvider/QQProvider.ts:112`：图片只有存在 `imageText` 时才使用文本，否则占位。
- `applications/data-provider/src/providers/QQProvider/QQProvider.ts:119`：语音消息是占位符。
- `applications/data-provider/src/providers/QQProvider/QQProvider.ts:124`：文件消息只有文件名占位。
- `applications/data-provider/src/providers/QQProvider/QQProvider.ts:129`：其他消息类型忽略。
- `applications/preprocessing/src/formatMsg.ts:4`：预处理只格式化文本内容。
- `applications/ai-model/src/context/ctxBuilders/IMSummaryCtxBuilder.ts:12`：摘要上下文只拼接 `preProcessedContent`。

### 期望行为

媒体消息至少应有可检索、可摘要的文本化信息。

### 建议修复

分阶段增强：先保留并展示媒体元信息；再接入 OCR、图片描述、语音转写、文件摘要或链接标题抽取。

### 验收标准

- 图片无 `imageText` 时不再只剩 `[图片]`。
- 语音消息能进入摘要上下文。
- 文件和链接至少包含有效标题、文件名、摘要或可读元信息。

## BUG-012 `/config` 左侧导航栏太短

优先级：P2

状态：待处理

### 问题现象

`http://localhost:3011/config` 左侧导航栏高度太短，需要额外滚动导航栏；用户希望导航栏更长，尽量不需要滚轮。

### 证据位置

- `applications/webui-frontend/src/pages/config-panel/components/ConfigSidebar.tsx:16`：侧边栏 Card 使用 `h-fit sticky top-20`。
- `applications/webui-frontend/src/pages/config-panel/components/ConfigSidebar.tsx:37`：导航列表限制为 `max-h-[65vh]`。
- `applications/webui-frontend/src/pages/config-panel/config.tsx:579`：配置页采用左右布局。

### 期望行为

左侧导航充分利用视口高度，常见屏幕下无需滚动导航栏即可看到更多配置分区。

### 建议修复

将侧边栏高度调整为基于视口的稳定高度，例如 `h-[calc(100vh-...)]`，并把内部滚动区域改为填满剩余高度；同时保持 sticky 与移动端表现正常。

### 验收标准

- 桌面端 `/config` 左侧导航明显变长。
- 常见 1080p 高度下不需要或很少需要滚动左侧导航。
- 页面主体滚动、定位到 section、搜索过滤仍正常。
- 窄屏布局不溢出。

## BUG-013 前端主 chunk 过大

优先级：P3

状态：待处理

### 问题现象

构建通过，但 Vite 提示主 chunk 过大，首屏加载和交互可能变慢。

### 证据位置

- 当前构建输出：主 chunk `2,633.88 kB`，gzip 后 `827.79 kB`，超过 Vite 默认 500 kB 警戒线。

### 期望行为

首屏只加载当前页面必要代码，低频页面、编辑器、图表、动画等按需加载。

### 建议修复

为路由页增加 lazy import；对大型依赖配置 manual chunks；检查 Monaco、图表库、动画库等是否进入主包。

### 验收标准

- 构建不再出现主 chunk 超大警告，或至少主包明显下降。
- 首屏功能无回归。
- 懒加载页面首次进入时有稳定 loading 状态。

## BUG-014 报告页 URL 深链分页会被重置

优先级：P3

状态：待处理

### 问题现象

打开带 `type` 和 `page` 的报告页深链时，初始化过程可能把页码重置成第 1 页。

### 证据位置

- `applications/webui-frontend/src/pages/reports/reports.tsx:65`：从 URL 读取 `page`。
- `applications/webui-frontend/src/pages/reports/reports.tsx:75`：从 URL 读取 `type`。
- `applications/webui-frontend/src/pages/reports/reports.tsx:245`：`selectedType` 变化时直接 `setPage(1)`。

### 期望行为

URL 中的分页参数在初始化时应被尊重；只有用户主动切换类型时才重置页码。

### 建议修复

跳过初始化阶段的 reset effect，或把重置页码逻辑挪到 tab onSelectionChange handler。

### 验收标准

- `/reports?type=weekly&page=3` 初始加载后仍停留在第 3 页。
- 用户手动切换报告类型时页码回到第 1 页。

## BUG-015 AI 聊天侧边栏分享/导出为空功能

优先级：P3

状态：待处理

### 问题现象

AI 聊天侧边栏展示“分享”和“导出”菜单，但点击后没有实际功能。

### 证据位置

- `applications/webui-frontend/src/pages/ai-chat/components/ChatHistorySidebar/SessionItem.tsx:165`：展示“分享”菜单项。
- `applications/webui-frontend/src/pages/ai-chat/components/ChatHistorySidebar/SessionItem.tsx:175`：展示“导出”菜单项。
- `applications/webui-frontend/src/pages/ai-chat/components/ChatHistorySidebar/ChatHistorySidebar.tsx:286`：分享 handler 只是 TODO 和 `console.log`。
- `applications/webui-frontend/src/pages/ai-chat/components/ChatHistorySidebar/ChatHistorySidebar.tsx:293`：导出 handler 只是 TODO 和 `console.log`。

### 期望行为

可见按钮必须有明确可感知结果；暂不支持的功能不应显示给用户。

### 建议修复

二选一：

1. 实现分享和导出。
2. 暂时隐藏菜单项，后续实现时再恢复。

### 验收标准

- 点击分享/导出有明确功能结果，或菜单项不再出现。
- 控制台不再只输出占位日志。

## 推荐修复顺序

1. `BUG-001`：优先解决 `/latest-topics` 慢，这是当前最影响使用的问题。
2. `BUG-007`：修复 AI 聊天 tab 切换抖动，避免核心入口不可用。
3. `BUG-006`、`BUG-012`：完成用户明确提出的前端页面和配置页体验调整。
4. `BUG-002` 到 `BUG-005`：集中修正报告准确度和兴趣分逻辑。
5. `BUG-008` 到 `BUG-011`：修正 Agent 中止、日期语义、pipeline 性能和媒体理解。
6. `BUG-013` 到 `BUG-015`：处理前端包体积、报告深链和空按钮。

## 通用验收命令

```bash
pnpm -r --filter "./applications/**" build
pnpm test -- --run --no-file-parallelism
git diff --check
```

涉及前端页面交互的任务还应使用浏览器手工验证对应 URL 和按钮行为。
