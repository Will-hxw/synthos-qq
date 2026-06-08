export type ChatMessageMediaStatus = "pending" | "success" | "failed" | "skipped";

export interface RawChatMessageMedia {
    mediaId: string;
    msgId: string;
    groupId: string;
    timestamp: number;
    elementIndex: number;
    mediaType: "image";
    sourceProvider: "QQ";
    sourceUrl?: string;
    width?: number;
    height?: number;
    picType?: number;
    originImageMd5?: string;
    qqImageText?: string;
}

export interface ChatMessageMedia extends RawChatMessageMedia {
    sourceUrl: string | null;
    width: number | null;
    height: number | null;
    picType: number | null;
    originImageMd5: string | null;
    qqImageText: string | null;
    ocrText: string | null;
    visionDescription: string | null;
    imageCategory: string | null;
    understandingText: string | null;
    status: ChatMessageMediaStatus;
    retryCount: number;
    failReason: string | null;
    ocrEngine: number | null;
    modelName: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface RawChatMessage {
    msgId: string;
    messageContent: string;
    groupId: string;
    timestamp: number; // 消息发送时间戳, 单位: 毫秒
    senderId: string; // 消息发送者id
    senderGroupNickname: string; // 消息发送者的群昵称
    senderNickname: string; // 消息发送者的昵称
    quotedMsgId?: string; // 引用的消息id
    quotedMsgContent?: string; // 引用的消息内容
    mediaItems?: RawChatMessageMedia[];
}

export interface ProcessedChatMessage {
    msgId: string;
    sessionId: string; // 消息所属会话id
    // 格式类似"'杨浩然(群昵称：ユリの花)'：【引用来自'李嘉浩(群昵称：DEAR James·Jordan ≈)'的消息: 今年offer发了多少】@DEAR James·Jordan ≈ 我觉得今年会超发offer"
    preProcessedContent?: string;
}

export type ProcessedChatMessageWithRawMessage = RawChatMessage & ProcessedChatMessage;

export { QQ_SOURCE_RECONCILE_STATUS_PREFIX } from "./QQSourceReconcileStatus";
export type { QQSourceReconcileCursorSnapshot, QQSourceReconcileStatus } from "./QQSourceReconcileStatus";

// IM类型
export enum IMTypes {
    QQ = "QQ",
    WeChat = "WeChat",
    Telegram = "Telegram",
    Discord = "Discord"
}
