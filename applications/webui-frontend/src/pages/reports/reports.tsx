import type { TopicReferenceItem } from "@/types/topicReference";

import { lazy, Suspense, useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Pagination } from "@heroui/pagination";
import { Spinner } from "@heroui/spinner";
import { Tabs, Tab, Chip, Calendar, Select, SelectItem, addToast, closeToast } from "@heroui/react";
import { FileText, RefreshCw, Plus } from "lucide-react";
import { today, getLocalTimeZone, CalendarDate } from "@internationalized/date";

import ReportCard from "./components/ReportCard";
import { useTopicStatus } from "./hooks/useTopicStatus";

import {
    getReportsPaginated,
    getReportsByDate,
    getReportById,
    triggerReportGenerate,
    markReportAsRead,
    getReportsReadStatus,
    sendReportEmail,
    markReportAsFavorite,
    removeReportFromFavorites,
    getReportsFavoriteStatus,
    deleteReport
} from "@/api/reportApi";
import { getCurrentConfig } from "@/api/configApi";
import { title } from "@/components/primitives";
import DefaultLayout from "@/layouts/default";
import { Notification } from "@/util/Notification";
import { Report, ReportType } from "@/types";

const ReportDetailModal = lazy(() => import("./components/ReportDetailModal"));

export default function ReportsPage() {
    const [searchParams, setSearchParams] = useSearchParams();

    // 状态管理
    const [reports, setReports] = useState<Report[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [page, setPage] = useState<number>(1);
    const [total, setTotal] = useState<number>(0);
    const [pageSize] = useState<number>(10);
    const [selectedType, setSelectedType] = useState<ReportType | "all">("all");

    // 收藏筛选：all(全部) | favorite(仅收藏)
    const [favoriteFilter, setFavoriteFilter] = useState<"all" | "favorite">("all");

    // 日历视图相关
    const [selectedDate, setSelectedDate] = useState<CalendarDate>(today(getLocalTimeZone()));
    const [dateReports, setDateReports] = useState<Report[]>([]);
    const [dateLoading, setDateLoading] = useState<boolean>(false);

    // 详情弹窗
    const [selectedReport, setSelectedReport] = useState<Report | null>(null);
    const [selectedReferences, setSelectedReferences] = useState<TopicReferenceItem[]>([]);
    const [isModalOpen, setIsModalOpen] = useState<boolean>(false);

    const { favoriteTopics, readTopics, loadStatuses, onMarkAsRead: onMarkTopicAsRead, onToggleFavorite: onToggleTopicFavorite } = useTopicStatus();

    // 视图模式: list(列表) | calendar(日历)
    const [viewMode, setViewMode] = useState<"list" | "calendar">("list");

    // 手动生成日报相关
    const [generateType, setGenerateType] = useState<ReportType>("half-daily");
    const [generating, setGenerating] = useState<boolean>(false);

    // 已读状态
    const [readReports, setReadReports] = useState<Record<string, boolean>>({});

    // 收藏状态
    const [favoriteReports, setFavoriteReports] = useState<Record<string, boolean>>({});

    // 待删除定时器（reportId -> timer），用于“延迟真删 + 可撤销”
    const pendingDeletesRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    // 邮件功能相关状态
    const [emailEnabled, setEmailEnabled] = useState<boolean>(false);
    const [sendingEmailReportId, setSendingEmailReportId] = useState<string | null>(null);

    // 标记是否已从URL初始化
    const [isInitializedFromUrl, setIsInitializedFromUrl] = useState<boolean>(false);

    // 从URL参数初始化状态
    useEffect(() => {
        const initFromUrl = async () => {
            const urlViewMode = searchParams.get("viewMode");
            const urlSelectedType = searchParams.get("type");
            const urlPage = searchParams.get("page");
            const urlSelectedDate = searchParams.get("date");
            const urlReportId = searchParams.get("reportId");

            // 处理视图模式
            if (urlViewMode === "list" || urlViewMode === "calendar") {
                setViewMode(urlViewMode);
            }

            // 处理报告类型
            if (urlSelectedType === "all" || urlSelectedType === "half-daily" || urlSelectedType === "weekly" || urlSelectedType === "monthly") {
                setSelectedType(urlSelectedType);
            }

            // 处理页码
            if (urlPage) {
                const pageNum = parseInt(urlPage, 10);

                if (!isNaN(pageNum) && pageNum >= 1) {
                    setPage(pageNum);
                }
            }

            // 处理选中日期（日历视图）
            if (urlSelectedDate) {
                try {
                    const dateParts = urlSelectedDate.split("-").map(Number);

                    if (dateParts.length === 3) {
                        setSelectedDate(new CalendarDate(dateParts[0], dateParts[1], dateParts[2]));
                    }
                } catch {
                    // 日期解析失败，使用默认值
                }
            }

            // 处理 reportId，如果存在则加载对应报告并打开弹窗
            if (urlReportId) {
                try {
                    const response = await getReportById(urlReportId);

                    if (response.success) {
                        setSelectedReport(response.data.report);
                        setSelectedReferences(response.data.references);
                        await loadStatuses(response.data.report.topicIds);
                        setIsModalOpen(true);
                    } else {
                        Notification.error({
                            title: "报告不存在",
                            description: `URL中指定的报告ID "${urlReportId}" 不存在`
                        });
                    }
                } catch (error) {
                    console.error("获取报告详情失败:", error);
                    Notification.error({
                        title: "加载失败",
                        description: `无法加载报告 "${urlReportId}"`
                    });
                }
            }

            setIsInitializedFromUrl(true);
        };

        initFromUrl();
    }, []);

    // 同步筛选参数到URL
    useEffect(() => {
        // 只有在初始化完成后才同步URL
        if (!isInitializedFromUrl) {
            return;
        }

        const newParams = new URLSearchParams();

        // 视图模式（默认list，只有calendar时才写入）
        if (viewMode !== "list") {
            newParams.set("viewMode", viewMode);
        }

        // 报告类型（默认all，只有非all时才写入）
        if (selectedType !== "all") {
            newParams.set("type", selectedType);
        }

        // 页码（只有非第一页才写入，且只在列表视图时有意义）
        if (viewMode === "list" && page > 1) {
            newParams.set("page", String(page));
        }

        // 选中日期（日历视图，只有非今天才写入）
        const todayDate = today(getLocalTimeZone());

        if (viewMode === "calendar" && (selectedDate.year !== todayDate.year || selectedDate.month !== todayDate.month || selectedDate.day !== todayDate.day)) {
            newParams.set("date", `${selectedDate.year}-${String(selectedDate.month).padStart(2, "0")}-${String(selectedDate.day).padStart(2, "0")}`);
        }

        // 当前打开的报告ID
        if (selectedReport) {
            newParams.set("reportId", selectedReport.reportId);
        }

        setSearchParams(newParams, { replace: true });
    }, [viewMode, selectedType, page, selectedDate, selectedReport, isInitializedFromUrl, setSearchParams]);

    // 加载日报列表
    const fetchReports = useCallback(async () => {
        setLoading(true);
        try {
            const type = selectedType === "all" ? undefined : selectedType;
            const favoriteOnly = favoriteFilter === "favorite";
            const response = await getReportsPaginated(page, pageSize, type, favoriteOnly);

            if (response.success) {
                setReports(response.data.reports);
                setTotal(response.data.total);
            } else {
                Notification.error({
                    title: "加载失败",
                    description: "无法获取日报列表"
                });
            }
        } catch (error) {
            console.error("获取日报列表失败:", error);
            Notification.error({
                title: "加载失败",
                description: "无法获取日报列表"
            });
        } finally {
            setLoading(false);
        }
    }, [page, pageSize, selectedType, favoriteFilter]);

    // 加载指定日期的日报
    const fetchReportsByDate = useCallback(async (date: CalendarDate) => {
        setDateLoading(true);
        try {
            const jsDate = date.toDate(getLocalTimeZone());
            const response = await getReportsByDate(jsDate.getTime());

            if (response.success) {
                setDateReports(response.data);
            } else {
                setDateReports([]);
            }
        } catch (error) {
            console.error("获取日期日报失败:", error);
            setDateReports([]);
        } finally {
            setDateLoading(false);
        }
    }, []);

    // 初始加载（需等待URL初始化完成）
    useEffect(() => {
        if (!isInitializedFromUrl) {
            return;
        }
        if (viewMode === "list") {
            fetchReports();
        }
    }, [fetchReports, viewMode, isInitializedFromUrl]);

    // 日期变化时加载日报（需等待URL初始化完成）
    useEffect(() => {
        if (!isInitializedFromUrl) {
            return;
        }
        if (viewMode === "calendar") {
            fetchReportsByDate(selectedDate);
        }
    }, [selectedDate, viewMode, fetchReportsByDate, isInitializedFromUrl]);

    // 加载邮件配置状态
    useEffect(() => {
        const loadEmailConfig = async () => {
            try {
                const response = await getCurrentConfig();

                if (response.success && response.data) {
                    const config = response.data as { email?: { enabled?: boolean } };

                    setEmailEnabled(config.email?.enabled === true);
                }
            } catch (error) {
                console.error("获取邮件配置失败:", error);
            }
        };

        loadEmailConfig();
    }, []);

    // 初始化已读状态（列表视图）
    useEffect(() => {
        const initReadStatus = async () => {
            if (reports.length === 0) return;

            try {
                const reportIds = reports.map(report => report.reportId);
                const response = await getReportsReadStatus(reportIds);

                if (response.success) {
                    setReadReports(response.data.readStatus);
                }
            } catch (error) {
                console.error("初始化日报已读状态失败:", error);
            }
        };

        initReadStatus();
    }, [reports]);

    // 初始化已读状态（日历视图）
    useEffect(() => {
        const initDateReadStatus = async () => {
            if (dateReports.length === 0) return;

            try {
                const reportIds = dateReports.map(report => report.reportId);
                const response = await getReportsReadStatus(reportIds);

                if (response.success) {
                    setReadReports(prev => ({
                        ...prev,
                        ...response.data.readStatus
                    }));
                }
            } catch (error) {
                console.error("初始化日报已读状态失败:", error);
            }
        };

        initDateReadStatus();
    }, [dateReports]);

    // 初始化收藏状态（列表视图）
    useEffect(() => {
        const initFavoriteStatus = async () => {
            if (reports.length === 0) return;

            try {
                const reportIds = reports.map(report => report.reportId);
                const response = await getReportsFavoriteStatus(reportIds);

                if (response.success) {
                    setFavoriteReports(prev => ({
                        ...prev,
                        ...response.data.favoriteStatus
                    }));
                }
            } catch (error) {
                console.error("初始化日报收藏状态失败:", error);
            }
        };

        initFavoriteStatus();
    }, [reports]);

    // 初始化收藏状态（日历视图）
    useEffect(() => {
        const initDateFavoriteStatus = async () => {
            if (dateReports.length === 0) return;

            try {
                const reportIds = dateReports.map(report => report.reportId);
                const response = await getReportsFavoriteStatus(reportIds);

                if (response.success) {
                    setFavoriteReports(prev => ({
                        ...prev,
                        ...response.data.favoriteStatus
                    }));
                }
            } catch (error) {
                console.error("初始化日报收藏状态失败:", error);
            }
        };

        initDateFavoriteStatus();
    }, [dateReports]);

    // 打开详情弹窗（拉取 detail + references 用于高亮与 cardlist）
    const openReportDetail = async (report: Report) => {
        setSelectedReport(null);
        setSelectedReferences([]);
        setIsModalOpen(true);

        try {
            const response = await getReportById(report.reportId);

            if (response.success) {
                setSelectedReport(response.data.report);
                setSelectedReferences(response.data.references);
                await loadStatuses(response.data.report.topicIds);
            } else {
                Notification.error({
                    title: "加载失败",
                    description: `无法加载报告 "${report.reportId}"`
                });
            }
        } catch (error) {
            console.error("获取报告详情失败:", error);
            Notification.error({
                title: "加载失败",
                description: `无法加载报告 "${report.reportId}"`
            });
        }
    };

    // 关闭详情弹窗
    const closeReportDetail = () => {
        setIsModalOpen(false);
        setSelectedReport(null);
        setSelectedReferences([]);
    };

    // 计算总页数
    const totalPages = Math.ceil(total / pageSize);

    // 日历日期变化
    const handleDateChange = (date: CalendarDate) => {
        setSelectedDate(date);
    };

    // 快捷跳转到今天
    const goToToday = () => {
        setSelectedDate(today(getLocalTimeZone()));
    };

    // 标记日报为已读
    const handleMarkAsRead = async (reportId: string) => {
        try {
            // 乐观更新本地状态
            setReadReports(prev => ({
                ...prev,
                [reportId]: true
            }));

            // 调用 API 持久化
            await markReportAsRead(reportId);

            Notification.success({
                title: "标记成功",
                description: "日报已标记为已读"
            });
        } catch (error) {
            console.error("标记日报已读失败:", error);
            // 回滚本地状态
            setReadReports(prev => ({
                ...prev,
                [reportId]: false
            }));
            Notification.error({
                title: "标记失败",
                description: "无法标记日报为已读"
            });
        }
    };

    // 发送日报邮件
    const handleSendEmail = async (reportId: string) => {
        setSendingEmailReportId(reportId);
        try {
            const response = await sendReportEmail(reportId);

            if (response.success && response.data.success) {
                Notification.success({
                    title: "发送成功",
                    description: response.data.message
                });
            } else {
                Notification.error({
                    title: "发送失败",
                    description: response.data?.message || "发送日报邮件失败"
                });
            }
        } catch (error) {
            console.error("发送日报邮件失败:", error);
            Notification.error({
                title: "发送失败",
                description: "发送日报邮件失败"
            });
        } finally {
            setSendingEmailReportId(null);
        }
    };

    // 切换日报收藏状态
    const handleToggleFavorite = async (reportId: string) => {
        const isCurrentlyFavorite = favoriteReports[reportId] === true;

        console.log(`[Reports] 切换收藏: reportId=${reportId}, ${isCurrentlyFavorite ? "取消收藏" : "加入收藏"}`);

        // 乐观更新
        setFavoriteReports(prev => ({
            ...prev,
            [reportId]: !isCurrentlyFavorite
        }));

        try {
            if (isCurrentlyFavorite) {
                await removeReportFromFavorites(reportId);
                console.log(`[Reports] 取消收藏成功: reportId=${reportId}`);
                Notification.success({
                    title: "取消收藏",
                    description: "日报已从收藏中移除"
                });

                // 当前处于“仅收藏”筛选时，取消收藏后从列表移除该卡片
                if (favoriteFilter === "favorite") {
                    console.log(`[Reports] 处于仅收藏筛选，从列表移除取消收藏的卡片: reportId=${reportId}`);
                    setReports(prev => prev.filter(r => r.reportId !== reportId));
                    setDateReports(prev => prev.filter(r => r.reportId !== reportId));
                    setTotal(prev => Math.max(0, prev - 1));
                }
            } else {
                await markReportAsFavorite(reportId);
                console.log(`[Reports] 加入收藏成功: reportId=${reportId}`);
                Notification.success({
                    title: "收藏成功",
                    description: "日报已添加到收藏"
                });
            }
        } catch (error) {
            console.error(`[Reports] 更新日报收藏状态失败: reportId=${reportId}`, error);
            // 回滚
            setFavoriteReports(prev => ({
                ...prev,
                [reportId]: isCurrentlyFavorite
            }));
            Notification.error({
                title: "操作失败",
                description: "无法更新日报收藏状态"
            });
        }
    };

    // 真正执行物理删除（撤销超时后由定时器触发）
    const commitDeleteReport = useCallback(
        async (reportId: string) => {
            pendingDeletesRef.current.delete(reportId);
            console.log(`[Reports] 撤销窗口结束，执行物理删除: reportId=${reportId}`);

            try {
                const response = await deleteReport(reportId);

                if (response.success) {
                    console.log(`[Reports] 物理删除成功: reportId=${reportId}`);
                } else {
                    console.warn(`[Reports] 物理删除返回失败: reportId=${reportId}, message=${response.data?.message}`);
                    Notification.error({
                        title: "删除失败",
                        description: response.data?.message || "无法删除日报，请刷新后重试"
                    });
                    // 删除失败，重新拉取以恢复真实状态
                    if (viewMode === "list") {
                        fetchReports();
                    } else {
                        fetchReportsByDate(selectedDate);
                    }
                }
            } catch (error) {
                console.error(`[Reports] 物理删除请求异常: reportId=${reportId}`, error);
                Notification.error({
                    title: "删除失败",
                    description: "无法删除日报，请刷新后重试"
                });
                if (viewMode === "list") {
                    fetchReports();
                } else {
                    fetchReportsByDate(selectedDate);
                }
            }
        },
        [viewMode, fetchReports, fetchReportsByDate, selectedDate]
    );

    // 删除日报（乐观移除 + 5 秒可撤销，超时后物理删除）
    const handleDeleteReport = (reportId: string) => {
        console.log(`[Reports] 请求删除日报，进入 5 秒可撤销窗口: reportId=${reportId}`);

        // 记录被删卡片的快照，用于撤销恢复
        const removedFromList = reports.find(r => r.reportId === reportId);
        const removedFromDate = dateReports.find(r => r.reportId === reportId);

        // 乐观移除
        setReports(prev => prev.filter(r => r.reportId !== reportId));
        setDateReports(prev => prev.filter(r => r.reportId !== reportId));
        setTotal(prev => Math.max(0, prev - 1));

        const UNDO_TIMEOUT = 5000;
        const toastKey = addToast({
            title: "日报已删除",
            description: "5 秒内可撤销",
            color: "warning",
            variant: "flat",
            timeout: UNDO_TIMEOUT,
            shouldShowTimeoutProgress: true,
            endContent: (
                <Button
                    color="warning"
                    size="sm"
                    variant="flat"
                    onPress={() => {
                        console.log(`[Reports] 用户撤销删除，恢复卡片: reportId=${reportId}`);

                        // 撤销：取消定时器并恢复卡片
                        const timer = pendingDeletesRef.current.get(reportId);

                        if (timer) {
                            clearTimeout(timer);
                            pendingDeletesRef.current.delete(reportId);
                        }

                        if (removedFromList) {
                            setReports(prev => (prev.some(r => r.reportId === reportId) ? prev : [...prev, removedFromList].sort((a, b) => b.timeEnd - a.timeEnd)));
                            setTotal(prev => prev + 1);
                        }
                        if (removedFromDate) {
                            setDateReports(prev => (prev.some(r => r.reportId === reportId) ? prev : [...prev, removedFromDate].sort((a, b) => a.timeStart - b.timeStart)));
                        }

                        if (toastKey) {
                            closeToast(toastKey);
                        }
                    }}
                >
                    撤销
                </Button>
            )
        });

        // 启动 5 秒后真删的定时器
        const timer = setTimeout(() => {
            void commitDeleteReport(reportId);
        }, UNDO_TIMEOUT);

        pendingDeletesRef.current.set(reportId, timer);
    };

    // 卸载时清理未触发的删除定时器（直接落库删除，避免遗留）
    useEffect(() => {
        const pending = pendingDeletesRef.current;

        return () => {
            if (pending.size > 0) {
                console.log(`[Reports] 页面卸载，立即提交 ${pending.size} 个待删除日报`);
            }
            pending.forEach((timer, reportId) => {
                clearTimeout(timer);
                void deleteReport(reportId);
            });
            pending.clear();
        };
    }, []);

    // 手动生成日报
    const handleGenerateReport = async () => {
        setGenerating(true);
        try {
            const response = await triggerReportGenerate(generateType);

            if (response.success && response.data.success) {
                Notification.success({
                    title: "生成任务已提交",
                    description: response.data.message
                });
            } else {
                Notification.error({
                    title: "生成失败",
                    description: response.data?.message || "触发日报生成失败"
                });
            }
        } catch (error) {
            console.error("触发日报生成失败:", error);
            Notification.error({
                title: "生成失败",
                description: "触发日报生成失败"
            });
        } finally {
            setGenerating(false);
        }
    };

    // 日报类型选项
    const reportTypeOptions = [
        { key: "half-daily", label: "半日报（过去12小时）" },
        { key: "weekly", label: "周报（过去7天）" },
        { key: "monthly", label: "月报（过去30天）" }
    ];

    return (
        <DefaultLayout>
            <section className="flex flex-col gap-4 py-0 md:py-10">
                {/* 页面标题 */}
                <div className="hidden sm:flex items-center justify-center">
                    <img alt="logo" className="w-21 mr-5" src="./logo.webp" />
                    <div className="flex flex-col items-center justify-center gap-4">
                        <h1 className={title()}>日报中心</h1>
                        <p className="text-default-600 max-w-2xl text-center">查看群聊话题的定期汇总报告，包含统计数据和 AI 生成的综述</p>
                    </div>
                </div>

                {/* 主内容区 */}
                <Card className="mt-0 md:mt-6 pt-2">
                    <CardHeader className="flex flex-row justify-between items-center pl-7 pr-7 gap-4 flex-wrap">
                        <div className="flex flex-row items-center gap-4">
                            <h2 className="text-xl font-bold">
                                <FileText className="inline-block mr-2" size={20} />
                                日报列表
                            </h2>
                            <Chip color="primary" size="sm" variant="flat">
                                共 {total} 份报告
                            </Chip>
                        </div>

                        {/* 视图切换和筛选 */}
                        <div className="flex flex-row items-center gap-4 flex-wrap">
                            {/* 视图模式切换 */}
                            <Tabs aria-label="视图模式" selectedKey={viewMode} size="sm" onSelectionChange={key => setViewMode(key as "list" | "calendar")}>
                                <Tab key="list" title="列表视图" />
                                <Tab key="calendar" title="日历视图" />
                            </Tabs>

                            {/* 报告类型筛选（仅列表视图） */}
                            {viewMode === "list" && (
                                <Tabs
                                    aria-label="报告类型"
                                    selectedKey={selectedType}
                                    size="sm"
                                    onSelectionChange={key => {
                                        setSelectedType(key as ReportType | "all");
                                        setPage(1);
                                    }}
                                >
                                    <Tab key="all" title="全部" />
                                    <Tab key="half-daily" title="半日报" />
                                    <Tab key="weekly" title="周报" />
                                    <Tab key="monthly" title="月报" />
                                </Tabs>
                            )}

                            {/* 收藏筛选（仅列表视图） */}
                            {viewMode === "list" && (
                                <Tabs
                                    aria-label="收藏筛选"
                                    selectedKey={favoriteFilter}
                                    size="sm"
                                    onSelectionChange={key => {
                                        setFavoriteFilter(key as "all" | "favorite");
                                        setPage(1);
                                    }}
                                >
                                    <Tab key="all" title="全部" />
                                    <Tab key="favorite" title="收藏" />
                                </Tabs>
                            )}

                            {/* 刷新按钮 */}
                            <Button
                                color="primary"
                                isLoading={loading || dateLoading}
                                size="sm"
                                startContent={<RefreshCw size={16} />}
                                variant="flat"
                                onPress={() => {
                                    if (viewMode === "list") {
                                        fetchReports();
                                    } else {
                                        fetchReportsByDate(selectedDate);
                                    }
                                }}
                            >
                                刷新
                            </Button>

                            {/* 手动生成日报 */}
                            <div className="flex flex-row items-center gap-2">
                                <Select
                                    aria-label="选择日报类型"
                                    className="w-44"
                                    selectedKeys={[generateType]}
                                    size="sm"
                                    onSelectionChange={keys => {
                                        const selected = Array.from(keys)[0] as ReportType;

                                        if (selected) {
                                            setGenerateType(selected);
                                        }
                                    }}
                                >
                                    {reportTypeOptions.map(option => (
                                        <SelectItem key={option.key}>{option.label}</SelectItem>
                                    ))}
                                </Select>
                                <Button color="success" isLoading={generating} size="sm" startContent={<Plus size={16} />} onPress={handleGenerateReport}>
                                    生成
                                </Button>
                            </div>
                        </div>
                    </CardHeader>

                    <CardBody>
                        {viewMode === "list" ? (
                            /* 列表视图 */
                            loading ? (
                                <div className="flex justify-center items-center h-64">
                                    <Spinner size="lg" />
                                </div>
                            ) : reports.length > 0 ? (
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-3 p-2">
                                        {reports.map(report => (
                                            <ReportCard
                                                key={report.reportId}
                                                emailEnabled={emailEnabled}
                                                favoriteReports={favoriteReports}
                                                readReports={readReports}
                                                report={report}
                                                sendingEmailReportId={sendingEmailReportId}
                                                onClick={() => void openReportDetail(report)}
                                                onDelete={handleDeleteReport}
                                                onMarkAsRead={handleMarkAsRead}
                                                onSendEmail={handleSendEmail}
                                                onToggleFavorite={handleToggleFavorite}
                                            />
                                        ))}
                                    </div>

                                    {totalPages > 1 && (
                                        <div className="flex justify-center mt-4">
                                            <Pagination showControls color="primary" page={page} size="md" total={totalPages} onChange={setPage} />
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="text-center py-12">
                                    <FileText className="mx-auto mb-4 text-default-400" size={48} />
                                    <p className="text-default-500">暂无日报数据</p>
                                    <p className="text-default-400 text-sm mt-2">日报会在配置的时间自动生成</p>
                                </div>
                            )
                        ) : (
                            /* 日历视图 */
                            <div className="flex flex-col lg:flex-row gap-6">
                                {/* 日历选择器 */}
                                <div className="flex flex-col items-center gap-4">
                                    <Calendar aria-label="选择日期" value={selectedDate} onChange={handleDateChange} />
                                    <Button color="primary" size="sm" variant="flat" onPress={goToToday}>
                                        回到今天
                                    </Button>
                                </div>

                                {/* 日期对应的日报列表 */}
                                <div className="flex-1">
                                    <div className="mb-4">
                                        <h3 className="text-lg font-semibold">
                                            {selectedDate.year}年{selectedDate.month}月{selectedDate.day}日 的日报
                                        </h3>
                                    </div>

                                    {dateLoading ? (
                                        <div className="flex justify-center items-center h-32">
                                            <Spinner size="md" />
                                        </div>
                                    ) : dateReports.length > 0 ? (
                                        <div className="flex flex-col gap-3">
                                            {dateReports.map(report => (
                                                <ReportCard
                                                    key={report.reportId}
                                                    emailEnabled={emailEnabled}
                                                    favoriteReports={favoriteReports}
                                                    readReports={readReports}
                                                    report={report}
                                                    sendingEmailReportId={sendingEmailReportId}
                                                    onClick={() => void openReportDetail(report)}
                                                    onDelete={handleDeleteReport}
                                                    onMarkAsRead={handleMarkAsRead}
                                                    onSendEmail={handleSendEmail}
                                                    onToggleFavorite={handleToggleFavorite}
                                                />
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-center py-8 bg-default-50 rounded-lg">
                                            <p className="text-default-500">该日期暂无日报</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </CardBody>
                </Card>
            </section>

            {/* 日报详情弹窗 */}
            {isModalOpen && selectedReport && (
                <Suspense fallback={null}>
                    <ReportDetailModal
                        emailEnabled={emailEnabled}
                        favoriteTopics={favoriteTopics}
                        isOpen={isModalOpen}
                        isSendingEmail={sendingEmailReportId === selectedReport.reportId}
                        readReports={readReports}
                        readTopics={readTopics}
                        report={selectedReport}
                        topicReferences={selectedReferences}
                        onClose={closeReportDetail}
                        onMarkReportAsRead={handleMarkAsRead}
                        onMarkTopicAsRead={onMarkTopicAsRead}
                        onSendEmail={handleSendEmail}
                        onToggleTopicFavorite={onToggleTopicFavorite}
                    />
                </Suspense>
            )}
        </DefaultLayout>
    );
}
