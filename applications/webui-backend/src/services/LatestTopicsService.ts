/**
 * 最新话题查询服务
 */
import type { LatestTopicRecord } from "@root/common/services/database/AgcDbAccessService";
import type { GetLatestTopicsParams } from "../schemas/index";

import { injectable, inject } from "tsyringe";
import { AgcDbAccessService } from "@root/common/services/database/AgcDbAccessService";

import { TOKENS } from "../di/tokens";

import { TopicStatusService } from "./TopicStatusService";

export type LatestTopicItem = Omit<LatestTopicRecord, "interestScore">;

export interface LatestTopicsResponse {
    topics: LatestTopicItem[];
    total: number;
    page: number;
    pageSize: number;
    readStatus: Record<string, boolean>;
    favoriteStatus: Record<string, boolean>;
    interestScores: Record<string, number>;
}

@injectable()
export class LatestTopicsService {
    public constructor(
        @inject(TOKENS.AgcDbAccessService) private agcDbAccessService: AgcDbAccessService,
        @inject(TOKENS.TopicStatusService) private topicStatusService: TopicStatusService
    ) {}

    /**
     * 获取最新话题分页结果。
     * 所有筛选和排序先作用于全量命中结果，再进行分页，保证分页总数与页面语义一致。
     */
    public async getLatestTopics(params: GetLatestTopicsParams): Promise<LatestTopicsResponse> {
        const groupId = params.groupId && params.groupId.length > 0 ? params.groupId : undefined;
        const searchText = params.search.trim().toLowerCase();
        const records = await this.agcDbAccessService.getLatestTopicRecordsByTimeRange(
            params.timeStart,
            params.timeEnd,
            groupId
        );

        let filteredRecords =
            searchText.length > 0 ? records.filter(record => this._matchesSearch(record, searchText)) : records;

        let readStatus: Record<string, boolean> = {};
        let favoriteStatus: Record<string, boolean> = {};

        if (params.filterRead) {
            readStatus = await this.topicStatusService.checkReadStatus(
                filteredRecords.map(record => record.topicId)
            );
            filteredRecords = filteredRecords.filter(record => !readStatus[record.topicId]);
        }

        if (params.filterFavorite) {
            favoriteStatus = await this.topicStatusService.checkFavoriteStatus(
                filteredRecords.map(record => record.topicId)
            );
            filteredRecords = filteredRecords.filter(record => favoriteStatus[record.topicId]);
        }

        const sortedRecords = this._sortRecords(filteredRecords, params.sortByInterest);
        const total = sortedRecords.length;
        const pageRecords = sortedRecords.slice(
            (params.page - 1) * params.pageSize,
            params.page * params.pageSize
        );
        const pageTopicIds = pageRecords.map(record => record.topicId);

        if (!params.filterRead) {
            readStatus = await this.topicStatusService.checkReadStatus(pageTopicIds);
        } else {
            readStatus = this._pickStatus(readStatus, pageTopicIds);
        }

        if (!params.filterFavorite) {
            favoriteStatus = await this.topicStatusService.checkFavoriteStatus(pageTopicIds);
        } else {
            favoriteStatus = this._pickStatus(favoriteStatus, pageTopicIds);
        }

        return {
            topics: pageRecords.map(record => this._toLatestTopicItem(record)),
            total,
            page: params.page,
            pageSize: params.pageSize,
            readStatus,
            favoriteStatus,
            interestScores: this._toInterestScoreMap(pageRecords)
        };
    }

    private _matchesSearch(record: LatestTopicRecord, searchText: string): boolean {
        const candidates = [record.topic, record.detail, record.contributors, record.groupId, record.sessionId];

        return candidates.some(candidate => this._normalizeNullableText(candidate).includes(searchText));
    }

    private _normalizeNullableText(value: string | null | undefined): string {
        return value ? value.toLowerCase() : "";
    }

    private _sortRecords(records: LatestTopicRecord[], sortByInterest: boolean): LatestTopicRecord[] {
        return [...records].sort((a, b) => {
            if (sortByInterest) {
                const aHasScore = typeof a.interestScore === "number";
                const bHasScore = typeof b.interestScore === "number";

                if (aHasScore && bHasScore) {
                    const scoreDiff = b.interestScore! - a.interestScore!;

                    if (scoreDiff !== 0) {
                        return scoreDiff;
                    }
                }

                if (aHasScore && !bHasScore) {
                    return -1;
                }

                if (!aHasScore && bHasScore) {
                    return 1;
                }
            }

            return this._compareByTimeDesc(a, b);
        });
    }

    private _compareByTimeDesc(a: LatestTopicRecord, b: LatestTopicRecord): number {
        const timeEndDiff = b.timeEnd - a.timeEnd;

        if (timeEndDiff !== 0) {
            return timeEndDiff;
        }

        const updateTimeDiff = b.updateTime - a.updateTime;

        if (updateTimeDiff !== 0) {
            return updateTimeDiff;
        }

        return a.topicId.localeCompare(b.topicId);
    }

    private _pickStatus(status: Record<string, boolean>, topicIds: string[]): Record<string, boolean> {
        const result: Record<string, boolean> = {};

        for (const topicId of topicIds) {
            result[topicId] = status[topicId] === true;
        }

        return result;
    }

    private _toInterestScoreMap(records: LatestTopicRecord[]): Record<string, number> {
        const result: Record<string, number> = {};

        for (const record of records) {
            if (typeof record.interestScore === "number") {
                result[record.topicId] = record.interestScore;
            }
        }

        return result;
    }

    private _toLatestTopicItem(record: LatestTopicRecord): LatestTopicItem {
        return {
            topicId: record.topicId,
            sessionId: record.sessionId,
            topic: record.topic,
            contributors: record.contributors,
            detail: record.detail,
            modelName: record.modelName,
            updateTime: record.updateTime,
            timeStart: record.timeStart,
            timeEnd: record.timeEnd,
            groupId: record.groupId
        };
    }
}
