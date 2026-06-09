import "reflect-metadata";

import { describe, expect, it, vi, afterEach } from "vitest";

import { MediaProcessingDiagnosisService } from "../services/MediaProcessingDiagnosisService";

describe("MediaProcessingDiagnosisService", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("应返回媒体状态聚合、最近样本和合并转发诊断结果", async () => {
        const now = 1_000_000;
        const snapshot = createSnapshot();
        const mockImDbAccessService = {
            getMediaProcessingDiagnosisSnapshot: vi.fn().mockResolvedValue(snapshot)
        };
        const service = new MediaProcessingDiagnosisService(mockImDbAccessService as any);

        vi.spyOn(Date, "now").mockReturnValue(now);

        const result = await service.getMediaProcessingDiagnosis({
            groupId: "group-a",
            timeStart: 100,
            timeEnd: 200,
            detailLimit: 10,
            mediaTypes: ["image", "audio"]
        });

        expect(mockImDbAccessService.getMediaProcessingDiagnosisSnapshot).toHaveBeenCalledWith({
            groupId: "group-a",
            timeStart: 100,
            timeEnd: 200,
            detailLimit: 10,
            mediaTypes: ["image", "audio"]
        });
        expect(result.generatedAt).toBe(now);
        expect(result.mediaSummary).toEqual([
            {
                mediaType: "image",
                status: "pending",
                count: 2,
                latestUpdatedAt: 180,
                failReasonSampleCount: 0,
                sourceUrlCount: 1,
                sourcePathCount: 1,
                missingSourceCount: 0
            },
            {
                mediaType: "image",
                status: "success",
                count: 1,
                latestUpdatedAt: 190,
                failReasonSampleCount: 0,
                sourceUrlCount: 1,
                sourcePathCount: 0,
                missingSourceCount: 0
            },
            {
                mediaType: "image",
                status: "failed",
                count: 0,
                latestUpdatedAt: null,
                failReasonSampleCount: 0,
                sourceUrlCount: 0,
                sourcePathCount: 0,
                missingSourceCount: 0
            },
            {
                mediaType: "image",
                status: "skipped",
                count: 0,
                latestUpdatedAt: null,
                failReasonSampleCount: 0,
                sourceUrlCount: 0,
                sourcePathCount: 0,
                missingSourceCount: 0
            },
            {
                mediaType: "audio",
                status: "pending",
                count: 0,
                latestUpdatedAt: null,
                failReasonSampleCount: 0,
                sourceUrlCount: 0,
                sourcePathCount: 0,
                missingSourceCount: 0
            },
            {
                mediaType: "audio",
                status: "success",
                count: 0,
                latestUpdatedAt: null,
                failReasonSampleCount: 0,
                sourceUrlCount: 0,
                sourcePathCount: 0,
                missingSourceCount: 0
            },
            {
                mediaType: "audio",
                status: "failed",
                count: 3,
                latestUpdatedAt: 195,
                failReasonSampleCount: 2,
                sourceUrlCount: 0,
                sourcePathCount: 2,
                missingSourceCount: 1
            },
            {
                mediaType: "audio",
                status: "skipped",
                count: 0,
                latestUpdatedAt: null,
                failReasonSampleCount: 0,
                sourceUrlCount: 0,
                sourcePathCount: 0,
                missingSourceCount: 0
            }
        ]);
        expect(result.imageSamples).toHaveLength(1);
        expect(result.audioSamples).toHaveLength(1);
        expect(result.forwardMergedSummary).toEqual(snapshot.forwardMergedSummary);
        expect(result.forwardMergedSamples[0].msgId).toBe("forward-1");
    });

    it("只请求图片时不返回语音样本", async () => {
        const mockImDbAccessService = {
            getMediaProcessingDiagnosisSnapshot: vi.fn().mockResolvedValue(createSnapshot())
        };
        const service = new MediaProcessingDiagnosisService(mockImDbAccessService as any);

        const result = await service.getMediaProcessingDiagnosis({
            timeStart: 100,
            timeEnd: 200,
            detailLimit: 5,
            mediaTypes: ["image"]
        });

        expect(result.imageSamples).toHaveLength(1);
        expect(result.audioSamples).toEqual([]);
        expect(result.mediaSummary.map(item => item.mediaType)).toEqual(["image", "image", "image", "image"]);
    });
});

function createSnapshot() {
    return {
        mediaSummary: [
            {
                mediaType: "image",
                status: "pending",
                count: 2,
                latestUpdatedAt: 180,
                failReasonSampleCount: 0,
                sourceUrlCount: 1,
                sourcePathCount: 1,
                missingSourceCount: 0
            },
            {
                mediaType: "image",
                status: "success",
                count: 1,
                latestUpdatedAt: 190,
                failReasonSampleCount: 0,
                sourceUrlCount: 1,
                sourcePathCount: 0,
                missingSourceCount: 0
            },
            {
                mediaType: "audio",
                status: "failed",
                count: 3,
                latestUpdatedAt: 195,
                failReasonSampleCount: 2,
                sourceUrlCount: 0,
                sourcePathCount: 2,
                missingSourceCount: 1
            }
        ],
        imageSamples: [
            {
                mediaId: "image-1",
                msgId: "msg-image",
                groupId: "group-a",
                timestamp: 120,
                status: "success",
                retryCount: 0,
                failReason: null,
                ocrLen: 2,
                visionLen: 4,
                understandingLen: 6,
                modelName: "vision-model",
                messageContent: "图片消息",
                preProcessedContent: "图片预处理"
            }
        ],
        audioSamples: [
            {
                mediaId: "audio-1",
                msgId: "msg-audio",
                groupId: "group-a",
                timestamp: 130,
                status: "failed",
                retryCount: 2,
                failReason: "ASR 失败",
                transcriptLen: 0,
                modelName: "asr-model",
                messageContent: "语音消息",
                preProcessedContent: "语音预处理"
            }
        ],
        forwardMergedSummary: {
            expandedMessageCount: 4,
            parseFailurePlaceholderCount: 1,
            emptyContentPlaceholderCount: 1,
            nestedTruncatedCount: 2
        },
        forwardMergedSamples: [
            {
                msgId: "forward-1",
                groupId: "group-a",
                timestamp: 140,
                messageContent: "[合并转发，共 2 条]",
                preProcessedContent: "合并转发预处理",
                contentLength: 12
            }
        ]
    };
}
