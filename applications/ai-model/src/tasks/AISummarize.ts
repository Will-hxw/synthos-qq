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
import { AI_MODEL_TOKENS } from "../di/tokens";
import {
    PooledTextGeneratorService,
    PooledTask,
    PooledTaskResult
} from "../services/generators/text/PooledTextGeneratorService";
import { VectorDBManagerService } from "../services/embedding/VectorDBManagerService";

const OPEN_SESSION_DELAY_MS = 10 * 60 * 1000;
const UNSUMMARIZED_SESSION_BACKFILL_LIMIT = 500;

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
        @inject(COMMON_TOKENS.AgcDbAccessService) private agcDbAccessService: AgcDbAccessService,
        @inject(AI_MODEL_TOKENS.VectorDBManagerService)
        private vectorDBManagerService: VectorDBManagerService
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

                await this._repairAndLogClosedSessionOverruns();

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
                            diagnosticContext: { groupId, sessionId },
                            checkJsonFormat: true
                        });
                    }
                }

                this.LOGGER.info(
                    `共收集到 ${allTasks.length} 个任务，开始并行处理（并行度=${config.ai.maxConcurrentRequests}）`
                );

                if (allTasks.length === 0) {
                    await this._logActiveDigestSessionBlocks(attrs.groupIds);
                }

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
                            await this.agcDbAccessService.markSessionFailed(
                                sessionId,
                                this._formatErrorMessage(result.error)
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
                                const deletedTopicIds = await this.agcDbAccessService.markSessionEmpty(sessionId);

                                this.vectorDBManagerService.deleteEmbeddingsIfExists(deletedTopicIds);
                                this.LOGGER.info(
                                    `[${completedCount}/${allTasks.length}] session ${sessionId} 无有效话题，标记为空摘要`
                                );

                                return;
                            }

                            // 幂等提交：按 session 替换旧话题并写入成功终态
                            const deletedTopicIds = await this.agcDbAccessService.commitSessionDigest(
                                sessionId,
                                digestResults
                            );

                            this.vectorDBManagerService.deleteEmbeddingsIfExists(deletedTopicIds);
                            this.LOGGER.success(
                                `[${completedCount}/${allTasks.length}] session ${sessionId} 生成并存储 ${digestResults.length} 个话题`
                            );
                        } catch (error) {
                            this.LOGGER.error(
                                `session ${sessionId} 处理结果失败，错误信息为：${error}, 跳过该session`
                            );
                            await this.agcDbAccessService.markSessionFailed(
                                sessionId,
                                this._formatErrorMessage(error)
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

        // session 消息可能很多，用 reduce 取最大时间戳，避免 Math.max(...arr) 大数组展开触发 RangeError
        const sessionTimeRange = sessionMessages.reduce(
            (range, msg) => ({
                timeStart: msg.timestamp < range.timeStart ? msg.timestamp : range.timeStart,
                timeEnd: msg.timestamp > range.timeEnd ? msg.timestamp : range.timeEnd
            }),
            {
                timeStart: sessionMessages[0].timestamp,
                timeEnd: sessionMessages[0].timestamp
            }
        );

        if (sessionTimeRange.timeEnd > readyBeforeTimestamp) {
            this.LOGGER.info(`session ${sessionId} 距离任务结束时间过近，延迟到后续任务处理`);

            return;
        }

        const claimed = await this.agcDbAccessService.tryClaimSessionForDigest(sessionId, {
            messageCount: sessionMessages.length,
            timeStart: sessionTimeRange.timeStart,
            timeEnd: sessionTimeRange.timeEnd
        });

        if (!claimed) {
            return;
        }

        candidateSessions.set(sessionId, sessionMessages);
    }

    /**
     * 修复终态摘要 session 后续仍有新消息的异常。
     * 修复会把超出消息迁移到新的未摘要 session，失败时中断本轮任务。
     */
    private async _repairAndLogClosedSessionOverruns(): Promise<void> {
        try {
            const repairResults = await this.agcDbAccessService.repairClosedDigestSessionOverruns();

            for (const result of repairResults) {
                this.LOGGER.warning(
                    `已修复终态摘要 session 后续新消息: oldSessionId=${result.oldSessionId}, newSessionId=${result.newSessionId}, groupId=${result.groupId}, status=${result.status}, 摘要结束时间=${this._formatTimestamp(result.summarizedTimeEnd)}, 最新消息时间=${this._formatTimestamp(result.latestMessageTime)}, 修复消息数=${result.repairedMessageCount}`
                );
            }

            const remainingStats = await this.agcDbAccessService.getClosedDigestSessionOverrunStats();

            for (const stats of remainingStats) {
                this.LOGGER.error(
                    `修复后仍检测到终态摘要 session 后有新消息: sessionId=${stats.sessionId}, groupId=${stats.groupId}, status=${stats.status}, 摘要结束时间=${this._formatTimestamp(stats.summarizedTimeEnd)}, 最新消息时间=${this._formatTimestamp(stats.latestMessageTime)}, 超出消息数=${stats.overrunMessageCount}`
                );
            }
        } catch (error) {
            this.LOGGER.error(`修复终态摘要 session 追加消息失败: ${this._formatErrorMessage(error)}`);
            throw error;
        }
    }

    /**
     * 记录仍在摘要保护窗口内、会暂时阻止本轮重新摘要的 session。
     * @param groupIds 群组ID列表
     */
    private async _logActiveDigestSessionBlocks(groupIds: string[]): Promise<void> {
        const blockStats = await this.imDbAccessService.getActiveDigestSessionBlockStatsByGroupIds(groupIds);

        for (const stats of blockStats) {
            this.LOGGER.warning(
                `本轮未收集到摘要任务，但检测到 ${stats.sessionCount} 个 ${stats.status} session 仍在摘要保护窗口内，消息数=${stats.messageCount}，最早重试时间=${this._formatTimestamp(stats.earliestRetryTime)}`
            );
        }
    }

    /**
     * 格式化日志中的时间戳。
     * @param timestamp UNIX 毫秒时间戳
     * @returns 本地时间字符串
     */
    private _formatTimestamp(timestamp: number): string {
        return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
    }

    private _formatErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }
}
