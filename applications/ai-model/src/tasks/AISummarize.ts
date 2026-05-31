import "reflect-metadata";
import { injectable, inject } from "tsyringe";
import { agendaInstance } from "@root/common/scheduler/agenda";
import { TaskHandlerTypes, TaskParameters } from "@root/common/scheduler/@types/Tasks";
import Logger from "@root/common/util/Logger";
import { checkConnectivity } from "@root/common/util/network/checkConnectivity";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";
import { ImDbAccessService } from "@root/common/services/database/ImDbAccessService";
import { ProcessedChatMessageWithRawMessage } from "@root/common/contracts/data-provider";
import { AgcDbAccessService } from "@root/common/services/database/AgcDbAccessService";
import { AIDigestResult } from "@root/common/contracts/ai-model";
import getRandomHash from "@root/common/util/math/getRandomHash";
import { COMMON_TOKENS } from "@root/common/di/tokens";

import { IMSummaryCtxBuilder } from "../context/ctxBuilders/IMSummaryCtxBuilder";
import {
    PooledTextGeneratorService,
    PooledTask,
    PooledTaskResult
} from "../services/generators/text/PooledTextGeneratorService";

const OPEN_SESSION_DELAY_MS = 10 * 60 * 1000;
const UNSUMMARIZED_SESSION_BACKFILL_LIMIT = 10;

/**
 * AI 摘要任务处理器
 * 负责对群聊消息进行 AI 摘要生成
 */
@injectable()
export class AISummarizeTaskHandler {
    private LOGGER = Logger.withTag("🤖 AISummarizeTask");

    public constructor(
        @inject(COMMON_TOKENS.ConfigManagerService) private configManagerService: ConfigManagerService,
        @inject(COMMON_TOKENS.ImDbAccessService) private imDbAccessService: ImDbAccessService,
        @inject(COMMON_TOKENS.AgcDbAccessService) private agcDbAccessService: AgcDbAccessService
    ) {}

