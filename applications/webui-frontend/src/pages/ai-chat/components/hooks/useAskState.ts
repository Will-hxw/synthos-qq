import type { AskResponse, ReferenceItem } from "@/api/ragApi";

import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeAskStream } from "@/api/agentTrpcClient";

type AskDoneChunk = {
    type: "done";
    sessionId?: string;
    isFailed?: boolean;
    failReason?: string;
};

interface UseAskStateOptions {
    onReferences?: (refs: ReferenceItem[]) => void;
    onDone?: (chunk: AskDoneChunk) => void;
}

/**
 * 流式问答：订阅管理 + UI 状态
 */
export function useAskState({ onReferences, onDone }: UseAskStateOptions) {
    const [askResponse, setAskResponse] = useState<AskResponse | null>(null);
    const [askLoading, setAskLoading] = useState(false);
    const [currentSessionIsFailed, setCurrentSessionIsFailed] = useState(false);
    const [currentSessionFailReason, setCurrentSessionFailReason] = useState("");

    const askUnsubscribeRef = useRef<{ unsubscribe: () => void } | null>(null);
    const currentAnswerRef = useRef("");
    const currentReferencesRef = useRef<ReferenceItem[]>([]);
    const tokenBufferRef = useRef("");
    const rafIdRef = useRef<number | null>(null);

    const flushTokenBuffer = useCallback(() => {
        rafIdRef.current = null;

        if (!tokenBufferRef.current) {
            return;
        }

        tokenBufferRef.current = "";
        setAskResponse(prev => {
            if (!prev) {
                return { answer: currentAnswerRef.current, references: currentReferencesRef.current };
            }

            return { ...prev, answer: currentAnswerRef.current };
        });
    }, []);

    const cancelPendingFlush = useCallback(() => {
        tokenBufferRef.current = "";
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
    }, []);

    const stopAsk = useCallback(() => {
        if (askUnsubscribeRef.current) {
            askUnsubscribeRef.current.unsubscribe();
            askUnsubscribeRef.current = null;
        }
        cancelPendingFlush();
    }, [cancelPendingFlush]);

    useEffect(() => {
        return () => {
            stopAsk();
        };
    }, [stopAsk]);

    const handleAsk = useCallback(
        async (params: { question: string; topK: number; enableQueryRewriter: boolean }) => {
            const { question, topK, enableQueryRewriter } = params;

            if (!question.trim()) {
                return;
            }

            setAskLoading(true);
            setCurrentSessionIsFailed(false);
            setCurrentSessionFailReason("");

            // 重置
            setAskResponse({ answer: "", references: [] });
            currentAnswerRef.current = "";
            currentReferencesRef.current = [];
            cancelPendingFlush();

            // 清理旧订阅
            stopAsk();

            try {
                const subscription = subscribeAskStream(
                    {
                        question,
                        topK,
                        enableQueryRewriter
                    },
                    chunk => {
                        if (chunk.type === "content" && chunk.content) {
                            const content = chunk.content;

                            currentAnswerRef.current += content;
                            tokenBufferRef.current += content;

                            if (rafIdRef.current === null) {
                                rafIdRef.current = requestAnimationFrame(flushTokenBuffer);
                            }
                        } else if (chunk.type === "references" && chunk.references) {
                            const refs = chunk.references as ReferenceItem[];

                            currentReferencesRef.current = refs;
                            setAskResponse(prev => {
                                if (!prev) {
                                    return { answer: "", references: refs };
                                }

                                return { ...prev, references: refs };
                            });
                            onReferences?.(refs);
                        } else if (chunk.type === "error") {
                            console.error("Ask stream error:", chunk.error);
                            cancelPendingFlush();
                            setCurrentSessionIsFailed(true);
                            setCurrentSessionFailReason(chunk.error || "");
                            currentAnswerRef.current += `\n\n[Error: ${chunk.error}]`;
                            setAskResponse(prev => (prev ? { ...prev, answer: currentAnswerRef.current } : null));
                        } else if (chunk.type === "done") {
                            flushTokenBuffer();
                            onDone?.(chunk as AskDoneChunk);
                            if ((chunk as AskDoneChunk).isFailed) {
                                setCurrentSessionIsFailed(true);
                                setCurrentSessionFailReason((chunk as AskDoneChunk).failReason || "");
                            }
                        }
                    },
                    err => {
                        console.error("Ask subscription error:", err);
                        setAskLoading(false);
                    },
                    () => {
                        setAskLoading(false);
                        askUnsubscribeRef.current = null;
                    }
                );

                askUnsubscribeRef.current = subscription;
            } catch (error) {
                console.error("问答出错:", error);
                setAskLoading(false);
            }
        },
        [cancelPendingFlush, flushTokenBuffer, onDone, onReferences, stopAsk]
    );

    return {
        askResponse,
        setAskResponse,
        askLoading,
        currentSessionIsFailed,
        setCurrentSessionIsFailed,
        currentSessionFailReason,
        setCurrentSessionFailReason,
        handleAsk,
        stopAsk
    };
}
