import "reflect-metadata";
import { injectable, container } from "tsyringe";

import {
    ChatMessageMedia,
    ProcessedChatMessage,
    RawChatMessage,
    RawChatMessageMedia,
    ProcessedChatMessageWithRawMessage
} from "../../contracts/data-provider/index";
import Logger from "../../util/Logger";
import { Disposable } from "../../util/lifecycle/Disposable";
import { mustInitBeforeUse } from "../../util/lifecycle/mustInitBeforeUse";
import { COMMON_TOKENS } from "../../di/tokens";

import { createIMDBTableSQL } from "./constants/InitialSQL";
import { AIDIGEST_SESSION_STALE_MS } from "./constants/AIDigestSessionConstants";
import { CommonDBService } from "./infra/CommonDBService";

export interface MessageRangeStats {
    groupId: string;
    count: number;
    timeStart: number;
    timeEnd: number;
}

export interface SessionStats {
    sessionId: string;
    messageCount: number;
    timeStart: number;
    timeEnd: number;
}

export interface ActiveDigestSessionBlockStats {
    status: string;
    sessionCount: number;
    messageCount: number;
    earliestRetryTime: number;
    latestUpdateTime: number;
}

export interface DigestCoverageRawMessageStats {
    messageCount: number;
    assignedMessageCount: number;
    unassignedMessageCount: number;
    assignedSessionCount: number;
    timeStart: number | null;
    timeEnd: number | null;
    unassignedTimeStart: number | null;
    unassignedTimeEnd: number | null;
}

export interface DigestCoverageSessionStats {
    sessionId: string;
    messageCount: number;
    timeStart: number;
    timeEnd: number;
    status: string | null;
    updateTime: number | null;
    processingStartedAt: number | null;
    failReason: string | null;
    statusTopicCount: number | null;
    resultTopicCount: number;
}

export interface DigestCoverageUnassignedMessageSample {
    msgId: string;
    timestamp: number;
    senderId: string | null;
    senderNickname: string | null;
    messageContent: string | null;
}

export interface DigestCoverageSnapshot {
    rawMessageStats: DigestCoverageRawMessageStats;
    sessions: DigestCoverageSessionStats[];
    unassignedMessageSamples: DigestCoverageUnassignedMessageSample[];
}

export interface PendingChatMessageMedia extends ChatMessageMedia {
    messageContent: string | null;
}

export interface ChatMessageMediaUpdate {
    status: ChatMessageMedia["status"];
    ocrText?: string | null;
    visionDescription?: string | null;
    imageCategory?: string | null;
    understandingText?: string | null;
    failReason?: string | null;
    ocrEngine?: number | null;
    modelName?: string | null;
    incrementRetryCount?: boolean;
}

/**
 * IM 消息数据库访问服务
 * 负责聊天消息的存储和查询
 */
@injectable()
@mustInitBeforeUse
export class ImDbAccessService extends Disposable {
    private LOGGER = Logger.withTag("ImDbAccessService");
    private db: CommonDBService | null = null;

    /**
     * 初始化数据库服务
     */
    public async init() {
        // 从 DI 容器获取 CommonDBService 实例
        this.db = container.resolve<CommonDBService>(COMMON_TOKENS.CommonDBService);
        await this.db.init(createIMDBTableSQL);
    }

    public async storeRawChatMessage(msg: RawChatMessage) {
        await this.db.run("BEGIN IMMEDIATE TRANSACTION");
        try {
            await this.db.run(
                `INSERT INTO chat_messages (
                    msgId, messageContent, groupId, timestamp, senderId, senderGroupNickname, senderNickname, quotedMsgId, quotedMsgContent
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(msgId) DO NOTHING`,
                [
                    msg.msgId,
                    msg.messageContent,
                    msg.groupId,
                    msg.timestamp,
                    msg.senderId,
                    msg.senderGroupNickname,
                    msg.senderNickname,
                    msg.quotedMsgId,
                    msg.quotedMsgContent
                ]
            );
            await this._storeRawChatMediaItems(msg.mediaItems || []);
            await this.db.run("COMMIT");
        } catch (err) {
            await this.db.run("ROLLBACK");
            throw err;
        }
    }

