/**
 * 向量相关性换算工具
 */

/**
 * 将归一化向量的 L2 距离换算为 [0,1] 的相关性分数。
 *
 * Ollama /api/embed 返回的 bge-m3 向量已做 L2 归一化，sqlite-vec 的 vec0 表默认使用
 * L2（欧氏）距离。对单位向量，L2 距离 d 与余弦相似度 s 满足 d² = 2(1 - s)，
 * 因此 s = 1 - d²/2，d ∈ [0, 2]、s ∈ [-1, 1]。
 *
 * 旧实现用 `1 - d` 把距离当作余弦距离处理，会把中高相似度（d≈1）错误压成 0，
 * 导致前端展示的相关性几乎恒为 0。此函数按正确公式换算并裁剪到 [0,1]。
 *
 * @param distance vec0 返回的 L2 距离
 * @returns [0,1] 的相关性分数
 */
export function l2DistanceToRelevance(distance: number | undefined | null): number {
    if (distance === undefined || distance === null || Number.isNaN(distance)) {
        return 0;
    }

    const similarity = 1 - (distance * distance) / 2;

    return Math.min(1, Math.max(0, similarity));
}
