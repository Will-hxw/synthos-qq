import "reflect-metadata";

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import { LangGraphAgentExecutor } from "../agent-langgraph/LangGraphAgentExecutor";

vi.mock("@root/common/util/Logger", () => ({
    default: {
        withTag: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn()
        })
    }
}));

const createExecutor = (): LangGraphAgentExecutor => {
    return new LangGraphAgentExecutor({} as any, {} as any, {} as any);
};

const createExecutorWithChunks = (chunks: any[]): LangGraphAgentExecutor => {
    async function* streamWithMessages() {
        for (const chunk of chunks) {
            yield chunk;
        }
    }

    return new LangGraphAgentExecutor(
        {
            streamWithMessages: vi.fn().mockReturnValue(streamWithMessages())
        } as any,
        {} as any,
        {} as any
    );
};

describe("LangGraphAgentExecutor", () => {
    it("工具调用后应进入tools节点", () => {
        const executor = createExecutor();
        const nextNode = (executor as any)._getNextGraphNode({
            messages: [
                new AIMessage({
                    content: "",
                    tool_calls: [
                        {
                            id: "tool-call-1",
                            name: "sql_query",
                            args: {
                                query: "SELECT 1"
                            }
                        }
                    ]
                })
            ],
            runToolRounds: 0,
            maxToolRounds: 20
        });

        expect(nextNode).toBe("tools");
    });

    it("工具轮次达到上限时应进入maxRounds节点", () => {
        const executor = createExecutor();
        const nextNode = (executor as any)._getNextGraphNode({
            messages: [
                new AIMessage({
                    content: "",
                    tool_calls: [
                        {
                            id: "tool-call-1",
                            name: "sql_query",
                            args: {
                                query: "SELECT 1"
                            }
                        }
                    ]
                })
            ],
            runToolRounds: 20,
            maxToolRounds: 20
        });

        expect(nextNode).toBe("maxRounds");
    });

    it("工具schema应拒绝缺失或空白的必填query参数", () => {
        const executor = createExecutor();
        const schema = (executor as any)._createToolInputSchema({
            type: "function",
            function: {
                name: "sql_query",
                description: "SQL 查询工具",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string"
                        },
                        limit: {
                            type: "number"
                        }
                    },
                    required: ["query"]
                }
            }
        });

        expect(() => schema.parse({})).toThrow();
        expect(() => schema.parse({ query: "   " })).toThrow("query 不能为空");
        expect(schema.parse({ query: "SELECT 1", limit: 5 })).toEqual({
            query: "SELECT 1",
            limit: 5
        });
    });

    it("应合并同一个tool_call的流式增量参数", async () => {
        const executor = createExecutorWithChunks([
            {
                content: "",
                tool_calls: [
                    {
                        id: "tool-call-1",
                        name: "sql_query",
                        args: {}
                    }
                ]
            },
            {
                content: "",
                tool_calls: [
                    {
                        id: "tool-call-1",
                        name: "sql_query",
                        args: {
                            query: "SELECT 1"
                        }
                    }
                ]
            }
        ]);
        const onChunk = vi.fn();

        const result = await (executor as any)._callLLMStream({
            messages: [],
            tools: [],
            enabledTools: ["sql_query"],
            conversationId: "conversation-1",
            onChunk,
            temperature: undefined,
            maxTokens: undefined,
            abortSignal: undefined
        });

        expect(result.toolCalls).toEqual([
            {
                id: "tool-call-1",
                name: "sql_query",
                arguments: {
                    query: "SELECT 1"
                }
            }
        ]);
        expect(onChunk).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "tool_call",
                toolCallId: "tool-call-1",
                toolName: "sql_query",
                toolArgs: {
                    query: "SELECT 1"
                }
            })
        );
    });

    it("应合并tool_call_chunks中的分片参数", async () => {
        const executor = createExecutorWithChunks([
            {
                content: "",
                tool_calls: [
                    {
                        id: "tool-call-1",
                        name: "sql_query",
                        args: {}
                    }
                ],
                tool_call_chunks: [
                    {
                        id: "tool-call-1",
                        name: "sql_query",
                        args: "",
                        index: 0
                    }
                ]
            },
            {
                content: "",
                tool_call_chunks: [
                    {
                        id: "tool-call-1",
                        name: "sql_query",
                        args: '{"query":"SEL',
                        index: 0
                    }
                ]
            },
            {
                content: "",
                tool_call_chunks: [
                    {
                        id: "tool-call-1",
                        name: "sql_query",
                        args: 'ECT 1"}',
                        index: 0
                    }
                ]
            }
        ]);
        const onChunk = vi.fn();

        const result = await (executor as any)._callLLMStream({
            messages: [],
            tools: [],
            enabledTools: ["sql_query"],
            conversationId: "conversation-1",
            onChunk,
            temperature: undefined,
            maxTokens: undefined,
            abortSignal: undefined
        });

        expect(result.toolCalls).toEqual([
            {
                id: "tool-call-1",
                name: "sql_query",
                arguments: {
                    query: "SELECT 1"
                }
            }
        ]);
    });

    it("重复tool_call_id应全部保留并改写为唯一ID", async () => {
        const executor = createExecutorWithChunks([
            {
                content: "",
                tool_calls: [
                    {
                        id: "duplicated-call",
                        name: "rag_search",
                        args: {
                            query: "清华群简介"
                        },
                        index: 0
                    },
                    {
                        id: "duplicated-call",
                        name: "sql_query",
                        args: {
                            query: "清华群 简介"
                        },
                        index: 1
                    },
                    {
                        id: "duplicated-call",
                        name: "sql_query",
                        args: {
                            query: "SELECT COUNT(*) as count FROM chat_messages"
                        },
                        index: 2
                    }
                ]
            }
        ]);
        const onChunk = vi.fn();

        const result = await (executor as any)._callLLMStream({
            messages: [],
            tools: [],
            enabledTools: ["rag_search", "sql_query"],
            conversationId: "conversation-1",
            onChunk,
            temperature: undefined,
            maxTokens: undefined,
            abortSignal: undefined
        });

        expect(result.toolCalls).toEqual([
            {
                id: "duplicated-call",
                name: "rag_search",
                arguments: {
                    query: "清华群简介"
                }
            },
            {
                id: "duplicated-call__dup_1",
                name: "sql_query",
                arguments: {
                    query: "清华群 简介"
                }
            },
            {
                id: "duplicated-call__dup_2",
                name: "sql_query",
                arguments: {
                    query: "SELECT COUNT(*) as count FROM chat_messages"
                }
            }
        ]);
        expect(onChunk).toHaveBeenCalledTimes(3);
        expect(onChunk).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                type: "tool_call",
                toolCallId: "duplicated-call__dup_1",
                toolName: "sql_query"
            })
        );
        expect(onChunk).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                type: "tool_call",
                toolCallId: "duplicated-call__dup_2",
                toolName: "sql_query"
            })
        );
    });

    it("历史prompt中的重复AI工具调用和ToolMessage应按顺序成对改写", () => {
        const executor = createExecutor();
        const messages = [
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "old-call",
                        name: "rag_search",
                        args: {
                            query: "清华群简介"
                        }
                    },
                    {
                        id: "old-call",
                        name: "sql_query",
                        args: {
                            query: "SELECT COUNT(*) as count FROM chat_messages"
                        }
                    }
                ],
                additional_kwargs: {
                    reasoning_content: "历史thinking"
                }
            }),
            new ToolMessage({
                content: '{"ok":true}',
                tool_call_id: "old-call",
                name: "rag_search"
            }),
            new ToolMessage({
                content: '{"rowCount":1}',
                tool_call_id: "old-call",
                name: "sql_query"
            })
        ];

        const normalizedMessages = (executor as any)._normalizePromptMessages(messages);

        expect(normalizedMessages).toHaveLength(3);
        expect((normalizedMessages[0] as any).tool_calls.map((tc: any) => tc.id)).toEqual([
            "old-call",
            "old-call__dup_1"
        ]);
        expect((normalizedMessages[0] as any).additional_kwargs.reasoning_content).toBe("历史thinking");
        expect((normalizedMessages[1] as any).tool_call_id).toBe("old-call");
        expect((normalizedMessages[2] as any).tool_call_id).toBe("old-call__dup_1");
        expect(() => (executor as any)._validatePromptMessages(normalizedMessages)).not.toThrow();
    });

    it("应将默认模型选择交给 TextGeneratorService 处理", async () => {
        async function* streamWithMessages() {
            yield { content: "ok" };
        }

        const streamWithMessagesMock = vi.fn().mockReturnValue(streamWithMessages());
        const executor = new LangGraphAgentExecutor(
            {
                streamWithMessages: streamWithMessagesMock
            } as any,
            {} as any,
            {} as any
        );

        await (executor as any)._callLLMStream({
            messages: [],
            tools: [],
            enabledTools: [],
            conversationId: "conversation-1",
            onChunk: vi.fn(),
            temperature: undefined,
            maxTokens: undefined,
            abortSignal: undefined
        });

        expect(streamWithMessagesMock).toHaveBeenCalledWith(undefined, [], [], undefined, undefined, undefined);
    });
});
