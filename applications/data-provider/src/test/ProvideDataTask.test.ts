import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    mockAgendaCreate,
    mockAgendaDefine,
    mockAgendaSave,
    mockAgendaUnique,
    mockConfigManagerService,
    mockImDbAccessService,
    mockQQProvider,
    mockCursorStore,
    mockKVStoreConstructor,
    mockLogger
} = vi.hoisted(() => {
    const save = vi.fn().mockResolvedValue(undefined);
    const unique = vi.fn(() => ({ save }));
    const qqProvider = {
        init: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
        getMsgByTimeRange: vi.fn(),
        getBusinessMsgIdPageAfterCursor: vi.fn(),
        getMsgsByMsgIds: vi.fn()
    };
    const cursorStore = {
        get: vi.fn(),
        put: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined)
    };

    return {
        mockAgendaCreate: vi.fn(() => ({ unique })),
        mockAgendaDefine: vi.fn(),
        mockAgendaSave: save,
        mockAgendaUnique: unique,
        mockConfigManagerService: {
            getCurrentConfig: vi.fn()
        },
        mockImDbAccessService: {
            getNewestRawChatMessageByGroupId: vi.fn(),
            storeRawChatMessages: vi.fn().mockResolvedValue(undefined),
            getExistingRawChatMessageIds: vi.fn()
        },
        mockQQProvider: qqProvider,
        mockCursorStore: cursorStore,
        mockKVStoreConstructor: vi.fn(),
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

vi.mock("@root/common/util/KVStore", () => ({
    KVStore: class MockKVStore {
        public constructor(location: string) {
            mockKVStoreConstructor(location);
        }

        public get = mockCursorStore.get;
        public put = mockCursorStore.put;
        public del = mockCursorStore.del;
        public dispose = mockCursorStore.dispose;
    }
}));

vi.mock("../di/container", () => ({
    getQQProvider: () => mockQQProvider
}));

import { IMTypes, QQ_SOURCE_RECONCILE_STATUS_PREFIX } from "@root/common/contracts/data-provider/index";

import { ProvideDataTaskHandler } from "../tasks/ProvideDataTask";

describe("ProvideDataTaskHandler", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            dataProviders: {
                QQ: {
                    sourceReconcile: {
                        batchSize: 50000
                    }
                }
            },
            webUI_Backend: {
                kvStoreBasePath: "D:\\tmp\\synthos-kv"
            }
        });
        mockImDbAccessService.storeRawChatMessages.mockResolvedValue(undefined);
        mockImDbAccessService.getNewestRawChatMessageByGroupId.mockResolvedValue(null);
        mockImDbAccessService.getExistingRawChatMessageIds.mockResolvedValue(new Set<string>());
        mockQQProvider.init.mockResolvedValue(undefined);
        mockQQProvider.dispose.mockResolvedValue(undefined);
        mockQQProvider.getMsgByTimeRange.mockResolvedValue([]);
        mockQQProvider.getBusinessMsgIdPageAfterCursor.mockResolvedValue({
            messages: [],
            nextCursor: null,
            reachedEnd: true,
            wrapped: false
        });
        mockQQProvider.getMsgsByMsgIds.mockResolvedValue([]);
        mockCursorStore.get.mockResolvedValue(undefined);
        mockCursorStore.put.mockResolvedValue(undefined);
        mockCursorStore.del.mockResolvedValue(undefined);
        mockCursorStore.dispose.mockResolvedValue(undefined);
    });

    it("普通增量应继续按主库最新时间拉取", async () => {
        const currentMessage = createRawMessage("current-msg", "group-a", 20_000);

        mockImDbAccessService.getNewestRawChatMessageByGroupId.mockResolvedValue({
            timestamp: 20_000
        });
        mockQQProvider.getMsgByTimeRange.mockResolvedValue([currentMessage]);

        await runProvideDataJob({
            groupIds: ["group-a"],
            startTimeStamp: -1,
            endTimeStamp: 30_000
        });

        expect(mockQQProvider.getMsgByTimeRange).toHaveBeenCalledWith(19_000, 30_000, "group-a");
        expect(mockImDbAccessService.storeRawChatMessages).toHaveBeenNthCalledWith(1, [currentMessage]);
        expect(mockQQProvider.getBusinessMsgIdPageAfterCursor).toHaveBeenCalledWith("group-a", null, 50000);
        expect(mockCursorStore.del).toHaveBeenCalledWith("qq-source-reconcile:group-a");
        expect(mockCursorStore.put).toHaveBeenCalledWith(
            `${QQ_SOURCE_RECONCILE_STATUS_PREFIX}:group-a`,
            expect.objectContaining({
                groupId: "group-a",
                scannedCount: 0,
                missingCount: 0,
                insertedCount: 0,
                reachedEnd: true
            })
        );
    });

    it("历史补漏应只回源解析缺失 msgId 并推进游标", async () => {
        const missingMessage = createRawMessage("missing-msg", "group-a", 10_000);
        const nextCursor = {
            msgId: "missing-msg",
            timestamp: 10_000
        };

        mockCursorStore.get.mockResolvedValue({
            msgId: "cursor-msg",
            timestamp: 5_000
        });
        mockQQProvider.getBusinessMsgIdPageAfterCursor.mockResolvedValue({
            messages: [
                { msgId: "existing-msg", timestamp: 9_000 },
                { msgId: "missing-msg", timestamp: 10_000 }
            ],
            nextCursor,
            reachedEnd: false,
            wrapped: false
        });
        mockImDbAccessService.getExistingRawChatMessageIds.mockResolvedValue(new Set(["existing-msg"]));
        mockQQProvider.getMsgsByMsgIds.mockResolvedValue([missingMessage]);

        await runProvideDataJob({
            groupIds: ["group-a"],
            startTimeStamp: 1_000,
            endTimeStamp: 30_000
        });

        expect(mockQQProvider.getMsgsByMsgIds).toHaveBeenCalledWith(["missing-msg"], "group-a");
        expect(mockImDbAccessService.storeRawChatMessages).toHaveBeenNthCalledWith(2, [missingMessage]);
        expect(mockCursorStore.put).toHaveBeenCalledWith("qq-source-reconcile:group-a", nextCursor);
        expect(mockCursorStore.put).toHaveBeenCalledWith(
            `${QQ_SOURCE_RECONCILE_STATUS_PREFIX}:group-a`,
            expect.objectContaining({
                groupId: "group-a",
                scannedCount: 2,
                missingCount: 1,
                insertedCount: 1,
                reachedEnd: false,
                batchSize: 50000
            })
        );
        expect(mockCursorStore.del).not.toHaveBeenCalledWith("qq-source-reconcile:group-a");
    });

    it("历史补漏扫到末尾时应清理游标供下一轮从头扫描", async () => {
        mockQQProvider.getBusinessMsgIdPageAfterCursor.mockResolvedValue({
            messages: [{ msgId: "existing-msg", timestamp: 9_000 }],
            nextCursor: {
                msgId: "existing-msg",
                timestamp: 9_000
            },
            reachedEnd: true,
            wrapped: false
        });
        mockImDbAccessService.getExistingRawChatMessageIds.mockResolvedValue(new Set(["existing-msg"]));

        await runProvideDataJob({
            groupIds: ["group-a"],
            startTimeStamp: 1_000,
            endTimeStamp: 30_000
        });

        expect(mockQQProvider.getMsgsByMsgIds).toHaveBeenCalledWith([], "group-a");
        expect(mockCursorStore.del).toHaveBeenCalledWith("qq-source-reconcile:group-a");
        expect(mockCursorStore.put).not.toHaveBeenCalledWith("qq-source-reconcile:group-a", expect.anything());
        expect(mockCursorStore.put).toHaveBeenCalledWith(
            `${QQ_SOURCE_RECONCILE_STATUS_PREFIX}:group-a`,
            expect.objectContaining({
                groupId: "group-a",
                scannedCount: 1,
                missingCount: 0,
                insertedCount: 0,
                reachedEnd: true,
                batchSize: 50000
            })
        );
    });

    it("QQ 原库回填批大小应读取配置", async () => {
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            dataProviders: {
                QQ: {
                    sourceReconcile: {
                        batchSize: 1234
                    }
                }
            },
            webUI_Backend: {
                kvStoreBasePath: "D:\\tmp\\synthos-kv"
            }
        });

        await runProvideDataJob({
            groupIds: ["group-a"],
            startTimeStamp: 1_000,
            endTimeStamp: 30_000
        });

        expect(mockQQProvider.getBusinessMsgIdPageAfterCursor).toHaveBeenCalledWith("group-a", null, 1234);
        expect(mockCursorStore.put).toHaveBeenCalledWith(
            `${QQ_SOURCE_RECONCILE_STATUS_PREFIX}:group-a`,
            expect.objectContaining({
                groupId: "group-a",
                batchSize: 1234,
                reachedEnd: true
            })
        );
    });

    async function runProvideDataJob(data: {
        groupIds: string[];
        startTimeStamp: number;
        endTimeStamp: number;
    }): Promise<void> {
        const handler = new ProvideDataTaskHandler(mockConfigManagerService as any, mockImDbAccessService as any);

        await handler.register();

        const processor = mockAgendaDefine.mock.calls[0][1] as (job: any) => Promise<void>;

        await processor({
            attrs: {
                name: "ProvideData",
                data: {
                    IMType: IMTypes.QQ,
                    ...data
                }
            },
            touch: vi.fn().mockResolvedValue(undefined)
        });
    }
});

function createRawMessage(msgId: string, groupId: string, timestamp: number) {
    return {
        msgId,
        messageContent: `消息 ${msgId}`,
        groupId,
        timestamp,
        senderId: "sender",
        senderGroupNickname: "发送者",
        senderNickname: "发送者"
    };
}
