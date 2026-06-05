import { describe, expect, it } from "vitest";

import { l2DistanceToRelevance } from "../util/vectorRelevance";

describe("AI Chat 搜索结果相关度换算", () => {
    it("L2 距离为 0 时相关度为 1", () => {
        expect(l2DistanceToRelevance(0)).toBe(1);
    });

    it("L2 距离为 1 时相关度为 0.5", () => {
        expect(l2DistanceToRelevance(1)).toBeCloseTo(0.5, 6);
    });

    it("L2 距离为 √2 时相关度为 0", () => {
        expect(l2DistanceToRelevance(Math.SQRT2)).toBeCloseTo(0, 6);
    });

    it("L2 距离为 2 时相关度裁剪到 0", () => {
        expect(l2DistanceToRelevance(2)).toBe(0);
    });

    it("非法距离返回 0", () => {
        expect(l2DistanceToRelevance(NaN)).toBe(0);
    });
});
