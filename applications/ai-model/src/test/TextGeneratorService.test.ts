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
        vi.spyOn(service as any, "doGenerateTextStream").mockResolvedValue('```json\n{"ok":true}\n```');

        const result = await service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true);

        expect(result).toEqual({
            selectedModelName: "mock-model",
            content: '{"ok":true}'
        });
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
            .mockResolvedValueOnce('{"ok":true}');

        const result = await service.generateTextWithModelCandidates(
            ["bad-model", "good-model"],
            "生成 JSON",
            true
        );

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: '{"ok":true}'
        });
    });

    it("候选模型单次失败应记录 warning 而不是 error", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream.mockResolvedValueOnce("").mockResolvedValueOnce('{"ok":true}');

        const result = await service.generateTextWithModelCandidates(
            ["bad-model", "good-model"],
            "生成 JSON",
            true
        );

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: '{"ok":true}'
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
});
