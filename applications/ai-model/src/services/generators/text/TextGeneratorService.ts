import "reflect-metadata";
import { injectable, inject } from "tsyringe";
import { ConfigManagerService } from "@root/common/services/config/ConfigManagerService";
import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage } from "@langchain/core/messages";
import ErrorReasons from "@root/common/contracts/ErrorReasons";
import Logger from "@root/common/util/Logger";
import { Disposable } from "@root/common/util/lifecycle/Disposable";
import { mustInitBeforeUse } from "@root/common/util/lifecycle/mustInitBeforeUse";
import { sleep } from "@root/common/util/promisify/sleep";
import { COMMON_TOKENS } from "@root/common/di/tokens";

import { JsonPromptStore } from "../../../context/prompts/JsonPromptStore";

class JsonRepairFailureError extends Error {
    public constructor(
        public readonly originalParseError: unknown,
        public readonly repairError: unknown,
        public readonly invalidJson: string,
        public readonly repairedResultStr: string
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

    private async useModel(modelName: string) {
        // 懒加载：当需要使用某个模型时才创建实例
        if (!this.models.has(modelName)) {
            const config = await this.configManagerService.getCurrentConfig();
            const chatModel = new ChatOpenAI({
                openAIApiKey: config.ai?.models[modelName]?.apiKey ?? config.ai.defaultModelConfig.apiKey, // 从配置中获取 API Key
                apiKey: config.ai?.models[modelName]?.apiKey ?? config.ai.defaultModelConfig.apiKey, // 从配置中获取 API Key
                configuration: {
                    baseURL: config.ai?.models[modelName]?.baseURL ?? config.ai.defaultModelConfig.baseURL // 支持自定义 base URL
                },
                model: modelName,
                temperature: config.ai?.models[modelName]?.temperature ?? config.ai.defaultModelConfig.temperature,
                maxTokens: config.ai?.models[modelName]?.maxTokens ?? config.ai.defaultModelConfig.maxTokens,
                reasoning: {
                    effort: "minimal" // 默认不思考
                }
            });

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
        const config = await this.configManagerService.getCurrentConfig();
        const deduped = [...new Set([...config.ai.pinnedModels, ...modelNames])];
        const modelCandidates = [...deduped, ...deduped, ...deduped];

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
                throw new Error("JSON 修复请求被上游网关/风控拒绝");
            }

            return this._validateJsonResult(repairedResultStr);
        } catch (error) {
            throw new JsonRepairFailureError(parseError, error, invalidJson, repairedResultStr);
        }
    }

    /**
     * 无状态的、带重试机制的、带候选机制的文本生成方法
     * @param modelNames 模型候选列表，允许为空。如果为空，则只使用置顶的的模型候选列表
     * @param input 输入文本
     * @param 是否对输出强校验json格式
     * @returns
     */
    public async generateTextWithModelCandidates(
        modelNames: string[],
        input: string,
        checkJsonFormat: boolean = false
    ): Promise<{
        selectedModelName: string;
        content: string;
    }> {
        const config = await this.configManagerService.getCurrentConfig();
        // 去重后整表重复3次：单次风控拒绝不代表下次还拒，给每个模型多次机会
        const deduped = [...new Set([...config.ai.pinnedModels, ...modelNames])];
        const modelCandidates = [...deduped, ...deduped, ...deduped];
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
                        this.LOGGER.info(
                            `模型 ${modelName} 被上游网关/风控拒绝（前200字符）：${this._formatPreview(rawOutput, 200)}，切换到下一个模型`
                        );
                        break;
                    }

                    let validatedResultStr = rawOutput;

