# Synthos —— data-provider 代码审查问题清单

> 范围：只考虑功能正确性、性能效率、结果准确度和交互体验问题。安全、权限、泄露、敏感信息、成本控制类问题不纳入。

> 审查对象：`applications/data-provider` 全目录（含其依赖的 `common` 契约/工具）。问题按严重度排序，已通过独立验证剔除误报。

---

## 汇总

| # | 严重度 | 文件 | 行 | 摘要 |
|---|--------|------|----|------|
| 1 | 高 | `QQProvider.ts` | 1259 | `quotedMsgId` 从不写入，引用消息被引 ID 永久丢失 |
| 2 | 高 | `QQProvider.ts` | 1265 | `senderGroupNickname/senderNickname` 可能为 null，违反非可选 string 契约 |
| 3 | 高 | `QQProvider.ts` | 309 | `PRAGMA key` 拼接，密钥含单引号导致整库无法解密 |
| 4 | 高 | `ProvideDataTask.ts` | 108 | 增量起始时间可能大于结束时间，区间反转静默漏拉 |
| 5 | 高 | `QQProvider.ts` | 1405 | 时间戳原样插入 SQL，NaN 生成 `BETWEEN NaN AND NaN` 静默返回空 |
| 6 | 中 | `QQProvider.ts` | 1390 | `getMsgByTimeRange` 缺少 `ORDER BY`，返回顺序未定义 |
| 7 | 中 | `KVStore.ts` | 36 | `get` 吞掉所有异常返回 undefined，损坏与缺失不可区分 |
| 8 | 中 | `MessagePBParser.ts` | 33 | proto 路径相对 `cwd`，非预期工作目录下 `init()` 抛错 |
| 9 | 中 | `QQProvider.ts` | 750 | `mediaId` 在跨父转发复用子消息 msgId 时冲突 |
| 10 | 中 | `ProvideDataTask.ts` | 155 | 对账依赖鸭子类型判定，无接口约束 |
| 11 | 低 | `QQProvider.ts` | 200 | 游标分页按字典序遍历，与时间序语义不一致 |
| 12 | 低 | `QQProvider.ts` | 1387 | `floor/ceil` 不对称，秒边界跨批重复拉取 |
| 13 | 低 | `ApplicationCardMessageFormatter.ts` | 21 | 顶层为 JSON 基本类型的卡片内容被静默丢弃 |
| 14 | 低 | `MessagePBParser.ts` | 122 | `bytes: String` 将 bytes 字段解码为 base64（潜在风险） |

---

## 高严重度

### 1. `quotedMsgId` 从不写入，引用消息的被引 ID 永久丢失

- **文件**：`applications/data-provider/src/providers/QQProvider/QQProvider.ts:1259`
- **现象**：`_parseRawGroupMsgRow` 中 REPLY 类型消息只设置 `processedMsg.quotedMsgContent`，从未设置 `quotedMsgId`。
- **影响**：`storeRawChatMessages` 绑定 `msg.quotedMsgId` 时永远是 `undefined → NULL`，`chat_messages.quotedMsgId` 整列恒为空。任何依赖 `quotedMsgId` 构建回复链/做关联的下游逻辑都拿不到数据，而 DB 行内 `replyMsgSeq` 本可用于回填。

### 2. `senderGroupNickname/senderNickname` 可能为 null，违反非可选 string 契约

- **文件**：`applications/data-provider/src/providers/QQProvider/QQProvider.ts:1265`
- **现象**：`RawChatMessage` 将两字段声明为 `string`（非空），而此处直接赋 `result[GMC.sendMemberName]` / `[GMC.sendNickName]`，未做 `String()` 兜底。
- **影响**：`GroupMsgColumn` 注释明确旧版迁移数据/未设群名片时这两列可能为 `NULL`。运行期值为 null 违反类型契约；任何消费者对其调用 `.length` / `.trim()` 等会抛 `TypeError`。

### 3. `PRAGMA key` 拼接，密钥含单引号导致整库无法解密

