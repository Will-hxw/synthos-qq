import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { COMMON_TOKENS } from "../di/tokens";
import { AgcDbAccessService } from "../services/database/AgcDbAccessService";

describe("AgcDbAccessService", () => {
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
        mockCommonDBService.all.mockResolvedValue([]);
        mockCommonDBService.run.mockResolvedValue(undefined);
        container.registerInstance(COMMON_TOKENS.CommonDBService, mockCommonDBService as any);
    });

    it("最新话题分页查询应在数据库层完成过滤排序和分页", async () => {
        const service = new AgcDbAccessService();

        await service.init();
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
        mockCommonDBService.all.mockResolvedValue([
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
        ]);
        const service = new AgcDbAccessService();

        await service.init();
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

    it("批量存储摘要结果应使用事务", async () => {
        const service = new AgcDbAccessService();

        await service.init();
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

        expect(mockCommonDBService.run.mock.calls[0][0]).toBe("BEGIN IMMEDIATE TRANSACTION");
        expect(mockCommonDBService.run.mock.calls[mockCommonDBService.run.mock.calls.length - 1][0]).toBe(
            "COMMIT"
        );
        expect(mockCommonDBService.run).toHaveBeenCalledTimes(4);
    });
});
