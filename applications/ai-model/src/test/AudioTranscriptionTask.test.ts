import "reflect-metadata";
import path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const save = vi.fn().mockResolvedValue(undefined);
    const unique = vi.fn(() => ({ save }));

    return {
        mockAgendaCreate: vi.fn(() => ({ unique })),
        mockAgendaDefine: vi.fn(),
        mockAgendaSave: save,
        mockAgendaUnique: unique,
        mockLogger: {
            debug: vi.fn(),
            info: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn()
        },
        mockReadAsWavDataUrl: vi.fn(),
        mockTranscribe: vi.fn()
    };
});

vi.mock("@root/common/scheduler/agenda", () => ({
    agendaInstance: {
        create: mocks.mockAgendaCreate,
        define: mocks.mockAgendaDefine,
        ready: Promise.resolve()
    }
}));

vi.mock("@root/common/util/Logger", () => ({
    default: {
        withTag: () => mocks.mockLogger
    }
}));

vi.mock("../services/audio-transcription/AudioDataUrlService", () => ({
    AudioDataUrlService: class MockAudioDataUrlService {
        public readAsWavDataUrl = mocks.mockReadAsWavDataUrl;
    }
}));

vi.mock("../services/audio-transcription/MimoAsrClient", () => ({
    MimoAsrClient: class MockMimoAsrClient {
        public transcribe = mocks.mockTranscribe;
    }
}));

import { TaskHandlerTypes } from "@root/common/scheduler/@types/Tasks";

import { AudioTranscriptionTaskHandler } from "../tasks/AudioTranscription";

describe("AudioTranscriptionTaskHandler", () => {
    const mockConfigManagerService = {
        getCurrentConfig: vi.fn()
    };
    const mockImDbAccessService = {
        getPendingAudioMediaByGroupIdsAndTimeRange: vi.fn(),
        getChatMessageMediaStatusSummaryByGroupIdsAndTimeRange: vi.fn(),
        updateChatMessageMediaTranscription: vi.fn(),
        updateAudioTranscribedMessage: vi.fn(),
        getRawChatMessageByMsgId: vi.fn(),
        getChatMessageMediaByMsgIds: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfigManagerService.getCurrentConfig.mockResolvedValue(createConfig());
        mockImDbAccessService.getPendingAudioMediaByGroupIdsAndTimeRange.mockResolvedValue([]);
        mockImDbAccessService.getChatMessageMediaStatusSummaryByGroupIdsAndTimeRange.mockResolvedValue([]);
        mockImDbAccessService.updateChatMessageMediaTranscription.mockResolvedValue(undefined);
        mockImDbAccessService.updateAudioTranscribedMessage.mockResolvedValue(undefined);
        mockImDbAccessService.getRawChatMessageByMsgId.mockResolvedValue(createRawMessage({ sessionId: null }));
        mockImDbAccessService.getChatMessageMediaByMsgIds.mockResolvedValue(new Map());
        mocks.mockReadAsWavDataUrl.mockResolvedValue({
            dataUrl: "data:audio/wav;base64,AAAA",
            byteLength: 32,
            durationMs: 1000
        });
        mocks.mockTranscribe.mockResolvedValue("你好");
    });

    it("配置关闭时应快速 no-op 且不查询待处理语音", async () => {
        mockConfigManagerService.getCurrentConfig.mockResolvedValue(
            createConfig({
                enabled: false
            })
        );
        const handler = new AudioTranscriptionTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.getPendingAudioMediaByGroupIdsAndTimeRange).not.toHaveBeenCalled();
        expect(mockImDbAccessService.updateAudioTranscribedMessage).not.toHaveBeenCalled();
        expect(mockImDbAccessService.getChatMessageMediaStatusSummaryByGroupIdsAndTimeRange).toHaveBeenCalledWith(
            ["group-a"],
            1000,
            2000,
            ["audio"]
        );
    });

    it("应读取当前 pipeline 范围内的 pending 语音并写回转写文本", async () => {
        mockImDbAccessService.getPendingAudioMediaByGroupIdsAndTimeRange.mockResolvedValue([createMedia()]);
        const handler = new AudioTranscriptionTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.getPendingAudioMediaByGroupIdsAndTimeRange).toHaveBeenCalledWith(
            ["group-a"],
            1000,
            2000,
            2
        );
        expect(mocks.mockReadAsWavDataUrl).toHaveBeenCalledWith(
            path.resolve(getQQMediaRootPath(), "nt_qq", "Audio", "voice.amr"),
            1048576
        );
        expect(mocks.mockTranscribe).toHaveBeenCalledWith(
            "data:audio/wav;base64,AAAA",
            expect.objectContaining({
                model: "mimo-v2.5-asr",
                language: "zh"
            })
        );
        expect(mockImDbAccessService.updateAudioTranscribedMessage).toHaveBeenCalledWith(
            "msg-1:0",
            "msg-1",
            "[语音转文字：你好]",
            null,
            {
                status: "success",
                transcript: "你好",
                failReason: null,
                modelName: "mimo-v2.5-asr"
            }
        );
    });

    it("消息已有 sessionId 时应重算 preProcessedContent", async () => {
        mockImDbAccessService.getPendingAudioMediaByGroupIdsAndTimeRange.mockResolvedValue([createMedia()]);
        mockImDbAccessService.getRawChatMessageByMsgId.mockResolvedValue(
            createRawMessage({
                sessionId: "session-1"
            })
        );
        const handler = new AudioTranscriptionTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.getChatMessageMediaByMsgIds).toHaveBeenCalledWith(["msg-1"]);
        expect(mockImDbAccessService.updateAudioTranscribedMessage).toHaveBeenCalledWith(
            "msg-1:0",
            "msg-1",
            "[语音转文字：你好]",
            '("发送者"): [语音转文字：你好]',
            expect.objectContaining({
                status: "success",
                transcript: "你好"
            })
        );
    });

    it("语音缺少源文件路径时应标记 skipped", async () => {
        mockImDbAccessService.getPendingAudioMediaByGroupIdsAndTimeRange.mockResolvedValue([
            createMedia({
                sourcePath: null
            })
        ]);
        const handler = new AudioTranscriptionTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mocks.mockReadAsWavDataUrl).not.toHaveBeenCalled();
        expect(mockImDbAccessService.updateChatMessageMediaTranscription).toHaveBeenCalledWith("msg-1:0", {
            status: "skipped",
            failReason: "语音缺少可定位的源文件路径"
        });
    });

    it("转写失败且未达重试上限时应递增 retryCount 并保持 pending", async () => {
        mockImDbAccessService.getPendingAudioMediaByGroupIdsAndTimeRange.mockResolvedValue([
            createMedia({
                retryCount: 1
            })
        ]);
        mocks.mockTranscribe.mockRejectedValue(new Error("ASR 暂时失败"));
        const handler = new AudioTranscriptionTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.updateChatMessageMediaTranscription).toHaveBeenCalledWith("msg-1:0", {
            status: "pending",
            failReason: "ASR 暂时失败",
            incrementRetryCount: true
        });
    });
});

