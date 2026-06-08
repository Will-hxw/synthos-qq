# QQ 客户端数据库分析参考

> 分析目标路径：`/data/user/0/com.tencent.mobileqq/databases/nt_db/nt_qq_{QQ_path_hash}/`
> 其余客户端基本也符合此结构。
>
> **注意**：以下信息均通过聊天数据推断而来，可能存在未发现或错误分析，欢迎指正。

---

## 1. 数据库文件总览

| 状态 | 数据库名 | 说明 |
|:---:|:---|:---|
| 🔵 | `nt_msg.db` | 聊天数据文件 |
| 🔵 | `profile_info.db` | 联系人信息 |
| 🔵 | `rich_media.db` | 群聊/私聊发送或接收的文件信息（待进一步分析） |
| 🔵 | `files_in_chat.db` | 媒体文件信息（含下载的图片/视频路径） |
| 🔵 | `recent_contact.db` | 推测为黑名单（待测试） |
| ❓ | `gpro_v1-6_{nt_uid}.db` | 暂未实现数据库解密，无法分析 |
| ✅ | `group_info.db` | 群聊信息（含群头像、群成员等） |
| 🔵 | `guild_msg.db` | 频道聊天数据 |
| 🔵 | `collection.db` | QQ 收藏数据 |
| 🔵 | `file_assistant.db` | 已下载文件存放数据 |
| 🔵 | `misc.db` | 杂项（见下文） |
| ✅ | `emoji.db` | QQ 表情包数据库（不再分析） |
| ✅ | `group_msg_fts.db` | 本地搜索索引 |
| ✅ | `data_line_msg_fts.db` | 本地搜索索引 |
| ✅ | `buddy_msg_fts.db` | 本地搜索索引 |
| ✅ | `discuss_msg_fts.db` | 本地搜索索引 |
| ✅ | `msg_fts.db` | 本地搜索索引 |
| ✅ | `rdelivery.db` | 文件中未发现有效信息 |
| ✅ | `settings.db` | 有效信息很少（无法理解的设置项，不再分析） |
| ✅ | `yffm.db` | 文件中未发现有效信息 |

**图例：**
- 🔵 存在有效信息，有待继续分析
- ✅ 已完成表名分析（列名会单独重开分析）
- ❓ 因技术原因暂无法分析

> 已被删除的数据库中未发现有意义的数据，后续不再探查。

---

## 2. 各数据库详细分析

### 2.1 `nt_msg.db` — 聊天数据

#### 2.1.1 `group_msg_table`（群聊消息）