    /**
     * 注册任务到 Agenda 调度器
     */
    public async register(): Promise<void> {
        let config = await this.configManagerService.getCurrentConfig();

        await agendaInstance
            .create(TaskHandlerTypes.AISummarize)
            .unique({ name: TaskHandlerTypes.AISummarize }, { insertOnly: true })
            .save();

        agendaInstance.define<TaskParameters<TaskHandlerTypes.AISummarize>>(
            TaskHandlerTypes.AISummarize,
            async job => {
                this.LOGGER.info(`😋开始处理任务: ${job.attrs.name}`);
                const attrs = job.attrs.data;

                config = await this.configManagerService.getCurrentConfig(); // 刷新配置

                if (!(await checkConnectivity())) {
                    this.LOGGER.error(`网络连接不可用，跳过当前任务`);

                    return;
                }

                const pooledTextGeneratorService = new PooledTextGeneratorService(config.ai.maxConcurrentRequests);

                await pooledTextGeneratorService.init();
                const ctxBuilder = new IMSummaryCtxBuilder();

                await ctxBuilder.init();

                // 任务上下文类型定义
                interface TaskContext {
                    groupId: string;
                    sessionId: string;
                }

                // 收集所有需要处理的任务
                const allTasks: PooledTask<TaskContext>[] = [];

                for (const groupId of attrs.groupIds) {
                    const readyBeforeTimestamp = attrs.endTimeStamp - OPEN_SESSION_DELAY_MS;
                    /* 1. 获取指定时间范围内的消息 */
                    const msgs = (
                        await this.imDbAccessService.getProcessedChatMessageWithRawMessageByGroupIdAndTimeRange(
                            groupId,
                            attrs.startTimeStamp,
                            attrs.endTimeStamp
                        )
                    ).filter(msg => {
                        // 过滤掉sessionId为空的消息
                        if (!msg.sessionId) {
                            this.LOGGER.warning(`消息 ${msg.msgId} 的 sessionId 为空，跳过`);

                            return false;
                        } else {
                            return true;
                        }
                    });

                    this.LOGGER.info(`群 ${groupId} 成功获取到 ${msgs.length} 条有效消息`);
                    await job.touch(); // 保证任务存活

                    const candidateSessions = new Map<string, ProcessedChatMessageWithRawMessage[]>();
                    const currentSessions = this._groupMessagesBySessionId(msgs);

                    for (const [sessionId, sessionMessages] of currentSessions) {
                        await this._tryCollectReadySession(
                            candidateSessions,
                            sessionId,
                            sessionMessages,
                            readyBeforeTimestamp
                        );
                    }

                    const unsummarizedSessionStats =
                        await this.imDbAccessService.getUnsummarizedSessionStatsByGroupId(
                            groupId,
                            UNSUMMARIZED_SESSION_BACKFILL_LIMIT
                        );

                    for (const sessionStats of unsummarizedSessionStats) {
                        if (candidateSessions.has(sessionStats.sessionId)) {
                            continue;
                        }

                        if (sessionStats.timeEnd > readyBeforeTimestamp) {
                            this.LOGGER.info(
                                `session ${sessionStats.sessionId} 距离任务结束时间过近，延迟到后续任务处理`
                            );

                            continue;
                        }

                        const sessionMessages = await this.imDbAccessService.getProcessedChatMessagesBySessionId(
                            sessionStats.sessionId
                        );

                        await this._tryCollectReadySession(
                            candidateSessions,
                            sessionStats.sessionId,
                            sessionMessages,
                            readyBeforeTimestamp
                        );
                    }

                    if (candidateSessions.size === 0) {
                        this.LOGGER.info(`群 ${groupId} 没有达到处理条件的未摘要session，跳过`);
                        continue;
                    }

                    this.LOGGER.info(`分组完成，共 ${candidateSessions.size} 个需要处理的session`);

                    /* 4. 构建任务列表 */
                    for (const [sessionId, sessionMessages] of candidateSessions) {
                        this.LOGGER.info(
                            `准备处理session ${sessionId} ，该session内共 ${sessionMessages.length} 条消息`
                        );

                        // 构建上下文
                        const ctx = await ctxBuilder.buildCtx(
                            sessionMessages,
                            config.groupConfigs[groupId].groupIntroduction
                        );

                        this.LOGGER.info(`session ${sessionId} 构建上下文成功，长度为 ${ctx.length}`);

                        allTasks.push({
                            input: ctx,
                            modelNames: config.groupConfigs[groupId].aiModels,
                            context: { groupId, sessionId },
                            checkJsonFormat: true
                        });
                    }
                }

                this.LOGGER.info(
                    `共收集到 ${allTasks.length} 个任务，开始并行处理（并行度=${config.ai.maxConcurrentRequests}）`
                );

                // 并行处理所有任务，每个任务完成时回调
                let completedCount = 0;

                await pooledTextGeneratorService.submitTasks<TaskContext>(
                    allTasks,
                    async (result: PooledTaskResult<TaskContext>) => {
                        await job.touch(); // 保证任务存活
                        completedCount++;
                        const { sessionId } = result.context;

                        if (!result.isSuccess) {
                            this.LOGGER.error(
                                `[${completedCount}/${allTasks.length}] session ${sessionId} 生成摘要失败，错误信息为：${result.error}, 跳过该session`
                            );

                            return;
                        }

                        try {
                            const resultStr = result.content!;
                            const selectedModelName = result.selectedModelName!;

                            // 解析 llm 回传的 json 结果
                            const parsed = JSON.parse(resultStr);

                            if (!Array.isArray(parsed)) {
                                throw new Error(`摘要结果不是数组：${resultStr.slice(0, 100)}`);
                            }

                            // 批内按 trim(topic) 去重并丢弃空标题，得到本 session 的有效话题
                            const seenTopics = new Set<string>();
                            const digestResults: AIDigestResult[] = [];

                            for (const item of parsed as Array<Record<string, unknown>>) {
                                const topic = typeof item.topic === "string" ? item.topic.trim() : "";

                                if (topic.length === 0 || seenTopics.has(topic)) {
                                    continue;
                                }
                                seenTopics.add(topic);
                                digestResults.push({
                                    topicId: getRandomHash(16),
                                    sessionId,
                                    topic,
                                    contributors: JSON.stringify(item.contributors ?? []),
                                    detail: typeof item.detail === "string" ? item.detail : "",
                                    modelName: selectedModelName,
                                    updateTime: Date.now()
                                });
                            }

                            // 合法空摘要：写入空终态，避免该 session 被无限重复摘要
                            if (digestResults.length === 0) {
                                await this.agcDbAccessService.markSessionEmpty(sessionId);
                                this.LOGGER.info(
                                    `[${completedCount}/${allTasks.length}] session ${sessionId} 无有效话题，标记为空摘要`
                                );

                                return;
                            }

                            // 幂等提交：按 session 替换旧话题并写入成功终态
                            await this.agcDbAccessService.commitSessionDigest(sessionId, digestResults);
                            this.LOGGER.success(
                                `[${completedCount}/${allTasks.length}] session ${sessionId} 生成并存储 ${digestResults.length} 个话题`
                            );
                        } catch (error) {
                            this.LOGGER.error(
                                `session ${sessionId} 处理结果失败，错误信息为：${error}, 跳过该session`
                            );
                        }
                    }
                );

                pooledTextGeneratorService.dispose();
                ctxBuilder.dispose();

                this.LOGGER.success(`🥳任务完成: ${job.attrs.name}`);
            },
            {
                concurrency: 1,
                priority: "high",
                lockLifetime: 20 * 60 * 1000 // 20分钟
            }
        );
    }

    /**
     * 按 sessionId 对消息分组。
     * @param msgs 已带 sessionId 的消息列表
     * @returns sessionId 到消息列表的映射
     */
    private _groupMessagesBySessionId(
        msgs: ProcessedChatMessageWithRawMessage[]
    ): Map<string, ProcessedChatMessageWithRawMessage[]> {
        const sessions = new Map<string, ProcessedChatMessageWithRawMessage[]>();

        for (const msg of msgs) {
            if (!sessions.has(msg.sessionId)) {
                sessions.set(msg.sessionId, []);
            }
            sessions.get(msg.sessionId)!.push(msg);
        }

        return sessions;
    }

    /**
     * 收集已经稳定且尚未摘要的 session。
     * @param candidateSessions 候选 session 映射
     * @param sessionId 会话ID
     * @param sessionMessages 会话消息
     * @param readyBeforeTimestamp 可处理的最晚结束时间
     */
    private async _tryCollectReadySession(
        candidateSessions: Map<string, ProcessedChatMessageWithRawMessage[]>,
        sessionId: string,
        sessionMessages: ProcessedChatMessageWithRawMessage[],
        readyBeforeTimestamp: number
    ): Promise<void> {
        if (sessionMessages.length === 0) {
            return;
        }

        if (await this.agcDbAccessService.isSessionIdProcessed(sessionId)) {
            return;
        }

        const sessionEndTime = Math.max(...sessionMessages.map(msg => msg.timestamp));

        if (sessionEndTime > readyBeforeTimestamp) {
            this.LOGGER.info(`session ${sessionId} 距离任务结束时间过近，延迟到后续任务处理`);

            return;
        }

        candidateSessions.set(sessionId, sessionMessages);
    }
}
