import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    mockAgendaCreate,
    mockAgendaDefine,
    mockBuildCtx,
    mockCtxDispose,
    mockCtxInit,
    mockGenerateContent,
    mockLogger,
    mockPooledDispose,
    mockPooledInit,
    mockSubmitTasks
} = vi.hoisted(() => {
    const save = vi.fn().mockResolvedValue(undefined);
    const unique = vi.fn(() => ({ save }));

    return {
        mockAgendaCreate: vi.fn(() => ({ unique })),
        mockAgendaDefine: vi.fn(),
        mockBuildCtx: vi.fn().mockResolvedValue("摘要上下文"),
        mockCtxDispose: vi.fn().mockResolvedValue(undefined),
        mockCtxInit: vi.fn().mockResolvedValue(undefined),
        mockGenerateContent: vi.fn((sessionId: string) =>
            JSON.stringify([{ topic: `话题 ${sessionId}`, contributors: ["发送者"], detail: "摘要详情" }])
        ),
        mockLogger: {
            debug: vi.fn(),
            info: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn()
        },
        mockPooledDispose: vi.fn(),
        mockPooledInit: vi.fn().mockResolvedValue(undefined),
        mockSubmitTasks: vi.fn()
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
    checkConnectivity: vi.fn().mockResolvedValue(true)
}));

vi.mock("../context/ctxBuilders/IMSummaryCtxBuilder", () => ({
    IMSummaryCtxBuilder: class MockIMSummaryCtxBuilder {
        public async init(): Promise<void> {
            await mockCtxInit();
        }

        public async buildCtx(messages: unknown[], groupIntroduction: string): Promise<string> {
            return await mockBuildCtx(messages, groupIntroduction);
        }

        public dispose(): void {
            mockCtxDispose();
        }
    }
}));

vi.mock("../services/generators/text/PooledTextGeneratorService", () => ({
    PooledTextGeneratorService: class MockPooledTextGeneratorService {
        public constructor(public readonly maxConcurrentRequests: number) {}

        public async init(): Promise<void> {
            await mockPooledInit();
        }

        public async submitTasks(tasks: any[], onComplete: (result: any) => Promise<void>): Promise<void> {
            await mockSubmitTasks(tasks, onComplete);
            for (const task of tasks) {
                await onComplete({
                    isSuccess: true,
                    content: mockGenerateContent(task.context.sessionId),
                    selectedModelName: "mock-model",
                    context: task.context
                });
            }
        }

        public dispose(): void {
            mockPooledDispose();
        }
    }
}));

import { AISummarizeTaskHandler } from "../tasks/AISummarize";