    public async storeRawChatMessages(messages: RawChatMessage[]) {
        if (messages.length === 0) return;

        // 计算每批大小（每条消息9个参数，SQLite 默认最大999参数）
        const MAX_SQLITE_PARAMS = 999;
        const paramsPerRecord = 9;
        const batchSize = Math.min(100, Math.floor(MAX_SQLITE_PARAMS / paramsPerRecord));

        // 构建基础SQL模板（带冲突处理）
        const baseSql = `
        INSERT INTO chat_messages (
            msgId, messageContent, groupId, timestamp, senderId,
            senderGroupNickname, senderNickname, quotedMsgId, quotedMsgContent
        ) VALUES ${Array(batchSize).fill("(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
        ON CONFLICT(msgId) DO NOTHING
    `.trim();

        // 开始事务
        await this.db.run("BEGIN IMMEDIATE TRANSACTION");

        try {
            for (let i = 0; i < messages.length; i += batchSize) {
                const batch = messages.slice(i, i + batchSize);

                // 动态生成当前批次的SQL（处理最后一批不足batchSize的情况）
                const currentBatchSize = batch.length;
                const sql =
                    currentBatchSize === batchSize
                        ? baseSql
                        : baseSql.replace(
                              Array(batchSize).fill("(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", "),
                              Array(currentBatchSize).fill("(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")
                          );

                // 收集参数
                const params: any[] = [];

                batch.forEach(msg => {
                    params.push(
                        msg.msgId,
                        msg.messageContent,
                        msg.groupId,
                        msg.timestamp,
                        msg.senderId,
                        msg.senderGroupNickname,
                        msg.senderNickname,
                        msg.quotedMsgId,
                        msg.quotedMsgContent
                    );
                });

                // 执行批量插入
                await this.db.run(sql, params);
                await this._storeRawChatMediaItems(batch.flatMap(msg => msg.mediaItems || []));
            }

            // 提交事务
            await this.db.run("COMMIT");
        } catch (err) {
            // 出错时回滚
            await this.db.run("ROLLBACK");
            this.LOGGER.error(`Failed to store messages batch: ${err.message}`);
            throw new Error(`Failed to store messages batch: ${err.message}`);
        }
    }

    /**
     * 批量写入聊天消息中的媒体元信息。
     * @param mediaItems 待写入的媒体元信息列表
     */
    private async _storeRawChatMediaItems(mediaItems: RawChatMessageMedia[]): Promise<void> {
        if (mediaItems.length === 0) {
            return;
        }

        const now = Date.now();

        for (const media of mediaItems) {
            const hasSourceUrl = typeof media.sourceUrl === "string" && media.sourceUrl.trim().length > 0;

            await this.db.run(
                `INSERT INTO chat_message_media (
                    mediaId, msgId, groupId, timestamp, elementIndex, mediaType, sourceProvider,
                    sourceUrl, width, height, picType, originImageMd5, qqImageText,
                    status, retryCount, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(mediaId) DO NOTHING`,
                [
                    media.mediaId,
                    media.msgId,
                    media.groupId,
                    media.timestamp,
                    media.elementIndex,
                    media.mediaType,
                    media.sourceProvider,
                    media.sourceUrl || null,
                    media.width ?? null,
                    media.height ?? null,
                    media.picType ?? null,
                    media.originImageMd5 || null,
                    media.qqImageText || null,
                    hasSourceUrl ? "pending" : "skipped",
                    0,
                    now,
                    now
                ]
            );
        }
    }

    /**
     * 获取当前时间范围内待图片理解处理的媒体记录。
     * @param groupIds 群组ID列表
     * @param timeStart 起始时间戳
     * @param timeEnd 结束时间戳
     * @param limit 数量上限
     * @returns 待处理媒体记录
     */
    public async getPendingImageMediaByGroupIdsAndTimeRange(
        groupIds: string[],
        timeStart: number,
        timeEnd: number,
        limit: number
    ): Promise<PendingChatMessageMedia[]> {
        const uniqueGroupIds = [...new Set(groupIds)];

        if (uniqueGroupIds.length === 0) {
            return [];
        }

        const resolvedLimit = Math.max(1, Math.floor(limit));
        const placeholders = uniqueGroupIds.map(() => "?").join(", ");

        return await this.db.all<PendingChatMessageMedia>(
            `SELECT m.*, c.messageContent AS messageContent
             FROM chat_message_media m
             INNER JOIN chat_messages c ON c.msgId = m.msgId
             WHERE m.groupId IN (${placeholders})
               AND m.timestamp BETWEEN ? AND ?
               AND m.createdAt >= ?
               AND m.mediaType = 'image'
               AND m.status = 'pending'
             ORDER BY m.timestamp ASC, m.msgId ASC, m.elementIndex ASC
             LIMIT ?`,
            [...uniqueGroupIds, timeStart, timeEnd, timeStart, resolvedLimit]
        );
    }

    /**
     * 按 msgId 批量读取媒体记录。
     * @param msgIds 消息ID列表
     * @returns 按 msgId 分组的媒体记录
     */
    public async getChatMessageMediaByMsgIds(msgIds: string[]): Promise<Map<string, ChatMessageMedia[]>> {
        const mediaMap = new Map<string, ChatMessageMedia[]>();

        if (msgIds.length === 0) {
            return mediaMap;
        }

        const uniqueMsgIds = [...new Set(msgIds)];
        const MAX_SQLITE_PARAMS = 999;

        for (let i = 0; i < uniqueMsgIds.length; i += MAX_SQLITE_PARAMS) {
            const batch = uniqueMsgIds.slice(i, i + MAX_SQLITE_PARAMS);
            const placeholders = batch.map(() => "?").join(", ");
            const rows = await this.db.all<ChatMessageMedia>(
                `SELECT *
                 FROM chat_message_media
                 WHERE msgId IN (${placeholders})
                 ORDER BY timestamp ASC, msgId ASC, elementIndex ASC`,
                batch
            );

            for (const row of rows) {
                if (!mediaMap.has(row.msgId)) {
                    mediaMap.set(row.msgId, []);
                }

                mediaMap.get(row.msgId)!.push(row);
            }
        }

        return mediaMap;
    }

    /**
     * 更新图片理解处理结果。
     * @param mediaId 媒体ID
     * @param update 更新内容
     */
    public async updateChatMessageMediaUnderstanding(
        mediaId: string,
        update: ChatMessageMediaUpdate
    ): Promise<void> {
        await this.db.run(
            `UPDATE chat_message_media
             SET status = ?,
                 ocrText = ?,
                 visionDescription = ?,
                 imageCategory = ?,
                 understandingText = ?,
                 failReason = ?,
                 ocrEngine = ?,
                 modelName = ?,
                 retryCount = retryCount + ?,
                 updatedAt = ?
             WHERE mediaId = ?`,
            [
                update.status,
                update.ocrText ?? null,
                update.visionDescription ?? null,
                update.imageCategory ?? null,
                update.understandingText ?? null,
                update.failReason ?? null,
                update.ocrEngine ?? null,
                update.modelName ?? null,
                update.incrementRetryCount ? 1 : 0,
                Date.now(),
                mediaId
            ]
        );
    }

    /**
     * 获取已入库的原始消息 msgId 集合。
     * @param msgIds 待对账的消息 ID 列表
     * @returns 已存在于主库的消息 ID 集合
     */
    public async getExistingRawChatMessageIds(msgIds: string[]): Promise<Set<string>> {
        const existingMsgIds = new Set<string>();

        if (msgIds.length === 0) {
            return existingMsgIds;
        }

        const MAX_SQLITE_PARAMS = 999;

        for (let i = 0; i < msgIds.length; i += MAX_SQLITE_PARAMS) {
            const batch = msgIds.slice(i, i + MAX_SQLITE_PARAMS);
            const placeholders = batch.map(() => "?").join(", ");
            const rows = await this.db.all<{ msgId: string }>(
                `SELECT msgId FROM chat_messages WHERE msgId IN (${placeholders})`,
                batch
            );

            for (const row of rows) {
                existingMsgIds.add(row.msgId);
            }
        }

        return existingMsgIds;
    }

    /**
     * 获取指定群组在指定时间范围内的所有消息
     * @param groupId 群组ID
     * @param timeStart 起始时间戳
     * @param timeEnd 结束时间戳
     * @returns 消息列表 ！！！已经按照时间从早到晚排序
     */
    public async getRawChatMessagesByGroupIdAndTimeRange(
        groupId: string,
        timeStart: number,
        timeEnd: number
    ): Promise<RawChatMessage[]> {
        const results = await this.db.all<RawChatMessage>(
            `SELECT * FROM chat_messages WHERE groupId = ? AND (timestamp BETWEEN ? AND ?)`,
            [groupId, timeStart, timeEnd]
        );

        // 按照时间从早到晚排序
        results.sort((a, b) => a.timestamp - b.timestamp);

        return results;
    }

    /**
     * 获取指定群组在指定时间范围内的所有消息，包含预处理后的消息
     * @param groupId 群组ID
     * @param timeStart 起始时间戳
     * @param timeEnd 结束时间戳
     * @returns 消息列表 ！！！已经按照时间从早到晚排序
     */
    public async getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange(
        groupId: string,
        timeStart: number,
        timeEnd: number
    ): Promise<ProcessedChatMessageWithRawMessage[]> {
        const results = await this.db.all<ProcessedChatMessageWithRawMessage>(
            `SELECT * FROM chat_messages WHERE groupId = ? AND (timestamp BETWEEN ? AND ?)`,
            [groupId, timeStart, timeEnd]
        );

        // 按照时间从早到晚排序
        results.sort((a, b) => a.timestamp - b.timestamp);

        return results;
    }

    public async getSessionIdsByGroupIdAndTimeRange(
        groupId: string,
        timeStart: number,
        timeEnd: number
    ): Promise<string[]> {
        const results = await this.db.all<{ sessionId: string }>(
            `SELECT DISTINCT sessionId FROM chat_messages WHERE groupId =? AND (timestamp BETWEEN? AND?) AND sessionId IS NOT NULL`,
            [groupId, timeStart, timeEnd]
        );

        return results.map(r => r.sessionId);
    }

    /**
     * 批量获取多个群组在指定时间范围内命中的 sessionId。
     * @param groupIds 群组ID列表
     * @param timeStart 起始时间戳
     * @param timeEnd 结束时间戳
     * @returns 按输入群组顺序返回的 sessionId 列表
     */
    public async getSessionIdsByGroupIdsAndTimeRange(
        groupIds: string[],
        timeStart: number,
        timeEnd: number
    ): Promise<{ groupId: string; sessionIds: string[] }[]> {
        if (groupIds.length === 0) {
            return [];
        }

        const uniqueGroupIds = Array.from(new Set(groupIds));
        const placeholders = uniqueGroupIds.map(() => "?").join(", ");
        const rows = await this.db.all<{ groupId: string; sessionId: string }>(
            `SELECT DISTINCT groupId, sessionId
             FROM chat_messages
             WHERE groupId IN (${placeholders})
               AND (timestamp BETWEEN ? AND ?)
               AND sessionId IS NOT NULL`,
            [...uniqueGroupIds, timeStart, timeEnd]
        );
        const sessionMap = new Map<string, string[]>();

        for (const groupId of uniqueGroupIds) {
            sessionMap.set(groupId, []);
        }

        for (const row of rows) {
            sessionMap.get(row.groupId)?.push(row.sessionId);
        }

        return groupIds.map(groupId => ({
            groupId,
            sessionIds: sessionMap.get(groupId) || []
        }));
    }

    /**
     * 获取指定会话的开始和结束时间
     * @param sessionId 会话ID
     * @returns 时间戳对象 { timeStart: 开始时间, timeEnd: 结束时间 } 或者 null 如果会话不存在
     */
    public async getSessionTimeDuration(
        sessionId: string
    ): Promise<{ timeStart: number; timeEnd: number } | null> {
        const results = await this.db.all<{ timeStart: number | null; timeEnd: number | null }>(
            `SELECT MIN(timestamp) AS timeStart, MAX(timestamp) AS timeEnd FROM chat_messages WHERE sessionId = ?`,
            [sessionId]
        );

        // 过滤掉全 null 的行
        const validResults = results.filter(r => r.timeStart !== null && r.timeEnd !== null);

        if (validResults.length === 0) {
            return null;
        }

        const timeStart = validResults[0].timeStart!;
        const timeEnd = validResults[0].timeEnd!;

        return { timeStart, timeEnd };
    }

    /**
     * 批量获取多个会话的开始和结束时间。
     * 用单条 GROUP BY 聚合替代逐 sessionId 查询，避免 N+1 往返。
     * @param sessionIds 会话ID数组
     * @returns 每个会话的时间范围；不存在消息的会话 timeStart/timeEnd 为 undefined
     */
    public async getSessionTimeDurations(
        sessionIds: string[]
    ): Promise<Array<{ sessionId: string; timeStart: number | undefined; timeEnd: number | undefined }>> {
        if (sessionIds.length === 0) {
            return [];
        }

        const MAX_SQLITE_PARAMS = 999;
        const durationMap = new Map<string, { timeStart: number; timeEnd: number }>();

        for (let i = 0; i < sessionIds.length; i += MAX_SQLITE_PARAMS) {
            const batch = sessionIds.slice(i, i + MAX_SQLITE_PARAMS);
            const placeholders = batch.map(() => "?").join(",");
            const rows = await this.db.all<{
                sessionId: string;
                timeStart: number | null;
                timeEnd: number | null;
            }>(
                `SELECT sessionId, MIN(timestamp) AS timeStart, MAX(timestamp) AS timeEnd
                 FROM chat_messages
                 WHERE sessionId IN (${placeholders})
                 GROUP BY sessionId`,
                batch
            );

            for (const row of rows) {
                if (row.timeStart !== null && row.timeEnd !== null) {
                    durationMap.set(row.sessionId, { timeStart: row.timeStart, timeEnd: row.timeEnd });
                }
            }
        }

        // 按入参顺序返回，缺失的会话以 undefined 占位，保持与旧逐条实现一致的结构
        return sessionIds.map(sessionId => {
            const duration = durationMap.get(sessionId);

            return {
                sessionId,
                timeStart: duration?.timeStart,
                timeEnd: duration?.timeEnd
            };
        });
    }

    /**
     * 获取指定群组中尚未分配 sessionId 的消息统计。
     * @param groupId 群组ID
     * @returns 未处理消息的数量和时间范围
     */
    public async getUnprocessedMessageStatsByGroupId(groupId: string): Promise<MessageRangeStats | null> {
        const result = await this.db.get<{
            count: number;
            timeStart: number | null;
            timeEnd: number | null;
        }>(
            `SELECT COUNT(*) AS count, MIN(timestamp) AS timeStart, MAX(timestamp) AS timeEnd
             FROM chat_messages
             WHERE groupId = ? AND sessionId IS NULL`,
            [groupId]
        );

        if (!result || result.count === 0 || result.timeStart === null || result.timeEnd === null) {
            return null;
        }

        return {
            groupId,
            count: result.count,
            timeStart: result.timeStart,
            timeEnd: result.timeEnd
        };
    }

    /**
     * 获取指定群组最早一批尚未分配 sessionId 消息的时间范围。
     * @param groupId 群组ID
     * @param limit 单批最多纳入的消息数
     * @returns 最早未处理批次的时间范围
     */
    public async getEarliestUnprocessedMessageTimeRangeByGroupId(
        groupId: string,
        limit: number
    ): Promise<MessageRangeStats | null> {
        const resolvedLimit = Math.max(1, Math.floor(limit));
        const result = await this.db.get<{
            count: number;
            timeStart: number | null;
            timeEnd: number | null;
        }>(
            `SELECT COUNT(*) AS count, MIN(timestamp) AS timeStart, MAX(timestamp) AS timeEnd
             FROM (
                SELECT timestamp
                FROM chat_messages
                WHERE groupId = ? AND sessionId IS NULL
                ORDER BY timestamp ASC
                LIMIT ?
             )`,
            [groupId, resolvedLimit]
        );

        if (!result || result.count === 0 || result.timeStart === null || result.timeEnd === null) {
            return null;
        }

        return {
            groupId,
            count: result.count,
            timeStart: result.timeStart,
            timeEnd: result.timeEnd
        };
    }

    /**
     * 获取指定群组最早一批尚未生成摘要的 session 统计。
     * @param groupId 群组ID
     * @param limit 单批最多纳入的 session 数
     * @returns 未摘要 session 的消息数量和时间范围
     */
    public async getUnsummarizedSessionStatsByGroupId(groupId: string, limit: number): Promise<SessionStats[]> {
        const resolvedLimit = Math.max(1, Math.floor(limit));
        const staleBefore = Date.now() - AIDIGEST_SESSION_STALE_MS;

        return await this.db.all<SessionStats>(
            `SELECT
                cm.sessionId AS sessionId,
                COUNT(DISTINCT cm.msgId) AS messageCount,
                MIN(cm.timestamp) AS timeStart,
                MAX(cm.timestamp) AS timeEnd
             FROM chat_messages cm
             LEFT JOIN ai_digest_results ar ON ar.sessionId = cm.sessionId
             WHERE cm.groupId = ? AND cm.sessionId IS NOT NULL
               AND NOT EXISTS (
                    SELECT 1 FROM ai_digest_sessions ds
                    WHERE ds.sessionId = cm.sessionId
                      AND (
                        ds.status IN ('success', 'empty')
                        OR (ds.status IN ('processing', 'failed') AND ds.updateTime >= ?)
                      )
               )
             GROUP BY cm.sessionId
             HAVING COUNT(ar.topicId) = 0
             ORDER BY timeEnd ASC
             LIMIT ?`,
            [groupId, staleBefore, resolvedLimit]
        );
    }

    /**
     * 统计当前仍处于摘要保护窗口内、会暂时阻止重新摘要的 session。
     * @param groupIds 群组ID列表
     * @returns 按摘要状态聚合的阻塞统计
     */
    public async getActiveDigestSessionBlockStatsByGroupIds(
        groupIds: string[]
    ): Promise<ActiveDigestSessionBlockStats[]> {
        const uniqueGroupIds = [...new Set(groupIds)];

        if (uniqueGroupIds.length === 0) {
            return [];
        }

        const groupPlaceholders = uniqueGroupIds.map(() => "?").join(", ");
        const staleBefore = Date.now() - AIDIGEST_SESSION_STALE_MS;

        return await this.db.all<ActiveDigestSessionBlockStats>(
            `SELECT
                ds.status AS status,
                COUNT(DISTINCT ds.sessionId) AS sessionCount,
                COUNT(DISTINCT cm.msgId) AS messageCount,
                MIN(
                    CASE
                        WHEN ds.status = 'processing' THEN COALESCE(ds.processingStartedAt, ds.updateTime)
                        ELSE ds.updateTime
                    END
                ) + ? AS earliestRetryTime,
                MAX(ds.updateTime) AS latestUpdateTime
             FROM ai_digest_sessions ds
             INNER JOIN chat_messages cm ON cm.sessionId = ds.sessionId
             WHERE cm.groupId IN (${groupPlaceholders})
               AND (
                    (ds.status = 'processing' AND COALESCE(ds.processingStartedAt, ds.updateTime) >= ?)
                    OR (ds.status = 'failed' AND ds.updateTime >= ?)
               )
             GROUP BY ds.status
             ORDER BY earliestRetryTime ASC, ds.status ASC`,
            [AIDIGEST_SESSION_STALE_MS, ...uniqueGroupIds, staleBefore, staleBefore]
        );
    }

    /**
     * 获取指定群组和时间范围内消息到摘要状态的只读覆盖快照。
     * @param groupId 群组ID
     * @param timeStart 起始时间戳
     * @param timeEnd 结束时间戳
     * @param detailLimit 未分配消息样例数量上限
     * @returns 原始消息统计、命中 session 摘要状态和未分配消息样例
     */
    public async getDigestCoverageSnapshotByGroupIdAndTimeRange(
        groupId: string,
        timeStart: number,
        timeEnd: number,
        detailLimit: number
    ): Promise<DigestCoverageSnapshot> {
        const resolvedLimit = Math.max(1, Math.floor(detailLimit));
        const rawMessageStats = await this.db.get<DigestCoverageRawMessageStats>(
            `SELECT
                COUNT(*) AS messageCount,
                COUNT(CASE WHEN sessionId IS NOT NULL THEN 1 END) AS assignedMessageCount,
                COUNT(CASE WHEN sessionId IS NULL THEN 1 END) AS unassignedMessageCount,
                COUNT(DISTINCT CASE WHEN sessionId IS NOT NULL THEN sessionId END) AS assignedSessionCount,
                MIN(timestamp) AS timeStart,
                MAX(timestamp) AS timeEnd,
                MIN(CASE WHEN sessionId IS NULL THEN timestamp END) AS unassignedTimeStart,
                MAX(CASE WHEN sessionId IS NULL THEN timestamp END) AS unassignedTimeEnd
             FROM chat_messages
             WHERE groupId = ? AND timestamp BETWEEN ? AND ?`,
            [groupId, timeStart, timeEnd]
        );
        const sessions = await this.db.all<DigestCoverageSessionStats>(
            `WITH range_sessions AS (
                SELECT
                    sessionId,
                    COUNT(DISTINCT msgId) AS messageCount,
                    MIN(timestamp) AS timeStart,
                    MAX(timestamp) AS timeEnd
                FROM chat_messages
                WHERE groupId = ? AND timestamp BETWEEN ? AND ? AND sessionId IS NOT NULL
                GROUP BY sessionId
            ),
            result_counts AS (
                SELECT
                    ar.sessionId AS sessionId,
                    COUNT(DISTINCT ar.topicId) AS resultTopicCount
                FROM ai_digest_results ar
                INNER JOIN range_sessions rs ON rs.sessionId = ar.sessionId
                GROUP BY ar.sessionId
            )
            SELECT
                rs.sessionId AS sessionId,
                rs.messageCount AS messageCount,
                rs.timeStart AS timeStart,
                rs.timeEnd AS timeEnd,
                ds.status AS status,
                ds.updateTime AS updateTime,
                ds.processingStartedAt AS processingStartedAt,
                ds.failReason AS failReason,
                ds.topicCount AS statusTopicCount,
                COALESCE(rc.resultTopicCount, 0) AS resultTopicCount
            FROM range_sessions rs
            LEFT JOIN ai_digest_sessions ds ON ds.sessionId = rs.sessionId
            LEFT JOIN result_counts rc ON rc.sessionId = rs.sessionId
            ORDER BY rs.timeEnd ASC, rs.sessionId ASC`,
            [groupId, timeStart, timeEnd]
        );
        const unassignedMessageSamples = await this.db.all<DigestCoverageUnassignedMessageSample>(
            `SELECT msgId, timestamp, senderId, senderNickname, messageContent
             FROM chat_messages
             WHERE groupId = ? AND timestamp BETWEEN ? AND ? AND sessionId IS NULL
             ORDER BY timestamp ASC, msgId ASC
             LIMIT ?`,
            [groupId, timeStart, timeEnd, resolvedLimit]
        );

        return {
            rawMessageStats: rawMessageStats ?? {
                messageCount: 0,
                assignedMessageCount: 0,
                unassignedMessageCount: 0,
                assignedSessionCount: 0,
                timeStart: null,
                timeEnd: null,
                unassignedTimeStart: null,
                unassignedTimeEnd: null
            },
            sessions,
            unassignedMessageSamples
        };
    }

    /**
     * 获取指定 session 的预处理消息。
     * @param sessionId 会话ID
     * @returns 已按时间升序排列的消息列表
     */
    public async getProcessedChatMessagesBySessionId(
        sessionId: string
    ): Promise<ProcessedChatMessageWithRawMessage[]> {
        return await this.db.all<ProcessedChatMessageWithRawMessage>(
            `SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY timestamp ASC`,
            [sessionId]
        );
    }

    /**
     * 获取指定群组最新的一条已入库消息
     * @param groupId 群组ID
     * @returns 消息对象
     */
    public async getNewestRawChatMessageByGroupId(groupId: string): Promise<RawChatMessage | undefined> {
        return await this.db.get<RawChatMessage | undefined>(
            `SELECT * FROM chat_messages WHERE groupId =? ORDER BY timestamp DESC LIMIT 1`,
            [groupId]
        );
    }

    /**
     * 根据消息id获取raw消息
     * @param msgId 消息id
     * @returns 消息对象
     * @throws 当消息不存在时抛出错误
     */
    public async getRawChatMessageByMsgId(msgId: string): Promise<RawChatMessage> {
        const result = await this.db.get<RawChatMessage>(`SELECT * FROM chat_messages WHERE msgId =?`, [msgId]);

        if (!result) {
            throw new Error(`消息不存在，msgId: ${msgId}`);
        }

        return result;
    }

    /**
     * 获取某条消息前后上下文（同群内按时间排序）
     * @param groupId 群组ID
     * @param msgId 目标消息ID
     * @param before 目标消息之前的条数
     * @param after 目标消息之后的条数
     */
    public async getProcessedChatMessagesContextByGroupIdAndMsgId(
        groupId: string,
        msgId: string,
        before: number,
        after: number
    ): Promise<ProcessedChatMessageWithRawMessage[]> {
        const resolvedBefore = Math.max(0, Math.min(200, Math.floor(before)));
        const resolvedAfter = Math.max(0, Math.min(200, Math.floor(after)));

        const target = await this.db.get<ProcessedChatMessageWithRawMessage>(
            `SELECT * FROM chat_messages WHERE msgId = ? AND groupId = ?`,
            [msgId, groupId]
        );

        if (!target) {
            return [];
        }

        const [beforeRows, afterRows] = await Promise.all([
            resolvedBefore === 0
                ? Promise.resolve([])
                : this.db.all<ProcessedChatMessageWithRawMessage>(
                      `SELECT * FROM chat_messages WHERE groupId = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`,
                      [groupId, target.timestamp, resolvedBefore]
                  ),
            resolvedAfter === 0
                ? Promise.resolve([])
                : this.db.all<ProcessedChatMessageWithRawMessage>(
                      `SELECT * FROM chat_messages WHERE groupId = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?`,
                      [groupId, target.timestamp, resolvedAfter]
                  )
        ]);

        const combined = [...beforeRows.reverse(), target, ...afterRows];

        return combined;
    }

    // 获取所有消息，用于数据库迁移、导出、备份等操作
    public async selectAll(): Promise<ProcessedChatMessageWithRawMessage[]> {
        const res = await this.db.all<ProcessedChatMessageWithRawMessage>(`SELECT * FROM chat_messages`);

        this.LOGGER.info(`去重前消息数量: ${res.length}`);
        // 按照id进行去重
        const uniqueResMap = new Map<string, ProcessedChatMessageWithRawMessage>();

        res.forEach(item => {
            uniqueResMap.set(item.msgId, item);
        });
        const dedupedArr = Array.from(uniqueResMap.values());

        this.LOGGER.info(`去重后消息数量: ${dedupedArr.length}`);

        return dedupedArr;
    }

    public async selectAllChatMessageMedia(): Promise<ChatMessageMedia[]> {
        return await this.db.all<ChatMessageMedia>(
            `SELECT * FROM chat_message_media ORDER BY timestamp ASC, msgId ASC, elementIndex ASC`
        );
    }

    public execQuerySQL(sql: string, params: any[] = []): Promise<any[]> {
        return this.db.all(sql, params);
    }

    /**
     * 获取多个群组在指定时间范围内的每小时消息统计
     * @param groupIds 群组ID数组
     * @param timeStart 起始时间戳（整点对齐）
     * @param timeEnd 结束时间戳
     * @returns 每小时消息数量统计 { groupId: string; hourTimestamp: number; count: number }[]
     */
    public async getMessageHourlyStatsByGroupIds(
        groupIds: string[],
        timeStart: number,
        timeEnd: number
    ): Promise<{ groupId: string; hourTimestamp: number; count: number }[]> {
        if (groupIds.length === 0) {
            return [];
        }

        // 构建 IN 子句占位符
        const placeholders = groupIds.map(() => "?").join(", ");

        // 使用 SQL 进行小时级别聚合统计
        // hourTimestamp 为每小时的起始时间戳（整点对齐）
        const sql = `
            SELECT
                groupId,
                (timestamp / 3600000) * 3600000 AS hourTimestamp,
                COUNT(*) AS count
            FROM chat_messages
            WHERE groupId IN (${placeholders})
                AND timestamp >= ?
                AND timestamp < ?
            GROUP BY groupId, hourTimestamp
            ORDER BY groupId, hourTimestamp
        `;

        const params = [...groupIds, timeStart, timeEnd];

        const results = await this.db.all<{
            groupId: string;
            hourTimestamp: number;
            count: number;
        }>(sql, params);

        return results;
    }

    public async storeProcessedChatMessage(message: ProcessedChatMessage) {
        // 执行这个函数的时候，数据库内已经通过storeRawChatMessage函数存储了原始消息，这里只需要更新原记录中的sessionId和preProcessedContent字段即可
        await this.db.run(`UPDATE chat_messages SET sessionId = ?, preProcessedContent = ? WHERE msgId = ?`, [
            message.sessionId,
            message.preProcessedContent,
            message.msgId
        ]);
    }

    public async storeProcessedChatMessages(messages: ProcessedChatMessage[]) {
        if (messages.length === 0) return;

        await this.db.run("BEGIN IMMEDIATE TRANSACTION");
        try {
            for (const msg of messages) {
                await this.db.run(
                    `UPDATE chat_messages SET sessionId = ?, preProcessedContent = ? WHERE msgId = ?`,
                    [msg.sessionId, msg.preProcessedContent, msg.msgId]
                );
            }
            await this.db.run("COMMIT");
        } catch (err) {
            await this.db.run("ROLLBACK");
            throw err;
        }
    }
}
