import { beforeAll, describe, expect, it } from "vitest";

import { MiddlewareContainer, CTX_MIDDLEWARE_TOKENS } from "../context/middleware/container/container";
import { ReportPromptStore } from "../context/prompts/ReportPromptStore";

describe("ReportPromptStore", () => {
    beforeAll(() => {
        MiddlewareContainer.getInstance().register(CTX_MIDDLEWARE_TOKENS.ADD_BACKGROUND_KNOWLEDGE, node => node);
    });

    it("半日报 prompt 应使用知识文章骨架并偏事件追踪", async () => {
        const prompt = (
            await ReportPromptStore.getReportSummaryPrompt(
                "half-daily",
                "2026年6月9日上午",
                [
                    { topic: "话题一", detail: "包含链接和截止时间" },
                    { topic: "话题二", detail: "包含后续动作" }
                ],
                { topicCount: 2, mostActiveGroups: ["群组A"], mostActiveHour: 10 }
            )
        ).serializeToString();

        expect(prompt).toContain("# {为本期内容拟一个有判断力的标题}");
        expect(prompt).toContain("> **核心观点：**");
        expect(prompt).toContain("## 🧭 一、本期先读结论");
        expect(prompt).toContain("## ✅ 六、行动清单与风险提醒");
        expect(prompt).toContain("## 📌 七、本期结论");
        expect(prompt).toContain("## 📎 附录：话题清单与主题归档");
        expect(prompt).toContain("半日报偏快速情报简报");
        expect(prompt).toContain("优先按主题聚合话题");
        expect(prompt).toContain("严禁编造输入材料中没有的事实");
        expect(prompt).toContain("emoji 使用要克制");
        expect(prompt).toContain("1. 【话题一】");
        expect(prompt).toContain("2. 【话题二】");
        expect(prompt).not.toContain("每个话题至少用2-3个段落");
    });

    it("周报 prompt 应偏主题归纳并包含展望", async () => {
        const prompt = (
            await ReportPromptStore.getReportSummaryPrompt(
                "weekly",
                "2026年6月1日 - 2026年6月7日 周报",
                [{ topic: "周报话题", detail: "周报详情" }],
                { topicCount: 1, mostActiveGroups: ["群组A"], mostActiveHour: 20 }
            )
        ).serializeToString();

        expect(prompt).toContain("周报偏主题情报归纳");
        expect(prompt).toContain("# {为本周内容拟一个有判断力的 Newsletter 标题}");
        expect(prompt).toContain("## 🧩 三、主题优先级地图：按信息价值分层");
        expect(prompt).toContain("## 🔍 四、重点主题情报分析：信息差、观点、总结、判断、建议");
        expect(prompt).toContain("## 🔭 八、下周观察清单：要验证什么");
        expect(prompt).toContain("AI 建议、风险预警与机会判断");
        expect(prompt).toContain("不要把重点主题写成话题列表");
        expect(prompt).not.toContain("不要重复罗列所有话题");
    });

    it("月报 prompt 应偏趋势洞察并禁止编造环比数据", async () => {
        const prompt = (
            await ReportPromptStore.getReportSummaryPrompt(
                "monthly",
                "2026年6月1日 - 2026年6月30日 月报",
                [{ topic: "月报话题", detail: "月报详情" }],
                { topicCount: 1, mostActiveGroups: ["群组A"], mostActiveHour: 15 }
            )
        ).serializeToString();

        expect(prompt).toContain("月报偏月度情报复盘");
        expect(prompt).toContain("严禁将月报写成");
        expect(prompt).toContain("# {为本月内容拟一个具有月度复盘感和洞察力的标题}");
        expect(prompt).toContain("## 📈 五、趋势与模式识别");
        expect(prompt).toContain("## ✅ 七、AI 建议、风险与长期策略");
        expect(prompt).toContain("## 🔭 九、下月观察清单");
        expect(prompt).toContain("材料不足时不得编造对比数字");
        expect(prompt).toContain("根据话题数量和信息密度动态控制篇幅");
        expect(prompt).not.toContain("报告总字数不应少于1500字");
    });
});
