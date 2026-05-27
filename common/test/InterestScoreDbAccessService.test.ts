import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { COMMON_TOKENS } from "../di/tokens";
import { InterestScoreDbAccessService } from "../services/database/InterestScoreDbAccessService";

describe("InterestScoreDbAccessService", () => {
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
        mockCommonDBService.all.mockResolvedValue([]);
        mockCommonDBService.run.mockResolvedValue(undefined);
        container.registerInstance(COMMON_TOKENS.CommonDBService, mockCommonDBService as any);
    });

    it("读取兴趣分时应保留0分结果", async () => {
        mockCommonDBService.get.mockResolvedValue({ score: 0 });
        const service = new InterestScoreDbAccessService();

        await service.init();
        const result = await service.getInterestScoreResult("topic-1");

        expect(result).toBe(0);
        expect(mockCommonDBService.get).toHaveBeenCalledWith(
            "SELECT scoreV1 AS score FROM interset_score_results WHERE topicId = ?",
            ["topic-1"]
        );
    });

    it("读取兴趣分时应按传入版本读取对应分数列", async () => {
        mockCommonDBService.get.mockResolvedValue({ score: 0.75 });
        const service = new InterestScoreDbAccessService();

        await service.init();
        const result = await service.getInterestScoreResult("topic-2", 2);

        expect(result).toBe(0.75);
        expect(mockCommonDBService.get).toHaveBeenCalledWith(
            "SELECT scoreV2 AS score FROM interset_score_results WHERE topicId = ?",
            ["topic-2"]
        );
    });

    it("查询不到兴趣分时应返回null", async () => {
        mockCommonDBService.get.mockResolvedValue(undefined);
        const service = new InterestScoreDbAccessService();

        await service.init();
        const result = await service.getInterestScoreResult("missing-topic");

        expect(result).toBeNull();
    });

    it("应批量读取已有兴趣分的topicId集合", async () => {
        mockCommonDBService.all.mockResolvedValue([{ topicId: "topic-1" }, { topicId: "topic-3" }]);
        const service = new InterestScoreDbAccessService();

        await service.init();
        const result = await service.getExistingInterestScoreTopicIds(["topic-1", "topic-2", "topic-1"], 2);

        expect(mockCommonDBService.all).toHaveBeenCalledWith(
            `SELECT topicId FROM interset_score_results
             WHERE topicId IN (?, ?)
               AND scoreV2 IS NOT NULL`,
            ["topic-1", "topic-2"]
        );
        expect(result).toEqual(new Set(["topic-1", "topic-3"]));
    });

    it("批量存储兴趣分应使用事务", async () => {
        const service = new InterestScoreDbAccessService();

        await service.init();
        await service.storeInterestScoreResults(
            [
                { topicId: "topic-1", score: 0 },
                { topicId: "topic-2", score: 0.8 }
            ],
            2
        );

        expect(mockCommonDBService.run.mock.calls[0][0]).toBe("BEGIN IMMEDIATE TRANSACTION");
        expect(mockCommonDBService.run.mock.calls[1][0]).toContain("scoreV2");
        expect(mockCommonDBService.run.mock.calls[mockCommonDBService.run.mock.calls.length - 1][0]).toBe(
            "COMMIT"
        );
        expect(mockCommonDBService.run).toHaveBeenCalledTimes(4);
    });
});
