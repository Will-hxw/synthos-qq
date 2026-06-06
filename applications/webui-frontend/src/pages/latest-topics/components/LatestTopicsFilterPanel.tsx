import type { CalendarDate } from "@internationalized/date";
import type { GroupDetailsRecord } from "@/types/group";

import { Button, Checkbox, DateRangePicker, Select, SelectItem } from "@heroui/react";

import QQAvatar from "@/components/QQAvatar";

const TOPICS_PER_PAGE_OPTIONS = [3, 6, 9, 12, 30] as const;

interface LatestTopicsDateRange {
    start: CalendarDate;
    end: CalendarDate;
}

interface LatestTopicsFilterPanelProps {
    groups: GroupDetailsRecord;
    selectedGroupId: string;
    topicsPerPage: number;
    filterRead: boolean;
    filterFavorite: boolean;
    sortByInterest: boolean;
    dateRange: LatestTopicsDateRange;
    isLoading: boolean;
    getGroupSelectLabel: (groupId: string) => string;
    onSelectedGroupIdChange: (groupId: string) => void;
    onTopicsPerPageChange: (pageSize: number) => void;
    onFilterReadChange: (value: boolean) => void;
    onFilterFavoriteChange: (value: boolean) => void;
    onSortByInterestChange: (value: boolean) => void;
    onDateRangeChange: (range: LatestTopicsDateRange) => void;
    onRefresh: () => void;
}

export default function LatestTopicsFilterPanel({
    groups,
    selectedGroupId,
    topicsPerPage,
    filterRead,
    filterFavorite,
    sortByInterest,
    dateRange,
    isLoading,
    getGroupSelectLabel,
    onSelectedGroupIdChange,
    onTopicsPerPageChange,
    onFilterReadChange,
    onFilterFavoriteChange,
    onSortByInterestChange,
    onDateRangeChange,
    onRefresh
}: LatestTopicsFilterPanelProps) {
    return (
        <div className="flex flex-col gap-4 p-3 lg:flex-row lg:items-center lg:p-0">
            <Select
                className="w-full lg:w-60"
                isClearable={true}
                label="群组"
                placeholder="全部群组"
                selectedKeys={selectedGroupId ? [selectedGroupId] : []}
                size="sm"
                onSelectionChange={keys => {
                    if (keys === "all" || (keys instanceof Set && keys.size === 0)) {
                        onSelectedGroupIdChange("");
                        return;
                    }

                    const selectedKey = Array.from(keys)[0] as string | undefined;

                    onSelectedGroupIdChange(selectedKey || "");
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

            <div className="flex items-center gap-3">
                <Select
                    className="w-27"
                    label="每页话题数"
                    selectedKeys={[String(topicsPerPage)]}
                    size="sm"
                    onSelectionChange={keys => {
                        const selected = Array.from(keys)[0];

                        if (selected) {
                            onTopicsPerPageChange(Number(selected));
                        }
                    }}
                >
                    {TOPICS_PER_PAGE_OPTIONS.map(pageSize => (
                        <SelectItem key={String(pageSize)} textValue={String(pageSize)}>
                            {pageSize}
                        </SelectItem>
                    ))}
                </Select>
            </div>

            <Checkbox className="w-110" isSelected={filterRead} onValueChange={onFilterReadChange}>
                只看未读
            </Checkbox>

            <Checkbox className="w-110" isSelected={filterFavorite} onValueChange={onFilterFavoriteChange}>
                只看收藏
            </Checkbox>

            <Checkbox className="w-150" isSelected={sortByInterest} onValueChange={onSortByInterestChange}>
                按兴趣度排序
            </Checkbox>

            <DateRangePicker
                className="w-full lg:w-70"
                label="时间范围"
                value={dateRange}
                onChange={range => {
                    if (range) {
                        onDateRangeChange({
                            start: range.start,
                            end: range.end
                        });
                    }
                }}
            />
            <Button color="primary" isLoading={isLoading} onPress={onRefresh}>
                刷新
            </Button>
        </div>
    );
}
