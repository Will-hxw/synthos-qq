/**
 * Agent 聊天组件
 * 显示 Agent 对话消息、工具调用过程、输入框
 */
import React, { useState, useRef, useEffect, useCallback } from "react";
import { Button, Spinner, Textarea, Card, CardBody, Chip, Tooltip, cn } from "@heroui/react";
import { Send, Bot, User, Wrench, Square } from "lucide-react";
import { motion } from "framer-motion";

import { AgentEvent, AgentMessage, AgentStreamError, agentAskStream, getAgentMessages } from "@/api/agentApi";
import MarkdownRenderer from "@/components/MarkdownRenderer";

interface AgentChatProps {
    // 当前选中的对话ID
    conversationId?: string;
    // 会话ID
    sessionId?: string;

    // 当服务端创建/切换对话时通知父组件
    onConversationIdChange?: (conversationId: string | undefined) => void;
}

function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException) {
        return error.name === "AbortError";
    }

    return typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError";
}

const MAX_TOOL_TRACE_COUNT = 20;
const MAX_TOOL_TRACE_TEXT_LENGTH = 4000;

function stringifyToolTraceValue(value: unknown): string {
    let text: string;

    try {
        text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        text = String(value);
    }

    if (text.length <= MAX_TOOL_TRACE_TEXT_LENGTH) {
        return text;
    }

    return `${text.slice(0, MAX_TOOL_TRACE_TEXT_LENGTH)}\n...内容过长，已截断`;
}

/**
 * Agent 消息项组件
 */
interface AgentMessageItemProps {
    message: AgentMessage;
}