- **文件**：`applications/data-provider/src/providers/QQProvider/QQProvider.ts:309`
- **现象**：`_openEncryptedDatabase` 用模板串拼接 `PRAGMA key = '${dbKey}'`。
- **影响**：若配置的 `dbKey` 含单引号（如 `it's`），生成 `PRAGMA key = 'it's'` 语法错误，`db.exec` 拒绝，整库无法打开。`dbKey` 为可信配置而非攻击者输入，故非注入风险，但属真实健壮性缺陷；应使用十六进制密钥或参数化形式。

### 4. 增量起始时间可能大于结束时间，区间反转静默漏拉

- **文件**：`applications/data-provider/src/tasks/ProvideDataTask.ts:108`
- **现象**：`startTimeStamp = newestMsg.timestamp - 1000` 可能大于 `endTimeStamp`。
- **影响**：当 `endTimeStamp` 为固定历史截止值、而库中已有更新消息时，`start > end`。`getMsgByTimeRange` 内除以 1000 后 `timeStart > timeEnd`，SQLite `BETWEEN` 反向区间返回空集且不报错，该批消息被静默漏拉，无任何告警。

### 5. 时间戳原样插入 SQL，NaN 生成 `BETWEEN NaN AND NaN` 静默返回空

- **文件**：`applications/data-provider/src/providers/QQProvider/QQProvider.ts:1405`
- **现象**：`getMsgByTimeRange` 把 `timeStart` / `timeEnd` 原样插入 SQL。
- **影响**：若上游传入非有限值（如 `newestMsg.timestamp` 缺失导致 `newestMsg.timestamp - 1000 = NaN`），`Math.floor/ceil(NaN) = NaN`，模板插值得到 `BETWEEN NaN AND NaN`，SQLite 视为恒假返回 0 行，静默失败。时间范围应参数化绑定而非字符串拼接。

---

## 中严重度

### 6. `getMsgByTimeRange` 缺少 `ORDER BY`，返回顺序未定义

- **文件**：`applications/data-provider/src/providers/QQProvider/QQProvider.ts:1390`
- **现象**：`getMsgsByMsgIds`(1175) 与 `_getBusinessMsgIdPage`(1213) 都显式 `ORDER BY msgTime ASC, msgId ASC`，唯独时间范围查询无排序。
- **影响**：SQLite 无 `ORDER BY` 时行序不保证，任何按返回数组顺序处理消息（假定时间升序）的消费者会得到乱序结果。

### 7. `KVStore.get` 吞掉所有异常返回 undefined，损坏与缺失不可区分

- **文件**：`common/util/KVStore.ts:36`
- **现象**：`catch` 对 I/O 错误、JSON 解析失败、条目损坏都返回 `undefined`。
- **影响**：`_reconcileQQSourceMessages` 读取损坏的 cursor 时 `(await get()) || null` 退化为 null，对账每轮都从头重扫并重复补入大量消息（靠 `ON CONFLICT` 避免重复行，但浪费整轮 `getMsgsByMsgIds + store` 开销且游标永不前进）。

### 8. proto 路径相对 `cwd`，非预期工作目录下 `init()` 抛错

- **文件**：`applications/data-provider/src/providers/QQProvider/parsers/MessagePBParser.ts:33`
- **现象**：`readFile('./src/...')` 与 `'./applications/data-provider/src/...'` 都按 `cwd` 解析，未用 `__dirname` / `import.meta.url`。
- **影响**：从子包目录或仓库根之外（测试 runner、不同 WORKDIR 的 Docker）启动时两条路径全失败，`protoContent` 为 `undefined`，`init` 抛 `NOT_EXIST`，整个 Provider 不可用。

### 9. `mediaId` 在跨父转发复用子消息 msgId 时冲突

- **文件**：`applications/data-provider/src/providers/QQProvider/QQProvider.ts:750`
- **现象**：`mediaId = ${msgId}:${elementIndex}`；`_getStoredMessageId` 对 msgId 非 `'0'` 的子消息直接返回其原始 msgId。
- **影响**：若同一子消息（如 `'12345'`）出现在两条不同父转发消息中，其首图都得到 `mediaId '12345:0'`。`chat_message_media` 的 `ON CONFLICT(mediaId) DO UPDATE` 会把两者合并，导致媒体记录挂上来自另一父消息的错误 `groupId` / `timestamp`。

