import { describe, expect, it } from "vitest";
import { ChatMessageMedia, RawChatMessage } from "@root/common/contracts/data-provider";

import { formatMsg } from "../formatMsg";

describe("formatMsg", () => {
    it("应将成功的图片理解文本拼入消息正文", () => {
        const result = formatMsg(createMessage("msg-1", "[图片，含图片链接]"), undefined, undefined, [
            createMedia("msg-1:0", "msg-1", {
                status: "success",
                imageCategory: "screenshot",
                ocrText: "报名截止时间 6 月 10 日 18:00",
                visionDescription: "一张活动通知截图。",
                understandingText: "图片通知报名截止时间为 6 月 10 日 18:00。"
            })
        ]);

        expect(result).toContain("[图片，含图片链接]");
        expect(result).toContain(
            "[图片；screenshot；OCR：报名截止时间 6 月 10 日 18:00；描述：一张活动通知截图。；理解：图片通知报名截止时间为 6 月 10 日 18:00。]"
        );
    });

    it("失败或跳过的图片不应额外注入状态文本或 QQ 图片文字", () => {
        const result = formatMsg(createMessage("msg-1", "[图片，暂无文字描述]"), undefined, undefined, [
            createMedia("msg-1:0", "msg-1", {
                status: "failed",
                qqImageText: "不要把失败图片文字重复注入",
                failReason: "图片 URL 过期"
            }),
            createMedia("msg-1:1", "msg-1", {
                status: "skipped",
                qqImageText: "跳过文本"
            })
        ]);

        expect(result).toBe('("发送者"): [图片，暂无文字描述]');
    });

    it("被引用消息有成功图片理解结果时应拼入引用内容", () => {
        const result = formatMsg(
            createMessage("msg-2", "收到"),
            createMessage("msg-1", "[图片，含图片链接]"),
            undefined,
            [],
            [
                createMedia("msg-1:0", "msg-1", {
                    status: "success",
                    understandingText: "引用图片是一张课程安排截图。"
                })
            ]
        );

        expect(result).toBe(
            '("发送者"):【这条消息引用了来自"发送者"的消息: [图片，含图片链接][图片；理解：引用图片是一张课程安排截图。]】 收到'
        );
    });
});

function createMessage(msgId: string, messageContent: string): RawChatMessage {
    return {
        msgId,
        messageContent,
        groupId: "group-a",
        timestamp: 1000,
        senderId: "sender-a",
        senderGroupNickname: "发送者",
        senderNickname: "发送者"
    };
}

function createMedia(mediaId: string, msgId: string, overrides: Partial<ChatMessageMedia>): ChatMessageMedia {
    return {
        mediaId,
        msgId,
        groupId: "group-a",
        timestamp: 1000,
        elementIndex: 0,
        mediaType: "image",
        sourceProvider: "QQ",
        sourceUrl: "https://example.com/image.jpg",
        width: null,
        height: null,
        picType: null,
        originImageMd5: null,
        qqImageText: null,
        ocrText: null,
        visionDescription: null,
        imageCategory: null,
        understandingText: null,
        status: "pending",
        retryCount: 0,
        failReason: null,
        ocrEngine: null,
        modelName: null,
        createdAt: 1000,
        updatedAt: 1000,
        ...overrides
    };
}