const AgentMessageItemComponent: React.FC<AgentMessageItemProps> = ({ message }) => {
    const isUser = message.role === "user";

    return (
        <motion.div animate={{ opacity: 1, y: 0 }} className={cn("flex gap-3 mb-6", isUser ? "flex-row-reverse" : "flex-row")} initial={{ opacity: 0, y: 20 }} transition={{ duration: 0.3 }}>
            {/* 头像 */}
            <div className={cn("flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center", isUser ? "bg-primary-100" : "bg-secondary-100")}>
                {isUser ? <User className="w-5 h-5 text-primary-600" /> : <Bot className="w-5 h-5 text-secondary-600" />}
            </div>

            {/* 消息内容 */}
            <div className={cn("flex-1 max-w-[80%]", isUser ? "text-right" : "text-left")}>
                <Card className={cn("shadow-sm", isUser ? "bg-primary-50" : "bg-default-50")}>
                    <CardBody className="p-4">
                        {isUser ? (
                            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                        ) : (
                            <>
                                <MarkdownRenderer content={message.content} showCopyButton={false} />

                                {/* 工具使用信息 */}
                                {message.toolsUsed && message.toolsUsed.length > 0 && (
                                    <div className="mt-3 pt-3 border-t border-default-200">
                                        <div className="flex flex-wrap gap-2 items-center">
                                            <Wrench className="w-4 h-4 text-default-500" />
                                            <span className="text-xs text-default-500">使用的工具：</span>
                                            {message.toolsUsed.map((tool, idx) => (
                                                <Chip key={idx} color="secondary" size="sm" variant="flat">
                                                    {tool}
                                                </Chip>
                                            ))}
                                        </div>

                                        {message.toolRounds !== undefined && (
                                            <div className="flex items-center gap-2 mt-2">
                                                <span className="text-xs text-default-500">调用轮次: {message.toolRounds}</span>
                                            </div>
                                        )}

                                        {/* Token 使用统计 */}
                                        {message.tokenUsage && (
                                            <div className="flex items-center gap-2 mt-2">
                                                <span className="text-xs text-default-500">
                                                    Token: {message.tokenUsage.promptTokens} + {message.tokenUsage.completionTokens} = {message.tokenUsage.totalTokens}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </CardBody>
                </Card>

                {/* 时间戳 */}
                <p className={cn("text-xs text-default-400 mt-1", isUser ? "text-right" : "text-left")}>{new Date(message.timestamp).toLocaleTimeString("zh-CN")}</p>
            </div>
        </motion.div>
    );
};

// 流式 token 高频更新整个 messages 数组，未变化的消息项无需重渲染。
// 仅当影响渲染的字段变化时才更新，避免每个 token 都重新解析全部 Markdown。
const AgentMessageItem = React.memo(AgentMessageItemComponent, (prev, next) => {
    const a = prev.message;
    const b = next.message;

    return (
        a.id === b.id && a.content === b.content && a.role === b.role && a.timestamp === b.timestamp && a.toolRounds === b.toolRounds && a.toolsUsed === b.toolsUsed && a.tokenUsage === b.tokenUsage
    );
});

/**
 * Agent 聊天主组件
 */
export const AgentChat: React.FC<AgentChatProps> = ({ conversationId, sessionId, onConversationIdChange }) => {
    // 消息列表
    const [messages, setMessages] = useState<AgentMessage[]>([]);
    // 输入内容
    const [inputValue, setInputValue] = useState("");
    // 加载状态
    const [loading, setLoading] = useState(false);
    // 当前对话ID
    const [currentConversationId, setCurrentConversationId] = useState<string | undefined>(conversationId);

    // 历史分页
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyHasMore, setHistoryHasMore] = useState(false);

    const abortRef = useRef<AbortController | null>(null);
    const activeRequestIdRef = useRef(0);
    const pendingAssistantIdRef = useRef<string | null>(null);
    // 流式 token 批处理：累积到缓冲区，按动画帧合并刷新，避免每个 token 都重解析 Markdown
    const tokenBufferRef = useRef("");
    const rafIdRef = useRef<number | null>(null);

    type ToolTrace = {
        toolCallId: string;
        toolName: string;
        toolArgs: unknown;
        result?: unknown;
        startedAt: number;
        finishedAt?: number;
    };

    const [toolTraces, setToolTraces] = useState<ToolTrace[]>([]);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    // 用户是否贴着底部：贴底才自动跟随，否则用户上滚阅读时不被强行拽回底部
    const shouldAutoScrollRef = useRef(true);

    // 监听滚动，判断是否仍在底部附近（阈值 80px，容纳行高抖动）
    const handleScroll = useCallback(() => {
        const el = scrollContainerRef.current;

        if (!el) {
            return;
        }

        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

        shouldAutoScrollRef.current = distanceToBottom < 80;
    }, []);

    // 自动滚动到底部。流式 token 高频更新时用 instant，避免 smooth 动画排队造成卡顿
    const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
        if (!shouldAutoScrollRef.current) {
            return;
        }

        messagesEndRef.current?.scrollIntoView({ behavior });
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages.length, scrollToBottom]);

    // 把缓冲的 token 一次性合并进待回答的助手消息，并清空缓冲与 RAF 句柄
    const flushTokenBuffer = useCallback(() => {
        rafIdRef.current = null;

        const buffered = tokenBufferRef.current;

        if (!buffered) {
            return;
        }

        tokenBufferRef.current = "";

        const assistantId = pendingAssistantIdRef.current;

        if (!assistantId) {
            return;
        }

        setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: (m.content || "") + buffered } : m)));
        requestAnimationFrame(() => scrollToBottom());
    }, [scrollToBottom]);

    // 卸载时取消挂起的 RAF，避免回调在已卸载组件上 setState
    useEffect(() => {
        return () => {
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
            }
        };
    }, []);

    // 切换会话或对话时，加载历史消息（默认拉取最新 20 条）
    useEffect(() => {
        setCurrentConversationId(conversationId);

        setToolTraces([]);
        setLoading(false);
        activeRequestIdRef.current++;
        pendingAssistantIdRef.current = null;
        // 切换对话：丢弃未刷新的缓冲 token 与挂起的 RAF
        tokenBufferRef.current = "";
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }

        // 清理正在进行的 SSE
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }

        if (!conversationId) {
            setMessages([]);
            setHistoryHasMore(false);

            return;
        }

        (async () => {
            try {
                setHistoryLoading(true);
                const resp = await getAgentMessages(conversationId, undefined, 20);

                if (resp.success && resp.data) {
                    setMessages(resp.data);
                    setHistoryHasMore(resp.data.length >= 20);
                }
            } catch (err) {
                console.error("加载 Agent 历史消息失败:", err);
            } finally {
                setHistoryLoading(false);
            }
        })();
    }, [conversationId, sessionId]);

    const handleLoadMoreHistory = useCallback(async () => {
        if (!currentConversationId || historyLoading || loading || messages.length === 0) {
            return;
        }

        try {
            setHistoryLoading(true);
            const oldestTimestamp = messages[0]?.timestamp;
            const resp = await getAgentMessages(currentConversationId, oldestTimestamp, 20);

            if (resp.success && resp.data) {
                if (resp.data.length === 0) {
                    setHistoryHasMore(false);

                    return;
                }
                setMessages(prev => [...resp.data, ...prev]);
                setHistoryHasMore(resp.data.length >= 20);
            }
        } catch (err) {
            console.error("加载更多 Agent 历史消息失败:", err);
        } finally {
            setHistoryLoading(false);
        }
    }, [currentConversationId, historyLoading, loading, messages]);

    const handleCancel = useCallback(() => {
        if (!abortRef.current) {
            return;
        }

        const pendingAssistantId = pendingAssistantIdRef.current;

        activeRequestIdRef.current++;
        abortRef.current.abort();
        abortRef.current = null;
        pendingAssistantIdRef.current = null;
        // 丢弃未刷新的缓冲 token，避免取消后又追加残留内容
        tokenBufferRef.current = "";
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        setLoading(false);
        setToolTraces([]);

        if (!pendingAssistantId) {
            return;
        }

        setMessages(prev =>
            prev.map(m => {
                if (m.id !== pendingAssistantId) {
                    return m;
                }

                return {
                    ...m,
                    content: m.content ? `${m.content}\n\n（已取消）` : "已取消本次回答"
                };
            })
        );
    }, []);

    // 处理发送消息
    const handleSend = useCallback(async () => {
        if (!inputValue.trim() || loading) {
            return;
        }

        const userQuestion = inputValue.trim();

        setInputValue("");
        setLoading(true);

        // 添加用户消息
        const userMessageId = `user_${Date.now()}`;
        const userMessage: AgentMessage = {
            id: userMessageId,
            conversationId: currentConversationId || "",
            role: "user",
            content: userQuestion,
            timestamp: Date.now()
        };

        const assistantTempId = `assistant_pending_${Date.now()}`;
        const assistantTempMessage: AgentMessage = {
            id: assistantTempId,
            conversationId: currentConversationId || "",
            role: "assistant",
            content: "",
            timestamp: Date.now()
        };

        setMessages(prev => [...prev, userMessage, assistantTempMessage]);
        // 用户主动发送：强制贴底跟随本轮回答
        shouldAutoScrollRef.current = true;

        try {
            // 清理之前的 SSE
            if (abortRef.current) {
                abortRef.current.abort();
                abortRef.current = null;
            }

            setToolTraces([]);
            const requestId = activeRequestIdRef.current + 1;

            activeRequestIdRef.current = requestId;
            pendingAssistantIdRef.current = assistantTempId;

            const abortController = new AbortController();

            abortRef.current = abortController;

            const handleEvent = (evt: AgentEvent) => {
                if (activeRequestIdRef.current !== requestId || abortController.signal.aborted) {
                    return;
                }

                if (evt.type === "token") {
                    // 累积到缓冲区，按帧合并刷新，降低 Markdown 重解析频率
                    tokenBufferRef.current += evt.content;

                    if (rafIdRef.current === null) {
                        rafIdRef.current = requestAnimationFrame(flushTokenBuffer);
                    }

                    return;
                }

                if (evt.type === "tool_call") {
                    setToolTraces(prev => {
                        if (prev.some(t => t.toolCallId === evt.toolCallId)) {
                            return prev;
                        }

                        const next = [
                            ...prev,
                            {
                                toolCallId: evt.toolCallId,
                                toolName: evt.toolName,
                                toolArgs: evt.toolArgs,
                                startedAt: evt.ts
                            }
                        ];

                        return next.slice(-MAX_TOOL_TRACE_COUNT);
                    });

                    return;
                }

                if (evt.type === "tool_result") {
                    setToolTraces(prev =>
                        prev.map(t => {
                            if (t.toolCallId !== evt.toolCallId) {
                                return t;
                            }

                            return {
                                ...t,
                                result: evt.result,
                                finishedAt: evt.ts
                            };
                        })
                    );

                    return;
                }

                if (evt.type === "error") {
                    // 丢弃未刷新的缓冲，避免错误文案后又追加残留 token
                    tokenBufferRef.current = "";
                    if (rafIdRef.current !== null) {
                        cancelAnimationFrame(rafIdRef.current);
                        rafIdRef.current = null;
                    }
                    setMessages(prev =>
                        prev.map(m => {
                            if (m.id !== assistantTempId) {
                                return m;
                            }

                            return {
                                ...m,
                                content: `发生错误: ${evt.error || "未知错误"}`
                            };
                        })
                    );
                    setLoading(false);
                    abortRef.current = null;
                    pendingAssistantIdRef.current = null;

                    return;
                }

                if (evt.type === "done") {
                    // 先把尚未刷新的缓冲 token 合并进消息，再以最终内容定稿
                    flushTokenBuffer();
                    setCurrentConversationId(evt.conversationId);
                    onConversationIdChange?.(evt.conversationId);

                    setMessages(prev =>
                        prev.map(m => {
                            if (m.id === userMessageId) {
                                return {
                                    ...m,
                                    conversationId: evt.conversationId
                                };
                            }

                            if (m.id === assistantTempId) {
                                return {
                                    ...m,
                                    id: evt.messageId || m.id,
                                    conversationId: evt.conversationId,
                                    toolsUsed: evt.toolsUsed,
                                    toolRounds: evt.toolRounds,
                                    tokenUsage: evt.totalUsage,
                                    content: evt.content ?? m.content
                                };
                            }

                            return m;
                        })
                    );
                    requestAnimationFrame(() => scrollToBottom());

                    setLoading(false);
                    abortRef.current = null;
                    pendingAssistantIdRef.current = null;
                }
            };

            void agentAskStream(
                {
                    question: userQuestion,
                    conversationId: currentConversationId,
                    sessionId: sessionId,
                    enabledTools: ["rag_search", "sql_query"],
                    maxToolRounds: 5,
                    temperature: 0.7,
                    maxTokens: 2048
                },
                {
                    signal: abortController.signal,
                    onEvent: handleEvent
                }
            ).catch(err => {
                if (activeRequestIdRef.current !== requestId || abortController.signal.aborted || isAbortError(err)) {
                    return;
                }

                console.error("Agent SSE 出错:", err);

                // 并发拒绝(409)不是网络错误，给出明确文案
                const isConversationRunning = err instanceof AgentStreamError && (err.status === 409 || err.code === "CONVERSATION_RUNNING");
                const content = isConversationRunning ? `${err.message}` : `网络错误: ${err instanceof Error ? err.message : String(err)}`;

                setMessages(prev =>
                    prev.map(m => {
                        if (m.id !== assistantTempId) {
                            return m;
                        }

                        return {
                            ...m,
                            content
                        };
                    })
                );
                setLoading(false);
                abortRef.current = null;
                pendingAssistantIdRef.current = null;
            });
        } catch (error) {
            console.error("Agent 问答出错:", error);

            // 显示错误消息
            const errorMessage: AgentMessage = {
                id: `error_${Date.now()}`,
                conversationId: currentConversationId || "",
                role: "assistant",
                content: `❌ 网络错误: ${error instanceof Error ? error.message : String(error)}`,
                timestamp: Date.now()
            };

            setMessages(prev => [...prev, errorMessage]);
        } finally {
            // loading 由订阅 done/error 关闭
        }
    }, [inputValue, loading, currentConversationId, sessionId, onConversationIdChange, flushTokenBuffer]);

    // 处理键盘事件
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="flex flex-col h-full">
            {/* 消息列表 */}
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-6" onScroll={handleScroll}>
                {/* 历史分页 */}
                {currentConversationId && messages.length > 0 && historyHasMore && (
                    <div className="flex justify-center mb-4">
                        <Button isLoading={historyLoading} size="sm" variant="flat" onPress={handleLoadMoreHistory}>
                            加载更早消息
                        </Button>
                    </div>
                )}

                {messages.length === 0 ? (
                    <motion.div
                        animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
                        className="text-center py-12"
                        initial={{ opacity: 0, filter: "blur(10px)", y: 20 }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                    >
                        <div
                            className="
                                bg-gradient-to-r from-secondary-600 via-primary-600 to-warning-600
                                bg-[length:200%_auto] animate-[gradient_3s_ease-in-out_infinite]
                                bg-clip-text text-transparent
                                text-3xl md:text-4xl font-bold mb-4
                            "
                            style={{
                                backgroundSize: "200% auto",
                                animation: "gradient 3s ease-in-out infinite"
                            }}
                        >
                            智能 Agent 助手
                        </div>
                        <p className="text-default-500 text-sm md:text-base">当前是新对话草稿，发送第一条消息后会自动保存到历史会话</p>
                    </motion.div>
                ) : (
                    <>
                        {messages.map(msg => (
                            <AgentMessageItem key={msg.id} message={msg} />
                        ))}

                        {/* 工具调用审阅展示：只展示，不中断 */}
                        {loading && toolTraces.length > 0 && (
                            <div className="mb-6">
                                <Card className="bg-default-50 shadow-sm">
                                    <CardBody className="p-4">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Wrench className="w-4 h-4 text-default-500" />
                                            <span className="text-xs text-default-500">工具调用过程（审阅）</span>
                                        </div>

                                        <div className="flex flex-col gap-3">
                                            {toolTraces.map(t => (
                                                <div key={t.toolCallId} className="border border-default-200 rounded-lg p-3">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <div className="text-sm font-medium text-default-700 break-words">{t.toolName}</div>
                                                        <div className="text-xs text-default-400 flex-shrink-0">{t.finishedAt ? "已完成" : "执行中"}</div>
                                                    </div>

                                                    <div className="mt-2">
                                                        <div className="text-xs text-default-500 mb-1">args</div>
                                                        <pre className="text-xs whitespace-pre-wrap break-words bg-default-100 rounded-md p-2 overflow-x-auto">
                                                            {stringifyToolTraceValue(t.toolArgs)}
                                                        </pre>
                                                    </div>

                                                    {t.finishedAt !== undefined && (
                                                        <div className="mt-2">
                                                            <div className="text-xs text-default-500 mb-1">result</div>
                                                            <pre className="text-xs whitespace-pre-wrap break-words bg-default-100 rounded-md p-2 overflow-x-auto">
                                                                {stringifyToolTraceValue(t.result)}
                                                            </pre>
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </CardBody>
                                </Card>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </>
                )}

                {/* 加载中提示 */}
                {loading && (
                    <motion.div animate={{ opacity: 1 }} className="flex items-center gap-3 mb-6" initial={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-secondary-100 flex items-center justify-center">
                            <Bot className="w-5 h-5 text-secondary-600" />
                        </div>
                        <Card className="bg-default-50 shadow-sm">
                            <CardBody className="p-4">
                                <div className="flex items-center gap-2">
                                    <Spinner color="secondary" size="sm" />
                                    <span className="text-sm text-default-500">思考中...</span>
                                </div>
                            </CardBody>
                        </Card>
                    </motion.div>
                )}
            </div>

            {/* 输入框 */}
            <div className="px-4 py-4 border-t border-default-200 bg-default-50">
                <div className="flex gap-2 items-end">
                    <Textarea
                        classNames={{
                            input: "resize-y"
                        }}
                        disabled={loading}
                        maxRows={6}
                        minRows={2}
                        placeholder="输入你的问题... (Enter 发送, Shift+Enter 换行)"
                        value={inputValue}
                        onChange={e => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                    />
                    {loading ? (
                        <Tooltip color="danger" content="取消本次回答" placement="top">
                            <Button isIconOnly aria-label="取消本次回答" color="danger" size="lg" variant="flat" onPress={handleCancel}>
                                <Square className="w-5 h-5" />
                            </Button>
                        </Tooltip>
                    ) : (
                        <Button isIconOnly aria-label="发送消息" color="primary" disabled={!inputValue.trim()} size="lg" onPress={handleSend}>
                            <Send className="w-5 h-5" />
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
};
