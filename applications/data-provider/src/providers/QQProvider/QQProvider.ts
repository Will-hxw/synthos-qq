import "reflect-metadata";
import { injectable, inject } from "tsyringe";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";
import { RawChatMessage } from "@root/common/contracts/data-provider/index";
import Logger from "@root/common/util/Logger";
import { PromisifiedSQLite } from "@root/common/util/promisify/PromisifiedSQLite";
import ErrorReasons from "@root/common/contracts/ErrorReasons";
import { ASSERT_NOT_FATAL } from "@root/common/util/ASSERT";
import { Disposable } from "@root/common/util/lifecycle/Disposable";
import { mustInitBeforeUse } from "@root/common/util/lifecycle/mustInitBeforeUse";
import sqlite3 from "@journeyapps/sqlcipher";

import { IIMProvider } from "../contracts/IIMProvider";
import { COMMON_TOKENS } from "../../di/tokens";

import { GroupMsgColumn as GMC } from "./@types/mappers/GroupMsgColumn";
import { RawGroupMsgFromDB } from "./@types/RawGroupMsgFromDB";
import { MessagePBParser } from "./parsers/MessagePBParser";
import { MsgElementType } from "./@types/mappers/MsgElementType";
import { MsgElement } from "./@types/RawMsgContentParseResult";
import { MsgType } from "./@types/mappers/MsgType";

sqlite3.verbose();

/**
 * QQ 消息提供者
 * 负责从 QQNT 数据库中读取消息数据
 */
@injectable()
@mustInitBeforeUse
export class QQProvider extends Disposable implements IIMProvider {
    private db: PromisifiedSQLite | null = null;
    private LOGGER = Logger.withTag("QQProvider");
    private messagePBParser = this._registerDisposable(new MessagePBParser());

    /**
     * 构造函数
     * @param configManagerService 配置管理服务
     */
    public constructor(
        @inject(COMMON_TOKENS.ConfigManagerService) private configManagerService: ConfigManagerService
    ) {
        super();
    }

    /**
     * 初始化 QQ 消息提供者
     */
    public async init() {
        const config = (await this.configManagerService.getCurrentConfig()).dataProviders.QQ;
        // 1. 创建一个临时内存数据库（仅用于加载扩展）
        const tempDb = new PromisifiedSQLite(sqlite3);

        await tempDb.open(":memory:"); // 内存数据库，瞬间打开
        // 2. 通过这个临时连接加载扩展 → 全局注册 offset_vfs
        await tempDb.loadExtension(config.VFSExtPath);
        // 3. 关闭临时数据库
        await tempDb.dispose();

        const dbPath = config.dbBasePath + "/nt_msg.db";
        // 打开QQNT数据库（原地读取，不复制）
        // @see https://docs.aaqwq.top/decrypt/decode_db.html#%E9%80%9A%E7%94%A8%E9%85%8D%E7%BD%AE%E9%80%89%E9%A1%B9
        const db = new PromisifiedSQLite(sqlite3);

        await db.open(dbPath);
        this.db = this._registerDisposable(db);

        // 加密相关配置
        await db.exec(`
            PRAGMA key = '${config.dbKey}';
            PRAGMA cipher_page_size = 4096;
            PRAGMA kdf_iter = 4000;
            PRAGMA cipher_hmac_algorithm = HMAC_SHA1;
            PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512;
        `);

        // 尝试读取数据库表数量，看看解密是否成功
        const sql = `SELECT count(*) FROM sqlite_master`;
        const stmt = await db.prepare(sql);
        const result = await stmt.get();

        this.LOGGER.success(`解密成功，数据库表数量: ${result["count(*)"]}`);
        await stmt.finalize();

        // 初始化消息解析器
        await this.messagePBParser.init();

        this.LOGGER.success("初始化完成！");
    }

    /**
     * 获取数据库补丁SQL
     * @returns 数据库补丁SQL
     */
    private async _getPatchSQL() {
        const qqConfig = (await this.configManagerService.getCurrentConfig()).dataProviders.QQ;
        const patchSQL = qqConfig.dbPatch.enabled ? `(${qqConfig.dbPatch.patchSQL})` : "1 = 1";

        return patchSQL;
    }

