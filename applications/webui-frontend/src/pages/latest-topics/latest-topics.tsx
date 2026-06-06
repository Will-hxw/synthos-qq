import type { TopicItem } from "@/types/topic";
import type { GroupDetailsRecord } from "@/types/group";
import type { ApiResponse } from "@/types/api";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Pagination } from "@heroui/pagination";
import { Spinner } from "@heroui/spinner";
import { Tooltip } from "@heroui/tooltip";
import { Input } from "@heroui/input";
import { Check, Search } from "lucide-react";
import { today, getLocalTimeZone, CalendarDate } from "@internationalized/date";

import TopicCard from "@/components/topic/TopicCard";
import { getGroupDetails } from "@/api/basicApi";
import { getLatestTopics } from "@/api/latestTopicsApi";
import { markTopicAsRead, markTopicAsFavorite, removeTopicFromFavorites } from "@/api/readAndFavApi";
import { title } from "@/components/primitives";
import DefaultLayout from "@/layouts/default";
import { Notification } from "@/util/Notification";
import ResponsivePopover from "@/components/ResponsivePopover";

const MIN_UNIX_MS_TIMESTAMP = 0;
const DEFAULT_TOPICS_PER_PAGE = 12;
const DEFAULT_RECENT_DAYS = 30;
const TOPICS_PER_PAGE_OPTIONS = [3, 6, 9, 12, 30] as const;

const LatestTopicsFilterPanel = lazy(() => import("./components/LatestTopicsFilterPanel"));

const getDefaultStartDate = () => today(getLocalTimeZone()).add({ days: -(DEFAULT_RECENT_DAYS - 1) });
const getDefaultEndDate = () => today(getLocalTimeZone());

const normalizeUnixMsTimestamp = (date: Date): number => Math.max(MIN_UNIX_MS_TIMESTAMP, date.getTime());

const toInclusiveDateEnd = (date: CalendarDate): Date => date.add({ days: 1 }).toDate(getLocalTimeZone());

