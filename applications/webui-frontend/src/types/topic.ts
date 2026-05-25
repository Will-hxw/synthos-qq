/**
 * 话题相关的类型定义
 */

/**
 * AI摘要结果（基础字段）
 */
export interface AIDigestResult {
    topicId: string;
    sessionId: string;
    topic: string;
    contributors: string;
    detail: string;
    modelName: string;
    updateTime: number; // UNIX毫秒级时间戳
}

/**
 * 话题项（包含时间范围和群组信息）
 */
export interface TopicItem extends AIDigestResult {
    timeStart: number;
    timeEnd: number;
    groupId: string;
}

export interface LatestTopicsRequest {
    timeStart: number;
    timeEnd: number;
    page: number;
    pageSize: number;
    groupId?: string;
    filterRead: boolean;
    filterFavorite: boolean;
    sortByInterest: boolean;
    search: string;
}

export interface LatestTopicsResponse {
    topics: TopicItem[];
    total: number;
    page: number;
    pageSize: number;
    readStatus: Record<string, boolean>;
    favoriteStatus: Record<string, boolean>;
    interestScores: Record<string, number>;
}
