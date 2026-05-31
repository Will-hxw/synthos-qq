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

        expect(sql).toContain(
            "NOT EXISTS (SELECT 1 FROM ai_digest_sessions ds WHERE ds.sessionId = cm.sessionId)"
        );
        expect(sql).toContain("HAVING COUNT(ar.topicId) = 0");
        expect(params).toEqual(["group-a", 10]);
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
