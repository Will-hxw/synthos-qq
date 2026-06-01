import type { TopicItem } from "@/types/topic";
import type { GroupDetailsRecord } from "@/types/group";
import type { ApiResponse } from "@/types/api";

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Pagination } from "@heroui/pagination";
import { Spinner } from "@heroui/spinner";
import { ScrollShadow } from "@heroui/scroll-shadow";
import { DateRangePicker, Tooltip, Input, Checkbox, Select, SelectItem } from "@heroui/react";
import { Check, Search } from "lucide-react";
import { today, getLocalTimeZone, CalendarDate } from "@internationalized/date";

import TopicCard from "@/components/topic/TopicCard";
import QQAvatar from "@/components/QQAvatar";
import { getGroupDetails } from "@/api/basicApi";
import { getLatestTopics } from "@/api/latestTopicsApi";
import { markTopicAsRead, markTopicAsFavorite, removeTopicFromFavorites } from "@/api/readAndFavApi";
import { title } from "@/components/primitives";
import DefaultLayout from "@/layouts/default";
import { Notification } from "@/util/Notification";
import ResponsivePopover from "@/components/ResponsivePopover";

const MIN_UNIX_MS_TIMESTAMP = 0;
const DEFAULT_TOPICS_PER_PAGE = 3;
const DEFAULT_START_DATE = new CalendarDate(1970, 1, 1);

const getDefaultEndDate = () => today(getLocalTimeZone());

const normalizeUnixMsTimestamp = (date: Date): number => Math.max(MIN_UNIX_MS_TIMESTAMP, date.getTime());

const toInclusiveDateEnd = (date: CalendarDate): Date => date.add({ days: 1 }).toDate(getLocalTimeZone());

