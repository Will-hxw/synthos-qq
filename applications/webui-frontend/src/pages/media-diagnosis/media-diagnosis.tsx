import type { GroupDetailsRecord } from "@/types/group";
import type { MediaDiagnosisMediaType, MediaDiagnosisResult } from "@/api/mediaDiagnosisApi";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Card, CardBody, CardHeader, Input, Select, SelectItem, Spinner } from "@heroui/react";
import { RefreshCw } from "lucide-react";

import { getGroupDetails } from "@/api/basicApi";
import { getMediaProcessingDiagnosis } from "@/api/mediaDiagnosisApi";
import { title } from "@/components/primitives";
import QQAvatar from "@/components/QQAvatar";
import DefaultLayout from "@/layouts/default";
import { Notification } from "@/util/Notification";

import { AudioSamplesTable, ForwardMergedTable, formatTimestamp, ImageSamplesTable, MediaSummaryTable, SummaryCard } from "./components/MediaDiagnosisTables";

const ALL_GROUP_KEY = "__all__";
const DEFAULT_DETAIL_LIMIT = 50;
const MAX_DETAIL_LIMIT = 200;
const DEFAULT_TIME_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MEDIA_TYPES: MediaDiagnosisMediaType[] = ["image", "audio"];

interface InitialState {
    selectedGroupId: string;
    startInput: string;
    endInput: string;
    detailLimitInput: string;
    mediaTypes: MediaDiagnosisMediaType[];
    shouldAutoQuery: boolean;
}

const pad = (value: number): string => String(value).padStart(2, "0");

const formatDatetimeInput = (timestamp: number): string => {
    const date = new Date(timestamp);

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const parseUnixMsParam = (value: string | null): number | null => {
    if (!value) {
        return null;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 0) {
        return null;
    }

    return parsed;
};

const parseDatetimeInput = (value: string): number | null => {
    if (!value) {
        return null;
    }

    const timestamp = new Date(value).getTime();

    if (!Number.isFinite(timestamp) || timestamp < 0) {
        return null;
    }

    return timestamp;
};

const parseDetailLimit = (value: string): number | null => {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_DETAIL_LIMIT) {
        return null;
    }

    return parsed;
};

const parseMediaTypesParam = (value: string | null): MediaDiagnosisMediaType[] => {
    if (!value) {
        return DEFAULT_MEDIA_TYPES;
    }

    const values = value
        .split(",")
        .map(item => item.trim())
        .filter((item): item is MediaDiagnosisMediaType => item === "image" || item === "audio");

    return values.length > 0 ? [...new Set(values)] : DEFAULT_MEDIA_TYPES;
};

const getInitialState = (searchParams: URLSearchParams): InitialState => {
    const now = Date.now();
    const parsedStart = parseUnixMsParam(searchParams.get("timeStart"));
    const parsedEnd = parseUnixMsParam(searchParams.get("timeEnd"));
    const parsedDetailLimit = parseDetailLimit(searchParams.get("detailLimit") || "");
    const hasValidRange = parsedStart !== null && parsedEnd !== null && parsedEnd >= parsedStart;
    const timeEnd = hasValidRange ? parsedEnd : now;
    const timeStart = hasValidRange ? parsedStart : now - DEFAULT_TIME_RANGE_MS;

    return {
        selectedGroupId: searchParams.get("groupId") || "",
        startInput: formatDatetimeInput(timeStart),
        endInput: formatDatetimeInput(timeEnd),
        detailLimitInput: String(parsedDetailLimit || DEFAULT_DETAIL_LIMIT),
        mediaTypes: parseMediaTypesParam(searchParams.get("mediaTypes")),
        shouldAutoQuery: hasValidRange
    };
};

const getGroupLabel = (groups: GroupDetailsRecord, groupId: string): string => {
    const groupName = groups[groupId]?.groupName;

    if (groupName && groupName.trim().length > 0) {
        return `${groupName.trim()} (${groupId})`;
    }

    return groupId;
};

const getSummaryCount = (result: MediaDiagnosisResult, mediaType: MediaDiagnosisMediaType, status?: string): number => {
    return result.mediaSummary.filter(item => item.mediaType === mediaType && (!status || item.status === status)).reduce((total, item) => total + item.count, 0);
};

