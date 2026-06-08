/**
 * 配置面板常量定义
 */

/**
 * 配置区域排序（仅用于 UI 展示顺序；schema 新增的顶层字段会自动追加）
 */
export const PREFERRED_SECTION_ORDER: string[] = [
    "dataProviders",
    "preprocessors",
    "ai",
    "webUI_Backend",
    "orchestrator",
    "webUI_Forwarder",
    "commonDatabase",
    "logger",
    "groupConfigs",
    "email",
    "report"
];

/**
 * 配置区域图标映射（schema 新增的顶层字段将使用默认图标）
 */
export const SECTION_ICON_MAP: Record<string, string> = {
    dataProviders: "📊",
    preprocessors: "⚙️",
    ai: "🤖",
    webUI_Backend: "🖥️",
    orchestrator: "📅",
    webUI_Forwarder: "🌐",
    commonDatabase: "💾",
    logger: "📝",
    groupConfigs: "👥",
    email: "✉️",
    report: "🗞️"
};

/** 默认区域图标 */
export const DEFAULT_SECTION_ICON = "⚙️";

/** 敏感字段路径列表 */
export const SENSITIVE_FIELDS = [
    "dataProviders.QQ.dbKey",
    "ai.models.*.apiKey",
    "ai.defaultModelConfig.apiKey",
    "ai.imageUnderstanding.ocr.apiKey",
    "ai.imageUnderstanding.vision.apiKey",
    "webUI_Forwarder.authTokenForFE",
    "webUI_Forwarder.authTokenForBE"
];
