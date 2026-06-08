import { z } from "zod";

import { DeepRequired } from "../../../util/type/DeepRequired";

// ==================== Zod Schema 定义（用于运行时验证）====================

export const QQ_SOURCE_RECONCILE_BATCH_SIZE_DEFAULT = 50000;
export const QQ_SOURCE_RECONCILE_BATCH_SIZE_MAX = 50000;
export const PREPROCESS_HISTORICAL_BACKFILL_MESSAGE_LIMIT_DEFAULT = 5000;
export const IMAGE_UNDERSTANDING_MAX_IMAGE_BYTES_DEFAULT = 1048576;
export const IMAGE_UNDERSTANDING_MAX_IMAGES_PER_RUN_DEFAULT = 50;
export const IMAGE_UNDERSTANDING_REQUEST_TIMEOUT_MS_DEFAULT = 30000;

/**
 * AI 模型配置 Schema
 */
export const ModelReasoningConfigSchema = z.object({
    enabled: z.boolean().default(false).describe("是否向模型请求透传 reasoning 参数"),
    effort: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
        .default("minimal")
        .describe("reasoning effort")
});

export const ModelConfigSchema = z.object({
    apiKey: z.string().describe("API 密钥"),
    baseURL: z.string().url().describe("API 基础 URL"),
    temperature: z.number().min(0).max(2).describe("温度参数，控制输出的随机性"),
    maxTokens: z.number().positive().int().describe("最大 Token 数量"),
    reasoning: ModelReasoningConfigSchema.default({
        enabled: false,
        effort: "minimal"
    }).describe("reasoning 参数透传配置")
});

export const ImageUnderstandingConfigSchema = z
    .object({
        enabled: z.boolean().default(false).describe("是否启用图片 OCR 与图片理解"),
        ocr: z
            .object({
                provider: z.literal("ocrspace").default("ocrspace").describe("OCR 服务提供商"),
                apiKey: z.string().default("").describe("OCR.space API Key"),
                endpoint: z
                    .string()
                    .url()
                    .default("https://api.ocr.space/parse/image")
                    .describe("OCR.space API 地址"),
                language: z.string().default("chs").describe("OCR.space language 参数"),
                ocrEngine: z.number().int().positive().default(2).describe("OCR.space OCREngine 参数"),
                scale: z.boolean().default(true).describe("是否启用 OCR.space scale 参数"),
                detectOrientation: z.boolean().default(true).describe("是否启用 OCR.space detectOrientation 参数"),
                isOverlayRequired: z.boolean().default(false).describe("是否要求 OCR.space 返回文字框 overlay"),
                maxImageBytes: z
                    .number()
                    .positive()
                    .int()
                    .default(IMAGE_UNDERSTANDING_MAX_IMAGE_BYTES_DEFAULT)
                    .describe("OCR.space 免费接口图片大小上限")
            })
            .default({
                provider: "ocrspace",
                apiKey: "",
                endpoint: "https://api.ocr.space/parse/image",
                language: "chs",
                ocrEngine: 2,
                scale: true,
                detectOrientation: true,
                isOverlayRequired: false,
                maxImageBytes: IMAGE_UNDERSTANDING_MAX_IMAGE_BYTES_DEFAULT
            })
            .describe("OCR 配置"),
        vision: z
            .object({
                provider: z
                    .literal("dashscope-openai-compatible")
                    .default("dashscope-openai-compatible")
                    .describe("图片理解模型提供商"),
                apiKey: z.string().default("").describe("DashScope API Key"),
                baseURL: z
                    .string()
                    .url()
                    .default("https://dashscope.aliyuncs.com/compatible-mode/v1")
                    .describe("DashScope OpenAI-compatible API 基础 URL"),
                modelName: z.string().default("qwen3.6-flash-2026-04-16").describe("图片理解模型名称"),
                temperature: z.number().min(0).max(2).default(0).describe("图片理解模型温度"),
                maxTokens: z.number().positive().int().default(2048).describe("图片理解模型最大输出 token")
            })
            .default({
                provider: "dashscope-openai-compatible",
                apiKey: "",
                baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                modelName: "qwen3.6-flash-2026-04-16",
                temperature: 0,
                maxTokens: 2048
            })
            .describe("图片理解模型配置"),
        maxImagesPerRun: z
            .number()
            .positive()
            .int()
            .default(IMAGE_UNDERSTANDING_MAX_IMAGES_PER_RUN_DEFAULT)
            .describe("每轮最多处理的图片数量"),
        retryCount: z.number().int().min(0).default(2).describe("图片理解失败后的重试次数"),
        requestTimeoutMs: z
            .number()
            .positive()
            .int()
            .default(IMAGE_UNDERSTANDING_REQUEST_TIMEOUT_MS_DEFAULT)
            .describe("单次 OCR 或图片理解请求超时时间"),
        processOnlyNewMessages: z.boolean().default(true).describe("是否只处理当前 pipeline 时间范围内的新消息")
    })
    .default({
        enabled: false,
        ocr: {
            provider: "ocrspace",
            apiKey: "",
            endpoint: "https://api.ocr.space/parse/image",
            language: "chs",
            ocrEngine: 2,
            scale: true,
            detectOrientation: true,
            isOverlayRequired: false,
            maxImageBytes: IMAGE_UNDERSTANDING_MAX_IMAGE_BYTES_DEFAULT
        },
        vision: {
            provider: "dashscope-openai-compatible",
            apiKey: "",
            baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            modelName: "qwen3.6-flash-2026-04-16",
            temperature: 0,
            maxTokens: 2048
        },
        maxImagesPerRun: IMAGE_UNDERSTANDING_MAX_IMAGES_PER_RUN_DEFAULT,
        retryCount: 2,
        requestTimeoutMs: IMAGE_UNDERSTANDING_REQUEST_TIMEOUT_MS_DEFAULT,
        processOnlyNewMessages: true
    })
    .describe("图片 OCR 与图片理解配置");

