import "reflect-metadata";

import type { Request, Response } from "express";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentController } from "../controllers/AgentController";

function makeReq(body: unknown): Request {
    const handlers: Record<string, () => void> = {};

    return {
        body,
        httpVersionMajor: 1,
        on: vi.fn((event: string, cb: () => void) => {
            handlers[event] = cb;
        })
    } as unknown as Request;
}

function makeRes(): Response & { _written: string[] } {
    const res: any = {
        _written: [],
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        status: vi.fn(function (this: any, code: number) {
            this.statusCode = code;

            return this;
        }),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        json: vi.fn(),
        write: vi.fn(function (this: any, chunk: string) {
            this._written.push(chunk);

            return true;
        }),
        end: vi.fn(function (this: any) {
            this.writableEnded = true;

            return this;
        })
    };

    return res;
}

describe("AgentController.askStream", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("并发拒绝时返回 409 SSE 错误帧且带可机读的 code", async () => {
        const agentService = {
            tryAcquireConversationLock: vi.fn().mockReturnValue(false),
            releaseConversationLock: vi.fn(),
            askAgentStream: vi.fn()
        };
        const controller = new AgentController(agentService as any);
        const req = makeReq({ question: "你好", conversationId: "conv-1" });
        const res = makeRes();

        await controller.askStream(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream; charset=utf-8");
        expect(res._written.join("")).toContain("event: error");
        expect(res._written.join("")).toContain('"code":"CONVERSATION_RUNNING"');
        expect(res._written.join("")).toContain("该对话正在运行中，请等待当前请求完成");
        expect(res.end).toHaveBeenCalled();
        // 没拿到锁就不应该释放锁，也不应该跑流式
        expect(agentService.askAgentStream).not.toHaveBeenCalled();
        expect(agentService.releaseConversationLock).not.toHaveBeenCalled();
    });

    it("流式处理超时应中止并释放对话锁，发出 error 帧", async () => {
        let capturedAbortSignal: AbortSignal | undefined;
        // askAgentStream 永不自行结束，只在 abort 时 reject，模拟挂起的 LLM 链路
        const agentService = {
            tryAcquireConversationLock: vi.fn().mockReturnValue(true),
            releaseConversationLock: vi.fn(),
            askAgentStream: vi.fn((_input: unknown, opts: { abortSignal: AbortSignal }) => {
                capturedAbortSignal = opts.abortSignal;

                return new Promise((_resolve, reject) => {
                    opts.abortSignal.addEventListener("abort", () => {
                        reject(new Error("aborted"));
                    });
                });
            })
        };
        const controller = new AgentController(agentService as any);
        const req = makeReq({ question: "你好", conversationId: "conv-2" });
        const res = makeRes();

        const promise = controller.askStream(req, res);

        // 推进到超时阈值之后
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);
        await promise;

        expect(capturedAbortSignal?.aborted).toBe(true);
        expect(agentService.releaseConversationLock).toHaveBeenCalledWith("conv-2");
        const errorFrame = res._written.find(w => w.includes('"type":"error"'));

        expect(errorFrame).toBeTruthy();
        expect(errorFrame).toContain("处理超时");
        expect(res.end).toHaveBeenCalled();
    });
});
