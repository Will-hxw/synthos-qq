import "reflect-metadata";

import type { Report, ReportSummaryStatus } from "@root/common/contracts/report/index";
import type { LatestTopicRecord } from "@root/common/services/database/AgcDbAccessService";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    mockAgendaCreate,
    mockAgendaDefine,
    mockCheckConnectivity,
    mockGetEmptyReportText,
    mockGetReportSummaryPrompt,
    mockLogger
} = vi.hoisted(() => {
    const save = vi.fn().mockResolvedValue(undefined);
    const unique = vi.fn(() => ({ save }));

    return {
        mockAgendaCreate: vi.fn(() => ({ unique })),
        mockAgendaDefine: vi.fn(),
        mockCheckConnectivity: vi.fn().mockResolvedValue(true),
        mockGetEmptyReportText: vi.fn((periodDescription: string) => `${periodDescription} 暂无热门话题讨论。`),
        mockGetReportSummaryPrompt: vi.fn().mockResolvedValue({
            serializeToString: () => "报告提示词"
        }),
        mockLogger: {
            debug: vi.fn(),
            info: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn()
        }
    };
});

vi.mock("@root/common/scheduler/agenda", () => ({
    agendaInstance: {
        create: mockAgendaCreate,
        define: mockAgendaDefine,
        ready: Promise.resolve()
    }
}));

vi.mock("@root/common/util/Logger", () => ({
    default: {
        withTag: () => mockLogger
    }
}));

vi.mock("@root/common/util/network/checkConnectivity", () => ({
    checkConnectivity: mockCheckConnectivity
}));

vi.mock("../context/prompts/ReportPromptStore", () => ({
    ReportPromptStore: {
        getEmptyReportText: mockGetEmptyReportText,
        getReportSummaryPrompt: mockGetReportSummaryPrompt
    }
}));

import { GenerateReportTaskHandler } from "../tasks/GenerateReport";

