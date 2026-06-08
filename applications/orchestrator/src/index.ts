import "reflect-metadata";
import Logger from "@root/common/util/Logger";
import { agendaInstance } from "@root/common/scheduler/agenda";
import { TaskHandlerTypes, TaskParameters } from "@root/common/scheduler/@types/Tasks";
import { cleanupStaleJobs, scheduleAndWaitForJob } from "@root/common/scheduler/jobUtils";
import { registerConfigManagerService } from "@root/common/di/container";
import ConfigManagerService from "@root/common/services/config/ConfigManagerService";
import { getHoursAgoTimestamp } from "@root/common/util/TimeUtils";
import { IMTypes } from "@root/common/contracts/data-provider/index";
import { sleep } from "@root/common/util/promisify/sleep";
import { bootstrap, bootstrapAll } from "@root/common/util/lifecycle/bootstrap";

import { setupReportScheduler } from "./schedulers/reportScheduler";

/**
 * Pipeline 执行顺序（严格串行）:
 * 1. ProvideData - 获取原始数据
 * 2. ImageUnderstanding - 图片 OCR 与图片理解
 * 3. Preprocess - 预处理数据
 * 4. AudioTranscription - 语音转文字
 * 5. AISummarize - AI 摘要生成
 * 6. GenerateEmbedding - 生成向量嵌入
 * 7. InterestScore - 计算兴趣度评分
 * 8. LLMInterestEvaluationAndNotification - LLM智能兴趣评估与邮件通知
 */

// 注意：日报生成任务由 reportScheduler 负责，独立于主 Pipeline

const LOGGER = Logger.withTag("🎭 orchestrator-root-script");
const PIPELINE_WORKER_TASKS = [
    TaskHandlerTypes.ProvideData,
    TaskHandlerTypes.ImageUnderstanding,
    TaskHandlerTypes.Preprocess,
    TaskHandlerTypes.AudioTranscription,
    TaskHandlerTypes.AISummarize,
    TaskHandlerTypes.GenerateEmbedding,
    TaskHandlerTypes.InterestScore,
    TaskHandlerTypes.LLMInterestEvaluationAndNotification
];
const WORKER_REGISTRATION_TIMEOUT_MS = 60 * 1000;
const WORKER_REGISTRATION_POLL_INTERVAL_MS = 1000;

export async function schedulePipelineIntervalWithStartupRun(pipelineIntervalMinutes: number): Promise<void> {
    const pipelineJob = await agendaInstance.every(
        pipelineIntervalMinutes + " minutes",
        TaskHandlerTypes.RunPipeline,
        undefined,
        {
            skipImmediate: true
        }
    );

    if (pipelineJob.attrs.lockedAt) {
        LOGGER.warning(`启动时发现 RunPipeline 残留锁，锁定时间: ${pipelineJob.attrs.lockedAt}`);
        pipelineJob.attrs.lockedAt = undefined;
        pipelineJob.attrs.failedAt = undefined;
        pipelineJob.attrs.failReason = undefined;
    }

    pipelineJob.schedule(new Date());
    await pipelineJob.save();
}

