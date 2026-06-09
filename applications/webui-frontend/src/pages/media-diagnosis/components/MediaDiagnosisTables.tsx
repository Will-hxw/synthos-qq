import type { AudioDiagnosisSample, ForwardMergedSample, ForwardMergedSummary, ImageDiagnosisSample, MediaDiagnosisStatus, MediaSummaryItem } from "@/api/mediaDiagnosisApi";

import { Card, CardBody, CardHeader, Chip, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from "@heroui/react";

export const formatTimestamp = (timestamp: number | null): string => {
    if (timestamp === null) {
        return "-";
    }

    return new Date(timestamp).toLocaleString();
};

const STATUS_LABELS: Record<MediaDiagnosisStatus, string> = {
    pending: "pending",
    success: "success",
    failed: "failed",
    skipped: "skipped"
};

const MEDIA_TYPE_LABELS: Record<string, string> = {
    image: "图片",
    audio: "语音"
};

const renderStatusChip = (status: MediaDiagnosisStatus) => {
    const color = status === "failed" ? "danger" : status === "success" ? "success" : status === "pending" ? "warning" : "default";

    return (
        <Chip color={color} size="sm" variant="flat">
            {STATUS_LABELS[status]}
        </Chip>
    );
};

const renderTextBlock = (label: string, value: string | null) => {
    if (!value) {
        return <span className="text-default-400">-</span>;
    }

    return (
        <details className="max-w-[520px]">
            <summary className="cursor-pointer text-xs text-primary">
                {label}（{value.length}）
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-small bg-default-100 p-3 text-xs leading-5">{value}</pre>
        </details>
    );
};

export function SummaryCard({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "warning" | "danger" | "success" }) {
    const toneClass = {
        default: "",
        warning: "text-warning",
        danger: "text-danger",
        success: "text-success"
    }[tone];

    return (
        <Card>
            <CardBody className="gap-1">
                <p className="text-sm text-default-500">{label}</p>
                <p className={`text-2xl font-semibold ${toneClass}`}>{value}</p>
            </CardBody>
        </Card>
    );
}

export function MediaSummaryTable({ items }: { items: MediaSummaryItem[] }) {
    return (
        <Card>
            <CardHeader>
                <h2 className="text-lg font-bold">媒体状态统计</h2>
            </CardHeader>
            <CardBody>
                <Table aria-label="媒体状态统计">
                    <TableHeader>
                        <TableColumn>类型</TableColumn>
                        <TableColumn>状态</TableColumn>
                        <TableColumn>数量</TableColumn>
                        <TableColumn>源计数</TableColumn>
                        <TableColumn>最近更新</TableColumn>
                        <TableColumn>失败原因样本数</TableColumn>
                    </TableHeader>
                    <TableBody emptyContent="无媒体记录">
                        {items.map(item => (
                            <TableRow key={`${item.mediaType}:${item.status}`}>
                                <TableCell>{MEDIA_TYPE_LABELS[item.mediaType] || item.mediaType}</TableCell>
                                <TableCell>{renderStatusChip(item.status)}</TableCell>
                                <TableCell>{item.count}</TableCell>
                                <TableCell>
                                    <div className="flex flex-col gap-1 text-xs">
                                        <span>URL {item.sourceUrlCount}</span>
                                        <span>本地缓存 {item.sourcePathCount}</span>
                                        <span>缺源 {item.missingSourceCount}</span>
                                    </div>
                                </TableCell>
                                <TableCell>{formatTimestamp(item.latestUpdatedAt)}</TableCell>
                                <TableCell>{item.failReasonSampleCount}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardBody>
        </Card>
    );
}

export function ImageSamplesTable({ items }: { items: ImageDiagnosisSample[] }) {
    return (
        <Card>
            <CardHeader>
                <h2 className="text-lg font-bold">图片理解样本（{items.length}）</h2>
            </CardHeader>
            <CardBody>
                <Table aria-label="图片理解样本">
                    <TableHeader>
                        <TableColumn>媒体</TableColumn>
                        <TableColumn>状态</TableColumn>
                        <TableColumn>源</TableColumn>
                        <TableColumn>长度</TableColumn>
                        <TableColumn>模型</TableColumn>
                        <TableColumn>失败原因</TableColumn>
                        <TableColumn>正文</TableColumn>
                    </TableHeader>
                    <TableBody emptyContent="无图片样本">
                        {items.map(item => (
                            <TableRow key={item.mediaId}>
                                <TableCell>
                                    <div className="flex flex-col gap-1 text-xs">
                                        <span className="font-mono">{item.mediaId}</span>
                                        <span className="font-mono text-default-500">{item.msgId}</span>
                                        <span>{formatTimestamp(item.timestamp)}</span>
                                    </div>
                                </TableCell>
                                <TableCell>{renderStatusChip(item.status)}</TableCell>
                                <TableCell>
                                    <div className="flex flex-col gap-1 text-xs">
                                        <span>URL {item.hasSourceUrl ? item.sourceUrlKind : "无"}</span>
                                        <span>本地缓存 {item.hasSourcePath ? "有" : "无"}</span>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <div className="flex flex-col gap-1 text-xs">
                                        <span>OCR {item.ocrLen}</span>
                                        <span>Vision {item.visionLen}</span>
                                        <span>理解 {item.understandingLen}</span>
                                    </div>
                                </TableCell>
                                <TableCell className="max-w-[160px] break-words text-xs">{item.modelName || "-"}</TableCell>
                                <TableCell className="max-w-[220px] whitespace-normal break-words text-xs">{item.failReason || "-"}</TableCell>
                                <TableCell>
                                    <div className="flex flex-col gap-2">
                                        {renderTextBlock("消息正文", item.messageContent)}
                                        {renderTextBlock("预处理正文", item.preProcessedContent)}
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardBody>
        </Card>
    );
}

export function AudioSamplesTable({ items }: { items: AudioDiagnosisSample[] }) {
    return (
        <Card>
            <CardHeader>
                <h2 className="text-lg font-bold">语音转文字样本（{items.length}）</h2>
            </CardHeader>
            <CardBody>
                <Table aria-label="语音转文字样本">
                    <TableHeader>
                        <TableColumn>媒体</TableColumn>
                        <TableColumn>状态</TableColumn>
                        <TableColumn>转写长度</TableColumn>
                        <TableColumn>模型</TableColumn>
                        <TableColumn>失败原因</TableColumn>
                        <TableColumn>正文</TableColumn>
                    </TableHeader>
                    <TableBody emptyContent="无语音样本">
                        {items.map(item => (
                            <TableRow key={item.mediaId}>
                                <TableCell>
                                    <div className="flex flex-col gap-1 text-xs">
                                        <span className="font-mono">{item.mediaId}</span>
                                        <span className="font-mono text-default-500">{item.msgId}</span>
                                        <span>{formatTimestamp(item.timestamp)}</span>
                                    </div>
                                </TableCell>
                                <TableCell>{renderStatusChip(item.status)}</TableCell>
                                <TableCell>{item.transcriptLen}</TableCell>
                                <TableCell className="max-w-[160px] break-words text-xs">{item.modelName || "-"}</TableCell>
                                <TableCell className="max-w-[220px] whitespace-normal break-words text-xs">{item.failReason || "-"}</TableCell>
                                <TableCell>
                                    <div className="flex flex-col gap-2">
                                        {renderTextBlock("消息正文", item.messageContent)}
                                        {renderTextBlock("预处理正文", item.preProcessedContent)}
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardBody>
        </Card>
    );
}

export function ForwardMergedTable({ summary, items }: { summary: ForwardMergedSummary; items: ForwardMergedSample[] }) {
    return (
        <Card>
            <CardHeader>
                <h2 className="text-lg font-bold">合并转发样本（{items.length}）</h2>
            </CardHeader>
            <CardBody className="gap-4">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <SummaryCard label="展开消息" tone="success" value={summary.expandedMessageCount} />
                    <SummaryCard label="解析失败占位" tone={summary.parseFailurePlaceholderCount > 0 ? "danger" : "success"} value={summary.parseFailurePlaceholderCount} />
                    <SummaryCard label="空正文占位" tone={summary.emptyContentPlaceholderCount > 0 ? "warning" : "success"} value={summary.emptyContentPlaceholderCount} />
                    <SummaryCard label="嵌套截断" tone={summary.nestedTruncatedCount > 0 ? "warning" : "success"} value={summary.nestedTruncatedCount} />
                </div>
                <Table aria-label="合并转发样本">
                    <TableHeader>
                        <TableColumn>消息</TableColumn>
                        <TableColumn>长度</TableColumn>
                        <TableColumn>正文</TableColumn>
                    </TableHeader>
                    <TableBody emptyContent="无合并转发样本">
                        {items.map(item => (
                            <TableRow key={item.msgId}>
                                <TableCell>
                                    <div className="flex flex-col gap-1 text-xs">
                                        <span className="font-mono">{item.msgId}</span>
                                        <span className="font-mono text-default-500">{item.groupId}</span>
                                        <span>{formatTimestamp(item.timestamp)}</span>
                                    </div>
                                </TableCell>
                                <TableCell>{item.contentLength}</TableCell>
                                <TableCell>
                                    <div className="flex flex-col gap-2">
                                        {renderTextBlock("消息正文", item.messageContent)}
                                        {renderTextBlock("预处理正文", item.preProcessedContent)}
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardBody>
        </Card>
    );
}
