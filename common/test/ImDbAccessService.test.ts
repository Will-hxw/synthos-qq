import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { COMMON_TOKENS } from "../di/tokens";
import { ImDbAccessService } from "../services/database/ImDbAccessService";

describe("ImDbAccessService", () => {
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

    async function initService(service: ImDbAccessService): Promise<void> {
        await service.init();
        mockCommonDBService.get.mockClear();
        mockCommonDBService.all.mockClear();
        mockCommonDBService.run.mockClear();
    }

    function countSqlPlaceholders(sql: unknown): number {
        return String(sql).split("?").length - 1;
    }

    it("根据不存在的消息id查询raw消息时应抛错", async () => {
        mockCommonDBService.get.mockResolvedValue(undefined);
        const service = new ImDbAccessService();

        await initService(service);

        await expect(service.getRawChatMessageByMsgId("missing-msg")).rejects.toThrow(
            "消息不存在，msgId: missing-msg"
        );
        expect(mockCommonDBService.get).toHaveBeenCalledWith("SELECT * FROM chat_messages WHERE msgId =?", [
            "missing-msg"
        ]);
    });

    it("批量写入原始消息时应同时写入图片媒体元信息", async () => {
        const service = new ImDbAccessService();

        await initService(service);
        await service.storeRawChatMessages([
            {
                msgId: "msg-1",
                messageContent: "[图片，含图片链接]",
                groupId: "group-a",
                timestamp: 1000,
                senderId: "sender-a",
                senderGroupNickname: "发送者",
                senderNickname: "发送者",
                mediaItems: [
                    {
                        mediaId: "msg-1:0",
                        msgId: "msg-1",
                        groupId: "group-a",
                        timestamp: 1000,
                        elementIndex: 0,
                        mediaType: "image",
                        sourceProvider: "QQ",
                        sourceUrl: "https://example.com/image.jpg",
                        width: 100,
                        height: 80,
                        picType: 1000,
                        originImageMd5: "abc",
                        qqImageText: "图片文字"
                    }
                ]
            }
        ]);

        const mediaInsertCall = mockCommonDBService.run.mock.calls.find(call =>
            String(call[0]).includes("INSERT INTO chat_message_media")
        );

        expect(mockCommonDBService.run).toHaveBeenCalledWith("BEGIN IMMEDIATE TRANSACTION");
        expect(mockCommonDBService.run).toHaveBeenCalledWith("COMMIT");
        expect(mediaInsertCall).toBeDefined();
        expect(countSqlPlaceholders(mediaInsertCall![0])).toBe(mediaInsertCall![1].length);
        expect(mediaInsertCall![1]).toEqual([
            "msg-1:0",
            "msg-1",
            "group-a",
            1000,
            0,
            "image",
            "QQ",
            "https://example.com/image.jpg",
            null,
            null,
            null,
            null,
            100,
            80,
            1000,
            "abc",
            "图片文字",
            "pending",
            0,
            expect.any(Number),
            expect.any(Number)
        ]);
    });

    it("无 URL 图片媒体入库时应标记为 skipped", async () => {
        const service = new ImDbAccessService();

        await initService(service);
        await service.storeRawChatMessages([
            {
                msgId: "msg-1",
                messageContent: "[图片，暂无文字描述]",
                groupId: "group-a",
                timestamp: 1000,
                senderId: "sender-a",
                senderGroupNickname: "发送者",
                senderNickname: "发送者",
                mediaItems: [
                    {
                        mediaId: "msg-1:0",
                        msgId: "msg-1",
                        groupId: "group-a",
                        timestamp: 1000,
                        elementIndex: 0,
                        mediaType: "image",
                        sourceProvider: "QQ"
                    }
                ]
            }
        ]);

        const mediaInsertCall = mockCommonDBService.run.mock.calls.find(call =>
            String(call[0]).includes("INSERT INTO chat_message_media")
        );

        expect(mediaInsertCall![1][17]).toBe("skipped");
    });

    it("只有本地缓存路径的图片媒体入库时应标记为 pending", async () => {
        const service = new ImDbAccessService();

        await initService(service);
        await service.storeRawChatMessages([
            {
                msgId: "msg-1",
                messageContent: "[图片，含本地缓存]",
                groupId: "group-a",
                timestamp: 1000,
                senderId: "sender-a",
                senderGroupNickname: "发送者",
                senderNickname: "发送者",
                mediaItems: [
                    {
                        mediaId: "msg-1:0",
                        msgId: "msg-1",
                        groupId: "group-a",
                        timestamp: 1000,
                        elementIndex: 0,
                        mediaType: "image",
                        sourceProvider: "QQ",
                        sourcePath: "nt_qq/nt_data/Pic/2026-06/Thumb/abc.jpg"
                    }
                ]
            }
        ]);

        const mediaInsertCall = mockCommonDBService.run.mock.calls.find(call =>
            String(call[0]).includes("INSERT INTO chat_message_media")
        );

        expect(mediaInsertCall![1][8]).toBe("nt_qq/nt_data/Pic/2026-06/Thumb/abc.jpg");
        expect(mediaInsertCall![1][17]).toBe("pending");
    });

    it("音频媒体入库时应按源文件路径决定 pending 或 skipped 状态", async () => {
        const service = new ImDbAccessService();

        await initService(service);
        await service.storeRawChatMessages([
            {
                msgId: "msg-1",
                messageContent: "[语音，时长：5秒]",
                groupId: "group-a",
                timestamp: 1000,
                senderId: "sender-a",
                senderGroupNickname: "发送者",
                senderNickname: "发送者",
                mediaItems: [
                    {
                        mediaId: "msg-1:0",
                        msgId: "msg-1",
                        groupId: "group-a",
                        timestamp: 1000,
                        elementIndex: 0,
                        mediaType: "audio",
                        sourceProvider: "QQ",
                        sourcePath: "Audio/voice.amr",
                        fileName: "voice.amr",
                        fileSize: 12345,
                        duration: 5
                    },
                    {
                        mediaId: "msg-1:1",
                        msgId: "msg-1",
                        groupId: "group-a",
                        timestamp: 1000,
                        elementIndex: 1,
                        mediaType: "audio",
                        sourceProvider: "QQ",
                        fileName: "missing.amr"
                    }
                ]
            }
        ]);

        const mediaInsertCalls = mockCommonDBService.run.mock.calls.filter(call =>
            String(call[0]).includes("INSERT INTO chat_message_media")
        );

        expect(mediaInsertCalls).toHaveLength(2);
        expect(mediaInsertCalls[0][1]).toEqual([
            "msg-1:0",
            "msg-1",
            "group-a",
            1000,
            0,
            "audio",
            "QQ",
            null,
            "Audio/voice.amr",
            "voice.amr",
            12345,
            5,
            null,
            null,
            null,
            null,
            null,
            "pending",
            0,
            expect.any(Number),
            expect.any(Number)
        ]);
        expect(mediaInsertCalls[1][1][17]).toBe("skipped");
    });

    it("应按群组、时间范围和 pending 状态查询待处理图片", async () => {
        mockCommonDBService.all.mockResolvedValue([
            {
                mediaId: "msg-1:0",
                msgId: "msg-1",
                groupId: "group-a",
                timestamp: 1000,
                elementIndex: 0,
                mediaType: "image",
                sourceProvider: "QQ",
                sourceUrl: "https://example.com/image.jpg",
                status: "pending",
                retryCount: 0,
                createdAt: 1000,
                updatedAt: 1000,
                messageContent: "[图片，含图片链接]"
            }
        ]);
        const service = new ImDbAccessService();

        await initService(service);
        const result = await service.getPendingImageMediaByGroupIdsAndTimeRange(
            ["group-a", "group-b", "group-a"],
            100,
            200,
            10
        );

        const sql = mockCommonDBService.all.mock.calls[0][0] as string;
        const params = mockCommonDBService.all.mock.calls[0][1];

        expect(sql).toContain("FROM chat_message_media m");
        expect(sql).toContain("m.groupId IN (?, ?)");
        expect(sql).toContain("m.timestamp BETWEEN ? AND ?");
        expect(sql).toContain("m.createdAt >= ?");
        expect(sql).toContain("m.status = 'pending'");
        expect(params).toEqual(["group-a", "group-b", 100, 200, 100, 10]);
        expect(result[0].mediaId).toBe("msg-1:0");
    });

    it("应按群组、创建时间范围和 pending 状态查询待处理语音", async () => {
        const service = new ImDbAccessService();

        await initService(service);
        mockCommonDBService.all.mockResolvedValue([
            {
                mediaId: "msg-1:0",
                msgId: "msg-1",
                groupId: "group-a",
                timestamp: 1000,
                elementIndex: 0,
                mediaType: "audio",
                sourceProvider: "QQ",
                sourcePath: "Audio/voice.amr",
                status: "pending",
                retryCount: 0,
                createdAt: 150,
                updatedAt: 150,
                messageContent: "[语音，时长：5秒]"
            }
        ]);

        const result = await service.getPendingAudioMediaByGroupIdsAndTimeRange(
            ["group-a", "group-b", "group-a"],
            100,
            200,
            10
        );

        const sql = mockCommonDBService.all.mock.calls[0][0] as string;
        const params = mockCommonDBService.all.mock.calls[0][1];

        expect(sql).toContain("FROM chat_message_media m");
        expect(sql).toContain("m.groupId IN (?, ?)");
        expect(sql).toContain("m.createdAt BETWEEN ? AND ?");
        expect(sql).toContain("m.mediaType = 'audio'");
        expect(sql).toContain("m.status = 'pending'");
        expect(params).toEqual(["group-a", "group-b", 100, 200, 10]);
        expect(result[0].mediaId).toBe("msg-1:0");
    });

    it("更新图片理解结果时应写入结果字段并按需递增 retryCount", async () => {
        const service = new ImDbAccessService();

        await initService(service);
        await service.updateChatMessageMediaUnderstanding("msg-1:0", {
            status: "pending",
            failReason: "临时失败",
            incrementRetryCount: true
        });

        const sql = mockCommonDBService.run.mock.calls[0][0] as string;
        const params = mockCommonDBService.run.mock.calls[0][1];

        expect(sql).toContain("UPDATE chat_message_media");
        expect(sql).toContain("retryCount = retryCount + ?");
        expect(params).toEqual([
            "pending",
            null,
            null,
            null,
            null,
            "临时失败",
            null,
            null,
            1,
            expect.any(Number),
            "msg-1:0"
        ]);
    });

    it("更新语音转文字结果时应写入转写字段并按需递增 retryCount", async () => {
        const service = new ImDbAccessService();

        await initService(service);
        await service.updateChatMessageMediaTranscription("msg-1:0", {
            status: "failed",
            transcript: null,
            failReason: "临时失败",
            modelName: "mimo-v2.5-asr",
            incrementRetryCount: true
        });

        const sql = mockCommonDBService.run.mock.calls[0][0] as string;
        const params = mockCommonDBService.run.mock.calls[0][1];

        expect(sql).toContain("UPDATE chat_message_media");
        expect(sql).toContain("transcript = ?");
        expect(sql).toContain("retryCount = retryCount + ?");
        expect(params).toEqual(["failed", null, "临时失败", "mimo-v2.5-asr", 1, expect.any(Number), "msg-1:0"]);
    });

    it("写回语音转文字结果时应在同一事务中更新媒体、正文和预处理文本", async () => {
        const service = new ImDbAccessService();

        await initService(service);
        await service.updateAudioTranscribedMessage("msg-1:0", "msg-1", "[语音转文字：你好]", "预处理后的你好", {
            status: "success",
            transcript: "你好",
            modelName: "mimo-v2.5-asr",
            incrementRetryCount: false
        });

        expect(mockCommonDBService.run).toHaveBeenCalledWith("BEGIN IMMEDIATE TRANSACTION");
        expect(mockCommonDBService.run).toHaveBeenCalledWith("COMMIT");
        expect(mockCommonDBService.run.mock.calls[1][0]).toContain("UPDATE chat_message_media");
        expect(mockCommonDBService.run.mock.calls[1][1]).toEqual([
            "success",
            "你好",
            null,
            "mimo-v2.5-asr",
            0,
            expect.any(Number),
            "msg-1:0"
        ]);
        expect(mockCommonDBService.run.mock.calls[2][0]).toContain("UPDATE chat_messages");
        expect(mockCommonDBService.run.mock.calls[2][1]).toEqual([
            "[语音转文字：你好]",
            "预处理后的你好",
            "预处理后的你好",
            "msg-1"
        ]);
    });

    it("应批量查询多个群组的sessionId并保持输入顺序", async () => {
        mockCommonDBService.all.mockResolvedValue([
            { groupId: "group-b", sessionId: "session-b" },
            { groupId: "group-a", sessionId: "session-a-1" },
            { groupId: "group-a", sessionId: "session-a-2" }
        ]);
        const service = new ImDbAccessService();

        await initService(service);
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

        await initService(service);
        await service.getUnsummarizedSessionStatsByGroupId("group-a", 10);

        const sql = mockCommonDBService.all.mock.calls[0][0] as string;
        const params = mockCommonDBService.all.mock.calls[0][1];

        expect(sql).toContain("FROM ai_digest_sessions ds");
        expect(sql).toContain("ds.status IN ('success', 'empty')");
        expect(sql).toContain("ds.status IN ('processing', 'failed') AND ds.updateTime >= ?");
        expect(sql).toContain("HAVING COUNT(ar.topicId) = 0");
        expect(params).toEqual(["group-a", expect.any(Number), 10]);
    });

    it("摘要阻塞诊断应统计保护窗口内的processing和failed session", async () => {
        mockCommonDBService.all.mockResolvedValue([
            {
                status: "processing",
                sessionCount: 16,
                messageCount: 1700,
                earliestRetryTime: 2000,
                latestUpdateTime: 1000
            }
        ]);
        const service = new ImDbAccessService();

        await initService(service);
        const result = await service.getActiveDigestSessionBlockStatsByGroupIds(["group-a", "group-b", "group-a"]);

        const sql = mockCommonDBService.all.mock.calls[0][0] as string;
        const params = mockCommonDBService.all.mock.calls[0][1];

        expect(sql).toContain("FROM ai_digest_sessions ds");
        expect(sql).toContain("INNER JOIN chat_messages cm ON cm.sessionId = ds.sessionId");
        expect(sql).toContain("cm.groupId IN (?, ?)");
        expect(sql).toContain("ds.status = 'processing'");
        expect(sql).toContain("ds.status = 'failed'");
        expect(sql).toContain("COALESCE(ds.processingStartedAt, ds.updateTime)");
        expect(params).toEqual([expect.any(Number), "group-a", "group-b", expect.any(Number), expect.any(Number)]);
        expect(result).toEqual([
            {
                status: "processing",
                sessionCount: 16,
                messageCount: 1700,
                earliestRetryTime: 2000,
                latestUpdateTime: 1000
            }
        ]);
    });

    it("摘要覆盖诊断应按群和时间范围只读聚合三表状态", async () => {
        mockCommonDBService.get.mockResolvedValue({
            messageCount: 3,
            assignedMessageCount: 2,
            unassignedMessageCount: 1,
            assignedSessionCount: 1,
            timeStart: 100,
            timeEnd: 200,
            unassignedTimeStart: 150,
            unassignedTimeEnd: 150
        });
        const service = new ImDbAccessService();

        await initService(service);
        mockCommonDBService.all
            .mockResolvedValueOnce([
                {
                    sessionId: "session-1",
                    messageCount: 2,
                    timeStart: 100,
                    timeEnd: 200,
                    status: "failed",
                    updateTime: 300,
                    processingStartedAt: null,
                    failReason: "模型失败",
                    statusTopicCount: 0,
                    resultTopicCount: 0
                }
            ])
            .mockResolvedValueOnce([
                {
                    msgId: "msg-2",
                    timestamp: 150,
                    senderId: "sender-1",
                    senderNickname: "发送者",
                    messageContent: "未分配消息"
                }
            ]);
        const result = await service.getDigestCoverageSnapshotByGroupIdAndTimeRange("group-a", 100, 200, 50);

        const rawSql = mockCommonDBService.get.mock.calls[0][0] as string;
        const rawParams = mockCommonDBService.get.mock.calls[0][1];
        const sessionSql = mockCommonDBService.all.mock.calls[0][0] as string;
        const sessionParams = mockCommonDBService.all.mock.calls[0][1];
        const sampleSql = mockCommonDBService.all.mock.calls[1][0] as string;
        const sampleParams = mockCommonDBService.all.mock.calls[1][1];

        expect(rawSql).toContain("COUNT(*) AS messageCount");
        expect(rawSql).toContain("WHERE groupId = ? AND timestamp BETWEEN ? AND ?");
        expect(rawParams).toEqual(["group-a", 100, 200]);
        expect(sessionSql).toContain("FROM chat_messages");
        expect(sessionSql).toContain("LEFT JOIN ai_digest_sessions");
        expect(sessionSql).toContain("FROM ai_digest_results");
        expect(sessionSql).toContain("sessionId IS NOT NULL");
        expect(sessionParams).toEqual(["group-a", 100, 200]);
        expect(sampleSql).toContain("sessionId IS NULL");
        expect(sampleParams).toEqual(["group-a", 100, 200, 50]);
        expect(result.rawMessageStats.unassignedMessageCount).toBe(1);
        expect(result.sessions[0].sessionId).toBe("session-1");
        expect(result.unassignedMessageSamples[0].msgId).toBe("msg-2");
    });

    it("应批量查询会话时间范围并按输入顺序返回，缺失会话以 undefined 占位", async () => {
        mockCommonDBService.all.mockResolvedValue([
            { sessionId: "session-2", timeStart: 300, timeEnd: 500 },
            { sessionId: "session-1", timeStart: 100, timeEnd: 200 }
        ]);
        const service = new ImDbAccessService();

        await initService(service);
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

        await initService(service);
        const result = await service.getSessionTimeDurations([]);

        expect(result).toEqual([]);
        expect(mockCommonDBService.all).not.toHaveBeenCalled();
    });
});
