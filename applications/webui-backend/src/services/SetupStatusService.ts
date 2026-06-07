import type ConfigManagerServiceType from "@root/common/services/config/ConfigManagerService";
import type { QQSourceReconcileStatus } from "@root/common/contracts/data-provider/index";

import { access } from "fs/promises";
import path from "path";

import { injectable, inject } from "tsyringe";
import { QQ_SOURCE_RECONCILE_STATUS_PREFIX } from "@root/common/contracts/data-provider/index";
import { KVStore } from "@root/common/util/KVStore";

import { TOKENS } from "../di/tokens";

interface OllamaTagModel {
    name?: string;
    model?: string;
}

interface OllamaTagsResponse {
    models?: OllamaTagModel[];
}

export interface SetupStatusCheck {
    key: string;
    status: "ok" | "warning" | "error";
    message: string;
}

export interface SetupStatusEmbedding {
    ollamaBaseURL: string;
    model: string;
    reachable: boolean;
    modelInstalled: boolean;
    error?: string;
}

export interface SetupStatusResult {
    generatedAt: number;
    groupCount: number;
    configuredGroupIds: string[];
    embedding: SetupStatusEmbedding;
    qqSourceReconcile: QQSourceReconcileStatus[];
    checks: SetupStatusCheck[];
}

@injectable()
export class SetupStatusService {
    public constructor(
        @inject(TOKENS.ConfigManagerService)
        private configManagerService: typeof ConfigManagerServiceType
    ) {}

    /**
     * 获取本地部署关键依赖的可见状态。
     */
    public async getSetupStatus(): Promise<SetupStatusResult> {
        const config = await this.configManagerService.getCurrentConfig();
        const configuredGroupIds = Object.keys(config.groupConfigs);
        const [embedding, qqSourceReconcile] = await Promise.all([
            this._getEmbeddingStatus(config.ai.embedding.ollamaBaseURL, config.ai.embedding.model),
            this._getQQSourceReconcileStatuses(config.webUI_Backend.kvStoreBasePath)
        ]);

        return {
            generatedAt: Date.now(),
            groupCount: configuredGroupIds.length,
            configuredGroupIds,
            embedding,
            qqSourceReconcile,
            checks: this._buildChecks(configuredGroupIds.length, embedding, qqSourceReconcile)
        };
    }

    private async _getEmbeddingStatus(ollamaBaseURL: string, model: string): Promise<SetupStatusEmbedding> {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort();
        }, 3000);
        const baseURL = ollamaBaseURL.endsWith("/") ? ollamaBaseURL.slice(0, -1) : ollamaBaseURL;

        try {
            const response = await fetch(`${baseURL}/api/tags`, { signal: controller.signal });

            if (!response.ok) {
                return {
                    ollamaBaseURL,
                    model,
                    reachable: false,
                    modelInstalled: false,
                    error: `Ollama /api/tags 返回 HTTP ${response.status}`
                };
            }

            const data = (await response.json()) as OllamaTagsResponse;
            const models = Array.isArray(data.models) ? data.models : [];
            const modelInstalled = models.some(item => {
                return (
                    this._matchesConfiguredModel(item.name, model) ||
                    this._matchesConfiguredModel(item.model, model)
                );
            });

            return {
                ollamaBaseURL,
                model,
                reachable: true,
                modelInstalled,
                error: modelInstalled ? undefined : `未在 Ollama 中找到 embedding 模型 ${model}`
            };
        } catch (error) {
            return {
                ollamaBaseURL,
                model,
                reachable: false,
                modelInstalled: false,
                error: error instanceof Error ? error.message : String(error)
            };
        } finally {
            clearTimeout(timer);
        }
    }

    private async _getQQSourceReconcileStatuses(kvStoreBasePath: string): Promise<QQSourceReconcileStatus[]> {
        const storePath = path.join(kvStoreBasePath, "data-provider", "qq-source-reconcile");

        try {
            await access(storePath);
        } catch {
            return [];
        }

        const store = new KVStore<QQSourceReconcileStatus>(storePath);

        try {
            const keys = await store.keys();
            const statuses: QQSourceReconcileStatus[] = [];

            for (const key of keys) {
                if (!key.startsWith(`${QQ_SOURCE_RECONCILE_STATUS_PREFIX}:`)) {
                    continue;
                }

                const status = await store.get(key);

                if (this._isQQSourceReconcileStatus(status)) {
                    statuses.push(status);
                }
            }

            return statuses.sort((left, right) => right.updatedAt - left.updatedAt);
        } finally {
            await store.dispose();
        }
    }

    private _buildChecks(
        groupCount: number,
        embedding: SetupStatusEmbedding,
        qqSourceReconcile: QQSourceReconcileStatus[]
    ): SetupStatusCheck[] {
        const checks: SetupStatusCheck[] = [];

        checks.push({
            key: "group-config",
            status: groupCount > 0 ? "ok" : "warning",
            message: groupCount > 0 ? `已配置 ${groupCount} 个群组` : "未配置任何群组，数据采集不会产生话题"
        });

        if (!embedding.reachable) {
            checks.push({
                key: "embedding",
                status: "warning",
                message: `Ollama 不可用：${embedding.error ?? "未知错误"}`
            });
        } else if (!embedding.modelInstalled) {
            checks.push({
                key: "embedding",
                status: "warning",
                message: `Ollama 缺少 embedding 模型 ${embedding.model}，请执行 ollama pull ${embedding.model}`
            });
        } else {
            checks.push({
                key: "embedding",
                status: "ok",
                message: `Ollama embedding 模型 ${embedding.model} 可用`
            });
        }

        checks.push({
            key: "qq-source-reconcile",
            status: qqSourceReconcile.length > 0 ? "ok" : "warning",
            message:
                qqSourceReconcile.length > 0
                    ? `已记录 ${qqSourceReconcile.length} 个群组的 QQ 原库对账状态`
                    : "尚未记录 QQ 原库对账状态；首次数据采集完成后才会出现"
        });

        return checks;
    }

    private _matchesConfiguredModel(candidate: string | undefined, configuredModel: string): boolean {
        if (!candidate) {
            return false;
        }

        return (
            candidate === configuredModel ||
            candidate.startsWith(`${configuredModel}:`) ||
            configuredModel.startsWith(`${candidate}:`)
        );
    }

    private _isQQSourceReconcileStatus(value: unknown): value is QQSourceReconcileStatus {
        if (!value || typeof value !== "object") {
            return false;
        }

        const candidate = value as Partial<QQSourceReconcileStatus>;

        return (
            typeof candidate.groupId === "string" &&
            typeof candidate.scannedCount === "number" &&
            typeof candidate.missingCount === "number" &&
            typeof candidate.insertedCount === "number" &&
            typeof candidate.reachedEnd === "boolean" &&
            typeof candidate.batchSize === "number" &&
            typeof candidate.updatedAt === "number"
        );
    }
}
