import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

import { RagSearchTool } from "../agent/tools/RagSearchTool";
import { SQLQueryTool } from "../agent/tools/SQLQueryTool";
import { WebSearchTool } from "../agent/tools/WebSearchTool";

vi.mock("@root/common/util/Logger", () => ({
    default: {
        withTag: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn()
        })
    }
}));

describe("Agent工具输入校验", () => {
    it("sql_query缺少query时应返回明确错误", async () => {
        const tool = new SQLQueryTool({} as any);
        const executor = tool.getExecutor();

        await expect(executor({} as any, {} as any)).rejects.toThrow("sql_query 参数 query 不能为空");
    });

    it("sql_query应保留用户显式指定的更小LIMIT", async () => {
        const all = vi.fn().mockResolvedValue([]);
        const tool = new SQLQueryTool({ db: { all } } as any);
        const executor = tool.getExecutor();

        await executor({ query: "SELECT * FROM chat_messages LIMIT 1" } as any, {} as any);

        expect(all).toHaveBeenCalledWith("SELECT * FROM chat_messages LIMIT 1", []);
    });

    it("sql_query应下调超过工具上限的LIMIT", async () => {
        const all = vi.fn().mockResolvedValue([]);
        const tool = new SQLQueryTool({ db: { all } } as any);
        const executor = tool.getExecutor();

        await executor({ query: "SELECT * FROM chat_messages LIMIT 500", limit: 10 } as any, {} as any);

        expect(all).toHaveBeenCalledWith("SELECT * FROM chat_messages LIMIT 10", []);
    });

    it("rag_search缺少query时应返回明确错误", async () => {
        const tool = new RagSearchTool({} as any, {} as any, {} as any);
        const executor = tool.getExecutor();

        await expect(executor({ query: "   " } as any, {} as any)).rejects.toThrow(
            "rag_search 参数 query 不能为空"
        );
    });

    it("web_search缺少query时应返回明确错误", async () => {
        const tool = new WebSearchTool();
        const executor = tool.getExecutor();

        await expect(executor({} as any, {} as any)).rejects.toThrow("web_search 参数 query 不能为空");
    });
});
