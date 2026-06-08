import Logger from "@root/common/util/Logger";
import { GlobalConfig } from "@root/common/services/config/schemas/GlobalConfig";

export interface OcrSpaceResult {
    text: string;
    isSuccess: boolean;
    failReason: string;
}

interface OcrSpaceParsedResult {
    ParsedText?: string;
}

interface OcrSpaceResponse {
    ParsedResults?: OcrSpaceParsedResult[];
    IsErroredOnProcessing?: boolean;
    ErrorMessage?: string | string[];
    ErrorDetails?: string;
}

type OcrConfig = GlobalConfig["ai"]["imageUnderstanding"]["ocr"];

export class OcrSpaceClient {
    private readonly LOGGER = Logger.withTag("OcrSpaceClient");

    public async parseImageUrl(imageUrl: string, config: OcrConfig, timeoutMs: number): Promise<OcrSpaceResult> {
        const formData = this._buildBaseFormData(config);

        formData.set("url", imageUrl);

        return await this._submit(formData, config, timeoutMs);
    }

    public async parseBase64Image(
        base64Image: string,
        config: OcrConfig,
        timeoutMs: number
    ): Promise<OcrSpaceResult> {
        const formData = this._buildBaseFormData(config);

        formData.set("base64Image", base64Image);

        return await this._submit(formData, config, timeoutMs);
    }

    private _buildBaseFormData(config: OcrConfig): FormData {
        const formData = new FormData();

        formData.set("language", config.language);
        formData.set("OCREngine", String(config.ocrEngine));
        formData.set("scale", String(config.scale));
        formData.set("detectOrientation", String(config.detectOrientation));
        formData.set("isOverlayRequired", String(config.isOverlayRequired));

        return formData;
    }

    private async _submit(formData: FormData, config: OcrConfig, timeoutMs: number): Promise<OcrSpaceResult> {
        try {
            const response = await this._fetchWithTimeout(
                config.endpoint,
                {
                    method: "POST",
                    headers: {
                        apikey: config.apiKey
                    },
                    body: formData
                },
                timeoutMs
            );

            if (!response.ok) {
                return {
                    text: "",
                    isSuccess: false,
                    failReason: `OCR.space HTTP ${response.status}`
                };
            }

            const responseJson = (await response.json()) as OcrSpaceResponse;
            const parsedText = (responseJson.ParsedResults || [])
                .map(result => result.ParsedText || "")
                .map(text => this._normalizeText(text))
                .filter(Boolean)
                .join("\n");
            const errorMessage = this._formatErrorMessage(responseJson);

            if (parsedText) {
                return {
                    text: parsedText,
                    isSuccess: !responseJson.IsErroredOnProcessing,
                    failReason: responseJson.IsErroredOnProcessing ? errorMessage : ""
                };
            }

            return {
                text: "",
                isSuccess: false,
                failReason: errorMessage || "OCR.space 未返回可读文本"
            };
        } catch (error) {
            this.LOGGER.warning(`OCR.space 调用失败：${this._formatUnknownError(error)}`);

            return {
                text: "",
                isSuccess: false,
                failReason: this._formatUnknownError(error)
            };
        }
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

    private _formatErrorMessage(responseJson: OcrSpaceResponse): string {
        const messages = Array.isArray(responseJson.ErrorMessage)
            ? responseJson.ErrorMessage
            : [responseJson.ErrorMessage, responseJson.ErrorDetails];

        return messages
            .map(message => this._normalizeText(message || ""))
            .filter(Boolean)
            .join("；");
    }

    private _normalizeText(value: string): string {
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

    private _formatUnknownError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }
}
