import type { ApiResponse } from "@/types/api";

import API_BASE_URL from "./constants/baseUrl";

import { MOCK_ENABLED } from "@/config/mock";
import fetchWrapper from "@/util/fetchWrapper";

export type MediaDiagnosisMediaType = "image" | "audio";
export type MediaDiagnosisStatus = "pending" | "success" | "failed" | "skipped";

export interface MediaDiagnosisRequest {
    groupId?: string;
    timeStart: number;
    timeEnd: number;
    detailLimit?: number;
    mediaTypes?: MediaDiagnosisMediaType[];
}

export interface MediaSummaryItem {
    mediaType: MediaDiagnosisMediaType;
    status: MediaDiagnosisStatus;
    count: number;
    latestUpdatedAt: number | null;
    failReasonSampleCount: number;
    sourceUrlCount: number;
    sourcePathCount: number;
    missingSourceCount: number;
}

export interface ImageDiagnosisSample {
    mediaId: string;
    msgId: string;
    groupId: string;
    timestamp: number;
    status: MediaDiagnosisStatus;
    retryCount: number;
    failReason: string | null;
    hasSourceUrl: boolean;
    hasSourcePath: boolean;
    sourceUrlKind: "http" | "qq-download" | "other" | "none";
    ocrLen: number;
    visionLen: number;
    understandingLen: number;
    modelName: string | null;
    messageContent: string | null;
    preProcessedContent: string | null;
}

export interface AudioDiagnosisSample {
    mediaId: string;
    msgId: string;
    groupId: string;
    timestamp: number;
    status: MediaDiagnosisStatus;
    retryCount: number;
    failReason: string | null;
    transcriptLen: number;
    modelName: string | null;
    messageContent: string | null;
    preProcessedContent: string | null;
}

export interface ForwardMergedSummary {
    expandedMessageCount: number;
    parseFailurePlaceholderCount: number;
    emptyContentPlaceholderCount: number;
    nestedTruncatedCount: number;
}

export interface ForwardMergedSample {
    msgId: string;
    groupId: string;
    timestamp: number;
    messageContent: string | null;
    preProcessedContent: string | null;
    contentLength: number;
}

export interface MediaDiagnosisResult {
    generatedAt: number;
    mediaSummary: MediaSummaryItem[];
    imageSamples: ImageDiagnosisSample[];
    audioSamples: AudioDiagnosisSample[];
    forwardMergedSummary: ForwardMergedSummary;
    forwardMergedSamples: ForwardMergedSample[];
}

export const getMediaProcessingDiagnosis = async (params: MediaDiagnosisRequest): Promise<ApiResponse<MediaDiagnosisResult>> => {
    if (MOCK_ENABLED) {
        const now = Date.now();

        return {
            success: true,
            data: {
                generatedAt: now,
                mediaSummary: [
                    createSummary("image", "pending", 2, now - 60_000, 0, 1, 1, 0),
                    createSummary("image", "success", 3, now - 10_000, 0, 2, 1, 0),
                    createSummary("image", "failed", 1, now - 20_000, 1, 0, 1, 0),
                    createSummary("image", "skipped", 4, now - 30_000, 4, 0, 0, 4),
                    createSummary("audio", "pending", 0, null, 0, 0, 0, 0),
                    createSummary("audio", "success", 1, now - 15_000, 0, 0, 1, 0),
                    createSummary("audio", "failed", 1, now - 25_000, 1, 0, 0, 1),
                    createSummary("audio", "skipped", 0, null, 0, 0, 0, 0)
                ],
                imageSamples: [
                    {
                        mediaId: "mock-image-1",
                        msgId: "mock-msg-image",
                        groupId: params.groupId || "mock-group",
                        timestamp: params.timeStart,
                        status: "success",
                        retryCount: 0,
                        failReason: null,
                        hasSourceUrl: false,
                        hasSourcePath: true,
                        sourceUrlKind: "none",
                        ocrLen: 12,
                        visionLen: 28,
                        understandingLen: 40,
                        modelName: "mock-vision",
                        messageContent: "图片消息正文样本",
                        preProcessedContent: "图片预处理正文样本"
                    }
                ],
                audioSamples: [
                    {
                        mediaId: "mock-audio-1",
                        msgId: "mock-msg-audio",
                        groupId: params.groupId || "mock-group",
                        timestamp: params.timeStart + 10_000,
                        status: "failed",
                        retryCount: 2,
                        failReason: "mock ASR failed",
                        transcriptLen: 0,
                        modelName: "mock-asr",
                        messageContent: "语音消息正文样本",
                        preProcessedContent: "语音预处理正文样本"
                    }
                ],
                forwardMergedSummary: {
                    expandedMessageCount: 2,
                    parseFailurePlaceholderCount: 1,
                    emptyContentPlaceholderCount: 0,
                    nestedTruncatedCount: 1
                },
                forwardMergedSamples: [
                    {
                        msgId: "mock-forward-1",
                        groupId: params.groupId || "mock-group",
                        timestamp: params.timeStart + 20_000,
                        messageContent: '[合并转发，共 2 条]\n("张三"): 第一条\n("李四"): 第二条',
                        preProcessedContent: "合并转发预处理正文样本",
                        contentLength: 36
                    }
                ]
            },
            message: ""
        };
    }

    const response = await fetchWrapper(`${API_BASE_URL}/api/setup-status/media-processing-diagnosis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params)
    });

    return response.json();
};

const createSummary = (
    mediaType: MediaDiagnosisMediaType,
    status: MediaDiagnosisStatus,
    count: number,
    latestUpdatedAt: number | null,
    failReasonSampleCount: number,
    sourceUrlCount: number,
    sourcePathCount: number,
    missingSourceCount: number
): MediaSummaryItem => ({
    mediaType,
    status,
    count,
    latestUpdatedAt,
    failReasonSampleCount,
    sourceUrlCount,
    sourcePathCount,
    missingSourceCount
});
