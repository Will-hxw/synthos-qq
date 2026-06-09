import "reflect-metadata";
import path from "path";
import { promises as fs } from "fs";

import { injectable, inject } from "tsyringe";
import { agendaInstance } from "@root/common/scheduler/agenda";
import { TaskHandlerTypes, TaskParameters } from "@root/common/scheduler/@types/Tasks";
import Logger from "@root/common/util/Logger";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";
import {
    ImDbAccessService,
    MediaProcessingMediaSummaryRow,
    PendingChatMessageMedia
} from "@root/common/services/database/ImDbAccessService";
import { COMMON_TOKENS } from "@root/common/di/tokens";
import { GlobalConfig } from "@root/common/services/config/schemas/GlobalConfig";

import { ImageUnderstandingPromptStore } from "../context/prompts/ImageUnderstandingPromptStore";
import { OcrSpaceClient } from "../services/image-understanding/OcrSpaceClient";
import {
    DashScopeVisionClient,
    VisionUnderstandingResult
} from "../services/image-understanding/DashScopeVisionClient";

interface ImageUnderstandingStats {
    processed: number;
    success: number;
    failed: number;
    skipped: number;
    ocrFailed: number;
    visionFailed: number;
    totalDurationMs: number;
}

interface ImageDataUrlResult {
    dataUrl: string;
    byteLength: number;
}

type ImageUnderstandingAuditStatus = "pending" | "success" | "failed" | "skipped";

/**
 * 图片理解任务处理器
 * 负责将图片 OCR 和视觉理解结果持久化为摘要可消费的文本。
 */
@injectable()
export class ImageUnderstandingTaskHandler {
    private readonly LOGGER = Logger.withTag("🖼️ ImageUnderstandingTask");
    private readonly ocrSpaceClient = new OcrSpaceClient();
    private readonly dashScopeVisionClient = new DashScopeVisionClient();

    public constructor(
        @inject(COMMON_TOKENS.ConfigManagerService) private configManagerService: ConfigManagerService,
        @inject(COMMON_TOKENS.ImDbAccessService) private imDbAccessService: ImDbAccessService
    ) {}

    /**
     * 注册任务到 Agenda 调度器
     */
    public async register(): Promise<void> {
        await agendaInstance
            .create(TaskHandlerTypes.ImageUnderstanding)
            .unique({ name: TaskHandlerTypes.ImageUnderstanding }, { insertOnly: true })
            .save();

        agendaInstance.define<TaskParameters<TaskHandlerTypes.ImageUnderstanding>>(
            TaskHandlerTypes.ImageUnderstanding,
            async job => {
                this.LOGGER.info(`😋开始处理任务: ${job.attrs.name}`);
                const attrs = job.attrs.data;
                const config = await this.configManagerService.getCurrentConfig();
                const imageUnderstandingConfig = config.ai.imageUnderstanding;

                if (!imageUnderstandingConfig.enabled) {
                    this.LOGGER.info("图片理解未启用，跳过当前任务");

                    return;
                }

                if (!imageUnderstandingConfig.ocr.apiKey || !imageUnderstandingConfig.vision.apiKey) {
                    this.LOGGER.warning("图片理解配置缺少 OCR 或 Vision API Key，跳过当前任务");

                    return;
                }

                const queryStartTime = imageUnderstandingConfig.processOnlyNewMessages ? attrs.startTimeStamp : 0;
                const mediaItems = await this.imDbAccessService.getPendingImageMediaByGroupIdsAndTimeRange(
                    attrs.groupIds,
                    queryStartTime,
                    attrs.endTimeStamp,
                    imageUnderstandingConfig.maxImagesPerRun
                );

                if (mediaItems.length === 0) {
                    await this._logImageMediaStatusSummary(
                        attrs.groupIds,
                        queryStartTime,
                        attrs.endTimeStamp,
                        "no-pending"
                    );
                    this.LOGGER.info("没有需要图片理解处理的新图片");

                    return;
                }

                this.LOGGER.info(`本轮准备处理 ${mediaItems.length} 张图片`);
                const stats = this._createStats();

                for (const media of mediaItems) {
                    await job.touch();
                    await this._processMedia(media, config, stats);
                }

                const averageDurationMs =
                    stats.processed === 0 ? 0 : Math.round(stats.totalDurationMs / stats.processed);

                this.LOGGER.success(
                    `图片理解完成：处理=${stats.processed}，成功=${stats.success}，失败=${stats.failed}，跳过=${stats.skipped}，OCR失败=${stats.ocrFailed}，Vision失败=${stats.visionFailed}，平均耗时=${averageDurationMs}ms`
                );
                await this._logImageMediaStatusSummary(
                    attrs.groupIds,
                    queryStartTime,
                    attrs.endTimeStamp,
                    "completed"
                );
            },
            {
                concurrency: 1,
                priority: "high"
            }
        );
    }

