import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { COMMON_TOKENS } from "../di/tokens";
import { AgentDbAccessService } from "../services/database/AgentDbAccessService";

describe("AgentDbAccessService", () => {
    const mockCommonDBService = {
        init: vi.fn(),
        get: vi.fn(),
        all: vi.fn(),
        run: vi.fn()
    };

    beforeEach(() => {
        container.reset();
        vi.clearAllMocks();
        mockCommonDBService.init.mockResolvedValue(undefined);
        mockCommonDBService.get.mockResolvedValue(undefined);
        mockCommonDBService.all.mockResolvedValue([]);
        mockCommonDBService.run.mockResolvedValue(undefined);
        container.registerInstance(COMMON_TOKENS.CommonDBService, mockCommonDBService as any);
    });

    it("应将对话记录字段转换为前端契约格式", async () => {
        mockCommonDBService.all.mockResolvedValue([
            {
                id: "conversation-1",
                session_id: "session-1",
                title: "测试对话",
                created_at: 100,
                updated_at: 200
            }
        ]);
        const service = new AgentDbAccessService();

        await service.init();
        const result = await service.getConversationsPage(undefined, undefined, 20);

        expect(result).toEqual([
            {
                id: "conversation-1",
                sessionId: "session-1",
                title: "测试对话",
                createdAt: 100,
                updatedAt: 200
            }
        ]);
    });

    it("根据 id 查询对话时应转换数据库字段", async () => {
        mockCommonDBService.get.mockResolvedValue({
            id: "conversation-2",
            session_id: null,
            title: "单条对话",
            created_at: 300,
            updated_at: 400
        });
        const service = new AgentDbAccessService();

        await service.init();
        const result = await service.getConversationById("conversation-2");

        expect(result).toEqual({
            id: "conversation-2",
            sessionId: undefined,
            title: "单条对话",
            createdAt: 300,
            updatedAt: 400
        });
    });

    it("应将消息记录字段转换为前端契约格式并保持正序返回", async () => {
        mockCommonDBService.all.mockResolvedValue([
            {
                id: "message-2",
                conversation_id: "conversation-1",
                role: "assistant",
                content: "回答",
                timestamp: 2,
                tools_used: '["sql_query"]',
                tool_rounds: 1,
                token_usage: '{"totalTokens":1}'
            },
            {
                id: "message-1",
                conversation_id: "conversation-1",
                role: "user",
                content: "提问",
                timestamp: 1
            }
        ]);
        const service = new AgentDbAccessService();

        await service.init();
        const result = await service.getMessagesPage("conversation-1", undefined, 20);

        expect(result).toEqual([
            {
                id: "message-1",
                conversationId: "conversation-1",
                role: "user",
                content: "提问",
                timestamp: 1,
                toolsUsed: undefined,
                toolRounds: undefined,
                tokenUsage: undefined
            },
            {
                id: "message-2",
                conversationId: "conversation-1",
                role: "assistant",
                content: "回答",
                timestamp: 2,
                toolsUsed: '["sql_query"]',
                toolRounds: 1,
                tokenUsage: '{"totalTokens":1}'
            }
        ]);
    });
});
