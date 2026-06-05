/**
 * 将 sqlite-vec 返回的 L2 距离换算为前端展示用相关性分数。
 *
 * bge-m3 向量按单位向量语义使用时，L2 距离 d 与余弦相似度 s 满足：
 * d² = 2(1 - s)，因此 s = 1 - d² / 2。
 */
export function l2DistanceToRelevance(distance: number | undefined | null): number {
    if (distance === undefined || distance === null || Number.isNaN(distance)) {
        return 0;
    }

    const similarity = 1 - (distance * distance) / 2;

    return Math.min(1, Math.max(0, similarity));
}