/**
 * 群组配置 Schema
 */
export const GroupConfigSchema = z.object({
    IM: z.enum(["QQ", "WeChat"]).describe("IM 平台类型"),
    groupName: z.string().default("").describe("群名称，用于前端展示；为空时使用群号"),
    splitStrategy: z.enum(["realtime", "accumulative"]).describe("消息分割策略"),
    groupIntroduction: z.string().describe("群简介，用于拼接在 context 里面"),
    aiModels: z.array(z.string()).min(1, "至少配置一个 AI 模型").describe("要使用的 AI 模型名列表，按优先级排序")
});

/**
 * 邮件配置 Schema（通用邮件服务配置）
 */
export const EmailConfigSchema = z
    .object({
        enabled: z.boolean().describe("是否启用邮件功能"),
        smtp: z
            .object({
                host: z.string().describe("SMTP 服务器地址"),
                port: z.number().int().positive().describe("SMTP 服务器端口"),
                secure: z.boolean().describe("是否使用 SSL/TLS，QQ邮箱需要设置为 true"),
                user: z.string().describe("SMTP 用户名"),
                pass: z.string().describe("SMTP 密码")
            })
            .describe("SMTP 配置"),
        from: z.string().describe("发件人地址。对于QQ邮箱，必须等于smtp.user"),
        recipients: z.array(z.string()).describe("收件人邮箱列表"),
        retryCount: z.number().int().min(0).describe("邮件发送失败重试次数")
    })
    .describe("邮件配置");

/**
 * 日报配置 Schema
 */
export const ReportConfigSchema = z
    .object({
        enabled: z.boolean().describe("是否启用日报功能"),
        sendEmail: z.boolean().describe("是否在生成日报后发送邮件"),
        schedule: z
            .object({
                halfDailyTimes: z
                    .array(z.string())
                    .describe("半日报触发时间，格式为 HH:mm，如 ['12:00', '18:00']"),
                weeklyTime: z.string().describe("周报触发时间，格式为 'HH:mm'，默认周一触发"),
                weeklyDayOfWeek: z.number().int().min(0).max(6).describe("周报触发的星期几，0-6 表示周日到周六"),
                monthlyTime: z.string().describe("月报触发时间，格式为 'HH:mm'，默认每月1号触发"),
                monthlyDayOfMonth: z.number().int().min(1).max(28).describe("月报触发的日期，1-28")
            })
            .describe("定时触发配置"),
        generation: z
            .object({
                topNTopics: z.number().positive().int().describe("喂给 LLM 的话题数量上限"),
                interestScoreThreshold: z
                    .number()
                    .min(-1)
                    .max(1)
                    .default(0)
                    .describe(
                        "兴趣分数阈值。如果话题的兴趣度评分小于这个值，在生成周报的时候该话题会被丢弃；若大于等于这个值或者不存在兴趣度评分，则会被保留"
                    ),
                llmRetryCount: z.number().int().min(0).describe("LLM 调用失败重试次数"),
                aiModels: z
                    .array(z.string())
                    .min(1, "至少配置一个 AI 模型")
                    .describe("用于生成日报综述的 AI 模型列表，按优先级排序")
            })
            .describe("日报生成配置")
    })
    .describe("日报配置");

/**
 * 全局配置 Schema
 */