### 10. 对账依赖鸭子类型判定，无接口约束

- **文件**：`applications/data-provider/src/tasks/ProvideDataTask.ts:155`
- **现象**：`IIMProvider` 只声明 `init` / `getMsgByTimeRange` / `dispose`；对账方法 `getBusinessMsgIdPageAfterCursor` / `getMsgsByMsgIds` 仅靠 `typeof 'function'` 守卫 + `as QQProvider` 断言访问。
- **影响**：未来某 Provider 偶然暴露同名但签名不同的方法会通过守卫，被以 QQProvider 参数类型调用，导致运行期错误或静默数据错乱；TS 编译期无任何保护。

---

## 低严重度

### 11. 游标分页按字典序遍历，与时间序语义不一致

- **文件**：`applications/data-provider/src/providers/QQProvider/QQProvider.ts:200`
- **现象**：游标分页 tiebreak 与 `ORDER BY` 均用 `CAST(msgId AS TEXT)` 做字典序。
- **影响**：排序与游标比较都用文本字典序且彼此一致，故单次扫描不会漏/重（完整性保留）。但 `'9'` 在字典序上排在 `'10'` / `'100'` 之后，对账按字典序而非时间序推进；若对账设计隐含按时间推进的语义则与预期不符，且与 `_getBusinessMsgIdPage` 内 `msgTime` 数值排序混用时语义不一致。

### 12. `floor/ceil` 不对称，秒边界跨批重复拉取

- **文件**：`applications/data-provider/src/providers/QQProvider/QQProvider.ts:1387`
- **现象**：`timeStart` 用 `Math.floor`、`timeEnd` 用 `Math.ceil`。
- **影响**：上一批 `endTimeStamp` 作为下一批 `startTimeStamp` 时，边界秒的消息同时落入上批 ceil 与下批 floor 的闭区间，被重复拉取（靠 `ON CONFLICT` 去重）；同时 `msgTime == ceil(endTimeStamp/1000)` 的消息可能被多纳入一秒窗口外的数据。

### 13. 顶层为 JSON 基本类型的卡片内容被静默丢弃

- **文件**：`applications/data-provider/src/providers/QQProvider/formatters/ApplicationCardMessageFormatter.ts:21`
- **现象**：`rawContent='123'/'true'/'null'` 时 `normalizeInlineText` 非空、守卫通过，`JSON.parse` 得到非对象顶层值，`collectStructuredStringEntries` 在 `typeof !== 'object'` 处直接返回，`entries` 为空。
- **影响**：最终回退“暂无可读文本”，丢失原始内容。（顶层为字符串数组不受影响——会递归收集。）

### 14. `bytes: String` 将 bytes 字段解码为 base64（潜在风险）

- **文件**：`applications/data-provider/src/providers/QQProvider/parsers/MessagePBParser.ts:122`
- **现象**：`toObject` 使用 `bytes: String`，bytes 字段被解码为 base64 字符串而非 `Buffer`；结果用 `as RawMsgContentParseResult` 断言无运行期校验。
- **影响**：任何把 bytes 字段当 `Buffer` 使用的消费者（取 `.length` 当字节数、传给二进制 API）会拿到长约 4/3 的 base64 串，造成静默数据错误且此处不抛异常。当前 QQProvider 未直接读 bytes 字段，故暂为潜在风险。

---

## 附：已剔除的误报（供参考）

- **`storeRawChatMessages` 的 `String.replace` 末批替换**：搜索串是完整的多组占位串，无前缀歧义，正确。
- **`msgContent` 为 null 被丢弃**：`decode` 异常在 parser 内统一转 `PROTOBUF_ERROR`，外层捕获后写占位，不会丢消息。
- **`enums:String → NaN`**：proto 中 `msgType` 是 `uint32` 而非 enum，`Number()` 正常。
- **`forwardMergedNestedTruncatedCount` 双计**：content 真值分支提前 `return`，与后续分支互斥。
- **`job.fail()` 后 `return`**：Agenda 在 `finally` 持久化 job 状态，失败会落库。
- **`_normalizeQQSourcePath` 兄弟目录穿越**：`path.relative` 对越界路径产出 `..\` 前缀，守卫已正确拦截。
