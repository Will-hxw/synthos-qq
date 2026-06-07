import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    mockAgendaCreate,
    mockAgendaDefine,
    mockAgendaSave,
    mockAgendaUnique,
    mockAccumulativeSplitter,
    mockLogger
} = vi.hoisted(() => {
    const save = vi.fn().mockResolvedValue(undefined);
    const unique = vi.fn(() => ({ save }));
    const splitter = {
        init: vi.fn().mockResolvedValue(undefined),
        assignSessionId: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined)
    };

    return {
        mockAgendaCreate: vi.fn(() => ({ unique })),
        mockAgendaDefine: vi.fn(),
        mockAgendaSave: save,
        mockAgendaUnique: unique,
        mockAccumulativeSplitter: splitter,
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

vi.mock("../di/container", () => ({
    getAccumulativeSplitter: () => mockAccumulativeSplitter,
    getTimeoutSplitter: () => mockAccumulativeSplitter
}));

import { PreprocessTaskHandler } from "../tasks/PreprocessTask";

describe("PreprocessTaskHandler", () => {
    const mockConfigManagerService = {
        getCurrentConfig: vi.fn()
    };
    const mockImDbAccessService = {
        getRawChatMessageByMsgId: vi.fn(),
        storeProcessedChatMessages: vi.fn(),
        getEarliestUnprocessedMessageTimeRangeByGroupId: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            preprocessors: {
                historicalBackfill: {
                    messageLimit: 5000
                }
            },
            groupConfigs: {
                "group-a": {
                    splitStrategy: "accumulative"
                }
            }
        });
        mockImDbAccessService.storeProcessedChatMessages.mockResolvedValue(undefined);
        mockImDbAccessService.getEarliestUnprocessedMessageTimeRangeByGroupId.mockResolvedValue(null);
        mockAccumulativeSplitter.assignSessionId.mockResolvedValue([]);
    });

    it("应在当前窗口处理后追加一批历史未分配消息回填", async () => {
        const currentMessage = createMessage("current-msg", "group-a", 1000);
        const historicalMessage = createMessage("historical-msg", "group-a", 10);

        mockAccumulativeSplitter.assignSessionId.mockImplementation(
            async (_groupId: string, startTimeStamp: number) => {
                if (startTimeStamp === 1000) {
                    return [currentMessage];
                }

                if (startTimeStamp === 10) {
                    return [historicalMessage];
                }

                return [];
            }
        );
        mockImDbAccessService.getEarliestUnprocessedMessageTimeRangeByGroupId.mockResolvedValue({
            timeStart: 10,
            timeEnd: 20,
            count: 2
        });

        const handler = new PreprocessTaskHandler(mockConfigManagerService as any, mockImDbAccessService as any);

        await handler.register();

        const processor = mockAgendaDefine.mock.calls[0][1] as (job: any) => Promise<void>;

        await processor({
            attrs: {
                name: "Preprocess",
                data: {
                    groupIds: ["group-a"],
                    startTimeStamp: 1000,
                    endTimeStamp: 2000
                }
            },
            touch: vi.fn().mockResolvedValue(undefined)
        });

        expect(mockAccumulativeSplitter.assignSessionId).toHaveBeenNthCalledWith(1, "group-a", 1000, 2000);
        expect(mockAccumulativeSplitter.assignSessionId).toHaveBeenNthCalledWith(2, "group-a", 10, 20);
        expect(mockImDbAccessService.getEarliestUnprocessedMessageTimeRangeByGroupId).toHaveBeenCalledWith(
            "group-a",
            5000
        );
        expect(mockImDbAccessService.storeProcessedChatMessages).toHaveBeenCalledTimes(2);
        expect(mockImDbAccessService.storeProcessedChatMessages).toHaveBeenNthCalledWith(
            2,
            expect.arrayContaining([
                expect.objectContaining({
                    msgId: "historical-msg",
                    sessionId: "session-historical-msg"
                })
            ])
        );
    });

    it("历史未分配消息回填数量应读取配置", async () => {
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            preprocessors: {
                historicalBackfill: {
                    messageLimit: 1234
                }
            },
            groupConfigs: {
                "group-a": {
                    splitStrategy: "accumulative"
                }
            }
        });

        const handler = new PreprocessTaskHandler(mockConfigManagerService as any, mockImDbAccessService as any);

        await handler.register();

        const processor = mockAgendaDefine.mock.calls[0][1] as (job: any) => Promise<void>;

        await processor({
            attrs: {
                name: "Preprocess",
                data: {
                    groupIds: ["group-a"],
                    startTimeStamp: 1000,
                    endTimeStamp: 2000
                }
            },
            touch: vi.fn().mockResolvedValue(undefined)
        });

        expect(mockImDbAccessService.getEarliestUnprocessedMessageTimeRangeByGroupId).toHaveBeenCalledWith(
            "group-a",
            1234
        );
    });
});

function createMessage(msgId: string, groupId: string, timestamp: number) {
    return {
        msgId,
        messageContent: `消息 ${msgId}`,
        groupId,
        timestamp,
        senderId: "sender",
        senderGroupNickname: "发送者",
        senderNickname: "发送者",
        sessionId: `session-${msgId}`,
        preProcessedContent: ""
    };
}
