import "reflect-metadata";

import type { ReportDBRecord } from "../contracts/report/index";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { COMMON_TOKENS } from "../di/tokens";
import { ReportDbAccessService } from "../services/database/ReportDbAccessService";

describe("ReportDbAccessService", () => {
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
        mockCommonDBService.get.mockResolvedValue(undefined);
        mockCommonDBService.all.mockResolvedValue([]);
        mockCommonDBService.run.mockResolvedValue(undefined);
        container.registerInstance(COMMON_TOKENS.CommonDBService, mockCommonDBService as any);
    });

    it("应按类型和完整周期精确读取报告并优先返回成功报告", async () => {
        mockCommonDBService.get.mockResolvedValue(createReportRecord({ reportId: "success-report" }));
        const service = new ReportDbAccessService();

        await service.init();
        const report = await service.getReportByTypeAndExactPeriod("weekly", 100, 200);

        const sql = mockCommonDBService.get.mock.calls[0][0] as string;
        const params = mockCommonDBService.get.mock.calls[0][1];

        expect(sql).toContain("WHERE type = ? AND timeStart = ? AND timeEnd = ?");
        expect(sql).toContain("ORDER BY CASE summaryStatus WHEN 'success' THEN 0 ELSE 1 END ASC");
        expect(sql).toContain("LIMIT 1");
        expect(params).toEqual(["weekly", 100, 200]);
        expect(report?.reportId).toBe("success-report");
        expect(report?.summaryStatus).toBe("success");
    });

    it("查不到完整周期报告时应返回 null", async () => {
        const service = new ReportDbAccessService();

        await service.init();
        const report = await service.getReportByTypeAndExactPeriod("half-daily", 100, 200);

        expect(report).toBeNull();
    });

    it("分页查询传入 favoriteReportIds 时应按 reportId IN (...) 过滤", async () => {
        mockCommonDBService.get.mockResolvedValue({ count: 2 });
        mockCommonDBService.all.mockResolvedValue([createReportRecord({ reportId: "fav-1" })]);
        const service = new ReportDbAccessService();

        await service.init();
        await service.getReportsPaginated(1, 10, "weekly", ["fav-1", "fav-2"]);

        const countSql = mockCommonDBService.get.mock.calls[0][0] as string;
        const countParams = mockCommonDBService.get.mock.calls[0][1];
        const selectSql = mockCommonDBService.all.mock.calls[0][0] as string;
        const selectParams = mockCommonDBService.all.mock.calls[0][1];

        expect(countSql).toContain("type = ?");
        expect(countSql).toContain("reportId IN (?, ?)");
        expect(countParams).toEqual(["weekly", "fav-1", "fav-2"]);
        expect(selectSql).toContain("ORDER BY timeEnd DESC LIMIT ? OFFSET ?");
        expect(selectParams).toEqual(["weekly", "fav-1", "fav-2", 10, 0]);
    });

    it("分页查询收藏集为空时应直接返回空结果且不查询数据库", async () => {
        const service = new ReportDbAccessService();

        await service.init();
        const result = await service.getReportsPaginated(1, 10, undefined, []);

        expect(result).toEqual({ reports: [], total: 0 });
        expect(mockCommonDBService.get).not.toHaveBeenCalled();
        expect(mockCommonDBService.all).not.toHaveBeenCalled();
    });

    it("分页查询不传 favoriteReportIds 时不应包含收藏过滤条件", async () => {
        mockCommonDBService.get.mockResolvedValue({ count: 5 });
        mockCommonDBService.all.mockResolvedValue([]);
        const service = new ReportDbAccessService();

        await service.init();
        await service.getReportsPaginated(2, 10);

        const countSql = mockCommonDBService.get.mock.calls[0][0] as string;
        const selectParams = mockCommonDBService.all.mock.calls[0][1];

        expect(countSql).not.toContain("reportId IN");
        expect(countSql).toBe("SELECT COUNT(*) as count FROM reports");
        // page=2, pageSize=10 => offset 10
        expect(selectParams).toEqual([10, 10]);
    });
});

function createReportRecord(overrides: Partial<ReportDBRecord> = {}): ReportDBRecord {
    return {
        reportId: "report-1",
        type: "weekly",
        timeStart: 100,
        timeEnd: 200,
        isEmpty: 0,
        summary: "summary",
        summaryGeneratedAt: 150,
        summaryStatus: "success",
        model: "mock-model",
        statisticsJson: JSON.stringify({ topicCount: 1, mostActiveGroups: ["group-a"], mostActiveHour: 8 }),
        topicIdsJson: JSON.stringify(["topic-1"]),
        createdAt: 120,
        updatedAt: 160,
        ...overrides
    };
}
