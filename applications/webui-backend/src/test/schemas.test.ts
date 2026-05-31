import { describe, expect, it } from "vitest";

import { GetChatMessagesByGroupIdSchema } from "../schemas/index";

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
