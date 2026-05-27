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
});