export const GlobalConfigObjectSchema = z.object({
    dataProviders: z
        .object({
            QQ: z
                .object({
                    VFSExtPath: z.string().describe("sqlite vfs 扩展路径"),
                    dbBasePath: z.string().describe("NTQQ 存放数据库的文件夹路径"),
                    dbKey: z.string().describe("NTQQ 的数据库密钥"),
                    dbPatch: z
                        .object({
                            enabled: z.boolean().describe("是否启用数据库补丁"),
                            patchSQL: z.string().optional().describe("数据库补丁的 SQL 语句")
                        })
                        .describe("数据库补丁配置"),
                    sourceReconcile: z
                        .object({
                            enabled: z.boolean().default(true).describe("是否启用 QQ 原库回填"),
                            batchSize: z
                                .number()
                                .int()
                                .min(0)
                                .max(QQ_SOURCE_RECONCILE_BATCH_SIZE_MAX)
                                .default(QQ_SOURCE_RECONCILE_BATCH_SIZE_DEFAULT)
                                .describe(
                                    `QQ 原库回填每个群每轮扫描的业务消息数量；enabled=false 时可为 0，最大 ${QQ_SOURCE_RECONCILE_BATCH_SIZE_MAX}`
                                )
                        })
                        .default({
                            enabled: true,
                            batchSize: QQ_SOURCE_RECONCILE_BATCH_SIZE_DEFAULT
                        })
                        .describe("QQ 原库回填配置")
                })
                .describe("QQ 数据源配置")
        })
        .describe("dataProviders配置"),

    preprocessors: z
        .object({
            AccumulativeSplitter: z
                .object({
                    mode: z.enum(["charCount", "messageCount"]).describe("分割模式"),
                    maxCharCount: z.number().positive().int().describe("最大字符数"),
                    maxMessageCount: z.number().positive().int().describe("最大消息数"),
                    persistentKVStorePath: z.string().describe("持久化 KVStore 路径")
                })
                .describe("累积分割器配置"),
            TimeoutSplitter: z
                .object({
                    timeoutInMinutes: z.number().positive().int().describe("超时时间（分钟）")
                })
                .describe("超时分割器配置"),
            historicalBackfill: z
                .object({
                    messageLimit: z
                        .number()
                        .positive()
                        .int()
                        .default(PREPROCESS_HISTORICAL_BACKFILL_MESSAGE_LIMIT_DEFAULT)
                        .describe("历史未分配消息每个群每轮预处理回填的候选消息数量")
                })
                .default({
                    messageLimit: PREPROCESS_HISTORICAL_BACKFILL_MESSAGE_LIMIT_DEFAULT
                })
                .describe("历史消息预处理回填配置")
        })
        .describe("预处理器配置"),

    ai: z
        .object({
            models: z.record(z.string(), ModelConfigSchema).describe("模型配置映射"),
            defaultModelConfig: ModelConfigSchema.describe("默认模型配置"),
            defaultModelNames: z
                .array(z.string())
                .min(1, "至少配置一个默认 AI 模型")
                .describe("默认 AI 模型候选列表，按优先级排序"),
            maxConcurrentRequests: z
                .number()
                .positive()
                .int()
                .describe("最大并发请求数，用于文本生成器池，太小了会导致吞吐量下降，太大了可能会被服务商限流"),
            imageUnderstanding: ImageUnderstandingConfigSchema,
            context: z
                .object({
                    backgroundKnowledge: z
                        .object({
                            enabled: z.boolean().describe("是否启用背景知识补充"),
                            maxKnowledgeEntries: z.number().positive().int().describe("每次补充的最大知识条目数"),
                            knowledgeBase: z
                                .array(
                                    z.tuple([
                                        z.array(z.string()).describe("关键词列表"),
                                        z.array(z.string()).describe("解释列表")
                                    ])
                                )
                                .describe("背景知识库")
                        })
                        .describe("背景知识补充配置")
                })
                .describe("上下文相关配置"),
            interestScore: z
                .object({
                    UserInterestsPositiveKeywords: z.array(z.string()).describe("正向关键词"),
                    UserInterestsNegativeKeywords: z.array(z.string()).describe("负向关键词"),
                    llmEvaluationDescriptions: z.array(z.string()).describe("LLM兴趣评估的用户兴趣描述句子列表"),
                    llmEvaluationBatchSize: z.number().positive().int().describe("LLM兴趣评估的批处理大小")
                })
                .describe("兴趣度评分配置"),
            embedding: z
                .object({
                    ollamaBaseURL: z.string().describe("embedding 服务base地址，如 http://localhost:11434"),
                    model: z.string().describe("嵌入模型名"),
                    batchSize: z.number().positive().int().describe("批量处理大小，建议50左右"),
                    vectorDBPath: z.string().describe("向量数据库路径"),
                    dimension: z.number().positive().int().describe("向量维度")
                })
                .describe("向量嵌入配置"),
            rpc: z
                .object({
                    port: z.number().int().positive().int().describe("RPC 服务端口")
                })
                .describe("RPC 服务配置")
        })
        .strict()
        .describe("AI 配置"),

    webUI_Backend: z
        .object({
            port: z.number().int().positive().describe("后端服务端口"),
            kvStoreBasePath: z.string().describe("KV 存储基础路径"),
            dbBasePath: z.string().describe("数据库基础路径")
        })
        .describe("WebUI 后端配置"),

    orchestrator: z
        .object({
            pipelineIntervalInMinutes: z.number().positive().int().describe("Pipeline 执行间隔（分钟）"),
            dataSeekTimeWindowInHours: z.number().positive().int().describe("数据时间窗口（小时）")
        })
        .describe("调度器配置"),

    webUI_Forwarder: z
        .object({
            enabled: z.boolean().describe("是否启用内网穿透"),
            authTokenForFE: z.string().optional().describe("前端 ngrok Token"),
            authTokenForBE: z.string().optional().describe("后端 ngrok Token")
        })
        .describe("内网穿透配置"),

    commonDatabase: z
        .object({
            dbBasePath: z.string().describe("数据库基础路径"),
            maxDBDuration: z.number().positive().int().describe("最大数据库持续时间（天）"),
            ftsDatabase: z
                .object({
                    imMessageDBPath: z.string().describe("IM 消息全文检索（FTS）数据库路径")
                })
                .describe("FTS 数据库配置")
        })
        .describe("公共数据库配置"),

    logger: z
        .object({
            logLevel: z.enum(["debug", "info", "success", "warning", "error"]).describe("日志级别"),
            logDirectory: z.string().describe("日志目录")
        })
        .describe("日志配置"),

    groupConfigs: z.record(z.string(), GroupConfigSchema).describe("群配置映射"),

    email: EmailConfigSchema.describe("邮件配置"),

    report: ReportConfigSchema.describe("日报配置"),

    preStartCommand: z
        .object({
            enabled: z.boolean().describe("是否启用启动前命令"),
            command: z
                .string()
                .describe(
                    "启动前命令，在启动全部子项目之前执行的命令字符串（会开一个独立子进程执行，不等待其执行完成）"
                ),
            silent: z.boolean().describe("静默模式，是否静默启动前命令，不输出stdout/stderr"),
            detached: z
                .boolean()
                .describe("detach模式，启动前命令是否以 detached 方式运行（父进程退出后仍继续运行）")
        })
        .describe("启动前命令")
});

