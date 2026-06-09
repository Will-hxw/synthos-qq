import { describe, expect, it } from "vitest";

import {
    GetChatMessagesByGroupIdSchema,
    GetMediaProcessingDiagnosisSchema,
    GetQQAvatarSchema
} from "../schemas/index";

describe("GetChatMessagesByGroupIdSchema", () => {
    it("应把字符串数字时间戳解析为 number", () => {
        const parsed = GetChatMessagesByGroupIdSchema.parse({
            groupId: "group-1",
            timeStart: "1000",
            timeEnd: "2000"
        });

        expect(parsed).toEqual({ groupId: "group-1", timeStart: 1000, timeEnd: 2000 });
    });

    it("非法时间戳应抛错而不是静默变成 NaN", () => {
        // 旧实现 z.string() 放行 + parseInt → NaN → SQL BETWEEN NaN 静默查空
        expect(() =>
            GetChatMessagesByGroupIdSchema.parse({
                groupId: "group-1",
                timeStart: "abc",
                timeEnd: "2000"
            })
        ).toThrow();
    });

    it("timeEnd 小于 timeStart 应抛错", () => {
        expect(() =>
            GetChatMessagesByGroupIdSchema.parse({
                groupId: "group-1",
                timeStart: "2000",
                timeEnd: "1000"
            })
        ).toThrow("timeEnd必须大于等于timeStart");
    });

    it("缺少时间参数应抛错", () => {
        expect(() => GetChatMessagesByGroupIdSchema.parse({ groupId: "group-1" })).toThrow();
    });
});

describe("GetQQAvatarSchema", () => {
    it("未指定头像类型时应保持用户头像默认值", () => {
        const parsed = GetQQAvatarSchema.parse({
            qqNumber: "123456"
        });

        expect(parsed).toEqual({ qqNumber: "123456", type: "user" });
    });

    it("应支持显式请求群头像", () => {
        const parsed = GetQQAvatarSchema.parse({
            qqNumber: "123456",
            type: "group"
        });

        expect(parsed).toEqual({ qqNumber: "123456", type: "group" });
    });
});

describe("GetMediaProcessingDiagnosisSchema", () => {
    it("应使用默认明细上限和默认媒体类型", () => {
        const parsed = GetMediaProcessingDiagnosisSchema.parse({
            timeStart: "1000",
            timeEnd: "2000"
        });

        expect(parsed).toEqual({
            groupId: undefined,
            timeStart: 1000,
            timeEnd: 2000,
            detailLimit: 50,
            mediaTypes: ["image", "audio"]
        });
    });

    it("应把空 groupId 当作未指定群组", () => {
        const parsed = GetMediaProcessingDiagnosisSchema.parse({
            groupId: "",
            timeStart: 1000,
            timeEnd: 2000,
            mediaTypes: ["audio"]
        });

        expect(parsed.groupId).toBeUndefined();
        expect(parsed.mediaTypes).toEqual(["audio"]);
    });

    it("detailLimit 超过上限时应抛错", () => {
        expect(() =>
            GetMediaProcessingDiagnosisSchema.parse({
                timeStart: 1000,
                timeEnd: 2000,
                detailLimit: 201
            })
        ).toThrow();
    });

    it("非法媒体类型应抛错", () => {
        expect(() =>
            GetMediaProcessingDiagnosisSchema.parse({
                timeStart: 1000,
                timeEnd: 2000,
                mediaTypes: ["video"]
            })
        ).toThrow();
    });

    it("timeEnd 小于 timeStart 应抛错", () => {
        expect(() =>
            GetMediaProcessingDiagnosisSchema.parse({
                timeStart: 2000,
                timeEnd: 1000
            })
        ).toThrow("timeEnd必须大于等于timeStart");
    });
});