describe("GenerateReportTaskHandler", () => {
    const mockConfigManagerService = {
        getCurrentConfig: vi.fn()
    };
    const mockAgcDbAccessService = {
        getLatestTopicRecordsByTimeRange: vi.fn(),
        selectAll: vi.fn()
    };
    const mockReportDbAccessService = {
        getReportByTypeAndExactPeriod: vi.fn(),
        storeReport: vi.fn()
    };
    const mockReportEmailService = {
        sendReportEmail: vi.fn()
    };
    const mockTextGeneratorService = {
        generateTextWithModelCandidates: vi.fn(),
        dispose: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            report: {
                enabled: true,
                generation: {
                    topNTopics: 10,
                    interestScoreThreshold: 0,
                    llmRetryCount: 0,
                    aiModels: ["mock-model"]
                }
            },
            groupConfigs: {}
        });
        mockAgcDbAccessService.getLatestTopicRecordsByTimeRange.mockResolvedValue([
            createTopicRecord({ topicId: "topic-1" })
        ]);
        mockAgcDbAccessService.selectAll.mockResolvedValue([]);
        mockReportDbAccessService.getReportByTypeAndExactPeriod.mockResolvedValue(null);
        mockReportDbAccessService.storeReport.mockResolvedValue(undefined);
        mockReportEmailService.sendReportEmail.mockResolvedValue(undefined);
        mockTextGeneratorService.generateTextWithModelCandidates.mockResolvedValue({
            content: "报告综述",
            selectedModelName: "mock-model"
        });
        mockCheckConnectivity.mockResolvedValue(true);
    });

    it("应按聊天消息时间查询报告候选，摘要更新时间在范围外也能入报", async () => {
        mockAgcDbAccessService.getLatestTopicRecordsByTimeRange.mockResolvedValue([
            createTopicRecord({
                topicId: "topic-chat-time",
                updateTime: 999_999,
                timeStart: 1_100,
                timeEnd: 1_500,
                groupId: "group-a",
                interestScore: 0.7
            })
        ]);

        await runProcessor(
            mockConfigManagerService,
            mockAgcDbAccessService,
            mockReportDbAccessService,
            mockReportEmailService,
            mockTextGeneratorService
        );

        expect(mockAgcDbAccessService.getLatestTopicRecordsByTimeRange).toHaveBeenCalledWith(1_000, 2_000);
        expect(mockAgcDbAccessService.selectAll).not.toHaveBeenCalled();
        expect(mockReportDbAccessService.storeReport).toHaveBeenCalledWith(
            expect.objectContaining({
                topicIds: ["topic-chat-time"],
                summaryStatus: "success"
            })
        );
        expect(mockTextGeneratorService.generateTextWithModelCandidates).toHaveBeenCalledWith(
            ["mock-model"],
            expect.any(String)
        );
    });

    it("不应从全量摘要中按 updateTime 捞取未命中聊天时间的 topic", async () => {
        mockAgcDbAccessService.getLatestTopicRecordsByTimeRange.mockResolvedValue([]);
        mockAgcDbAccessService.selectAll.mockResolvedValue([
            createTopicRecord({
                topicId: "topic-update-time-only",
                updateTime: 1_500,
                timeStart: 100,
                timeEnd: 200
            })
        ]);

        await runProcessor(
            mockConfigManagerService,
            mockAgcDbAccessService,
            mockReportDbAccessService,
            mockReportEmailService,
            mockTextGeneratorService
        );

        expect(mockAgcDbAccessService.selectAll).not.toHaveBeenCalled();
        expect(mockReportDbAccessService.storeReport).toHaveBeenCalledWith(
            expect.objectContaining({
                isEmpty: true,
                topicIds: []
            })
        );
    });

    it("报告统计应使用真实 groupId 和 session 结束时间", async () => {
        const hourEight = new Date("2026-01-01T08:30:00").getTime();
        const hourNine = new Date("2026-01-01T09:30:00").getTime();

        mockAgcDbAccessService.getLatestTopicRecordsByTimeRange.mockResolvedValue([
            createTopicRecord({ topicId: "topic-a1", groupId: "group-a", timeEnd: hourEight, interestScore: 0.8 }),
            createTopicRecord({
                topicId: "topic-a2",
                groupId: "group-a",
                timeEnd: hourEight,
                interestScore: null
            }),
            createTopicRecord({ topicId: "topic-b1", groupId: "group-b", timeEnd: hourNine, interestScore: 0.7 })
        ]);

        await runProcessor(
            mockConfigManagerService,
            mockAgcDbAccessService,
            mockReportDbAccessService,
            mockReportEmailService,
            mockTextGeneratorService
        );

        const report = mockReportDbAccessService.storeReport.mock.calls[0][0] as Report;

        expect(report.statistics).toEqual({
            topicCount: 3,
            mostActiveGroups: ["group-a", "group-b"],
            mostActiveHour: 8
        });
    });

    it("缺失 groupId 的 topic 应在统计中降级为 unknown", async () => {
        mockAgcDbAccessService.getLatestTopicRecordsByTimeRange.mockResolvedValue([
            createTopicRecord({ topicId: "topic-unknown", groupId: "" })
        ]);

        await runProcessor(
            mockConfigManagerService,
            mockAgcDbAccessService,
            mockReportDbAccessService,
            mockReportEmailService,
            mockTextGeneratorService
        );

        const report = mockReportDbAccessService.storeReport.mock.calls[0][0] as Report;

        expect(report.statistics.mostActiveGroups).toEqual(["unknown"]);
    });

    it("已有成功报告时应跳过重复生成", async () => {
        mockReportDbAccessService.getReportByTypeAndExactPeriod.mockResolvedValue(
            createReport({ reportId: "success-report", summaryStatus: "success" })
        );

        await runProcessor(
            mockConfigManagerService,
            mockAgcDbAccessService,
            mockReportDbAccessService,
            mockReportEmailService,
            mockTextGeneratorService
        );

        expect(mockAgcDbAccessService.getLatestTopicRecordsByTimeRange).not.toHaveBeenCalled();
        expect(mockReportDbAccessService.storeReport).not.toHaveBeenCalled();
    });

    it.each(["pending", "failed"] as const)("已有 %s 报告时应复用 reportId 原地重试", async status => {
        mockReportDbAccessService.getReportByTypeAndExactPeriod.mockResolvedValue(
            createReport({
                reportId: "retry-report",
                summaryStatus: status,
                createdAt: 123
            })
        );

        await runProcessor(
            mockConfigManagerService,
            mockAgcDbAccessService,
            mockReportDbAccessService,
            mockReportEmailService,
            mockTextGeneratorService
        );

        const report = mockReportDbAccessService.storeReport.mock.calls[0][0] as Report;

        expect(report.reportId).toBe("retry-report");
        expect(report.createdAt).toBe(123);
        expect(report.summaryStatus).toBe("success");
    });
});

async function runProcessor(
    mockConfigManagerService: any,
    mockAgcDbAccessService: any,
    mockReportDbAccessService: any,
    mockReportEmailService: any,
    mockTextGeneratorService: any
): Promise<void> {
    const handler = new GenerateReportTaskHandler(
        mockConfigManagerService,
        mockAgcDbAccessService,
        mockReportDbAccessService,
        mockReportEmailService,
        mockTextGeneratorService
    );

    await handler.register();

    const processor = mockAgendaDefine.mock.calls[0][1] as (job: any) => Promise<void>;

    await processor({
        attrs: {
            name: "GenerateReport",
            data: {
                reportType: "weekly",
                timeStart: 1_000,
                timeEnd: 2_000
            }
        }
    });
}

function createTopicRecord(overrides: Partial<LatestTopicRecord> = {}): LatestTopicRecord {
    return {
        topicId: "topic-1",
        sessionId: "session-1",
        topic: "话题",
        contributors: "发送者",
        detail: "摘要详情",
        modelName: "summary-model",
        updateTime: 1_500,
        timeStart: 1_100,
        timeEnd: 1_900,
        groupId: "group-a",
        interestScore: 0.5,
        ...overrides
    };
}

function createReport(overrides: Partial<Report> = {}): Report {
    return {
        reportId: "report-1",
        type: "weekly",
        timeStart: 1_000,
        timeEnd: 2_000,
        isEmpty: false,
        summary: "",
        summaryGeneratedAt: 0,
        summaryStatus: "pending" as ReportSummaryStatus,
        model: "",
        statistics: { topicCount: 0, mostActiveGroups: [], mostActiveHour: 0 },
        topicIds: [],
        createdAt: 100,
        updatedAt: 100,
        ...overrides
    };
}
