import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import ErrorReasons from "@root/common/contracts/ErrorReasons";

import { GroupMsgColumn as GMC } from "../providers/QQProvider/@types/mappers/GroupMsgColumn";
import { MsgElementType } from "../providers/QQProvider/@types/mappers/MsgElementType";
import { MsgType } from "../providers/QQProvider/@types/mappers/MsgType";

// 使用 vi.hoisted 来创建可以在 mock 中引用的变量
const { mockConfig, mockConfigManager, mockDbMethods, mockParserMethods, mockLogger } = vi.hoisted(() => ({
    mockConfig: {
        dataProviders: {
            QQ: {
                VFSExtPath: "/mock/path/to/vfs_ext.dll",
                dbBasePath: "/mock/path/to/db",
                dbKey: "mock_db_key_12345",
                dbPatch: {
                    enabled: false,
                    patchSQL: ""
                }
            }
        }
    },
    mockConfigManager: {
        getCurrentConfig: vi.fn()
    },
    mockDbMethods: {
        open: vi.fn().mockResolvedValue(undefined),
        loadExtension: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue(undefined),
        prepare: vi.fn(),
        all: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined)
    },
    mockParserMethods: {
        init: vi.fn().mockResolvedValue(undefined),
        parseMessageSegment: vi.fn()
    },
    mockLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn()
    }
}));

// Mock Logger
vi.mock("@root/common/util/Logger", () => ({
    default: {
        debug: mockLogger.debug,
        info: mockLogger.info,
        success: mockLogger.success,
        warning: mockLogger.warning,
        error: mockLogger.error,
        withTag: () => mockLogger
    }
}));

// Mock ASSERT，避免断言失败时给测试 worker 发送 SIGINT
vi.mock("@root/common/util/ASSERT", () => ({
    ASSERT: (condition: unknown, message?: string) => {
        if (!condition) {
            throw new Error("断言失败！" + (message ? message : ""));
        }
    },
    ASSERT_NOT_FATAL: vi.fn()
}));

// Mock ConfigManagerService
vi.mock("@root/common/services/config/ConfigManagerService", () => ({
    ConfigManagerService: class MockConfigManagerService {},
    default: mockConfigManager
}));

// Mock PromisifiedSQLite - 需要返回一个类
vi.mock("@root/common/util/promisify/PromisifiedSQLite", () => {
    return {
        PromisifiedSQLite: class MockPromisifiedSQLite {
            open = mockDbMethods.open;
            loadExtension = mockDbMethods.loadExtension;
            exec = mockDbMethods.exec;
            prepare = mockDbMethods.prepare;
            all = mockDbMethods.all;
            dispose = mockDbMethods.dispose;
        }
    };
});

// Mock MessagePBParser - 需要返回一个类
vi.mock("../providers/QQProvider/parsers/MessagePBParser", () => {
    return {
        MessagePBParser: class MockMessagePBParser {
            init = mockParserMethods.init;
            parseMessageSegment = mockParserMethods.parseMessageSegment;
        }
    };
});

// Mock sqlcipher - 需要提供 default 导出，因为 QQProvider.ts 使用 default import
vi.mock("@journeyapps/sqlcipher", () => ({
    default: {
        verbose: () => ({})
    }
}));

// Mock mustInitBeforeUse - 使其变成透传装饰器
vi.mock("@root/common/util/lifecycle/mustInitBeforeUse", () => ({
    mustInitBeforeUse: <T extends new (...args: any[]) => any>(constructor: T) => constructor
}));

// Mock Disposable - 简单的空实现
vi.mock("@root/common/util/lifecycle/Disposable", () => ({
    Disposable: class MockDisposable {
        protected _registerDisposable<T>(disposable: T): T {
            return disposable;
        }
        protected _registerDisposableFunction(_func: () => Promise<void> | void): void {}
        async dispose(): Promise<void> {}
        get isDisposed(): boolean {
            return false;
        }
    }
}));

type QQProvider = import("../providers/QQProvider/QQProvider").QQProvider;

let QQProviderClass: new (...args: any[]) => QQProvider;

// ==================== 测试用例 ====================

