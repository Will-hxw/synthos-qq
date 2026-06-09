/**
 * 日报服务
 */
import type { ReferenceItem } from "@root/common/rpc/ai-model";

import { injectable, inject } from "tsyringe";
import { AgcDbAccessService } from "@root/common/services/database/AgcDbAccessService";
import { ReportDbAccessService } from "@root/common/services/database/ReportDbAccessService";
import { Report, ReportType } from "@root/common/contracts/report/index";
import Logger from "@root/common/util/Logger";

import { TOKENS } from "../di/tokens";
import { NotFoundError } from "../errors/AppError";
import { RAGClient } from "../rpc/aiModelClient";
import { ReportReadStatusManager } from "../repositories/ReportReadStatusManager";
import { ReportFavoriteStatusManager } from "../repositories/ReportFavoriteStatusManager";

@injectable()
export class ReportService {
    private LOGGER = Logger.withTag("ReportService");

    constructor(
        @inject(TOKENS.ReportDbAccessService) private reportDbAccessService: ReportDbAccessService,
        @inject(TOKENS.AgcDbAccessService) private agcDbAccessService: AgcDbAccessService,
        @inject(TOKENS.RAGClient) private ragClient: RAGClient,
        @inject(TOKENS.ReportReadStatusManager) private readStatusManager: ReportReadStatusManager,
        @inject(TOKENS.ReportFavoriteStatusManager) private favoriteStatusManager: ReportFavoriteStatusManager
    ) {}

    /**
     * 根据 reportId 获取日报
     */
    public async getReportById(reportId: string): Promise<Report> {
        const report = await this.reportDbAccessService.getReportById(reportId);

        if (!report) {
            throw new NotFoundError("未找到对应的日报");
        }

        return report;
    }

    /**
     * 获取日报详情（包含 references）
     * references 的顺序与 report.topicIds 保持一致，从而与 AI 输出的 [话题N] 标注序号对齐。
     */
    public async getReportDetailById(reportId: string): Promise<{ report: Report; references: ReferenceItem[] }> {
        const report = await this.getReportById(reportId);

        const topicIds = report.topicIds;

        if (topicIds.length === 0) {
            return { report, references: [] };
        }

        const references: ReferenceItem[] = [];

        // 批量取出全部 topic 摘要，避免逐 topicId 查询的 N+1 往返
        const digestMap = await this.agcDbAccessService.getAIDigestResultsByTopicIds(topicIds);

        for (let i = 0; i < topicIds.length; i += 1) {
            const topicId = topicIds[i];
            const digest = digestMap.get(topicId);

            if (!digest) {
                throw new NotFoundError(`未找到对应的话题摘要：${topicId}`);
            }

            // report 的 topicIds 已按“价值/兴趣度”排序，relevance 用序位做一个 0~1 的衰减映射。
            // 仅用于 UI 展示，并不参与检索。
            const relevance = (topicIds.length - i) / topicIds.length;

            references.push({
                topicId,
                topic: digest.topic,
                relevance
            });
        }

        return { report, references };
    }

