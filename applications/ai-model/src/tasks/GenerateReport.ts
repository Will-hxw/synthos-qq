import "reflect-metadata";
import { injectable, inject } from "tsyringe";
import { agendaInstance } from "@root/common/scheduler/agenda";
import { TaskHandlerTypes, TaskParameters } from "@root/common/scheduler/@types/Tasks";
import Logger from "@root/common/util/Logger";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";
import { checkConnectivity } from "@root/common/util/network/checkConnectivity";
import { AgcDbAccessService, type LatestTopicRecord } from "@root/common/services/database/AgcDbAccessService";
import { ReportDbAccessService } from "@root/common/services/database/ReportDbAccessService";
import { Report, ReportStatistics, ReportType } from "@root/common/contracts/report";
import getRandomHash from "@root/common/util/math/getRandomHash";
import { COMMON_TOKENS } from "@root/common/di/tokens";

import { ReportPromptStore } from "../context/prompts/ReportPromptStore";
import { AI_MODEL_TOKENS } from "../di/tokens";
import { ReportEmailService } from "../services/email/ReportEmailService";
import { TextGeneratorService } from "../services/generators/text/TextGeneratorService";

/**
 * 日报生成任务处理器
 * 负责生成各类日报（半日报、周报、月报）
 */
@injectable()
export class GenerateReportTaskHandler {
    private LOGGER = Logger.withTag("📰 GenerateReportTask");

    public constructor(
        @inject(COMMON_TOKENS.ConfigManagerService) private configManagerService: ConfigManagerService,
        @inject(COMMON_TOKENS.AgcDbAccessService) private agcDbAccessService: AgcDbAccessService,
        @inject(COMMON_TOKENS.ReportDbAccessService) private reportDbAccessService: ReportDbAccessService,
        @inject(AI_MODEL_TOKENS.ReportEmailService) private reportEmailService: ReportEmailService,
        @inject(AI_MODEL_TOKENS.TextGeneratorService) private textGeneratorService: TextGeneratorService
    ) {}

