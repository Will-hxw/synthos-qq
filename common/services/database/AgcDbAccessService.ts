import "reflect-metadata";
import { injectable, container } from "tsyringe";

import Logger from "../../util/Logger";
import { AIDigestResult } from "../../contracts/ai-model";
import { Disposable } from "../../util/lifecycle/Disposable";
import { mustInitBeforeUse } from "../../util/lifecycle/mustInitBeforeUse";
import { COMMON_TOKENS } from "../../di/tokens";

import { CommonDBService } from "./infra/CommonDBService";
import { createAGCTableSQL } from "./constants/InitialSQL";
import {
    AIDIGEST_SESSION_STALE_MS,
    AIDIGEST_SESSION_STATUSES,
    AIDigestSessionStatus
} from "./constants/AIDigestSessionConstants";

export interface LatestTopicRecord extends AIDigestResult {
    timeStart: number;
    timeEnd: number;
    groupId: string;
    interestScore: number | null;
}

export interface LatestTopicPageQuery {
    timeStart: number;
    timeEnd: number;
    page: number;
    pageSize: number;
    groupId?: string;
    searchText?: string;
    sortByInterest: boolean;
    excludeTopicIds?: string[];
    includeTopicIds?: string[];
}

export interface LatestTopicPageResult {
    records: LatestTopicRecord[];
    total: number;
}

export interface AIDigestSessionClaimMetadata {
    messageCount: number;
    timeStart: number;
    timeEnd: number;
}

interface AIDigestSessionRow {
    status: AIDigestSessionStatus | string;
    updateTime: number;
    processingStartedAt: number | null;
}

/**
 * AI 生成内容数据库访问服务
 * 负责 AI 摘要结果的存储和查询
 */
@injectable()
@mustInitBeforeUse
export class AgcDbAccessService extends Disposable {
    private LOGGER = Logger.withTag("AgcDbAccessService");
    private db: CommonDBService | null = null;
    /** 写操作互斥链：串行化所有写事务，避免多并发回调在同一连接上事务交错 */
    private writeChain: Promise<unknown> = Promise.resolve();

    public async getLatestTopicRecordsPageByTimeRange(
        query: LatestTopicPageQuery
    ): Promise<LatestTopicPageResult> {
        const includeTopicIds = this._uniqueStrings(query.includeTopicIds);

        if (query.includeTopicIds && includeTopicIds.length === 0) {
            return {
                records: [],
                total: 0
            };
        }

        const params: Array<number | string> = [query.timeStart, query.timeEnd];
        let groupFilterSql = "";

        if (query.groupId) {
            groupFilterSql = " AND groupId = ?";
            params.push(query.groupId);
        }

        const filters: string[] = [];
        const searchText = query.searchText?.trim().toLowerCase();

        if (searchText) {
            const likePattern = `%${this._escapeLikePattern(searchText)}%`;

            filters.push(`(
                LOWER(COALESCE(topic, '')) LIKE ? ESCAPE '\\'
                OR LOWER(COALESCE(detail, '')) LIKE ? ESCAPE '\\'
                OR LOWER(COALESCE(contributors, '')) LIKE ? ESCAPE '\\'
                OR LOWER(COALESCE(groupId, '')) LIKE ? ESCAPE '\\'
                OR LOWER(COALESCE(sessionId, '')) LIKE ? ESCAPE '\\'
            )`);
            params.push(likePattern, likePattern, likePattern, likePattern, likePattern);
        }

        const excludeTopicIds = this._uniqueStrings(query.excludeTopicIds);

        if (excludeTopicIds.length > 0) {
            filters.push(`topicId NOT IN (${excludeTopicIds.map(() => "?").join(", ")})`);
            params.push(...excludeTopicIds);
        }

        if (includeTopicIds.length > 0) {
            filters.push(`topicId IN (${includeTopicIds.map(() => "?").join(", ")})`);
            params.push(...includeTopicIds);
        }

        const whereSql = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
        const cteSql = `WITH matched_sessions AS (
                SELECT DISTINCT sessionId
                FROM chat_messages
                WHERE timestamp BETWEEN ? AND ?
                  AND sessionId IS NOT NULL${groupFilterSql}
            ),
            session_durations AS (
                SELECT
                    cm.sessionId AS sessionId,
                    MIN(cm.timestamp) AS timeStart,
                    MAX(cm.timestamp) AS timeEnd,
                    MIN(cm.groupId) AS groupId
                FROM chat_messages cm
                INNER JOIN matched_sessions ms ON ms.sessionId = cm.sessionId
                GROUP BY cm.sessionId
            ),
            topic_records AS (
                SELECT
                    ar.topicId AS topicId,
                    COALESCE(ar.sessionId, '') AS sessionId,
                    COALESCE(ar.topic, '') AS topic,
                    COALESCE(ar.contributors, '') AS contributors,
                    COALESCE(ar.detail, '') AS detail,
                    COALESCE(ar.modelName, '') AS modelName,
                    COALESCE(ar.updateTime, 0) AS updateTime,
                    sd.timeStart AS timeStart,
                    sd.timeEnd AS timeEnd,
                    COALESCE(sd.groupId, '') AS groupId,
                    isr.scoreV1 AS interestScore
                FROM ai_digest_results ar
                INNER JOIN session_durations sd ON sd.sessionId = ar.sessionId
                LEFT JOIN interset_score_results isr ON isr.topicId = ar.topicId
            ),
            filtered_records AS (
                SELECT * FROM topic_records
                ${whereSql}
            )`;
        const countResult = await this.db.get<{ total: number }>(
            `${cteSql}
            SELECT COUNT(*) AS total FROM filtered_records`,
            [...params]
        );
        const offset = (query.page - 1) * query.pageSize;
        const orderBySql = query.sortByInterest
            ? "CASE WHEN interestScore IS NULL THEN 1 ELSE 0 END ASC, interestScore DESC, timeEnd DESC, updateTime DESC, topicId ASC"
            : "timeEnd DESC, topicId ASC";
        const records = await this.db.all<LatestTopicRecord>(
            `${cteSql}
            SELECT * FROM filtered_records
            ORDER BY ${orderBySql}
            LIMIT ? OFFSET ?`,
            [...params, query.pageSize, offset]
        );

        return {
            records,
            total: countResult?.total ?? 0
        };
    }