const hasConfiguredModel = (models: Record<string, unknown>, modelName: string): boolean => {
    return Object.prototype.hasOwnProperty.call(models, modelName);
};

const addMissingModelIssue = (ctx: z.RefinementCtx, path: (string | number)[], modelName: string): void => {
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `引用的 AI 模型 "${modelName}" 未在 ai.models 中配置`
    });
};

export const GlobalConfigSchema = GlobalConfigObjectSchema.superRefine((config, ctx) => {
    const models = config.ai.models;
    const sourceReconcile = config.dataProviders.QQ.sourceReconcile;

    if (sourceReconcile.enabled && sourceReconcile.batchSize <= 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["dataProviders", "QQ", "sourceReconcile", "batchSize"],
            message: "启用 QQ 原库回填时 batchSize 必须大于 0"
        });
    }

    config.ai.defaultModelNames.forEach((modelName, index) => {
        if (!hasConfiguredModel(models, modelName)) {
            addMissingModelIssue(ctx, ["ai", "defaultModelNames", index], modelName);
        }
    });

    Object.entries(config.groupConfigs).forEach(([groupId, groupConfig]) => {
        groupConfig.aiModels.forEach((modelName, index) => {
            if (!hasConfiguredModel(models, modelName)) {
                addMissingModelIssue(ctx, ["groupConfigs", groupId, "aiModels", index], modelName);
            }
        });
    });

    config.report.generation.aiModels.forEach((modelName, index) => {
        if (!hasConfiguredModel(models, modelName)) {
            addMissingModelIssue(ctx, ["report", "generation", "aiModels", index], modelName);
        }
    });
});

/**
 * 部分配置 Schema（用于 override 配置验证）
 */
export const PartialGlobalConfigSchema = GlobalConfigObjectSchema.deepPartial();

// ==================== TypeScript 类型（从 Zod Schema 自动推导）====================

/**
 * AI 模型配置类型
 */
export type ModelConfig = DeepRequired<z.infer<typeof ModelConfigSchema>>;

/**
 * 群组配置类型
 */
export type GroupConfig = DeepRequired<z.infer<typeof GroupConfigSchema>>;

/**
 * 全局配置类型
 */
export type GlobalConfig = DeepRequired<z.infer<typeof GlobalConfigSchema>>;

/**
 * 部分配置类型（用于 override 配置）
 */
export type PartialGlobalConfig = z.infer<typeof PartialGlobalConfigSchema>;