    /**
     * 注册任务到 Agenda 调度器
     */
    public async register(): Promise<void> {
        let config = await this.configManagerService.getCurrentConfig();

        await agendaInstance
            .create(TaskHandlerTypes.GenerateReport)
            .unique({ name: TaskHandlerTypes.GenerateReport }, { insertOnly: true })
            .save();

        agendaInstance.define<TaskParameters<TaskHandlerTypes.GenerateReport>>(
            TaskHandlerTypes.GenerateReport,
            async job => {
                this.LOGGER.info(`📰 开始处理日报生成任务: ${job.attrs.name}`);
                const attrs = job.attrs.data;

                config = await this.configManagerService.getCurrentConfig();

                // 检查日报功能是否启用
                if (!config.report.enabled) {
                    this.LOGGER.info("日报功能未启用，跳过任务");

                    return;
                }

                const { reportType, timeStart, timeEnd } = attrs;

                const existingReport = await this.reportDbAccessService.getReportByTypeAndExactPeriod(
                    reportType,
                    timeStart,
                    timeEnd
                );

                if (existingReport?.summaryStatus === "success") {
                    this.LOGGER.info(
                        `${reportType} 日报已成功生成 (${new Date(timeStart).toISOString()} - ${new Date(timeEnd).toISOString()})，跳过重复生成`
                    );

                    return;
                }

                const reportId = existingReport?.reportId ?? getRandomHash(16);
                const reportCreatedAt = existingReport?.createdAt ?? Date.now();

                const periodDescription = this.formatPeriodDescription(reportType, timeStart, timeEnd);

                this.LOGGER.info(`正在生成 ${periodDescription} 的日报...`);

                try {
                    // 1. 按聊天消息时间获取该周期命中的 AI 摘要结果
                    const digestResults = await this.agcDbAccessService.getLatestTopicRecordsByTimeRange(
                        timeStart,
                        timeEnd
                    );

                    // 2. 获取兴趣度评分，过滤掉负分话题
                    const interestScores = new Map<string, number>();

                    for (const result of digestResults) {
                        const score = result.interestScore;

                        if (typeof score === "number") {
                            interestScores.set(result.topicId, score);
                        }
                    }

                    // 过滤掉兴趣度低于阈值的话题（若不存在兴趣度评分，则保留）
                    const interestScoreThreshold = config.report.generation.interestScoreThreshold;
                    const filteredResults = digestResults.filter(result => {
                        const score = interestScores.get(result.topicId);

                        return score === undefined || score >= interestScoreThreshold;
                    });

                    // 3. 检查是否有话题
                    if (filteredResults.length === 0) {
                        this.LOGGER.info(`${periodDescription} 没有有效话题，生成空日报`);

                        const emptyReport: Report = {
                            reportId,
                            type: reportType,
                            timeStart,
                            timeEnd,
                            isEmpty: true,
                            summary: ReportPromptStore.getEmptyReportText(periodDescription),
                            summaryGeneratedAt: Date.now(),
                            summaryStatus: "success",
                            model: "",
                            statistics: { topicCount: 0, mostActiveGroups: [], mostActiveHour: 0 },
                            topicIds: [],
                            createdAt: reportCreatedAt,
                            updatedAt: Date.now()
                        };

                        await this.reportDbAccessService.storeReport(emptyReport);
                        this.LOGGER.success(`${periodDescription} 空日报生成完成`);

                        // 发送空日报邮件
                        try {
                            await this.reportEmailService.sendReportEmail(emptyReport);
                        } catch (emailError) {
                            this.LOGGER.warning(`发送空日报邮件失败: ${emailError}`);
                        }

                        return;
                    }

                    // 4. 按兴趣度排序，取 Top N
                    const topN = config.report.generation.topNTopics;
                    const sortedResults = [...filteredResults]
                        .sort((a, b) => {
                            const scoreA = interestScores.get(a.topicId) ?? 0;
                            const scoreB = interestScores.get(b.topicId) ?? 0;

                            return scoreB - scoreA;
                        })
                        .slice(0, topN);

                    // 5. 计算统计数据
                    const statistics = this.calculateStatistics(sortedResults);

                    // 6. 准备话题数据给 LLM
                    const topicsData = sortedResults.map(r => ({
                        topic: r.topic,
                        detail: r.detail
                    }));

                    // 7. 检查网络连接
                    if (!(await checkConnectivity())) {
                        this.LOGGER.error("网络连接不可用，跳过 LLM 综述生成");

                        const report: Report = {
                            reportId,
                            type: reportType,
                            timeStart,
                            timeEnd,
                            isEmpty: false,
                            summary: "",
                            summaryGeneratedAt: 0,
                            summaryStatus: "pending",
                            model: "",
                            statistics,
                            topicIds: sortedResults.map(r => r.topicId),
                            createdAt: reportCreatedAt,
                            updatedAt: Date.now()
                        };

                        await this.reportDbAccessService.storeReport(report);

                        return;
                    }

                    // 8. 调用 LLM 生成综述
                    const prompt = (
                        await ReportPromptStore.getReportSummaryPrompt(
                            reportType,
                            periodDescription,
                            topicsData,
                            statistics
                        )
                    ).serializeToString();
                    let summary = "";
                    let selectedModelName = "";
                    let summaryStatus: "success" | "failed" = "failed";
                    const retryCount = config.report.generation.llmRetryCount;
                    const modelCandidates = config.report.generation.aiModels;

                    this.LOGGER.info(`开始调用 LLM 生成日报综述，prompt长度：${prompt.length}`);

                    for (let attempt = 0; attempt <= retryCount; attempt++) {
                        try {
                            const result = await this.textGeneratorService.generateTextWithModelCandidates(
                                modelCandidates,
                                prompt
                            );

                            summary = result.content;
                            selectedModelName = result.selectedModelName;
                            summaryStatus = "success";
                            this.LOGGER.success(`日报综述生成成功，使用模型: ${selectedModelName}`);
                            break;
                        } catch (error) {
                            this.LOGGER.warning(`第 ${attempt + 1} 次尝试生成综述失败: ${error}`);
                            if (attempt === retryCount) {
                                this.LOGGER.error(`所有重试均失败，日报综述生成失败`);
                            }
                        }
                    }

                    this.textGeneratorService.dispose();

                    // 9. 保存日报
                    const report: Report = {
                        reportId,
                        type: reportType,
                        timeStart,
                        timeEnd,
                        isEmpty: false,
                        summary,
                        summaryGeneratedAt: Date.now(),
                        summaryStatus,
                        model: selectedModelName,
                        statistics,
                        topicIds: sortedResults.map(r => r.topicId),
                        createdAt: reportCreatedAt,
                        updatedAt: Date.now()
                    };

                    await this.reportDbAccessService.storeReport(report);
                    this.LOGGER.success(`📰 ${periodDescription} 日报生成完成！话题数: ${statistics.topicCount}`);

                    // 发送日报邮件（仅当综述生成成功时）
                    if (summaryStatus === "success") {
                        try {
                            await this.reportEmailService.sendReportEmail(report);
                        } catch (emailError) {
                            this.LOGGER.error(`发送日报邮件失败: ${emailError}`);
                        }
                    }
                } catch (error) {
                    this.LOGGER.error(`日报生成失败: ${error}`);
                    throw error;
                }
            },
            {
                concurrency: 1,
                priority: "normal",
                lockLifetime: 10 * 60 * 1000 // 10分钟
            }
        );
    }

    /**
     * 格式化时间段描述
     */
    private formatPeriodDescription(type: ReportType, timeStart: number, timeEnd: number): string {
        const startDate = new Date(timeStart);
        const endDate = new Date(timeEnd);

        const formatDate = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;

        if (type === "half-daily") {
            const hour = startDate.getHours();
            const period = hour < 12 ? "上午" : "下午";

            return `${formatDate(startDate)} ${period}`;
        } else if (type === "weekly") {
            return `${formatDate(startDate)} - ${formatDate(endDate)} 周报`;
        } else {
            return `${formatDate(startDate)} - ${formatDate(endDate)} 月报`;
        }
    }

    /**
     * 计算统计数据
     */
    private calculateStatistics(topics: Pick<LatestTopicRecord, "groupId" | "timeEnd">[]): ReportStatistics {
        // 计算最活跃群组
        const groupTopicCount = new Map<string, number>();

        for (const topic of topics) {
            const groupId = topic.groupId || "unknown";

            groupTopicCount.set(groupId, (groupTopicCount.get(groupId) || 0) + 1);
        }

        const sortedGroups = Array.from(groupTopicCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([groupId]) => groupId);

        // 计算最活跃时段
        const hourCount = new Map<number, number>();

        for (const topic of topics) {
            const hour = new Date(topic.timeEnd).getHours();

            hourCount.set(hour, (hourCount.get(hour) || 0) + 1);
        }

        let mostActiveHour = 0;
        let maxCount = 0;

        for (const [hour, count] of hourCount.entries()) {
            if (count > maxCount) {
                maxCount = count;
                mostActiveHour = hour;
            }
        }

        return {
            topicCount: topics.length,
            mostActiveGroups: sortedGroups,
            mostActiveHour
        };
    }
}
