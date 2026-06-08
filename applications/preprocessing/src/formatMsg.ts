import { ChatMessageMedia, RawChatMessage } from "@root/common/contracts/data-provider";

// 优先使用quotedMsg；如果没有quotedMsg，使用quotedMsgContent；如果都没有，则不引用
export function formatMsg(
    msg: RawChatMessage,
    quotedMsg?: RawChatMessage,
    quotedMsgContent?: string,
    mediaItems: ChatMessageMedia[] = [],
    quotedMediaItems: ChatMessageMedia[] = []
): string {
    // 格式类似"'杨浩然(群昵称：ユリの花)'：【引用来自'李嘉浩(群昵称：DEAR James·Jordan ≈)'的消息: 今年offer发了多少】@DEAR James·Jordan ≈ 我觉得今年会超发offer"
    const nickname = msg.senderGroupNickname || msg.senderNickname;
    const content = renderMessageContent(msg, mediaItems);

    if (quotedMsg) {
        const quotedNickname = quotedMsg.senderGroupNickname || quotedMsg.senderNickname;
        const quotedContent = renderMessageContent(quotedMsg, quotedMediaItems);

        return `("${nickname}"):【这条消息引用了来自"${quotedNickname}"的消息: ${quotedContent}】 ${content}`;
    } else if (quotedMsgContent) {
        return `("${nickname}"):【这条消息引用了其他人的消息: ${quotedMsgContent}】 ${content}`;
    } else {
        return `("${nickname}"): ${content}`;
    }
}

function renderMessageContent(msg: RawChatMessage, mediaItems: ChatMessageMedia[]): string {
    const mediaText = mediaItems.map(renderMediaUnderstanding).filter(Boolean).join("");

    return `${msg.messageContent}${mediaText}`;
}

function renderMediaUnderstanding(media: ChatMessageMedia): string {
    if (media.status !== "success") {
        return "";
    }

    const parts: string[] = ["图片"];

    if (media.imageCategory) {
        parts.push(media.imageCategory);
    }

    const ocrText = normalizeInlineText(media.ocrText || media.qqImageText);

    if (ocrText) {
        parts.push(`OCR：${truncateText(ocrText, 240)}`);
    }

    const visionDescription = normalizeInlineText(media.visionDescription);

    if (visionDescription) {
        parts.push(`描述：${truncateText(visionDescription, 240)}`);
    }

    const understandingText = normalizeInlineText(media.understandingText);

    if (understandingText) {
        parts.push(`理解：${truncateText(understandingText, 320)}`);
    }

    if (parts.length === 1) {
        return "";
    }

    return `[${parts.join("；")}]`;
}

function normalizeInlineText(value: string | null | undefined): string {
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

function truncateText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}...`;
}