    private async _parseMessageContent(rawMsgElements: MsgElement[]): Promise<string> {
        let result = "";

        for (const rawMsgElement of rawMsgElements) {
            switch (rawMsgElement.elementType) {
                case MsgElementType.TEXT: {
                    result += rawMsgElement.messageText;
                    break;
                }
                case MsgElementType.EMOJI: {
                    if (rawMsgElement.emojiText) {
                        result += `[${rawMsgElement.emojiText}]`;
                    }
                    break;
                }
                case MsgElementType.EMOJI_NEW: {
                    if (rawMsgElement.emojiText) {
                        result += `[${rawMsgElement.emojiText}]`;
                    }
                    break;
                }
                case MsgElementType.IMAGE: {
                    if (rawMsgElement.imageText) {
                        result += `[图片文字：${this._normalizeInlineText(rawMsgElement.imageText)}]`;
                    } else {
                        result += this._formatImageMessage(rawMsgElement);
                    }
                    break;
                }
                case MsgElementType.VOICE: {
                    result += this._formatVoiceMessage(rawMsgElement);
                    break;
                }
                case MsgElementType.FILE: {
                    result += this._formatFileMessage(rawMsgElement);
                    break;
                }
                case MsgElementType.VIDEO: {
                    result += this._formatVideoMessage(rawMsgElement);
                    break;
                }
                case MsgElementType.REPLY: {
                    const replyContent = this._normalizeInlineText(rawMsgElement.replyMsgContent);

                    if (replyContent) {
                        result += `[引用消息：${replyContent}]`;
                    }
                    break;
                }
                case MsgElementType.SYSTEM_NOTICE: {
                    result += this._formatSystemNoticeMessage(rawMsgElement);
                    break;
                }
                case MsgElementType.CARD: {
                    result += this._formatStructuredMessage("卡片消息", rawMsgElement.applicationMessage);
                    break;
                }
                case MsgElementType.XML: {
                    result += this._formatStructuredMessage("XML消息", rawMsgElement.xmlMessage);
                    break;
                }
                case MsgElementType.CALL: {
                    result += this._formatCallMessage(rawMsgElement);
                    break;
                }
                case MsgElementType.FEED: {
                    result += this._formatFeedMessage(rawMsgElement);
                    break;
                }
                default: {
                    const fallback = this._formatUnknownMessage(rawMsgElement);

                    if (fallback) {
                        result += fallback;
                    } else {
                        this.LOGGER.debug(`未知的element类型: ${rawMsgElement.elementType}，忽略该element。`);
                    }
                    break;
                }
            }
        }

        return result;
    }

    private _formatImageMessage(element: MsgElement): string {
        const parts: string[] = [];

        if (element.picType === 2000) {
            parts.push("GIF");
        } else if (element.picType === 1000) {
            parts.push("静态图");
        }

        if (element.picWidth > 0 && element.picHeight > 0) {
            parts.push(`尺寸：${element.picWidth}x${element.picHeight}`);
        }

        const md5 = this._normalizeInlineText(element.originImageMd5);

        if (md5) {
            parts.push(`MD5：${this._truncateText(md5, 12)}`);
        }

        if (this._normalizeInlineText(element.imageUrlOrigin || element.imageUrlHigh || element.imageUrlLow)) {
            parts.push("含图片链接");
        }

        if (parts.length === 0) {
            parts.push("暂无文字描述");
        }

        return this._buildBracketedMessage("图片", parts);
    }

    private _formatVoiceMessage(element: MsgElement): string {
        const pttText = this._normalizeInlineText(element.pttText);

        if (pttText) {
            return `[语音转文字：${pttText}]`;
        }

        const parts: string[] = [];

        if (element.duration > 0) {
            parts.push(`时长：${element.duration}秒`);
        }

        if (parts.length === 0) {
            parts.push("暂无转文字");
        }

        return this._buildBracketedMessage("语音", parts);
    }