describe("QQProvider", () => {
    let qqProvider: QQProvider;

    beforeAll(async () => {
        QQProviderClass = (await import("../providers/QQProvider/QQProvider")).QQProvider as unknown as new (
            ...args: any[]
        ) => QQProvider;
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        mockConfigManager.getCurrentConfig.mockResolvedValue(mockConfig);

        // 设置默认的 prepare mock 返回值（用于 init 中的表数量查询）
        mockDbMethods.prepare.mockResolvedValue({
            get: vi.fn().mockResolvedValue({ "count(*)": 10 }),
            finalize: vi.fn().mockResolvedValue(undefined)
        });

        qqProvider = new QQProviderClass(mockConfigManager as any);
    });

    afterEach(async () => {
        await qqProvider.dispose();
    });

    describe("初始化相关", () => {
        it("未初始化时调用方法应抛出 UNINITIALIZED_ERROR", async () => {
            const uninitializedProvider = new QQProviderClass(mockConfigManager as any);

            // 由于 db 为 null，调用 getMsgByTimeRange 会抛出 UNINITIALIZED_ERROR
            await expect(uninitializedProvider.getMsgByTimeRange(0, 1000)).rejects.toBe("UNINITIALIZED_ERROR");

            await uninitializedProvider.dispose();
        });

        it("初始化成功应正确设置数据库连接和解析器", async () => {
            await qqProvider.init();

            // 验证数据库连接流程
            expect(mockDbMethods.open).toHaveBeenCalledWith(":memory:");
            expect(mockDbMethods.loadExtension).toHaveBeenCalledWith(mockConfig.dataProviders.QQ.VFSExtPath);
            expect(mockDbMethods.open).toHaveBeenCalledWith(mockConfig.dataProviders.QQ.dbBasePath + "/nt_msg.db");
            expect(mockDbMethods.exec).toHaveBeenCalled();

            // 验证解析器初始化
            expect(mockParserMethods.init).toHaveBeenCalled();
        });

        it("初始化时应执行正确的加密配置", async () => {
            await qqProvider.init();

            const execCalls = mockDbMethods.exec.mock.calls;
            const execCall = execCalls.find((call: string[]) => call[0].includes("PRAGMA key"));

            expect(execCall).toBeDefined();
            expect(execCall![0]).toContain(`PRAGMA key = '${mockConfig.dataProviders.QQ.dbKey}'`);
            expect(execCall![0]).toContain("PRAGMA cipher_page_size = 4096");
            expect(execCall![0]).toContain("PRAGMA kdf_iter = 4000");
        });
    });

    describe("getMsgByTimeRange", () => {
        const mockTimestamp = 1700000000000; // 示例时间戳（毫秒）
        const mockGroupId = "123456789";
        const mockSenderId = "987654321";
        const mockMsgId = "7654321098765432100";

        const createMockDbRow = (overrides = {}) => ({
            [GMC.msgId]: mockMsgId,
            [GMC.msgTime]: Math.floor(mockTimestamp / 1000),
            [GMC.groupUin]: mockGroupId,
            [GMC.peeruin]: mockGroupId,
            [GMC.senderUin]: mockSenderId,
            [GMC.replyMsgSeq]: null,
            [GMC.msgContent]: Buffer.from("mock content"),
            [GMC.sendMemberName]: "测试群昵称",
            [GMC.sendNickName]: "测试昵称",
            ...overrides
        });

        beforeEach(async () => {
            await qqProvider.init();
        });

        it("应正确返回时间范围内的文本消息", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.TEXT,
                        messageText: "你好，世界！"
                    }
                ]
            });

            const timeStart = mockTimestamp - 3600000; // 1小时前
            const timeEnd = mockTimestamp + 3600000; // 1小时后

            const result = await qqProvider.getMsgByTimeRange(timeStart, timeEnd);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                msgId: mockMsgId,
                messageContent: "你好，世界！",
                groupId: mockGroupId,
                senderId: mockSenderId,
                senderGroupNickname: "测试群昵称",
                senderNickname: "测试昵称"
            });
            expect(result[0].timestamp).toBe(Math.floor(mockTimestamp / 1000) * 1000);
        });

        it("禁用数据库补丁时 SQL 应包含恒真条件", async () => {
            mockDbMethods.all.mockResolvedValue([]);

            await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            const sqlCall = mockDbMethods.all.mock.calls[0][0] as string;

            expect(sqlCall).toContain("WHERE 1 = 1");
            expect(sqlCall).toContain('AND ("40050" BETWEEN');
        });

        it("应正确处理表情消息", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.EMOJI,
                        emojiText: "微笑"
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("[微笑]");
        });

        it("应正确处理图片消息", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.IMAGE
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("[图片，暂无文字描述]");
        });

        it("图片消息存在识别文本时应进入消息正文", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.IMAGE,
                        imageText: "图片里的文字"
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("[图片文字：图片里的文字]");
        });

        it("应正确处理语音消息", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.VOICE
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("[语音，暂无转文字]");
        });

        it("语音消息存在转写文本时应进入消息正文", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.VOICE,
                        pttText: "语音转写内容",
                        duration: 5
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("[语音转文字：语音转写内容]");
        });

        it("应正确处理文件消息", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.FILE,
                        fileName: "test.pdf"
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("[文件，文件名：test.pdf]");
        });

        it("应从卡片消息中提取可读文本", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.CARD,
                        applicationMessage: JSON.stringify({
                            title: "分享标题",
                            desc: "分享描述",
                            url: "https://example.com/a"
                        })
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("[卡片消息，分享标题；分享描述；https://example.com/a]");
        });

        it("应正确处理混合消息（文本+表情）", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.TEXT,
                        messageText: "今天天气真好"
                    },
                    {
                        messageId: "elem_2",
                        elementType: MsgElementType.EMOJI,
                        emojiText: "太阳"
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("今天天气真好[太阳]");
        });

        it("应过滤空内容的消息", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: 999, // 未知类型
                        messageText: ""
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(0);
        });

        it("正文为空但引用内容有效时应保留消息", async () => {
            const mockRow = createMockDbRow({
                [GMC.msgType]: MsgType.REPLY,
                [GMC.replyMsgSeq]: 123,
                [GMC.extraData]: Buffer.from("mock extra")
            });

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment
                .mockReturnValueOnce({
                    extraMessage: {
                        messages: [
                            {
                                messageId: "quoted_1",
                                elementType: MsgElementType.TEXT,
                                messageText: "被引用的内容"
                            }
                        ]
                    }
                })
                .mockReturnValueOnce({
                    messages: [
                        {
                            messageId: "elem_1",
                            elementType: 999,
                            messageText: ""
                        }
                    ]
                });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("");
            expect(result[0].quotedMsgContent).toBe("被引用的内容");
        });

        it("消息正文 protobuf 解析失败时应跳过该消息", async () => {
            const mockRow = createMockDbRow();

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockImplementation(() => {
                throw ErrorReasons.PROTOBUF_ERROR;
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(0);
            expect(mockLogger.warning).toHaveBeenCalledWith("跳过 1 条消息正文解析失败的消息。");
        });

        it("诊断日志中的发送者应在群名片为空时回退到昵称", async () => {
            const mockRow = createMockDbRow({
                [GMC.sendMemberName]: "",
                [GMC.sendNickName]: "测试昵称"
            });

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: 999,
                        messageText: ""
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(0);
            expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("发送者: 测试昵称"));
        });

        it("指定群号时应使用参数化 SQL 条件", async () => {
            mockDbMethods.all.mockResolvedValue([]);
            mockParserMethods.parseMessageSegment.mockReturnValue({ messages: [] });

            await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000, mockGroupId);

            const sqlCall = mockDbMethods.all.mock.calls[0][0] as string;
            const paramsCall = mockDbMethods.all.mock.calls[0][1] as string[];

            expect(sqlCall).toContain(`"${GMC.peeruin}" = ?`);
            expect(paramsCall).toEqual([mockGroupId]);
        });

        it("groupUin 为空时应使用 peeruin 作为群号", async () => {
            const mockRow = createMockDbRow({
                [GMC.groupUin]: 0,
                [GMC.peeruin]: mockGroupId
            });

            mockDbMethods.all.mockResolvedValue([mockRow]);
            mockParserMethods.parseMessageSegment.mockReturnValue({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.TEXT,
                        messageText: "你好，世界！"
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].groupId).toBe(mockGroupId);
        });

        it("应正确处理空结果", async () => {
            mockDbMethods.all.mockResolvedValue([]);

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toEqual([]);
        });

        it("应正确转换时间戳为秒级", async () => {
            mockDbMethods.all.mockResolvedValue([]);

            const timeStartMs = 1700000000123; // 毫秒级时间戳
            const timeEndMs = 1700003600456;

            await qqProvider.getMsgByTimeRange(timeStartMs, timeEndMs);

            const sqlCall = mockDbMethods.all.mock.calls[0][0] as string;

            // 验证开始时间向下取整，结束时间向上取整
            expect(sqlCall).toContain("BETWEEN 1700000000 AND 1700003601");
        });
    });

    describe("引用消息处理", () => {
        beforeEach(async () => {
            await qqProvider.init();
        });

        it("应正确获取被引用消息的内容", async () => {
            const mockTimestamp = 1700000000000;
            const mockGroupId = "123456789";
            const quotedMsgContent = "这是被引用的原始消息";

            const mockRow = {
                [GMC.msgId]: "2222222222222222222",
                [GMC.msgTime]: Math.floor(mockTimestamp / 1000),
                [GMC.groupUin]: mockGroupId,
                [GMC.peeruin]: mockGroupId,
                [GMC.senderUin]: "987654321",
                [GMC.replyMsgSeq]: 123,
                [GMC.msgContent]: Buffer.from("mock"),
                [GMC.msgType]: MsgType.REPLY,
                [GMC.extraData]: Buffer.from("mock extra data"),
                [GMC.sendMemberName]: "测试用户",
                [GMC.sendNickName]: "测试昵称"
            };

            mockDbMethods.all.mockResolvedValueOnce([mockRow]);

            // 根据调用顺序返回不同结果：
            // 第一次调用（处理 extraData）返回引用消息内容
            // 第二次调用（处理 msgContent）返回主消息内容
            mockParserMethods.parseMessageSegment
                .mockReturnValueOnce({
                    extraMessage: {
                        messages: [
                            {
                                messageId: "quoted_elem_1",
                                elementType: MsgElementType.TEXT,
                                messageText: quotedMsgContent
                            }
                        ]
                    },
                    messages: []
                })
                .mockReturnValueOnce({
                    messages: [
                        {
                            messageId: "elem_1",
                            elementType: MsgElementType.TEXT,
                            messageText: "回复消息"
                        }
                    ]
                });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].quotedMsgContent).toBe(quotedMsgContent);
            expect(result[0].messageContent).toBe("回复消息");
        });

        it("引用消息内容为空时应汇总 warning 且不输出逐条发送者信息", async () => {
            const mockTimestamp = 1700000000000;
            const mockGroupId = "123456789";

            const mockRow = {
                [GMC.msgId]: "2222222222222222222",
                [GMC.msgTime]: Math.floor(mockTimestamp / 1000),
                [GMC.groupUin]: mockGroupId,
                [GMC.peeruin]: mockGroupId,
                [GMC.senderUin]: "987654321",
                [GMC.replyMsgSeq]: 123,
                [GMC.msgContent]: Buffer.from("mock"),
                [GMC.msgType]: MsgType.REPLY,
                [GMC.extraData]: Buffer.from("mock extra data"),
                [GMC.sendMemberName]: "测试用户",
                [GMC.sendNickName]: "测试昵称"
            };

            mockDbMethods.all.mockResolvedValueOnce([mockRow]);
            mockParserMethods.parseMessageSegment
                .mockReturnValueOnce({
                    extraMessage: {
                        messages: [
                            {
                                messageId: "quoted_elem_1",
                                elementType: 999,
                                messageText: ""
                            }
                        ]
                    },
                    messages: []
                })
                .mockReturnValueOnce({
                    messages: [
                        {
                            messageId: "elem_1",
                            elementType: MsgElementType.TEXT,
                            messageText: "回复消息"
                        }
                    ]
                });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].quotedMsgContent).toBeUndefined();
            expect(result[0].messageContent).toBe("回复消息");
            expect(mockLogger.warning).toHaveBeenCalledWith("跳过 1 条引用消息内容为空的消息引用。");
            expect(mockLogger.warning).not.toHaveBeenCalledWith(expect.stringContaining("msgId:"));
        });

        it("引用消息 extraMessage 缺失（为 null）时应跳过引用且不崩整批", async () => {
            const mockTimestamp = 1700000000000;
            const mockGroupId = "123456789";

            const mockRow = {
                [GMC.msgId]: "2222222222222222222",
                [GMC.msgTime]: Math.floor(mockTimestamp / 1000),
                [GMC.groupUin]: mockGroupId,
                [GMC.peeruin]: mockGroupId,
                [GMC.senderUin]: "987654321",
                [GMC.replyMsgSeq]: 123,
                [GMC.msgContent]: Buffer.from("mock"),
                [GMC.msgType]: MsgType.REPLY,
                [GMC.extraData]: Buffer.from("mock extra data"),
                [GMC.sendMemberName]: "测试用户",
                [GMC.sendNickName]: "测试昵称"
            };

            mockDbMethods.all.mockResolvedValueOnce([mockRow]);
            // 第一次解析 extraData：protobufjs 对缺失子消息置 extraMessage 为 null
            mockParserMethods.parseMessageSegment
                .mockReturnValueOnce({
                    extraMessage: null,
                    messages: []
                })
                .mockReturnValueOnce({
                    messages: [
                        {
                            messageId: "elem_1",
                            elementType: MsgElementType.TEXT,
                            messageText: "回复消息"
                        }
                    ]
                });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            // 不应抛错；引用内容被跳过，主消息正文仍正常入库
            expect(result).toHaveLength(1);
            expect(result[0].quotedMsgContent).toBeUndefined();
            expect(result[0].messageContent).toBe("回复消息");
            expect(mockLogger.warning).toHaveBeenCalledWith("跳过 1 条引用消息内容为空的消息引用。");
        });

        it("引用消息 replyMsgSeq 为 0 时不应触发致命断言而崩整批", async () => {
            const mockTimestamp = 1700000000000;
            const mockGroupId = "123456789";

            const mockRow = {
                [GMC.msgId]: "2222222222222222222",
                [GMC.msgTime]: Math.floor(mockTimestamp / 1000),
                [GMC.groupUin]: mockGroupId,
                [GMC.peeruin]: mockGroupId,
                [GMC.senderUin]: "987654321",
                [GMC.replyMsgSeq]: 0,
                [GMC.msgContent]: Buffer.from("mock"),
                [GMC.msgType]: MsgType.REPLY,
                [GMC.extraData]: Buffer.from("mock extra data"),
                [GMC.sendMemberName]: "测试用户",
                [GMC.sendNickName]: "测试昵称"
            };

            mockDbMethods.all.mockResolvedValueOnce([mockRow]);
            mockParserMethods.parseMessageSegment
                .mockReturnValueOnce({
                    extraMessage: {
                        messages: [
                            {
                                messageId: "quoted_elem_1",
                                elementType: MsgElementType.TEXT,
                                messageText: "被引用内容"
                            }
                        ]
                    },
                    messages: []
                })
                .mockReturnValueOnce({
                    messages: [
                        {
                            messageId: "elem_1",
                            elementType: MsgElementType.TEXT,
                            messageText: "回复消息"
                        }
                    ]
                });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].messageContent).toBe("回复消息");
        });

        it("非引用消息时 quotedMsgContent 应为 undefined", async () => {
            const mockTimestamp = 1700000000000;
            const mockGroupId = "123456789";

            const mockRow = {
                [GMC.msgId]: "2222222222222222222",
                [GMC.msgTime]: Math.floor(mockTimestamp / 1000),
                [GMC.groupUin]: mockGroupId,
                [GMC.peeruin]: mockGroupId,
                [GMC.senderUin]: "987654321",
                [GMC.replyMsgSeq]: null,
                [GMC.msgContent]: Buffer.from("mock_content"),
                [GMC.msgType]: MsgType.TEXT, // 非引用消息
                [GMC.sendMemberName]: "测试用户",
                [GMC.sendNickName]: "测试昵称"
            };

            mockDbMethods.all.mockResolvedValueOnce([mockRow]);

            // 为 msgContent 的解析返回正常消息内容
            mockParserMethods.parseMessageSegment.mockReturnValueOnce({
                messages: [
                    {
                        messageId: "elem_1",
                        elementType: MsgElementType.TEXT,
                        messageText: "普通消息"
                    }
                ]
            });

            const result = await qqProvider.getMsgByTimeRange(mockTimestamp - 1000, mockTimestamp + 1000);

            expect(result).toHaveLength(1);
            expect(result[0].quotedMsgContent).toBeUndefined();
            expect(result[0].messageContent).toBe("普通消息");
        });
    });

    describe("数据库补丁配置", () => {
        it("启用数据库补丁时应在 SQL 中包含补丁语句", async () => {
            const configWithPatch = {
                dataProviders: {
                    QQ: {
                        ...mockConfig.dataProviders.QQ,
                        dbPatch: {
                            enabled: true,
                            patchSQL: "40001 IS NOT NULL"
                        }
                    }
                }
            };

            mockConfigManager.getCurrentConfig.mockResolvedValue(configWithPatch);
            const providerWithPatch = new QQProviderClass(mockConfigManager as any);

            await providerWithPatch.init();

            mockDbMethods.all.mockResolvedValue([]);

            await providerWithPatch.getMsgByTimeRange(1700000000000, 1700001000000);

            const sqlCall = mockDbMethods.all.mock.calls[0][0] as string;

            expect(sqlCall).toContain("(40001 IS NOT NULL)");

            await providerWithPatch.dispose();
        });
    });

    describe("dispose 资源清理", () => {
        it("dispose 后不应再次抛出错误", async () => {
            await qqProvider.init();
            await qqProvider.dispose();

            // 第二次 dispose 不应报错
            await expect(qqProvider.dispose()).resolves.not.toThrow();
        });
    });
});
