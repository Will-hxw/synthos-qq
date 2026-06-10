import "reflect-metadata";
import { injectable, inject } from "tsyringe";
import { agendaInstance } from "@root/common/scheduler/agenda";
import { TaskHandlerTypes, TaskParameters } from "@root/common/scheduler/@types/Tasks";
import Logger from "@root/common/util/Logger";
import { ImDbAccessService } from "@root/common/services/database/ImDbAccessService";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";
import { AgcDbAccessService } from "@root/common/services/database/AgcDbAccessService";
import { InterestScoreDbAccessService } from "@root/common/services/database/InterestScoreDbAccessService";
import { COMMON_TOKENS } from "@root/common/di/tokens";
import { retryAsync } from "@root/common/util/retryAsync";

import { SemanticRater } from "../misc/SemanticRater";
import { EmbeddingService } from "../services/embedding/EmbeddingService";
import { AI_MODEL_TOKENS } from "../di/tokens";

/**
 * 兴趣度评分任务处理器
 * 负责对 AI 摘要结果进行兴趣度评分
 */
@injectable()
export class InterestScoreTaskHandler {
    private LOGGER = Logger.withTag("🤖 InterestScoreTask");

    public constructor(
        @inject(COMMON_TOKENS.ConfigManagerService) private configManagerService: ConfigManagerService,
        @inject(COMMON_TOKENS.ImDbAccessService) private imDbAccessService: ImDbAccessService,
        @inject(COMMON_TOKENS.AgcDbAccessService) private agcDbAccessService: AgcDbAccessService,
        @inject(COMMON_TOKENS.InterestScoreDbAccessService)
        private interestScoreDbAccessService: InterestScoreDbAccessService,
        @inject(AI_MODEL_TOKENS.EmbeddingService) private embeddingService: EmbeddingService
    ) {}

    /**
     * 注册任务到 Agenda 调度器
     */
    public async register(): Promise<void> {
        let config = await this.configManagerService.getCurrentConfig();

        await agendaInstance
            .create(TaskHandlerTypes.InterestScore)
            .unique({ name: TaskHandlerTypes.InterestScore }, { insertOnly: true })
            .save();

        agendaInstance.define<TaskParameters<TaskHandlerTypes.InterestScore>>(
            TaskHandlerTypes.InterestScore,
            async job => {
                this.LOGGER.info(`😋开始处理任务: ${job.attrs.name}`);
                const attrs = job.attrs.data;

                config = await this.configManagerService.getCurrentConfig(); // 刷新配置

                // 检查 Ollama 服务可用性（带重试）
                try {
                    await retryAsync(
                        async () => {
                            const embeddingStatus = await this.embeddingService.getAvailability();

                            if (!embeddingStatus.ollamaReachable) {
                                throw new Error(`Ollama 服务不可达：${embeddingStatus.error ?? "未知错误"}`);
                            }

                            if (!embeddingStatus.modelInstalled) {
                                throw new Error(
                                    `Ollama embedding 模型未安装：${embeddingStatus.model}。请执行 ollama pull ${embeddingStatus.model}`
                                );
                            }
                        },
                        {
                            maxRetries: 3,
                            retryDelayMs: 10000,
                            taskName: "Ollama 可用性检查"
                        }
                    );

                    this.LOGGER.success(`Ollama 服务可用，模型: ${config.ai.embedding.model}`);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);

                    this.LOGGER.error(`Ollama 服务不可用，重试已耗尽：${errorMessage}`);
                    throw error; // 抛出异常让 Agenda 感知到任务失败
                }

                const groupIds = Object.keys(config.groupConfigs);
                const sessionIdsByGroup = await this.imDbAccessService.getSessionIdsByGroupIdsAndTimeRange(
                    groupIds,
                    attrs.startTimeStamp,
                    attrs.endTimeStamp
                );
                const sessionIds = sessionIdsByGroup.flatMap(item => item.sessionIds);
                const digestResults = (
                    await this.agcDbAccessService.getAIDigestResultsBySessionIds(sessionIds)
                ).flatMap(item => item.result);

                this.LOGGER.info(`共获取到 ${digestResults.length} 可能需要打分的摘要结果`);

                // 过滤掉已经计算过兴趣度的结果
                const existingTopicIds = await this.interestScoreDbAccessService.getExistingInterestScoreTopicIds(
                    digestResults.map(digestResult => digestResult.topicId)
                );
                const filteredDigestResults = digestResults.filter(
                    digestResult => !existingTopicIds.has(digestResult.topicId)
                );

                this.LOGGER.info(`还剩 ${filteredDigestResults.length} 条需要打分的摘要结果`);
                if (filteredDigestResults.length === 0) {
                    this.LOGGER.info("没有需要打分的摘要结果，跳过当前任务");

                    return;
                }

                const rater = new SemanticRater(this.embeddingService);
                // 转换参数格式
                const argArr = [];

                argArr.push(
                    ...config.ai.interestScore.UserInterestsPositiveKeywords.map(keyword => {
                        return {
                            keyword,
                            liked: true
                        };
                    })
                );
                argArr.push(
                    ...config.ai.interestScore.UserInterestsNegativeKeywords.map(keyword => {
                        return {
                            keyword,
                            liked: false
                        };
                    })
                );
                if (argArr.length === 0) {
                    this.LOGGER.warning("未配置兴趣关键词，跳过当前任务");

                    return;
                }

                // 构建所有话题详情文本
                const topics = filteredDigestResults.map(
                    digestResult => `话题：${digestResult.topic} 正文内容：${digestResult.detail}`
                );

                // 批量获取所有话题的分数
                await job.touch(); // 保证任务存活
                const scores = await rater.scoreTopics(argArr, topics);

                // 存储所有分数结果
                await this.interestScoreDbAccessService.storeInterestScoreResults(
                    filteredDigestResults.map((digestResult, index) => ({
                        topicId: digestResult.topicId,
                        score: scores[index]
                    }))
                );

                this.LOGGER.success(`🥳任务完成: ${job.attrs.name}`);
            },
            {
                concurrency: 1,
                priority: "high",
                lockLifetime: 10 * 60 * 1000 // 10分钟
            }
        );
    }
}
