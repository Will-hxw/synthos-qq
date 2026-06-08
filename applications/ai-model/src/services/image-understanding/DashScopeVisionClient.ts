import { GlobalConfig } from "@root/common/services/config/schemas/GlobalConfig";

export interface VisionUnderstandingResult {
    visionDescription: string;
    imageCategory: string;
    understandingText: string;
    confidence: number;
}

interface ChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string | Array<{ type?: string; text?: string }>;
        };
    }>;
}

type VisionConfig = GlobalConfig["ai"]["imageUnderstanding"]["vision"];

export class DashScopeVisionClient {
    public async understandImage(
        imageUrl: string,
        prompt: string,
        config: VisionConfig,
        timeoutMs: number
    ): Promise<VisionUnderstandingResult> {
        const endpoint = this._joinChatCompletionEndpoint(config.baseURL);
        const response = await this._fetchWithTimeout(
            endpoint,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: config.modelName,
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: prompt
                                },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: imageUrl
                                    }
                                }
                            ]
                        }
                    ],
                    temperature: config.temperature,
                    max_tokens: config.maxTokens,
                    response_format: {
                        type: "json_object"
                    }
                })
            },
            timeoutMs
        );

        if (!response.ok) {
            throw new Error(`DashScope HTTP ${response.status}`);
        }

        const responseJson = (await response.json()) as ChatCompletionResponse;
        const content = this._extractContent(responseJson);
        const parsed = this._parseJsonObject(content);

        return {
            visionDescription: this._readString(parsed, "visionDescription"),
            imageCategory: this._readString(parsed, "imageCategory") || "other",
            understandingText: this._readString(parsed, "understandingText"),
            confidence: this._readNumber(parsed, "confidence")
        };
    }

    private _joinChatCompletionEndpoint(baseURL: string): string {
        const trimmed = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;

        return `${trimmed}/chat/completions`;
    }

    private async _fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await fetch(url, {
                ...init,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    private _extractContent(responseJson: ChatCompletionResponse): string {
        const content = responseJson.choices?.[0]?.message?.content;

        if (typeof content === "string") {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .map(item => (item.type === "text" || !item.type ? item.text || "" : ""))
                .filter(Boolean)
                .join("");
        }

        throw new Error("DashScope 未返回 message.content");
    }

    private _parseJsonObject(content: string): Record<string, unknown> {
        const trimmed = this._stripCodeFence(content.trim());
        const parsed = JSON.parse(trimmed);

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("DashScope 返回内容不是 JSON 对象");
        }

        return parsed as Record<string, unknown>;
    }

    private _stripCodeFence(content: string): string {
        if (!content.startsWith("```")) {
            return content;
        }

        const lines = content.split("\n");

        if (lines.length <= 2) {
            return content;
        }

        if (!lines[lines.length - 1].trim().startsWith("```")) {
            return content;
        }

        return lines
            .slice(1, lines.length - 1)
            .join("\n")
            .trim();
    }

    private _readString(parsed: Record<string, unknown>, key: string): string {
        const value = parsed[key];

        return typeof value === "string" ? value.trim() : "";
    }

    private _readNumber(parsed: Record<string, unknown>, key: string): number {
        const value = parsed[key];

        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    }
}
