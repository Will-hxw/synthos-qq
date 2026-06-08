import "reflect-metadata";
import type { GlobalConfig, ModelConfig } from "@root/common/services/config/schemas/GlobalConfig";

import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

import { injectable, inject } from "tsyringe";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import ErrorReasons from "@root/common/contracts/ErrorReasons";
import Logger from "@root/common/util/Logger";
import { Disposable } from "@root/common/util/lifecycle/Disposable";
import { mustInitBeforeUse } from "@root/common/util/lifecycle/mustInitBeforeUse";
import { sleep } from "@root/common/util/promisify/sleep";
import { COMMON_TOKENS } from "@root/common/di/tokens";

import { JsonPromptStore } from "../../../context/prompts/JsonPromptStore";

/**
 * DeepSeek thinking 模式需要 reasoning_content 在多轮对话中被回传。
 * @langchain/openai@1.x 不处理该字段，因此在自定义 fetch 中按 assistant 消息指纹补回。
 */
const REASONING_REGISTRY_MAX_SIZE = 100;
const reasoningRegistry = new Map<string, string>();

interface AssistantReasoningMessagePayload {
    content?: unknown;
    tool_calls?: unknown[];
}

function stableSerialize(value: unknown): string {
    if (value === undefined) {
        return "null";
    }

    if (typeof value === "bigint") {
        return JSON.stringify(value.toString());
    }

    if (typeof value === "function" || typeof value === "symbol") {
        return JSON.stringify(String(value));
    }

    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }

    if (Array.isArray(value)) {
        return `[${value.map(item => stableSerialize(item)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();

    return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function normalizeToolCallArguments(toolCall: Record<string, unknown>): unknown {
    const fn =
        toolCall.function && typeof toolCall.function === "object"
            ? (toolCall.function as Record<string, unknown>)
            : undefined;
    const rawArguments = toolCall.args ?? toolCall.arguments ?? fn?.arguments ?? {};

    if (typeof rawArguments === "string") {
        try {
            return JSON.parse(rawArguments);
        } catch {
            return rawArguments;
        }
    }

    return rawArguments;
}

function normalizeToolCallForReasoning(toolCall: unknown): Record<string, unknown> {
    const record = toolCall && typeof toolCall === "object" ? (toolCall as Record<string, unknown>) : {};
    const fn =
        record.function && typeof record.function === "object"
            ? (record.function as Record<string, unknown>)
            : undefined;

    return {
        id: typeof record.id === "string" ? record.id : "",
        name: typeof record.name === "string" ? record.name : typeof fn?.name === "string" ? fn.name : "",
        arguments: normalizeToolCallArguments(record)
    };
}

export function createAssistantMessageReasoningKey(payload: AssistantReasoningMessagePayload): string {
    const toolCalls = Array.isArray(payload.tool_calls)
        ? payload.tool_calls.map(toolCall => normalizeToolCallForReasoning(toolCall))
        : [];

    return stableSerialize({
        content: payload.content ?? "",
        tool_calls: toolCalls
    });
}

/** 注册某条 assistant 消息对应的 reasoning_content。 */
export function registerReasoningContent(
    message: AssistantReasoningMessagePayload | string,
    reasoningContent: string
): void {
    if (!reasoningContent) {
        return;
    }

    const key = typeof message === "string" ? message : createAssistantMessageReasoningKey(message);

    if (key) {
        reasoningRegistry.set(key, reasoningContent);
    }
}

function trimReasoningRegistry(): void {
    while (reasoningRegistry.size > REASONING_REGISTRY_MAX_SIZE) {
        const firstKey = reasoningRegistry.keys().next().value as string | undefined;

        if (!firstKey) {
            break;
        }
        reasoningRegistry.delete(firstKey);
    }
}

function getAssistantToolCallId(toolCall: unknown): string {
    if (!toolCall || typeof toolCall !== "object") {
        return "";
    }

    const id = (toolCall as Record<string, unknown>).id;

    return typeof id === "string" ? id : "";
}

function validateReasoningAwareMessages(messages: unknown[]): void {
    const errors: string[] = [];
    const allToolCallIds = new Set<string>();
    const outstandingToolCallIds = new Set<string>();
    const consumedToolCallIds = new Set<string>();

    for (const [index, message] of messages.entries()) {
        if (!message || typeof message !== "object") {
            continue;
        }

        const msg = message as Record<string, unknown>;

        if (msg.role === "assistant") {
            const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

            if (toolCalls.length === 0) {
                continue;
            }

            if (typeof msg.reasoning_content !== "string" || msg.reasoning_content.length === 0) {
                errors.push(`message[${index}] assistant tool_calls 缺少 reasoning_content`);
            }

            const idsInMessage = new Set<string>();

            for (const toolCall of toolCalls) {
                const toolCallId = getAssistantToolCallId(toolCall);

                if (!toolCallId) {
                    errors.push(`message[${index}] assistant tool_call 缺少 id`);
                    continue;
                }
                if (idsInMessage.has(toolCallId)) {
                    errors.push(`message[${index}] assistant tool_call_id 重复: ${toolCallId}`);
                }
                if (allToolCallIds.has(toolCallId)) {
                    errors.push(`message[${index}] tool_call_id 全局重复: ${toolCallId}`);
                }

                idsInMessage.add(toolCallId);
                allToolCallIds.add(toolCallId);
                outstandingToolCallIds.add(toolCallId);
            }
            continue;
        }

        if (msg.role === "tool") {
            const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";

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
        throw new Error(`Agent 请求体校验失败: ${errors.join("; ")}`);
    }
}

function createReasoningAwareFetch(): typeof fetch {
    const realFetch = globalThis.fetch;

    return async (input, init) => {
        if (init?.body && typeof init.body === "string") {
            let body: any;

            try {
                body = JSON.parse(init.body);
            } catch {
                return realFetch(input, init);
            }

            if (body.messages && Array.isArray(body.messages)) {
                body.messages = body.messages.map((msg: Record<string, unknown>) => {
                    if (msg.role === "assistant") {
                        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

                        if (toolCalls.length > 0 && typeof msg.reasoning_content !== "string") {
                            const reasoningContent = reasoningRegistry.get(
                                createAssistantMessageReasoningKey({
                                    content: msg.content,
                                    tool_calls: toolCalls
                                })
                            );

                            if (reasoningContent) {
                                return { ...msg, reasoning_content: reasoningContent };
                            }
                        }
                    }

                    return msg;
                });
                validateReasoningAwareMessages(body.messages);
                init = { ...init, body: JSON.stringify(body) };
            }
        }

        trimReasoningRegistry();

        return realFetch(input, init);
    };
}

type JsonFailureStage =
    | "raw_validation_failed"
    | "raw_non_json"
    | "raw_provider_rejection"
    | "raw_json_with_provider_rejection_suffix"
    | "repair_validation_failed"
    | "repair_provider_rejection";

export interface JsonFailureDiagnosticContext {
    groupId?: string;
    sessionId?: string;
}

interface JsonFailureRecord {
    timestamp: string;
    modelName: string;
    stage: JsonFailureStage;
    parseError: string;
    originalParseError?: string;
    rawOutput: string;
    rawOutputLength: number;
    repairedOutput: string;
    repairedOutputLength: number;
    selectedFallbackAction: string;
    groupId?: string;
    sessionId?: string;
}

type ChatOpenAIConstructorOptions = ConstructorParameters<typeof ChatOpenAI>[0];

class JsonRepairFailureError extends Error {
    public constructor(
        public readonly originalParseError: unknown,
        public readonly repairError: unknown,
        public readonly invalidJson: string,
        public readonly repairedResultStr: string,
        public readonly repairStage: JsonFailureStage
    ) {
        super("JSON 修复失败");
        this.name = "JsonRepairFailureError";
    }
}

/**
 * 文本生成器
 * 提供基于 LLM 的文本生成能力，支持多模型候选和重试机制
 */
@injectable()
@mustInitBeforeUse
export class TextGeneratorService extends Disposable {
    private models = new Map<string, ChatOpenAI>();
    private activeModel: ChatOpenAI | null = null;
    private LOGGER = Logger.withTag("TextGeneratorService");

    /**
     * 构造函数
     * @param configManagerService 配置管理服务
     */
    public constructor(
        @inject(COMMON_TOKENS.ConfigManagerService) private configManagerService: ConfigManagerService
    ) {
        super();
    }

    /**
     * 初始化文本生成器
     */
    public async init() {
        this._registerDisposableFunction(() => {
            // LangChain 的 ChatOpenAI 通常不需要显式关闭，但可以清空模型缓存
            this.models.clear();
            this.activeModel = null;
        });
        // 可选：预加载默认模型，或留空由 useModel 懒加载
    }

    /**
     * 获取指定模型配置，未单独配置时回退到默认模型配置。
     */
    private _getModelConfig(config: GlobalConfig, modelName: string): ModelConfig {
        return config.ai.models[modelName] ?? config.ai.defaultModelConfig;
    }

    /**
     * 统一组装 ChatOpenAI 参数，仅在模型显式启用时透传 reasoning。
     */
    private _buildChatOpenAIOptions(
        config: GlobalConfig,
        modelName: string,
        temperature?: number,
        maxTokens?: number
    ): ChatOpenAIConstructorOptions {
        const modelConfig = this._getModelConfig(config, modelName);
        const options: ChatOpenAIConstructorOptions = {
            openAIApiKey: modelConfig.apiKey,
            apiKey: modelConfig.apiKey,
            configuration: {
                baseURL: modelConfig.baseURL
            },
            model: modelName,
            temperature: temperature ?? modelConfig.temperature,
            maxTokens: maxTokens ?? modelConfig.maxTokens
        };

        // DeepSeek thinking 模式：API 返回 reasoning_content，多轮对话中必须回传。
        // @langchain/openai@1.x 不处理该字段 → 通过自定义 fetch 注入 reasoning_content，
        // 并开启 includeRawResponse 以便在消费端捕捉 reasoning_content。
        options.__includeRawResponse = true;
        options.configuration = {
            ...options.configuration,
            fetch: createReasoningAwareFetch()
        };

        if (!modelConfig.reasoning.enabled) {
            return options;
        }

        return {
            ...options,
            reasoning: {
                effort: modelConfig.reasoning.effort
            }
        };
    }

    private async useModel(modelName: string) {
        // 懒加载：当需要使用某个模型时才创建实例
        if (!this.models.has(modelName)) {
            const config = await this.configManagerService.getCurrentConfig();
            const chatModel = new ChatOpenAI(this._buildChatOpenAIOptions(config, modelName));

            this.models.set(modelName, chatModel);
            this.LOGGER.info(`Model ${modelName} 成功加载.`);
        }
        this.activeModel = this.models.get(modelName)!;
    }

    /**
     * 生成文本
     * @param modelName 模型名称
     * @param input 用户输入
     * @returns 生成的文本
     */
    private async doGenerateText(modelName: string, input: string): Promise<string> {
        try {
            await this.useModel(modelName);
            if (!this.activeModel) {
                throw ErrorReasons.UNINITIALIZED_ERROR;
            }

            const response = await this.activeModel.invoke([{ role: "user", content: input }]);

            return response.content as string;
        } catch (error) {
            this.LOGGER.warning(
                `模型 ${modelName} 单次文本生成失败，错误信息为：${this._formatUnknownError(error)}`
            );
            throw error;
        }
    }

    /**
     * 生成文本。内部使用langchain的流式特性，但是对外的行为和doGenerateText一致。
     * @param modelName 模型名称
     * @param input 用户输入
     * @returns 生成的文本流
     */
    private async doGenerateTextStream(modelName: string, input: string): Promise<string> {
        let fullContent = "";

        await this.doStreamText(modelName, input, chunk => {
            fullContent += chunk;
        });

        return fullContent;
    }

    /**
     * 执行底层的流式生成
     */
    private async doStreamText(
        modelName: string,
        input: string,
        onChunk: (chunk: string) => void
    ): Promise<string> {
        try {
            await this.useModel(modelName);
            if (!this.activeModel) {
                throw ErrorReasons.UNINITIALIZED_ERROR;
            }

            let fullContent = "";
            const stream = await this.activeModel.stream([{ role: "user", content: input }]);

            for await (const chunk of stream) {
                // chunk 是 AIMessageChunk，其 content 是字符串片段
                if (typeof chunk.content === "string") {
                    fullContent += chunk.content;
                    onChunk(chunk.content);
                }
            }

            return fullContent;
        } catch (error) {
            this.LOGGER.warning(
                `模型 ${modelName} 单次流式文本生成失败，错误信息为：${this._formatUnknownError(error)}`
            );
            throw error;
        }
    }

    /**
     * 按传入顺序对模型列表去重，并拒绝空候选。
     */
    private _dedupeModelNames(modelNames: string[]): string[] {
        const deduped = [...new Set(modelNames)];

        if (deduped.length === 0) {
            throw new Error("模型候选列表不能为空");
        }

        return deduped;
    }

    /**
     * 普通文本生成候选列表：保序去重后重复三轮，保留既有重试语义。
     */
    private _buildRepeatedModelCandidates(modelNames: string[]): string[] {
        const deduped = this._dedupeModelNames(modelNames);

        return [...deduped, ...deduped, ...deduped];
    }

    /**
     * 无状态的、带重试机制的、带候选机制的流式文本生成方法
     * @param modelNames 模型候选列表
     * @param input 输入文本
     * @param onChunk 流式回调
     */
    public async generateTextStreamWithModelCandidates(
        modelNames: string[],
        input: string,
        onChunk: (chunk: string) => void
    ): Promise<{
        selectedModelName: string;
        content: string;
    }> {
        const modelCandidates = this._buildRepeatedModelCandidates(modelNames);
        let resultStr = "";
        let selectedModelName = "";

        for (const modelName of modelCandidates) {
            try {
                // 重置当前模型的累积结果
                let currentModelContent = "";

                await this.doStreamText(modelName, input, chunk => {
                    currentModelContent += chunk;
                    onChunk(chunk);
                });

                resultStr = currentModelContent;
                if (resultStr) {
                    selectedModelName = modelName;
                    break;
                }
            } catch (error) {
                this.LOGGER.warning(
                    `模型 ${modelName} 流式生成失败，错误信息为：${this._formatUnknownError(error)}，尝试下一个模型`
                );
                // 继续尝试下一个模型
            }
        }

        if (!resultStr) {
            throw ErrorReasons.ALL_MODELS_FAILED;
        }

        return {
            selectedModelName,
            content: resultStr
        };
    }

    /**
     * 剥离完整包裹 JSON 内容的 markdown 代码围栏
     * @param content 模型返回内容
     * @returns 去除围栏后的 JSON 字符串
     */
    private _stripJsonCodeFence(content: string): string {
        const trimmedContent = content.trim();

        if (!trimmedContent.startsWith("```") || !trimmedContent.endsWith("```")) {
            return trimmedContent;
        }

        const normalizedContent = trimmedContent.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        const lines = normalizedContent.split("\n");

        if (lines.length < 2) {
            return trimmedContent;
        }

        const openingFence = lines[0].trim().toLowerCase();
        const closingFence = lines[lines.length - 1].trim();

        if (openingFence !== "```json" && openingFence !== "```") {
            return trimmedContent;
        }

        if (closingFence !== "```") {
            return trimmedContent;
        }

        return lines
            .slice(1, lines.length - 1)
            .join("\n")
            .trim();
    }

    /**
     * 校验并规范化模型返回的 JSON 内容。
     * checkJsonFormat 场景下游（摘要任务）按数组遍历结果，因此这里不仅要求可被 JSON.parse，
     * 还要求解析结果是数组：`{}`、`{"error":...}`、`null`、字符串等虽是合法 JSON 但不符合契约，
     * 必须判为非法以触发 JSON 修复重试，避免脏数据/空写流入下游。
     * @param content 模型返回内容
     * @returns 可被 JSON.parse 解析且为数组的 JSON 字符串
     */
    private _validateJsonResult(content: string): string {
        const validatedResultStr = this._stripJsonCodeFence(content);

        const parsed = JSON.parse(validatedResultStr);

        if (!Array.isArray(parsed)) {
            throw new Error(`期望 JSON 数组，实际为 ${parsed === null ? "null" : typeof parsed}`);
        }

        return validatedResultStr;
    }

    /**
     * 判断模型输出是否为供应商/网关在 HTTP 200 下返回的拒绝类纯文本。
     * 这些文本不是非法 JSON,而是上游风控/审核的确定性拒绝,
     * 对同一模型重试和 JSON 修复均无意义,应立即切换到下一个候选模型。
     */
    private _isProviderRejection(content: string): boolean {
        const text = content.trim().toLowerCase();

        if (text.startsWith("{") || text.startsWith("[") || text.startsWith("```")) {
            return false;
        }

        return [
            "considered high risk",
            "request was rejected",
            "content policy",
            "content_filter",
            "risk control"
        ].some(kw => text.includes(kw));
    }

    /**
     * 判断错误是否为速率限制(429),仅此类错误需要退避后重试。
     */
    private _isRateLimitError(error: unknown): boolean {
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();

            return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
        }

        return false;
    }

    /**
     * 判断模型输出是否像 JSON，避免把普通错误文本包装成合法 JSON
     * @param content 模型返回内容
     * @returns 是否像 JSON 对象、数组或 JSON 代码围栏
     */
    private _looksLikeJsonPayload(content: string): boolean {
        const rawTrimmedContent = content.trim();
        const trimmedContent = this._stripJsonCodeFence(content);

        return (
            trimmedContent.startsWith("{") || trimmedContent.startsWith("[") || rawTrimmedContent.startsWith("```")
        );
    }

    /**
     * 提取被上游拒绝文本污染尾部的合法 JSON 数组前缀。
     * 仅当 JSON 前缀可解析为数组，且剩余尾部明确是 provider rejection 文本时才接受。
     * @param content 模型原始输出
     * @returns 可安全使用的 JSON 数组前缀；不满足严格条件时返回 null
     */
    private _tryExtractJsonArrayPrefixBeforeProviderRejection(content: string): string | null {
        const trimmedContent = content.trim();

        if (!trimmedContent.startsWith("[")) {
            return null;
        }

        for (let index = 0; index < trimmedContent.length; index++) {
            if (trimmedContent[index] !== "]") {
                continue;
            }

            const jsonPrefix = trimmedContent.slice(0, index + 1).trim();
            const suffix = trimmedContent.slice(index + 1).trim();

            if (suffix.length === 0 || !this._isProviderRejection(suffix)) {
                continue;
            }

            try {
                const parsed = JSON.parse(jsonPrefix);

                if (Array.isArray(parsed)) {
                    return jsonPrefix;
                }
            } catch {
                continue;
            }
        }

        return null;
    }

    /**
     * 格式化未知错误，避免日志和修复提示词丢失关键信息
     * @param error 未知错误
     * @returns 可读错误字符串
     */
    private _formatUnknownError(error: unknown): string {
        if (error instanceof Error) {
            return `${error.name}: ${error.message}`;
        }

        return String(error);
    }

    /**
     * 格式化日志预览，避免模型输出中的换行把单条日志切碎。
     * @param content 需要预览的内容
     * @param maxLength 最大字符数
     * @returns 单行预览文本
     */
    private _formatPreview(content: string, maxLength: number): string {
        return content
            .replaceAll("\r\n", "\\n")
            .replaceAll("\r", "\\n")
            .replaceAll("\n", "\\n")
            .slice(0, maxLength);
    }

    private _getDateString(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");

        return `${year}-${month}-${day}`;
    }

    private async _saveJsonFailureRecord(params: {
        logDirectory: string;
        modelName: string;
        stage: JsonFailureStage;
        parseError: unknown;
        originalParseError?: unknown;
        rawOutput: string;
        repairedOutput?: string;
        selectedFallbackAction: string;
        diagnosticContext?: JsonFailureDiagnosticContext;
    }): Promise<string | null> {
        const timestamp = new Date();
        const failureDir = join(params.logDirectory, "ai-model-json-failures");
        const filePath = join(failureDir, `${this._getDateString(timestamp)}.jsonl`);
        const repairedOutput = params.repairedOutput ?? "";
        const record: JsonFailureRecord = {
            timestamp: timestamp.toISOString(),
            modelName: params.modelName,
            stage: params.stage,
            parseError: this._formatUnknownError(params.parseError),
            rawOutput: params.rawOutput,
            rawOutputLength: params.rawOutput.length,
            repairedOutput,
            repairedOutputLength: repairedOutput.length,
            selectedFallbackAction: params.selectedFallbackAction,
            groupId: params.diagnosticContext?.groupId,
            sessionId: params.diagnosticContext?.sessionId
        };

        if (params.originalParseError !== undefined) {
            record.originalParseError = this._formatUnknownError(params.originalParseError);
        }

        try {
            await mkdir(failureDir, { recursive: true });
            await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");

            return filePath;
        } catch (error) {
            this.LOGGER.warning(
                `JSON 失败样本落盘失败，阶段=${params.stage}，模型=${params.modelName}，错误信息为：${this._formatUnknownError(error)}`
            );

            return null;
        }
    }

    private _formatJsonFailureLog(params: {
        modelName: string;
        stage: JsonFailureStage;
        parseError: unknown;
        rawOutput: string;
        repairedOutput?: string;
        selectedFallbackAction: string;
        savedFilePath: string | null;
    }): string {
        const repairedPart =
            params.repairedOutput !== undefined
                ? `，修复输出长度=${params.repairedOutput.length}，修复输出前200字符：${this._formatPreview(params.repairedOutput, 200)}`
                : "";
        const savedPath = params.savedFilePath ?? "保存失败";

        return `模型 ${params.modelName} JSON 输出诊断，阶段=${params.stage}，错误信息为：${this._formatUnknownError(params.parseError)}，原始输出长度=${params.rawOutput.length}，原始输出前200字符：${this._formatPreview(params.rawOutput, 200)}${repairedPart}，完整失败样本：${savedPath}，后续动作=${params.selectedFallbackAction}`;
    }

    /**
     * 尝试用同一模型修复非法 JSON 输出
     * @param modelName 模型名称
     * @param invalidJson 原始非法 JSON
     * @param parseError JSON.parse 报错
     * @returns 修复且通过校验的 JSON 字符串
     */
    private async _repairJsonResult(modelName: string, invalidJson: string, parseError: unknown): Promise<string> {
        const prompt = (
            await JsonPromptStore.getJsonRepairPrompt(invalidJson, this._formatUnknownError(parseError))
        ).serializeToString();
        let repairedResultStr = "";

        try {
            repairedResultStr = await this.doGenerateTextStream(modelName, prompt);

            if (this._isProviderRejection(repairedResultStr)) {
                throw new JsonRepairFailureError(
                    parseError,
                    new Error("JSON 修复请求被上游网关/风控拒绝"),
                    invalidJson,
                    repairedResultStr,
                    "repair_provider_rejection"
                );
            }

            try {
                return this._validateJsonResult(repairedResultStr);
            } catch (repairError) {
                throw new JsonRepairFailureError(
                    parseError,
                    repairError,
                    invalidJson,
                    repairedResultStr,
                    "repair_validation_failed"
                );
            }
        } catch (error) {
            if (error instanceof JsonRepairFailureError) {
                throw error;
            }

            throw new JsonRepairFailureError(
                parseError,
                error,
                invalidJson,
                repairedResultStr,
                "repair_validation_failed"
            );
        }
    }

    /**
     * 无状态的、带重试机制的、带候选机制的文本生成方法
     * @param modelNames 模型候选列表，不能为空，按调用方传入顺序保序去重后重试
     * @param input 输入文本
     * @param 是否对输出强校验json格式
     * @returns
     */
    public async generateTextWithModelCandidates(
        modelNames: string[],
        input: string,
        checkJsonFormat: boolean = false,
        diagnosticContext?: JsonFailureDiagnosticContext
    ): Promise<{
        selectedModelName: string;
        content: string;
    }> {
        // 去重后整表重复3次：单次风控拒绝不代表下次还拒，给每个模型多次机会
        const modelCandidates = this._buildRepeatedModelCandidates(modelNames);
        const config = await this.configManagerService.getCurrentConfig();
        let resultStr = "";
        let selectedModelName = "";
        const MAX_RATE_LIMIT_RETRIES = 2;

        for (const modelName of modelCandidates) {
            let rateLimitRetries = 0;

            // 内层循环仅处理限流重试；其余错误直接换下一个候选模型
            while (true) {
                let rawOutput = "";

                try {
                    rawOutput = await this.doGenerateTextStream(modelName, input);

                    if (!rawOutput) {
                        throw new Error(`生成的摘要为空`);
                    }

                    // 风控/网关拒绝：不可通过重试解决，立即切换到下一个模型
                    if (checkJsonFormat && this._isProviderRejection(rawOutput)) {
                        const error = new Error("上游网关/风控拒绝");
                        const savedFilePath = await this._saveJsonFailureRecord({
                            logDirectory: config.logger.logDirectory,
                            modelName,
                            stage: "raw_provider_rejection",
                            parseError: error,
                            rawOutput,
                            selectedFallbackAction: "switch_model",
                            diagnosticContext
                        });

                        this.LOGGER.info(
                            `模型 ${modelName} 被上游网关/风控拒绝，${this._formatJsonFailureLog({
                                modelName,
                                stage: "raw_provider_rejection",
                                parseError: error,
                                rawOutput,
                                selectedFallbackAction: "switch_model",
                                savedFilePath
                            })}`
                        );
                        break;
                    }

                    let validatedResultStr = rawOutput;

                    if (checkJsonFormat) {
                        try {
                            validatedResultStr = this._validateJsonResult(rawOutput);
                        } catch (parseError) {
                            const jsonPrefix = this._tryExtractJsonArrayPrefixBeforeProviderRejection(rawOutput);

                            if (jsonPrefix !== null) {
                                const savedFilePath = await this._saveJsonFailureRecord({
                                    logDirectory: config.logger.logDirectory,
                                    modelName,
                                    stage: "raw_json_with_provider_rejection_suffix",
                                    parseError,
                                    rawOutput,
                                    selectedFallbackAction: "accept_json_prefix",
                                    diagnosticContext
                                });

                                this.LOGGER.warning(
                                    `${this._formatJsonFailureLog({
                                        modelName,
                                        stage: "raw_json_with_provider_rejection_suffix",
                                        parseError,
                                        rawOutput,
                                        selectedFallbackAction: "accept_json_prefix",
                                        savedFilePath
                                    })}，已截断上游拒绝文本尾部并使用合法 JSON 前缀`
                                );
                                validatedResultStr = jsonPrefix;
                                resultStr = validatedResultStr;
                                selectedModelName = modelName;
                                break;
                            }

                            if (!this._looksLikeJsonPayload(rawOutput)) {
                                const savedFilePath = await this._saveJsonFailureRecord({
                                    logDirectory: config.logger.logDirectory,
                                    modelName,
                                    stage: "raw_non_json",
                                    parseError,
                                    rawOutput,
                                    selectedFallbackAction: "switch_model",
                                    diagnosticContext
                                });

                                this.LOGGER.warning(
                                    this._formatJsonFailureLog({
                                        modelName,
                                        stage: "raw_non_json",
                                        parseError,
                                        rawOutput,
                                        selectedFallbackAction: "switch_model",
                                        savedFilePath
                                    })
                                );
                                throw parseError;
                            }
                            const savedFilePath = await this._saveJsonFailureRecord({
                                logDirectory: config.logger.logDirectory,
                                modelName,
                                stage: "raw_validation_failed",
                                parseError,
                                rawOutput,
                                selectedFallbackAction: "repair_json",
                                diagnosticContext
                            });

                            this.LOGGER.warning(
                                `${this._formatJsonFailureLog({
                                    modelName,
                                    stage: "raw_validation_failed",
                                    parseError,
                                    rawOutput,
                                    selectedFallbackAction: "repair_json",
                                    savedFilePath
                                })}，尝试修复 JSON`
                            );
                            validatedResultStr = await this._repairJsonResult(modelName, rawOutput, parseError);
                        }
                    }

                    resultStr = validatedResultStr;
                    selectedModelName = modelName;
                    break;
                } catch (error) {
                    const rawPreview = rawOutput
                        ? ` 原始输出前200字符：${this._formatPreview(rawOutput, 200)}`
                        : "";

                    if (this._isRateLimitError(error) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries++;
                        this.LOGGER.warning(
                            `模型 ${modelName} 触发速率限制，等待后重试（${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}）${rawPreview}`
                        );
                        await sleep(10000);
                        continue;
                    }

                    if (error instanceof JsonRepairFailureError) {
                        const savedFilePath = await this._saveJsonFailureRecord({
                            logDirectory: config.logger.logDirectory,
                            modelName,
                            stage: error.repairStage,
                            parseError: error.repairError,
                            originalParseError: error.originalParseError,
                            rawOutput: error.invalidJson,
                            repairedOutput: error.repairedResultStr,
                            selectedFallbackAction: "switch_model",
                            diagnosticContext
                        });

                        this.LOGGER.warning(
                            `模型 ${modelName} JSON 修复失败，原始校验错误为：${this._formatUnknownError(error.originalParseError)}，修复错误为：${this._formatUnknownError(error.repairError)}，${this._formatJsonFailureLog(
                                {
                                    modelName,
                                    stage: error.repairStage,
                                    parseError: error.repairError,
                                    rawOutput: error.invalidJson,
                                    repairedOutput: error.repairedResultStr,
                                    selectedFallbackAction: "switch_model",
                                    savedFilePath
                                }
                            )}，尝试下一个模型`
                        );
                        break;
                    }

                    this.LOGGER.warning(
                        `模型 ${modelName} 生成摘要失败，错误信息为：${this._formatUnknownError(error)}，尝试下一个模型。${rawPreview}`
                    );
                    break;
                }
            }

            if (resultStr) {
                break;
            }
        }

        if (!resultStr) {
            throw new Error(`所有模型都生成摘要失败，跳过`);
        }

        return {
            selectedModelName,
            content: resultStr
        };
    }

    /**
     * 获取指定模型的 ChatOpenAI 实例（用于高级场景，如 Agent 的 Function Calling）
     * @param modelName 模型名称
     * @param temperature 温度参数（可选）
     * @param maxTokens 最大 token 数（可选）
     * @returns ChatOpenAI 实例
     */
    public async getChatModel(modelName: string, temperature?: number, maxTokens?: number): Promise<ChatOpenAI> {
        const config = await this.configManagerService.getCurrentConfig();

        // 创建新的 ChatOpenAI 实例（不缓存，因为参数可能不同）
        const chatModel = new ChatOpenAI(this._buildChatOpenAIOptions(config, modelName, temperature, maxTokens));

        this.LOGGER.info(`为 Agent 场景创建独立的 ChatOpenAI 实例: ${modelName}`);

        return chatModel;
    }

    /**
     * 注册历史 assistant 消息中的 reasoning_content，保证 checkpoint 回放时仍能补齐请求体。
     */
    private _registerReasoningContentFromMessages(messages: BaseMessage[]): void {
        for (const message of messages) {
            if (!AIMessage.isInstance(message)) {
                continue;
            }

            const anyMessage = message as any;
            const reasoningContent = anyMessage?.additional_kwargs?.reasoning_content;

            if (typeof reasoningContent !== "string" || reasoningContent.length === 0) {
                continue;
            }

            registerReasoningContent(
                {
                    content: anyMessage.content ?? "",
                    tool_calls: Array.isArray(anyMessage.tool_calls) ? anyMessage.tool_calls : []
                },
                reasoningContent
            );
        }
    }

    /**
     * 使用消息列表生成文本（流式，支持工具绑定）
     * 适用于 Agent 等需要复杂消息历史和工具调用的场景
     * @param modelName 模型名称（如果未指定或为 "default"，则使用默认模型候选列表）
     * @param messages 消息列表
     * @param tools 工具定义（可选）
     * @param temperature 温度参数（可选）
     * @param maxTokens 最大 token 数（可选）
     * @param abortSignal 中止信号（可选）
     * @returns 异步迭代器，产出文本片段
     */
    public async streamWithMessages(
        modelName: string | undefined,
        messages: BaseMessage[],
        tools?: any[],
        temperature?: number,
        maxTokens?: number,
        abortSignal?: AbortSignal
    ): Promise<AsyncIterableIterator<any>> {
        const config = await this.configManagerService.getCurrentConfig();

        this._registerReasoningContentFromMessages(messages);

        const modelCandidates =
            !modelName || modelName === "default"
                ? this._dedupeModelNames(config.ai.defaultModelNames)
                : [modelName];

        return this._streamWithMessageModelCandidates(
            config,
            modelCandidates,
            messages,
            tools,
            temperature,
            maxTokens,
            abortSignal
        );
    }

    private async _createMessageStreamForModel(
        config: GlobalConfig,
        modelName: string,
        messages: BaseMessage[],
        tools?: any[],
        temperature?: number,
        maxTokens?: number,
        abortSignal?: AbortSignal
    ): Promise<AsyncIterableIterator<any>> {
        this.LOGGER.info(`Agent 使用模型: ${modelName}`);

        const chatModel = new ChatOpenAI(this._buildChatOpenAIOptions(config, modelName, temperature, maxTokens));

        if (tools && tools.length > 0) {
            this.LOGGER.info(`绑定 ${tools.length} 个工具到 ChatModel`);
            const boundModel = chatModel.bindTools(tools);

            this.LOGGER.info(`尝试启用工具调用模式 (tool_choice: "auto")`);

            return boundModel.stream(messages, {
                signal: abortSignal
            });
        }

        return chatModel.stream(messages, { signal: abortSignal });
    }

    private async *_streamWithMessageModelCandidates(
        config: GlobalConfig,
        modelNames: string[],
        messages: BaseMessage[],
        tools?: any[],
        temperature?: number,
        maxTokens?: number,
        abortSignal?: AbortSignal
    ): AsyncIterableIterator<any> {
        for (const modelName of modelNames) {
            let hasYieldedChunk = false;

            try {
                const stream = await this._createMessageStreamForModel(
                    config,
                    modelName,
                    messages,
                    tools,
                    temperature,
                    maxTokens,
                    abortSignal
                );

                for await (const chunk of stream) {
                    hasYieldedChunk = true;
                    yield chunk;
                }

                return;
            } catch (error) {
                if (hasYieldedChunk) {
                    throw error;
                }

                this.LOGGER.warning(
                    `Agent 模型 ${modelName} 建流失败，错误信息为：${this._formatUnknownError(error)}，尝试下一个模型`
                );
            }
        }

        throw ErrorReasons.ALL_MODELS_FAILED;
    }
}
