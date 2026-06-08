import { join, dirname, resolve } from "path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ==================== Mock 区域 ====================

// 使用 vi.hoisted 来创建可以在 mock 中引用的变量
// 设置默认返回值以便模块加载时不会崩溃
const { mockReadFile, mockWriteFile, mockAccess, mockFindFileUpwards, mockLogger } = vi.hoisted(() => {
    const loggerInstance: Record<string, unknown> = {
        debug: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn()
    };

    loggerInstance.withTag = vi.fn().mockReturnValue(loggerInstance);

    return {
        mockReadFile: vi.fn().mockResolvedValue("{}"),
        mockWriteFile: vi.fn().mockResolvedValue(undefined),
        mockAccess: vi.fn().mockRejectedValue(new Error("File not found")),
        mockFindFileUpwards: vi.fn().mockResolvedValue("/default/path/synthos_config.json"),
        mockLogger: loggerInstance
    };
});

// Mock fs/promises
vi.mock("fs/promises", () => ({
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    access: mockAccess
}));

// Mock findFileUpwards
vi.mock("@root/common/util/file/findFileUpwards", () => ({
    findFileUpwards: mockFindFileUpwards
}));

// Mock Logger 以避免循环依赖问题
vi.mock("@root/common/util/Logger", () => ({
    default: mockLogger
}));

// Mock ASSERT 以避免它发送 SIGINT 信号终止进程
vi.mock("@root/common/util/ASSERT", () => ({
    ASSERT: (condition: unknown, message?: string) => {
        if (!condition) {
            throw new Error("断言失败！" + (message ? message : ""));
        }
    },
    ASSERT_NOT_FATAL: vi.fn()
}));

// 在 mock 之后导入类（不是单例实例）
import { ConfigManagerService } from "../services/config/ConfigManagerService";
import {
    PREPROCESS_HISTORICAL_BACKFILL_MESSAGE_LIMIT_DEFAULT,
    QQ_SOURCE_RECONCILE_BATCH_SIZE_DEFAULT
} from "../services/config/schemas/GlobalConfig";

// ==================== 测试数据 ====================

/**
 * 完整的配置数据，符合 GlobalConfigSchema
 */
const mockMainConfig = {
    dataProviders: {
        QQ: {
            VFSExtPath: "/path/to/vfs",
            dbBasePath: "/path/to/db",
            dbKey: "test-key",
            dbPatch: {
                enabled: false
            },
            sourceReconcile: {
                enabled: true,
                batchSize: 50000
            }
        }
    },
    preprocessors: {
        AccumulativeSplitter: {
            mode: "charCount" as const,
            maxCharCount: 5000,
            maxMessageCount: 100,
            persistentKVStorePath: "/path/to/kvstore"
        },
        TimeoutSplitter: {
            timeoutInMinutes: 30
        },
        historicalBackfill: {
            messageLimit: 5000
        }
    },
    ai: {
        models: {
            "gpt-4": {
                apiKey: "test-api-key",
                baseURL: "https://api.openai.com/v1",
                temperature: 0.7,
                maxTokens: 4096,
                reasoning: {
                    enabled: false,
                    effort: "minimal" as const
                }
            }
        },
        defaultModelConfig: {
            apiKey: "test-api-key",
            baseURL: "https://api.openai.com/v1",
            temperature: 0.7,
            maxTokens: 4096,
            reasoning: {
                enabled: false,
                effort: "minimal" as const
            }
        },
        defaultModelName: "gpt-4",
        defaultModelNames: ["gpt-4"],
        maxConcurrentRequests: 5,
        context: {
            backgroundKnowledge: {
                enabled: false,
                maxKnowledgeEntries: 10,
                knowledgeBase: []
            }
        },
        interestScore: {
            UserInterestsPositiveKeywords: ["tech", "coding"],
            UserInterestsNegativeKeywords: ["spam"],
            llmEvaluationDescriptions: ["技术", "编程"],
            llmEvaluationBatchSize: 10
        },
        embedding: {
            ollamaBaseURL: "http://localhost:11434",
            model: "nomic-embed-text",
            batchSize: 50,
            vectorDBPath: "/path/to/vectordb",
            dimension: 768
        },
        rpc: {
            port: 3001
        }
    },
    webUI_Backend: {
        port: 3000,
        kvStoreBasePath: "/path/to/kvstore",
        dbBasePath: "/path/to/db"
    },
    orchestrator: {
        pipelineIntervalInMinutes: 5,
        dataSeekTimeWindowInHours: 24
    },
    webUI_Forwarder: {
        enabled: false
    },
    commonDatabase: {
        dbBasePath: "/path/to/commondb",
        maxDBDuration: 30,
        ftsDatabase: {
            imMessageDBPath: "/path/to/fts/im_messages_fts.db"
        }
    },
    logger: {
        logLevel: "info" as const,
        logDirectory: "/logs"
    },
    groupConfigs: {},
    email: {
        enabled: false,
        smtp: {
            host: "smtp.example.com",
            port: 465,
            secure: true,
            user: "user@example.com",
            pass: "password"
        },
        from: "user@example.com",
        recipients: [],
        retryCount: 3
    },
    report: {
        enabled: false,
        sendEmail: false,
        schedule: {
            halfDailyTimes: ["12:00", "18:00"],
            weeklyTime: "09:00",
            weeklyDayOfWeek: 1,
            monthlyTime: "09:00",
            monthlyDayOfMonth: 1
        },
        generation: {
            topNTopics: 10,
            interestScoreThreshold: 0,
            llmRetryCount: 3,
            aiModels: ["gpt-4"]
        }
    },
    preStartCommand: {
        enabled: false,
        command: "",
        silent: true,
        detached: false
    }
};

