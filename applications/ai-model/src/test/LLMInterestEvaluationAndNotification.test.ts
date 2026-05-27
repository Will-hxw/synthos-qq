import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    mockAgendaCreate,
    mockAgendaDefine,
    mockAgendaSave,
    mockAgendaUnique,
    mockEvaluationPut,
    mockKVDispose,
    mockKVGet,
    mockLogger,
    mockNotificationPut
} = vi.hoisted(() => {
    const save = vi.fn().mockResolvedValue(undefined);
    const unique = vi.fn(() => ({ save }));

    return {
        mockAgendaCreate: vi.fn(() => ({ unique })),
        mockAgendaDefine: vi.fn(),
        mockAgendaSave: save,
        mockAgendaUnique: unique,
        mockEvaluationPut: vi.fn().mockResolvedValue(undefined),
        mockKVDispose: vi.fn().mockResolvedValue(undefined),
        mockKVGet: vi.fn().mockResolvedValue(undefined),
        mockLogger: {
            debug: vi.fn(),
            info: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn()
        },
        mockNotificationPut: vi.fn().mockResolvedValue(undefined)
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

vi.mock("@root/common/util/KVStore", () => ({
    KVStore: class MockKVStore {
        private readonly isNotificationStore: boolean;

        public constructor(pathValue: string) {
            this.isNotificationStore = pathValue.endsWith("Notification");
        }

        public async get(key: string): Promise<boolean | undefined> {
            return mockKVGet(key);
        }

        public async put(key: string, value: boolean): Promise<void> {
            if (this.isNotificationStore) {
                await mockNotificationPut(key, value);
            } else {
                await mockEvaluationPut(key, value);
            }
        }

        public async dispose(): Promise<void> {
            await mockKVDispose();
        }
    }
}));

import { LLMInterestEvaluationAndNotificationTaskHandler } from "../tasks/LLMInterestEvaluationAndNotification";

describe("LLMInterestEvaluationAndNotificationTaskHandler", () => {
    const mockConfigManagerService = {
        getCurrentConfig: vi.fn()
    };
    const mockImDbAccessService = {
        getSessionIdsByGroupIdsAndTimeRange: vi.fn()
    };
    const mockAgcDbAccessService = {
        getAIDigestResultsBySessionIds: vi.fn()
    };
    const mockTextGeneratorService = {
        generateTextWithModelCandidates: vi.fn()
    };
    const mockInterestEmailService = {
        sendInterestTopicsEmail: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            ai: {
                defaultModelName: "mock-model",
                interestScore: {
                    llmEvaluationDescriptions: ["技术讨论"],
                    llmEvaluationBatchSize: 10
                }
            },
            groupConfigs: {
                "123456": {}
            },
            webUI_Backend: {
                kvStoreBasePath: "D:/tmp/synthos-kv"
            }
        });
        mockImDbAccessService.getSessionIdsByGroupIdsAndTimeRange.mockResolvedValue([
            { groupId: "123456", sessionIds: ["session-1"] }
        ]);
        mockAgcDbAccessService.getAIDigestResultsBySessionIds.mockResolvedValue([
            {
                sessionId: "session-1",
                result: [
                    {
                        topicId: "topic-1",
                        sessionId: "session-1",
                        topic: "测试话题",
                        detail: "测试详情",
                        contributors: "[]",
                        modelName: "mock-model",
                        updateTime: 1
                    }
                ]
            }
        ]);
        mockInterestEmailService.sendInterestTopicsEmail.mockResolvedValue("skipped");
    });

    it("邮件跳过时不应写入通知 KV，也不应记录发送失败 warning", async () => {
        const handler = new LLMInterestEvaluationAndNotificationTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any,
            mockAgcDbAccessService as any,
            mockTextGeneratorService as any,
            mockInterestEmailService as any
        );

        vi.spyOn(handler as any, "_evaluateTopicsBatch").mockResolvedValue([true]);

        await handler.register();

        expect(mockAgendaCreate).toHaveBeenCalled();
        expect(mockAgendaUnique).toHaveBeenCalled();
        expect(mockAgendaSave).toHaveBeenCalled();
        const processor = mockAgendaDefine.mock.calls[0][1] as (job: any) => Promise<void>;

        await processor({
            attrs: {
                name: "LLMInterestEvaluationAndNotification",
                data: {
                    startTimeStamp: 1,
                    endTimeStamp: 2
                }
            },
            touch: vi.fn().mockResolvedValue(undefined)
        });

        expect(mockInterestEmailService.sendInterestTopicsEmail).toHaveBeenCalledOnce();
        expect(mockEvaluationPut).toHaveBeenCalledWith("topic-1", true);
        expect(mockNotificationPut).not.toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledWith("邮件通知已跳过");
        expect(mockLogger.warning).not.toHaveBeenCalledWith("邮件通知发送失败");
    });
});