const formatCalendarDateParam = (date: CalendarDate): string => `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

const isSameCalendarDate = (left: CalendarDate, right: CalendarDate): boolean => left.year === right.year && left.month === right.month && left.day === right.day;

const parsePositiveInteger = (value: string | null): number | null => {
    if (!value) {
        return null;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1) {
        return null;
    }

    return parsed;
};

const parseBooleanParam = (value: string | null, defaultValue: boolean): boolean => {
    if (value === "true") {
        return true;
    }

    if (value === "false") {
        return false;
    }

    return defaultValue;
};

const parseUrlDate = (value: string | null): CalendarDate | null => {
    if (!value) {
        return null;
    }

    const parts = value.split("-");

    if (parts.length !== 3) {
        return null;
    }

    const [yearText, monthText, dayText] = parts;

    if (yearText.length !== 4 || monthText.length < 1 || monthText.length > 2 || dayText.length < 1 || dayText.length > 2) {
        return null;
    }

    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);

    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
        return null;
    }

    try {
        return new CalendarDate(year, month, day);
    } catch {
        return null;
    }
};

const isDateRangeOrdered = (start: CalendarDate, end: CalendarDate): boolean => start.toDate(getLocalTimeZone()).getTime() <= end.toDate(getLocalTimeZone()).getTime();

interface LatestTopicsInitialState {
    selectedGroupId: string;
    filterRead: boolean;
    filterFavorite: boolean;
    sortByInterest: boolean;
    searchText: string;
    page: number;
    topicsPerPage: number;
    dateRange: {
        start: CalendarDate;
        end: CalendarDate;
    };
    hasPendingGroupValidation: boolean;
    hasInvalidDateRange: boolean;
}

const getInitialStateFromUrl = (searchParams: URLSearchParams): LatestTopicsInitialState => {
    const page = parsePositiveInteger(searchParams.get("page")) ?? 1;
    const pageSize = parsePositiveInteger(searchParams.get("pageSize"));
    const startDate = parseUrlDate(searchParams.get("startDate"));
    const endDate = parseUrlDate(searchParams.get("endDate"));
    const hasDateParams = searchParams.has("startDate") || searchParams.has("endDate");
    const hasValidDateRange = !!startDate && !!endDate && isDateRangeOrdered(startDate, endDate);
    const selectedGroupId = searchParams.get("groupId") || "";

    return {
        selectedGroupId,
        filterRead: parseBooleanParam(searchParams.get("filterRead"), true),
        filterFavorite: parseBooleanParam(searchParams.get("filterFavorite"), false),
        sortByInterest: parseBooleanParam(searchParams.get("sortByInterest"), false),
        searchText: searchParams.get("search") || "",
        page,
        topicsPerPage: pageSize && TOPICS_PER_PAGE_OPTIONS.includes(pageSize as (typeof TOPICS_PER_PAGE_OPTIONS)[number]) ? pageSize : DEFAULT_TOPICS_PER_PAGE,
        dateRange: hasValidDateRange
            ? {
                  start: startDate,
                  end: endDate
              }
            : {
                  start: getDefaultStartDate(),
                  end: getDefaultEndDate()
              },
        hasPendingGroupValidation: selectedGroupId.length > 0,
        hasInvalidDateRange: hasDateParams && !hasValidDateRange
    };
};

const getApiDataOrThrow = <T,>(response: ApiResponse<T>, action: string): T => {
    if (!response.success) {
        throw new Error(`${action}失败：${response.message || "接口返回失败"}`);
    }

    return response.data;
};

const ensureApiSuccess = (response: { success: boolean; message?: string }, action: string): void => {
    if (!response.success) {
        throw new Error(`${action}失败：${response.message || "接口返回失败"}`);
    }
};

const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error && error.message) {
        return error.message;
    }

    if (typeof error === "string" && error.length > 0) {
        return error;
    }

    return "未知错误";
};

const isAbortError = (error: unknown): boolean => {
    if (error instanceof DOMException) {
        return error.name === "AbortError";
    }

    return typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError";
};

export default function LatestTopicsPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const initialStateRef = useRef<LatestTopicsInitialState | null>(null);

    if (!initialStateRef.current) {
        initialStateRef.current = getInitialStateFromUrl(searchParams);
    }

    const initialState = initialStateRef.current;
    const [topics, setTopics] = useState<TopicItem[]>([]);
    const [totalTopics, setTotalTopics] = useState<number>(0);
    const [loading, setLoading] = useState<boolean>(true);
    const [page, setPage] = useState<number>(initialState.page);
    const [topicsPerPage, setTopicsPerPage] = useState<number>(initialState.topicsPerPage); // 将topicsPerPage改为状态
    const [readTopics, setReadTopics] = useState<Record<string, boolean>>({});
    const [favoriteTopics, setFavoriteTopics] = useState<Record<string, boolean>>({}); // 收藏状态
    const [interestScores, setInterestScores] = useState<Record<string, number>>({}); // 兴趣得分状态

    // 群组筛选状态
    const [groups, setGroups] = useState<GroupDetailsRecord>({});
    const [selectedGroupId, setSelectedGroupId] = useState<string>(initialState.selectedGroupId); // 空字符串表示"全部群组"

    // 筛选状态
    const [filterRead, setFilterRead] = useState<boolean>(initialState.filterRead); // 过滤已读
    const [filterFavorite, setFilterFavorite] = useState<boolean>(initialState.filterFavorite); // 筛选收藏
    const [sortByInterest, setSortByInterest] = useState<boolean>(initialState.sortByInterest); // 按兴趣度排序
    const [searchText, setSearchText] = useState<string>(initialState.searchText); // 全文搜索

    // 默认时间范围
    const [dateRange, setDateRange] = useState(initialState.dateRange);

    // 标记是否已从URL初始化
    const [isInitializedFromUrl, setIsInitializedFromUrl] = useState<boolean>(() => !initialState.hasPendingGroupValidation);
    const requestSeqRef = useRef<number>(0);
    const latestTopicsAbortRef = useRef<AbortController | null>(null);
    const pendingGroupValidationRef = useRef<string | null>(initialState.hasPendingGroupValidation ? initialState.selectedGroupId : null);

    const abortLatestTopicsRequest = () => {
        if (!latestTopicsAbortRef.current) {
            return;
        }

        latestTopicsAbortRef.current.abort();
        latestTopicsAbortRef.current = null;
    };

    // 加载群组列表；只有 URL 带 groupId 时才阻塞话题查询以保留原有校验行为。
    useEffect(() => {
        const fetchGroups = async () => {
            try {
                const response = await getGroupDetails();

                if (response.success) {
                    setGroups(response.data);

                    const pendingGroupId = pendingGroupValidationRef.current;

                    if (pendingGroupId) {
                        if (Object.keys(response.data).includes(pendingGroupId)) {
                            setSelectedGroupId(pendingGroupId);
                        } else {
                            setSelectedGroupId("");
                            Notification.error({
                                title: "群组不存在",
                                description: `URL中指定的群组ID "${pendingGroupId}" 不存在`
                            });
                        }

                        pendingGroupValidationRef.current = null;
                        setIsInitializedFromUrl(true);
                    }
                }
            } catch (error) {
                console.error("获取群组信息失败:", error);
            } finally {
                if (pendingGroupValidationRef.current) {
                    pendingGroupValidationRef.current = null;
                    setSelectedGroupId("");
                    setIsInitializedFromUrl(true);
                }
            }
        };

        if (initialState.hasInvalidDateRange) {
            Notification.error({
                title: "日期参数无效",
                description: "URL中的时间范围无效，已使用默认最近2年"
            });
        }

        fetchGroups();
    }, []);

    // 同步筛选参数到URL
    useEffect(() => {
        // 只有在初始化完成后才同步URL
        if (!isInitializedFromUrl) {
            return;
        }

        const newParams = new URLSearchParams();

        if (selectedGroupId) {
            newParams.set("groupId", selectedGroupId);
        }
        if (!filterRead) {
            // 默认是true，所以只有为false时才写入URL
            newParams.set("filterRead", "false");
        }
        if (filterFavorite) {
            // 默认是false，所以只有为true时才写入URL
            newParams.set("filterFavorite", "true");
        }
        if (sortByInterest) {
            // 默认是false，所以只有为true时才写入URL
            newParams.set("sortByInterest", "true");
        }
        if (searchText) {
            newParams.set("search", searchText);
        }
        if (page > 1) {
            // 只有非第一页才写入URL
            newParams.set("page", String(page));
        }
        if (topicsPerPage !== DEFAULT_TOPICS_PER_PAGE) {
            newParams.set("pageSize", String(topicsPerPage));
        }

        // 时间范围：格式化为 YYYY-MM-DD
        const defaultStart = getDefaultStartDate();
        const defaultEnd = getDefaultEndDate();

        // 只有当时间范围不是默认值时才写入URL
        const isStartDefault = isSameCalendarDate(dateRange.start, defaultStart);
        const isEndDefault = isSameCalendarDate(dateRange.end, defaultEnd);

        if (!isStartDefault || !isEndDefault) {
            newParams.set("startDate", formatCalendarDateParam(dateRange.start));
            newParams.set("endDate", formatCalendarDateParam(dateRange.end));
        }

        setSearchParams(newParams, { replace: true });
    }, [selectedGroupId, filterRead, filterFavorite, sortByInterest, searchText, page, topicsPerPage, dateRange, isInitializedFromUrl, setSearchParams]);

    const fetchLatestTopics = async (options?: { silent?: boolean }) => {
        // silent：用于乐观更新后的后台回填。不切换 loading，避免整列表被 Spinner 顶替
        // 造成闪烁——乐观删除已让条目平滑消失，此处只在原地把下一条补进当前页。
        const silent = options?.silent ?? false;
        const requestId = requestSeqRef.current + 1;
        const abortController = new AbortController();
        const signal = abortController.signal;
        const start = dateRange.start.toDate(getLocalTimeZone());
        const end = toInclusiveDateEnd(dateRange.end);

        abortLatestTopicsRequest();
        requestSeqRef.current = requestId;
        latestTopicsAbortRef.current = abortController;
        if (!silent) {
            setLoading(true);
        }
        try {
            const [startTime, endTime] = [normalizeUnixMsTimestamp(start), normalizeUnixMsTimestamp(end)];
            const response = await getLatestTopics(
                {
                    timeStart: startTime,
                    timeEnd: endTime,
                    page,
                    pageSize: topicsPerPage,
                    groupId: selectedGroupId || undefined,
                    filterRead,
                    filterFavorite,
                    sortByInterest,
                    search: searchText
                },
                signal
            );
            const data = getApiDataOrThrow(response, "获取最新话题");

            if (requestSeqRef.current !== requestId || signal.aborted) {
                return;
            }

            setTopics(data.topics);
            setTotalTopics(data.total);
            setReadTopics(data.readStatus);
            setFavoriteTopics(data.favoriteStatus);
            setInterestScores(data.interestScores);
        } catch (error) {
            if (requestSeqRef.current !== requestId || signal.aborted || isAbortError(error)) {
                return;
            }

            console.error("获取最新话题失败:", error);
            Notification.error({
                title: "获取话题失败",
                description: `无法加载最新话题：${getErrorMessage(error)}`
            });
        } finally {
            if (latestTopicsAbortRef.current === abortController) {
                latestTopicsAbortRef.current = null;
            }

            if (requestSeqRef.current === requestId && !signal.aborted && !silent) {
                setLoading(false);
            }
        }
    };

    // 条件变化时重新加载（需等待URL初始化完成）
    useEffect(() => {
        if (!isInitializedFromUrl) {
            return;
        }

        const timerId = window.setTimeout(
            () => {
                fetchLatestTopics();
            },
            searchText ? 300 : 0
        );

        return () => {
            window.clearTimeout(timerId);
            abortLatestTopicsRequest();
        };
    }, [dateRange, page, topicsPerPage, selectedGroupId, filterRead, filterFavorite, sortByInterest, searchText, isInitializedFromUrl]);

    // 分页处理
    const totalPages = Math.ceil(totalTopics / topicsPerPage);

    useEffect(() => {
        if (totalPages > 0 && page > totalPages) {
            setPage(totalPages);
        }
    }, [page, totalPages]);

    const currentPageTopics = topics;

    const getGroupSelectLabel = (groupId: string): string => {
        const groupName = groups[groupId]?.groupName;

        if (groupName && groupName.trim().length > 0) {
            return groupName.trim();
        }

        return groupId;
    };

    // 标记话题为已读
    const markAsRead = async (topicId: string) => {
        try {
            // 更新本地状态
            setReadTopics(prev => ({
                ...prev,
                [topicId]: true
            }));

            // 使用新的API标记为已读
            ensureApiSuccess(await markTopicAsRead(topicId), "标记话题为已读");

            Notification.success({
                title: "标记成功",
                description: "话题已标记为已读"
            });

            if (filterRead) {
                await fetchLatestTopics({ silent: true });
            }
        } catch (error) {
            console.error("Failed to mark topic as read:", error);
            // 如果API调用失败，回滚本地状态
            setReadTopics(prev => ({
                ...prev,
                [topicId]: false
            }));
            Notification.error({
                title: "标记失败",
                description: "无法标记话题为已读"
            });
        }
    };

    // 切换收藏状态
    const toggleFavorite = async (topicId: string) => {
        try {
            const isCurrentlyFavorite = favoriteTopics[topicId];

            // 更新本地状态（乐观更新）
            setFavoriteTopics(prev => ({
                ...prev,
                [topicId]: !isCurrentlyFavorite
            }));

            if (isCurrentlyFavorite) {
                // 取消收藏
                await removeTopicFromFavorites(topicId);
                Notification.success({
                    title: "取消收藏",
                    description: "话题已从收藏中移除"
                });

                if (filterFavorite) {
                    await fetchLatestTopics({ silent: true });
                }
            } else {
                // 添加收藏
                await markTopicAsFavorite(topicId);
                Notification.success({
                    title: "收藏成功",
                    description: "话题已添加到收藏"
                });
            }
        } catch (error) {
            console.error("Failed to toggle favorite status:", error);
            // 如果API调用失败，回滚本地状态
            setFavoriteTopics(prev => ({
                ...prev,
                [topicId]: favoriteTopics[topicId]
            }));
            Notification.error({
                title: "操作失败",
                description: "无法更新收藏状态"
            });
        }
    };

    const hasUnreadTopicOnCurrentPage = currentPageTopics.some(topic => !readTopics[topic.topicId]);

    const markCurrentPageAsRead = async () => {
        const unreadTopics = currentPageTopics.filter(topic => !readTopics[topic.topicId]);

        try {
            const promises = unreadTopics.map(topic => markTopicAsRead(topic.topicId));
            const responses = await Promise.all(promises);

            responses.forEach(response => {
                ensureApiSuccess(response, "标记话题为已读");
            });

            const newReadTopics = { ...readTopics };

            unreadTopics.forEach(topic => {
                newReadTopics[topic.topicId] = true;
            });
            setReadTopics(newReadTopics);

            if (filterRead) {
                const unreadTopicIds = new Set(unreadTopics.map(topic => topic.topicId));
                const nextTotalTopics = Math.max(0, totalTopics - unreadTopics.length);
                const nextTotalPages = Math.ceil(nextTotalTopics / topicsPerPage);
                const nextPage = Math.max(1, Math.min(page, nextTotalPages || 1));

                setTopics(prev => prev.filter(topic => !unreadTopicIds.has(topic.topicId)));
                setTotalTopics(nextTotalTopics);
                if (nextPage !== page) {
                    setPage(nextPage);
                } else {
                    await fetchLatestTopics({ silent: true });
                }
            }

            Notification.success({
                title: "批量标记成功",
                description: `已将 ${unreadTopics.length} 个话题标记为已读`
            });
        } catch (error) {
            console.error("批量标记话题为已读失败:", error);
            Notification.error({
                title: "批量标记失败",
                description: "无法标记所有话题为已读"
            });
        }
    };

    return (
        <DefaultLayout>
            <section className="flex flex-col gap-4 py-0 md:py-10">
                <div className="hidden sm:flex items-center justify-center">
                    <img alt="logo" className="w-21 mr-5" src="./logo.webp" />
                    <div className="flex flex-col items-center justify-center gap-4">
                        <h1 className={title()}>最新话题</h1>
                        <p className="text-default-600 max-w-2xl text-center">按时间排序的最新聊天话题摘要</p>
                    </div>
                </div>

                <Card className="mt-0 md:mt-6">
                    <CardHeader className="flex flex-row justify-between items-center pl-7 pr-7 gap-4">
                        <div className="flex flex-row items-center gap-4">
                            <h2 className="text-xl font-bold min-w-[135px]">话题列表 ({totalTopics})</h2>
                            <Input
                                isClearable
                                aria-label="全文搜索"
                                className="max-w-[135px]"
                                placeholder="搜索..."
                                startContent={<Search size={16} />}
                                value={searchText}
                                onValueChange={value => {
                                    setSearchText(value);
                                    setPage(1);
                                }}
                            />
                        </div>

                        {/* 顶栏右侧 */}
                        <ResponsivePopover buttonText="筛选...">
                            <Suspense
                                fallback={
                                    <div className="flex min-h-10 items-center justify-center px-4">
                                        <Spinner size="sm" />
                                    </div>
                                }
                            >
                                <LatestTopicsFilterPanel
                                    dateRange={dateRange}
                                    filterFavorite={filterFavorite}
                                    filterRead={filterRead}
                                    getGroupSelectLabel={getGroupSelectLabel}
                                    groups={groups}
                                    isLoading={loading}
                                    selectedGroupId={selectedGroupId}
                                    sortByInterest={sortByInterest}
                                    topicsPerPage={topicsPerPage}
                                    onDateRangeChange={range => {
                                        setDateRange(range);
                                        setPage(1);
                                    }}
                                    onFilterFavoriteChange={value => {
                                        setFilterFavorite(value);
                                        setPage(1);
                                    }}
                                    onFilterReadChange={value => {
                                        setFilterRead(value);
                                        setPage(1);
                                    }}
                                    onRefresh={() => {
                                        fetchLatestTopics();
                                    }}
                                    onSelectedGroupIdChange={value => {
                                        setSelectedGroupId(value);
                                        setPage(1);
                                    }}
                                    onSortByInterestChange={value => {
                                        setSortByInterest(value);
                                        setPage(1);
                                    }}
                                    onTopicsPerPageChange={value => {
                                        setTopicsPerPage(value);
                                        setPage(1);
                                    }}
                                />
                            </Suspense>
                        </ResponsivePopover>
                    </CardHeader>

                    <CardBody>
                        {loading ? (
                            <div className="flex justify-center items-center h-64">
                                <Spinner size="lg" />
                            </div>
                        ) : currentPageTopics.length > 0 ? (
                            <div className="flex flex-col gap-4">
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-0 md:p-5">
                                    {currentPageTopics.map((topic, index) => (
                                        <TopicCard
                                            key={`${topic.topicId}-${index}`}
                                            favoriteTopics={favoriteTopics}
                                            index={(page - 1) * topicsPerPage + index + 1}
                                            interestScore={interestScores[topic.topicId]}
                                            readTopics={readTopics}
                                            topic={topic}
                                            onMarkAsRead={markAsRead}
                                            onToggleFavorite={toggleFavorite}
                                        />
                                    ))}
                                </div>

                                {(totalPages > 1 || hasUnreadTopicOnCurrentPage) && (
                                    <div className="flex flex-col items-center gap-3 md:flex-row md:justify-center md:gap-4">
                                        {totalPages > 1 && <Pagination showControls color="primary" page={page} size="md" total={totalPages} onChange={setPage} />}
                                        {hasUnreadTopicOnCurrentPage && (
                                            <Tooltip color="primary" content="将当前页面所有未读话题标记为已读" placement="top">
                                                <Button color="primary" size="sm" startContent={<Check size={16} />} variant="flat" onPress={markCurrentPageAsRead}>
                                                    整页已读
                                                </Button>
                                            </Tooltip>
                                        )}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="text-center py-12">
                                <p className="text-default-500">暂无话题数据，请调整筛选条件后重试</p>
                                <Button
                                    className="mt-4"
                                    color="primary"
                                    variant="light"
                                    onPress={() => {
                                        fetchLatestTopics();
                                    }}
                                >
                                    重新加载
                                </Button>
                            </div>
                        )}
                    </CardBody>
                </Card>
            </section>
        </DefaultLayout>
    );
}
