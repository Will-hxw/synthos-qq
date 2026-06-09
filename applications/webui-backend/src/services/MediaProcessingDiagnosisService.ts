/**
 * 媒体处理与合并转发诊断服务。
 */
import { injectable, inject } from "tsyringe";
import {
    ForwardMergedDiagnosisSample,
    ForwardMergedDiagnosisSummary,
    ImDbAccessService,
    MediaProcessingAudioSample,
    MediaProcessingImageSample,
    MediaProcessingMediaSummaryRow,
    MediaProcessingMediaType
} from "@root/common/services/database/ImDbAccessService";

import { TOKENS } from "../di/tokens";

const MEDIA_PROCESSING_STATUSES: Array<MediaProcessingMediaSummaryRow["status"]> = [
    "pending",
    "success",
    "failed",
    "skipped"
];

export interface MediaProcessingDiagnosisParams {
    groupId?: string;
    timeStart: number;
    timeEnd: number;
    detailLimit: number;
    mediaTypes: MediaProcessingMediaType[];
}

export interface MediaProcessingDiagnosisResult {
    generatedAt: number;
    mediaSummary: MediaProcessingMediaSummaryRow[];
    imageSamples: MediaProcessingImageSample[];
    audioSamples: MediaProcessingAudioSample[];
    forwardMergedSummary: ForwardMergedDiagnosisSummary;
    forwardMergedSamples: ForwardMergedDiagnosisSample[];
}

@injectable()
export class MediaProcessingDiagnosisService {
    public constructor(@inject(TOKENS.ImDbAccessService) private imDbAccessService: ImDbAccessService) {}

    /**
     * 按群组和时间范围获取媒体处理与合并转发只读诊断结果。
     * @param params 诊断参数
     * @returns 媒体处理和合并转发诊断结果
     */
    public async getMediaProcessingDiagnosis(
        params: MediaProcessingDiagnosisParams
    ): Promise<MediaProcessingDiagnosisResult> {
        const mediaTypes = this._normalizeMediaTypes(params.mediaTypes);
        const snapshot = await this.imDbAccessService.getMediaProcessingDiagnosisSnapshot({
            groupId: params.groupId,
            timeStart: params.timeStart,
            timeEnd: params.timeEnd,
            detailLimit: params.detailLimit,
            mediaTypes
        });

        return {
            generatedAt: Date.now(),
            mediaSummary: this._normalizeSummary(snapshot.mediaSummary, mediaTypes),
            imageSamples: mediaTypes.includes("image") ? snapshot.imageSamples : [],
            audioSamples: mediaTypes.includes("audio") ? snapshot.audioSamples : [],
            forwardMergedSummary: snapshot.forwardMergedSummary,
            forwardMergedSamples: snapshot.forwardMergedSamples
        };
    }

    private _normalizeMediaTypes(mediaTypes: MediaProcessingMediaType[]): MediaProcessingMediaType[] {
        const normalizedTypes: MediaProcessingMediaType[] = [];

        for (const mediaType of mediaTypes) {
            if ((mediaType === "image" || mediaType === "audio") && !normalizedTypes.includes(mediaType)) {
                normalizedTypes.push(mediaType);
            }
        }

        return normalizedTypes.length > 0 ? normalizedTypes : ["image", "audio"];
    }

    private _normalizeSummary(
        rows: MediaProcessingMediaSummaryRow[],
        mediaTypes: MediaProcessingMediaType[]
    ): MediaProcessingMediaSummaryRow[] {
        const rowMap = new Map<string, MediaProcessingMediaSummaryRow>();

        for (const row of rows) {
            rowMap.set(`${row.mediaType}:${row.status}`, {
                mediaType: row.mediaType,
                status: row.status,
                count: Number(row.count) || 0,
                latestUpdatedAt: row.latestUpdatedAt === null ? null : Number(row.latestUpdatedAt),
                failReasonSampleCount: Number(row.failReasonSampleCount) || 0,
                sourceUrlCount: Number(row.sourceUrlCount) || 0,
                sourcePathCount: Number(row.sourcePathCount) || 0,
                missingSourceCount: Number(row.missingSourceCount) || 0
            });
        }

        return mediaTypes.flatMap(mediaType =>
            MEDIA_PROCESSING_STATUSES.map(status => {
                const key = `${mediaType}:${status}`;

                return (
                    rowMap.get(key) || {
                        mediaType,
                        status,
                        count: 0,
                        latestUpdatedAt: null,
                        failReasonSampleCount: 0,
                        sourceUrlCount: 0,
                        sourcePathCount: 0,
                        missingSourceCount: 0
                    }
                );
            })
        );
    }
}