    private _createStats(): ImageUnderstandingStats {
        return {
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
            ocrFailed: 0,
            visionFailed: 0,
            totalDurationMs: 0
        };
    }

    private async _logImageMediaStatusSummary(
        groupIds: string[],
        timeStart: number,
        timeEnd: number,
        stage: "no-pending" | "completed"
    ): Promise<void> {
        try {
            const rows = await this.imDbAccessService.getChatMessageMediaStatusSummaryByGroupIdsAndTimeRange(
                groupIds,
                timeStart,
                timeEnd,
                ["image"]
            );
            const message = this._formatImageMediaStatusSummary(rows, stage);

            this.LOGGER.info(message);
        } catch (error) {
            this.LOGGER.warning(`图片理解媒体诊断统计失败：${this._formatUnknownError(error)}`);
        }
    }

    private _formatImageMediaStatusSummary(
        rows: MediaProcessingMediaSummaryRow[],
        stage: "no-pending" | "completed"
    ): string {
        const rowMap = new Map<string, MediaProcessingMediaSummaryRow>();

        for (const row of rows) {
            if (row.mediaType === "image") {
                rowMap.set(row.status, row);
            }
        }

        const parts = (["pending", "success", "failed", "skipped"] as const).map(status => {
            const row = rowMap.get(status);

            return (
                `${status}=${Number(row?.count || 0)}` +
                `,sourceUrl=${Number(row?.sourceUrlCount || 0)}` +
                `,sourcePath=${Number(row?.sourcePathCount || 0)}` +
                `,missingSource=${Number(row?.missingSourceCount || 0)}` +
                `,failReasonSample=${Number(row?.failReasonSampleCount || 0)}`
            );
        });

        return `图片理解媒体诊断(${stage})：${parts.join("；")}`;
    }

