import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { COMMON_TOKENS } from "../di/tokens";
import { AgcDbAccessService } from "../services/database/AgcDbAccessService";

describe("AgcDbAccessService", () => {
    const sessionColumns = [
        "sessionId",
        "status",
        "topicCount",
        "updateTime",
        "processingStartedAt",
        "failReason",
        "messageCount",
        "timeStart",
        "timeEnd"
    ].map(name => ({ name }));
    const mockCommonDBService = {
        init: vi.fn(),
        get: vi.fn(),
        all: vi.fn(),
        run: vi.fn()
    };

    beforeEach(() => {
        container.reset();
        vi.clearAllMocks();
        mockCommonDBService.init.mockResolvedValue(undefined);
        mockCommonDBService.get.mockResolvedValue({ total: 7 });
        mockCommonDBService.all.mockImplementation(async (sql: string) => {
            if (sql.includes("PRAGMA table_info(ai_digest_sessions)")) {
                return sessionColumns;
            }

            return [];
        });
        mockCommonDBService.run.mockResolvedValue(undefined);
        container.registerInstance(COMMON_TOKENS.CommonDBService, mockCommonDBService as any);
    });

    it("最新话题分页查询应在数据库层完成过滤排序和分页", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        await service.getLatestTopicRecordsPageByTimeRange({
            timeStart: 100,
            timeEnd: 200,
            page: 3,
            pageSize: 10,
            groupId: "group-1",
            searchText: "foo_%",
            sortByInterest: true,
            excludeTopicIds: ["read-1", "read-1", "read-2"],
            includeTopicIds: ["fav-1"]
        });

        const countSql = mockCommonDBService.get.mock.calls[0][0] as string;
        const countParams = mockCommonDBService.get.mock.calls[0][1];
        const pageSql = mockCommonDBService.all.mock.calls[0][0] as string;
        const pageParams = mockCommonDBService.all.mock.calls[0][1];

        expect(countSql).toContain("SELECT COUNT(*) AS total FROM filtered_records");
        expect(pageSql).toContain("ORDER BY CASE WHEN interestScore IS NULL THEN 1 ELSE 0 END ASC");
        expect(pageSql).toContain("LIMIT ? OFFSET ?");
        expect(countParams).toEqual([
            100,
            200,
            "group-1",
            "%foo\\_\\%%",
            "%foo\\_\\%%",
            "%foo\\_\\%%",
            "%foo\\_\\%%",
            "%foo\\_\\%%",
            "read-1",
            "read-2",
            "fav-1"
        ]);
        expect(pageParams).toEqual([...countParams, 10, 20]);
    });

    it("收藏过滤没有候选topic时不应访问数据库", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        const result = await service.getLatestTopicRecordsPageByTimeRange({
            timeStart: 100,
            timeEnd: 200,
            page: 1,
            pageSize: 10,
            sortByInterest: false,
            includeTopicIds: []
        });

        expect(result).toEqual({
            records: [],
            total: 0
        });
        expect(mockCommonDBService.get).not.toHaveBeenCalled();
        expect(mockCommonDBService.all).not.toHaveBeenCalled();
    });

    it("报告话题查询应基于聊天消息时间并返回真实群组", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        await service.getLatestTopicRecordsByTimeRange(100, 200, "group-a");

        const sql = mockCommonDBService.all.mock.calls[0][0] as string;
        const params = mockCommonDBService.all.mock.calls[0][1];

        expect(sql).toContain("FROM chat_messages");
        expect(sql).toContain("WHERE timestamp BETWEEN ? AND ?");
        expect(sql).toContain("MIN(cm.groupId) AS groupId");
        expect(sql).toContain("LEFT JOIN interset_score_results");
        expect(sql).not.toContain("ar.updateTime BETWEEN");
        expect(params).toEqual([100, 200, "group-a"]);
    });

    it("应批量查询多个session的摘要结果并按输入顺序分组", async () => {
        const rows = [
            {
                topicId: "topic-2",
                sessionId: "session-2",
                topic: "话题2",
                contributors: "[]",
                detail: "详情2",
                modelName: "mock",
                updateTime: 2
            },
            {
                topicId: "topic-1",
                sessionId: "session-1",
                topic: "话题1",
                contributors: "[]",
                detail: "详情1",
                modelName: "mock",
                updateTime: 1
            }
        ];
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        mockCommonDBService.all.mockResolvedValue(rows);
        const result = await service.getAIDigestResultsBySessionIds(["session-1", "session-2", "session-1"]);

        expect(mockCommonDBService.all).toHaveBeenCalledWith(
            "SELECT * FROM ai_digest_results WHERE sessionId IN (?, ?)",
            ["session-1", "session-2"]
        );
        expect(result.map(item => item.sessionId)).toEqual(["session-1", "session-2", "session-1"]);
        expect(result[0].result.map(item => item.topicId)).toEqual(["topic-1"]);
        expect(result[1].result.map(item => item.topicId)).toEqual(["topic-2"]);
        expect(result[2].result.map(item => item.topicId)).toEqual(["topic-1"]);
    });

    it("应批量查询多个topicId的摘要结果并返回去重映射", async () => {
        const rows = [
            {
                topicId: "topic-2",
                sessionId: "session-2",
                topic: "话题2",
                contributors: "[]",
                detail: "详情2",
                modelName: "mock",
                updateTime: 2
            },
            {
                topicId: "topic-1",
                sessionId: "session-1",
                topic: "话题1",
                contributors: "[]",
                detail: "详情1",
                modelName: "mock",
                updateTime: 1
            }
        ];
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        mockCommonDBService.all.mockResolvedValue(rows);
        // 含重复 topicId，应在单条 IN 查询里去重
        const result = await service.getAIDigestResultsByTopicIds(["topic-1", "topic-2", "topic-1"]);

        expect(mockCommonDBService.all).toHaveBeenCalledTimes(1);
        expect(mockCommonDBService.all).toHaveBeenCalledWith(
            "SELECT * FROM ai_digest_results WHERE topicId IN (?, ?)",
            ["topic-1", "topic-2"]
        );
        expect(result.size).toBe(2);
        expect(result.get("topic-1")?.topic).toBe("话题1");
        expect(result.get("topic-2")?.topic).toBe("话题2");
    });

    it("批量查询topicId传入空数组应直接返回空且不查库", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        const result = await service.getAIDigestResultsByTopicIds([]);

        expect(result.size).toBe(0);
        expect(mockCommonDBService.all).not.toHaveBeenCalled();
    });

    it("批量存储摘要结果应按 session 幂等提交", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        mockCommonDBService.get.mockResolvedValue({ topicCount: 1 });
        await service.storeAIDigestResults([
            {
                topicId: "topic-1",
                sessionId: "session-1",
                topic: "话题1",
                contributors: "[]",
                detail: "详情1",
                modelName: "mock",
                updateTime: 1
            },
            {
                topicId: "topic-2",
                sessionId: "session-2",
                topic: "话题2",
                contributors: "[]",
                detail: "详情2",
                modelName: "mock",
                updateTime: 2
            }
        ]);

        const runSqlList = mockCommonDBService.run.mock.calls.map(call => call[0] as string);

        expect(runSqlList.filter(sql => sql === "BEGIN IMMEDIATE TRANSACTION")).toHaveLength(2);
        expect(runSqlList.filter(sql => sql === "COMMIT")).toHaveLength(2);
        expect(runSqlList.some(sql => sql.includes("INSERT INTO ai_digest_sessions"))).toBe(true);
    });

    it("非兴趣排序应按 timeEnd 降序并用 topicId 稳定兜底", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        await service.getLatestTopicRecordsPageByTimeRange({
            timeStart: 100,
            timeEnd: 200,
            page: 1,
            pageSize: 10,
            sortByInterest: false
        });

        const pageSql = mockCommonDBService.all.mock.calls[0][0] as string;

        expect(pageSql).toContain("ORDER BY timeEnd DESC, topicId ASC");
    });

    it("commitSessionDigest 应在单事务内替换话题并写入 success 终态", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        mockCommonDBService.get.mockResolvedValue({ topicCount: 1 });
        await service.commitSessionDigest("session-1", [
            {
                topicId: "topic-1",
                sessionId: "session-1",
                topic: "话题1",
                contributors: "[]",
                detail: "详情1",
                modelName: "mock",
                updateTime: 1
            }
        ]);

        const calls = mockCommonDBService.run.mock.calls;

        expect(calls[0][0]).toBe("BEGIN IMMEDIATE TRANSACTION");
        expect(calls.some(call => String(call[0]).includes("INSERT INTO ai_digest_results"))).toBe(true);
        const statusCall = calls.find(call => String(call[0]).includes("INSERT INTO ai_digest_sessions"));

        expect(statusCall?.[1]).toEqual([
            "session-1",
            "success",
            1,
            expect.any(Number),
            null,
            null,
            null,
            null,
            null
        ]);
        expect(calls[calls.length - 1][0]).toBe("COMMIT");
    });

    it("commitSessionDigest 对 sessionId 不一致的结果应抛错且不写库", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();

        await expect(
            service.commitSessionDigest("session-1", [
                {
                    topicId: "topic-x",
                    sessionId: "session-2",
                    topic: "话题x",
                    contributors: "[]",
                    detail: "详情x",
                    modelName: "mock",
                    updateTime: 1
                }
            ])
        ).rejects.toThrow("session-1");
        expect(mockCommonDBService.run).not.toHaveBeenCalled();
    });

    it("markSessionEmpty 应清除旧话题并写入 empty 终态", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        await service.markSessionEmpty("session-empty");

        const calls = mockCommonDBService.run.mock.calls;

        expect(calls[0][0]).toBe("BEGIN IMMEDIATE TRANSACTION");
        expect(calls.some(call => String(call[0]).includes("DELETE FROM ai_digest_results"))).toBe(false);
        const statusCall = calls.find(call => String(call[0]).includes("INSERT INTO ai_digest_sessions"));

        expect(statusCall?.[1]).toEqual([
            "session-empty",
            "empty",
            0,
            expect.any(Number),
            null,
            null,
            null,
            null,
            null
        ]);
        expect(calls[calls.length - 1][0]).toBe("COMMIT");
        expect(calls.some(call => String(call[0]).includes("INSERT INTO ai_digest_results"))).toBe(false);
    });

    it("tryClaimSessionForDigest 应原子写入 processing 状态", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        mockCommonDBService.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ topicCount: 0 });

        const claimed = await service.tryClaimSessionForDigest("session-claim", {
            messageCount: 3,
            timeStart: 100,
            timeEnd: 200
        });

        const statusCall = mockCommonDBService.run.mock.calls.find(call =>
            String(call[0]).includes("INSERT INTO ai_digest_sessions")
        );

        expect(claimed).toBe(true);
        expect(statusCall?.[1]).toEqual([
            "session-claim",
            "processing",
            0,
            expect.any(Number),
            expect.any(Number),
            null,
            3,
            100,
            200
        ]);
    });

    it("tryClaimSessionForDigest 遇到未过期 processing 应拒绝抢占", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        mockCommonDBService.get.mockResolvedValueOnce({
            status: "processing",
            updateTime: Date.now(),
            processingStartedAt: Date.now()
        });

        const claimed = await service.tryClaimSessionForDigest("session-claim", {
            messageCount: 1,
            timeStart: 100,
            timeEnd: 100
        });

        expect(claimed).toBe(false);
        expect(
            mockCommonDBService.run.mock.calls.some(call =>
                String(call[0]).includes("INSERT INTO ai_digest_sessions")
            )
        ).toBe(false);
    });

    it("deduplicateTopicTitles 应删除重复标题和兴趣分", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();
        mockCommonDBService.all.mockResolvedValue([{ topicId: "old-topic" }]);

        const deletedTopicIds = await service.deduplicateTopicTitles();

        expect(deletedTopicIds).toEqual(["old-topic"]);
        expect(
            mockCommonDBService.run.mock.calls.some(call =>
                String(call[0]).includes("DELETE FROM interset_score_results")
            )
        ).toBe(true);
        expect(
            mockCommonDBService.run.mock.calls.some(call =>
                String(call[0]).includes("DELETE FROM ai_digest_results")
            )
        ).toBe(true);
    });

    it("isSessionIdProcessed 命中结果表或状态表即视为已处理", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();

        mockCommonDBService.get.mockResolvedValueOnce({ processed: 1 });
        await expect(service.isSessionIdProcessed("s1")).resolves.toBe(true);

        const sql = mockCommonDBService.get.mock.calls[0][0] as string;

        expect(sql).toContain("FROM ai_digest_results");
        expect(sql).toContain("FROM ai_digest_sessions");

        mockCommonDBService.get.mockResolvedValueOnce({ processed: 0 });
        await expect(service.isSessionIdProcessed("s2")).resolves.toBe(false);
    });

    it("并发写事务应串行执行，避免事务交错", async () => {
        const service = new AgcDbAccessService();

        await service.init();
        vi.clearAllMocks();

        let activeTxn = 0;
        let maxActiveTxn = 0;

        mockCommonDBService.run.mockImplementation(async (sql: string) => {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (sql === "BEGIN IMMEDIATE TRANSACTION") {
                activeTxn++;
                maxActiveTxn = Math.max(maxActiveTxn, activeTxn);
            }
            if (sql === "COMMIT" || sql === "ROLLBACK") {
                activeTxn--;
            }
        });

        const oneResult = {
            topicId: "t",
            sessionId: "s",
            topic: "话题",
            contributors: "[]",
            detail: "d",
            modelName: "mock",
            updateTime: 1
        };

        await Promise.all([
            service.storeAIDigestResults([oneResult]),
            service.storeAIDigestResults([oneResult]),
            service.markSessionEmpty("s")
        ]);

        expect(maxActiveTxn).toBe(1);
    });
});
