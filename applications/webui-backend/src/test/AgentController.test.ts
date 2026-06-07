import "reflect-metadata";

import type { Request, Response } from "express";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentController } from "../controllers/AgentController";

type TestReq = Request & {
    _emit: (event: string) => void;
};

type TestRes = Response & {
    _written: string[];
    _emit: (event: string) => void;
};

function makeReq(body: unknown, params: Record<string, string> = {}): TestReq {
    const handlers: Record<string, (() => void)[]> = {};

    const req: any = {
        body,
        params,
        httpVersionMajor: 1,
        on: vi.fn((event: string, cb: () => void) => {
            handlers[event] = handlers[event] || [];
            handlers[event].push(cb);

            return req;
        }),
        _emit: (event: string) => {
            for (const handler of handlers[event] || []) {
                handler();
            }
        }
    };

    return req as TestReq;
}

function makeRes(): TestRes {
    const handlers: Record<string, (() => void)[]> = {};

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
        on: vi.fn((event: string, cb: () => void) => {
            handlers[event] = handlers[event] || [];
            handlers[event].push(cb);

            return res;
        }),
        write: vi.fn(function (this: any, chunk: string) {
            this._written.push(chunk);

            return true;
        }),
        end: vi.fn(function (this: any) {
            this.writableEnded = true;

            return this;
        }),
        _emit: (event: string) => {
            for (const handler of handlers[event] || []) {
                handler();
            }
        }
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
        const agentService = {
            tryAcquireConversationLock: vi.fn().mockReturnValue(true),
            releaseConversationLock: vi.fn(),
            askAgentStream: vi.fn((_input: unknown, opts: { abortSignal: AbortSignal }) => {
                capturedAbortSignal = opts.abortSignal;

                return new Promise<void>(resolve => {
                    opts.abortSignal.addEventListener("abort", () => {
                        resolve();
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

    it("请求 close 不应中止 SSE 流", async () => {
        let capturedAbortSignal: AbortSignal | undefined;
        let emitDone: (() => void) | undefined;
        let resolveStream: (() => void) | undefined;
        const agentService = {
            tryAcquireConversationLock: vi.fn().mockReturnValue(true),
            releaseConversationLock: vi.fn(),
            askAgentStream: vi.fn(
                (_input: unknown, opts: { abortSignal: AbortSignal; onEvent: (evt: any) => void }) => {
                    capturedAbortSignal = opts.abortSignal;
                    emitDone = () => {
                        opts.onEvent({
                            type: "done",
                            ts: Date.now(),
                            conversationId: "conv-3",
                            messageId: "msg-3",
                            content: "完成",
                            toolsUsed: [],
                            toolRounds: 0
                        });
                    };

                    return new Promise<void>(resolve => {
                        resolveStream = resolve;
                    });
                }
            )
        };
        const controller = new AgentController(agentService as any);
        const req = makeReq({ question: "你好", conversationId: "conv-3" });
        const res = makeRes();

        const promise = controller.askStream(req, res);

        await Promise.resolve();
        req._emit("close");

        expect(capturedAbortSignal?.aborted).toBe(false);
        expect(agentService.releaseConversationLock).not.toHaveBeenCalled();

        emitDone?.();
        resolveStream?.();
        await promise;

        expect(res._written.join("")).toContain("event: done");
        expect(res.end).toHaveBeenCalled();
        expect(agentService.releaseConversationLock).toHaveBeenCalledWith("conv-3");
    });

    it("响应 close 且未正常结束时应中止下游流并释放对话锁", async () => {
        let capturedAbortSignal: AbortSignal | undefined;
        let resolveStream: (() => void) | undefined;
        const agentService = {
            tryAcquireConversationLock: vi.fn().mockReturnValue(true),
            releaseConversationLock: vi.fn(),
            askAgentStream: vi.fn((_input: unknown, opts: { abortSignal: AbortSignal }) => {
                capturedAbortSignal = opts.abortSignal;

                return new Promise<void>(resolve => {
                    resolveStream = resolve;
                });
            })
        };
        const controller = new AgentController(agentService as any);
        const req = makeReq({ question: "你好", conversationId: "conv-4" });
        const res = makeRes();

        const promise = controller.askStream(req, res);

        await Promise.resolve();
        res._emit("close");

        expect(capturedAbortSignal?.aborted).toBe(true);

        resolveStream?.();
        await promise;

        expect(agentService.releaseConversationLock).toHaveBeenCalledWith("conv-4");
    });

    it("正常 done 事件应结束响应并释放对话锁", async () => {
        const agentService = {
            tryAcquireConversationLock: vi.fn().mockReturnValue(true),
            releaseConversationLock: vi.fn(),
            askAgentStream: vi.fn(async (_input: unknown, opts: { onEvent: (evt: any) => void }) => {
                opts.onEvent({
                    type: "done",
                    ts: Date.now(),
                    conversationId: "conv-5",
                    messageId: "msg-5",
                    content: "完成",
                    toolsUsed: [],
                    toolRounds: 0
                });
            })
        };
        const controller = new AgentController(agentService as any);
        const req = makeReq({ question: "你好", conversationId: "conv-5" });
        const res = makeRes();

        await controller.askStream(req, res);

        expect(res._written.join("")).toContain("event: done");
        expect(res.end).toHaveBeenCalled();
        expect(agentService.releaseConversationLock).toHaveBeenCalledWith("conv-5");
    });
});

describe("AgentController conversation actions", () => {
    it("更新 Agent 对话标题时应校验参数并调用 service", async () => {
        const agentService = {
            updateConversationTitle: vi.fn().mockResolvedValue(undefined)
        };
        const controller = new AgentController(agentService as any);
        const req = makeReq({ title: "  新标题  " }, { id: "conv-rename" });
        const res = makeRes();

        await controller.updateConversationTitle(req, res);

        expect(agentService.updateConversationTitle).toHaveBeenCalledWith("conv-rename", "新标题");
        expect(res.json).toHaveBeenCalledWith({ success: true, message: "标题已更新" });
    });

    it("删除 Agent 对话时应调用 service", async () => {
        const agentService = {
            deleteConversation: vi.fn().mockResolvedValue(undefined)
        };
        const controller = new AgentController(agentService as any);
        const req = makeReq({}, { id: "conv-delete" });
        const res = makeRes();

        await controller.deleteConversation(req, res);

        expect(agentService.deleteConversation).toHaveBeenCalledWith("conv-delete");
        expect(res.json).toHaveBeenCalledWith({ success: true, message: "对话已删除" });
    });
});