    private async _processMedia(
        media: PendingChatMessageMedia,
        config: GlobalConfig,
        stats: ImageUnderstandingStats
    ): Promise<void> {
        const startedAt = Date.now();
        const imageUnderstandingConfig = config.ai.imageUnderstanding;

        stats.processed++;

        try {
            if (media.retryCount > imageUnderstandingConfig.retryCount) {
                const failReason = "图片理解超过最大重试次数";

                await this.imDbAccessService.updateChatMessageMediaUnderstanding(media.mediaId, {
                    status: "failed",
                    failReason
                });
                stats.failed++;
                this._logImageUnderstandingAudit(media, "failed", "", "", "", null, failReason, "warning");

                return;
            }

            if (!media.sourceUrl && !media.sourcePath) {
                const failReason = "图片缺少可访问 URL 或本地缓存路径";

                await this.imDbAccessService.updateChatMessageMediaUnderstanding(media.mediaId, {
                    status: "skipped",
                    failReason
                });
                stats.skipped++;
                this._logImageUnderstandingAudit(media, "skipped", "", "", "", null, failReason, "debug");

                return;
            }

            const ocrTextResult = await this._runOcr(media, config);
            const ocrText = this._normalizeInlineText(ocrTextResult.text || media.qqImageText || "");
            let imageDataUrl: ImageDataUrlResult | null = ocrTextResult.imageDataUrl;
            let visionResult: VisionUnderstandingResult | null = null;
            let visionFailReason = "";

            if (ocrTextResult.failReason) {
                stats.ocrFailed++;
            }

            if (media.sourceUrl && !media.sourcePath && this._isHttpUrl(media.sourceUrl)) {
                try {
                    const prompt = (
                        await ImageUnderstandingPromptStore.getImageUnderstandingPrompt(
                            ocrText,
                            media.messageContent || ""
                        )
                    ).serializeToString();

                    visionResult = await this.dashScopeVisionClient.understandImage(
                        media.sourceUrl,
                        prompt,
                        imageUnderstandingConfig.vision,
                        imageUnderstandingConfig.requestTimeoutMs
                    );
                } catch (error) {
                    visionFailReason = this._formatUnknownError(error);
                }
            }

            if (!visionResult) {
                try {
                    imageDataUrl =
                        imageDataUrl ||
                        (await this._loadImageAsDataUrl(
                            media,
                            config,
                            imageUnderstandingConfig.ocr.maxImageBytes
                        ));
                    const prompt = (
                        await ImageUnderstandingPromptStore.getImageUnderstandingPrompt(
                            ocrText,
                            media.messageContent || ""
                        )
                    ).serializeToString();

                    visionResult = await this.dashScopeVisionClient.understandImage(
                        imageDataUrl.dataUrl,
                        prompt,
                        imageUnderstandingConfig.vision,
                        imageUnderstandingConfig.requestTimeoutMs
                    );
                    visionFailReason = "";
                } catch (fallbackError) {
                    visionFailReason = this._formatUnknownError(fallbackError);
                    stats.visionFailed++;
                }
            }

            if (visionResult) {
                const understandingText =
                    this._normalizeInlineText(visionResult.understandingText) ||
                    this._buildOcrOnlyUnderstandingText(ocrText);

                await this.imDbAccessService.updateChatMessageMediaUnderstanding(media.mediaId, {
                    status: "success",
                    ocrText,
                    visionDescription: visionResult.visionDescription,
                    imageCategory: visionResult.imageCategory,
                    understandingText,
                    failReason: ocrTextResult.failReason || null,
                    ocrEngine: imageUnderstandingConfig.ocr.ocrEngine,
                    modelName: imageUnderstandingConfig.vision.modelName
                });
                stats.success++;
                this._logImageUnderstandingAudit(
                    media,
                    "success",
                    ocrText,
                    visionResult.visionDescription,
                    understandingText,
                    imageUnderstandingConfig.vision.modelName,
                    ocrTextResult.failReason || null,
                    "success"
                );

                return;
            }

            if (ocrText) {
                const understandingText = this._buildOcrOnlyUnderstandingText(ocrText);
                const failReason = this._joinReasons([ocrTextResult.failReason, visionFailReason]);

                await this.imDbAccessService.updateChatMessageMediaUnderstanding(media.mediaId, {
                    status: "success",
                    ocrText,
                    understandingText,
                    failReason,
                    ocrEngine: imageUnderstandingConfig.ocr.ocrEngine,
                    modelName: null
                });
                stats.success++;
                this._logImageUnderstandingAudit(
                    media,
                    "success",
                    ocrText,
                    "",
                    understandingText,
                    null,
                    failReason,
                    "success"
                );

                return;
            }

            await this._markFailedOrRetry(
                media,
                this._joinReasons([ocrTextResult.failReason, visionFailReason]),
                stats
            );
        } catch (error) {
            await this._markFailedOrRetry(media, this._formatUnknownError(error), stats);
        } finally {
            stats.totalDurationMs += Date.now() - startedAt;
        }
    }