    /**
     * 获取日报列表（分页）
     * @param favoriteOnly 为 true 时仅返回已收藏的日报
     */
    public async getReportsPaginated(
        page: number,
        pageSize: number,
        type?: ReportType,
        favoriteOnly?: boolean
    ): Promise<{ reports: Report[]; total: number; page: number; pageSize: number }> {
        this.LOGGER.info(
            `查询日报列表（分页）: page=${page}, pageSize=${pageSize}, type=${type ?? "all"}, favoriteOnly=${favoriteOnly === true}`
        );

        try {
            let favoriteReportIds: string[] | undefined;

            if (favoriteOnly) {
                favoriteReportIds = await this.favoriteStatusManager.getFavoriteReportIds();
                this.LOGGER.debug(`收藏筛选已启用，当前收藏日报数量: ${favoriteReportIds.length}`);

                if (favoriteReportIds.length === 0) {
                    this.LOGGER.info("收藏集为空，直接返回空列表");
                }
            }

            const result = await this.reportDbAccessService.getReportsPaginated(
                page,
                pageSize,
                type,
                favoriteReportIds
            );

            this.LOGGER.success(
                `日报列表查询完成: 本页返回 ${result.reports.length} 条，总计 ${result.total} 条（page=${page}, type=${type ?? "all"}, favoriteOnly=${favoriteOnly === true}）`
            );

            return {
                ...result,
                page,
                pageSize
            };
        } catch (error) {
            this.LOGGER.error(
                `日报列表查询失败: page=${page}, pageSize=${pageSize}, type=${type ?? "all"}, favoriteOnly=${favoriteOnly === true}, error=${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /**
     * 获取指定日期的半日报
     */
    public async getHalfDailyReportsByDate(date: Date): Promise<Report[]> {
        return this.reportDbAccessService.getHalfDailyReportsByDate(date);
    }

    /**
     * 获取指定时间范围内的日报
     */
    public async getReportsByTimeRange(timeStart: number, timeEnd: number, type?: ReportType): Promise<Report[]> {
        if (type) {
            return this.reportDbAccessService.getReportsByTypeAndTimeRange(type, timeStart, timeEnd);
        }

        return this.reportDbAccessService.getReportsByTimeRange(timeStart, timeEnd);
    }

    /**
     * 获取最近的日报
     */
    public async getRecentReports(type: ReportType, limit: number): Promise<Report[]> {
        return this.reportDbAccessService.getRecentReportsByType(type, limit);
    }

    /**
     * 手动触发生成日报
     * @param type 日报类型
     * @param timeStart 可选的开始时间
     * @param timeEnd 可选的结束时间
     */
    public async triggerGenerate(
        type: ReportType,
        timeStart?: number,
        timeEnd?: number
    ): Promise<{ success?: boolean; message?: string; reportId?: string }> {
        return this.ragClient.triggerReportGenerate.mutate({
            type,
            timeStart,
            timeEnd
        });
    }

    // ==================== 已读相关 ====================

    /**
     * 标记日报为已读
     */
    public async markAsRead(reportId: string): Promise<void> {
        await this.readStatusManager.markAsRead(reportId);
    }

    /**
     * 标记日报为未读
     */
    public async markAsUnread(reportId: string): Promise<void> {
        await this.readStatusManager.markAsUnread(reportId);
    }

    /**
     * 批量检查日报已读状态
     */
    public async checkReadStatus(reportIds: string[]): Promise<Record<string, boolean>> {
        const entries = await Promise.all(
            reportIds.map(
                async reportId => [reportId, await this.readStatusManager.isReportRead(reportId)] as const
            )
        );

        return Object.fromEntries(entries);
    }

    // ==================== 收藏相关 ====================

    /**
     * 标记日报为收藏
     */
    public async markAsFavorite(reportId: string): Promise<void> {
        this.LOGGER.info(`标记日报为收藏: reportId=${reportId}`);

        try {
            const alreadyFavorite = await this.favoriteStatusManager.isReportFavorite(reportId);

            if (alreadyFavorite) {
                this.LOGGER.debug(`日报已处于收藏状态，重复标记（幂等）: reportId=${reportId}`);
            }

            await this.favoriteStatusManager.markAsFavorite(reportId);
            this.LOGGER.success(`日报已标记为收藏: reportId=${reportId}`);
        } catch (error) {
            this.LOGGER.error(
                `标记日报收藏失败: reportId=${reportId}, error=${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /**
     * 从收藏中移除日报
     */
    public async removeFromFavorites(reportId: string): Promise<void> {
        this.LOGGER.info(`从收藏中移除日报: reportId=${reportId}`);

        try {
            const isFavorite = await this.favoriteStatusManager.isReportFavorite(reportId);

            if (!isFavorite) {
                this.LOGGER.debug(`日报本就不在收藏中，移除操作无实际变更（幂等）: reportId=${reportId}`);
            }

            await this.favoriteStatusManager.removeFromFavorites(reportId);
            this.LOGGER.success(`日报已从收藏中移除: reportId=${reportId}`);
        } catch (error) {
            this.LOGGER.error(
                `移除日报收藏失败: reportId=${reportId}, error=${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /**
     * 批量检查日报收藏状态
     */
    public async checkFavoriteStatus(reportIds: string[]): Promise<Record<string, boolean>> {
        this.LOGGER.info(`批量检查日报收藏状态: count=${reportIds.length}`);

        try {
            const entries = await Promise.all(
                reportIds.map(
                    async reportId =>
                        [reportId, await this.favoriteStatusManager.isReportFavorite(reportId)] as const
                )
            );

            const favoriteCount = entries.filter(([, isFavorite]) => isFavorite).length;

            this.LOGGER.debug(`收藏状态检查完成: 查询 ${reportIds.length} 条，其中已收藏 ${favoriteCount} 条`);

            return Object.fromEntries(entries);
        } catch (error) {
            this.LOGGER.error(
                `批量检查日报收藏状态失败: count=${reportIds.length}, error=${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    // ==================== 删除相关 ====================

    /**
     * 删除日报（物理删除，不可恢复）。
     * 同时清理该日报的已读与收藏状态，避免遗留孤儿记录。
     */
    public async deleteReport(reportId: string): Promise<void> {
        this.LOGGER.info(`请求删除日报（物理删除）: reportId=${reportId}`);

        const report = await this.reportDbAccessService.getReportById(reportId);

        if (!report) {
            this.LOGGER.warning(`删除日报失败，日报不存在: reportId=${reportId}`);
            throw new NotFoundError("未找到对应的日报");
        }

        this.LOGGER.debug(
            `待删除日报详情: reportId=${reportId}, type=${report.type}, timeStart=${report.timeStart}, timeEnd=${report.timeEnd}, isEmpty=${report.isEmpty}, topicCount=${report.topicIds.length}`
        );

        try {
            await this.reportDbAccessService.deleteReport(reportId);
            this.LOGGER.debug(`已从数据库删除日报记录: reportId=${reportId}`);

            // 清理关联的已读/收藏状态。失败不应阻断主流程（日报本体已删除），仅告警。
            try {
                await this.readStatusManager.markAsUnread(reportId);
                await this.favoriteStatusManager.removeFromFavorites(reportId);
                this.LOGGER.debug(`已清理日报关联的已读/收藏状态: reportId=${reportId}`);
            } catch (cleanupError) {
                this.LOGGER.warning(
                    `日报已删除，但清理已读/收藏状态时出错（可能遗留孤儿状态）: reportId=${reportId}, error=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
                );
            }

            this.LOGGER.success(`日报已删除: reportId=${reportId}, type=${report.type}`);
        } catch (error) {
            this.LOGGER.error(
                `删除日报失败: reportId=${reportId}, error=${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /**
     * 发送日报邮件
     * 通过 RPC 调用 ai-model 发送日报邮件
     * @param reportId 日报 ID
     * @returns 发送结果
     */
    public async sendReportEmail(reportId: string): Promise<{ success: boolean; message: string }> {
        const result = await this.ragClient.sendReportEmail.mutate({ reportId });

        return {
            success: result.success ?? false,
            message: result.message ?? ""
        };
    }
}