    /**
     * 初始化数据库服务
     */
    public async init() {
        // 从 DI 容器获取 CommonDBService 实例
        this.db = container.resolve<CommonDBService>(COMMON_TOKENS.CommonDBService);
        await this.db.init(createAGCTableSQL);
        await this._ensureAIDigestSessionColumns();
    }

    /**
     * 存储一个摘要结果
     * @param result 摘要结果
     */
    public async storeAIDigestResult(result: AIDigestResult) {
        // to fix
        await this.db.run(
            `INSERT INTO ai_digest_results (topicId, sessionId, topic, contributors, detail, modelName, updateTime) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(topicId) DO UPDATE SET
                sessionId = excluded.sessionId,
                topic = excluded.topic,
                contributors = excluded.contributors,
                detail = excluded.detail,
                modelName = excluded.modelName,
                updateTime = excluded.updateTime
            `,
            [
                result.topicId,
                result.sessionId,
                result.topic,
                result.contributors,
                result.detail,
                result.modelName,
                result.updateTime
            ]
        );
    }

    /**
     * 串行化写事务。共享同一 SQLite 连接的并发回调若各自 BEGIN IMMEDIATE，
     * 会触发 "cannot start a transaction within a transaction" 并丢失写入；
     * 通过 promise 链保证同一时刻只有一个写事务在执行。
     */
    private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.writeChain.then(() => fn());

        // 链尾吞掉异常，避免一次写失败阻断后续所有写操作
        this.writeChain = result.then(
            () => undefined,
            () => undefined
        );

