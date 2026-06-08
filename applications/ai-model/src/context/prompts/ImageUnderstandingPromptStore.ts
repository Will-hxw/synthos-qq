import { ContentUtils } from "../template/ContentUtils";
import { CtxTemplateNode } from "../template/CtxTemplate";

export class ImageUnderstandingPromptStore {
    public static async getImageUnderstandingPrompt(
        ocrText: string,
        messageContent: string
    ): Promise<CtxTemplateNode> {
        const root = new CtxTemplateNode();

        root.setChildNodes([
            new CtxTemplateNode()
                .setTitle("你的任务")
                .setContentText("你需要理解一张群聊图片，并输出可供群聊摘要使用的结构化中文结果。"),
            new CtxTemplateNode()
                .setTitle("输出要求")
                .setContentText(
                    ContentUtils.unorderedList([
                        "只输出一个 JSON 对象，不要使用 Markdown 代码块，不要输出 JSON 之外的解释文字。",
                        "visionDescription 用一到两句话客观描述图片内容。",
                        "imageCategory 只能从 screenshot、document、photo、meme、chart、other 中选择一个。",
                        "understandingText 应该适合直接拼入群聊摘要上下文，优先保留时间、地点、链接、数字、通知、截止日期等关键信息。",
                        "如果 OCR 文本为空或明显不可靠，不要编造图片里的文字。",
                        "如果图片只是表情包或低信息量图片，应在 understandingText 中简短说明，不要过度扩写。",
                        "confidence 使用 0 到 1 的数字表示整体可信度。"
                    ])
                ),
            new CtxTemplateNode().setTitle("已有 OCR 文本").setContentText(ocrText || "无"),
            new CtxTemplateNode().setTitle("原始消息文本").setContentText(messageContent || "无"),
            new CtxTemplateNode().setTitle("JSON 格式").setContentText(`{
  "visionDescription": "图片内容的客观描述",
  "imageCategory": "screenshot",
  "understandingText": "可直接进入摘要上下文的中文描述",
  "confidence": 0.8
}`)
        ]);

        return root;
    }
}