                    if (checkJsonFormat) {
                        try {
                            validatedResultStr = this._validateJsonResult(rawOutput);
                        } catch (parseError) {
                            if (!this._looksLikeJsonPayload(rawOutput)) {
                                this.LOGGER.warning(
                                    `模型 ${modelName} 返回非 JSON 内容（前200字符）：${this._formatPreview(rawOutput, 200)}`
                                );
                                throw parseError;
                            }
                            this.LOGGER.warning(
                                `模型 ${modelName} 生成结果不是合法 JSON，错误信息为：${this._formatUnknownError(parseError)}，尝试修复 JSON`
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
                        const repairedPreview = error.repairedResultStr
                            ? ` 修复输出前200字符：${this._formatPreview(error.repairedResultStr, 200)}`
                            : " 修复输出为空或未返回";

                        this.LOGGER.warning(
                            `模型 ${modelName} JSON 修复失败，原始校验错误为：${this._formatUnknownError(error.originalParseError)}，修复错误为：${this._formatUnknownError(error.repairError)}，尝试下一个模型。 原始输出前200字符：${this._formatPreview(error.invalidJson, 200)}${repairedPreview}`
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
        const chatModel = new ChatOpenAI({
            openAIApiKey: config.ai?.models[modelName]?.apiKey ?? config.ai.defaultModelConfig.apiKey,
            apiKey: config.ai?.models[modelName]?.apiKey ?? config.ai.defaultModelConfig.apiKey,
            configuration: {
                baseURL: config.ai?.models[modelName]?.baseURL ?? config.ai.defaultModelConfig.baseURL
            },
            model: modelName,
            temperature:
                temperature ??
                config.ai?.models[modelName]?.temperature ??
                config.ai.defaultModelConfig.temperature,
            maxTokens:
                maxTokens ?? config.ai?.models[modelName]?.maxTokens ?? config.ai.defaultModelConfig.maxTokens,
            reasoning: {
                effort: "minimal"
            }
        });

        this.LOGGER.info(`为 Agent 场景创建独立的 ChatOpenAI 实例: ${modelName}`);

        return chatModel;
    }

    /**
     * 使用消息列表生成文本（流式，支持工具绑定）
     * 适用于 Agent 等需要复杂消息历史和工具调用的场景
     * @param modelName 模型名称（如果未指定或为 "default"，则使用配置中的第一个置顶模型）
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

        // 如果未指定模型或指定为 "default"，使用配置中的第一个置顶模型
        const effectiveModelName =
            !modelName || modelName === "default" ? config.ai.pinnedModels[0] || "gpt-4" : modelName;

        this.LOGGER.info(`Agent 使用模型: ${effectiveModelName}`);

        // 创建独立的模型实例
        let chatModel = new ChatOpenAI({
            openAIApiKey: config.ai?.models[effectiveModelName]?.apiKey ?? config.ai.defaultModelConfig.apiKey,
            apiKey: config.ai?.models[effectiveModelName]?.apiKey ?? config.ai.defaultModelConfig.apiKey,
            configuration: {
                baseURL: config.ai?.models[effectiveModelName]?.baseURL ?? config.ai.defaultModelConfig.baseURL
            },
            model: effectiveModelName,
            temperature:
                temperature ??
                config.ai?.models[effectiveModelName]?.temperature ??
                config.ai.defaultModelConfig.temperature,
            maxTokens:
                maxTokens ??
                config.ai?.models[effectiveModelName]?.maxTokens ??
                config.ai.defaultModelConfig.maxTokens,
            reasoning: {
                effort: "minimal"
            }
        });

        // 如果提供了工具，绑定工具并返回流
        if (tools && tools.length > 0) {
            this.LOGGER.info(`绑定 ${tools.length} 个工具到 ChatModel`);
            // 使用 bindTools 绑定工具，并通过 stream 的第二个参数传递 tool_choice
            const boundModel = chatModel.bindTools(tools);

            this.LOGGER.info(`尝试启用强制工具调用模式 (tool_choice: "auto")`);

            return boundModel.stream(messages, {
                signal: abortSignal
                // 注意：部分模型可能不支持 tool_choice，需要测试
            });
        }

        // 返回流式迭代器
        return chatModel.stream(messages, { signal: abortSignal });
    }
}