    private _formatFileMessage(element: MsgElement): string {
        const parts: string[] = [];
        const fileName = this._normalizeInlineText(element.fileName);
        const fileSize = this._formatFileSize(element.fileSize);

        if (fileName) {
            parts.push(`文件名：${fileName}`);
        }

        if (fileSize) {
            parts.push(`大小：${fileSize}`);
        }

        if (!fileName) {
            const fileUuid = this._normalizeInlineText(element.fileUuid);

            if (fileUuid) {
                parts.push(`文件ID：${this._truncateText(fileUuid, 16)}`);
            }
        }

        if (parts.length === 0) {
            parts.push("未知文件");
        }

        return this._buildBracketedMessage("文件", parts);
    }

    private _formatVideoMessage(element: MsgElement): string {
        const parts: string[] = [];

        if (element.videotime > 0) {
            parts.push(`时长：${element.videotime}秒`);
        }

        if (element.thumbWidth > 0 && element.thumbHeight > 0) {
            parts.push(`封面尺寸：${element.thumbWidth}x${element.thumbHeight}`);
        }

        const thumbName = this._normalizeInlineText(element.thumbfilename);

        if (thumbName) {
            parts.push(`封面：${thumbName}`);
        }

        if (parts.length === 0) {
            parts.push("暂无文字描述");
        }

        return this._buildBracketedMessage("视频", parts);
    }

    private _formatSystemNoticeMessage(element: MsgElement): string {
        const parts = [
            this._normalizeInlineText(element.noticeInfo),
            this._normalizeInlineText(element.noticeInfo2),
            this._normalizeInlineText(element.withdrawSuffix)
        ].filter(Boolean);

        return parts.length > 0 ? this._buildBracketedMessage("系统消息", parts) : "";
    }

    private _formatCallMessage(element: MsgElement): string {
        const parts = [
            this._normalizeInlineText(element.callStatusText),
            this._normalizeInlineText(element.callText)
        ].filter(Boolean);

        return parts.length > 0 ? this._buildBracketedMessage("通话消息", parts) : "";
    }

    private _formatFeedMessage(element: MsgElement): string {
        const parts = [
            this._normalizeInlineText(element.feedTitle?.text),
            this._normalizeInlineText(element.feedContent?.text),
            this._normalizeInlineText(element.feedUrl)
        ].filter(Boolean);

        return parts.length > 0 ? this._buildBracketedMessage("动态消息", parts) : "";
    }

    private _formatStructuredMessage(kind: string, rawContent: string): string {
        const structuredText = this._extractStructuredText(rawContent);

        if (!structuredText) {
            return this._buildBracketedMessage(kind, ["暂无可读文本"]);
        }

        return this._buildBracketedMessage(kind, [structuredText]);
    }

    private _formatUnknownMessage(element: MsgElement): string {
        const parts = [
            this._normalizeInlineText(element.messageText),
            this._normalizeInlineText(element.applicationMessage),
            this._normalizeInlineText(element.xmlMessage),
            this._normalizeInlineText(element.noticeInfo),
            this._normalizeInlineText(element.feedTitle?.text),
            this._normalizeInlineText(element.feedContent?.text)
        ].filter(Boolean);

        return parts.length > 0 ? this._buildBracketedMessage(`未知消息${element.elementType}`, parts) : "";
    }

    private _extractStructuredText(rawContent: string): string {
        const normalized = this._normalizeInlineText(rawContent);

        if (!normalized) {
            return "";
        }

        try {
            const parsed = JSON.parse(rawContent);
            const values: string[] = [];

            this._collectStructuredStrings(parsed, values);

            if (values.length > 0) {
                return values.slice(0, 6).join("；");
            }
        } catch {
            // 非 JSON 时继续按文本/XML 兜底处理。
        }

        return this._truncateText(this._stripXmlTags(normalized), 200);
    }

    private _collectStructuredStrings(value: unknown, values: string[]): void {
        if (values.length >= 6 || value === null || value === undefined) {
            return;
        }

        if (typeof value === "string") {
            const normalized = this._normalizeInlineText(value);

            if (normalized) {
                values.push(this._truncateText(normalized, 80));
            }

            return;
        }

        if (typeof value !== "object") {
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                this._collectStructuredStrings(item, values);
            }

            return;
        }

