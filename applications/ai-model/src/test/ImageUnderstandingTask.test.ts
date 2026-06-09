import "reflect-metadata";
import path from "path";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";

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
        mockParseImageUrl: vi.fn(),
        mockParseBase64Image: vi.fn(),
        mockUnderstandImage: vi.fn()
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

vi.mock("../services/image-understanding/OcrSpaceClient", () => ({
    OcrSpaceClient: class MockOcrSpaceClient {
        public parseImageUrl = mocks.mockParseImageUrl;
        public parseBase64Image = mocks.mockParseBase64Image;
    }
}));

vi.mock("../services/image-understanding/DashScopeVisionClient", () => ({
    DashScopeVisionClient: class MockDashScopeVisionClient {
        public understandImage = mocks.mockUnderstandImage;
    }
}));

import { TaskHandlerTypes } from "@root/common/scheduler/@types/Tasks";

import { ImageUnderstandingTaskHandler } from "../tasks/ImageUnderstanding";

describe("ImageUnderstandingTaskHandler", () => {
    const mockConfigManagerService = {
        getCurrentConfig: vi.fn()
    };
    const mockImDbAccessService = {
        getPendingImageMediaByGroupIdsAndTimeRange: vi.fn(),
        getChatMessageMediaStatusSummaryByGroupIdsAndTimeRange: vi.fn(),
        updateChatMessageMediaUnderstanding: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        mockConfigManagerService.getCurrentConfig.mockResolvedValue(createConfig());
        mockImDbAccessService.getPendingImageMediaByGroupIdsAndTimeRange.mockResolvedValue([]);
        mockImDbAccessService.getChatMessageMediaStatusSummaryByGroupIdsAndTimeRange.mockResolvedValue([]);
        mockImDbAccessService.updateChatMessageMediaUnderstanding.mockResolvedValue(undefined);
        mocks.mockParseImageUrl.mockResolvedValue({
            text: "",
            isSuccess: true,
            failReason: ""
        });
        mocks.mockParseBase64Image.mockResolvedValue({
            text: "",
            isSuccess: true,
            failReason: ""
        });
        mocks.mockUnderstandImage.mockResolvedValue({
            visionDescription: "一张通知截图。",
            imageCategory: "screenshot",
            understandingText: "图片通知报名截止时间为 6 月 10 日。",
            confidence: 0.9
        });
    });

    it("配置关闭时应快速 no-op 且不查询待处理图片", async () => {
        mockConfigManagerService.getCurrentConfig.mockResolvedValue(
            createConfig({
                enabled: false
            })
        );
        const handler = new ImageUnderstandingTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.getPendingImageMediaByGroupIdsAndTimeRange).not.toHaveBeenCalled();
        expect(mockImDbAccessService.updateChatMessageMediaUnderstanding).not.toHaveBeenCalled();
    });

    it("没有 pending 图片时应输出媒体处理诊断统计", async () => {
        mockImDbAccessService.getChatMessageMediaStatusSummaryByGroupIdsAndTimeRange.mockResolvedValue([
            {
                mediaType: "image",
                status: "skipped",
                count: 3,
                latestUpdatedAt: 2000,
                failReasonSampleCount: 3,
                sourceUrlCount: 0,
                sourcePathCount: 0,
                missingSourceCount: 3
            }
        ]);
        const handler = new ImageUnderstandingTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.getChatMessageMediaStatusSummaryByGroupIdsAndTimeRange).toHaveBeenCalledWith(
            ["group-a"],
            1000,
            2000,
            ["image"]
        );
        expect(mocks.mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("skipped=3"));
        expect(mocks.mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("missingSource=3"));
        expect(mocks.mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("failReasonSample=3"));
    });

    it("应只查询当前 pipeline 时间范围内的 pending 图片并写入理解结果", async () => {
        mockImDbAccessService.getPendingImageMediaByGroupIdsAndTimeRange.mockResolvedValue([
            createMedia({ mediaId: "msg-1:0" })
        ]);
        mocks.mockParseImageUrl.mockResolvedValue({
            text: "报名截止 6 月 10 日",
            isSuccess: true,
            failReason: ""
        });
        const handler = new ImageUnderstandingTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.getPendingImageMediaByGroupIdsAndTimeRange).toHaveBeenCalledWith(
            ["group-a"],
            1000,
            2000,
            50
        );
        expect(mocks.mockUnderstandImage).toHaveBeenCalledWith(
            "https://example.com/image.jpg",
            expect.stringContaining("报名截止 6 月 10 日"),
            expect.objectContaining({
                modelName: "qwen3.6-flash-2026-04-16"
            }),
            30000
        );
        expect(mockImDbAccessService.updateChatMessageMediaUnderstanding).toHaveBeenCalledWith("msg-1:0", {
            status: "success",
            ocrText: "报名截止 6 月 10 日",
            visionDescription: "一张通知截图。",
            imageCategory: "screenshot",
            understandingText: "图片通知报名截止时间为 6 月 10 日。",
            failReason: null,
            ocrEngine: 2,
            modelName: "qwen3.6-flash-2026-04-16"
        });
    });

    it("存在本地缓存路径时应使用 base64 图片调用 OCR 和视觉理解", async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), "synthos-image-"));
        const dbBasePath = path.join(tempRoot, "nt_qq", "nt_db");
        const relativeImagePath = path.join("nt_qq", "nt_data", "Pic", "2026-06", "Thumb", "abc.png");
        const absoluteImagePath = path.join(tempRoot, relativeImagePath);
        const config = createConfig();

        (config as any).dataProviders = {
            QQ: {
                dbBasePath
            }
        };
        mockConfigManagerService.getCurrentConfig.mockResolvedValue(config);
        mockImDbAccessService.getPendingImageMediaByGroupIdsAndTimeRange.mockResolvedValue([
            createMedia({
                mediaId: "msg-1:0",
                sourceUrl: null,
                sourcePath: relativeImagePath
            })
        ]);
        mocks.mockParseBase64Image.mockResolvedValue({
            text: "缓存图文字",
            isSuccess: true,
            failReason: ""
        });

        await mkdir(path.dirname(absoluteImagePath), { recursive: true });
        await writeFile(absoluteImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        try {
            const handler = new ImageUnderstandingTaskHandler(
                mockConfigManagerService as any,
                mockImDbAccessService as any
            );

            await handler.register();
            await runRegisteredTask();

            const ocrDataUrl = mocks.mockParseBase64Image.mock.calls[0][0] as string;
            const visionDataUrl = mocks.mockUnderstandImage.mock.calls[0][0] as string;

            expect(mocks.mockParseImageUrl).not.toHaveBeenCalled();
            expect(ocrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
            expect(visionDataUrl.startsWith("data:image/png;base64,")).toBe(true);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    it("OCR 成功但视觉理解失败时应降级为 OCR 文本并标记 success", async () => {
        mockImDbAccessService.getPendingImageMediaByGroupIdsAndTimeRange.mockResolvedValue([
            createMedia({ mediaId: "msg-1:0" })
        ]);
        mocks.mockParseImageUrl.mockResolvedValue({
            text: "图片里的通知文本",
            isSuccess: true,
            failReason: ""
        });
        mocks.mockUnderstandImage.mockRejectedValue(new Error("Vision unavailable"));
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(Buffer.from("image"), { status: 200 })));
        const handler = new ImageUnderstandingTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.updateChatMessageMediaUnderstanding).toHaveBeenCalledWith("msg-1:0", {
            status: "success",
            ocrText: "图片里的通知文本",
            understandingText: "图片文字：图片里的通知文本",
            failReason: expect.stringContaining("Vision unavailable"),
            ocrEngine: 2,
            modelName: null
        });
    });

    it("图片缺少 URL 和本地缓存路径时应标记 skipped", async () => {
        mockImDbAccessService.getPendingImageMediaByGroupIdsAndTimeRange.mockResolvedValue([
            createMedia({
                mediaId: "msg-1:0",
                sourceUrl: null
            })
        ]);
        const handler = new ImageUnderstandingTaskHandler(
            mockConfigManagerService as any,
            mockImDbAccessService as any
        );

        await handler.register();
        await runRegisteredTask();

        expect(mockImDbAccessService.updateChatMessageMediaUnderstanding).toHaveBeenCalledWith("msg-1:0", {
            status: "skipped",
            failReason: "图片缺少可访问 URL 或本地缓存路径"
        });
    });
});

