import { useCallback, useState } from "react";

import {
    getTopicsFavoriteStatus,
    getTopicsReadStatus,
    markTopicAsFavorite,
    markTopicAsRead,
    removeTopicFromFavorites
} from "@/api/readAndFavApi";
import { Notification } from "@/util/Notification";

/**
 * 话题收藏/已读状态管理
 */
export function useTopicStatus() {
    const [favoriteTopics, setFavoriteTopics] = useState<Record<string, boolean>>({});
    const [readTopics, setReadTopics] = useState<Record<string, boolean>>({});

    const loadTopicStatuses = useCallback(async (topicIds: string[]) => {
        if (topicIds.length === 0) {
            return;
        }

        try {
            const [favoriteRes, readRes] = await Promise.all([getTopicsFavoriteStatus(topicIds), getTopicsReadStatus(topicIds)]);

            if (favoriteRes.success && favoriteRes.data?.favoriteStatus) {
                setFavoriteTopics(prev => ({ ...prev, ...favoriteRes.data.favoriteStatus }));
            }
            if (readRes.success && readRes.data?.readStatus) {
                setReadTopics(prev => ({ ...prev, ...readRes.data.readStatus }));
            }
        } catch (err) {
            console.error("获取话题状态失败:", err);
        }
    }, []);

    const toggleFavorite = useCallback(
        async (topicId: string) => {
            const isCurrentlyFavorite = favoriteTopics[topicId] === true;

            setFavoriteTopics(prev => ({
                ...prev,
                [topicId]: !isCurrentlyFavorite
            }));

            try {
                if (isCurrentlyFavorite) {
                    await removeTopicFromFavorites(topicId);
                } else {
                    await markTopicAsFavorite(topicId);
                }
            } catch (err) {
                console.error("更新话题收藏状态失败:", err);
                setFavoriteTopics(prev => ({
                    ...prev,
                    [topicId]: isCurrentlyFavorite
                }));
                Notification.error({
                    title: "操作失败",
                    description: "无法更新收藏状态"
                });
            }
        },
        [favoriteTopics]
    );

    const markAsRead = useCallback(async (topicId: string) => {
        setReadTopics(prev => ({
            ...prev,
            [topicId]: true
        }));

        try {
            await markTopicAsRead(topicId);
        } catch (err) {
            console.error("标记话题已读失败:", err);
            setReadTopics(prev => ({
                ...prev,
                [topicId]: false
            }));
            Notification.error({
                title: "标记失败",
                description: "无法标记话题为已读"
            });
        }
    }, []);

    return { favoriteTopics, readTopics, loadTopicStatuses, toggleFavorite, markAsRead };
}
