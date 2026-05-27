import "reflect-metadata";
import { injectable, container } from "tsyringe";

import Logger from "../../util/Logger";
import { Disposable } from "../../util/lifecycle/Disposable";
import { mustInitBeforeUse } from "../../util/lifecycle/mustInitBeforeUse";
import { COMMON_TOKENS } from "../../di/tokens";

import { createInterestScoreTableSQL } from "./constants/InitialSQL";
import { CommonDBService } from "./infra/CommonDBService";

/**
 * 兴趣评分数据库访问服务
 * 负责兴趣评分结果的存储和查询
 */
@injectable()
@mustInitBeforeUse
export class InterestScoreDbAccessService extends Disposable {
    private LOGGER = Logger.withTag("InterestScoreDbAccessService");
    private db: CommonDBService | null = null;

    /**
     * 初始化数据库服务
     */
    public async init() {
        // 从 DI 容器获取 CommonDBService 实例
        this.db = container.resolve<CommonDBService>(COMMON_TOKENS.CommonDBService);
        await this.db.init(createInterestScoreTableSQL);
        this.LOGGER.info("初始化完成！");
    }

    public async storeInterestScoreResult(topicId: string, score: number, version: number = 1) {
        await this.db.run(
            `INSERT INTO interset_score_results (topicId, scoreV${version}) VALUES (?,?)
            ON CONFLICT(topicId) DO UPDATE SET
                scoreV${version} = excluded.scoreV${version}
            `,
            [topicId, score]
        );
    }

    /**
     * 批量存储兴趣评分结果。
     * @param results 评分结果列表
     * @param version 分数版本
     */
    public async storeInterestScoreResults(
        results: { topicId: string; score: number }[],
        version: number = 1
    ): Promise<void> {
        if (results.length === 0) {
            return;
        }

        await this.db.run("BEGIN IMMEDIATE TRANSACTION");
        try {
            for (const result of results) {
                await this.db.run(
                    `INSERT INTO interset_score_results (topicId, scoreV${version}) VALUES (?,?)
                    ON CONFLICT(topicId) DO UPDATE SET
                        scoreV${version} = excluded.scoreV${version}
                    `,
                    [result.topicId, result.score]
                );
            }

            await this.db.run("COMMIT");
        } catch (err) {
            await this.db.run("ROLLBACK");
            throw err;
        }
    }

    // 如果对应的topicid不存在 或者 topicid存在但是没有对应的分数，那么该项目对应的score为null
    public async getInterestScoreResult(topicId: string, version: number = 1): Promise<number | null> {
        const result = await this.db.get<{ score: number | null }>(
            `SELECT scoreV${version} AS score FROM interset_score_results WHERE topicId = ?`,
            [topicId]
        );

        return result?.score ?? null;
    }

    public async isInterestScoreResultExist(topicId: string, version: number = 1): Promise<boolean> {
        // 返回结果类似 { 'EXISTS(SELECT 1 FROM interset_score_results WHERE topicId = ?)': 0 }
        const result = await this.db.get(
            `SELECT EXISTS(SELECT 1 FROM interset_score_results WHERE topicId = ? AND scoreV${version} IS NOT NULL)`,
            [topicId]
        );

        return result[Object.keys(result)[0]] === 1;
    }

    /**
     * 批量读取已经存在指定版本兴趣分的 topicId。
     * @param topicIds 待检查 topicId
     * @param version 分数版本
     * @returns 已存在分数的 topicId 集合
     */
    public async getExistingInterestScoreTopicIds(topicIds: string[], version: number = 1): Promise<Set<string>> {
        if (topicIds.length === 0) {
            return new Set();
        }

        const uniqueTopicIds = Array.from(new Set(topicIds));
        const placeholders = uniqueTopicIds.map(() => "?").join(", ");
        const rows = await this.db.all<{ topicId: string }>(
            `SELECT topicId FROM interset_score_results
             WHERE topicId IN (${placeholders})
               AND scoreV${version} IS NOT NULL`,
            uniqueTopicIds
        );

        return new Set(rows.map(row => row.topicId));
    }

    // 获取所有数据，用于数据库迁移、导出、备份等操作
    public async selectAll(): Promise<{ topicId: string; scoreV1: number | null }[]> {
        return this.db.all<{ topicId: string; scoreV1: number | null }>(`SELECT * FROM interset_score_results`);
    }
}