export default function MediaDiagnosisPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const initialStateRef = useRef<InitialState | null>(null);

    if (!initialStateRef.current) {
        initialStateRef.current = getInitialState(searchParams);
    }

    const initialState = initialStateRef.current;
    const shouldAutoQueryRef = useRef<boolean>(initialState.shouldAutoQuery);
    const [groups, setGroups] = useState<GroupDetailsRecord>({});
    const [selectedGroupId, setSelectedGroupId] = useState<string>(initialState.selectedGroupId);
    const [startInput, setStartInput] = useState<string>(initialState.startInput);
    const [endInput, setEndInput] = useState<string>(initialState.endInput);
    const [detailLimitInput, setDetailLimitInput] = useState<string>(initialState.detailLimitInput);
    const [mediaTypes, setMediaTypes] = useState<MediaDiagnosisMediaType[]>(initialState.mediaTypes);
    const [result, setResult] = useState<MediaDiagnosisResult | null>(null);
    const [isGroupsLoading, setIsGroupsLoading] = useState<boolean>(false);
    const [isQueryLoading, setIsQueryLoading] = useState<boolean>(false);
    const requestSeqRef = useRef<number>(0);

    const groupIds = useMemo(() => Object.keys(groups), [groups]);
    const groupSelectIds = useMemo(() => [ALL_GROUP_KEY, ...groupIds], [groupIds]);
    const parsedTimeStart = parseDatetimeInput(startInput);
    const parsedTimeEnd = parseDatetimeInput(endInput);
    const parsedDetailLimit = parseDetailLimit(detailLimitInput);
    const hasValidTimeRange = parsedTimeStart !== null && parsedTimeEnd !== null && parsedTimeEnd >= parsedTimeStart;
    const hasValidDetailLimit = parsedDetailLimit !== null;
    const hasSelectedMediaTypes = mediaTypes.length > 0;

    useEffect(() => {
        const fetchGroups = async () => {
            setIsGroupsLoading(true);
            try {
                const response = await getGroupDetails();

                if (response.success) {
                    setGroups(response.data);
                } else {
                    Notification.error({ title: "群组加载失败", description: response.message || "无法获取群组列表" });
                }
            } catch (error) {
                Notification.error({
                    title: "群组加载失败",
                    description: error instanceof Error ? error.message : String(error)
                });
            } finally {
                setIsGroupsLoading(false);
            }
        };

        void fetchGroups();
    }, []);

    useEffect(() => {
        if (!hasValidTimeRange || parsedTimeStart === null || parsedTimeEnd === null || !hasValidDetailLimit) {
            return;
        }

        const nextParams = new URLSearchParams();

        if (selectedGroupId) {
            nextParams.set("groupId", selectedGroupId);
        }
        nextParams.set("timeStart", String(parsedTimeStart));
        nextParams.set("timeEnd", String(parsedTimeEnd));
        nextParams.set("detailLimit", String(parsedDetailLimit));
        nextParams.set("mediaTypes", mediaTypes.join(","));
        setSearchParams(nextParams, { replace: true });
    }, [hasValidDetailLimit, hasValidTimeRange, mediaTypes, parsedDetailLimit, parsedTimeEnd, parsedTimeStart, selectedGroupId, setSearchParams]);

    const fetchDiagnosis = async () => {
        if (!hasValidTimeRange || parsedTimeStart === null || parsedTimeEnd === null) {
            Notification.error({ title: "时间范围无效", description: "请确认开始时间不晚于结束时间" });
            return;
        }

        if (!hasValidDetailLimit || parsedDetailLimit === null) {
            Notification.error({ title: "明细上限无效", description: `请输入 1 到 ${MAX_DETAIL_LIMIT} 之间的整数` });
            return;
        }

        if (!hasSelectedMediaTypes) {
            Notification.error({ title: "媒体类型为空", description: "请至少选择一种媒体类型" });
            return;
        }

        const requestId = requestSeqRef.current + 1;

        requestSeqRef.current = requestId;
        setIsQueryLoading(true);
        try {
            const response = await getMediaProcessingDiagnosis({
                groupId: selectedGroupId || undefined,
                timeStart: parsedTimeStart,
                timeEnd: parsedTimeEnd,
                detailLimit: parsedDetailLimit,
                mediaTypes
            });

            if (requestSeqRef.current !== requestId) {
                return;
            }

            if (response.success) {
                setResult(response.data);
            } else {
                Notification.error({ title: "诊断失败", description: response.message || "接口返回失败" });
            }
        } catch (error) {
            if (requestSeqRef.current !== requestId) {
                return;
            }

            Notification.error({
                title: "诊断失败",
                description: error instanceof Error ? error.message : String(error)
            });
        } finally {
            if (requestSeqRef.current === requestId) {
                setIsQueryLoading(false);
            }
        }
    };

    useEffect(() => {
        if (!shouldAutoQueryRef.current) {
            return;
        }

        shouldAutoQueryRef.current = false;
        void fetchDiagnosis();
    }, []);

    return (
        <DefaultLayout>
            <section className="flex flex-col gap-4 py-8 md:py-10">
                <div className="flex flex-col items-center justify-center gap-4">
                    <h1 className={title()}>媒体处理诊断</h1>
                </div>

                <Card className="mt-6">
                    <CardHeader>
                        <h2 className="px-3 text-lg font-bold">诊断条件</h2>
                    </CardHeader>
                    <CardBody>
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,1fr)_190px_190px_140px_180px_auto] lg:items-end">
                            <Select
                                isLoading={isGroupsLoading}
                                label="群组"
                                selectedKeys={[selectedGroupId || ALL_GROUP_KEY]}
                                size="sm"
                                onSelectionChange={keys => {
                                    const selected = keys === "all" ? ALL_GROUP_KEY : Array.from(keys)[0];

                                    setSelectedGroupId(typeof selected === "string" && selected !== ALL_GROUP_KEY ? selected : "");
                                }}
                            >
                                {groupSelectIds.map(groupId =>
                                    groupId === ALL_GROUP_KEY ? (
                                        <SelectItem key={ALL_GROUP_KEY} textValue="全部群组">
                                            全部群组
                                        </SelectItem>
                                    ) : (
                                        <SelectItem key={groupId} startContent={<QQAvatar qqId={groupId} type="group" />} textValue={getGroupLabel(groups, groupId)}>
                                            {getGroupLabel(groups, groupId)}
                                        </SelectItem>
                                    )
                                )}
                            </Select>
                            <Input label="开始时间" size="sm" type="datetime-local" value={startInput} onValueChange={setStartInput} />
                            <Input label="结束时间" size="sm" type="datetime-local" value={endInput} onValueChange={setEndInput} />
                            <Input label="明细上限" max={MAX_DETAIL_LIMIT} min={1} size="sm" type="number" value={detailLimitInput} onValueChange={setDetailLimitInput} />
                            <Select
                                disallowEmptySelection
                                label="媒体类型"
                                selectedKeys={mediaTypes}
                                selectionMode="multiple"
                                size="sm"
                                onSelectionChange={keys => {
                                    const selected =
                                        keys === "all"
                                            ? DEFAULT_MEDIA_TYPES
                                            : Array.from(keys)
                                                  .map(String)
                                                  .filter((item): item is MediaDiagnosisMediaType => item === "image" || item === "audio");

                                    setMediaTypes(selected.length > 0 ? selected : DEFAULT_MEDIA_TYPES);
                                }}
                            >
                                <SelectItem key="image">图片</SelectItem>
                                <SelectItem key="audio">语音</SelectItem>
                            </Select>
                            <Button color="primary" isLoading={isQueryLoading} startContent={!isQueryLoading && <RefreshCw size={16} />} onPress={fetchDiagnosis}>
                                开始诊断
                            </Button>
                        </div>
                        {!hasValidTimeRange && <p className="mt-3 text-sm text-danger">时间范围无效，请确认开始时间不晚于结束时间。</p>}
                        {!hasValidDetailLimit && <p className="mt-3 text-sm text-danger">明细上限必须是 1 到 {MAX_DETAIL_LIMIT} 之间的整数。</p>}
                    </CardBody>
                </Card>

                {isQueryLoading && !result ? (
                    <div className="flex h-48 items-center justify-center">
                        <Spinner label="正在诊断" />
                    </div>
                ) : result ? (
                    <div className="flex flex-col gap-4">
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                            <SummaryCard label="图片媒体" value={getSummaryCount(result, "image")} />
                            <SummaryCard label="图片失败" tone={getSummaryCount(result, "image", "failed") > 0 ? "danger" : "success"} value={getSummaryCount(result, "image", "failed")} />
                            <SummaryCard label="语音媒体" value={getSummaryCount(result, "audio")} />
                            <SummaryCard label="语音失败" tone={getSummaryCount(result, "audio", "failed") > 0 ? "danger" : "success"} value={getSummaryCount(result, "audio", "failed")} />
                        </div>

                        <Card>
                            <CardBody className="gap-2 text-sm text-default-600">
                                <p>
                                    诊断时间：{formatTimestamp(result.generatedAt)}；明细上限：{parsedDetailLimit || DEFAULT_DETAIL_LIMIT} 条；群组：
                                    {selectedGroupId ? getGroupLabel(groups, selectedGroupId) : "全部群组"}。
                                </p>
                                <p>
                                    查询范围：{formatTimestamp(parsedTimeStart)} 至 {formatTimestamp(parsedTimeEnd)}。
                                </p>
                            </CardBody>
                        </Card>

                        <MediaSummaryTable items={result.mediaSummary} />
                        <ImageSamplesTable items={result.imageSamples} />
                        <AudioSamplesTable items={result.audioSamples} />
                        <ForwardMergedTable items={result.forwardMergedSamples} summary={result.forwardMergedSummary} />
                    </div>
                ) : (
                    <Card>
                        <CardBody className="py-12 text-center text-default-500">选择条件后点击“开始诊断”。</CardBody>
                    </Card>
                )}
            </section>
        </DefaultLayout>
    );
}
