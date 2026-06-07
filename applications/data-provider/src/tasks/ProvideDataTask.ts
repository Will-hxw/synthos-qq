import "reflect-metadata";
import type { QQProvider, QQSourceMessageCursor, QQSourceMessagePage } from "../providers/QQProvider/QQProvider";

import * as path from "path";

import { injectable, inject } from "tsyringe";
import Logger from "@root/common/util/Logger";
import { ImDbAccessService } from "@root/common/services/database/ImDbAccessService";
import { agendaInstance } from "@root/common/scheduler/agenda";
import { TaskHandlerTypes, TaskParameters } from "@root/common/scheduler/@types/Tasks";
import {
    IMTypes,
    QQ_SOURCE_RECONCILE_STATUS_PREFIX,
    QQSourceReconcileStatus,
    RawChatMessage
} from "@root/common/contracts/data-provider/index";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";
import { KVStore } from "@root/common/util/KVStore";

import { IIMProvider } from "../providers/contracts/IIMProvider";
import { COMMON_TOKENS } from "../di/tokens";
import { getQQProvider } from "../di/container";

const QQ_SOURCE_RECONCILE_CURSOR_PREFIX = "qq-source-reconcile";

type QQSourceReconcileStoreValue = QQSourceMessageCursor | QQSourceReconcileStatus;

/**
 * 数据提供任务处理器
 * 负责从各种 IM 平台获取消息并存储到数据库
 */
@injectable()
export class ProvideDataTaskHandler {
    private LOGGER = Logger.withTag("🌏 ProvideDataTask");

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
        await agendaInstance
            .create(TaskHandlerTypes.ProvideData)
            .unique({ name: TaskHandlerTypes.ProvideData }, { insertOnly: true })
            .save();

