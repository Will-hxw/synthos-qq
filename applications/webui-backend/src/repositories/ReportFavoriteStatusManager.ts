import { KVStore } from "@root/common/util/KVStore";
import Logger from "@root/common/util/Logger";

/**
 * 日报收藏状态管理器
 * 使用 KVStore（LevelDB）存储日报的收藏状态
 */
export class ReportFavoriteStatusManager {
    private static instance: ReportFavoriteStatusManager;
    private LOGGER = Logger.withTag("ReportFavoriteStatusManager");
    private store: KVStore<boolean>;

    private constructor(dbPath: string) {
        this.store = new KVStore<boolean>(dbPath);
        this.LOGGER.info(`日报收藏状态存储已初始化: dbPath=${dbPath}`);
    }

    /**
     * 获取单例实例
     * @param dbPath 可选：数据库路径，默认为 './data/favorite_reports'
     */
    public static getInstance(dbPath: string = "./data/favorite_reports"): ReportFavoriteStatusManager {
        if (!ReportFavoriteStatusManager.instance) {
            ReportFavoriteStatusManager.instance = new ReportFavoriteStatusManager(dbPath);
        }

        return ReportFavoriteStatusManager.instance;
    }

    /**
     * 标记日报为收藏
     */
    public async markAsFavorite(reportId: string): Promise<void> {
        try {
            await this.store.put(reportId, true);
            this.LOGGER.debug(`写入收藏状态成功: reportId=${reportId}`);
        } catch (error) {
            this.LOGGER.error(
                `写入收藏状态失败: reportId=${reportId}, error=${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /**
     * 从收藏中移除日报
     */
    public async removeFromFavorites(reportId: string): Promise<void> {
        try {
            await this.store.del(reportId);
            this.LOGGER.debug(`删除收藏状态成功: reportId=${reportId}`);
        } catch (error) {
            this.LOGGER.error(
                `删除收藏状态失败: reportId=${reportId}, error=${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /**
     * 检查日报是否被收藏
     */
    public async isReportFavorite(reportId: string): Promise<boolean> {
        const value = await this.store.get(reportId);

        return value === true; // 仅当明确存入 true 时才视为收藏
    }

    /**
     * 获取所有被收藏的日报 ID
     */
    public async getFavoriteReportIds(): Promise<string[]> {
        const ids = await this.store.keys();

        this.LOGGER.debug(`读取全部收藏日报 ID: count=${ids.length}`);

        return ids;
    }

    /**
     * 关闭数据库连接
     */
    public async close(): Promise<void> {
        this.LOGGER.info("关闭日报收藏状态存储");
        await this.store.dispose();
    }
}

export default ReportFavoriteStatusManager;
