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
});