        agendaInstance.define<TaskParameters<TaskHandlerTypes.ProvideData>>(
            TaskHandlerTypes.ProvideData,
            async job => {
                this.LOGGER.info(`😋开始处理任务: ${job.attrs.name}`);
                const attrs = job.attrs.data;

                // 根据 IM 类型从 DI 容器获取对应的 IM 提供者
                let activeProvider: IIMProvider;

                switch (attrs.IMType) {
                    case IMTypes.QQ: {
                        activeProvider = getQQProvider();
                        break;
                    }
                    default: {
                        this.LOGGER.error(`Unknown IM type: ${attrs.IMType}`);
                        job.fail("Unknown IM type");

                        return;
                    }
                }

                let qqSourceCursorStore: KVStore<QQSourceReconcileStoreValue> | null = null;
                let qqSourceReconcileBatchSize: number | null = null;

                try {
                    await activeProvider.init();
                    this.LOGGER.info(`IM provider initialized for ${attrs.IMType}`);

                    if (this._isQQSourceReconcileProvider(activeProvider)) {
                        const config = await this.configManagerService.getCurrentConfig();

                        qqSourceCursorStore = new KVStore<QQSourceReconcileStoreValue>(
                            path.join(config.webUI_Backend.kvStoreBasePath, "data-provider", "qq-source-reconcile")
                        );
                        qqSourceReconcileBatchSize = config.dataProviders.QQ.sourceReconcile.batchSize;
                    }

                    for (const groupId of attrs.groupIds) {
                        this.LOGGER.debug(`开始获取群 ${groupId} 的消息`);

                        let results: RawChatMessage[] = [];

                        if (attrs.startTimeStamp < 0) {
                            const newestMsg =
                                await this.imDbAccessService.getNewestRawChatMessageByGroupId(groupId);
                            const startTimeStamp = newestMsg ? newestMsg.timestamp - 1000 : 0; // 如果数据库中没有消息，则从时间戳0开始获取

                            results = await activeProvider.getMsgByTimeRange(
                                startTimeStamp,
                                attrs.endTimeStamp,
                                groupId
                            );
                        } else {
                            results = await activeProvider.getMsgByTimeRange(
                                attrs.startTimeStamp,
                                attrs.endTimeStamp,
                                groupId
                            );
                        }

                        this.LOGGER.success(`群 ${groupId} 成功获取到 ${results.length} 条有效消息`);
                        await this.imDbAccessService.storeRawChatMessages(results);
                        if (
                            qqSourceCursorStore &&
                            qqSourceReconcileBatchSize !== null &&
                            this._isQQSourceReconcileProvider(activeProvider)
                        ) {
                            await this._reconcileQQSourceMessages(
                                activeProvider,
                                qqSourceCursorStore,
                                groupId,
                                qqSourceReconcileBatchSize
                            );
                        }
                        await job.touch(); // 保证任务存活
                    }
                } finally {
                    // 无论循环中途是否抛错，都必须释放 provider 打开的（加密）数据库连接，避免句柄泄漏
                    await activeProvider.dispose();
                    await qqSourceCursorStore?.dispose();
                }

                this.LOGGER.success(`🥳任务完成: ${job.attrs.name}`);
            },
            {
                concurrency: 1,
                priority: "high",
                lockLifetime: 10 * 60 * 1000 // 10分钟
            }
        );
    }

    private _isQQSourceReconcileProvider(provider: IIMProvider): provider is QQProvider {
        const candidate = provider as QQProvider;

        return (
            typeof candidate.getBusinessMsgIdPageAfterCursor === "function" &&
            typeof candidate.getMsgsByMsgIds === "function"
        );
    }

    private async _reconcileQQSourceMessages(
        provider: QQProvider,
        cursorStore: KVStore<QQSourceReconcileStoreValue>,
        groupId: string,
        batchSize: number
    ): Promise<number> {
        const cursorKey = `${QQ_SOURCE_RECONCILE_CURSOR_PREFIX}:${groupId}`;
        const cursor = ((await cursorStore.get(cursorKey)) as QQSourceMessageCursor | undefined) || null;
        const page = await provider.getBusinessMsgIdPageAfterCursor(groupId, cursor, batchSize);

        if (page.messages.length === 0) {
            await cursorStore.del(cursorKey);
            await this._storeQQSourceReconcileStatus(cursorStore, {
                groupId,
                cursor,
                nextCursor: null,
                scannedCount: 0,
                missingCount: 0,
                insertedCount: 0,
                reachedEnd: true,
                wrapped: false,
                batchSize,
                updatedAt: Date.now()
            });
            this.LOGGER.debug(`群 ${groupId} QQ 原库对账未扫描到业务消息。`);

            return 0;
        }

        const sourceMsgIds = page.messages.map(message => message.msgId);
        const existingMsgIds = await this.imDbAccessService.getExistingRawChatMessageIds(sourceMsgIds);
        const missingMsgIds = sourceMsgIds.filter(msgId => !existingMsgIds.has(msgId));
        const missingMessages = await provider.getMsgsByMsgIds(missingMsgIds, groupId);

        await this.imDbAccessService.storeRawChatMessages(missingMessages);
        await this._storeNextQQSourceCursor(cursorStore, cursorKey, page);
        await this._storeQQSourceReconcileStatus(cursorStore, {
            groupId,
            cursor,
            nextCursor: page.nextCursor,
            scannedCount: sourceMsgIds.length,
            missingCount: missingMsgIds.length,
            insertedCount: missingMessages.length,
            reachedEnd: page.reachedEnd,
            wrapped: page.wrapped,
            batchSize,
            updatedAt: Date.now()
        });
        this.LOGGER.info(
            `群 ${groupId} QQ 原库对账扫描 ${sourceMsgIds.length} 条，缺失 ${missingMsgIds.length} 条，补入 ${missingMessages.length} 条。`
        );

        return missingMessages.length;
    }

    private async _storeNextQQSourceCursor(
        cursorStore: KVStore<QQSourceReconcileStoreValue>,
        cursorKey: string,
        page: QQSourceMessagePage
    ): Promise<void> {
        if (page.reachedEnd || !page.nextCursor) {
            await cursorStore.del(cursorKey);

            return;
        }

        await cursorStore.put(cursorKey, page.nextCursor);
    }

    private async _storeQQSourceReconcileStatus(
        cursorStore: KVStore<QQSourceReconcileStoreValue>,
        status: QQSourceReconcileStatus
    ): Promise<void> {
        await cursorStore.put(`${QQ_SOURCE_RECONCILE_STATUS_PREFIX}:${status.groupId}`, status);
    }
}
