import "reflect-metadata";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TextGeneratorService, registerReasoningContent } from "../services/generators/text/TextGeneratorService";

const { mockChatOpenAIConstructor, mockChatOpenAIStreamFactories, mockLogger } = vi.hoisted(() => ({
    mockChatOpenAIConstructor: vi.fn(),
    mockChatOpenAIStreamFactories: [] as Array<
        () => AsyncIterableIterator<any> | Promise<AsyncIterableIterator<any>>
    >,
    mockLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        success: vi.fn()
    }
}));

vi.mock("@langchain/openai", () => ({
    ChatOpenAI: class MockChatOpenAI {
        public constructor(options: unknown) {
            mockChatOpenAIConstructor(options);
        }

        public bindTools(): MockChatOpenAI {
            return this;
        }

        public async stream(): Promise<AsyncIterableIterator<any>> {
            const factory = mockChatOpenAIStreamFactories.shift();

            if (!factory) {
                return (async function* () {})();
            }

            return factory();
        }
    }
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
    let tempLogDir: string;
    const mockConfigManagerService = {
        getCurrentConfig: vi.fn()
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        mockChatOpenAIStreamFactories.length = 0;
        tempLogDir = await mkdtemp(join(tmpdir(), "text-generator-service-"));
        mockConfigManagerService.getCurrentConfig.mockResolvedValue({
            ai: {
                defaultModelNames: ["default-model"]
            },
            logger: {
                logDirectory: tempLogDir
            }
        });
        service = new TextGeneratorService(mockConfigManagerService as any);
        await service.init();
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await rm(tempLogDir, { recursive: true, force: true });
    });

    async function readJsonFailureRecords(): Promise<Array<Record<string, unknown>>> {
        const failureDir = join(tempLogDir, "ai-model-json-failures");

        try {
            const files = await readdir(failureDir);
            const records: Array<Record<string, unknown>> = [];

            for (const file of files.filter(item => item.endsWith(".jsonl"))) {
                const content = await readFile(join(failureDir, file), "utf8");
                const lines = content.split("\n").filter(line => line.trim().length > 0);

                for (const line of lines) {
                    records.push(JSON.parse(line) as Record<string, unknown>);
                }
            }

            return records;
        } catch {
            return [];
        }
    }

    const buildModelConfig = (reasoning: { enabled: boolean; effort: string }) => ({
        apiKey: "test-api-key",
        baseURL: "https://api.example.com/v1",
        temperature: 0.3,
        maxTokens: 1024,
        reasoning
    });

    const buildConfigWithDefaultModels = (modelNames: string[]) => ({
        ai: {
            models: Object.fromEntries(
                modelNames.map(modelName => [modelName, buildModelConfig({ enabled: false, effort: "minimal" })])
            ),
            defaultModelConfig: buildModelConfig({ enabled: false, effort: "minimal" }),
            defaultModelNames: modelNames
        },
        logger: {
            logDirectory: tempLogDir
        }
    });

    async function getReasoningAwareFetch(): Promise<typeof fetch> {
        mockConfigManagerService.getCurrentConfig.mockResolvedValueOnce({
            ai: {
                models: {
                    "deepseek-v4-pro": buildModelConfig({ enabled: false, effort: "minimal" })
                },
                defaultModelConfig: buildModelConfig({ enabled: false, effort: "minimal" }),
                defaultModelNames: ["deepseek-v4-pro"]
            },
            logger: {
                logDirectory: tempLogDir
            }
        });

        await service.getChatModel("deepseek-v4-pro");

        const options = mockChatOpenAIConstructor.mock.calls.at(-1)?.[0] as Record<string, any>;

        return options.configuration.fetch as typeof fetch;
    }

    it("模型未启用 reasoning 时不应透传 reasoning 参数", async () => {
        mockConfigManagerService.getCurrentConfig.mockResolvedValueOnce({
            ai: {
                models: {
                    "plain-model": buildModelConfig({ enabled: false, effort: "minimal" })
                },
                defaultModelConfig: buildModelConfig({ enabled: false, effort: "minimal" }),
                defaultModelNames: ["plain-model"]
            },
            logger: {
                logDirectory: tempLogDir
            }
        });

        await service.getChatModel("plain-model");

        const options = mockChatOpenAIConstructor.mock.calls[0][0] as Record<string, unknown>;

        expect(options).not.toHaveProperty("reasoning");
    });

    it("模型显式启用 reasoning 时应透传配置的 effort", async () => {
        mockConfigManagerService.getCurrentConfig.mockResolvedValueOnce({
            ai: {
                models: {
                    "reasoning-model": buildModelConfig({ enabled: true, effort: "low" })
                },
                defaultModelConfig: buildModelConfig({ enabled: false, effort: "minimal" }),
                defaultModelNames: ["reasoning-model"]
            },
            logger: {
                logDirectory: tempLogDir
            }
        });

        await service.getChatModel("reasoning-model");

        expect(mockChatOpenAIConstructor.mock.calls[0][0]).toMatchObject({
            reasoning: {
                effort: "low"
            }
        });
    });

    it("自定义fetch应为匹配的assistant工具消息注入reasoning_content", async () => {
        const realFetch = vi.fn().mockResolvedValue({ ok: true });

        vi.stubGlobal("fetch", realFetch);
        registerReasoningContent(
            {
                content: "",
                tool_calls: [
                    {
                        id: "inject-call-1",
                        name: "rag_search",
                        args: {
                            query: "清华群简介"
                        }
                    }
                ]
            },
            "thinking-content"
        );

        const reasoningAwareFetch = await getReasoningAwareFetch();

        await reasoningAwareFetch("https://api.example.com/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({
                messages: [
                    {
                        role: "assistant",
                        content: "",
                        tool_calls: [
                            {
                                id: "inject-call-1",
                                type: "function",
                                function: {
                                    name: "rag_search",
                                    arguments: '{"query":"清华群简介"}'
                                }
                            }
                        ]
                    },
                    {
                        role: "tool",
                        tool_call_id: "inject-call-1",
                        content: '{"ok":true}'
                    }
                ]
            })
        } as any);

        const sentBody = JSON.parse(realFetch.mock.calls[0][1].body);

        expect(sentBody.messages[0].reasoning_content).toBe("thinking-content");
    });

    it("自定义fetch应在assistant工具消息缺少reasoning_content时本地抛错", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
        const reasoningAwareFetch = await getReasoningAwareFetch();

        await expect(
            reasoningAwareFetch("https://api.example.com/v1/chat/completions", {
                method: "POST",
                body: JSON.stringify({
                    messages: [
                        {
                            role: "assistant",
                            content: "",
                            tool_calls: [
                                {
                                    id: "missing-reasoning-call-1",
                                    type: "function",
                                    function: {
                                        name: "rag_search",
                                        arguments: '{"query":"清华群简介"}'
                                    }
                                }
                            ]
                        },
                        {
                            role: "tool",
                            tool_call_id: "missing-reasoning-call-1",
                            content: '{"ok":true}'
                        }
                    ]
                })
            } as any)
        ).rejects.toThrow("缺少 reasoning_content");
    });

    it("自定义fetch应在assistant工具调用ID重复时本地抛错", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
        const reasoningAwareFetch = await getReasoningAwareFetch();

        await expect(
            reasoningAwareFetch("https://api.example.com/v1/chat/completions", {
                method: "POST",
                body: JSON.stringify({
                    messages: [
                        {
                            role: "assistant",
                            content: "",
                            reasoning_content: "thinking-content",
                            tool_calls: [
                                {
                                    id: "duplicate-fetch-call",
                                    type: "function",
                                    function: {
                                        name: "rag_search",
                                        arguments: '{"query":"清华群简介"}'
                                    }
                                },
                                {
                                    id: "duplicate-fetch-call",
                                    type: "function",
                                    function: {
                                        name: "sql_query",
                                        arguments: '{"query":"SELECT 1"}'
                                    }
                                }
                            ]
                        },
                        {
                            role: "tool",
                            tool_call_id: "duplicate-fetch-call",
                            content: '{"ok":true}'
                        }
                    ]
                })
            } as any)
        ).rejects.toThrow("tool_call_id 重复");
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

    it("候选模型不应混入默认模型列表", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream.mockResolvedValue('[{"ok":true}]');

        const result = await service.generateTextWithModelCandidates(["scoped-model"], "生成 JSON", true);

        expect(result.selectedModelName).toBe("scoped-model");
        expect(doGenerateTextStream).toHaveBeenCalledWith("scoped-model", "生成 JSON");
        expect(doGenerateTextStream).not.toHaveBeenCalledWith("default-model", expect.any(String));
    });

    it("候选模型应按传入顺序去重后重复三轮", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream.mockRejectedValue(new Error("模型失败"));

        await expect(
            service.generateTextWithModelCandidates(
                ["first-model", "second-model", "first-model"],
                "生成 JSON",
                true
            )
        ).rejects.toThrow("所有模型都生成摘要失败");

        expect(doGenerateTextStream.mock.calls.map((call: unknown[]) => call[0])).toEqual([
            "first-model",
            "second-model",
            "first-model",
            "second-model",
            "first-model",
            "second-model"
        ]);
    });

    it("候选模型列表为空时应直接失败", async () => {
        await expect(service.generateTextWithModelCandidates([], "生成内容", false)).rejects.toThrow(
            "模型候选列表不能为空"
        );
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

    it("流式候选模型不应混入默认模型列表", async () => {
        const doStreamText = vi.spyOn(service as any, "doStreamText") as any;

        doStreamText.mockImplementationOnce(
            async (_modelName: string, _input: string, onChunk: (chunk: string) => void) => {
                onChunk("ok");

                return "ok";
            }
        );

        await service.generateTextStreamWithModelCandidates(["stream-model"], "生成内容", () => {});

        expect(doStreamText).toHaveBeenCalledWith("stream-model", "生成内容", expect.any(Function));
        expect(doStreamText).not.toHaveBeenCalledWith("default-model", expect.any(String), expect.any(Function));
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
        expect(repairLog!).toContain("阶段=repair_provider_rejection");
        expect(repairLog!).toContain('原始输出前200字符：[{"topic":"AI讨论","detail":"输出被截断"');
        expect(repairLog!).toContain(
            "修复输出前200字符：The request was rejected because it was considered high risk"
        );
        expect(repairLog!).toContain("完整失败样本：");
        expect(repairLog!).not.toContain("\n");
    });

    it("未转义双引号导致的 JSON 校验失败应保存完整原始输出", async () => {
        const rawOutput = '[{"topic":"报价讨论","detail":"他说 "可以接受""}]';
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce(rawOutput)
            .mockResolvedValueOnce('[{"topic":"报价讨论","detail":"他说 \\"可以接受\\""}]');

        const result = await service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true, {
            groupId: "group-1",
            sessionId: "session-1"
        });
        const records = await readJsonFailureRecords();

        expect(result.content).toBe('[{"topic":"报价讨论","detail":"他说 \\"可以接受\\""}]');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            modelName: "mock-model",
            stage: "raw_validation_failed",
            rawOutput,
            rawOutputLength: rawOutput.length,
            repairedOutput: "",
            repairedOutputLength: 0,
            selectedFallbackAction: "repair_json",
            groupId: "group-1",
            sessionId: "session-1"
        });
    });

    it("尾随逗号导致的 JSON 校验失败应保存完整原始输出", async () => {
        const rawOutput = '[{"topic":"尾随逗号","detail":"内容"},]';
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce(rawOutput)
            .mockResolvedValueOnce('[{"topic":"尾随逗号","detail":"内容"}]');

        await service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true);
        const records = await readJsonFailureRecords();

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            modelName: "mock-model",
            stage: "raw_validation_failed",
            rawOutput,
            rawOutputLength: rawOutput.length,
            selectedFallbackAction: "repair_json"
        });
    });

    it("残缺代码围栏和修复阶段风控拒绝都应保存 JSONL 样本", async () => {
        const rawOutput = '```json\n[{"topic":"围栏残缺","detail":"内容"}]';
        const repairedOutput = "The request was rejected because it was considered high risk";
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce(rawOutput)
            .mockResolvedValueOnce(repairedOutput)
            .mockResolvedValueOnce('[{"topic":"ok"}]');

        const result = await service.generateTextWithModelCandidates(
            ["bad-model", "good-model"],
            "生成 JSON",
            true
        );
        const records = await readJsonFailureRecords();

        expect(result).toEqual({
            selectedModelName: "good-model",
            content: '[{"topic":"ok"}]'
        });
        expect(records.map(record => record.stage)).toEqual([
            "raw_validation_failed",
            "repair_provider_rejection"
        ]);
        expect(records[0]).toMatchObject({
            modelName: "bad-model",
            rawOutput,
            rawOutputLength: rawOutput.length,
            repairedOutput: "",
            selectedFallbackAction: "repair_json"
        });
        expect(records[1]).toMatchObject({
            modelName: "bad-model",
            rawOutput,
            rawOutputLength: rawOutput.length,
            repairedOutput,
            repairedOutputLength: repairedOutput.length,
            selectedFallbackAction: "switch_model"
        });
    });

    it("JSON 失败日志应包含阶段、长度、保存路径且预览不含真实换行", async () => {
        const rawOutput = '[{"topic":"AI讨论",\n"detail":"输出被截断"';
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream
            .mockResolvedValueOnce(rawOutput)
            .mockResolvedValueOnce('[{"topic":"AI讨论",\n"detail":"仍然失败"')
            .mockResolvedValueOnce('[{"topic":"ok"}]');

        await service.generateTextWithModelCandidates(["bad-model", "good-model"], "生成 JSON", true);

        const repairLog = mockLogger.warning.mock.calls
            .map(call => String(call[0]))
            .find(message => message.includes("阶段=repair_validation_failed"));

        expect(repairLog).toBeDefined();
        expect(repairLog!).toContain(`原始输出长度=${rawOutput.length}`);
        expect(repairLog!).toContain("修复输出长度=");
        expect(repairLog!).toContain("完整失败样本：");
        expect(repairLog!).toContain("ai-model-json-failures");
        expect(repairLog!).not.toContain("\n");
        expect(repairLog!).toContain("\\n");
    });

    it("失败样本落盘失败不应中断模型 fallback", async () => {
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        vi.spyOn(service as any, "_saveJsonFailureRecord").mockResolvedValue(null);
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
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("完整失败样本：保存失败"));
    });

    it("合法 JSON 数组后追加上游拒绝文本时应安全截断尾部", async () => {
        const jsonPrefix = '[{"topic":"ok","contributors":[],"detail":"内容"}]';
        const rawOutput = `${jsonPrefix}The request was rejected because it was considered high risk`;
        const doGenerateTextStream = vi.spyOn(service as any, "doGenerateTextStream") as any;

        doGenerateTextStream.mockResolvedValueOnce(rawOutput);

        const result = await service.generateTextWithModelCandidates(["mock-model"], "生成 JSON", true, {
            groupId: "group-1",
            sessionId: "session-1"
        });
        const records = await readJsonFailureRecords();

        expect(result).toEqual({
            selectedModelName: "mock-model",
            content: jsonPrefix
        });
        expect(doGenerateTextStream).toHaveBeenCalledTimes(1);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            modelName: "mock-model",
            stage: "raw_json_with_provider_rejection_suffix",
            rawOutput,
            rawOutputLength: rawOutput.length,
            repairedOutput: "",
            repairedOutputLength: 0,
            selectedFallbackAction: "accept_json_prefix",
            groupId: "group-1",
            sessionId: "session-1"
        });
        expect(mockLogger.warning).toHaveBeenCalledWith(
            expect.stringContaining("已截断上游拒绝文本尾部并使用合法 JSON 前缀")
        );
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

    it("Agent 默认模型应在首个输出前失败时尝试下一个默认候选", async () => {
        mockConfigManagerService.getCurrentConfig.mockResolvedValueOnce(
            buildConfigWithDefaultModels(["bad-agent-model", "good-agent-model"])
        );
        mockChatOpenAIStreamFactories.push(
            () =>
                (async function* () {
                    throw new Error("建流失败");
                })(),
            () =>
                (async function* () {
                    yield { content: "ok" };
                })()
        );
        const constructorCallStart = mockChatOpenAIConstructor.mock.calls.length;

        const stream = await service.streamWithMessages(undefined, [] as any[]);
        const chunks: any[] = [];

        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual([{ content: "ok" }]);
        expect(
            mockChatOpenAIConstructor.mock.calls
                .slice(constructorCallStart)
                .map(call => (call[0] as Record<string, unknown>).model)
        ).toEqual(["bad-agent-model", "good-agent-model"]);
        expect(mockLogger.warning).toHaveBeenCalledWith(
            expect.stringContaining("Agent 模型 bad-agent-model 建流失败")
        );
    });

    it("Agent 默认模型在已经输出后失败时不应切换候选模型", async () => {
        mockConfigManagerService.getCurrentConfig.mockResolvedValueOnce(
            buildConfigWithDefaultModels(["first-agent-model", "second-agent-model"])
        );
        mockChatOpenAIStreamFactories.push(
            () =>
                (async function* () {
                    yield { content: "partial" };
                    throw new Error("输出后失败");
                })(),
            () =>
                (async function* () {
                    yield { content: "should-not-run" };
                })()
        );
        const constructorCallStart = mockChatOpenAIConstructor.mock.calls.length;

        const stream = await service.streamWithMessages(undefined, [] as any[]);
        const chunks: any[] = [];

        await expect(
            (async () => {
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
            })()
        ).rejects.toThrow("输出后失败");

        expect(chunks).toEqual([{ content: "partial" }]);
        expect(
            mockChatOpenAIConstructor.mock.calls
                .slice(constructorCallStart)
                .map(call => (call[0] as Record<string, unknown>).model)
        ).toEqual(["first-agent-model"]);
    });
});
