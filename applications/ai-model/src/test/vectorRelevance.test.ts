import { describe, expect, it } from "vitest";

import { l2DistanceToRelevance } from "../services/embedding/vectorRelevance";

describe("l2DistanceToRelevance", () => {
    it("距离为 0（完全相同）时相关性为 1", () => {
        expect(l2DistanceToRelevance(0)).toBe(1);
    });

    it("中等距离（d=1）应换算为 0.5 而非被错误压成 0", () => {
        // s = 1 - 1/2 = 0.5；旧实现 1 - d = 0 会丢失该信号
        expect(l2DistanceToRelevance(1)).toBeCloseTo(0.5, 6);
    });

    it("正交向量（d=√2，余弦相似度 0）相关性为 0", () => {
        expect(l2DistanceToRelevance(Math.SQRT2)).toBeCloseTo(0, 6);
    });

    it("最大距离（d=2，方向相反）裁剪到 0", () => {
        expect(l2DistanceToRelevance(2)).toBe(0);
    });

    it("距离单调递增时相关性单调递减", () => {
        const r0 = l2DistanceToRelevance(0.2);
        const r1 = l2DistanceToRelevance(0.8);
        const r2 = l2DistanceToRelevance(1.3);

        expect(r0).toBeGreaterThan(r1);
        expect(r1).toBeGreaterThan(r2);
    });

    it("缺失/非法距离返回 0", () => {
        expect(l2DistanceToRelevance(undefined)).toBe(0);
        expect(l2DistanceToRelevance(null)).toBe(0);
        expect(l2DistanceToRelevance(NaN)).toBe(0);
    });
});
