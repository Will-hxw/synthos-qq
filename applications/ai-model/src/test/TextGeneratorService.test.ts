import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { TextGeneratorService } from "../services/generators/text/TextGeneratorService";

const { mockLogger } = vi.hoisted(() => ({
    mockLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        success: vi.fn()
    }
}));

vi.mock("@langchain/openai", () => ({
    ChatOpenAI: class MockChatOpenAI {}
}));

vi.mock("@root/common/util/Logger", () => ({
    default: {
        withTag: () => mockLogger
    }
}));

vi.mock("@root/common/util/promisify/sleep", () => ({
    sleep: vi.fn().mockResolvedValue(undefined)
}));

describe("TextGeneratorService", () => {
    let service: TextGeneratorService;
    const mockConfigManagerService = {
        getCurrentConfig: vi.fn()
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            ai: {
                pinnedModels: []
            }
        });
        service = new TextGeneratorService(mockConfigManagerService as any);
        await service.init();
    });

    it("JSON 校验场景应剥离完整包裹的 JSON 代码围栏", async () => {
        vi.spyOn(service as any, "doGenerateTextStream").mockResolvedValue('```json\n[{"ok":true}]\n```');

        const result = await service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true);

        expect(result).toEqual({
            selectedModelName: "mock-model",
            content: '[{"ok":true}]'
        });
    });

    it("JSON 校验场景应接受合法空数组", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream.mockResolvedValue("[]");

        const result = await service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true);

        expect(result).toEqual({
            selectedModelName: "mock-model",
            content: "[]"
        });
        expect(doGenerateTextStream).toHaveBeenCalledTimes(1);
        expect(mockLogger.warning).not.toHaveBeenCalledWith(expect.stringContaining("尝试修复 JSON"));
    });

    it("JSON 校验场景下合法但非数组的对象应触发修复（{} / {error}）", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        // 第一次返回合法 JSON 对象（旧实现会误判通过），修复后返回期望的数组
        doGenerateTextStream
            .mockResolvedValueOnce('{"error":"无法生成"}')
            .mockResolvedValueOnce('[{"topic":"话题","detail":"内容"}]');

        const result = await service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true);

        expect(result).toEqual({
            selectedModelName: "mock-model",
            content: '[{"topic":"话题","detail":"内容"}]'
        });
        // 第二次调用是修复请求，证明对象未被直接当作合法结果
        expect(doGenerateTextStream).toHaveBeenCalledTimes(2);
    });

    it("JSON 校验场景下 null / 字符串等非数组 JSON 应被判为非法", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        // null 是合法 JSON 但非数组，修复仍返回 null → 换下一个模型，最终全失败
        doGenerateTextStream.mockResolvedValue("null");

        await expect(service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true)).rejects.toThrow(
            "所有模型都生成摘要失败"
        );
    });

    it("非 JSON 场景应保留回答中的代码块", async () => {
        const fencedContent = '```ts\nconsole.log("ok");\n```';

        vi.spyOn(service as any, "doGenerateTextStream").mockResolvedValue(fencedContent);

        const result = await service.generateTextWithModelCandidates(["mock-model"], "生成代码", false);

        expect(result).toEqual({
            selectedModelName: "mock-model",
            content: fencedContent
        });
    });

    it("JSON 校验失败时不应返回最后一次非法响应", async () => {
        vi.spyOn(service as any, "doGenerateTextStream").mockResolvedValue("The request is not valid");

        await expect(service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true)).rejects.toThrow(
            "所有模型都生成摘要失败"
        );
    });

    it("JSON 校验失败后应继续尝试下一个模型候选", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce("The request is not valid")
            .mockResolvedValueOnce('[{"ok":true}]');

        const result = await service.generateTextWithModelCandidates(
            ["bad-model", "good-model"],
            "生成 JSON",
            true
        );

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: '[{"ok":true}]'
        });
    });

    it("候选模型单次失败应记录 warning 而不是 error", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream.mockResolvedValueOnce("").mockResolvedValueOnce('[{"ok":true}]');

        const result = await service.generateTextWithModelCandidates(
            ["bad-model", "good-model"],
            "生成 JSON",
            true
        );

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: '[{"ok":true}]'
        });
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining("模型 bad-model 生成摘要失败"));
        expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("流式候选模型单次失败应记录 warning 而不是 error", async () => {
        const doStreamText = vi.spyOn(service as any, "doStreamText") as any;
        const chunks: string[] = [];

        doStreamText
            .mockRejectedValueOnce(new Error("bad model"))
            .mockImplementationOnce(
                async (_modelName: string, _input: string, onChunk: (chunk: string) => void) => {
                    onChunk("ok");

                    return "ok";
                }
            );

        const result = await service.generateTextStreamWithModelCandidates(
            ["bad-model", "good-model"],
            "生成内容",
            chunk => chunks.push(chunk)
        );

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: "ok"
        });
        expect(chunks).toEqual(["ok"]);
        expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining("模型 bad-model 流式生成失败"));
        expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("JSON 校验失败后应先尝试修复看起来像 JSON 的响应", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce('[{"topic":"报价讨论","detail":"他说 "可以接受""}]')
            .mockResolvedValueOnce('[{"topic":"报价讨论","detail":"他说 \\"可以接受\\""}]');

        const result = await service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true);

        expect(result).toEqual({
            selectedModelName: "mock-model",
            content: '[{"topic":"报价讨论","detail":"他说 \\"可以接受\\""}]'
        });
        expect(doGenerateTextStream).toHaveBeenCalledTimes(2);
    });

    it("JSON 修复失败后应继续尝试下一个模型候选", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce('[{"topic":"报价讨论","detail":"他说 "可以接受""}]')
            .mockResolvedValueOnce('[{"topic":"报价讨论","detail":"他说 "可以接受""}]')
            .mockResolvedValueOnce('[{"topic":"报价讨论","detail":"他说 \\"可以接受\\""}]');

        const result = await service.generateTextWithModelCandidates(
            ["bad-model", "good-model"],
            "生成 JSON",
            true
        );

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: '[{"topic":"报价讨论","detail":"他说 \\"可以接受\\""}]'
        });
        expect(doGenerateTextStream).toHaveBeenCalledTimes(3);
    });

    it("JSON 修复失败日志应区分原始校验错误和修复错误", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce('[{"topic":"AI讨论","detail":"输出被截断"')
            .mockResolvedValueOnce("The request was rejected because it was considered high risk")
            .mockResolvedValueOnce('[{"topic":"ok"}]');

        const result = await service.generateTextWithModelCandidates(
            ["bad-model", "good-model"],
            "生成 JSON",
            true
        );

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: '[{"topic":"ok"}]'
        });

        const repairLog = mockLogger.warning.mock.calls
            .map(call => String(call[0]))
            .find(message => message.includes("JSON 修复失败"));

        expect(repairLog).toBeDefined();
        expect(repairLog!).toContain("原始校验错误为");
        expect(repairLog!).toContain("修复错误为：Error: JSON 修复请求被上游网关/风控拒绝");
        expect(repairLog!).toContain('原始输出前200字符：[{"topic":"AI讨论","detail":"输出被截断"');
        expect(repairLog!).toContain("修复输出前200字符：The request was rejected because it was considered high risk");
        expect(repairLog!).not.toContain("\n");
    });

    it("网关风控拒绝(high risk)应跳过 JSON 修复并直接换下一个模型", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce("The request was rejected because it was considered high risk")
            .mockResolvedValueOnce('[{"topic":"ok"}]');

        const result = await service.generateTextWithModelCandidates(
            ["bad-model", "good-model"],
            "生成 JSON",
            true
        );

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: '[{"topic":"ok"}]'
        });
        // 风控拒绝不应触发 JSON 修复（_repairJsonResult 内部也会调 doGenerateTextStream）
        expect(doGenerateTextStream).toHaveBeenCalledTimes(2);
    });

    it("网关风控拒绝应记 info 日志而非 warning", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce("The request was rejected because it was considered high risk")
            .mockResolvedValueOnce('[{"topic":"ok"}]');

        await service.generateTextWithModelCandidates(["bad-model", "good-model"], "生成 JSON", true);

        // 应有 info 日志记录风控拒绝
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("被上游网关/风控拒绝"));
    });

    it("非限流错误不应触发 sleep 退避", async () => {
        const { sleep } = await import("@root/common/util/promisify/sleep");
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockRejectedValueOnce(new Error("ALL_MODELS_FAILED"))
            .mockResolvedValueOnce('[{"topic":"ok"}]');

        await service.generateTextWithModelCandidates(["bad-model", "good-model"], "生成 JSON", true);

        // 非限流错误不应调用 sleep
        expect(sleep).not.toHaveBeenCalled();
    });

    it("速率限制(429)错误应触发 sleep 并重试同一模型", async () => {
        const { sleep } = await import("@root/common/util/promisify/sleep");
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockRejectedValueOnce(new Error("429 Too Many Requests"))
            .mockResolvedValueOnce('[{"topic":"ok"}]');

        const result = await service.generateTextWithModelCandidates(["limited-model"], "生成 JSON", true);

        expect(result).toEqual({
            selectedModelName: "limited-model",
            content: '[{"topic":"ok"}]'
        });
        // 限流错误应触发 sleep 退避
        expect(sleep).toHaveBeenCalled();
    });
});
