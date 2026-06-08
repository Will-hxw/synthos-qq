import { afterEach, describe, expect, it, vi } from "vitest";

import { DashScopeVisionClient } from "../services/image-understanding/DashScopeVisionClient";
import { OcrSpaceClient } from "../services/image-understanding/OcrSpaceClient";

describe("OcrSpaceClient", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("应使用 OCR.space URL 请求参数并合并 ParsedText", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    ParsedResults: [{ ParsedText: "第一行\n" }, { ParsedText: "第二行" }],
                    IsErroredOnProcessing: false
                }),
                { status: 200 }
            )
        );

        vi.stubGlobal("fetch", fetchMock);

        const client = new OcrSpaceClient();
        const result = await client.parseImageUrl("https://example.com/image.jpg", createOcrConfig(), 30000);
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const formData = init.body as FormData;

        expect(fetchMock.mock.calls[0][0]).toBe("https://api.ocr.space/parse/image");
        expect((init.headers as Record<string, string>).apikey).toBe("test-ocr-key");
        expect(formData.get("url")).toBe("https://example.com/image.jpg");
        expect(formData.get("language")).toBe("chs");
        expect(formData.get("OCREngine")).toBe("2");
        expect(formData.get("scale")).toBe("true");
        expect(formData.get("detectOrientation")).toBe("true");
        expect(result).toEqual({
            text: "第一行\n第二行",
            isSuccess: true,
            failReason: ""
        });
    });

    it("OCR.space 部分成功时应保留文本并记录降级原因", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        ParsedResults: [{ ParsedText: "可读文字" }],
                        IsErroredOnProcessing: true,
                        ErrorMessage: "部分页面失败"
                    }),
                    { status: 200 }
                )
            )
        );

        const client = new OcrSpaceClient();
        const result = await client.parseBase64Image("data:image/png;base64,AAAA", createOcrConfig(), 30000);

        expect(result.text).toBe("可读文字");
        expect(result.isSuccess).toBe(false);
        expect(result.failReason).toBe("部分页面失败");
    });
});

describe("DashScopeVisionClient", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("应按 OpenAI-compatible chat/completions 格式发送图片和严格 JSON 请求", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    visionDescription: "一张通知截图。",
                                    imageCategory: "screenshot",
                                    understandingText: "图片通知报名截止时间为 6 月 10 日。",
                                    confidence: 0.9
                                })
                            }
                        }
                    ]
                }),
                { status: 200 }
            )
        );

        vi.stubGlobal("fetch", fetchMock);

        const client = new DashScopeVisionClient();
        const result = await client.understandImage(
            "https://example.com/image.jpg",
            "只输出 JSON",
            createVisionConfig(),
            30000
        );
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(init.body as string);

        expect(fetchMock.mock.calls[0][0]).toBe(
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-vision-key");
        expect(body.model).toBe("qwen3.6-flash-2026-04-16");
        expect(body.messages[0].content).toEqual([
            {
                type: "text",
                text: "只输出 JSON"
            },
            {
                type: "image_url",
                image_url: {
                    url: "https://example.com/image.jpg"
                }
            }
        ]);
        expect(body.response_format).toEqual({ type: "json_object" });
        expect(result).toEqual({
            visionDescription: "一张通知截图。",
            imageCategory: "screenshot",
            understandingText: "图片通知报名截止时间为 6 月 10 日。",
            confidence: 0.9
        });
    });

    it("DashScope 返回 fenced JSON 时应清理代码块后解析", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        choices: [
                            {
                                message: {
                                    content:
                                        '```json\n{"visionDescription":"图表","imageCategory":"chart","understandingText":"趋势上升","confidence":0.7}\n```'
                                }
                            }
                        ]
                    }),
                    { status: 200 }
                )
            )
        );

        const client = new DashScopeVisionClient();
        const result = await client.understandImage(
            "data:image/png;base64,AAAA",
            "只输出 JSON",
            createVisionConfig(),
            30000
        );

        expect(result.imageCategory).toBe("chart");
        expect(result.understandingText).toBe("趋势上升");
        expect(result.confidence).toBe(0.7);
    });
});

function createOcrConfig() {
    return {
        provider: "ocrspace",
        apiKey: "test-ocr-key",
        endpoint: "https://api.ocr.space/parse/image",
        language: "chs",
        ocrEngine: 2,
        scale: true,
        detectOrientation: true,
        isOverlayRequired: false,
        maxImageBytes: 1048576
    } as any;
}

function createVisionConfig() {
    return {
        provider: "dashscope-openai-compatible",
        apiKey: "test-vision-key",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelName: "qwen3.6-flash-2026-04-16",
        temperature: 0,
        maxTokens: 2048
    } as any;
}
