/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
/* eslint-disable jsx-a11y/no-autofocus */
/**
 * Agent 对话列表
 */
import type { AgentConversation } from "@/api/agentApi";

import React, { useState } from "react";
import { Button, Divider, Input, Listbox, ListboxItem, Popover, PopoverContent, PopoverTrigger, Spinner, cn } from "@heroui/react";
import { Check, Edit2, MessageSquare, MoreVertical, Trash2, X } from "lucide-react";

interface AgentConversationListProps {
    activeTab: string;
    agentConversations: AgentConversation[];
    agentLoading: boolean;
    agentHasMore: boolean;
    selectedAgentConversationId?: string;
    editingConversationId: string | null;
    editingConversationTitle: string;
    onSelectAgentConversation?: (conversationId: string | undefined) => void;
    onStartEditConversation: (conversation: AgentConversation) => void;
    onSaveEditConversation: (conversationId: string) => void;
    onCancelEditConversation: () => void;
    onEditingConversationTitleChange: (value: string) => void;
    onDeleteConversation: (conversationId: string) => void;
    onLoadMore: () => void;
}

interface AgentConversationItemProps {
    conversation: AgentConversation;
    isActive: boolean;
    isEditing: boolean;
    editingTitle: string;
    onSelect: () => void;
    onStartEdit: () => void;
    onSaveEdit: () => void;
    onCancelEdit: () => void;
    onEditingTitleChange: (value: string) => void;
    onDelete: () => void;
}

const AgentConversationItem: React.FC<AgentConversationItemProps> = ({
    conversation,
    isActive,
    isEditing,
    editingTitle,
    onSelect,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onEditingTitleChange,
    onDelete
}) => {
    const [isPopoverOpen, setIsPopoverOpen] = useState(false);

    const stopPropagation: React.MouseEventHandler = e => {
        e.stopPropagation();
    };

    return (
        <div className="group relative mb-1">
            <div className={cn("relative flex w-full cursor-pointer items-center rounded-md p-2 text-left transition-colors", isActive ? "bg-primary-100" : "hover:bg-default-100")} onClick={onSelect}>
                <div className={cn("mr-3 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full", isActive ? "bg-primary-50" : "bg-default-200")}>
                    <MessageSquare className="w-4 h-4" />
                </div>
                <div className="flex-1 overflow-hidden">
                    {isEditing ? (
                        <div className="flex items-center gap-1" onClick={stopPropagation}>
                            <Input
                                autoFocus
                                className="flex-1"
                                size="sm"
                                value={editingTitle}
                                onChange={e => onEditingTitleChange(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === "Enter") {
                                        e.stopPropagation();
                                        onSaveEdit();
                                    } else if (e.key === "Escape") {
                                        e.stopPropagation();
                                        onCancelEdit();
                                    }
                                }}
                            />
                            <Button isIconOnly color="success" size="sm" variant="light" onPress={onSaveEdit}>
                                <Check className="w-3 h-3" />
                            </Button>
                            <Button isIconOnly size="sm" variant="light" onPress={onCancelEdit}>
                                <X className="w-3 h-3" />
                            </Button>
                        </div>
                    ) : (
                        <>
                            <div className="truncate pr-8 text-sm font-medium">{conversation.title || "未命名对话"}</div>
                            <div className="text-xs text-default-400">
                                {new Date(conversation.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {!isEditing && (
                <Popover isOpen={isPopoverOpen} placement="right-start" onOpenChange={setIsPopoverOpen}>
                    <PopoverTrigger>
                        <Button
                            isIconOnly
                            className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                            size="sm"
                            variant="light"
                            onClick={stopPropagation}
                            onPress={() => setIsPopoverOpen(!isPopoverOpen)}
                        >
                            <MoreVertical className="w-4 h-4" />
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-1" onClick={stopPropagation}>
                        <Listbox aria-label="Agent 对话操作">
                            <ListboxItem
                                key="edit"
                                startContent={<Edit2 className="w-4 h-4" />}
                                onPress={() => {
                                    onStartEdit();
                                    setIsPopoverOpen(false);
                                }}
                            >
                                重命名
                            </ListboxItem>
                            <ListboxItem
                                key="delete"
                                className="text-danger"
                                color="danger"
                                startContent={<Trash2 className="w-4 h-4" />}
                                onPress={() => {
                                    onDelete();
                                    setIsPopoverOpen(false);
                                }}
                            >
                                删除
                            </ListboxItem>
                        </Listbox>
                    </PopoverContent>
                </Popover>
            )}
        </div>
    );
};

export const AgentConversationList: React.FC<AgentConversationListProps> = ({
    activeTab,
    agentConversations,
    agentLoading,
    agentHasMore,
    selectedAgentConversationId,
    editingConversationId,
    editingConversationTitle,
    onSelectAgentConversation,
    onStartEditConversation,
    onSaveEditConversation,
    onCancelEditConversation,
    onEditingConversationTitleChange,
    onDeleteConversation,
    onLoadMore
}) => {
    if (activeTab !== "agent") {
        return null;
    }

    return (
        <>
            <Divider className="my-3" />
            <div className="px-1">
                <div className="text-xs font-semibold text-default-500 uppercase mb-2">Agent 对话</div>

                {agentLoading && agentConversations.length === 0 ? (
                    <div className="flex justify-center py-4">
                        <Spinner size="sm" />
                    </div>
                ) : agentConversations.length === 0 ? (
                    <div className="text-center py-4 text-default-400 text-sm">暂无对话</div>
                ) : (
                    <div className="space-y-0.5">
                        {agentConversations.map(conversation => (
                            <AgentConversationItem
                                key={conversation.id}
                                conversation={conversation}
                                editingTitle={editingConversationTitle}
                                isActive={selectedAgentConversationId === conversation.id}
                                isEditing={editingConversationId === conversation.id}
                                onCancelEdit={onCancelEditConversation}
                                onDelete={() => onDeleteConversation(conversation.id)}
                                onEditingTitleChange={onEditingConversationTitleChange}
                                onSaveEdit={() => onSaveEditConversation(conversation.id)}
                                onSelect={() => onSelectAgentConversation?.(conversation.id)}
                                onStartEdit={() => onStartEditConversation(conversation)}
                            />
                        ))}
                    </div>
                )}

                {agentHasMore && (
                    <Button className="w-full mt-2 mb-2" isLoading={agentLoading} size="sm" variant="flat" onPress={onLoadMore}>
                        加载更多
                    </Button>
                )}
            </div>
        </>
    );
};