const mockOverrideConfig = {
    dataProviders: {
        QQ: {
            dbKey: "override-key"
        }
    },
    logger: {
        logLevel: "debug" as const
    }
};

// ==================== 辅助函数 ====================

/**
 * 获取预期的 override 路径
 */
function getExpectedOverridePath(configPath: string): string {
    return join(dirname(configPath), "synthos_config_override.json");
}

// ==================== 测试用例 ====================

describe("ConfigManagerService", () => {
    let service: InstanceType<typeof ConfigManagerService>;
    const originalEnv = process.env;
    const testConfigPath = join("/path", "to", "synthos_config.json");

    beforeEach(() => {
        vi.clearAllMocks();
        // 重置环境变量
        process.env = { ...originalEnv };
        delete process.env.SYNTHOS_CONFIG_PATH;
        // 重置为默认值
        mockReadFile.mockResolvedValue(JSON.stringify(mockMainConfig));
        mockAccess.mockRejectedValue(new Error("File not found"));
        mockWriteFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("构造函数", () => {
        it("使用环境变量 SYNTHOS_CONFIG_PATH 时应直接使用该路径", async () => {
            const customPath = join("/custom", "path", "synthos_config.json");

            process.env.SYNTHOS_CONFIG_PATH = customPath;

            service = new ConfigManagerService();
            await service.getCurrentConfig();

            // 不应调用 findFileUpwards
            expect(mockFindFileUpwards).not.toHaveBeenCalled();
            expect(mockReadFile).toHaveBeenCalledWith(customPath, "utf8");
        });

        it("未设置环境变量时应使用 findFileUpwards 查找配置文件", async () => {
            const foundPath = join("/found", "path", "synthos_config.json");

            mockFindFileUpwards.mockResolvedValue(foundPath);

            service = new ConfigManagerService();
            await service.getCurrentConfig();

            expect(mockFindFileUpwards).toHaveBeenCalledWith("synthos_config.json");
            expect(mockReadFile).toHaveBeenCalledWith(foundPath, "utf8");
        });
    });

    describe("getConfigPath", () => {
        it("应返回配置文件路径", async () => {
            const customPath = join("/custom", "path", "synthos_config.json");

            process.env.SYNTHOS_CONFIG_PATH = customPath;

            service = new ConfigManagerService();
            const path = await service.getConfigPath();

            expect(path).toBe(customPath);
        });

        it("使用 findFileUpwards 时应返回找到的路径", async () => {
            const foundPath = join("/found", "path", "synthos_config.json");

            mockFindFileUpwards.mockResolvedValue(foundPath);

            service = new ConfigManagerService();
            const path = await service.getConfigPath();

            expect(path).toBe(foundPath);
        });

        it("当找不到配置文件时应返回 null", async () => {
            mockFindFileUpwards.mockRejectedValue(new Error("File not found"));

            service = new ConfigManagerService();
            const path = await service.getConfigPath();

            expect(path).toBeNull();
        });
    });

    describe("getOverridePath", () => {
        it("应返回 override 配置文件路径", async () => {
            const customPath = join("/custom", "path", "synthos_config.json");
            const expectedOverridePath = getExpectedOverridePath(customPath);

            process.env.SYNTHOS_CONFIG_PATH = customPath;

            service = new ConfigManagerService();
            const path = await service.getOverridePath();

            expect(path).toBe(expectedOverridePath);
        });

        it("当找不到主配置文件时应返回 null", async () => {
            mockFindFileUpwards.mockRejectedValue(new Error("File not found"));

            service = new ConfigManagerService();
            const path = await service.getOverridePath();

            expect(path).toBeNull();
        });
    });

    describe("getCurrentConfig", () => {
        it("当配置文件路径未找到时应抛出断言错误", async () => {
            mockFindFileUpwards.mockResolvedValue(undefined);
            service = new ConfigManagerService();

            await expect(service.getCurrentConfig()).rejects.toThrow("未找到配置文件");
        });

        it("当只有主配置文件时应返回主配置内容", async () => {
            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;
            service = new ConfigManagerService();

            const config = await service.getCurrentConfig();

            expect(mockReadFile).toHaveBeenCalledWith(testConfigPath, "utf8");
            expect(mockAccess).toHaveBeenCalledWith(getExpectedOverridePath(testConfigPath));
            expect(config).toEqual(mockMainConfig);
        });

        it("当存在 override 配置文件时应合并配置", async () => {
            const expectedOverridePath = getExpectedOverridePath(testConfigPath);

            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;

            mockAccess.mockResolvedValue(undefined); // override 存在
            mockReadFile
                .mockResolvedValueOnce(JSON.stringify(mockMainConfig))
                .mockResolvedValueOnce(JSON.stringify(mockOverrideConfig));

            service = new ConfigManagerService();
            const config = await service.getCurrentConfig();

            expect(mockReadFile).toHaveBeenCalledWith(testConfigPath, "utf8");
            expect(mockReadFile).toHaveBeenCalledWith(expectedOverridePath, "utf8");

            // 验证合并结果
            expect(config.logger.logLevel).toBe("debug"); // 被覆盖
            expect(config.logger.logDirectory).toBe("/logs"); // 保持原值
            expect(config.dataProviders.QQ.dbKey).toBe("override-key"); // 嵌套属性被覆盖
            expect(config.dataProviders.QQ.VFSExtPath).toBe("/path/to/vfs"); // 嵌套属性保持原值
        });

        it("历史配置缺少 QQ 原库回填配置时应填充默认批大小", async () => {
            const legacyConfig = {
                ...mockMainConfig,
                dataProviders: {
                    QQ: {
                        VFSExtPath: mockMainConfig.dataProviders.QQ.VFSExtPath,
                        dbBasePath: mockMainConfig.dataProviders.QQ.dbBasePath,
                        dbKey: mockMainConfig.dataProviders.QQ.dbKey,
                        dbPatch: mockMainConfig.dataProviders.QQ.dbPatch
                    }
                }
            };

            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;
            mockReadFile.mockResolvedValue(JSON.stringify(legacyConfig));

            service = new ConfigManagerService();
            const config = await service.getCurrentConfig();

            expect(config.dataProviders.QQ.sourceReconcile.enabled).toBe(true);
            expect(config.dataProviders.QQ.sourceReconcile.batchSize).toBe(QQ_SOURCE_RECONCILE_BATCH_SIZE_DEFAULT);
        });

        it("历史配置缺少预处理历史回填配置时应填充默认消息数量", async () => {
            const legacyConfig = {
                ...mockMainConfig,
                preprocessors: {
                    AccumulativeSplitter: mockMainConfig.preprocessors.AccumulativeSplitter,
                    TimeoutSplitter: mockMainConfig.preprocessors.TimeoutSplitter
                }
            };

            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;
            mockReadFile.mockResolvedValue(JSON.stringify(legacyConfig));

            service = new ConfigManagerService();
            const config = await service.getCurrentConfig();

            expect(config.preprocessors.historicalBackfill.messageLimit).toBe(
                PREPROCESS_HISTORICAL_BACKFILL_MESSAGE_LIMIT_DEFAULT
            );
        });

        it("应将相对路径解析为相对于配置文件所在目录的绝对路径", async () => {
            const configRoot = join(process.cwd(), "runtime-config");
            const configPath = join(configRoot, "synthos_config.json");
            const relativeConfig = {
                ...mockMainConfig,
                dataProviders: {
                    QQ: {
                        ...mockMainConfig.dataProviders.QQ,
                        VFSExtPath: "assets/sqlite_vfs_plugins/win_x86/sqlite_ext_ntqq_db.dll",
                        dbBasePath: "qq-db"
                    }
                },
                preprocessors: {
                    ...mockMainConfig.preprocessors,
                    AccumulativeSplitter: {
                        ...mockMainConfig.preprocessors.AccumulativeSplitter,
                        persistentKVStorePath: "data/splitter-kv"
                    }
                },
                ai: {
                    ...mockMainConfig.ai,
                    embedding: {
                        ...mockMainConfig.ai.embedding,
                        vectorDBPath: "data/vectors.db"
                    }
                },
                webUI_Backend: {
                    ...mockMainConfig.webUI_Backend,
                    kvStoreBasePath: "data/kv-store",
                    dbBasePath: "data"
                },
                commonDatabase: {
                    ...mockMainConfig.commonDatabase,
                    dbBasePath: "data",
                    ftsDatabase: {
                        imMessageDBPath: "data/fts_messages.db"
                    }
                },
                logger: {
                    ...mockMainConfig.logger,
                    logDirectory: "logs"
                }
            };

            process.env.SYNTHOS_CONFIG_PATH = configPath;
            mockReadFile.mockResolvedValue(JSON.stringify(relativeConfig));

            service = new ConfigManagerService();
            const config = await service.getCurrentConfig();

            expect(config.dataProviders.QQ.VFSExtPath).toBe(
                resolve(configRoot, "assets/sqlite_vfs_plugins/win_x86/sqlite_ext_ntqq_db.dll")
            );
            expect(config.dataProviders.QQ.dbBasePath).toBe(resolve(configRoot, "qq-db"));
            expect(config.preprocessors.AccumulativeSplitter.persistentKVStorePath).toBe(
                resolve(configRoot, "data/splitter-kv")
            );
            expect(config.ai.embedding.vectorDBPath).toBe(resolve(configRoot, "data/vectors.db"));
            expect(config.webUI_Backend.kvStoreBasePath).toBe(resolve(configRoot, "data/kv-store"));
            expect(config.webUI_Backend.dbBasePath).toBe(resolve(configRoot, "data"));
            expect(config.commonDatabase.dbBasePath).toBe(resolve(configRoot, "data"));
            expect(config.commonDatabase.ftsDatabase.imMessageDBPath).toBe(
                resolve(configRoot, "data/fts_messages.db")
            );
            expect(config.logger.logDirectory).toBe(resolve(configRoot, "logs"));
        });

        it("获取原始合并配置时应保留相对路径", async () => {
            const configPath = join(process.cwd(), "runtime-config", "synthos_config.json");
            const relativeConfig = {
                ...mockMainConfig,
                commonDatabase: {
                    ...mockMainConfig.commonDatabase,
                    dbBasePath: "data",
                    ftsDatabase: {
                        imMessageDBPath: "data/fts_messages.db"
                    }
                },
                logger: {
                    ...mockMainConfig.logger,
                    logDirectory: "logs"
                }
            };

            process.env.SYNTHOS_CONFIG_PATH = configPath;
            mockReadFile.mockResolvedValue(JSON.stringify(relativeConfig));

            service = new ConfigManagerService();
            const config = await service.getCurrentRawConfig();

            expect(config.commonDatabase.dbBasePath).toBe("data");
            expect(config.commonDatabase.ftsDatabase.imMessageDBPath).toBe("data/fts_messages.db");
            expect(config.logger.logDirectory).toBe("logs");
        });
    });

    describe("getBaseConfig", () => {
        it("应返回原始主配置", async () => {
            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;

            service = new ConfigManagerService();
            const config = await service.getBaseConfig();

            expect(mockReadFile).toHaveBeenCalledWith(testConfigPath, "utf8");
            expect(config).toEqual(mockMainConfig);
        });

        it("当找不到配置文件时应返回 null", async () => {
            mockFindFileUpwards.mockRejectedValue(new Error("File not found"));

            service = new ConfigManagerService();
            const config = await service.getBaseConfig();

            expect(config).toBeNull();
        });

        it("当读取配置文件失败时应返回 null", async () => {
            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;
            mockReadFile.mockRejectedValue(new Error("Read failed"));

            service = new ConfigManagerService();
            const config = await service.getBaseConfig();

            expect(config).toBeNull();
        });
    });

    describe("getOverrideConfig", () => {
        it("应返回 override 配置", async () => {
            const expectedOverridePath = getExpectedOverridePath(testConfigPath);

            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;
            mockReadFile.mockResolvedValue(JSON.stringify(mockOverrideConfig));

            service = new ConfigManagerService();
            const config = await service.getOverrideConfig();

            expect(mockReadFile).toHaveBeenCalledWith(expectedOverridePath, "utf8");
            expect(config).toEqual(mockOverrideConfig);
        });

        it("当找不到主配置文件时应返回 null", async () => {
            mockFindFileUpwards.mockRejectedValue(new Error("File not found"));

            service = new ConfigManagerService();
            const config = await service.getOverrideConfig();

            expect(config).toBeNull();
        });

        it("当读取 override 配置文件失败时应返回 null", async () => {
            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;
            mockReadFile.mockRejectedValue(new Error("Read failed"));

            service = new ConfigManagerService();
            const config = await service.getOverrideConfig();

            expect(config).toBeNull();
        });
    });

    describe("saveOverrideConfig", () => {
        it("应保存 override 配置", async () => {
            const expectedOverridePath = getExpectedOverridePath(testConfigPath);

            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;

            service = new ConfigManagerService();
            await service.saveOverrideConfig(mockOverrideConfig);

            expect(mockWriteFile).toHaveBeenCalledWith(
                expectedOverridePath,
                JSON.stringify(mockOverrideConfig, null, 4),
                "utf8"
            );
        });

        it("当找不到主配置路径时应抛出断言错误", async () => {
            mockFindFileUpwards.mockRejectedValue(new Error("File not found"));

            service = new ConfigManagerService();

            await expect(service.saveOverrideConfig(mockOverrideConfig)).rejects.toThrow(
                "无法确定 override 配置文件路径"
            );
        });

        it("当配置验证失败时应抛出错误", async () => {
            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;
            const invalidConfig = {
                dataProviders: {
                    QQ: {
                        dbKey: 12345 // 应该是字符串
                    }
                }
            };

            service = new ConfigManagerService();

            await expect(
                service.saveOverrideConfig(invalidConfig as unknown as typeof mockOverrideConfig)
            ).rejects.toThrow("配置验证失败");
        });
    });

    describe("getConfigJsonSchema", () => {
        it("应返回配置的 JSON Schema", () => {
            service = new ConfigManagerService();
            const schema = service.getConfigJsonSchema();

            expect(schema).toBeDefined();
            expect(typeof schema).toBe("object");
            // JSON Schema 应该有基本结构（可能在根对象或 definitions 中）
            expect(schema).toHaveProperty("$schema");
            const schemaText = JSON.stringify(schema);

            expect(schemaText).toContain("defaultModelNames");
            expect(schemaText).not.toContain("pinnedModels");
        });
    });

    describe("validateConfig", () => {
        it("对有效配置应返回成功", () => {
            service = new ConfigManagerService();
            const result = service.validateConfig(mockMainConfig);

            expect(result.success).toBe(true);
        });

        it("禁用 QQ 原库回填时允许 batchSize 为 0", () => {
            service = new ConfigManagerService();
            const disabledSourceReconcileConfig = {
                ...mockMainConfig,
                dataProviders: {
                    QQ: {
                        ...mockMainConfig.dataProviders.QQ,
                        sourceReconcile: {
                            enabled: false,
                            batchSize: 0
                        }
                    }
                }
            };
            const result = service.validateConfig(disabledSourceReconcileConfig);

            expect(result.success).toBe(true);
        });

        it("启用 QQ 原库回填时 batchSize 必须大于 0", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                ...mockMainConfig,
                dataProviders: {
                    QQ: {
                        ...mockMainConfig.dataProviders.QQ,
                        sourceReconcile: {
                            enabled: true,
                            batchSize: 0
                        }
                    }
                }
            };
            const result = service.validateConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect("errors" in result && result.errors.some(error => error.includes("batchSize"))).toBe(true);
        });

        it("对无效配置应返回失败和错误信息", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                dataProviders: {
                    QQ: {
                        VFSExtPath: 123 // 应该是字符串
                    }
                }
            };
            const result = service.validateConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect("errors" in result && result.errors).toBeInstanceOf(Array);
            expect("errors" in result && result.errors.length).toBeGreaterThan(0);
        });

        it("模型引用不存在时应返回失败", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                ...mockMainConfig,
                report: {
                    ...mockMainConfig.report,
                    generation: {
                        ...mockMainConfig.report.generation,
                        aiModels: ["missing-model"]
                    }
                }
            };
            const result = service.validateConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect("errors" in result && result.errors.some(error => error.includes("missing-model"))).toBe(true);
        });

        it("默认模型列表引用不存在时应返回失败", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                ...mockMainConfig,
                ai: {
                    ...mockMainConfig.ai,
                    defaultModelNames: ["missing-default-model"]
                }
            };
            const result = service.validateConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect(
                "errors" in result && result.errors.some(error => error.includes("missing-default-model"))
            ).toBe(true);
        });

        it("默认模型列表为空时应返回失败", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                ...mockMainConfig,
                ai: {
                    ...mockMainConfig.ai,
                    defaultModelNames: []
                }
            };
            const result = service.validateConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect("errors" in result && result.errors.some(error => error.includes("defaultModelNames"))).toBe(
                true
            );
        });

        it("群模型列表为空时应返回失败", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                ...mockMainConfig,
                groupConfigs: {
                    "123456": {
                        ...mockMainConfig.groupConfigs["123456"],
                        aiModels: []
                    }
                }
            };
            const result = service.validateConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect("errors" in result && result.errors.some(error => error.includes("aiModels"))).toBe(true);
        });

        it("日报模型列表为空时应返回失败", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                ...mockMainConfig,
                report: {
                    ...mockMainConfig.report,
                    generation: {
                        ...mockMainConfig.report.generation,
                        aiModels: []
                    }
                }
            };
            const result = service.validateConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect("errors" in result && result.errors.some(error => error.includes("aiModels"))).toBe(true);
        });

        it("旧的 pinnedModels 字段不应被接受", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                ...mockMainConfig,
                ai: {
                    ...mockMainConfig.ai,
                    pinnedModels: ["gpt-4"]
                }
            };
            const result = service.validateConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect("errors" in result && result.errors.some(error => error.includes("pinnedModels"))).toBe(true);
        });
    });

    describe("validatePartialConfig", () => {
        it("对有效的部分配置应返回成功", () => {
            service = new ConfigManagerService();
            const result = service.validatePartialConfig(mockOverrideConfig);

            expect(result.success).toBe(true);
        });

        it("对无效的部分配置应返回失败和错误信息", () => {
            service = new ConfigManagerService();
            const invalidConfig = {
                dataProviders: {
                    QQ: {
                        dbKey: 12345 // 应该是字符串
                    }
                }
            };
            const result = service.validatePartialConfig(invalidConfig);

            expect(result.success).toBe(false);
            expect("errors" in result && result.errors).toBeInstanceOf(Array);
            expect("errors" in result && result.errors.length).toBeGreaterThan(0);
        });
    });

    describe("deepMerge（通过 getCurrentConfig 间接测试）", () => {
        it("override 中不存在的 key 不应覆盖主配置", async () => {
            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;
            // JSON.stringify 会移除 undefined 值，所以这个测试实际上测试的是 key 不存在的情况
            const overridePartial = {
                logger: {
                    logDirectory: "/override/logs"
                    // logLevel 不存在，应该保持原值
                }
            };

            mockAccess.mockResolvedValue(undefined);
            mockReadFile
                .mockResolvedValueOnce(JSON.stringify(mockMainConfig))
                .mockResolvedValueOnce(JSON.stringify(overridePartial));

            service = new ConfigManagerService();
            const config = await service.getCurrentConfig();

            // 不存在的 key 不应覆盖原值
            expect(config.logger.logLevel).toBe("info");
            // 有值的应该覆盖
            expect(config.logger.logDirectory).toBe("/override/logs");
        });

        it("数组类型应被完整替换而非合并", async () => {
            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;

            const overrideWithArray = {
                ai: {
                    interestScore: {
                        UserInterestsPositiveKeywords: ["new", "keywords"]
                    }
                }
            };

            mockAccess.mockResolvedValue(undefined);
            mockReadFile
                .mockResolvedValueOnce(JSON.stringify(mockMainConfig))
                .mockResolvedValueOnce(JSON.stringify(overrideWithArray));

            service = new ConfigManagerService();
            const config = await service.getCurrentConfig();

            // 数组应被完整替换
            expect(config.ai.interestScore.UserInterestsPositiveKeywords).toEqual(["new", "keywords"]);
            // 其他数组保持原值
            expect(config.ai.interestScore.UserInterestsNegativeKeywords).toEqual(["spam"]);
        });

        it("深层嵌套对象应正确合并", async () => {
            process.env.SYNTHOS_CONFIG_PATH = testConfigPath;

            const deepOverride = {
                dataProviders: {
                    QQ: {
                        dbPatch: {
                            enabled: true,
                            patchSQL: "SELECT 1"
                        }
                    }
                }
            };

            mockAccess.mockResolvedValue(undefined);
            mockReadFile
                .mockResolvedValueOnce(JSON.stringify(mockMainConfig))
                .mockResolvedValueOnce(JSON.stringify(deepOverride));

            service = new ConfigManagerService();
            const config = await service.getCurrentConfig();

            // 深层嵌套应正确合并
            expect(config.dataProviders.QQ.dbPatch.enabled).toBe(true);
            expect(config.dataProviders.QQ.dbPatch.patchSQL).toBe("SELECT 1");
            // 其他嵌套属性应保持
            expect(config.dataProviders.QQ.VFSExtPath).toBe("/path/to/vfs");
            expect(config.dataProviders.QQ.dbKey).toBe("test-key");
        });
    });
});