@bootstrap
// eslint-disable-next-line @typescript-eslint/no-unused-vars
class OrchestratorApplication {
    public async main(): Promise<void> {
        // 初始化 DI 容器
        registerConfigManagerService();

        let config = await ConfigManagerService.getCurrentConfig();

        // 在启动前清理所有残留任务，避免上次运行残留的任务导致非预期执行
        await cleanupStaleJobs([
            TaskHandlerTypes.RunPipeline,
            TaskHandlerTypes.ProvideData,
            TaskHandlerTypes.ImageUnderstanding,
            TaskHandlerTypes.Preprocess,
            TaskHandlerTypes.AudioTranscription,
            TaskHandlerTypes.AISummarize,
            TaskHandlerTypes.GenerateEmbedding,
            TaskHandlerTypes.InterestScore,
            TaskHandlerTypes.LLMInterestEvaluationAndNotification,
            TaskHandlerTypes.GenerateReport
        ]);

        // 定义 RunPipeline 任务
        await agendaInstance
            .create(TaskHandlerTypes.RunPipeline)
            .unique({ name: TaskHandlerTypes.RunPipeline }, { insertOnly: true })
            .save();
        agendaInstance.define<TaskParameters<TaskHandlerTypes.RunPipeline>>(
            TaskHandlerTypes.RunPipeline,
            async job => {
                LOGGER.info(`🚀 开始执行 Pipeline 任务: ${job.attrs.name}`);
                config = await ConfigManagerService.getCurrentConfig(); // 刷新配置
                const startTimeStamp = getHoursAgoTimestamp(config.orchestrator.dataSeekTimeWindowInHours); // 如果是负数则代表自动获取时间范围
                const endTimeStamp = Date.now();

                const groupIds = Object.keys(config.groupConfigs);

                LOGGER.info(`Pipeline 配置 - 处理群组: ${groupIds.join(", ")}`);

                // 任务超时时间配置（毫秒）
                const TASK_TIMEOUT = 90 * 60 * 1000; // 90分钟
                const POLL_INTERVAL = 5000; // 5秒

                // ==================== 步骤 1: ProvideData ====================
                LOGGER.info("📥 [1/8] 开始执行 ProvideData 任务...");
                const provideDataSuccess = await scheduleAndWaitForJob(
                    TaskHandlerTypes.ProvideData,
                    {
                        IMType: IMTypes.QQ, // TODO: 支持多种 IM 类型
                        groupIds,
                        startTimeStamp: -1,
                        endTimeStamp
                    },
                    POLL_INTERVAL,
                    TASK_TIMEOUT
                );

                if (!provideDataSuccess) {
                    LOGGER.error("❌ ProvideData 任务失败，Pipeline 终止");
                    job.fail("ProvideData task failed");

                    return;
                }
                await job.touch();

                // ==================== 步骤 2: ImageUnderstanding ====================
                LOGGER.info("🖼️ [2/8] 开始执行 ImageUnderstanding 任务...");
                const imageUnderstandingSuccess = await scheduleAndWaitForJob(
                    TaskHandlerTypes.ImageUnderstanding,
                    {
                        groupIds,
                        startTimeStamp,
                        endTimeStamp
                    },
                    POLL_INTERVAL,
                    TASK_TIMEOUT
                );

                if (!imageUnderstandingSuccess) {
                    LOGGER.error("❌ ImageUnderstanding 任务失败，Pipeline 终止");
                    job.fail("ImageUnderstanding task failed");

                    return;
                }
                await job.touch();

                // ==================== 步骤 3: Preprocess ====================
                LOGGER.info("🔧 [3/8] 开始执行 Preprocess 任务...");
                const preprocessSuccess = await scheduleAndWaitForJob(
                    TaskHandlerTypes.Preprocess,
                    {
                        groupIds,
                        startTimeStamp,
                        endTimeStamp
                    },
                    POLL_INTERVAL,
                    TASK_TIMEOUT
                );

                if (!preprocessSuccess) {
                    LOGGER.error("❌ Preprocess 任务失败，Pipeline 终止");
                    job.fail("Preprocess task failed");

                    return;
                }
                await job.touch();

                // ==================== 步骤 4: AudioTranscription ====================
                LOGGER.info("🎙️ [4/8] 开始执行 AudioTranscription 任务...");
                const audioTranscriptionSuccess = await scheduleAndWaitForJob(
                    TaskHandlerTypes.AudioTranscription,
                    {
                        groupIds,
                        startTimeStamp,
                        endTimeStamp
                    },
                    POLL_INTERVAL,
                    TASK_TIMEOUT
                );

                if (!audioTranscriptionSuccess) {
                    LOGGER.error("❌ AudioTranscription 任务失败，Pipeline 终止");
                    job.fail("AudioTranscription task failed");

                    return;
                }
                await job.touch();

                // ==================== 步骤 5: AISummarize ====================
                LOGGER.info("🤖 [5/8] 开始执行 AISummarize 任务...");
                const aiSummarizeSuccess = await scheduleAndWaitForJob(
                    TaskHandlerTypes.AISummarize,
                    {
                        groupIds,
                        startTimeStamp,
                        endTimeStamp
                    },
                    POLL_INTERVAL,
                    TASK_TIMEOUT
                );

                if (!aiSummarizeSuccess) {
                    LOGGER.error("❌ AISummarize 任务失败，Pipeline 终止");
                    job.fail("AISummarize task failed");

                    return;
                }
                await job.touch();

                // ==================== 步骤 6: GenerateEmbedding ====================
                LOGGER.info("📐 [6/8] 开始执行 GenerateEmbedding 任务...");
                const generateEmbeddingSuccess = await scheduleAndWaitForJob(
                    TaskHandlerTypes.GenerateEmbedding,
                    {
                        startTimeStamp,
                        endTimeStamp
                    },
                    POLL_INTERVAL,
                    TASK_TIMEOUT
                );

                if (!generateEmbeddingSuccess) {
                    LOGGER.error("❌ GenerateEmbedding 任务失败，Pipeline 终止");
                    job.fail("GenerateEmbedding task failed");

                    return;
                }
                await job.touch();

                // ==================== 步骤 7: InterestScore ====================
                LOGGER.info("⭐ [7/8] 开始执行 InterestScore 任务...");
                const interestScoreSuccess = await scheduleAndWaitForJob(
                    TaskHandlerTypes.InterestScore,
                    {
                        startTimeStamp,
                        endTimeStamp
                    },
                    POLL_INTERVAL,
                    TASK_TIMEOUT
                );

                if (!interestScoreSuccess) {
                    LOGGER.error("❌ InterestScore 任务失败，Pipeline 终止");
                    job.fail("InterestScore task failed");

                    return;
                }
                await job.touch();

                // ==================== 步骤 8: LLMInterestEvaluationAndNotification ====================
                LOGGER.info("🔔 [8/8] 开始执行 LLMInterestEvaluationAndNotification 任务...");
                const llmInterestEvaluationSuccess = await scheduleAndWaitForJob(
                    TaskHandlerTypes.LLMInterestEvaluationAndNotification,
                    {
                        startTimeStamp,
                        endTimeStamp
                    },
                    POLL_INTERVAL,
                    TASK_TIMEOUT
                );

                if (!llmInterestEvaluationSuccess) {
                    LOGGER.error("❌ LLMInterestEvaluationAndNotification 任务失败，Pipeline 终止");
                    job.fail("LLMInterestEvaluationAndNotification task failed");

                    return;
                }

                LOGGER.success(`🎉 Pipeline 任务全部完成！`);
            },
            {
                concurrency: 1,
                priority: "high",
                lockLifetime: 90 * 60 * 1000 // 90min（Pipeline 整体超时）
            }
        );

        await this._waitForPipelineWorkerJobs(PIPELINE_WORKER_TASKS);

        // 读取配置，设置定时执行 Pipeline
        const pipelineIntervalMinutes = config.orchestrator.pipelineIntervalInMinutes;

        LOGGER.debug(`Pipeline 任务将每隔 ${pipelineIntervalMinutes} 分钟执行一次，启动时立即执行一次`);
        await schedulePipelineIntervalWithStartupRun(pipelineIntervalMinutes);

        LOGGER.success("✅ Orchestrator 准备就绪，启动 Agenda 调度器");
        await agendaInstance.start();

        // 设置日报定时任务
        await setupReportScheduler();
    }

    private async _waitForPipelineWorkerJobs(taskNames: TaskHandlerTypes[]): Promise<void> {
        await agendaInstance.ready;

        const startTime = Date.now();
        let lastMissingSignature = "";

        while (Date.now() - startTime <= WORKER_REGISTRATION_TIMEOUT_MS) {
            const missingTaskNames: TaskHandlerTypes[] = [];

            for (const taskName of taskNames) {
                const jobs = await agendaInstance.jobs({ name: taskName });

                if (jobs.length === 0) {
                    missingTaskNames.push(taskName);
                }
            }

            if (missingTaskNames.length === 0) {
                LOGGER.success("Pipeline worker 任务已全部注册");

                return;
            }

            const missingSignature = missingTaskNames.join(", ");

            if (missingSignature !== lastMissingSignature) {
                LOGGER.info(`等待 Pipeline worker 任务注册：${missingSignature}`);
                lastMissingSignature = missingSignature;
            }

            await sleep(WORKER_REGISTRATION_POLL_INTERVAL_MS);
        }

        throw new Error(`Pipeline worker 任务注册超时：${lastMissingSignature || "未知任务"}`);
    }
}

// 启动应用
bootstrapAll();
