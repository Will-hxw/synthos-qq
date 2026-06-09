# 03 - Protobuf 消息格式

> 消息内容（列 `40800`）以 Protocol Buffers 二进制格式存储。本文件记录已知字段结构和消息段（element）类型枚举。

---

## 1. 顶层结构

消息内容 Protobuf 顶层字段：

| Field Number | 类型 | 含义 | 说明 |
|:---|:---|:---|:---|
| `48000` | protobuf / protobuf[] | 消息段 | 一条消息可有多个消息段，按内容顺序排列（类似富文本），部分类型中可嵌套 |

> **⚠️ 注意**：社区文档（linux.do、QQDecrypt）使用 `48000` 作为消息段字段号。但本项目经实际数据验证，发现外层 Message 结构中 `40800` 可能才是直接承载 `repeated MsgElement` 的字段号。此处可能存在文档笔误，实际解析时应以实测数据为准。详见本项目的 `messageSegment.proto`。

---

## 2. 消息段字段详解（Field 48000 / 40800 内部）

以下为每个消息段（MsgElement）内部的字段：

### 2.1 基础标识字段

| Field Number | 类型 | MsgRecord 字段 | 说明 | 所属 Element |
|:---|:---|:---|:---|:---|
| `40010` | int | `chatType` | 聊天类型 | — |
| `45001` | int | `elementId` | 元素 ID，与 msgId 同样具有唯一性 | — |
| `45002` | int | `elementType` | 元素类型（见 [第 3 节](#3-elementtype-枚举)） | — |
| `45003` | int | `subElementType` | 子元素类型（未完全确定） | — |
| `45004` | str | — | `msgId` + `faceType` | — |
| `49155` | int | `msgTime` | 发送时间戳 | — |

### 2.2 文本消息（elementType=1, textElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `45101` | str | `content` | 文本内容（@消息为独立消息段，内容为"@群昵称"） |

### 2.3 图片消息（elementType=2, picElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `45402` | str | `fileName` | 图片文件名 |
| `45405` | int | `fileSize` | 图片文件大小 |
| `45411` | int | `picWidth` / `thumbWidth` | 原图/封面宽度 |
| `45412` | int | `picHeight` / `thumbHeight` | 原图/封面高度 |
| `45416` | int | `picType` | 图片类型：`1000` = 静态图，`2000` = GIF |
| `45424` | str/bytes | `originImageMd5` | 原图 MD5 |
| `45503` | str | `fileUuid` | CDN 下载 fileid |
| `45802` | str | `imageUrlLow` | 低清图片下载地址，QQNT 中常见为 `/download?...` 相对地址 |
| `45803` | str | `imageUrlHigh` | 高清图片下载地址，QQNT 中常见为 `/download?...` 相对地址 |
| `45804` | str | `imageUrlOrigin` | 原图下载地址，QQNT 中常见为 `/download?...` 相对地址 |
| `45812` | str | `imageSourcePath` | 图片本地缓存路径，仅当 QQ 已缓存到本地时存在 |
| `45815` | str | `imageText` | QQ 自带图片文字或表情描述 |

> 图片消息不保证存在本地缓存路径。实测 `45403` / `45954` 对图片通常为空，`45812` 在部分已缓存图片中保存 `nt_data/Pic/...` 或 `nt_data/Emoji/...` 路径；其余图片通常只能拿到 `/download?...` 下载地址。

### 2.4 文件消息（elementType=3, fileElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `45402` | str | `fileName` | 文件名 |
| `45403` | str | `filePath` | 文件路径 |
| `45405` | int | `fileSize` | 文件大小 |
| `45406` | int | `md5HexStr` | 视频 MD5（视频文件） |
| `45407` | bytes | `file10MMD5` | 文件 10M MD5 |
| `45408` | bytes | `fileSha` | 文件 SHA |
| `45409` | bytes | `fileSha3` | 文件 SHA3 |
| `45410` | int | `videoTime` | 视频时长 |
| `45503` | str | `fileUuid` | 文件唯一标识 |
| `45954` | str | `picThumbPath` | 预览封面路径 |
| `95654` | int | `thumbSize` | 封面大小（fileElement） |

### 2.5 语音消息（elementType=4, pttElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `45102` | str | `text` | 语音转文字 |
| `45402` | str | `fileName` | 文件名 |
| `45403` | str | `filePath` | 文件路径 |
| `45405` | int | `fileSize` | 文件大小 |
| `45407` | bytes | `file10MMD5` | 文件 MD5 |
| `45906` | int | `duration` | 语音时长（秒） |
| `45923` | str | `text` | 语音转文字 |
| `45925` | bytes | `waveAmplitudes` | 音频波形数据 |

### 2.6 视频消息（elementType=5, videoElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `45410` | int | `videoTime` | 视频时长 |
| `45411` | int | `thumbWidth` | 封面宽度 |
| `45412` | int | `thumbHeight` | 封面高度 |
| `45413` | int | — | 预览封面宽度 |
| `45414` | int | — | 预览封面高度 |
| `45415` | int | `thumbSize` | 封面大小 |
| `45422` | str | `thumbFileName` | 封面路径（`/Tencent/MobileQQ/shortvideo/thumbs/`） |
| `45862` | bytes | `thumbMD5` | 封面 MD5 |

### 2.7 表情消息（elementType=6 或 11, faceElement / marketFaceElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `47601` | int | `faceIndex` | 表情 ID（与 [QQBot 表情模型](https://bot.q.qq.com/wiki/develop/api/openapi/emoji/model.html) 对应） |
| `47602` | str | `faceText` | 表情含义（外显文字） |

### 2.8 引用/回复消息（elementType=7, replyElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `47401` | int | `replayMsgId` | 引用消息的 msgId |
| `47402` | int | `replayMsgSeq` | 引用消息的 seq |
| `47403` | int | `replyMsgTime` | 引用消息的时间戳 |
| `47404` | int | — | 引用消息时间戳（冗余） |
| `47413` | str | — | 引用消息内容（仅文本） |
| `47421` | str | — | 引用方群昵称 |
| `47422` | int | `sourceMsgIdInRecords` | 原始消息记录 ID |

### 2.9 系统消息（elementType=8, grayTipElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `47713` | str | — | 撤回消息后缀（系统撤回消息） |

### 2.10 卡片消息（elementType=10, arkElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `47901` | str | `bytesData` | 卡片详细信息（通常为 JSON） |

### 2.11 XML 消息（elementType=16）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `48602` | str | — | XML 消息内容（合并转发、转发聊天记录本质上也是 XML） |

### 2.12 通话消息（elementType=21, avRecordElement）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `48153` | str | — | 通话状态文本 |
| `48157` | str | — | 通话文本 |

### 2.13 动态消息（elementType=26, GrayTip_QQZone）

| Field Number | 类型 | 字段 | 说明 |
|:---|:---|:---|:---|
| `48175` | protobuf | — | 动态标题 |
| `48176` | protobuf | — | 动态内容 |
| `48180` | str | — | 动态链接 |
| `48181` | str | — | 动态 Logo 链接 |
| `48182` | int | — | 发布者 UID |
| `48183` | str | — | 跳转信息 |
| `48188` | str | — | 发布者 ID |

---

## 3. `elementType` 枚举（Protobuf 字段 `45002`）

| 值 | 名称 | 说明 |
|:---|:---|:---|
| `1` | `textElement` | 文本段（含 @ 消息，@消息为独立消息段，内容为"@群昵称"） |
| `2` | `picElement` | 图片段 |
| `3` | `fileElement` | 文件消息 |
| `4` | `pttElement` | 语音消息 |
| `5` | `videoElement` | 视频消息 |
| `6` | `faceElement` | QQ 系统表情 |
| `7` | `replyElement` | 引用（即"回复"），位于消息段开头，其后为正式消息 |
| `8` | `grayTipElement` | 系统消息（灰字提示，如撤回、接收文件） |
| `9` | `walletElement` | 红包消息 |
| `10` | `arkElement` | 卡片消息 |
| `11` | `marketFaceElement` | 商城表情 |
| `14` | `markdownElement` | Markdown 消息 |
| `16` | — | XML 消息（转发聊天记录本质也是 XML 消息） |
| `17` | `inlineKeyboardElement` | Markdown 按钮消息 |
| `21` | `avRecordElement` | 通话消息 |
| `26` | `GrayTip_QQZone` | 空间动态提示 |
| `27` | `faceBubbleElement` | 弹射表情包 |
| `28` | `shareLocationElement` | 位置共享 |
| `44` | `QQBotChat` | 机器人对话 |

---

## 4. 覆盖率说明

| 来源 | 覆盖情况 |
|:---|:---|
| QQDecrypt 官方文档 | 约 45 个字段，覆盖 text / pic / file / ptt / video / face / reply / grayTip / ark / marketFace |
| GitHub [Yumeka/qq-dump](https://github.com/miniyu157/qq-dump) | `c2c_msg_table.40800` 约 260 个字段（含大量无意义随机长短字段） |
| 本项目 `messageSegment.proto` | 约 45 个核心字段，覆盖常见消息类型 |

---

## 5. 模型表情编号

- 表态表情编号与 [QQBot 表情模型](https://bot.q.qq.com/wiki/develop/api/openapi/emoji/model.html) 对应
- 超级表情不在此列表中
- `emoji.db` → `emoji_group_table` 包含超级表情 ID 说明（如超级表情 0-16）
