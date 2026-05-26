import { describe, expect, it } from "vitest";

import { getCurrentFunctionName } from "../util/core/getCurrentFunctionName";

describe("getCurrentFunctionName", () => {
    it("应返回具名调用方名称", () => {
        function namedCaller(): string {
            return getCurrentFunctionName();
        }

        expect(namedCaller()).toBe("namedCaller");
    });

    it("匿名调用方也不应退化为 unknown", () => {
        const functionName = (() => getCurrentFunctionName())();

        expect(functionName).not.toBe("unknown");
    });

    it("应跳过日志包装函数并返回真实业务调用方", () => {
        function _getPrefix(): string {
            return getCurrentFunctionName();
        }

        function _logWithColor(): string {
            return _getPrefix();
        }

        function info(): string {
            return _logWithColor();
        }

        function businessCaller(): string {
            return info();
        }

        expect(businessCaller()).toBe("businessCaller");
    });
});