        return result;
    }

    /** 在已开启的事务中插入单条摘要结果（不含事务控制） */
    private async _insertAIDigestResult(result: AIDigestResult): Promise<void> {
        await this.db.run(
            `INSERT INTO ai_digest_results (topicId, sessionId, topic, contributors, detail, modelName, updateTime) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(topicId) DO UPDATE SET
                sessionId = excluded.sessionId,
                topic = excluded.topic,
                contributors = excluded.contributors,
                detail = excluded.detail,
                modelName = excluded.modelName,
                updateTime = excluded.updateTime
            `,
            [
                result.topicId,
                result.sessionId,
                result.topic,
                result.contributors,
                result.detail,
                result.modelName,
                result.updateTime
            ]
        );
    }

    /**
     * 存储多个摘要结果。
     * 按 session 分组后走幂等提交，避免旧调用方继续追加重复话题。
     * @param results 摘要结果
     */
    public async storeAIDigestResults(results: AIDigestResult[]): Promise<void> {
        if (results.length === 0) {
            return;
        }

        const sessionResults = new Map<string, AIDigestResult[]>();

        for (const result of results) {
            if (!sessionResults.has(result.sessionId)) {
                sessionResults.set(result.sessionId, []);
            }
            sessionResults.get(result.sessionId)!.push(result);
        }

        for (const [sessionId, currentResults] of sessionResults) {
            await this.commitSessionDigest(sessionId, currentResults);
        }
    }

    /**
     * 原子抢占一个 session 的摘要生成权。
     * 已成功、已空摘要、处理中未超时或失败未过冷却期的 session 都不会被再次处理。
     * @param sessionId 会话id
     * @param metadata session 消息统计
     * @returns 是否成功抢占
     */
    public async tryClaimSessionForDigest(
        sessionId: string,
        metadata: AIDigestSessionClaimMetadata
    ): Promise<boolean> {
        let claimed = false;

        await this.runExclusive(async () => {
            await this.db.run("BEGIN IMMEDIATE TRANSACTION");
            try {
                const now = Date.now();
                const staleBefore = now - AIDIGEST_SESSION_STALE_MS;
                const row = await this.db.get<AIDigestSessionRow>(
                    `SELECT status, updateTime, processingStartedAt FROM ai_digest_sessions WHERE sessionId = ?`,
                    [sessionId]
                );

                if (row) {
                    if (row.status === AIDIGEST_SESSION_STATUSES.success) {
                        await this.db.run("COMMIT");

                        return;
                    }

                    if (row.status === AIDIGEST_SESSION_STATUSES.empty) {
                        await this.db.run("COMMIT");

                        return;
                    }

                    const lockTime = row.processingStartedAt ?? row.updateTime;

                    if (row.status === AIDIGEST_SESSION_STATUSES.processing && lockTime >= staleBefore) {
                        await this.db.run("COMMIT");

                        return;
                    }

                    if (row.status === AIDIGEST_SESSION_STATUSES.failed && row.updateTime >= staleBefore) {
                        await this.db.run("COMMIT");

                        return;
                    }
                } else {
                    const legacyResult = await this.db.get<{ topicCount: number }>(
                        `SELECT COUNT(*) AS topicCount FROM ai_digest_results WHERE sessionId = ?`,
                        [sessionId]
                    );

                    if ((legacyResult?.topicCount ?? 0) > 0) {
                        await this._upsertSessionStatus(
                            sessionId,
                            AIDIGEST_SESSION_STATUSES.success,
                            legacyResult!.topicCount,
                            metadata,
                            null,
                            null
                        );
                        await this.db.run("COMMIT");

                        return;
                    }
                }

                await this._upsertSessionStatus(
                    sessionId,
                    AIDIGEST_SESSION_STATUSES.processing,
                    0,
                    metadata,
                    now,
                    null
                );
                claimed = true;

                await this.db.run("COMMIT");
            } catch (err) {
                await this.db.run("ROLLBACK");
                throw err;
            }
        });

        return claimed;
    }

    /**
     * 幂等提交一个 session 的摘要结果：在单个事务内先删除该 session 旧话题，再插入新话题，
     * 并写入 success 终态。重复执行同一 session 不会产生重复话题行。
     * @param sessionId 会话id
     * @param results 摘要结果（其 sessionId 必须与入参一致）
     * @returns 本次提交删除的话题ID，供外部清理向量等外部索引
     */
    public async commitSessionDigest(sessionId: string, results: AIDigestResult[]): Promise<string[]> {
        for (const result of results) {
            if (result.sessionId !== sessionId) {
                throw new Error(`result的sessionId必须是${sessionId}，但实际为${result.sessionId}`);
            }
        }

        let deletedTopicIds: string[] = [];

        await this.runExclusive(async () => {
            await this.db.run("BEGIN IMMEDIATE TRANSACTION");
            try {
                const oldTopicIds = await this._getTopicIdsBySessionId(sessionId);

                await this._deleteTopicIds(oldTopicIds);
                for (const result of results) {
                    await this._insertAIDigestResult(result);
                }

                const duplicateTopicIds = await this._findDuplicateTopicIdsByTitle();

                await this._deleteTopicIds(duplicateTopicIds);

                deletedTopicIds = this._uniqueStrings([...oldTopicIds, ...duplicateTopicIds]);
                const topicCount = await this._getSessionTopicCount(sessionId);

                await this._upsertSessionStatus(
                    sessionId,
                    AIDIGEST_SESSION_STATUSES.success,
                    topicCount,
                    undefined,
                    null,
                    null
                );
                await this._refreshSuccessSessionTopicCounts();

                await this.db.run("COMMIT");
            } catch (err) {
                await this.db.run("ROLLBACK");
                throw err;
            }
        });

        return deletedTopicIds;
    }

    /**
     * 将一个 session 标记为空摘要终态（LLM 合法返回无有效话题）。
     * 清除该 session 可能残留的旧话题并写入 empty 终态，使其不再被重复摘要。
     * @param sessionId 会话id
     */
    public async markSessionEmpty(sessionId: string): Promise<string[]> {
        let deletedTopicIds: string[] = [];

        await this.runExclusive(async () => {
            await this.db.run("BEGIN IMMEDIATE TRANSACTION");
            try {
                deletedTopicIds = await this._getTopicIdsBySessionId(sessionId);

                await this._deleteTopicIds(deletedTopicIds);
                await this._upsertSessionStatus(
                    sessionId,
                    AIDIGEST_SESSION_STATUSES.empty,
                    0,
                    undefined,
                    null,
                    null
                );

                await this.db.run("COMMIT");
            } catch (err) {
                await this.db.run("ROLLBACK");
                throw err;
            }
        });

        return deletedTopicIds;
    }

    /**
     * 将 session 标记为摘要失败，避免失败 session 在短时间内被反复提交给 LLM。
     * @param sessionId 会话id
     * @param reason 失败原因
     */
    public async markSessionFailed(sessionId: string, reason: string): Promise<void> {
        const failReason = reason.length > 500 ? reason.slice(0, 500) : reason;

        await this.runExclusive(async () => {
            await this.db.run("BEGIN IMMEDIATE TRANSACTION");
            try {
                await this._upsertSessionStatus(
                    sessionId,
                    AIDIGEST_SESSION_STATUSES.failed,
                    0,
                    undefined,
                    null,
                    failReason
                );

                await this.db.run("COMMIT");
            } catch (err) {
                await this.db.run("ROLLBACK");
                throw err;
            }
        });
    }

    /**
     * 全量清理重复标题话题。标题完全相同（按 trim 后比较）时只保留 session 结束时间最新的一条。
     * @returns 被删除的话题ID
     */
    public async deduplicateTopicTitles(): Promise<string[]> {
        let deletedTopicIds: string[] = [];

        await this.runExclusive(async () => {
            await this.db.run("BEGIN IMMEDIATE TRANSACTION");
            try {
                deletedTopicIds = await this._findDuplicateTopicIdsByTitle();
                await this._deleteTopicIds(deletedTopicIds);
                await this._refreshSuccessSessionTopicCounts();

                await this.db.run("COMMIT");
            } catch (err) {
                await this.db.run("ROLLBACK");
                throw err;
            }
        });

        if (deletedTopicIds.length > 0) {
            this.LOGGER.warning(`已清理 ${deletedTopicIds.length} 个重复标题话题`);
        }

        return deletedTopicIds;
    }

    /**
     * 根据topicId获取一个摘要结果
     * @param topicId 主题id
     * @returns 摘要结果
     */
    public async getAIDigestResultByTopicId(topicId: string): Promise<AIDigestResult | null> {
        const result = await this.db.get<AIDigestResult>(`SELECT * FROM ai_digest_results WHERE topicId =?`, [
            topicId
        ]);

        return result;
    }

    /**
     * 根据sessionId获取多个摘要结果
     * @param sessionId 会话id
     * @returns 摘要结果
     */
    public async getAIDigestResultsBySessionId(sessionId: string): Promise<AIDigestResult[]> {
        const results = await this.db.all<AIDigestResult>(`SELECT * FROM ai_digest_results WHERE sessionId =?`, [
            sessionId
        ]);

        return results;
    }

    /**
     * 批量获取多个 session 的摘要结果。
     * @param sessionIds 会话ID列表
     * @returns 按输入 sessionId 顺序分组的摘要结果
     */
    public async getAIDigestResultsBySessionIds(
        sessionIds: string[]
    ): Promise<{ sessionId: string; result: AIDigestResult[] }[]> {
        if (sessionIds.length === 0) {
            return [];
        }

        const uniqueSessionIds = Array.from(new Set(sessionIds));
        const placeholders = uniqueSessionIds.map(() => "?").join(", ");
        const rows = await this.db.all<AIDigestResult>(
            `SELECT * FROM ai_digest_results WHERE sessionId IN (${placeholders})`,
            uniqueSessionIds
        );
        const digestMap = new Map<string, AIDigestResult[]>();

        for (const sessionId of uniqueSessionIds) {
            digestMap.set(sessionId, []);
        }

        for (const row of rows) {
            digestMap.get(row.sessionId)?.push(row);
        }

        return sessionIds.map(sessionId => ({
            sessionId,
            result: digestMap.get(sessionId) || []
        }));
    }

    /**
     * 批量获取多个 topicId 的摘要结果。
     * 用单条 IN 查询替代逐 topicId 查询，避免报告详情等场景的 N+1 往返。
     * 超 999 参数自动分块。
     * @param topicIds 话题ID列表
     * @returns topicId 到摘要结果的映射；不存在的 topicId 不会出现在 map 中
     */
    public async getAIDigestResultsByTopicIds(topicIds: string[]): Promise<Map<string, AIDigestResult>> {
        const digestMap = new Map<string, AIDigestResult>();

        if (topicIds.length === 0) {
            return digestMap;
        }

        const MAX_SQLITE_PARAMS = 999;
        const uniqueTopicIds = Array.from(new Set(topicIds));

        for (let i = 0; i < uniqueTopicIds.length; i += MAX_SQLITE_PARAMS) {
            const batch = uniqueTopicIds.slice(i, i + MAX_SQLITE_PARAMS);
            const placeholders = batch.map(() => "?").join(", ");
            const rows = await this.db.all<AIDigestResult>(
                `SELECT * FROM ai_digest_results WHERE topicId IN (${placeholders})`,
                batch
            );

            for (const row of rows) {
                digestMap.set(row.topicId, row);
            }
        }

        return digestMap;
    }

    /**
     * 返回输入 topicId 中当前仍存在摘要记录的集合。
     * @param topicIds 待检查话题ID
     */
    public async getExistingTopicIds(topicIds: string[]): Promise<Set<string>> {
        const existingTopicIds = new Set<string>();

        if (topicIds.length === 0) {
            return existingTopicIds;
        }

        const MAX_SQLITE_PARAMS = 999;
        const uniqueTopicIds = this._uniqueStrings(topicIds);

        for (let i = 0; i < uniqueTopicIds.length; i += MAX_SQLITE_PARAMS) {
            const batch = uniqueTopicIds.slice(i, i + MAX_SQLITE_PARAMS);
            const placeholders = batch.map(() => "?").join(", ");
            const rows = await this.db.all<{ topicId: string }>(
                `SELECT topicId FROM ai_digest_results WHERE topicId IN (${placeholders})`,
                batch
            );

            for (const row of rows) {
                existingTopicIds.add(row.topicId);
            }
        }

        return existingTopicIds;
    }

    /**
     * 获取指定时间范围内命中的话题记录，并附带所属会话完整时间范围、群组和兴趣分。
     * 时间过滤语义与旧页面链路一致：只要 session 内任一消息落入时间范围，就返回该 session 的全部话题。
     * @param timeStart 开始时间戳
     * @param timeEnd 结束时间戳
     * @param groupId 可选群组 ID
     */
    public async getLatestTopicRecordsByTimeRange(
        timeStart: number,
        timeEnd: number,
        groupId?: string
    ): Promise<LatestTopicRecord[]> {
        const params: Array<number | string> = [timeStart, timeEnd];
        let groupFilterSql = "";

        if (groupId) {
            groupFilterSql = " AND groupId = ?";
            params.push(groupId);
        }

        return await this.db.all<LatestTopicRecord>(
            `WITH matched_sessions AS (
                SELECT DISTINCT sessionId
                FROM chat_messages
                WHERE timestamp BETWEEN ? AND ?
                  AND sessionId IS NOT NULL${groupFilterSql}
            ),
            session_durations AS (
                SELECT
                    cm.sessionId AS sessionId,
                    MIN(cm.timestamp) AS timeStart,
                    MAX(cm.timestamp) AS timeEnd,
                    MIN(cm.groupId) AS groupId
                FROM chat_messages cm
                INNER JOIN matched_sessions ms ON ms.sessionId = cm.sessionId
                GROUP BY cm.sessionId
            )
            SELECT
                ar.topicId AS topicId,
                COALESCE(ar.sessionId, '') AS sessionId,
                COALESCE(ar.topic, '') AS topic,
                COALESCE(ar.contributors, '') AS contributors,
                COALESCE(ar.detail, '') AS detail,
                COALESCE(ar.modelName, '') AS modelName,
                COALESCE(ar.updateTime, 0) AS updateTime,
                sd.timeStart AS timeStart,
                sd.timeEnd AS timeEnd,
                COALESCE(sd.groupId, '') AS groupId,
                isr.scoreV1 AS interestScore
            FROM ai_digest_results ar
            INNER JOIN session_durations sd ON sd.sessionId = ar.sessionId
            LEFT JOIN interset_score_results isr ON isr.topicId = ar.topicId`,
            params
        );
    }

    /**
     * 检查一个sessionId是否已经被摘要过了
     * 检查逻辑：如果给定的sessionId出现在了表的任意一行，则返回true，否则返回false
     * @param sessionId 会话id
     * @returns 是否已经被摘要过了
     */
    public async isSessionIdSummarized(sessionId: string): Promise<boolean> {
        // 返回结果类似 { 'EXISTS(SELECT 1 FROM ai_digest_results WHERE sessionId = ?)': 0 }
        const result = await this.db.get(`SELECT EXISTS(SELECT 1 FROM ai_digest_results WHERE sessionId = ?)`, [
            sessionId
        ]);

        return result[Object.keys(result)[0]] === 1;
    }

    /**
     * 检查一个 session 是否已被处理过（产生话题或被标记为空摘要）。
     * 兼容历史数据：仅有话题行而无状态记录的旧 session 同样视为已处理。
     * @param sessionId 会话id
     * @returns 是否已处理
     */
    public async isSessionIdProcessed(sessionId: string): Promise<boolean> {
        const result = await this.db.get<{ processed: number }>(
            `SELECT EXISTS(
                SELECT 1 FROM ai_digest_results WHERE sessionId = ?
                UNION ALL
                SELECT 1 FROM ai_digest_sessions WHERE sessionId = ?
            ) AS processed`,
            [sessionId, sessionId]
        );

        return (result?.processed ?? 0) === 1;
    }

    // 获取数据消息，用于数据库迁移、导出、备份等操作
    public async selectAll(): Promise<AIDigestResult[]> {
        return this.db.all<AIDigestResult>(`SELECT * FROM ai_digest_results`);
    }

    private async _ensureAIDigestSessionColumns(): Promise<void> {
        const columns = await this.db.all<{ name: string }>(`PRAGMA table_info(ai_digest_sessions)`);
        const columnNames = new Set(columns.map(column => column.name));
        const columnSqlList: Array<{ name: string; sql: string }> = [
            {
                name: "processingStartedAt",
                sql: "ALTER TABLE ai_digest_sessions ADD COLUMN processingStartedAt INTEGER"
            },
            { name: "failReason", sql: "ALTER TABLE ai_digest_sessions ADD COLUMN failReason TEXT" },
            { name: "messageCount", sql: "ALTER TABLE ai_digest_sessions ADD COLUMN messageCount INTEGER" },
            { name: "timeStart", sql: "ALTER TABLE ai_digest_sessions ADD COLUMN timeStart INTEGER" },
            { name: "timeEnd", sql: "ALTER TABLE ai_digest_sessions ADD COLUMN timeEnd INTEGER" }
        ];

        for (const item of columnSqlList) {
            if (!columnNames.has(item.name)) {
                await this.db.run(item.sql);
            }
        }

        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_ai_digest_sessions_status_updateTime ON ai_digest_sessions(status, updateTime)`
        );
    }

    private async _upsertSessionStatus(
        sessionId: string,
        status: AIDigestSessionStatus,
        topicCount: number,
        metadata: AIDigestSessionClaimMetadata | undefined,
        processingStartedAt: number | null,
        failReason: string | null
    ): Promise<void> {
        const now = Date.now();

        await this.db.run(
            `INSERT INTO ai_digest_sessions (
                sessionId,
                status,
                topicCount,
                updateTime,
                processingStartedAt,
                failReason,
                messageCount,
                timeStart,
                timeEnd
            ) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(sessionId) DO UPDATE SET
                status = excluded.status,
                topicCount = excluded.topicCount,
                updateTime = excluded.updateTime,
                processingStartedAt = excluded.processingStartedAt,
                failReason = excluded.failReason,
                messageCount = COALESCE(excluded.messageCount, ai_digest_sessions.messageCount),
                timeStart = COALESCE(excluded.timeStart, ai_digest_sessions.timeStart),
                timeEnd = COALESCE(excluded.timeEnd, ai_digest_sessions.timeEnd)
            `,
            [
                sessionId,
                status,
                topicCount,
                now,
                processingStartedAt,
                failReason,
                metadata?.messageCount ?? null,
                metadata?.timeStart ?? null,
                metadata?.timeEnd ?? null
            ]
        );
    }

    private async _getTopicIdsBySessionId(sessionId: string): Promise<string[]> {
        const rows = await this.db.all<{ topicId: string }>(
            `SELECT topicId FROM ai_digest_results WHERE sessionId = ?`,
            [sessionId]
        );

        return rows.map(row => row.topicId);
    }

    private async _getSessionTopicCount(sessionId: string): Promise<number> {
        const row = await this.db.get<{ topicCount: number }>(
            `SELECT COUNT(*) AS topicCount FROM ai_digest_results WHERE sessionId = ?`,
            [sessionId]
        );

        return row?.topicCount ?? 0;
    }

    private async _findDuplicateTopicIdsByTitle(): Promise<string[]> {
        const rows = await this.db.all<{ topicId: string }>(
            `WITH session_durations AS (
                SELECT sessionId, MAX(timestamp) AS timeEnd
                FROM chat_messages
                WHERE sessionId IS NOT NULL
                GROUP BY sessionId
            ),
            ranked_topics AS (
                SELECT
                    ar.topicId AS topicId,
                    ROW_NUMBER() OVER (
                        PARTITION BY TRIM(COALESCE(ar.topic, ''))
                        ORDER BY COALESCE(sd.timeEnd, 0) DESC, COALESCE(ar.updateTime, 0) DESC, ar.topicId ASC
                    ) AS titleRank
                FROM ai_digest_results ar
                LEFT JOIN session_durations sd ON sd.sessionId = ar.sessionId
                WHERE TRIM(COALESCE(ar.topic, '')) <> ''
            )
            SELECT topicId FROM ranked_topics WHERE titleRank > 1
            UNION
            SELECT topicId FROM ai_digest_results WHERE TRIM(COALESCE(topic, '')) = ''`
        );

        return rows.map(row => row.topicId);
    }

    private async _deleteTopicIds(topicIds: string[]): Promise<void> {
        const uniqueTopicIds = this._uniqueStrings(topicIds);

        if (uniqueTopicIds.length === 0) {
            return;
        }

        const MAX_SQLITE_PARAMS = 999;

        for (let i = 0; i < uniqueTopicIds.length; i += MAX_SQLITE_PARAMS) {
            const batch = uniqueTopicIds.slice(i, i + MAX_SQLITE_PARAMS);
            const placeholders = batch.map(() => "?").join(", ");

            await this.db.run(`DELETE FROM interset_score_results WHERE topicId IN (${placeholders})`, batch);
            await this.db.run(`DELETE FROM ai_digest_results WHERE topicId IN (${placeholders})`, batch);
        }
    }

    private async _refreshSuccessSessionTopicCounts(): Promise<void> {
        await this.db.run(
            `UPDATE ai_digest_sessions
             SET topicCount = (
                SELECT COUNT(*)
                FROM ai_digest_results ar
                WHERE ar.sessionId = ai_digest_sessions.sessionId
             )
             WHERE status = ?`,
            [AIDIGEST_SESSION_STATUSES.success]
        );
    }

    private _escapeLikePattern(value: string): string {
        return value.split("\\").join("\\\\").split("%").join("\\%").split("_").join("\\_");
    }

    private _uniqueStrings(values: string[] | undefined): string[] {
        if (!values) {
            return [];
        }

        return Array.from(new Set(values));
    }
}
