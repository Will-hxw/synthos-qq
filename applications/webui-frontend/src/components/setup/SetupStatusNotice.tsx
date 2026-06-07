import type { SetupStatus } from "@/api/setupStatusApi";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Spinner } from "@heroui/spinner";
import { AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";

import { getSetupStatus } from "@/api/setupStatusApi";

interface SetupStatusNoticeProps {
    className?: string;
}

const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
};

export default function SetupStatusNotice({ className = "" }: SetupStatusNoticeProps) {
    const [status, setStatus] = useState<SetupStatus | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [error, setError] = useState<string>("");

    const loadStatus = useCallback(async () => {
        setIsLoading(true);
        setError("");

        try {
            const response = await getSetupStatus();

            if (response.success) {
                setStatus(response.data);
            } else {
                setError(response.message || "启动状态加载失败");
            }
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : String(requestError));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadStatus();
    }, [loadStatus]);

    const visibleChecks = status?.checks.filter(check => check.status !== "ok") ?? [];
    const recentReconcileStatuses = status?.qqSourceReconcile.slice(0, 3) ?? [];

    if (!isLoading && !error && visibleChecks.length === 0 && recentReconcileStatuses.length === 0) {
        return null;
    }

    return (
        <div className={`rounded-lg border border-warning-200 bg-warning-50 p-4 text-left text-warning-900 dark:border-warning-900/60 dark:bg-warning-950/30 dark:text-warning-100 ${className}`}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    {visibleChecks.length > 0 || error ? <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />}
                    <div className="min-w-0 space-y-2">
                        <p className="font-semibold">启动状态提示</p>
                        {isLoading ? (
                            <div className="flex items-center gap-2 text-sm">
                                <Spinner size="sm" />
                                <span>正在检查本地依赖状态</span>
                            </div>
                        ) : error ? (
                            <p className="break-words text-sm">{error}</p>
                        ) : (
                            <div className="space-y-2 text-sm">
                                {visibleChecks.map(check => (
                                    <p key={check.key} className="break-words">
                                        {check.message}
                                    </p>
                                ))}
                                {recentReconcileStatuses.map(item => (
                                    <p key={item.groupId} className="break-words text-warning-800 dark:text-warning-200">
                                        群 {item.groupId} 最近 QQ 原库回填：批大小 {item.batchSize}，扫描 {item.scannedCount} 条，缺失 {item.missingCount} 条，补入 {item.insertedCount} 条，
                                        {item.reachedEnd ? "已扫到末尾" : "未扫到末尾"}，更新时间 {formatTimestamp(item.updatedAt)}
                                    </p>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                <Button isIconOnly aria-label="刷新启动状态" isLoading={isLoading} size="sm" variant="light" onPress={loadStatus}>
                    {!isLoading && <RefreshCw className="h-4 w-4" />}
                </Button>
            </div>
        </div>
    );
}
