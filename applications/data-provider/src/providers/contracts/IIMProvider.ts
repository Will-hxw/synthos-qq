import type { QQSourceMessageCursor, QQSourceMessagePage } from "../QQProvider/contracts/QQSourceMessagePage";

import { RawChatMessage } from "@root/common/contracts/data-provider";
import { Disposable } from "@root/common/util/lifecycle/Disposable";

export interface IIMProvider extends Disposable {
    init(): Promise<void>;
    getMsgByTimeRange(timeStart: number, timeEnd: number, groupId?: string): Promise<RawChatMessage[]>;
}

export interface IQQSourceReconcileProvider extends IIMProvider {
    readonly sourceReconcileProviderType: "QQ";
    getBusinessMsgIdPageAfterCursor(
        groupId: string,
        cursor: QQSourceMessageCursor | null,
        limit: number
    ): Promise<QQSourceMessagePage>;
    getMsgsByMsgIds(msgIds: string[], groupId?: string): Promise<RawChatMessage[]>;
}