const getApiDataOrThrow = <T,>(response: ApiResponse<T>, action: string): T => {
    if (!response.success) {
        throw new Error(`${action}失败：${response.message || "接口返回失败"}`);
    }

    return response.data;
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
    const [topics, setTopics] = useState<TopicItem[]>([]);
    const [totalTopics, setTotalTopics] = useState<number>(0);
    const [loading, setLoading] = useState<boolean>(true);
    const [page, setPage] = useState<number>(1);
    const [topicsPerPage, setTopicsPerPage] = useState<number>(DEFAULT_TOPICS_PER_PAGE); // 将topicsPerPage改为状态
    const [readTopics, setReadTopics] = useState<Record<string, boolean>>({});
    const [favoriteTopics, setFavoriteTopics] = useState<Record<string, boolean>>({}); // 收藏状态
    const [interestScores, setInterestScores] = useState<Record<string, number>>({}); // 兴趣得分状态

    // 群组筛选状态
    const [groups, setGroups] = useState<GroupDetailsRecord>({});
    const [selectedGroupId, setSelectedGroupId] = useState<string>(""); // 空字符串表示"全部群组"

    // 筛选状态
    const [filterRead, setFilterRead] = useState<boolean>(true); // 过滤已读
    const [filterFavorite, setFilterFavorite] = useState<boolean>(false); // 筛选收藏
    const [sortByInterest, setSortByInterest] = useState<boolean>(false); // 按兴趣度排序
    const [searchText, setSearchText] = useState<string>(""); // 全文搜索

    // 默认时间范围
    const [dateRange, setDateRange] = useState({
        start: DEFAULT_START_DATE,
        end: getDefaultEndDate()
    });

    // 标记是否已从URL初始化
    const [isInitializedFromUrl, setIsInitializedFromUrl] = useState<boolean>(false);
    const requestSeqRef = useRef<number>(0);
    const latestTopicsAbortRef = useRef<AbortController | null>(null);

    const abortLatestTopicsRequest = () => {
        if (!latestTopicsAbortRef.current) {
            return;
        }

        latestTopicsAbortRef.current.abort();
        latestTopicsAbortRef.current = null;
    };

    // 从URL参数初始化状态
    useEffect(() => {
        const fetchGroupsAndInitFromUrl = async () => {
            try {
                const response = await getGroupDetails();

                if (response.success) {
                    setGroups(response.data);
                    const groupIds = Object.keys(response.data);

                    // 从URL获取参数
                    const urlGroupId = searchParams.get("groupId");
                    const urlFilterRead = searchParams.get("filterRead");
                    const urlFilterFavorite = searchParams.get("filterFavorite");
                    const urlSortByInterest = searchParams.get("sortByInterest");
                    const urlSearchText = searchParams.get("search");
                    const urlPage = searchParams.get("page");
                    const urlPageSize = searchParams.get("pageSize");
                    const urlStartDate = searchParams.get("startDate");
                    const urlEndDate = searchParams.get("endDate");

                    // 处理群组ID
                    if (urlGroupId) {
                        if (groupIds.includes(urlGroupId)) {
                            setSelectedGroupId(urlGroupId);
                        } else {
                            // URL中的groupId不存在于群组列表中，提示用户
                            Notification.error({
                                title: "群组不存在",
                                description: `URL中指定的群组ID "${urlGroupId}" 不存在`
                            });
                        }
                    }

                    // 处理筛选开关
                    if (urlFilterRead !== null) {
                        setFilterRead(urlFilterRead === "true");
                    }
                    if (urlFilterFavorite !== null) {
                        setFilterFavorite(urlFilterFavorite === "true");
                    }
                    if (urlSortByInterest !== null) {
                        setSortByInterest(urlSortByInterest === "true");
                    }

                    // 处理搜索文本
                    if (urlSearchText) {
                        setSearchText(urlSearchText);
                    }

                    // 处理页码
                    if (urlPage) {
                        const pageNum = parseInt(urlPage, 10);

                        if (!isNaN(pageNum) && pageNum >= 1) {
                            setPage(pageNum);
                        }
                    }

                    if (urlPageSize) {
                        const pageSizeNum = parseInt(urlPageSize, 10);

                        if ([3, 6, 9, 12].includes(pageSizeNum)) {
                            setTopicsPerPage(pageSizeNum);
                        }
                    }

                    // 处理时间范围
                    if (urlStartDate && urlEndDate) {
                        try {
                            const startParts = urlStartDate.split("-").map(Number);
                            const endParts = urlEndDate.split("-").map(Number);

                            if (startParts.length === 3 && endParts.length === 3) {
                                setDateRange({
                                    start: new CalendarDate(startParts[0], startParts[1], startParts[2]),
                                    end: new CalendarDate(endParts[0], endParts[1], endParts[2])
                                });
                            }
                        } catch {
                            // 日期解析失败，使用默认值
                        }
                    }
                }
            } catch (error) {
                console.error("获取群组信息失败:", error);
            } finally {
                setIsInitializedFromUrl(true);
            }
        };

        fetchGroupsAndInitFromUrl();
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
        const defaultStart = DEFAULT_START_DATE;
        const defaultEnd = getDefaultEndDate();

        // 只有当时间范围不是默认值时才写入URL
        const isStartDefault = dateRange.start.year === defaultStart.year && dateRange.start.month === defaultStart.month && dateRange.start.day === defaultStart.day;
        const isEndDefault = dateRange.end.year === defaultEnd.year && dateRange.end.month === defaultEnd.month && dateRange.end.day === defaultEnd.day;

        if (!isStartDefault || !isEndDefault) {
            newParams.set("startDate", `${dateRange.start.year}-${String(dateRange.start.month).padStart(2, "0")}-${String(dateRange.start.day).padStart(2, "0")}`);
            newParams.set("endDate", `${dateRange.end.year}-${String(dateRange.end.month).padStart(2, "0")}-${String(dateRange.end.day).padStart(2, "0")}`);
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
            await markTopicAsRead(topicId);

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
                            <div className="flex flex-col lg:flex-row lg:items-center gap-4 p-3 lg:p-0">
                                {/* 群组选择器 */}
                                <Select
                                    className="w-full lg:w-60"
                                    isClearable={true}
                                    label="群组"
                                    placeholder="全部群组"
                                    selectedKeys={selectedGroupId ? [selectedGroupId] : []}
                                    size="sm"
                                    onSelectionChange={keys => {
                                        if (keys === "all" || (keys instanceof Set && keys.size === 0)) {
                                            setSelectedGroupId("");
                                        } else {
                                            const selectedKey = Array.from(keys)[0] as string;

                                            setSelectedGroupId(selectedKey || "");
                                        }
                                        setPage(1);
                                    }}
                                >
                                    {Object.keys(groups).map(groupId => {
                                        const groupLabel = getGroupSelectLabel(groupId);

                                        return (
                                            <SelectItem key={groupId} startContent={<QQAvatar qqId={groupId} type="group" />} textValue={groupLabel}>
                                                {groupLabel}
                                            </SelectItem>
                                        );
                                    })}
                                </Select>

                                {/* 筛选控件 */}
                                <div className="flex gap-3 items-center">
                                    <Select
                                        className="w-27"
                                        label="每页话题数"
                                        selectedKeys={[String(topicsPerPage)]}
                                        size="sm"
                                        onSelectionChange={keys => {
                                            const selected = Array.from(keys)[0];

                                            if (selected) {
                                                setTopicsPerPage(Number(selected));
                                                setPage(1);
                                            }
                                        }}
                                    >
                                        <SelectItem key="3">3</SelectItem>
                                        <SelectItem key="6">6</SelectItem>
                                        <SelectItem key="9">9</SelectItem>
                                        <SelectItem key="12">12</SelectItem>
                                    </Select>
                                </div>

                                <Checkbox
                                    className="w-110"
                                    isSelected={filterRead}
                                    onValueChange={value => {
                                        setFilterRead(value);
                                        setPage(1);
                                    }}
                                >
                                    只看未读
                                </Checkbox>

                                <Checkbox
                                    className="w-110"
                                    isSelected={filterFavorite}
                                    onValueChange={value => {
                                        setFilterFavorite(value);
                                        setPage(1);
                                    }}
                                >
                                    只看收藏
                                </Checkbox>

                                <Checkbox
                                    className="w-150"
                                    isSelected={sortByInterest}
                                    onValueChange={value => {
                                        setSortByInterest(value);
                                        setPage(1);
                                    }}
                                >
                                    按兴趣度排序
                                </Checkbox>

                                {/* 日期选择器 + 刷新按钮 */}
                                <DateRangePicker
                                    className="w-full lg:w-70"
                                    label="时间范围"
                                    value={dateRange}
                                    onChange={range => {
                                        if (range) {
                                            setDateRange({
                                                start: range.start,
                                                end: range.end
                                            });
                                            setPage(1);
                                        }
                                    }}
                                />
                                <Button
                                    color="primary"
                                    isLoading={loading}
                                    onPress={() => {
                                        fetchLatestTopics();
                                    }}
                                >
                                    刷新
                                </Button>
                            </div>
                        </ResponsivePopover>
                    </CardHeader>

                    <CardBody className="relative">
                        {loading ? (
                            <div className="flex justify-center items-center h-64">
                                <Spinner size="lg" />
                            </div>
                        ) : currentPageTopics.length > 0 ? (
                            <div className="flex flex-col gap-4">
                                <ScrollShadow className="max-h-[calc(100vh-220px)]">
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
                                </ScrollShadow>

                                {totalPages > 1 && (
                                    <div className="flex justify-center mt-4">
                                        <Pagination showControls color="primary" page={page} size="md" total={totalPages} onChange={setPage} />
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

                        {/* 整页已读按钮 - 固定在右下角 */}
                        {!loading && currentPageTopics.length > 0 && currentPageTopics.some(topic => !readTopics[topic.topicId]) && (
                            <div className="absolute bottom-4 right-4 hidden md:block">
                                <Tooltip color="primary" content="将当前页面所有未读话题标记为已读" placement="top">
                                    <Button
                                        color="primary"
                                        size="sm"
                                        startContent={<Check size={16} />}
                                        variant="flat"
                                        onPress={async () => {
                                            const unreadTopics = currentPageTopics.filter(topic => !readTopics[topic.topicId]);

                                            try {
                                                // 批量标记为已读
                                                const promises = unreadTopics.map(topic => markTopicAsRead(topic.topicId));

                                                await Promise.all(promises);

                                                // 更新本地状态
                                                const newReadTopics = { ...readTopics };

                                                unreadTopics.forEach(topic => {
                                                    newReadTopics[topic.topicId] = true;
                                                });
                                                setReadTopics(newReadTopics);

                                                if (filterRead) {
                                                    const unreadTopicIds = new Set(unreadTopics.map(topic => topic.topicId));

                                                    setTopics(prev => prev.filter(topic => !unreadTopicIds.has(topic.topicId)));
                                                    setTotalTopics(prev => Math.max(0, prev - unreadTopics.length));
                                                    await fetchLatestTopics({ silent: true });
                                                }

                                                Notification.success({
                                                    title: "批量标记成功",
                                                    description: `已将 ${unreadTopics.length} 个话题标记为已读`
                                                });
                                            } catch (error) {
                                                console.error("Failed to mark all topics as read:", error);
                                                Notification.error({
                                                    title: "批量标记失败",
                                                    description: "无法标记所有话题为已读"
                                                });
                                            }
                                        }}
                                    >
                                        整页已读
                                    </Button>
                                </Tooltip>
                            </div>
                        )}
                    </CardBody>
                </Card>
            </section>
        </DefaultLayout>
    );
}