    private async _runOcr(
        media: PendingChatMessageMedia,
        config: GlobalConfig
    ): Promise<{ text: string; failReason: string; imageDataUrl: ImageDataUrlResult | null }> {
        const imageUnderstandingConfig = config.ai.imageUnderstanding;
        let urlFailReason = "";

        if (media.sourceUrl && !media.sourcePath && this._isHttpUrl(media.sourceUrl)) {
            const urlResult = await this.ocrSpaceClient.parseImageUrl(
                media.sourceUrl,
                imageUnderstandingConfig.ocr,
                imageUnderstandingConfig.requestTimeoutMs
            );

            if (urlResult.text || urlResult.isSuccess) {
                return {
                    text: urlResult.text,
                    failReason: urlResult.failReason,
                    imageDataUrl: null
                };
            }

            urlFailReason = urlResult.failReason;
        }

        try {
            const imageDataUrl = await this._loadImageAsDataUrl(
                media,
                config,
                imageUnderstandingConfig.ocr.maxImageBytes
            );
            const base64Result = await this.ocrSpaceClient.parseBase64Image(
                imageDataUrl.dataUrl,
                imageUnderstandingConfig.ocr,
                imageUnderstandingConfig.requestTimeoutMs
            );

            return {
                text: base64Result.text,
                failReason: base64Result.failReason || urlFailReason,
                imageDataUrl
            };
        } catch (error) {
            return {
                text: "",
                failReason: this._joinReasons([urlFailReason, this._formatUnknownError(error)]),
                imageDataUrl: null
            };
        }
    }

    private _logImageUnderstandingAudit(
        media: PendingChatMessageMedia,
        status: ImageUnderstandingAuditStatus,
        ocrText: string | null,
        visionDescription: string | null,
        understandingText: string | null,
        modelName: string | null,
        failReason: string | null,
        level: "success" | "warning" | "debug"
    ): void {
        const message =
            `图片理解审计：mediaId=${media.mediaId}` +
            `，msgId=${media.msgId}` +
            `，status=${status}` +
            `，ocrLen=${this._getTextLength(ocrText)}` +
            `，visionLen=${this._getTextLength(visionDescription)}` +
            `，understandingLen=${this._getTextLength(understandingText)}` +
            `，modelName=${modelName || ""}` +
            `，failReason=${this._truncateText(failReason || "", 240)}`;

        if (level === "success") {
            this.LOGGER.success(message);
        } else if (level === "debug") {
            this.LOGGER.debug(message);
        } else {
            this.LOGGER.warning(message);
        }
    }

    private async _markFailedOrRetry(
        media: PendingChatMessageMedia,
        failReason: string,
        stats: ImageUnderstandingStats
    ): Promise<void> {
        const config = await this.configManagerService.getCurrentConfig();
        const nextRetryCount = media.retryCount + 1;
        const shouldRetry = nextRetryCount <= config.ai.imageUnderstanding.retryCount;

        await this.imDbAccessService.updateChatMessageMediaUnderstanding(media.mediaId, {
            status: shouldRetry ? "pending" : "failed",
            failReason: this._truncateText(failReason || "图片理解失败", 240),
            incrementRetryCount: true
        });

        const status = shouldRetry ? "pending" : "failed";
        const truncatedFailReason = this._truncateText(failReason || "图片理解失败", 240);

        if (shouldRetry) {
            this._logImageUnderstandingAudit(media, status, "", "", "", null, truncatedFailReason, "warning");
        } else {
            stats.failed++;
            this._logImageUnderstandingAudit(media, status, "", "", "", null, truncatedFailReason, "warning");
        }
    }

