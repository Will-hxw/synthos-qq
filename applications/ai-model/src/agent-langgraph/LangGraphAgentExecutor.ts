/**
 * LangGraph 版本 Agent 执行器
 * 使用 LangGraph Graph API 实现 tool-calling 循环，并接入 checkpointer 实现持久化/时间旅行/HITL。
 */
import "reflect-metadata";
import type {
    AgentConfig,
    AgentResult,
    AgentStreamChunk,
    ToolDefinition,
    ToolCall,
    ToolContext,
    TokenUsage
} from "../agent/contracts/index";

import util from "util";

import { injectable, inject } from "tsyringe";
import { Annotation, StateGraph, messagesStateReducer, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import Logger from "@root/common/util/Logger";
import { z } from "zod";

import { AI_MODEL_TOKENS } from "../di/tokens";
import { TextGeneratorService, registerReasoningContent } from "../services/generators/text/TextGeneratorService";
import { ToolCallParser } from "../agent/utils/ToolCallParser";

import { AgentToolCatalog } from "./AgentToolCatalog";
import { LangGraphCheckpointerService } from "./LangGraphCheckpointerService";

interface AgentGraphState {
    messages: BaseMessage[];
    systemPrompt: string;
    enabledTools: string[];
    maxToolRounds: number;
    toolContext: ToolContext;

    // 每次 invoke 的运行态统计（会在每次调用时重置）
    runToolRounds: number;
    runToolsUsed: string[];
    runTotalUsage: TokenUsage;
}

@injectable()
export class LangGraphAgentExecutor {
    private LOGGER = Logger.withTag("LangGraphAgentExecutor");

    public constructor(
        @inject(AI_MODEL_TOKENS.TextGeneratorService) private textGeneratorService: TextGeneratorService,
        @inject(AI_MODEL_TOKENS.AgentToolCatalog) private agentToolCatalog: AgentToolCatalog,
        @inject(AI_MODEL_TOKENS.LangGraphCheckpointerService)
        private checkpointerService: LangGraphCheckpointerService
    ) {}

    private _formatMessagesForLog(messages: BaseMessage[]) {
        return messages.map(m => {
            const anyMsg = m as any;
            const type = typeof anyMsg?._getType === "function" ? anyMsg._getType() : anyMsg?.type;

            return {
                type,
                content: anyMsg?.content,
                tool_calls: anyMsg?.tool_calls,
                invalid_tool_calls: anyMsg?.invalid_tool_calls,
                tool_call_id: anyMsg?.tool_call_id
            };
        });
    }

    private _estimateMessageChars(messages: BaseMessage[]) {
        let chars = 0;

        for (const m of messages) {
            const anyMsg = m as any;
            const content = anyMsg?.content;

            if (typeof content === "string") {
                chars += content.length;
                continue;
            }

            if (Array.isArray(content)) {
                for (const part of content) {
                    if (typeof part === "string") {
                        chars += part.length;
                    } else if (part && typeof part === "object" && typeof (part as any).text === "string") {
                        chars += (part as any).text.length;
                    } else if (part != null) {
                        try {
                            chars += JSON.stringify(part).length;
                        } catch {
                            // ignore
                        }
                    }
                }
                continue;
            }

            if (content != null) {
                try {
                    chars += JSON.stringify(content).length;
                } catch {
                    // ignore
                }
            }
        }

        return chars;
    }

    private _extractUsage(
        lastChunk: any,
        messages: BaseMessage[],
        completionText: string
    ): TokenUsage | undefined {
        const usageCandidates: any[] = [];

        if (lastChunk?.usage_metadata) {
            usageCandidates.push({ source: "usage_metadata", value: lastChunk.usage_metadata });
        }
        if (lastChunk?.response_metadata?.usage_metadata) {
            usageCandidates.push({
                source: "response_metadata.usage_metadata",
                value: lastChunk.response_metadata.usage_metadata
            });
        }
        if (lastChunk?.response_metadata?.usage) {
            usageCandidates.push({ source: "response_metadata.usage", value: lastChunk.response_metadata.usage });
        }
        if (lastChunk?.response_metadata?.tokenUsage) {
            usageCandidates.push({
                source: "response_metadata.tokenUsage",
                value: lastChunk.response_metadata.tokenUsage
            });
        }
        if (lastChunk?.additional_kwargs?.usage) {
            usageCandidates.push({ source: "additional_kwargs.usage", value: lastChunk.additional_kwargs.usage });
        }

        const normalize = (u: any): TokenUsage | undefined => {
            if (!u) {
                return undefined;
            }

            // LangChain usage_metadata
            if (
                typeof u.input_tokens === "number" ||
                typeof u.output_tokens === "number" ||
                typeof u.total_tokens === "number"
            ) {
                const promptTokens = Number(u.input_tokens || 0);
                const completionTokens = Number(u.output_tokens || 0);
                const totalTokens = Number(u.total_tokens || promptTokens + completionTokens);

                return { promptTokens, completionTokens, totalTokens };
            }

            // OpenAI-ish
            const promptTokens = Number(u.prompt_tokens ?? u.promptTokens ?? 0);
            const completionTokens = Number(u.completion_tokens ?? u.completionTokens ?? 0);
            const totalTokensRaw = u.total_tokens ?? u.totalTokens;
            const totalTokens = Number(totalTokensRaw ?? promptTokens + completionTokens);

            if ([promptTokens, completionTokens, totalTokens].some(n => Number.isNaN(n))) {
                return undefined;
            }
            if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) {
                return undefined;
            }

            return {
                promptTokens: Math.max(0, promptTokens),
                completionTokens: Math.max(0, completionTokens),
                totalTokens: Math.max(0, totalTokens)
            };
        };

        let usage: TokenUsage | undefined;
        let pickedSource: string | undefined;

        for (const c of usageCandidates) {
            const normalized = normalize(c.value);

            if (normalized) {
                usage = normalized;
                pickedSource = c.source;
                break;
            }
        }

        if (!usage) {
            return undefined;
        }

        // Sanity check: provider 可能返回占位 token 数（例如 1/1/2），对较长 prompt 不可能成立。
        // 但 Agent 的 tool_calls 响应天生是紧凑 JSON（字符多但 token 少），跳过 completion 侧检查。
        const promptChars = this._estimateMessageChars(messages);
        const completionChars = completionText?.length ?? 0;
        const hasToolCalls = lastChunk?.tool_calls?.length > 0 || lastChunk?.tool_call_chunks?.length > 0;

        const suspiciousPrompt = promptChars > 200 && usage.promptTokens <= 5;
        const suspiciousCompletion = !hasToolCalls && completionChars > 80 && usage.completionTokens <= 5;
        const suspiciousTotal = promptChars + completionChars > 300 && usage.totalTokens <= 10;

        if (suspiciousPrompt || suspiciousCompletion || suspiciousTotal) {
            this.LOGGER.debug(
                `检测到可疑 token usage(可能为占位值)，忽略。source=${pickedSource}, usage=${util.inspect(usage)}`
            );

            return undefined;
        }

        if (!usage.totalTokens || usage.totalTokens <= 0) {
            usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }

        return usage;
    }

    private _mergeUsage(base: TokenUsage, delta: TokenUsage | undefined): TokenUsage {
        if (!delta) {
            return base;
        }

        return {
            promptTokens: base.promptTokens + delta.promptTokens,
            completionTokens: base.completionTokens + delta.completionTokens,
            totalTokens: base.totalTokens + delta.totalTokens
        };
    }

    private _createEmptyUsage(): TokenUsage {
        return {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
        };
    }

    private _addUnique(arr: string[], item: string): string[] {
        if (arr.includes(item)) {
            return arr;
        }

        return [...arr, item];
    }

    /**
     * 为重复或冲突的 tool_call id 生成稳定的唯一 ID。
     */
    private _allocateToolCallId(
        originalId: string,
        usedIds: Set<string>,
        duplicateCounters: Map<string, number>
    ): string {
        const baseId = originalId.trim() || "tool-call";

        if (!usedIds.has(baseId)) {
            usedIds.add(baseId);

            return baseId;
        }

        let nextIndex = duplicateCounters.get(baseId) ?? 1;
        let candidate = `${baseId}__dup_${nextIndex}`;

        while (usedIds.has(candidate)) {
            nextIndex += 1;
            candidate = `${baseId}__dup_${nextIndex}`;
        }

        duplicateCounters.set(baseId, nextIndex + 1);
        usedIds.add(candidate);

        return candidate;
    }

    /**
     * 规范化 assistant tool_calls 的 ID，保留所有工具调用并避免重复 ID。
     */
    private _normalizeToolCallIds(
        toolCalls: ToolCall[],
        reservedIds: Set<string> = new Set()
    ): {
        toolCalls: ToolCall[];
        originalIds: string[];
        rewrites: Array<{ originalId: string; newId: string; toolName: string }>;
    } {
        const usedIds = reservedIds;
        const duplicateCounters = new Map<string, number>();
        const normalizedToolCalls: ToolCall[] = [];
        const originalIds: string[] = [];
        const rewrites: Array<{ originalId: string; newId: string; toolName: string }> = [];

        for (const [index, toolCall] of toolCalls.entries()) {
            const originalId = String(toolCall.id || `tool-call-${index}`);
            const newId = this._allocateToolCallId(originalId, usedIds, duplicateCounters);

            if (newId !== originalId) {
                rewrites.push({
                    originalId,
                    newId,
                    toolName: toolCall.name
                });
            }

            originalIds.push(originalId);
            normalizedToolCalls.push({
                ...toolCall,
                id: newId
            });
        }

        return {
            toolCalls: normalizedToolCalls,
            originalIds,
            rewrites
        };
    }

    private _getAIMessageToolCalls(message: AIMessage): ToolCall[] {
        const anyMessage = message as any;
        const rawToolCalls = Array.isArray(anyMessage.tool_calls) ? anyMessage.tool_calls : [];

        return rawToolCalls.map((toolCall: any, index: number) => ({
            id: String(toolCall?.id || `tool-call-${index}`),
            name: String(toolCall?.name || ""),
            arguments: this._normalizeToolCallArguments(toolCall?.args ?? toolCall?.arguments)
        }));
    }

    private _cloneAIMessageWithToolCalls(message: AIMessage, toolCalls: ToolCall[]): AIMessage {
        const anyMessage = message as any;

        return new AIMessage({
            id: anyMessage.id,
            name: anyMessage.name,
            content: anyMessage.content ?? "",
            tool_calls: toolCalls.map(toolCall => ({
                id: toolCall.id,
                name: toolCall.name,
                args: toolCall.arguments
            })),
            invalid_tool_calls: anyMessage.invalid_tool_calls,
            usage_metadata: anyMessage.usage_metadata,
            additional_kwargs: { ...(anyMessage.additional_kwargs ?? {}) },
            response_metadata: { ...(anyMessage.response_metadata ?? {}) }
        } as any);
    }

    private _cloneToolMessageWithId(message: ToolMessage, toolCallId: string): ToolMessage {
        const anyMessage = message as any;

        return new ToolMessage({
            id: anyMessage.id,
            name: anyMessage.name,
            content: anyMessage.content ?? "",
            tool_call_id: toolCallId,
            status: anyMessage.status,
            artifact: anyMessage.artifact,
            metadata: anyMessage.metadata,
            additional_kwargs: { ...(anyMessage.additional_kwargs ?? {}) },
            response_metadata: { ...(anyMessage.response_metadata ?? {}) }
        } as any);
    }

    /**
     * 修复 checkpoint 历史中的重复 tool_call_id，并按 assistant/tool 出现顺序保持配对。
     */
    private _normalizePromptMessages(messages: BaseMessage[]): BaseMessage[] {
        const normalizedMessages: BaseMessage[] = [];
        const usedToolCallIds = new Set<string>();
        const pendingToolCallIdsByOriginalId = new Map<string, string[]>();

        for (const message of messages) {
            if (AIMessage.isInstance(message)) {
                const toolCalls = this._getAIMessageToolCalls(message);

                if (toolCalls.length === 0) {
                    normalizedMessages.push(message);
                    continue;
                }

                const normalized = this._normalizeToolCallIds(toolCalls, usedToolCallIds);

                for (const [index, originalId] of normalized.originalIds.entries()) {
                    const queue = pendingToolCallIdsByOriginalId.get(originalId) ?? [];

                    queue.push(normalized.toolCalls[index].id);
                    pendingToolCallIdsByOriginalId.set(originalId, queue);
                }

                for (const rewrite of normalized.rewrites) {
                    this.LOGGER.warning(
                        `改写重复 tool_call id: ${rewrite.originalId} -> ${rewrite.newId}，工具: ${rewrite.toolName}`
                    );
                }

                normalizedMessages.push(this._cloneAIMessageWithToolCalls(message, normalized.toolCalls));
                continue;
            }

            if (ToolMessage.isInstance(message)) {
                const originalToolCallId = String((message as any).tool_call_id || "");
                const queue = pendingToolCallIdsByOriginalId.get(originalToolCallId);

                if (queue && queue.length > 0) {
                    const normalizedToolCallId = queue.shift()!;

                    normalizedMessages.push(this._cloneToolMessageWithId(message, normalizedToolCallId));
                    continue;
                }
            }

            normalizedMessages.push(message);
        }

        return normalizedMessages;
    }

    /**
     * 发起 LLM 请求前校验 assistant/tool 消息的 tool_call_id 契约。
     */
    private _validatePromptMessages(messages: BaseMessage[]): void {
        const errors: string[] = [];
        const allToolCallIds = new Set<string>();
        const outstandingToolCallIds = new Set<string>();
        const consumedToolCallIds = new Set<string>();

        for (const [index, message] of messages.entries()) {
            if (AIMessage.isInstance(message)) {
                const toolCalls = this._getAIMessageToolCalls(message);
                const idsInMessage = new Set<string>();

                for (const toolCall of toolCalls) {
                    if (!toolCall.id) {
                        errors.push(`message[${index}] assistant tool_call 缺少 id`);
                        continue;
                    }
                    if (idsInMessage.has(toolCall.id)) {
                        errors.push(`message[${index}] assistant tool_call_id 重复: ${toolCall.id}`);
                    }
                    if (allToolCallIds.has(toolCall.id)) {
                        errors.push(`message[${index}] tool_call_id 全局重复: ${toolCall.id}`);
                    }

                    idsInMessage.add(toolCall.id);
                    allToolCallIds.add(toolCall.id);
                    outstandingToolCallIds.add(toolCall.id);
                }
                continue;
            }

            if (ToolMessage.isInstance(message)) {
                const toolCallId = String((message as any).tool_call_id || "");

                if (!toolCallId) {
                    errors.push(`message[${index}] tool message 缺少 tool_call_id`);
                    continue;
                }
                if (consumedToolCallIds.has(toolCallId)) {
                    errors.push(`message[${index}] tool message 重复: ${toolCallId}`);
                    continue;
                }
                if (!outstandingToolCallIds.has(toolCallId)) {
                    errors.push(`message[${index}] tool message 孤儿: ${toolCallId}`);
                    continue;
                }

                consumedToolCallIds.add(toolCallId);
                outstandingToolCallIds.delete(toolCallId);
            }
        }

        if (outstandingToolCallIds.size > 0) {
            errors.push(`assistant tool_calls 缺少对应 tool message: ${[...outstandingToolCallIds].join(", ")}`);
        }

        if (errors.length > 0) {
            throw new Error(`Agent prompt 校验失败: ${errors.join("; ")}`);
        }
    }

    /**
     * 规范化流式工具调用参数。
     */
    private _normalizeToolCallArguments(args: unknown): Record<string, unknown> {
        if (!args) {
            return {};
        }

        if (typeof args === "string") {
            try {
                const parsed = JSON.parse(args);

                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>;
                }
            } catch {
                return {};
            }
        }

        if (typeof args === "object" && !Array.isArray(args)) {
            return args as Record<string, unknown>;
        }

        return {};
    }

    /**
     * 合并同一个 tool_call 的流式增量参数（深度合并，保留嵌套结构）。
     */
    private _mergeToolCallArguments(
        base: Record<string, unknown>,
        delta: Record<string, unknown>
    ): Record<string, unknown> {
        const result = { ...base };

        for (const key of Object.keys(delta)) {
            const baseVal = result[key];
            const deltaVal = delta[key];

            if (
                baseVal != null &&
                typeof baseVal === "object" &&
                !Array.isArray(baseVal) &&
                deltaVal != null &&
                typeof deltaVal === "object" &&
                !Array.isArray(deltaVal)
            ) {
                result[key] = this._mergeToolCallArguments(
                    baseVal as Record<string, unknown>,
                    deltaVal as Record<string, unknown>
                );
            } else {
                result[key] = deltaVal;
            }
        }

        return result;
    }

    /**
     * 将工具 JSON Schema 的基础字段转换为 LangChain 可执行的 zod schema。
     */
    private _createToolInputSchema(definition: ToolDefinition): z.ZodObject<z.ZodRawShape> {
        const requiredFields = new Set(definition.function.parameters.required || []);
        const shape: z.ZodRawShape = {};

        for (const [name, propertyDefinition] of Object.entries(definition.function.parameters.properties)) {
            shape[name] = this._createToolPropertySchema(name, propertyDefinition, requiredFields.has(name));
        }

        return z.object(shape).passthrough();
    }

    /**
     * 转换单个工具参数字段，必填字符串同时拒绝空白内容。
     */
    private _createToolPropertySchema(
        name: string,
        propertyDefinition: unknown,
        isRequired: boolean
    ): z.ZodTypeAny {
        const propertyType =
            propertyDefinition && typeof propertyDefinition === "object"
                ? (propertyDefinition as { type?: string }).type
                : undefined;

        let schema: z.ZodTypeAny;

        switch (propertyType) {
            case "string":
                schema = z.string();
                if (isRequired) {
                    schema = schema.refine(value => value.trim().length > 0, {
                        message: `${name} 不能为空`
                    });
                }
                break;
            case "number":
                schema = z.number();
                break;
            case "integer":
                schema = z.number().int();
                break;
            case "boolean":
                schema = z.boolean();
                break;
            case "array":
                schema = z.array(z.unknown());
                break;
            case "object":
                schema = z.record(z.unknown());
                break;
            default:
                schema = z.unknown();
                break;
        }

        if (!isRequired) {
            schema = schema.optional();
        }

        return schema;
    }

    /**
     * 决定 LangGraph 下一跳节点。
     */
    private _getNextGraphNode(
        state: Pick<AgentGraphState, "messages" | "runToolRounds" | "maxToolRounds">
    ): "tools" | "maxRounds" | typeof END {
        const lastMessage = state.messages.at(-1);

        if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
            return END;
        }

        if (state.runToolRounds >= state.maxToolRounds) {
            return "maxRounds";
        }

        if (lastMessage.tool_calls?.length) {
            return "tools";
        }

        return END;
    }

    private async _callLLMStream(args: {
        messages: BaseMessage[];
        tools: any[];
        enabledTools: string[];
        conversationId: string;
        onChunk: (chunk: AgentStreamChunk) => void;
        temperature: number | undefined;
        maxTokens: number | undefined;
        abortSignal: AbortSignal | undefined;
    }): Promise<{ content: string; toolCalls: ToolCall[]; usage?: TokenUsage; reasoningContent?: string }> {
        let fullContent = "";
        let reasoningContentAcc = "";
        let lastChunk: any = null;

        const toolCallDrafts = new Map<
            string,
            {
                id: string;
                name: string;
                argumentsText: string;
                arguments: Record<string, unknown>;
            }
        >();
        const toolCallOrder: string[] = [];
        const getToolCallKey = (tc: any, index: number) => {
            const toolCallIndex = typeof tc?.index === "number" ? tc.index : index;

            return `index:${toolCallIndex}`;
        };
        const getOrCreateToolCallDraft = (tc: any, index: number) => {
            const toolCallKey = getToolCallKey(tc, index);
            let draft = toolCallDrafts.get(toolCallKey);

            if (!draft) {
                toolCallOrder.push(toolCallKey);
                draft = {
                    id: tc.id || `tool-call-${index}`,
                    name: tc.name || "",
                    argumentsText: "",
                    arguments: {}
                };
                toolCallDrafts.set(toolCallKey, draft);
            }

            if (tc.id) {
                draft.id = tc.id;
            }
            if (tc.name) {
                draft.name = tc.name;
            }

            return draft;
        };

        const stream = await this.textGeneratorService.streamWithMessages(
            undefined,
            args.messages,
            args.tools,
            args.temperature,
            args.maxTokens,
            args.abortSignal
        );

        for await (const chunk of stream) {
            lastChunk = chunk;

            if (args.abortSignal?.aborted) {
                break;
            }

            if (typeof chunk.content === "string" && chunk.content) {
                fullContent += chunk.content;
                args.onChunk({
                    type: "token",
                    ts: Date.now(),
                    conversationId: args.conversationId,
                    content: chunk.content
                });
            }

            // 从 raw response 中提取 reasoning_content（DeepSeek thinking 模式）
            const rawDelta = chunk.additional_kwargs?.__raw_response?.choices?.[0]?.delta;

            if (rawDelta?.reasoning_content) {
                reasoningContentAcc += rawDelta.reasoning_content;
            }

            if (chunk.tool_calls && chunk.tool_calls.length > 0) {
                for (const [index, tc] of chunk.tool_calls.entries()) {
                    const draft = getOrCreateToolCallDraft(tc, index);
                    const toolArgs = this._normalizeToolCallArguments(tc.args);

                    if (Object.keys(toolArgs).length > 0) {
                        draft.arguments = this._mergeToolCallArguments(draft.arguments, toolArgs);
                    }
                }
            }

            if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
                for (const [index, tc] of chunk.tool_call_chunks.entries()) {
                    const draft = getOrCreateToolCallDraft(tc, index);

                    if (typeof tc.args === "string" && tc.args) {
                        draft.argumentsText += tc.args;
                    }
                    const toolArgs = this._normalizeToolCallArguments(draft.argumentsText || tc.args);

                    if (Object.keys(toolArgs).length > 0) {
                        draft.arguments = this._mergeToolCallArguments(draft.arguments, toolArgs);
                    }
                }
            }
        }

        const usage = this._extractUsage(lastChunk, args.messages, fullContent);
        const toolCalls: ToolCall[] = toolCallOrder
            .map(key => toolCallDrafts.get(key))
            .filter((draft): draft is NonNullable<typeof draft> => Boolean(draft))
            .filter(draft => args.enabledTools.includes(draft.name))
            .map(draft => ({
                id: draft.id,
                name: draft.name,
                arguments: draft.arguments
            }));

        let normalizedToolCalls = this._normalizeToolCallIds(toolCalls);

        // 兼容：部分模型/渠道不支持原生 tool_calls，沿用旧实现的"文本工具调用"兜底
        if (normalizedToolCalls.toolCalls.length === 0 && fullContent) {
            const parsed = ToolCallParser.parseToolCalls(fullContent);

            if (parsed.length > 0) {
                const filtered = parsed.filter(tc => args.enabledTools.includes(tc.name));

                if (filtered.length > 0) {
                    this.LOGGER.info(`从文本中解析到 ${filtered.length} 个工具调用(已按 enabledTools 过滤)`);
                    normalizedToolCalls = this._normalizeToolCallIds(filtered);
                }
            }
        }

        for (const rewrite of normalizedToolCalls.rewrites) {
            this.LOGGER.warning(
                `改写重复 tool_call id: ${rewrite.originalId} -> ${rewrite.newId}，工具: ${rewrite.toolName}`
            );
        }

        for (const tc of normalizedToolCalls.toolCalls) {
            args.onChunk({
                type: "tool_call",
                ts: Date.now(),
                conversationId: args.conversationId,
                toolCallId: tc.id,
                toolName: tc.name,
                toolArgs: tc.arguments
            });
        }

        return {
            content: fullContent,
            toolCalls: normalizedToolCalls.toolCalls,
            usage,
            reasoningContent: reasoningContentAcc
        };
    }

    /**
     * 执行 Agent（流式）
     * 兼容旧版签名：historyMessages 参数会被忽略（对话历史由 checkpointer + thread_id 维护）。
     */
    public async executeStream(
        userMessage: string,
        context: ToolContext,
        onChunk: (chunk: AgentStreamChunk) => void,
        config: AgentConfig = {},
        historyMessages: { role: string; content: string }[] = [],
        systemPrompt?: string,
        modelName?: string
    ): Promise<AgentResult> {
        void historyMessages;
        void modelName;

        const maxToolRounds = config.maxToolRounds ?? 20;
        const enabledTools = config.enabledTools ?? [];
        const recursionLimit = Math.max(25, maxToolRounds * 2 + 5);

        // thread_id 必须稳定：优先使用 conversationId。RagRPCImpl 会保证 conversationId 已存在。
        const conversationId = String((context as any).conversationId || crypto.randomUUID());

        const initialUsage: TokenUsage = this._createEmptyUsage();

        const AgentState = Annotation.Root({
            messages: Annotation<BaseMessage[]>({
                reducer: messagesStateReducer,
                default: () => []
            }),
            systemPrompt: Annotation<string>,
            enabledTools: Annotation<string[]>,
            maxToolRounds: Annotation<number>,
            toolContext: Annotation<ToolContext>,
            runToolRounds: Annotation<number>,
            runToolsUsed: Annotation<string[]>,
            runTotalUsage: Annotation<TokenUsage>
        });

        const llmCall = async (state: AgentGraphState): Promise<Partial<AgentGraphState>> => {
            if (config.abortSignal?.aborted) {
                throw new Error("执行被用户中止");
            }

            const tools = this.agentToolCatalog.getEnabledToolDefinitions(state.enabledTools);

            const promptMessages: BaseMessage[] = [];

            if (state.systemPrompt) {
                promptMessages.push(new SystemMessage(state.systemPrompt));
            }
            promptMessages.push(...state.messages);

            const normalizedPromptMessages = this._normalizePromptMessages(promptMessages);

            this._validatePromptMessages(normalizedPromptMessages);

            if (state.runToolRounds === 0) {
                this.LOGGER.info(`本轮启用工具: ${tools.map(t => t.function.name).join(", ") || "无"}`);
                this.LOGGER.debug(
                    "发送给 LLM 的 messages: " +
                        util.inspect(this._formatMessagesForLog(normalizedPromptMessages), {
                            depth: null,
                            maxArrayLength: 50,
                            maxStringLength: 2000
                        })
                );
            }

            const { content, toolCalls, usage, reasoningContent } = await this._callLLMStream({
                messages: normalizedPromptMessages,
                tools,
                enabledTools: state.enabledTools,
                conversationId,
                onChunk,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
                abortSignal: config.abortSignal
            });

            // 将 reasoning_content 注入 AIMessage 并注册到全局 registry，
            // 确保后续 LLM 调用时能通过自定义 fetch 回传给 DeepSeek API。
            // DeepSeek 要求 ALL assistant 消息的 reasoning_content 在每次调用中都回传。
            const aiMessageAdditionalKwargs: Record<string, unknown> = {};

            if (reasoningContent) {
                aiMessageAdditionalKwargs.reasoning_content = reasoningContent;
                registerReasoningContent(
                    {
                        content: content || "",
                        tool_calls: toolCalls.map(tc => ({
                            id: tc.id,
                            name: tc.name,
                            args: tc.arguments
                        }))
                    },
                    reasoningContent
                );
            }

            const aiMessage = new AIMessage({
                content: content || "",
                tool_calls: toolCalls.map(tc => ({
                    id: tc.id,
                    name: tc.name,
                    args: tc.arguments
                })),
                additional_kwargs: aiMessageAdditionalKwargs
            });

            return {
                messages: [aiMessage],
                runToolRounds: state.runToolRounds + 1,
                runTotalUsage: this._mergeUsage(state.runTotalUsage, usage)
            };
        };

        // 使用 LangGraph 官方 ToolNode 执行工具，避免自造轮子。
        const enabledToolDefinitions = this.agentToolCatalog.getEnabledToolDefinitions(enabledTools);
        const langChainTools = enabledToolDefinitions.map(def => {
            const toolName = def.function.name;

            return new DynamicStructuredTool({
                name: toolName,
                description: def.function.description,
                schema: this._createToolInputSchema(def),
                func: async (input: Record<string, unknown>) => {
                    if (config.abortSignal?.aborted) {
                        throw new Error("执行被用户中止");
                    }

                    try {
                        return await this.agentToolCatalog.executeTool(toolName, input, context, enabledTools);
                    } catch (e) {
                        const errorMessage = e instanceof Error ? e.message : String(e);

                        return { error: errorMessage };
                    }
                }
            });
        });

        const lgToolNode = new ToolNode(langChainTools, { handleToolErrors: true });

        const toolsNode = async (state: AgentGraphState): Promise<Partial<AgentGraphState>> => {
            const normalizedStateMessages = this._normalizePromptMessages(state.messages);
            const lastMessage = normalizedStateMessages.at(-1);

            if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
                return {};
            }

            const toolCalls = lastMessage.tool_calls ?? [];

            if (toolCalls.length === 0) {
                return {};
            }

            const toolCallIdToName = new Map<string, string>();

            for (const tc of toolCalls) {
                if (tc?.id && tc?.name) {
                    toolCallIdToName.set(String(tc.id), String(tc.name));
                }
            }

            // 审阅展示：tool_call 事件已由 LLM streaming 发出。这里补齐 toolsUsed 统计。
            let toolsUsed = state.runToolsUsed;

            for (const tc of toolCalls) {
                toolsUsed = this._addUnique(toolsUsed, tc.name);
            }

            const output = (await lgToolNode.invoke({ messages: normalizedStateMessages })) as any;
            const produced = Array.isArray(output) ? output : output?.messages;
            const toolMessages = (produced || []).filter((m: any) => ToolMessage.isInstance(m)) as ToolMessage[];

            // 将 ToolNode 的执行结果转换为稳定业务事件 tool_result（用于前端审阅展示）
            for (const tm of toolMessages) {
                const anyMsg = tm as any;
                const toolCallId = String(anyMsg?.tool_call_id || "");

                if (!toolCallId) {
                    continue;
                }

                const toolName = toolCallIdToName.get(toolCallId) || String(anyMsg?.name || "");

                let result: unknown = anyMsg?.content;

                if (typeof result === "string") {
                    try {
                        result = JSON.parse(result);
                    } catch {
                        // keep raw string
                    }
                }

                onChunk({
                    type: "tool_result",
                    ts: Date.now(),
                    conversationId,
                    toolCallId,
                    toolName,
                    result
                });
            }

            return {
                messages: toolMessages,
                runToolsUsed: toolsUsed
            };
        };

        const maxRoundsNode = async (): Promise<Partial<AgentGraphState>> => {
            return {
                messages: [new AIMessage("已达到最大工具调用轮数限制，请简化问题或重新提问。")]
            };
        };

        const shouldContinue = (state: AgentGraphState): "tools" | "maxRounds" | typeof END =>
            this._getNextGraphNode(state);

        const workflow = new StateGraph(AgentState)
            .addNode("llmCall", llmCall as any)
            .addNode("tools", toolsNode as any)
            .addNode("maxRounds", maxRoundsNode as any)
            .addEdge(START, "llmCall")
            .addConditionalEdges("llmCall", shouldContinue as any, ["tools", "maxRounds", END])
            .addEdge("tools", "llmCall")
            .addEdge("maxRounds", END);

        const checkpointer = await this.checkpointerService.getCheckpointer();
        const graph = workflow.compile({ checkpointer });

        try {
            const resultState = (await graph.invoke(
                {
                    messages: [new HumanMessage(userMessage)],
                    systemPrompt: systemPrompt || "",
                    enabledTools,
                    maxToolRounds,
                    toolContext: context,
                    runToolRounds: 0,
                    runToolsUsed: [],
                    runTotalUsage: initialUsage
                },
                {
                    configurable: {
                        thread_id: conversationId
                    },
                    recursionLimit,
                    signal: config.abortSignal
                } as any
            )) as AgentGraphState;

            const last = resultState.messages.at(-1);
            const finalContent = last && AIMessage.isInstance(last) ? String((last as any).content || "") : "";

            return {
                content: finalContent,
                toolsUsed: resultState.runToolsUsed,
                toolRounds: resultState.runToolRounds,
                totalUsage: resultState.runTotalUsage
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);

            this.LOGGER.error(`Agent 执行出错: ${msg}`);
            onChunk({ type: "error", ts: Date.now(), conversationId, error: msg });
            throw error;
        }
    }

    /**
     * 获取 checkpoint 历史（用于 time-travel / 调试）
     */
    public async getStateHistory(params: {
        conversationId: string;
        limit: number;
        beforeCheckpointId?: string;
    }): Promise<{
        items: Array<{ checkpointId: string; createdAt: number; next: string[]; metadata?: unknown }>;
        nextCursor?: string;
    }> {
        const checkpointer = await this.checkpointerService.getCheckpointer();

        // 复用同一套 workflow 结构（无需绑定实际工具，仅用于读取 checkpoint）
        const AgentState = Annotation.Root({
            messages: Annotation<BaseMessage[]>({
                reducer: messagesStateReducer,
                default: () => []
            }),
            systemPrompt: Annotation<string>,
            enabledTools: Annotation<string[]>,
            maxToolRounds: Annotation<number>,
            toolContext: Annotation<ToolContext>,
            runToolRounds: Annotation<number>,
            runToolsUsed: Annotation<string[]>,
            runTotalUsage: Annotation<TokenUsage>
        });

        const workflow = new StateGraph(AgentState)
            .addNode("noop", async () => ({}))
            .addEdge(START, "noop")
            .addEdge("noop", END);

        const graph = workflow.compile({ checkpointer });

        const baseConfig: any = {
            configurable: {
                thread_id: params.conversationId
            }
        };

        const options: any = {
            limit: params.limit
        };

        if (params.beforeCheckpointId) {
            options.before = {
                configurable: {
                    thread_id: params.conversationId,
                    checkpoint_id: params.beforeCheckpointId
                }
            };
        }

        const items: Array<{ checkpointId: string; createdAt: number; next: string[]; metadata?: unknown }> = [];
        let nextCursor: string | undefined;

        for await (const snapshot of graph.getStateHistory(baseConfig, options)) {
            const cfg: any = snapshot.config as any;
            const checkpointId = String(cfg?.configurable?.checkpoint_id || "");

            if (!checkpointId) {
                continue;
            }

            const createdAtMs = snapshot.createdAt ? Date.parse(snapshot.createdAt) : Date.now();

            items.push({
                checkpointId,
                createdAt: Number.isNaN(createdAtMs) ? Date.now() : createdAtMs,
                next: snapshot.next || [],
                metadata: snapshot.metadata
            });
            nextCursor = checkpointId;
        }

        return {
            items,
            nextCursor
        };
    }

    /**
     * 从指定 checkpoint fork 新 thread
     */
    public async forkFromCheckpoint(params: {
        conversationId: string;
        checkpointId: string;
        newConversationId?: string;
    }): Promise<{ conversationId: string }> {
        const checkpointer = await this.checkpointerService.getCheckpointer();

        const AgentState = Annotation.Root({
            messages: Annotation<BaseMessage[]>({
                reducer: messagesStateReducer,
                default: () => []
            }),
            systemPrompt: Annotation<string>,
            enabledTools: Annotation<string[]>,
            maxToolRounds: Annotation<number>,
            toolContext: Annotation<ToolContext>,
            runToolRounds: Annotation<number>,
            runToolsUsed: Annotation<string[]>,
            runTotalUsage: Annotation<TokenUsage>
        });

        const workflow = new StateGraph(AgentState)
            .addNode("noop", async () => ({}))
            .addEdge(START, "noop")
            .addEdge("noop", END);

        const graph = workflow.compile({ checkpointer });

        const sourceConfig: any = {
            configurable: {
                thread_id: params.conversationId,
                checkpoint_id: params.checkpointId
            }
        };

        const snapshot = await graph.getState(sourceConfig);
        const newConversationId = params.newConversationId || crypto.randomUUID();

        await graph.updateState(
            {
                configurable: {
                    thread_id: newConversationId
                }
            } as any,
            snapshot.values,
            "fork"
        );

        return {
            conversationId: newConversationId
        };
    }
}