async function runRegisteredTask(): Promise<void> {
    const taskName = mocks.mockAgendaDefine.mock.calls.at(-1)?.[0];
    const taskHandler = mocks.mockAgendaDefine.mock.calls.at(-1)?.[1] as (job: any) => Promise<void>;

    expect(taskName).toBe(TaskHandlerTypes.AudioTranscription);
    await taskHandler({
        attrs: {
            name: TaskHandlerTypes.AudioTranscription,
            data: {
                groupIds: ["group-a"],
                startTimeStamp: 1000,
                endTimeStamp: 2000
            }
        },
        touch: vi.fn().mockResolvedValue(undefined)
    });
}

function createConfig(overrides: Record<string, unknown> = {}) {
    return {
        dataProviders: {
            QQ: {
                dbBasePath: getQQDbBasePath()
            }
        },
        ai: {
            audioTranscription: {
                enabled: true,
                baseURL: "https://token-plan-sgp.xiaomimimo.com/v1",
                apiKey: "test-key",
                model: "mimo-v2.5-asr",
                language: "zh",
                batchSize: 2,
                maxRetryCount: 2,
                requestTimeoutMs: 60000,
                maxAudioBase64Bytes: 1048576,
                ...overrides
            }
        }
    } as any;
}

function getQQDbBasePath(): string {
    return path.join("D:\\Tencent Files", "123456", "nt_qq", "nt_db");
}

function getQQMediaRootPath(): string {
    return path.dirname(path.dirname(path.dirname(path.resolve(getQQDbBasePath()))));
}

function createMedia(overrides: Record<string, unknown> = {}) {
    return {
        mediaId: "msg-1:0",
        msgId: "msg-1",
        groupId: "group-a",
        timestamp: 900,
        elementIndex: 0,
        mediaType: "audio",
        sourceProvider: "QQ",
        sourceUrl: null,
        sourcePath: path.join("nt_qq", "Audio", "voice.amr"),
        fileName: "voice.amr",
        fileSize: 12345,
        duration: 5,
        width: null,
        height: null,
        picType: null,
        originImageMd5: null,
        qqImageText: null,
        ocrText: null,
        visionDescription: null,
        imageCategory: null,
        understandingText: null,
        transcript: null,
        status: "pending",
        retryCount: 0,
        failReason: null,
        ocrEngine: null,
        modelName: null,
        createdAt: 1000,
        updatedAt: 1000,
        messageContent: "[语音，时长：5秒]",
        ...overrides
    };
}

function createRawMessage(overrides: Record<string, unknown> = {}) {
    return {
        msgId: "msg-1",
        messageContent: "[语音，时长：5秒]",
        groupId: "group-a",
        timestamp: 900,
        senderId: "sender-a",
        senderGroupNickname: "发送者",
        senderNickname: "发送者",
        quotedMsgId: null,
        quotedMsgContent: null,
        ...overrides
    };
}
