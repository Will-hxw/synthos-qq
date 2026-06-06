/**
 * Agent 控制器
 * 处理 Agent 相关的 HTTP 请求
 */
import type { AgentEvent } from "@root/common/rpc/ai-model/schemas";

import { randomUUID } from "crypto";

import { Request, Response } from "express";
import { injectable, inject } from "tsyringe";

import { TOKENS } from "../di/tokens";
import { AgentService } from "../services/AgentService";
import {
    AgentAskRequestSchema,
    AgentAskStreamRequestSchema,
    AgentForkFromCheckpointRequestSchema,
    AgentGetConversationsSchema,
    AgentGetMessagesSchema,
    AgentGetStateHistoryRequestSchema
} from "../schemas/index";

@injectable()
export class AgentController {
    constructor(@inject(TOKENS.AgentService) private agentService: AgentService) {}

    /**
     * POST /api/agent/ask
     * Agent 问答
     */
    public async ask(req: Request, res: Response): Promise<void> {
        const params = AgentAskRequestSchema.parse(req.body);
        const result = await this.agentService.askAgent({
            question: params.question,
            conversationId: params.conversationId,
            sessionId: params.sessionId,
            enabledTools: params.enabledTools,
            maxToolRounds: params.maxToolRounds,
            temperature: params.temperature,
            maxTokens: params.maxTokens
        });

        res.json({ success: true, data: result });
    }

    /**
     * POST /api/agent/ask/stream
     * Agent 问答（SSE 流式事件）
     */
    public async askStream(req: Request, res: Response): Promise<void> {
        const params = AgentAskStreamRequestSchema.parse(req.body);

        const conversationId = params.conversationId || randomUUID();

        // 单实例并发拒绝：同 conversationId 不允许并行跑
        if (!this.agentService.tryAcquireConversationLock(conversationId)) {
            res.status(409);
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.write(
                `event: error\ndata: ${JSON.stringify({
                    type: "error",
                    ts: Date.now(),
                    conversationId,
                    code: "CONVERSATION_RUNNING",
                    error: "该对话正在运行中，请等待当前请求完成"
                })}\n\n`
            );
            res.end();

            return;
        }

        // SSE headers
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        // no-transform: 避免中间层对 event-stream 做压缩/转换
        res.setHeader("Cache-Control", "no-cache, no-transform");
        // HTTP/2 禁止 Connection 头；仅在 HTTP/1.x 下设置
        if (req.httpVersionMajor < 2) {
            res.setHeader("Connection", "keep-alive");
        }
        // nginx 等反代场景下禁用缓冲（开发环境也无害）
        res.setHeader("X-Accel-Buffering", "no");
        (res as any).flushHeaders?.();

        // 立即输出一个 comment，确保中间层尽快收到字节，避免首 token 慢导致超时
        res.write(`: connected ${Date.now()}\n\n`);

        let responseClosedEarly = false;

        // 心跳：防止某些代理/隧道在长时间无数据时主动断开
        const heartbeatTimer = setInterval(() => {
            if (res.writableEnded || responseClosedEarly) {
                return;
            }
            res.write(`: ping ${Date.now()}\n\n`);
        }, 15000);

        const abortController = new AbortController();

        let timedOut = false;
        const STREAM_TIMEOUT_MS = 5 * 60 * 1000;

        const writeEvent = (event: string, data: unknown) => {
            if (res.writableEnded || responseClosedEarly) {
                return;
            }

            // SSE 格式：event + data(JSON)
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const writeTimeoutError = () => {
            writeEvent("error", {
                type: "error",
                ts: Date.now(),
                conversationId,
                error: `处理超时（超过 ${Math.round(STREAM_TIMEOUT_MS / 1000)} 秒），已自动中止`
            });
            if (!res.writableEnded && !responseClosedEarly) {
                res.end();
            }
        };

        // 整体超时兜底：LLM/工具链路若长时间挂起，主动结束 SSE 并释放对话锁。
        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            writeTimeoutError();
            abortController.abort();
        }, STREAM_TIMEOUT_MS);

        // POST 请求体读完也会触发 req close；只有响应连接提前关闭才代表客户端断开 SSE。
        res.on("close", () => {
            if (res.writableEnded) {
                return;
            }

            responseClosedEarly = true;
            abortController.abort();
        });

        try {
            await this.agentService.askAgentStream(
                {
                    question: params.question,
                    conversationId,
                    sessionId: params.sessionId,
                    enabledTools: params.enabledTools,
                    maxToolRounds: params.maxToolRounds,
                    temperature: params.temperature,
                    maxTokens: params.maxTokens
                },
                {
                    abortSignal: abortController.signal,
                    onEvent: (evt: AgentEvent) => {
                        writeEvent(evt.type ?? "message", evt);

                        if (evt.type === "done" || evt.type === "error") {
                            res.end();
                        }
                    }
                }
            );
        } catch (e) {
            if (!res.writableEnded && !responseClosedEarly) {
                const msg = timedOut
                    ? `处理超时（超过 ${Math.round(STREAM_TIMEOUT_MS / 1000)} 秒），已自动中止`
                    : e instanceof Error
                      ? e.message
                      : String(e);

                writeEvent("error", {
                    type: "error",
                    ts: Date.now(),
                    conversationId,
                    error: msg
                });
                res.end();
            }
        } finally {
            clearTimeout(timeoutTimer);
            clearInterval(heartbeatTimer);
            this.agentService.releaseConversationLock(conversationId);
        }
    }

    /**
     * POST /api/agent/conversations
     * 获取对话列表
     */
    public async getConversations(req: Request, res: Response): Promise<void> {
        const params = AgentGetConversationsSchema.parse(req.body);
        const conversations = await this.agentService.getConversations(
            params.sessionId,
            params.beforeUpdatedAt,
            params.limit
        );

        res.json({ success: true, data: conversations });
    }

    /**
     * POST /api/agent/conversations/:id/messages
     * 获取对话的消息列表
     */
    public async getMessages(req: Request, res: Response): Promise<void> {
        const params = AgentGetMessagesSchema.parse({
            conversationId: req.params.id,
            beforeTimestamp: req.body?.beforeTimestamp,
            limit: req.body?.limit
        });
        const messages = await this.agentService.getMessages(
            params.conversationId,
            params.beforeTimestamp,
            params.limit
        );

        res.json({ success: true, data: messages });
    }

    /**
     * POST /api/agent/state/history
     * 获取 LangGraph thread 的 checkpoint 历史（分页）
     */
    public async getStateHistory(req: Request, res: Response): Promise<void> {
        const params = AgentGetStateHistoryRequestSchema.parse(req.body);
        const result = await this.agentService.getStateHistory(params);

        res.json({ success: true, data: result });
    }

    /**
     * POST /api/agent/state/fork
     * 从某个 checkpoint fork 新 thread
     */
    public async forkFromCheckpoint(req: Request, res: Response): Promise<void> {
        const params = AgentForkFromCheckpointRequestSchema.parse(req.body);
        const result = await this.agentService.forkFromCheckpoint(params);

        res.json({ success: true, data: result });
    }
}