        for (const item of Object.values(value as Record<string, unknown>)) {
            this._collectStructuredStrings(item, values);
        }
    }

    private _stripXmlTags(value: string): string {
        let result = "";
        let inTag = false;

        for (const char of value) {
            if (char === "<") {
                inTag = true;
                result += " ";
                continue;
            }

            if (char === ">") {
                inTag = false;
                result += " ";
                continue;
            }

            if (!inTag) {
                result += char;
            }
        }

        return this._normalizeInlineText(result);
    }

    private _formatFileSize(value: string): string {
        const bytes = Number(value);

        if (!Number.isFinite(bytes) || bytes <= 0) {
            return "";
        }

        if (bytes >= 1024 * 1024) {
            return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
        }

        if (bytes >= 1024) {
            return `${(bytes / 1024).toFixed(1)}KB`;
        }

        return `${bytes}B`;
    }

    private _buildBracketedMessage(kind: string, parts: string[]): string {
        const normalizedParts = parts.map(part => this._normalizeInlineText(part)).filter(Boolean);

        return `[${[kind, ...normalizedParts].join("，")}]`;
    }

    private _normalizeInlineText(value: unknown): string {
        if (typeof value !== "string") {
            return "";
        }

        let result = "";
        let hasPendingSpace = false;

        for (const char of value.trim()) {
            if (char === " " || char === "\n" || char === "\r" || char === "\t") {
                hasPendingSpace = result.length > 0;
                continue;
            }

            if (hasPendingSpace) {
                result += " ";
                hasPendingSpace = false;
            }

            result += char;
        }

        return result.trim();
    }

    private _truncateText(value: string, maxLength: number): string {
        if (value.length <= maxLength) {
            return value;
        }

        return `${value.slice(0, maxLength)}...`;
    }

    /**
     * 从QQNT数据库中获取指定时间范围内的消息
     * @param timeStart 开始时间（毫秒级时间戳）
     * @param timeEnd 结束时间（毫秒级时间戳）
     * @param groupId 群号（可选）
     * @returns 消息数组
     */
    public async getMsgByTimeRange(
        timeStart: number,
        timeEnd: number,
        groupId: string = ""
    ): Promise<RawChatMessage[]> {
        if (this.db) {
            // 转换为秒级时间戳
            timeStart = Math.floor(timeStart / 1000);
            timeEnd = Math.ceil(timeEnd / 1000);
            // 生成SQL语句
            const sql = `
                SELECT 
                    CAST("${GMC.msgId}" AS TEXT) AS "${GMC.msgId}",
                    "${GMC.msgTime}",
                    "${GMC.groupUin}",
                    "${GMC.peeruin}",
                    "${GMC.senderUin}",
                    "${GMC.replyMsgSeq}",
                    "${GMC.msgContent}",
                    "${GMC.sendMemberName}",
                    "${GMC.sendNickName}",
                    "${GMC.msgType}",
                    "${GMC.extraData}"
                FROM group_msg_table 
                WHERE ${await this._getPatchSQL()} 
                AND ("${GMC.msgTime}" BETWEEN ${timeStart} AND ${timeEnd})
                ${groupId ? `AND "${GMC.peeruin}" = ?` : ""}
            `;

            this.LOGGER.debug(`执行的SQL: ${sql}`);
            const results = await this.db.all(sql, groupId ? [groupId] : []);

            this.LOGGER.debug(`结果数量: ${results.length}`);

            // 解析查询到的全部消息内容
            const messages: RawChatMessage[] = [];
            let skippedInvalidProtobufCount = 0;
            let skippedEmptyQuotedContentCount = 0;
            let skippedInvalidQuotedProtobufCount = 0;

            for (const result of results) {
                // 生成消息对象
                const processedMsg: RawChatMessage = {
                    msgId: String(result[GMC.msgId]),
                    messageContent: "",
                    groupId: String(result[GMC.groupUin] || result[GMC.peeruin]),
                    timestamp: result[GMC.msgTime] * 1000, // 转换为毫秒级时间戳
                    senderId: String(result[GMC.senderUin]),
                    senderGroupNickname: result[GMC.sendMemberName],
                    senderNickname: result[GMC.sendNickName]
                };

                // 处理引用消息，首先尝试获取被引用消息的消息正文而不是id，减少一次开销极大的数据库查询，极大提升性能
                if (result[GMC.msgType] === MsgType.REPLY) {
                    this.LOGGER.debug(`这是一条引用消息！`);
                    // replyMsgSeq 为 0/缺失属于异常数据，但不应终止整批摄取，仅记录后按普通消息处理
                    ASSERT_NOT_FATAL(
                        !!result[GMC.replyMsgSeq],
                        "MsgType为REPLY时，对应的replyMsgSeq应该也是有效的"
                    );
                    try {
                        // protobufjs toObject(defaults:true) 对缺失的 message 字段置为 null，
                        // 当 extraData 能解码但不含 extraMessage 子消息时，直接取 .messages 会抛 TypeError，
                        // 这里显式判空并归类为空引用内容，避免一条坏数据冒泡崩整批摄取。
                        const extraMessage = this.messagePBParser.parseMessageSegment(
                            result[GMC.extraData]
                        ).extraMessage;

                        if (!extraMessage || !extraMessage.messages) {
                            skippedEmptyQuotedContentCount++;
                            throw ErrorReasons.EMPTY_VALUE_ERROR;
                        }

                        const quotedMsgContent = await this._parseMessageContent(extraMessage.messages);

                        if (!quotedMsgContent) {
                            skippedEmptyQuotedContentCount++;
                            throw ErrorReasons.EMPTY_VALUE_ERROR;
                        }
                        processedMsg.quotedMsgContent = quotedMsgContent;
                    } catch (error) {
                        if (error === ErrorReasons.EMPTY_VALUE_ERROR || error === ErrorReasons.PROTOBUF_ERROR) {
                            if (error === ErrorReasons.PROTOBUF_ERROR) {
                                skippedInvalidQuotedProtobufCount++;
                            }
                        } else {
                            throw error;
                        }
                    }
                }

                // 获取消息正文：解析40800中的所有element（或者叫做fragment）
                try {
                    processedMsg.messageContent = await this._parseMessageContent(
                        this.messagePBParser.parseMessageSegment(result[GMC.msgContent]).messages
                    );
                } catch (error) {
                    if (error === ErrorReasons.PROTOBUF_ERROR) {
                        skippedInvalidProtobufCount++;
                        continue;
                    }

                    throw error;
                }
                if (processedMsg.messageContent === "" && !processedMsg.quotedMsgContent) {
                    this.LOGGER.debug(
                        `msgId: ${result[GMC.msgId]}的消息内容为空，忽略该消息。
                        发送者: ${this._getSenderDisplayName(result)}`
                    );
                } else {
                    messages.push(processedMsg);
                }
            }
            if (skippedEmptyQuotedContentCount > 0) {
                this.LOGGER.warning(`跳过 ${skippedEmptyQuotedContentCount} 条引用消息内容为空的消息引用。`);
            }
            if (skippedInvalidQuotedProtobufCount > 0) {
                this.LOGGER.warning(
                    `跳过 ${skippedInvalidQuotedProtobufCount} 条引用消息正文解析失败的消息引用。`
                );
            }
            if (skippedInvalidProtobufCount > 0) {
                this.LOGGER.warning(`跳过 ${skippedInvalidProtobufCount} 条消息正文解析失败的消息。`);
            }

            return messages;
        } else {
            throw ErrorReasons.UNINITIALIZED_ERROR;
        }
    }

    /**
     * 获取可用于诊断日志的发送者显示名。
     * @param result QQNT 原始消息行
     * @returns 优先群名片，其次昵称，最后空字符串
     */
    private _getSenderDisplayName(result: RawGroupMsgFromDB): string {
        const groupNickname = result[GMC.sendMemberName];

        if (typeof groupNickname === "string" && groupNickname.length > 0) {
            return groupNickname;
        }

        const nickname = result[GMC.sendNickName];

        if (typeof nickname === "string" && nickname.length > 0) {
            return nickname;
        }

        return "";
    }
}