| 列名 | 类型 | MsgRecord 字段 | 说明 |
|:---|:---|:---|:---|
| 40001 | int | `msgId` | 消息 ID，具有唯一性 |
| 40002 | int | `msgRandom` | 消息随机值，用于消息去重 |
| 40003 | int | `msgSeq` | 群聊消息序号，在每个聊天中依次递增 |
| 40005 | int | — | 作用不明，仅自己发的消息有一定概率存在数值，正常为 0 |
| 40006 | int | — | elem id? 作用不明 |
| 40010 | int | `chatType` | 聊天类型（见 [chatType 枚举](#31-chattype-枚举)） |
| 40011 | int | `msgType` | 消息类型（见 [msgType 枚举](#32-msgtype-枚举)） |
| 40012 | int | `subMsgType` | PB 子消息类型（见 [subMsgType 枚举](#33-submsgtype-枚举)） |
| 40013 | int | `sendType` | 发送标志：0=他人发送, 1=本机发送, 2=其他客户端发送, 5=转发消息；已退出/封禁消息中为当日整点时间戳 |
| 40020 | str | `senderuid` | `nt_uid`，对应 `nt_uid_mapping_table` |
| 40021 | str | `peeruid` | 会话 ID |
| 40027 | int | `peeruin` | 会话 ID（群号） |
| 40030 | int | — | 群号（QQNT 保存） |
| 40033 | int | — | 发送者 QQ 号（QQNT 保存） |
| 40041 | int | `sendStatus` | 发送状态：0=发送被阻止（如非好友）, 1=尚未发送成功（如网络问题）, 2=成功, 3=消息被和谐 |
| 40050 | int | `msgTime` | 消息时间戳（UTC+8，单位为秒） |
| 40058 | int | — | 当日 0 时整的时间戳（GMT+0800） |
| 40060 | int | — | 已退出/已解散群聊标志 |
| 40062 | protobuf | — | 表态信息详情（含表态表情和表态数量），数字与 QQBOT 表情编号对应（超级表情不在此列） |
| 40080 | protobuf | — | 聊天消息内容（最复杂，尚未解析完） |
| 40083 | int | — | 表态表情数量总和 |
| 40084 | int | — | 表态表情数量总和 |
| 40090 | str | `sendMemberName` | 发送者群名片（旧版格式 `name(12345)`，QQNT 中为群名片） |
| 40093 | str | `sendNickName` | 发送者昵称（旧版 QQ 此字段为空，QQNT 中未设群名片时才有） |
| 40100 | int | — | @ 状态（见 [@ 状态枚举](#34--状态枚举)） |
| 40600 | protobuf | — | 状态标志（见 [40600 解析](#35-40600-状态标志解析)） |
| 40801 | protobuf | — | 无法理解的 protobuf |
| 40850 | int | — | 回复消息序号（该消息所回复消息的序号） |
| 40900 | protobuf | — | 按 msgType 区分：`8` → 转发聊天缓存, `9` → 引用消息 |

#### 2.1.2 `group_at_me_msg`（被 @ 消息）

| 列名 | MsgRecord 字段 | 含义 |
|:---|:---|:---|
| 40001 | `msgId` | 消息 ID |
| 40027 | `peeruin` | 群号 |
| 40020 | `senderUid` | @ 我的成员的 `nt_uid` |
| 40100 | `atTypeArray` | @ 类型数组：`6` = 有人 @ 我, `1` = @ 所有人 |
| 40050 | — | 消息时间戳 |
| 40003 | `msgSeq` | 群聊消息序号，在每个群聊中依次递增 |

#### 2.1.3 `recent_contact_top_table`（置顶聊天）

| 列名 | 含义 |
|:---|:---|
| 40010 | 聊天类型 |
| 41103 | 置顶时间 |
| 1000 | 私聊置顶 → `uin` |
| 60001 | 群聊置顶 → `peeruin` |

#### 2.1.4 `recent_contact_v3_table`（聊天对象资料信息）

| 列名 | MsgRecord 字段 | 含义 |
|:---|:---|:---|
| 40010 | `chatType` | 聊天类型 |
| 40021 | — | `peeruin` / `nt_uid` |
| 40030 | — | C2C 才有 `uin`，群聊此值为 0 |
| 40051 | `lastMessage` | 最后一条消息（protobuf） |
| 40041 | `sendStatus` | 发送状态 |
| 40050 | `lastTime` | 最后一条消息时间戳（秒） |
| 40003 | `msgSeq` | — |
| 40094 | — | 来源 |
| 40093 | `sendNickName` | 昵称 |
| 40090 | `sendMemberName` | 群名片 |
| 40095 | `sendRemarkName` | 备注名称 |
| 40020 | — | `nt_uid` |
| 40033 | — | `uin` |
| 41110 | — | 群头像本地缓存路径 |
| 41135 | — | 通过群聊发起聊天时显示对应群昵称 |

---

### 2.2 `c2c_msg_table`（私聊消息）

| 列名 | 类型 | 含义 | 说明 |
|:---|:---|:---|:---|
| 40030 | int | 私聊对象 QQ 号 | 对方 QQ 号（双方发送的消息均记录此值） |
| 40033 | int | 发送者 QQ 号 | 发送者的 QQ 号 |
| 40050 | int | 时间 | 时间戳（秒） |
| 40058 | int | 日期 | 当日 0 时整的时间戳 |
| 40093 | str | 昵称/备注 | QQ 昵称或备注名 |
| 40800 | bytes | 消息内容 | protobuf 格式 |

---

### 2.3 Protobuf 消息格式（`40800` 字段）

消息内容 protobuf 顶层字段：

| Field Number | 类型 | 含义 |
|:---|:---|:---|
| 48000 | protobuf / protobuf[] | 消息段，一条消息可有多个，按内容顺序排列（类似富文本） |

#### 2.3.1 消息段（`48000`）字段

| Field Number | 类型 | MsgRecord 字段 | 说明 | 所属 Element |
|:---|:---|:---|:---|:---|
| 40010 | int | `chatType` | — | — |
| 45001 | int | `elementId` | 元素 ID，与 msgId 一样唯一 | — |
| 45002 | int | `elementType` | 元素类型（见 [elementType 枚举](#36-elementtype-枚举)） | — |
| 45003 | int | `subElementType` | 未确定 | — |
| 45004 | str | — | `msgId` + `faceType` | — |
| 45101 | str | `content` | 文本内容 | textElement |
| 45102 | str | `text` | 语音转文字 | pttElement |
| 45402 | str | `fileName` | 文件名 | fileElement, pttElement |
| 45403 | str | `filePath` | 文件路径 | fileElement, pttElement |
| 45405 | int | `fileSize` | 文件大小 | fileElement, pttElement |
| 45406 | int | `md5HexStr` | 视频 MD5 | fileElement |
| 45407 | bytes | `file10MMD5` | — | fileElement, pttElement |
| 45408 | bytes | `fileSha` | — | fileElement |
| 45409 | bytes | `fileSha3` | — | fileElement |
| 45410 | int | `videoTime` | 视频时长 | videoElement, fileElement |
| 45411 | int | `thumbWidth` | 封面宽度 | videoElement, picElement |
| 45412 | int | `thumbHeight` | 封面高度 | videoElement, picElement |
| 45413 | int | — | 预览封面宽度 | — |
| 45414 | int | — | 预览封面高度 | — |
| 45415 | int | `thumbSize` | 封面大小 | videoElement |
| 45416 | int | `picType` | 图片类型：`1000` = 静态, `2000` = GIF | picElement |
| 45418 | int | — | `original` | — |
| 45422 | str | — | 封面路径（`/Tencent/MobileQQ/shortvideo/thumbs/`） | videoElement |
| 45424 | str/bytes | `originImageMd5` | — | — |
| 45503 | str | `fileUuid` | — | — |
| 45862 | bytes | `thumbMD5` | 封面 MD5（对应 45422 文件） | videoElement |
| 45906 | int | `duration` | 语音时长 | pttElement |
| 45923 | str | `text` | 语音转文字 | pttElement |
| 45925 | bytes | `waveAmplitudes` | 信号频率 | pttElement |
| 45954 | str | `picThumbPath` | 封面路径 | fileElement |
| 47401 | int | `replayMsgId` | 引用消息 msgId | replyElement |
| 47402 | int | `replayMsgSeq` | 引用消息 seq | replyElement |
| 47403 | int | `replyMsgTime` | 引用消息时间戳 | replyElement |
| 47404 | int | — | 引用消息时间戳（冗余） | replyElement |
| 47413 | str | — | 引用消息（仅文本） | replyElement |
| 47421 | str | — | 引用方群昵称 | replyElement |
| 47422 | int | `sourceMsgIdInRecords` | — | replyElement |
| 47601 | int | `faceIndex` | 表情 ID | faceElement |
| 47602 | str | `faceText` | 表情含义（外显文字） | faceElement |
| 47713 | str | — | 撤回消息后缀（系统撤回） | — |
| 47901 | str | `bytesData` | 卡片详细信息 | — |
| 48602 | str | — | XML 消息内容 | XML 消息 |
| 49155 | int | `msgTime` | 发送时间 | — |
| 95654 | int | `thumbSize` | 封面大小 | fileElement |

---

## 3. 枚举值参考

### 3.1 `chatType` 枚举

| 值 | 含义 |
|:---|:---|
| 1 | 私聊（C2C） |
| 2 | 群聊 |
| 4 | 频道 |
| 100 | 临时会话 |
| 102 | 企业客服 |
| 103 | 公众号 |

### 3.2 `msgType` 枚举（列 `40011`）

| 值 | 含义 |
|:---|:---|
| 0 | 无消息（消息损坏，多见于已退出群聊且时间久远） |
| 1 | 消息空白（msgId 存在，未加载出来） |
| 2 | 文本消息 |
| 3 | 群文件 |
| 4 | 未发现（待补充） |
| 5 | 系统（灰字）消息 |
| 6 | 语音消息 |
| 7 | 视频文件 |
| 8 | 合并转发消息 |
| 9 | 回复类型消息 |
| 10 | 红包 |
| 11 | 应用消息 |

### 3.3 `subMsgType` 枚举（列 `40012`）

| 值 | 含义 |
|:---|:---|
| 0 | 非常规 text 消息 |
| 1 | 普通文本 / 群文件其他类型 |
| 2 | 图片 / 群文件图片 |
| 3 | 群公告 |
| 4 | 撤回消息提醒 / 群文件视频 |
| 8 | 原创表情包 / 群文件音频 |
| 11 | 射精消息 |
| 12 | 拍一拍 |
| 16 | 群文件 docx |
| 32 | 平台文本 / 群文件 pptx |
| 33 | 回复类型 |
| 64 | 群文件 xlsx |
| 129 | 纯链接 |
| 161 | 存在链接 |
| 512 | 群文件 zip |
| 2048 | 群文件 exe |
| 4096 | 表情消息 |

### 3.4 @ 状态枚举（列 `40100`）

| 值 | 含义 |
|:---|:---|
| 0 | 不包含 @ |
| 2 | 有人 @ 他人 |
| 6 | 有人 @ 我 |

### 3.5 `40600` 状态标志解析

| 十六进制值 | 含义 |
|:---|:---|
| `14 00` | 回复消息（此时 `40100`: `6` = 有人回复自己, `2` = 他人回复他人） |
| `c2e91304a8d114**` 等 | 撤回消息（值不唯一） |

### 3.6 `elementType` 枚举（Protobuf `45002`）

| 值 | 名称 | 说明 |
|:---|:---|:---|
| 1 | `textElement` | 文本段（含 @ 消息） |
| 2 | `picElement` | 图片段 |
| 3 | `fileElement` | 文件消息 |
| 4 | `pttElement` | 语音消息 |
| 5 | `videoElement` | 视频消息 |
| 6 | `faceElement` | QQ 系统表情 |
| 7 | `replyElement` | 引用（即"回复"） |
| 8 | `grayTipElement` | 系统消息（灰字提示，如撤回、接收文件） |
| 9 | `walletElement` | 红包消息 |
| 10 | `arkElement` | 卡片消息 |
| 11 | `marketFaceElement` | 商城表情 |
| 14 | `markdownElement` | Markdown 消息 |
| 17 | `inlineKeyboardElement` | Markdown 按钮消息 |
| 27 | `faceBubbleElement` | 弹射表情包 |
| 28 | `shareLocationElement` | 位置共享 |

---

## 4. 常见消息组合（`40011` + `40012`）

> 注意：由于优先级问题（特别是 msgType=2 类别），部分消息可能不满足以下规则。

### 文本类（msgType=2）

| subMsgType | 消息类型 |
|:---|:---|
| 0 | 空消息 |
| 1 | 普通文本 |
| 2 | 图片消息 |
| 3 | 仅带图片的纯文本 |
| 16 | 纯表情 |
| 17 | 带表情的纯文本 |
| 19 | 带图片 + 表情的纯文本 |
| 35 | @ 消息 |
| 65 | 机器人 Markdown 消息 |
| 129 | 纯链接 |
| 145 | 带表情链接 |
| 577 | 机器人消息 |
| 4096 | 收藏表情包 |

### 回复类（msgType=9）

| subMsgType | 消息类型 |
|:---|:---|
| 33 | 回复引用（不带表情） |
| 34 | 回复带图片（无 @） |
| 35 | 回复带图片 + @ |
| 49 | 回复卡片引用 / 带表情回复 |
| 51 | 带表情 + 图片 + @ |
| 161 | 回复存在链接的消息 |

### 群文件类（msgType=3）

| subMsgType | 消息类型 |
|:---|:---|
| 1 | 其他类型 |
| 2 | 图片（png, jpg） |
| 4 | 视频 |
| 8 | 音频（mp3, flac） |
| 16 | docx |
| 32 | pptx |
| 64 | xlsx |
| 512 | zip |
| 2048 | exe |

### 其他组合

| msgType | subMsgType | 消息类型 |
|:---|:---|:---|
| 0 | 0 | 空消息 |
| 1 | 0 | 已撤回消息 |
| 5 | 4 | 撤回消息提醒 |
| 5 | 12 | 拍一拍 |
| 6 | 0 | AMR 语音文件 |
| 7 | 0 | 视频文件 |
| 8 | 0 | 合并转发 |
| 10 | 0 | 红包 |
| 11 | 0 | 应用消息（如小程序） |
| 11 | 3 | 群公告 |
| 17 | 8 | 表情包 / 原创表情 |
| 2 | 2 | 收藏表情 |

---

## 5. 附录

### 表情编号
- 表态表情编号与 [QQBot 表情模型](https://bot.q.qq.com/wiki/develop/api/openapi/emoji/model.html) 对应
- 超级表情不在此列表中

### 封面路径
- 视频封面位于半私有目录：`/Tencent/MobileQQ/shortvideo/thumbs/`
