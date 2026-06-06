import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
    mockLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock("@root/common/util/Logger", () => ({
    default: {
        withTag: () => mockLogger
    }
}));

vi.mock("../context/prompts/AgentPromptStore", () => ({
    AgentPromptStore: {
        getAgentSystemPrompt: vi.fn().mockResolvedValue({
            serializeToString: () => "系统提示词"
        })
    }
}));

import { RagRPCImpl } from "../rag/RagRPCImpl";

describe("RagRPCImpl", () => {
    it("Agent流式请求取消后不应写入assistant消息", async () => {
        const abortController = new AbortController();
        const onChunk = vi.fn();
        const agentDB = {
            createConversation: vi.fn().mockResolvedValue(undefined),
            getConversationById: vi.fn().mockResolvedValue({
                id: "conversation-1",
                sessionId: undefined,
                title: "测试问题",
                createdAt: 1,
                updatedAt: 1
            }),
            addMessage: vi.fn().mockResolvedValue(undefined),
            getMessagesByConversationId: vi.fn().mockResolvedValue([])
        };
        const agentExecutor = {
            executeStream: vi.fn().mockImplementation(async () => {
                abortController.abort();

                return {
                    content: "过期回答",
                    toolsUsed: [],
                    toolRounds: 1,
                    totalUsage: undefined
                };
            })
        };
        const agentToolCatalog = {
            getEnabledToolDefinitions: vi.fn().mockReturnValue([])
        };
        const rpcImpl = new RagRPCImpl(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            agentExecutor as any,
            agentDB as any,
            agentToolCatalog as any
        );

        await expect(
            rpcImpl.agentAsk(
                {
                    question: "测试问题",
                    conversationId: "conversation-1"
                },
                onChunk,
                {
                    abortSignal: abortController.signal
                }
            )
        ).rejects.toThrow("执行被用户中止");

        expect(agentDB.addMessage).toHaveBeenCalledTimes(1);
        expect(agentDB.addMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: "conversation-1",
                role: "user",
                content: "测试问题"
            })
        );
        expect(onChunk).not.toHaveBeenCalledWith(expect.objectContaining({ type: "done" }));
    });

    it("Agent流式请求传入新conversationId时应先创建会话元数据", async () => {
        const onChunk = vi.fn();
        const agentDB = {
            createConversation: vi.fn().mockResolvedValue(undefined),
            getConversationById: vi.fn().mockResolvedValue(null),
            addMessage: vi.fn().mockResolvedValue(undefined),
            getMessagesByConversationId: vi.fn().mockResolvedValue([])
        };
        const agentExecutor = {
            executeStream: vi.fn().mockResolvedValue({
                content: "回答",
                toolsUsed: [],
                toolRounds: 1,
                totalUsage: undefined
            })
        };
        const agentToolCatalog = {
            getEnabledToolDefinitions: vi.fn().mockReturnValue([])
        };
        const rpcImpl = new RagRPCImpl(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            agentExecutor as any,
            agentDB as any,
            agentToolCatalog as any
        );

        await rpcImpl.agentAsk(
            {
                question: "新的 Agent 问题",
                conversationId: "conversation-new",
                sessionId: "session-1"
            },
            onChunk
        );

        expect(agentDB.getConversationById).toHaveBeenCalledWith("conversation-new");
        expect(agentDB.createConversation).toHaveBeenCalledWith(
            "conversation-new",
            "新的 Agent 问题",
            "session-1"
        );
        expect(agentDB.addMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: "conversation-new",
                role: "user",
                content: "新的 Agent 问题"
            })
        );
        expect(agentDB.addMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: "conversation-new",
                role: "assistant",
                content: "回答"
            })
        );
        expect(onChunk).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "done",
                conversationId: "conversation-new",
                content: "回答"
            })
        );
    });

    it("Agent流式请求传入已有conversationId时不应重复创建会话", async () => {
        const onChunk = vi.fn();
        const agentDB = {
            createConversation: vi.fn().mockResolvedValue(undefined),
            getConversationById: vi.fn().mockResolvedValue({
                id: "conversation-existing",
                sessionId: "session-1",
                title: "已有会话",
                createdAt: 1,
                updatedAt: 1
            }),
            addMessage: vi.fn().mockResolvedValue(undefined),
            getMessagesByConversationId: vi.fn().mockResolvedValue([])
        };
        const agentExecutor = {
            executeStream: vi.fn().mockResolvedValue({
                content: "回答",
                toolsUsed: [],
                toolRounds: 1,
                totalUsage: undefined
            })
        };
        const agentToolCatalog = {
            getEnabledToolDefinitions: vi.fn().mockReturnValue([])
        };
        const rpcImpl = new RagRPCImpl(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            agentExecutor as any,
            agentDB as any,
            agentToolCatalog as any
        );

        await rpcImpl.agentAsk(
            {
                question: "继续追问",
                conversationId: "conversation-existing",
                sessionId: "session-1"
            },
            onChunk
        );

        expect(agentDB.getConversationById).toHaveBeenCalledWith("conversation-existing");
        expect(agentDB.createConversation).not.toHaveBeenCalled();
        expect(agentDB.addMessage).toHaveBeenCalledTimes(2);
    });

    it("Multi-Query 扩展失败时应降级为仅使用原始问题，不抛错中断", async () => {
        const rpcImpl = new RagRPCImpl(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any
        );

        const failingRewriter = {
            expandQuery: vi.fn().mockRejectedValue(new Error("Multi-Query 多次重试仍然失败"))
        };

        (rpcImpl as any).queryRewriter = failingRewriter;

        const queries = await (rpcImpl as any)._expandQueriesWithFallback("原始问题");

        expect(failingRewriter.expandQuery).toHaveBeenCalledWith("原始问题");
        expect(queries).toEqual(["原始问题"]);
    });

    it("Multi-Query 扩展成功时应返回扩展后的查询列表", async () => {
        const rpcImpl = new RagRPCImpl(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any
        );

        (rpcImpl as any).queryRewriter = {
            expandQuery: vi.fn().mockResolvedValue(["原始问题", "扩展1", "扩展2"])
        };

        const queries = await (rpcImpl as any)._expandQueriesWithFallback("原始问题");

        expect(queries).toEqual(["原始问题", "扩展1", "扩展2"]);
    });

    it("search 应批量获取话题摘要而非逐条查询", async () => {
        const embeddingService = {
            embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
        };
        const vectorDB = {
            searchSimilar: vi.fn().mockReturnValue([
                { topicId: "topic-1", distance: 0.1 },
                { topicId: "topic-2", distance: 0.2 },
                { topicId: "missing", distance: 0.3 }
            ])
        };
        const getAIDigestResultsByTopicIds = vi.fn().mockResolvedValue(
            new Map([
                ["topic-1", { topic: "话题1", detail: "详情1", contributors: "[]" }],
                ["topic-2", { topic: "话题2", detail: "详情2", contributors: "[]" }]
            ])
        );
        const agcDB = {
            getAIDigestResultsByTopicIds,
            getAIDigestResultByTopicId: vi.fn()
        };

        const rpcImpl = new RagRPCImpl(
            {} as any,
            vectorDB as any,
            agcDB as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            embeddingService as any,
            {} as any,
            {} as any,
            {} as any
        );

        const output = await rpcImpl.search({ query: "测试", limit: 10 });

        // 只调用一次批量查询，不再逐条 await
        expect(getAIDigestResultsByTopicIds).toHaveBeenCalledTimes(1);
        expect(getAIDigestResultsByTopicIds).toHaveBeenCalledWith(["topic-1", "topic-2", "missing"]);
        expect(agcDB.getAIDigestResultByTopicId).not.toHaveBeenCalled();
        // 无摘要的 topic 被过滤掉
        expect(output.map(r => r.topicId)).toEqual(["topic-1", "topic-2"]);
        expect(output[0]).toMatchObject({ topicId: "topic-1", topic: "话题1", distance: 0.1 });
    });

    it("ask 应按 L2 距离公式返回引用相关度", async () => {
        const embeddingService = {
            embed: vi.fn().mockResolvedValue(new Float32Array([1, 0]))
        };
        const vectorDB = {
            searchSimilar: vi.fn().mockReturnValue([
                { topicId: "topic-1", distance: 1 },
                { topicId: "topic-2", distance: Math.SQRT2 }
            ])
        };
        const agcDB = {
            getAIDigestResultsByTopicIds: vi.fn().mockResolvedValue(
                new Map([
                    ["topic-1", { topic: "话题1", detail: "详情1", contributors: "[]" }],
                    ["topic-2", { topic: "话题2", detail: "详情2", contributors: "[]" }]
                ])
            )
        };
        const textGeneratorService = {
            generateTextWithModelCandidates: vi.fn().mockResolvedValue({ content: "回答" })
        };
        const ragCtxBuilder = {
            buildCtx: vi.fn().mockResolvedValue("prompt")
        };
        const rpcImpl = new RagRPCImpl(
            {} as any,
            vectorDB as any,
            agcDB as any,
            {} as any,
            {} as any,
            textGeneratorService as any,
            ragCtxBuilder as any,
            embeddingService as any,
            {} as any,
            {} as any,
            {} as any
        );

        const output = await rpcImpl.ask({
            question: "测试问题",
            topK: 2,
            enableQueryRewriter: false
        });
        const references = output.references || [];

        expect(references).toHaveLength(2);
        expect(references[0]).toMatchObject({ topicId: "topic-1", topic: "话题1" });
        expect(references[0].relevance).toBeCloseTo(0.5, 6);
        expect(references[1]).toMatchObject({ topicId: "topic-2", topic: "话题2" });
        expect(references[1].relevance).toBeCloseTo(0, 6);
    });

    it("askStream 应按 L2 距离公式发送引用相关度", async () => {
        const embeddingService = {
            embed: vi.fn().mockResolvedValue(new Float32Array([1, 0]))
        };
        const vectorDB = {
            searchSimilar: vi.fn().mockReturnValue([
                { topicId: "topic-1", distance: 1 },
                { topicId: "topic-2", distance: Math.SQRT2 }
            ])
        };
        const agcDB = {
            getAIDigestResultsByTopicIds: vi.fn().mockResolvedValue(
                new Map([
                    ["topic-1", { topic: "话题1", detail: "详情1", contributors: "[]" }],
                    ["topic-2", { topic: "话题2", detail: "详情2", contributors: "[]" }]
                ])
            )
        };
        const textGeneratorService = {
            generateTextStreamWithModelCandidates: vi
                .fn()
                .mockImplementation(
                    async (_models: string[], _prompt: string, onToken: (chunk: string) => void) => {
                        onToken("回答");
                    }
                )
        };
        const ragCtxBuilder = {
            buildCtx: vi.fn().mockResolvedValue("prompt")
        };
        const rpcImpl = new RagRPCImpl(
            {} as any,
            vectorDB as any,
            agcDB as any,
            {} as any,
            {} as any,
            textGeneratorService as any,
            ragCtxBuilder as any,
            embeddingService as any,
            {} as any,
            {} as any,
            {} as any
        );
        const chunks: any[] = [];

        await rpcImpl.askStream(
            {
                question: "测试问题",
                topK: 2,
                enableQueryRewriter: false
            },
            chunk => chunks.push(chunk)
        );

        const referenceChunk = chunks.find(chunk => chunk.type === "references");

        expect(referenceChunk?.references).toHaveLength(2);
        expect(referenceChunk.references[0].relevance).toBeCloseTo(0.5, 6);
        expect(referenceChunk.references[1].relevance).toBeCloseTo(0, 6);
    });
});
