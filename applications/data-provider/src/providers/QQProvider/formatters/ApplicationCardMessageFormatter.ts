const PRIMARY_LINK_KEYS = ["jumpurl", "qqdocurl", "url", "legacyurl", "pcjumpurl"];
const NOISE_LINK_PATH_PARTS = ["icon", "preview", "cover", "avatar", "logo", "tagicon", "image", "pic", "thumb"];
const TITLE_KEYS = ["title", "maintitle", "headline", "name"];
const DESCRIPTION_KEYS = ["desc", "description", "summary", "digest", "content", "text"];
const SOURCE_KEYS = ["source", "sourcename", "appname", "tag", "platform"];

interface StructuredStringEntry {
    path: string;
    key: string;
    value: string;
}

interface ApplicationCardInfo {
    source: string;
    title: string;
    description: string;
    link: string;
}

export function formatApplicationCardMessage(rawContent: string): string {
    const normalized = normalizeInlineText(rawContent);

    if (!normalized) {
        return buildBracketedMessage("卡片消息", ["暂无可读文本"]);
    }

    try {
        const parsed = JSON.parse(rawContent);
        const entries: StructuredStringEntry[] = [];

        collectStructuredStringEntries(parsed, entries, []);

        const cardInfo = extractApplicationCardInfo(entries);
        const parts = [
            cardInfo.source ? `来源：${cardInfo.source}` : "",
            cardInfo.title ? `标题：${cardInfo.title}` : "",
            cardInfo.description ? `描述：${cardInfo.description}` : "",
            cardInfo.link ? `链接：${cardInfo.link}` : ""
        ].filter(Boolean);

        if (parts.length > 0) {
            return buildBracketedMessage("卡片消息", parts);
        }

        return buildBracketedMessage("卡片消息", ["暂无可读文本"]);
    } catch {
        return formatStructuredMessage("卡片消息", rawContent);
    }
}

function formatStructuredMessage(kind: string, rawContent: string): string {
    const structuredText = extractStructuredText(rawContent);

    if (!structuredText) {
        return buildBracketedMessage(kind, ["暂无可读文本"]);
    }

    return buildBracketedMessage(kind, [structuredText]);
}

function extractStructuredText(rawContent: string): string {
    const normalized = normalizeInlineText(rawContent);

    if (!normalized) {
        return "";
    }

    try {
        const parsed = JSON.parse(rawContent);
        const values: string[] = [];

        collectStructuredStrings(parsed, values);

        if (values.length > 0) {
            return values.slice(0, 6).join("；");
        }
    } catch {
        // 非 JSON 时继续按文本/XML 兜底处理。
    }

    return truncateText(stripXmlTags(normalized), 200);
}

function collectStructuredStrings(value: unknown, values: string[]): void {
    if (values.length >= 6 || value === null || value === undefined) {
        return;
    }

    if (typeof value === "string") {
        const normalized = normalizeInlineText(value);

        if (normalized) {
            values.push(truncateText(normalized, 80));
        }

        return;
    }

    if (typeof value !== "object") {
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectStructuredStrings(item, values);
        }

        return;
    }

    for (const item of Object.values(value as Record<string, unknown>)) {
        collectStructuredStrings(item, values);
    }
}

function collectStructuredStringEntries(
    value: unknown,
    entries: StructuredStringEntry[],
    pathParts: string[]
): void {
    if (value === null || value === undefined) {
        return;
    }

    if (typeof value === "string") {
        const normalized = normalizeInlineText(value);

        if (normalized) {
            entries.push({
                path: pathParts.join("."),
                key: pathParts[pathParts.length - 1] || "",
                value: normalized
            });
        }

        return;
    }

    if (typeof value !== "object") {
        return;
    }

    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            collectStructuredStringEntries(value[index], entries, [...pathParts, String(index)]);
        }

        return;
    }

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        collectStructuredStringEntries(item, entries, [...pathParts, key]);
    }
}

function extractApplicationCardInfo(entries: StructuredStringEntry[]): ApplicationCardInfo {
    const link = selectApplicationPrimaryLink(entries);
    const source = selectApplicationSource(entries, link);
    const title = selectApplicationText(entries, TITLE_KEYS, [source, link], 80);
    const description = selectApplicationText(entries, DESCRIPTION_KEYS, [source, title, link], 120);

    return {
        source,
        title,
        description,
        link
    };
}

