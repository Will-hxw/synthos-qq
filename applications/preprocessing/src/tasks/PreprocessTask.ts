import "reflect-metadata";
import { injectable, inject } from "tsyringe";
import { ImDbAccessService } from "@root/common/services/database/ImDbAccessService";
import Logger from "@root/common/util/Logger";
import { ProcessedChatMessage } from "@root/common/contracts/data-provider";
import { agendaInstance } from "@root/common/scheduler/agenda";
import { TaskHandlerTypes, TaskParameters } from "@root/common/scheduler/@types/Tasks";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";

import { formatMsg } from "../formatMsg";
import { ISplitter } from "../splitters/contracts/ISplitter";
import { COMMON_TOKENS } from "../di/tokens";
import { getAccumulativeSplitter, getTimeoutSplitter } from "../di/container";

/**
 * 预处理任务处理器
 * 负责对消息进行分割和预处理
 */
@injectable()
export class PreprocessTaskHandler {
    private LOGGER = Logger.withTag("🏭 PreprocessTask");

    /**
     * 构造函数
     * @param configManagerService 配置管理服务
     * @param imDbAccessService IM 数据库访问服务
     */
    public constructor(
        @inject(COMMON_TOKENS.ConfigManagerService) private configManagerService: ConfigManagerService,
        @inject(COMMON_TOKENS.ImDbAccessService) private imDbAccessService: ImDbAccessService
    ) {}

    /**
     * 注册任务到 Agenda 调度器
     */
    public async register(): Promise<void> {
        let config = await this.configManagerService.getCurrentConfig();

        await agendaInstance
            .create(TaskHandlerTypes.Preprocess)
            .unique({ name: TaskHandlerTypes.Preprocess }, { insertOnly: true })
            .save();

        agendaInstance.define<TaskParameters<TaskHandlerTypes.Preprocess>>(
            TaskHandlerTypes.Preprocess,
            async job => {
                this.LOGGER.info(`😋开始处理任务: ${job.attrs.name}`);
                const attrs = job.attrs.data;

                config = await this.configManagerService.getCurrentConfig(); // 刷新配置

                for (const groupId of attrs.groupIds) {
                    // 从 DI 容器获取对应的分割器
                    let splitter: ISplitter;

                    switch (config.groupConfigs[groupId]?.splitStrategy) {
                        case "accumulative": {
                            splitter = getAccumulativeSplitter();
                            break;
                        }
                        case "realtime": {
                            splitter = getTimeoutSplitter();
                            break;
                        }
                        default: {
                            this.LOGGER.warning(
                                `未知的分割策略: ${config.groupConfigs[groupId]?.splitStrategy}，使用accumulative策略兜底`
                            );
                            splitter = getAccumulativeSplitter();
                            break;
                        }
                    }

                    // 开始消息分割，分配sessionId
                    await splitter.init();
                    try {
                        const currentCount = await this._preprocessRange(
                            splitter,
                            groupId,
                            attrs.startTimeStamp,
                            attrs.endTimeStamp
                        );

                        this.LOGGER.success(`为群${groupId}分配了${currentCount}条消息`);

                        const backfillRange =
                            await this.imDbAccessService.getEarliestUnprocessedMessageTimeRangeByGroupId(
                                groupId,
                                config.preprocessors.historicalBackfill.messageLimit
                            );

                        if (backfillRange) {
                            const backfillCount = await this._preprocessRange(
                                splitter,
                                groupId,
                                backfillRange.timeStart,
                                backfillRange.timeEnd
                            );

                            this.LOGGER.success(
                                `为群${groupId}回填分配了${backfillCount}条历史消息，候选未处理消息数为${backfillRange.count}`
                            );
                        }
                    } finally {
                        await splitter.dispose();
                    }
                    await job.touch(); // 保活
                }

                this.LOGGER.success(`🥳任务完成: ${job.attrs.name}`);
            },
            {
                concurrency: 1,
                priority: "high"
            }
        );
    }

    /**
     * 对指定时间范围内的消息分配 sessionId 并写回预处理内容。
     * @param splitter 消息分割器
     * @param groupId 群组ID
     * @param startTimeStamp 起始时间戳
     * @param endTimeStamp 结束时间戳
     * @returns 本次写回的消息数量
     */
    private async _preprocessRange(
        splitter: ISplitter,
        groupId: string,
        startTimeStamp: number,
        endTimeStamp: number
    ): Promise<number> {
        const assignedMessages = await splitter.assignSessionId(groupId, startTimeStamp, endTimeStamp);
        const quotedMessages = new Map<
            string,
            Awaited<ReturnType<ImDbAccessService["getRawChatMessageByMsgId"]>>
        >();

        await Promise.all(
            assignedMessages.map(async message => {
                if (!message.quotedMsgId || quotedMessages.has(message.quotedMsgId)) {
                    return;
                }

                quotedMessages.set(
                    message.quotedMsgId,
                    await this.imDbAccessService.getRawChatMessageByMsgId(message.quotedMsgId)
                );
            })
        );

        const mediaMsgIds = [
            ...assignedMessages.map(message => message.msgId),
            ...Array.from(quotedMessages.values()).map(message => message.msgId)
        ];
        const mediaMap = await this.imDbAccessService.getChatMessageMediaByMsgIds(mediaMsgIds);
        const results = assignedMessages.map<ProcessedChatMessage>(result => {
            const quotedMsg = result.quotedMsgId ? quotedMessages.get(result.quotedMsgId) : undefined;

            return {
                sessionId: result.sessionId!,
                msgId: result.msgId,
                preProcessedContent: formatMsg(
                    result,
                    quotedMsg,
                    result.quotedMsgContent,
                    mediaMap.get(result.msgId) || [],
                    quotedMsg ? mediaMap.get(quotedMsg.msgId) || [] : []
                )
            };
        });

        await this.imDbAccessService.storeProcessedChatMessages(results);

        return results.length;
    }
}