    private async _fetchImageAsDataUrl(imageUrl: string, maxImageBytes: number): Promise<ImageDataUrlResult> {
        const response = await fetch(imageUrl);

        if (!response.ok) {
            throw new Error(`图片下载 HTTP ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const byteLength = arrayBuffer.byteLength;

        if (byteLength > maxImageBytes) {
            throw new Error(`图片大小 ${byteLength} 超过上限 ${maxImageBytes}`);
        }

        const contentType = response.headers.get("content-type") || "image/jpeg";
        const base64 = Buffer.from(arrayBuffer).toString("base64");

        return {
            dataUrl: `data:${contentType};base64,${base64}`,
            byteLength
        };
    }

    private async _loadImageAsDataUrl(
        media: PendingChatMessageMedia,
        config: GlobalConfig,
        maxImageBytes: number
    ): Promise<ImageDataUrlResult> {
        if (media.sourcePath) {
            return await this._readQQImageSourcePathAsDataUrl(
                config.dataProviders.QQ.dbBasePath,
                media.sourcePath,
                maxImageBytes
            );
        }

        if (media.sourceUrl && this._isHttpUrl(media.sourceUrl)) {
            return await this._fetchImageAsDataUrl(media.sourceUrl, maxImageBytes);
        }

        throw new Error("图片缺少可访问 URL 或本地缓存路径");
    }

    private async _readImagePathAsDataUrl(imagePath: string, maxImageBytes: number): Promise<ImageDataUrlResult> {
        const buffer = await fs.readFile(imagePath);
        const byteLength = buffer.byteLength;

        if (byteLength > maxImageBytes) {
            throw new Error(`图片大小 ${byteLength} 超过上限 ${maxImageBytes}`);
        }

        return {
            dataUrl: `data:${this._inferImageContentType(imagePath)};base64,${buffer.toString("base64")}`,
            byteLength
        };
    }

    private async _readQQImageSourcePathAsDataUrl(
        dbBasePath: string,
        sourcePath: string,
        maxImageBytes: number
    ): Promise<ImageDataUrlResult> {
        const candidatePaths = this._resolveQQImageFilePathCandidates(dbBasePath, sourcePath);
        let lastError: unknown = null;

        if (candidatePaths.length === 0) {
            throw new Error("图片缓存路径超出 QQ 媒体根目录");
        }

        for (const candidatePath of candidatePaths) {
            try {
                return await this._readImagePathAsDataUrl(candidatePath, maxImageBytes);
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error("图片缓存文件不存在");
    }

    private _resolveQQImageFilePathCandidates(dbBasePath: string, sourcePath: string): string[] {
        const accountRootPath = path.dirname(path.dirname(path.resolve(dbBasePath)));
        const tencentFilesRootPath = path.dirname(accountRootPath);
        const normalizedSourcePath = path.normalize(sourcePath);
        const candidatePaths = path.isAbsolute(normalizedSourcePath)
            ? [path.resolve(normalizedSourcePath)]
            : [
                  path.resolve(accountRootPath, normalizedSourcePath),
                  path.resolve(tencentFilesRootPath, normalizedSourcePath)
              ];

        return [...new Set(candidatePaths)].filter(candidatePath =>
            this._isPathInsideAnyRoot(candidatePath, [accountRootPath, tencentFilesRootPath])
        );
    }

    private _isPathInsideAnyRoot(candidatePath: string, rootPaths: string[]): boolean {
        for (const rootPath of rootPaths) {
            const relativePath = path.relative(rootPath, candidatePath);

            if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`)) {
                return true;
            }
        }

        return false;
    }

    private _inferImageContentType(imagePath: string): string {
        const extension = path.extname(imagePath).toLowerCase();

        if (extension === ".png") {
            return "image/png";
        }

        if (extension === ".gif") {
            return "image/gif";
        }

        if (extension === ".webp") {
            return "image/webp";
        }

        return "image/jpeg";
    }

    private _isHttpUrl(value: string | null | undefined): boolean {
        if (!value) {
            return false;
        }

        try {
            const url = new URL(value);

            return url.protocol === "http:" || url.protocol === "https:";
        } catch {
            return false;
        }
    }

    private _buildOcrOnlyUnderstandingText(ocrText: string): string {
        return ocrText ? `图片文字：${ocrText}` : "";
    }

    private _getTextLength(value: string | null | undefined): number {
        return value ? value.length : 0;
    }

    private _joinReasons(reasons: string[]): string {
        return reasons
            .map(reason => this._normalizeInlineText(reason))
            .filter(Boolean)
            .join("；");
    }

    private _normalizeInlineText(value: string | null | undefined): string {
        if (!value) {
            return "";
        }

        let result = "";
        let hasPendingSpace = false;

        for (const char of value.trim()) {
            if (char === " " || char === "\n" || char === "\r" || char === "\t") {
                hasPendingSpace = result.length > 0;
                continue;
            }

            if (hasPendingSpace) {
                result += " ";
                hasPendingSpace = false;
            }

            result += char;
        }

        return result.trim();
    }

    private _truncateText(value: string, maxLength: number): string {
        if (value.length <= maxLength) {
            return value;
        }

        return `${value.slice(0, maxLength)}...`;
    }

    private _formatUnknownError(error: unknown): string {
        if (error instanceof Error) {
            return this._truncateText(error.message, 240);
        }

        return this._truncateText(String(error), 240);
    }
}