function selectApplicationPrimaryLink(entries: StructuredStringEntry[]): string {
    let selectedLink = "";
    let selectedPriority = Number.POSITIVE_INFINITY;

    for (const entry of entries) {
        const link = normalizeStructuredUrl(entry.value);

        if (!link || isApplicationNoisePath(entry.path)) {
            continue;
        }

        const key = normalizeStructuredKey(entry.key);
        const primaryKeyIndex = PRIMARY_LINK_KEYS.indexOf(key);
        const priority = primaryKeyIndex >= 0 ? primaryKeyIndex : getFallbackLinkPriority(key);

        if (priority < selectedPriority) {
            selectedLink = link;
            selectedPriority = priority;
        }
    }

    return selectedLink;
}

function getFallbackLinkPriority(key: string): number {
    if (key.includes("url") || key.includes("link")) {
        return 50;
    }

    return 100;
}

function selectApplicationSource(entries: StructuredStringEntry[], link: string): string {
    const source = selectApplicationText(entries, SOURCE_KEYS, [link], 40);

    if (source) {
        return source;
    }

    return inferApplicationCardSourceFromLink(link);
}

function selectApplicationText(
    entries: StructuredStringEntry[],
    acceptedKeys: string[],
    excludedValues: string[],
    maxLength: number
): string {
    for (const entry of entries) {
        const key = normalizeStructuredKey(entry.key);

        if (!acceptedKeys.includes(key)) {
            continue;
        }

        if (isApplicationNoisePath(entry.path) || normalizeStructuredUrl(entry.value)) {
            continue;
        }

        const normalized = normalizeInlineText(entry.value);

        if (!isReadableApplicationText(normalized)) {
            continue;
        }

        if (excludedValues.some(value => value && value === normalized)) {
            continue;
        }

        return truncateText(normalized, maxLength);
    }

    return "";
}

function inferApplicationCardSourceFromLink(link: string): string {
    if (!link) {
        return "";
    }

    try {
        const hostname = new URL(link).hostname.toLowerCase();

        if (hostname === "b23.tv" || hostname.endsWith(".b23.tv") || hostname.endsWith(".bilibili.com")) {
            return "B站";
        }

        if (
            hostname === "xhslink.com" ||
            hostname.endsWith(".xhslink.com") ||
            hostname.endsWith(".xiaohongshu.com")
        ) {
            return "小红书";
        }

        if (hostname === "mp.weixin.qq.com") {
            return "微信公众号";
        }

        if (hostname === "docs.qq.com") {
            return "腾讯文档";
        }

        if (hostname === "zhuanlan.zhihu.com") {
            return "知乎专栏";
        }

        return hostname.startsWith("www.") ? hostname.substring(4) : hostname;
    } catch {
        return "";
    }
}

function normalizeStructuredUrl(value: string): string {
    const normalized = normalizeInlineText(value).replaceAll("\\/", "/");

    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
        return "";
    }

    try {
        const url = new URL(normalized);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return "";
        }

        return normalized;
    } catch {
        return "";
    }
}

function isApplicationNoisePath(pathValue: string): boolean {
    const normalizedPath = normalizeStructuredKey(pathValue);

    return NOISE_LINK_PATH_PARTS.some(part => normalizedPath.includes(part));
}

function isReadableApplicationText(value: string): boolean {
    const normalized = normalizeInlineText(value);

    if (!normalized) {
        return false;
    }

    const lowerValue = normalized.toLowerCase();

    if (lowerValue.startsWith("com.tencent.") || lowerValue.endsWith(".lua")) {
        return false;
    }

    return true;
}

function normalizeStructuredKey(value: string): string {
    return value.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function stripXmlTags(value: string): string {
    let result = "";
    let inTag = false;

    for (const char of value) {
        if (char === "<") {
            inTag = true;
            result += " ";
            continue;
        }

        if (char === ">") {
            inTag = false;
            result += " ";
            continue;
        }

        if (!inTag) {
            result += char;
        }
    }

    return normalizeInlineText(result);
}

function buildBracketedMessage(kind: string, parts: string[]): string {
    const normalizedParts = parts.map(part => normalizeInlineText(part)).filter(Boolean);

    return `[${[kind, ...normalizedParts].join("，")}]`;
}

function normalizeInlineText(value: unknown): string {
    if (typeof value !== "string") {
        return "";
    }

    let result = "";
    let hasPendingSpace = false;

    for (const char of value.trim()) {
        if (char === " " || char === "\n" || char === "\r" || char === "\t") {
            hasPendingSpace = result.length > 0;
            continue;
        }

        if (hasPendingSpace) {
            result += " ";
            hasPendingSpace = false;
        }

        result += char;
    }

    return result.trim();
}

function truncateText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}...`;
}
