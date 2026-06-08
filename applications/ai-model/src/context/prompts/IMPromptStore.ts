import { CTX_MIDDLEWARE_TOKENS } from "../middleware/container/container";
import { useMiddleware } from "../middleware/useMiddleware";
import { ContentUtils } from "../template/ContentUtils";
import { CtxTemplateNode } from "../template/CtxTemplate";

export class IMPromptStore {
    // 这里不注入时间中间件，因为待总结话题可能不是最近的
    @useMiddleware(CTX_MIDDLEWARE_TOKENS.ADD_BACKGROUND_KNOWLEDGE)
    public static async getSummarizePrompt(
        groupIntroduction: string,
        maxTopics: number,
        messages: string
    ): Promise<CtxTemplateNode> {
        const root = new CtxTemplateNode();

        root.setChildNodes([
            new CtxTemplateNode()
                .setTitle("你的任务")
                .setContentText(
                    `你是一个帮我进行群聊信息总结的助手，请分析接下来提供的群聊记录，提取出最多${maxTopics}个主要话题。生成总结内容时，你需要严格遵守下面的全部准则：`
                ),
            new CtxTemplateNode()
                .setTitle("对于每个话题，请提供：")
                .setContentText(
                    ContentUtils.orderedList([
                        "话题名称（突出主题内容，尽量简明扼要）",
                        "主要参与者（最多10人）",
                        "话题详细描述（包含关键信息和结论）"
                    ])
                ),
            new CtxTemplateNode()
                .setTitle("注意")
                .setContentText(
                    ContentUtils.unorderedList([
                        '对于比较有价值的点，用几句话详细展开讲讲，但是不要生成类似于 "李嘉浩和杨浩然讨论了中科大计算机研究生院今年招生情况" 这种宽泛的内容，而是生成更加具体的讨论内容，让其他人只看这个消息就能知道讨论中有价值的、有营养的信息。',
                        "对于其中一些重要信息，你需要特意提到主题施加的主体是谁，是哪个群友做了什么事情，而不要直接生成和群友没有关系的语句；对于次要信息，则不需要提到主题施加的主体。",
                        "对于每一条总结，尽量讲清楚前因后果，以及话题的结论——是什么、为什么、怎么做；如果用户没有讲到细节，则可以不用这么做。",
                        "群聊记录中的消息有时候会出现相互引用（mention）的情况，会使用类似于这样的格式标出：\"'杨浩然(群昵称：ユリの花)'：【引用来自'李嘉浩(群昵称：DEAR James·Jordan ≈)'的消息: 今年offer发了多少】@DEAR James·Jordan ≈ 我觉得今年会超发offer\"。",
                        "群成员的昵称可能是自己的QQ昵称，也可能是群昵称，也可能是真实姓名。",
                        "聊天中出现的表情使用以下格式标出：[/大怨种]。",
                        "类似早安晚安之类的无实质内容的打招呼消息，请不要将其作为话题返回。但对于通知、公告、重要信息分享等简短但有实质价值的内容，即使只有一两句话也应该提取为话题进行总结。",
                        "对话中出现的链接、群号等信息请尽量完整保留下来。",
                        "群聊记录中的图片可能带有 OCR、描述和理解文本，这些内容是图片信息的辅助描述；请优先保留其中的关键时间、地点、链接、数字、通知内容和截止日期，但不要把 OCR 失败、暂无描述、处理失败等状态本身当成话题。",
                        '"detail"字段中出现的用户昵称名必须和"contributors"数组中的item一致，不允许改变和缩减。'
                    ])
                ),
            new CtxTemplateNode().setTitle("群聊详情").setContentText(groupIntroduction),
            new CtxTemplateNode().setTitle("群聊记录").setContentText(messages),
            new CtxTemplateNode().setTitle("输出格式要求").setContentText(`
                    重要：必须返回能被 JSON.parse 直接解析的标准 JSON 数组，严格遵守以下规则：
                    1. 只输出 JSON 数组本身，不要在 JSON 外添加任何文字说明，不要使用 Markdown 代码块
                    2. JSON 的键名和字符串值必须使用英文双引号 " 包裹
                    3. 字符串内容中如果需要出现英文双引号 " ，必须转义为 \\" ，严禁在字符串内部直接输出未转义的英文双引号
                    4. 如果原始聊天内容包含英文双引号、JSON片段、代码、引用文本等，请保留语义，但必须完成 JSON 转义
                    5. 字符串内容中不要输出未转义的换行控制字符；如需表达换行，请改写为普通中文句子
                    6. 多个对象之间用逗号分隔，不要输出尾随逗号、注释或多余字段
                    7. 输出前请自检一次：整体内容必须可以被 JSON.parse 成功解析
                    8. 以下失败形态一律不允许：Markdown 代码围栏、残缺代码围栏、JSON 外说明文字、尾随逗号、字符串内部未转义的英文双引号、字符串内部真实换行、未闭合的数组/对象/字符串

                    错误示例（不要这样输出，detail 内部的英文双引号没有转义）：
                    [
                    {
                        "topic": "模型报错讨论",
                        "contributors": ["用户1"],
                        "detail": "用户1说 "The request was rejected because it was considered high risk"，这是原始报错文本。"
                    }
                    ]

                    错误示例（不要这样输出，最后一个对象后存在尾随逗号）：
                    [
                    {
                        "topic": "模型报错讨论",
                        "contributors": ["用户1"],
                        "detail": "用户1讨论了模型返回错误。"
                    },
                    ]

                    错误示例（不要这样输出，存在残缺 Markdown 代码围栏或 JSON 外文字）：
                    json
                    [
                    {
                        "topic": "模型报错讨论",
                        "contributors": ["用户1"],
                        "detail": "用户1讨论了模型返回错误。"
                    }
                    ]

                    正确示例：
                    [
                    {
                        "topic": "模型报错讨论",
                        "contributors": ["用户1"],
                        "detail": "用户1说 \\"The request was rejected because it was considered high risk\\"，这是原始报错文本。"
                    }
                    ]

                    请严格按照以下JSON格式返回，确保可以被标准JSON解析器解析：
                    [
                    {
                        "topic": "话题名称",
                        "contributors": ["用户1", "用户2"],
                        "detail": "话题描述内容"
                    }
                    ]
                    一段输出示例如下：
                    [
                    {
                    "topic": "中国科学院软件研究所科创计划项目介绍与水平评估",
                    "contributors": ["23-upc-爱卖菜的Julie😆","kltb","22-魔法少女上岸nju-ics的krkt","23-hust-koreyoshi","22-xdu-thu-残心"],
                    "detail": "23-upc-爱卖菜的Julie😆在群内询问中国科学院软件研究所的‘大学生创新实践训练计划’（科创计划）的含金量，以及其相当于什么学校的冬令营水平。kltb提供了详细解答，指出科创计划是一个为期6个月的实习项目，能提供顶级科研资源和导师指导，对于提升科研能力和积累长期规范的科研探索经历意义重大。从推免角度看，软件所的门槛略低于计算所和自动化所，但仍至少相当于C9高校水平，因其历史渊源是从计算所独立而来。kltb强调，在本科学校、绩点或竞赛不突出的情况下，一段成熟的科研经历或一篇B类会议论文可以作为有力补充，但并非硬性要求。他还提到，软件所录取标准相对模糊，存在一定的运气成分。23-hust-koreyoshi对此表示惊讶，认为要求似乎很高，而22-魔法少女上岸nju-ics的krkt则证实了软件所面试时生源背景多样，清北与双非学生俱全。相关官方信息链接为：https://yyy.cn/yyy.html 和 https://xxx.cn/xxx.html。"
                    }
                    ]`)
        ]);

        return root;
    }
}