describe("AISummarizeTaskHandler", () => {
    const mockConfigManagerService = {
        getCurrentConfig: vi.fn()
    };
    const mockImDbAccessService = {
        getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange: vi.fn(),
        getUnsummarizedSessionStatsByGroupId: vi.fn(),
        getProcessedChatMessagesBySessionId: vi.fn(),
        getActiveDigestSessionBlockStatsByGroupIds: vi.fn()
    };
    const mockAgcDbAccessService = {
        tryClaimSessionForDigest: vi.fn(),
        commitSessionDigest: vi.fn(),
        markSessionEmpty: vi.fn(),
        markSessionFailed: vi.fn(),
        repairClosedDigestSessionOverruns: vi.fn(),
        getClosedDigestSessionOverrunStats: vi.fn()
    };
    const mockVectorDBManagerService = {
        deleteEmbeddingsIfExists: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            ai: {
                maxConcurrentRequests: 5
            },
            groupConfigs: {
                "group-a": {
                    groupIntroduction: "测试群",
                    aiModels: ["mock-model"]
                }
            }
        });
        mockImDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange.mockResolvedValue([]);
        mockImDbAccessService.getUnsummarizedSessionStatsByGroupId.mockResolvedValue([]);
        mockImDbAccessService.getActiveDigestSessionBlockStatsByGroupIds.mockResolvedValue([]);
        mockImDbAccessService.getProcessedChatMessagesBySessionId.mockImplementation(async (sessionId: string) => [
            createMessage(`${sessionId}-msg-1`, "group-a", sessionId, 1000)
        ]);
        mockAgcDbAccessService.tryClaimSessionForDigest.mockResolvedValue(true);
        mockAgcDbAccessService.commitSessionDigest.mockResolvedValue([]);
        mockAgcDbAccessService.markSessionEmpty.mockResolvedValue([]);
        mockAgcDbAccessService.markSessionFailed.mockResolvedValue(undefined);
        mockAgcDbAccessService.repairClosedDigestSessionOverruns.mockResolvedValue([]);
        mockAgcDbAccessService.getClosedDigestSessionOverrunStats.mockResolvedValue([]);
        mockVectorDBManagerService.deleteEmbeddingsIfExists.mockReturnValue(undefined);
        mockGenerateContent.mockImplementation((sessionId: string) =>
            JSON.stringify([{ topic: `话题 ${sessionId}`, contributors: ["发送者"], detail: "摘要详情" }])
        );
    });

    it("只有一个低活跃 session 且超过延迟窗口时也应生成摘要", async () => {
        mockImDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange.mockResolvedValue(
            Array.from({ length: 5 }, (_, index) =>
                createMessage(`small-${index}`, "group-a", "small-session", 1000 + index)
            )
        );

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockSubmitTasks.mock.calls[0][0]).toHaveLength(1);
        expect(mockSubmitTasks.mock.calls[0][0][0].context).toEqual({
            groupId: "group-a",
            sessionId: "small-session"
        });
        expect(mockSubmitTasks.mock.calls[0][0][0].modelNames).toEqual(["mock-model"]);
        expect(mockAgcDbAccessService.commitSessionDigest).toHaveBeenCalledOnce();
    });

    it("未摘要历史 session 不在当前时间窗时也应生成摘要", async () => {
        mockImDbAccessService.getUnsummarizedSessionStatsByGroupId.mockResolvedValue([
            {
                sessionId: "historical-session",
                messageCount: 3,
                timeStart: 100,
                timeEnd: 200
            }
        ]);
        mockImDbAccessService.getProcessedChatMessagesBySessionId.mockResolvedValue([
            createMessage("historical-1", "group-a", "historical-session", 100),
            createMessage("historical-2", "group-a", "historical-session", 200)
        ]);

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockImDbAccessService.getUnsummarizedSessionStatsByGroupId).toHaveBeenCalledWith("group-a", 500);
        expect(mockSubmitTasks.mock.calls[0][0]).toHaveLength(1);
        expect(mockSubmitTasks.mock.calls[0][0][0].context.sessionId).toBe("historical-session");
        expect(mockAgcDbAccessService.commitSessionDigest).toHaveBeenCalledOnce();
    });

    it("距离任务结束时间过近的 session 应延迟处理", async () => {
        mockImDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange.mockResolvedValue([
            createMessage("open-1", "group-a", "open-session", 1_990_000)
        ]);

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockSubmitTasks.mock.calls[0][0]).toHaveLength(0);
        expect(mockAgcDbAccessService.commitSessionDigest).not.toHaveBeenCalled();
    });

    it("抢占失败的 session 不应重复生成摘要", async () => {
        mockImDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange.mockResolvedValue([
            createMessage("done-1", "group-a", "done-session", 1000)
        ]);
        mockAgcDbAccessService.tryClaimSessionForDigest.mockResolvedValue(false);

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockSubmitTasks.mock.calls[0][0]).toHaveLength(0);
        expect(mockAgcDbAccessService.commitSessionDigest).not.toHaveBeenCalled();
    });

    it("LLM 返回空数组时应标记为空摘要而非写入话题", async () => {
        mockImDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange.mockResolvedValue(
            Array.from({ length: 5 }, (_, index) =>
                createMessage(`empty-${index}`, "group-a", "empty-session", 1000 + index)
            )
        );
        mockGenerateContent.mockReturnValue(JSON.stringify([]));

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockAgcDbAccessService.markSessionEmpty).toHaveBeenCalledWith("empty-session");
        expect(mockVectorDBManagerService.deleteEmbeddingsIfExists).toHaveBeenCalledWith([]);
        expect(mockAgcDbAccessService.commitSessionDigest).not.toHaveBeenCalled();
    });

    it("同一 session 内重复标题与空标题应被去重过滤", async () => {
        mockImDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange.mockResolvedValue(
            Array.from({ length: 5 }, (_, index) =>
                createMessage(`dup-${index}`, "group-a", "dup-session", 1000 + index)
            )
        );
        mockGenerateContent.mockReturnValue(
            JSON.stringify([
                { topic: "  话题A  ", contributors: ["甲"], detail: "d1" },
                { topic: "话题A", contributors: ["乙"], detail: "d2" },
                { topic: "   ", contributors: ["丙"], detail: "d3" },
                { topic: "话题B", contributors: ["丁"], detail: "d4" }
            ])
        );

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockAgcDbAccessService.markSessionEmpty).not.toHaveBeenCalled();
        expect(mockAgcDbAccessService.commitSessionDigest).toHaveBeenCalledOnce();
        const [sessionId, results] = mockAgcDbAccessService.commitSessionDigest.mock.calls[0];

        expect(sessionId).toBe("dup-session");
        expect(results.map((item: any) => item.topic)).toEqual(["话题A", "话题B"]);
        expect(results.every((item: any) => item.sessionId === "dup-session")).toBe(true);
    });

    it("提交摘要后应清理被替换话题的向量", async () => {
        mockImDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange.mockResolvedValue(
            Array.from({ length: 5 }, (_, index) =>
                createMessage(`replace-${index}`, "group-a", "replace-session", 1000 + index)
            )
        );
        mockAgcDbAccessService.commitSessionDigest.mockResolvedValue(["old-topic"]);

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockVectorDBManagerService.deleteEmbeddingsIfExists).toHaveBeenCalledWith(["old-topic"]);
    });

    it("摘要结果解析失败时应写入 failed 终态", async () => {
        mockImDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange.mockResolvedValue(
            Array.from({ length: 5 }, (_, index) =>
                createMessage(`bad-${index}`, "group-a", "bad-session", 1000 + index)
            )
        );
        mockGenerateContent.mockReturnValue("不是JSON");

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockAgcDbAccessService.markSessionFailed).toHaveBeenCalledWith(
            "bad-session",
            expect.stringContaining("Unexpected")
        );
        expect(mockAgcDbAccessService.commitSessionDigest).not.toHaveBeenCalled();
    });

    it("应记录终态 session 后续仍有新消息的诊断日志", async () => {
        mockAgcDbAccessService.getClosedDigestSessionOverrunStats.mockResolvedValue([
            {
                sessionId: "closed-session",
                groupId: "group-a",
                status: "success",
                summarizedTimeEnd: 1000,
                latestMessageTime: 2000,
                overrunMessageCount: 3
            }
        ]);

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockAgcDbAccessService.getClosedDigestSessionOverrunStats).toHaveBeenCalledWith();
        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("closed-session"));
        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("超出消息数=3"));
    });

    it("应修复终态 session 后续仍有新消息并记录日志", async () => {
        mockAgcDbAccessService.repairClosedDigestSessionOverruns.mockResolvedValue([
            {
                oldSessionId: "closed-session",
                newSessionId: "new-session",
                groupId: "group-a",
                status: "success",
                summarizedTimeEnd: 1000,
                latestMessageTime: 2000,
                repairedMessageCount: 3
            }
        ]);
        mockAgcDbAccessService.getClosedDigestSessionOverrunStats.mockResolvedValue([]);

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockAgcDbAccessService.repairClosedDigestSessionOverruns).toHaveBeenCalledWith();
        expect(mockAgcDbAccessService.getClosedDigestSessionOverrunStats).toHaveBeenCalledWith();
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining("closed-session"));
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining("new-session"));
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining("修复消息数=3"));
    });

    it("修复终态 session 追加消息失败时应中断任务", async () => {
        mockAgcDbAccessService.repairClosedDigestSessionOverruns.mockRejectedValue(new Error("repair failed"));

        await expect(
            runProcessor(
                mockConfigManagerService,
                mockImDbAccessService,
                mockAgcDbAccessService,
                mockVectorDBManagerService,
                2_000_000
            )
        ).rejects.toThrow("repair failed");

        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("repair failed"));
        expect(mockSubmitTasks).not.toHaveBeenCalled();
    });

    it("本轮无任务但存在保护窗口内 session 时应记录诊断日志", async () => {
        mockImDbAccessService.getActiveDigestSessionBlockStatsByGroupIds.mockResolvedValue([
            {
                status: "processing",
                sessionCount: 16,
                messageCount: 1700,
                earliestRetryTime: 2_000_000,
                latestUpdateTime: 1_000_000
            }
        ]);

        await runProcessor(
            mockConfigManagerService,
            mockImDbAccessService,
            mockAgcDbAccessService,
            mockVectorDBManagerService,
            2_000_000
        );

        expect(mockImDbAccessService.getActiveDigestSessionBlockStatsByGroupIds).toHaveBeenCalledWith(["group-a"]);
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining("16 个 processing session"));
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining("最早重试时间"));
    });
});

async function runProcessor(
    mockConfigManagerService: any,
    mockImDbAccessService: any,
    mockAgcDbAccessService: any,
    mockVectorDBManagerService: any,
    endTimeStamp: number
) {
    const handler = new AISummarizeTaskHandler(
        mockConfigManagerService as any,
        mockImDbAccessService as any,
        mockAgcDbAccessService as any,
        mockVectorDBManagerService as any
    );

    await handler.register();

    const processor = mockAgendaDefine.mock.calls[0][1] as (job: any) => Promise<void>;

    await processor({
        attrs: {
            name: "AISummarize",
            data: {
                groupIds: ["group-a"],
                startTimeStamp: 0,
                endTimeStamp
            }
        },
        touch: vi.fn().mockResolvedValue(undefined)
    });
}

function createMessage(msgId: string, groupId: string, sessionId: string, timestamp: number) {
    return {
        msgId,
        messageContent: `消息 ${msgId}`,
        groupId,
        timestamp,
        senderId: "sender",
        senderGroupNickname: "发送者",
        senderNickname: "发送者",
        sessionId,
        preProcessedContent: `预处理 ${msgId}`
    };
}
