import type { GroupDetailsRecord, GroupListItem, MessageHourlyStatsData } from "@/types/index";

import { lazy, Suspense, useState, useEffect, useMemo, useRef } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow, SortDescriptor } from "@heroui/table";
import { Chip } from "@heroui/chip";
import { Spinner } from "@heroui/spinner";
import { Tooltip } from "@heroui/react";
import { TrendingDown, TrendingUp } from "lucide-react";

import { getGroupDetails, getMessageHourlyStats } from "@/api/basicApi";
import { title } from "@/components/primitives";
import DefaultLayout from "@/layouts/default";
import SetupStatusNotice from "@/components/setup/SetupStatusNotice";

interface HourlyTrend {
    current: number[];
    previous: number[];
}

const MessageTrendChart = lazy(() => import("@/components/MessageTrendChart"));

export default function GroupsPage() {
    const [groups, setGroups] = useState<GroupDetailsRecord>({});
    const [recentMessageCounts, setRecentMessageCounts] = useState<Record<string, number>>({});
    const [previousMessageCounts, setPreviousMessageCounts] = useState<Record<string, number>>({});
    const [totalRecentMessageCount, setTotalRecentMessageCount] = useState<number>(0);
    const [totalPreviousMessageCount, setTotalPreviousMessageCount] = useState<number>(0);
    const [, setHourlyStats] = useState<MessageHourlyStatsData | null>(null);
    const [isGroupsLoading, setIsGroupsLoading] = useState<boolean>(false);
    const [isStatsLoading, setIsStatsLoading] = useState<boolean>(false);
    const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
    const [hasStatsData, setHasStatsData] = useState<boolean>(false);
    const [statsLoadFailed, setStatsLoadFailed] = useState<boolean>(false);
    const statsRequestSeqRef = useRef<number>(0);
    const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
        column: "messageCount",
        direction: "descending"
    });
    // 走势图数据存入 state，由 MessageTrendChart 组件声明式渲染（替代命令式 init/dispose）
    const [groupHourlyTrends, setGroupHourlyTrends] = useState<Record<string, HourlyTrend>>({});
    const [totalHourlyTrend, setTotalHourlyTrend] = useState<HourlyTrend>({ current: [], previous: [] });
    const [chartTimestamps, setChartTimestamps] = useState<number[]>([]);

    // 渲染“较昨日”涨跌幅（上涨红色、下跌绿色）
    const renderDayOverDayChange = (currentCount: number, previousCount: number) => {
        const diff = currentCount - previousCount;
        const isUp = diff > 0;
        const isDown = diff < 0;

        let percentText: string;
        let tooltipText: string;

        if (previousCount === 0) {
            if (currentCount === 0) {
                percentText = "0.0%";
                tooltipText = "昨日消息量为 0，本次也为 0";
            } else {
                percentText = "+∞";
                tooltipText = "昨日消息量为 0，无法计算百分比";
            }
        } else {
            percentText = `${diff >= 0 ? "+" : ""}${((diff / previousCount) * 100).toFixed(1)}%`;
            tooltipText = `较昨日${isUp ? "增加" : isDown ? "减少" : "持平"} ${Math.abs(diff)} 条`;
        }

        const chipColor = isUp ? "danger" : isDown ? "success" : "default";
        const icon = isUp ? <TrendingUp size={14} /> : isDown ? <TrendingDown size={14} /> : null;

        return (
            <Tooltip color="primary" content={tooltipText} placement="top">
                <Chip color={chipColor} size="sm" startContent={icon} variant="flat">
                    较昨日 {percentText}
                </Chip>
            </Tooltip>
        );
    };

    // 获取消息统计
    const resetStatsState = () => {
        setHourlyStats(null);
        setRecentMessageCounts({});
        setPreviousMessageCounts({});
        setTotalRecentMessageCount(0);
        setTotalPreviousMessageCount(0);
        setGroupHourlyTrends({});
        setTotalHourlyTrend({ current: [], previous: [] });
        setChartTimestamps([]);
        setHasStatsData(false);
        setStatsLoadFailed(false);
    };

    const fetchMessageHourlyStats = async (groupIds: string[]) => {
        const requestId = statsRequestSeqRef.current + 1;

        statsRequestSeqRef.current = requestId;
        setIsStatsLoading(true);
        setStatsLoadFailed(false);
        setHasStatsData(false);

        if (groupIds.length === 0) {
            resetStatsState();
            setIsStatsLoading(false);
            return;
        }

        try {
            const response = await getMessageHourlyStats(groupIds);

            if (statsRequestSeqRef.current !== requestId) {
                return;
            }

            if (response.success) {
                const statsData = response.data;

                setHourlyStats(statsData);

                // 计算每个群组的当前24小时/前一天24小时总消息量
                const currentCounts: Record<string, number> = {};
                const previousCounts: Record<string, number> = {};

                for (const groupId of groupIds) {
                    const groupData = statsData.data[groupId];

                    if (groupData) {
                        currentCounts[groupId] = groupData.current.reduce((sum, count) => sum + count, 0);
                        previousCounts[groupId] = groupData.previous.reduce((sum, count) => sum + count, 0);
                    } else {
                        currentCounts[groupId] = 0;
                        previousCounts[groupId] = 0;
                    }
                }
                setRecentMessageCounts(currentCounts);
                setPreviousMessageCounts(previousCounts);
                setTotalRecentMessageCount(statsData.totalCounts.current);
                setTotalPreviousMessageCount(statsData.totalCounts.previous);

                // 计算总计的每小时数据
                const totalCurrentHourly = new Array(24).fill(0);
                const totalPreviousHourly = new Array(24).fill(0);
                const perGroupTrends: Record<string, HourlyTrend> = {};

                for (const groupId of groupIds) {
                    const groupData = statsData.data[groupId];

                    if (groupData) {
                        groupData.current.forEach((count, index) => {
                            totalCurrentHourly[index] += count;
                        });
                        groupData.previous.forEach((count, index) => {
                            totalPreviousHourly[index] += count;
                        });
                        perGroupTrends[groupId] = { current: groupData.current, previous: groupData.previous };
                    }
                }

                // 走势数据写入 state，交给 MessageTrendChart 声明式渲染（不再用 setTimeout 命令式 init）
                setChartTimestamps(statsData.timestamps.current);
                setTotalHourlyTrend({ current: totalCurrentHourly, previous: totalPreviousHourly });
                setGroupHourlyTrends(perGroupTrends);
                setHasStatsData(true);
            } else {
                setStatsLoadFailed(true);
                console.error("获取消息统计失败:", response.message);
            }
        } catch (error) {
            if (statsRequestSeqRef.current !== requestId) {
                return;
            }
            setStatsLoadFailed(true);
            console.error("获取消息统计失败:", error);
        }
        if (statsRequestSeqRef.current === requestId) {
            setIsStatsLoading(false);
        }
    };

    // 获取群组信息
    const fetchGroups = async () => {
        const hasExistingGroups = Object.keys(groups).length > 0;

        setIsGroupsLoading(!hasExistingGroups);
        setIsRefreshing(hasExistingGroups);
        try {
            const response = await getGroupDetails();

            if (response.success) {
                setGroups(response.data);
                resetStatsState();
                void fetchMessageHourlyStats(Object.keys(response.data));
            } else {
                console.error("获取群组信息失败:", response.message);
            }
        } catch (error) {
            console.error("获取群组信息失败:", error);
        } finally {
            setIsGroupsLoading(false);
            setIsRefreshing(false);
        }
    };

    // 初始化加载群组信息
    useEffect(() => {
        fetchGroups();
    }, []);

    // 获取分组策略标签
    const getSplitStrategyLabel = (strategy: string) => {
        switch (strategy) {
            case "realtime":
                return "实时分组";
            case "accumulative":
                return "累积分组";
            default:
                return strategy;
        }
    };

    // 获取分组策略颜色
    const getSplitStrategyColor = (strategy: string) => {
        switch (strategy) {
            case "realtime":
                return "success";
            case "accumulative":
                return "warning";
            default:
                return "default";
        }
    };

    // 构建并排序群组列表
    const sortedGroupList = useMemo(() => {
        const items: GroupListItem[] = Object.entries(groups).map(([groupId, groupDetail]) => ({
            groupId,
            groupDetail,
            messageCount: recentMessageCounts[groupId] ?? 0,
            previousMessageCount: previousMessageCounts[groupId] ?? 0
        }));

        // 根据排序描述符进行排序
        if (sortDescriptor.column) {
            items.sort((a, b) => {
                let first: string | number;
                let second: string | number;

                switch (sortDescriptor.column) {
                    case "groupId":
                        first = a.groupId;
                        second = b.groupId;
                        break;
                    case "platform":
                        first = a.groupDetail.IM;
                        second = b.groupDetail.IM;
                        break;
                    case "splitStrategy":
                        first = a.groupDetail.splitStrategy;
                        second = b.groupDetail.splitStrategy;
                        break;
                    case "messageCount":
                        first = a.messageCount;
                        second = b.messageCount;
                        break;
                    case "previousMessageCount":
                        first = a.previousMessageCount;
                        second = b.previousMessageCount;
                        break;
                    default:
                        return 0;
                }

                // 比较逻辑：支持数字和字符串
                let cmp: number;

                if (typeof first === "number" && typeof second === "number") {
                    cmp = first < second ? -1 : first > second ? 1 : 0;
                } else {
                    cmp = String(first).localeCompare(String(second));
                }

                if (sortDescriptor.direction === "descending") {
                    cmp *= -1;
                }

                return cmp;
            });
        }

        return items;
    }, [groups, recentMessageCounts, previousMessageCounts, sortDescriptor]);

    // 处理排序变更
    const handleSortChange = (descriptor: SortDescriptor) => {
        setSortDescriptor(descriptor);
    };

    const renderCountValue = (value: number) => {
        if (isStatsLoading) {
            return <div aria-label="统计加载中" className="h-5 w-12 rounded bg-default-200 animate-pulse" />;
        }

        if (statsLoadFailed && !hasStatsData) {
            return <span className="text-default-400">--</span>;
        }

        return <span className="font-semibold">{value}</span>;
    };

    const renderStatsChange = (currentCount: number, previousCount: number) => {
        if (isStatsLoading) {
            return <div aria-label="统计加载中" className="h-6 w-24 rounded-full bg-default-200 animate-pulse" />;
        }

        if (statsLoadFailed && !hasStatsData) {
            return (
                <Chip color="warning" size="sm" variant="flat">
                    统计失败
                </Chip>
            );
        }

        return renderDayOverDayChange(currentCount, previousCount);
    };

    // 走势图列统一尺寸：宽度自适应列宽，min/max 约束防止过窄或过宽，使 ResizeObserver 真正生效
    const trendChartBoxClass = "h-[100px] w-full min-w-[200px] max-w-[340px]";

    const renderTrendChart = (currentHourlyData: number[], previousHourlyData: number[]) => {
        if (isStatsLoading) {
            return <div aria-label="统计加载中" className={`${trendChartBoxClass} rounded bg-default-200 animate-pulse`} />;
        }

        if (statsLoadFailed && !hasStatsData) {
            return <div className={`${trendChartBoxClass} flex items-center justify-center rounded bg-default-100 text-xs text-default-400`}>统计加载失败</div>;
        }

        if (!hasStatsData) {
            return <div className={`${trendChartBoxClass} rounded bg-default-100`} />;
        }

        return (
            <div className={trendChartBoxClass}>
                <Suspense fallback={<div aria-label="走势图加载中" className="h-full w-full rounded bg-default-100" />}>
                    <MessageTrendChart currentHourlyData={currentHourlyData} height="100%" previousHourlyData={previousHourlyData} timestamps={chartTimestamps} width="100%" />
                </Suspense>
            </div>
        );
    };

    return (
        <DefaultLayout>
            <section className="flex flex-col gap-4 py-8 md:py-10">
                <div className="flex flex-col items-center justify-center gap-4">
                    <h1 className={title()}>群组管理</h1>
                    <p className="text-default-600 max-w-2xl text-center">管理QQ群组配置信息，查看群组AI模型设置和分组策略</p>
                </div>

                <Card className="mt-6">
                    <CardHeader>
                        <div className="flex justify-between items-center w-full p-3">
                            <h3 className="text-lg font-bold">群组列表 ({Object.entries(groups).length})</h3>
                            <Button color="primary" isLoading={isGroupsLoading || isRefreshing || isStatsLoading} size="sm" onPress={fetchGroups}>
                                {isGroupsLoading || isRefreshing || isStatsLoading ? <Spinner size="sm" /> : "刷新"}
                            </Button>
                        </div>
                    </CardHeader>
                    <CardBody>
                        {isGroupsLoading && Object.keys(groups).length === 0 ? (
                            <div className="flex justify-center items-center h-64">
                                <Spinner size="lg" />
                            </div>
                        ) : (
                            <Table aria-label="群组列表" sortDescriptor={sortDescriptor} onSortChange={handleSortChange}>
                                <TableHeader>
                                    <TableColumn key="avatar">群头像</TableColumn>
                                    <TableColumn key="groupId" allowsSorting>
                                        群号
                                    </TableColumn>
                                    <TableColumn key="platform" allowsSorting>
                                        平台
                                    </TableColumn>
                                    <TableColumn key="groupName">群名称</TableColumn>
                                    <TableColumn key="splitStrategy" allowsSorting>
                                        分组策略
                                    </TableColumn>
                                    <TableColumn key="messageCount" allowsSorting>
                                        最近24小时消息量
                                    </TableColumn>
                                    <TableColumn key="previousMessageCount" allowsSorting>
                                        前一天24小时消息量
                                    </TableColumn>
                                    <TableColumn key="messageTrend">最近24小时消息量走势</TableColumn>
                                </TableHeader>
                                <TableBody emptyContent={"未找到群组信息"}>
                                    <>
                                        {/* 总计行 - 始终固定在顶部，不参与排序 */}
                                        <TableRow key="total">
                                            <TableCell>
                                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                                                    <span className="font-bold">总计</span>
                                                </div>
                                            </TableCell>
                                            <TableCell className="font-semibold">所有群组</TableCell>
                                            <TableCell>-</TableCell>
                                            <TableCell>-</TableCell>
                                            <TableCell>-</TableCell>
                                            <TableCell>
                                                <div className="flex flex-col gap-1">
                                                    {renderCountValue(totalRecentMessageCount)}
                                                    {renderStatsChange(totalRecentMessageCount, totalPreviousMessageCount)}
                                                </div>
                                            </TableCell>
                                            <TableCell>{renderCountValue(totalPreviousMessageCount)}</TableCell>
                                            <TableCell>{renderTrendChart(totalHourlyTrend.current, totalHourlyTrend.previous)}</TableCell>
                                        </TableRow>
                                        {/* 群组数据行 - 根据排序描述符排序 */}
                                        {sortedGroupList.map(({ groupId, groupDetail, messageCount, previousMessageCount }) => (
                                            <TableRow key={groupId}>
                                                <TableCell>
                                                    <img
                                                        alt="群头像"
                                                        className="w-10 h-10 rounded-full"
                                                        decoding="async"
                                                        height={40}
                                                        loading="lazy"
                                                        src={`https://p.qlogo.cn/gh/${groupId}/${groupId}/0`}
                                                        width={40}
                                                        onError={e => {
                                                            const target = e.target as HTMLImageElement;

                                                            target.onerror = null;
                                                            target.src =
                                                                "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23ccc'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";
                                                        }}
                                                    />
                                                </TableCell>
                                                <TableCell className="font-semibold">{groupId}</TableCell>
                                                <TableCell>
                                                    <Chip color={groupDetail.IM === "QQ" ? "primary" : "secondary"} variant="flat">
                                                        {groupDetail.IM}
                                                    </Chip>
                                                </TableCell>
                                                <TableCell>{groupDetail.groupName?.trim() ? groupDetail.groupName : groupId}</TableCell>
                                                <TableCell>
                                                    <Chip color={getSplitStrategyColor(groupDetail.splitStrategy)} variant="flat">
                                                        {getSplitStrategyLabel(groupDetail.splitStrategy)}
                                                    </Chip>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col gap-1">
                                                        {renderCountValue(messageCount)}
                                                        {renderStatsChange(messageCount, previousMessageCount)}
                                                    </div>
                                                </TableCell>
                                                <TableCell>{renderCountValue(previousMessageCount)}</TableCell>
                                                <TableCell>{renderTrendChart(groupHourlyTrends[groupId]?.current ?? [], groupHourlyTrends[groupId]?.previous ?? [])}</TableCell>
                                            </TableRow>
                                        ))}
                                    </>
                                </TableBody>
                            </Table>
                        )}
                        {!isGroupsLoading && Object.keys(groups).length === 0 && <SetupStatusNotice className="mt-4" />}
                    </CardBody>
                </Card>

                {/* <Card className="mt-6">
                    <CardHeader>
                        <h3 className="text-lg font-bold">使用说明</h3>
                    </CardHeader>
                    <CardBody>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <h4 className="font-semibold mb-2">分组策略</h4>
                                <ul className="list-disc pl-5 space-y-1">
                                    <li>
                                        <span className="font-medium">实时分组:</span>{" "}
                                        根据消息时间实时划分会话
                                    </li>
                                    <li>
                                        <span className="font-medium">累积分组:</span>{" "}
                                        将连续消息累积为一个会话
                                    </li>
                                </ul>
                            </div>
                            <div>
                                <h4 className="font-semibold mb-2">AI模型</h4>
                                <ul className="list-disc pl-5 space-y-1">
                                    <li>
                                        <span className="font-medium">GPT-3.5 Turbo:</span>{" "}
                                        快速且成本较低的模型
                                    </li>
                                    <li>
                                        <span className="font-medium">GPT-4:</span>{" "}
                                        更强大但成本较高的模型
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </CardBody>
                </Card> */}
            </section>
        </DefaultLayout>
    );
}