async function runRegisteredTask(): Promise<void> {
    const taskName = mocks.mockAgendaDefine.mock.calls.at(-1)?.[0];
    const taskHandler = mocks.mockAgendaDefine.mock.calls.at(-1)?.[1] as (job: any) => Promise<void>;

    expect(taskName).toBe(TaskHandlerTypes.ImageUnderstanding);
    await taskHandler({
        attrs: {
            name: TaskHandlerTypes.ImageUnderstanding,
            data: {
                groupIds: ["group-a"],
                startTimeStamp: 1000,
                endTimeStamp: 2000
            }
        },
        touch: vi.fn().mockResolvedValue(undefined)
    });
}

function createConfig(overrides: Partial<ReturnType<typeof createImageUnderstandingConfig>> = {}) {
    return {
        ai: {
            imageUnderstanding: {
                ...createImageUnderstandingConfig(),
                ...overrides
            }
        }
    } as any;
}

function createImageUnderstandingConfig() {
    return {
        enabled: true,
        ocr: {
            provider: "ocrspace",
            apiKey: "test-ocr-key",
            endpoint: "https://api.ocr.space/parse/image",
            language: "chs",
            ocrEngine: 2,
            scale: true,
            detectOrientation: true,
            isOverlayRequired: false,
            maxImageBytes: 1048576
        },
        vision: {
            provider: "dashscope-openai-compatible",
            apiKey: "test-vision-key",
            baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            modelName: "qwen3.6-flash-2026-04-16",
            temperature: 0,
            maxTokens: 2048
        },
        maxImagesPerRun: 50,
        retryCount: 2,
        requestTimeoutMs: 30000,
        processOnlyNewMessages: true
    };
}

function createMedia(overrides: Record<string, unknown> = {}) {
    return {
        mediaId: "msg-1:0",
        msgId: "msg-1",
        groupId: "group-a",
        timestamp: 1000,
        elementIndex: 0,
        mediaType: "image",
        sourceProvider: "QQ",
        sourceUrl: "https://example.com/image.jpg",
        sourcePath: null,
        fileName: null,
        fileSize: null,
        duration: null,
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
        messageContent: "[图片，含图片链接]",
        ...overrides
    };
}
