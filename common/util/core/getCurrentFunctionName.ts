import { basename } from "path";

const IGNORED_FUNCTION_NAMES = new Set([
    "anonymous",
    "unknown",
    "info",
    "success",
    "debug",
    "warning",
    "warn",
    "error",
    "blue",
    "brightCyan",
    "green",
    "yellow",
    "red",
    "gray",
    "bgRed",
    "bgGreen",
    "bgYellow",
    "bgBlue",
    "gradientWithPastel",
    "gradientWithAtlas",
    "gradientWithRainbow",
    "_getPrefix",
    "_logWithColor",
    "_logWithGradient",
    "getCurrentFunctionName"
]);

const INTERNAL_FILE_NAMES = new Set([
    "Logger.ts",
    "Logger.js",
    "getCurrentFunctionName.ts",
    "getCurrentFunctionName.js"
]);

function getStructuredStack(): NodeJS.CallSite[] {
    const originalPrepareStackTrace = Error.prepareStackTrace;

    try {
        Error.prepareStackTrace = (_, stack) => stack;

        return (new Error().stack as unknown as NodeJS.CallSite[]) || [];
    } finally {
        Error.prepareStackTrace = originalPrepareStackTrace;
    }
}

function getFrameFileName(frame: NodeJS.CallSite): string {
    const fileName = frame.getFileName() || frame.getScriptNameOrSourceURL() || "";

    return basename(fileName);
}

function isInternalFrame(frame: NodeJS.CallSite): boolean {
    return INTERNAL_FILE_NAMES.has(getFrameFileName(frame));
}

function getFunctionNameFromFrame(frame: NodeJS.CallSite): string | null {
    const functionName = frame.getFunctionName() || frame.getMethodName();

    if (!functionName) {
        return null;
    }

    const parts = functionName.split(".");
    const normalizedFunctionName = parts[parts.length - 1] || functionName;

    if (IGNORED_FUNCTION_NAMES.has(normalizedFunctionName)) {
        return null;
    }

    return normalizedFunctionName;
}

function getFrameLocation(frame: NodeJS.CallSite): string | null {
    const fileName = getFrameFileName(frame);
    const lineNumber = frame.getLineNumber();

    if (!fileName) {
        return null;
    }

    return lineNumber ? `${fileName}:${lineNumber}` : fileName;
}

export function getCurrentFunctionName(): string {
    const stack = getStructuredStack();
    let fallbackLocation: string | null = null;

    for (const frame of stack) {
        if (isInternalFrame(frame)) {
            continue;
        }

        const functionName = getFunctionNameFromFrame(frame);

        if (functionName) {
            return functionName;
        }

        fallbackLocation = fallbackLocation ?? getFrameLocation(frame);
    }

    return fallbackLocation || "unknown";
}
