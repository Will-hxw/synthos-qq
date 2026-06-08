import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { COMMON_TOKENS } from "../di/tokens";
import { ImDbAccessService } from "../services/database/ImDbAccessService";

describe("ImDbAccessService", () => {
    const mockCommonDBService = {
        init: vi.fn(),
        get: vi.fn(),
        all: vi.fn()
    };

    beforeEach(() => {
        container.reset();
        vi.clearAllMocks();
        mockCommonDBService.init.mockResolvedValue(undefined);
        mockCommonDBService.all.mockResolvedValue([]);
        container.registerInstance(COMMON_TOKENS.CommonDBService, mockCommonDBService as any);
    });

    it("根据不存在的消息id查询raw消息时应抛错", async () => {
        mockCommonDBService.get.mockResolvedValue(undefined);
        const service = new ImDbAccessService();

        await service.init();

        await expect(service.getRawChatMessageByMsgId("missing-msg")).rejects.toThrow(
            "消息不存在，msgId: missing-msg"
        );
        expect(mockCommonDBService.get).toHaveBeenCalledWith("SELECT * FROM chat_messages WHERE msgId =?", [
            "missing-msg"
        ]);
    });

    it("应批量查询多个群组的sessionId并保持输入顺序", async () => {
        mockCommonDBService.all.mockResolvedValue([
            { groupId: "group-b", sessionId: "session-b" },
            { groupId: "group-a", sessionId: "session-a-1" },
            { groupId: "group-a", sessionId: "session-a-2" }
        ]);
        const service = new ImDbAccessService();

        await service.init();
        const result = await service.getSessionIdsByGroupIdsAndTimeRange(
            ["group-a", "group-b", "group-a"],
            100,
            200
        );

        expect(mockCommonDBService.all).toHaveBeenCalledWith(
            `SELECT DISTINCT groupId, sessionId
             FROM chat_messages
             WHERE groupId IN (?, ?)
               AND (timestamp BETWEEN ? AND ?)
               AND sessionId IS NOT NULL`,
            ["group-a", "group-b", 100, 200]
        );
        expect(result).toEqual([
            { groupId: "group-a", sessionIds: ["session-a-1", "session-a-2"] },
            { groupId: "group-b", sessionIds: ["session-b"] },
            { groupId: "group-a", sessionIds: ["session-a-1", "session-a-2"] }
        ]);
    });

    it("回填未摘要 session 应排除已写入终态的 session", async () => {
        const service = new ImDbAccessService();

        await service.init();
        await service.getUnsummarizedSessionStatsByGroupId("group-a", 10);

        const sql = mockCommonDBService.all.mock.calls[0][0] as string;
        const params = mockCommonDBService.all.mock.calls[0][1];

        expect(sql).toContain("FROM ai_digest_sessions ds");
        expect(sql).toContain("ds.status IN ('success', 'empty')");
        expect(sql).toContain("ds.status IN ('processing', 'failed') AND ds.updateTime >= ?");
        expect(sql).toContain("HAVING COUNT(ar.topicId) = 0");
        expect(params).toEqual(["group-a", expect.any(Number), 10]);
    });

    it("摘要阻塞诊断应统计保护窗口内的processing和failed session", async () => {
        mockCommonDBService.all.mockResolvedValue([
            {
                status: "processing",
                sessionCount: 16,
                messageCount: 1700,
                earliestRetryTime: 2000,
                latestUpdateTime: 1000
            }
        ]);
        const service = new ImDbAccessService();

        await service.init();
        const result = await service.getActiveDigestSessionBlockStatsByGroupIds(["group-a", "group-b", "group-a"]);

        const sql = mockCommonDBService.all.mock.calls[0][0] as string;
        const params = mockCommonDBService.all.mock.calls[0][1];

        expect(sql).toContain("FROM ai_digest_sessions ds");
        expect(sql).toContain("INNER JOIN chat_messages cm ON cm.sessionId = ds.sessionId");
        expect(sql).toContain("cm.groupId IN (?, ?)");
        expect(sql).toContain("ds.status = 'processing'");
        expect(sql).toContain("ds.status = 'failed'");
        expect(sql).toContain("COALESCE(ds.processingStartedAt, ds.updateTime)");
        expect(params).toEqual([expect.any(Number), "group-a", "group-b", expect.any(Number), expect.any(Number)]);
        expect(result).toEqual([
            {
                status: "processing",
                sessionCount: 16,
                messageCount: 1700,
                earliestRetryTime: 2000,
                latestUpdateTime: 1000
            }
        ]);
    });

    it("摘要覆盖诊断应按群和时间范围只读聚合三表状态", async () => {
        mockCommonDBService.get.mockResolvedValue({
            messageCount: 3,
            assignedMessageCount: 2,
            unassignedMessageCount: 1,
            assignedSessionCount: 1,
            timeStart: 100,
            timeEnd: 200,
            unassignedTimeStart: 150,
            unassignedTimeEnd: 150
        });
        mockCommonDBService.all
            .mockResolvedValueOnce([
                {
                    sessionId: "session-1",
                    messageCount: 2,
                    timeStart: 100,
                    timeEnd: 200,
                    status: "failed",
                    updateTime: 300,
                    processingStartedAt: null,
                    failReason: "模型失败",
                    statusTopicCount: 0,
                    resultTopicCount: 0
                }
            ])
            .mockResolvedValueOnce([
                {
                    msgId: "msg-2",
                    timestamp: 150,
                    senderId: "sender-1",
                    senderNickname: "发送者",
                    messageContent: "未分配消息"
                }
            ]);
        const service = new ImDbAccessService();

        await service.init();
        const result = await service.getDigestCoverageSnapshotByGroupIdAndTimeRange("group-a", 100, 200, 50);

        const rawSql = mockCommonDBService.get.mock.calls[0][0] as string;
        const rawParams = mockCommonDBService.get.mock.calls[0][1];
        const sessionSql = mockCommonDBService.all.mock.calls[0][0] as string;
        const sessionParams = mockCommonDBService.all.mock.calls[0][1];
        const sampleSql = mockCommonDBService.all.mock.calls[1][0] as string;
        const sampleParams = mockCommonDBService.all.mock.calls[1][1];

        expect(rawSql).toContain("COUNT(*) AS messageCount");
        expect(rawSql).toContain("WHERE groupId = ? AND timestamp BETWEEN ? AND ?");
        expect(rawParams).toEqual(["group-a", 100, 200]);
        expect(sessionSql).toContain("FROM chat_messages");
        expect(sessionSql).toContain("LEFT JOIN ai_digest_sessions");
        expect(sessionSql).toContain("FROM ai_digest_results");
        expect(sessionSql).toContain("sessionId IS NOT NULL");
        expect(sessionParams).toEqual(["group-a", 100, 200]);
        expect(sampleSql).toContain("sessionId IS NULL");
        expect(sampleParams).toEqual(["group-a", 100, 200, 50]);
        expect(result.rawMessageStats.unassignedMessageCount).toBe(1);
        expect(result.sessions[0].sessionId).toBe("session-1");
        expect(result.unassignedMessageSamples[0].msgId).toBe("msg-2");
    });

    it("应批量查询会话时间范围并按输入顺序返回，缺失会话以 undefined 占位", async () => {
        mockCommonDBService.all.mockResolvedValue([
            { sessionId: "session-2", timeStart: 300, timeEnd: 500 },
            { sessionId: "session-1", timeStart: 100, timeEnd: 200 }
        ]);
        const service = new ImDbAccessService();

        await service.init();
        const result = await service.getSessionTimeDurations(["session-1", "session-2", "session-missing"]);

        // 单次 GROUP BY 聚合，而非逐 sessionId 查询
        expect(mockCommonDBService.all).toHaveBeenCalledTimes(1);
        expect(mockCommonDBService.all).toHaveBeenCalledWith(
            `SELECT sessionId, MIN(timestamp) AS timeStart, MAX(timestamp) AS timeEnd
                 FROM chat_messages
                 WHERE sessionId IN (?,?,?)
                 GROUP BY sessionId`,
            ["session-1", "session-2", "session-missing"]
        );
        expect(result).toEqual([
            { sessionId: "session-1", timeStart: 100, timeEnd: 200 },
            { sessionId: "session-2", timeStart: 300, timeEnd: 500 },
            { sessionId: "session-missing", timeStart: undefined, timeEnd: undefined }
        ]);
    });

    it("批量查询会话时间范围传入空数组应直接返回空且不查库", async () => {
        const service = new ImDbAccessService();

        await service.init();
        const result = await service.getSessionTimeDurations([]);

        expect(result).toEqual([]);
        expect(mockCommonDBService.all).not.toHaveBeenCalled();
    });
});
