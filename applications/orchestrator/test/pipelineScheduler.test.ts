import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const mockPipelineJob = {
        attrs: {} as {
            lockedAt?: Date;
            failedAt?: Date;
            failReason?: string;
        },
        schedule: vi.fn(),
        save: vi.fn()
    };

    mockPipelineJob.schedule.mockReturnValue(mockPipelineJob);

    return {
        mockPipelineJob,
        mockAgendaEvery: vi.fn(async () => mockPipelineJob),
        mockAgendaNow: vi.fn(),
        mockAgendaCreate: vi.fn(() => ({ unique: vi.fn(() => ({ save: vi.fn().mockResolvedValue(undefined) })) })),
        mockAgendaDefine: vi.fn(),
        mockAgendaJobs: vi.fn().mockResolvedValue([{ name: "registered" }]),
        mockAgendaStart: vi.fn(),
        mockCleanupStaleJobs: vi.fn().mockResolvedValue(undefined),
        mockScheduleAndWaitForJob: vi.fn().mockResolvedValue(true),
        mockRegisterConfigManagerService: vi.fn(),
        mockGetCurrentConfig: vi.fn().mockResolvedValue({
            orchestrator: {
                pipelineIntervalInMinutes: 30,
                dataSeekTimeWindowInHours: 1
            },
            groupConfigs: {
                "group-a": {}
            }
        }),
        mockBootstrap: vi.fn((target: unknown) => target),
        mockBootstrapAll: vi.fn(),
        mockSetupReportScheduler: vi.fn().mockResolvedValue(undefined)
    };
});

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

vi.mock("@root/common/scheduler/agenda", () => ({
    agendaInstance: {
        every: mocks.mockAgendaEvery,
        now: mocks.mockAgendaNow,
        create: mocks.mockAgendaCreate,
        define: mocks.mockAgendaDefine,
        jobs: mocks.mockAgendaJobs,
        ready: Promise.resolve(),
        start: mocks.mockAgendaStart
    }
}));

vi.mock("@root/common/scheduler/jobUtils", () => ({
    cleanupStaleJobs: mocks.mockCleanupStaleJobs,
    scheduleAndWaitForJob: mocks.mockScheduleAndWaitForJob
}));

vi.mock("@root/common/di/container", () => ({
    registerConfigManagerService: mocks.mockRegisterConfigManagerService
}));

vi.mock("@root/common/services/config/ConfigManagerService", () => ({
    default: { getCurrentConfig: mocks.mockGetCurrentConfig }
}));

vi.mock("@root/common/util/lifecycle/bootstrap", () => ({
    bootstrap: mocks.mockBootstrap,
    bootstrapAll: mocks.mockBootstrapAll
}));

vi.mock("../src/schedulers/reportScheduler", () => ({
    setupReportScheduler: mocks.mockSetupReportScheduler
}));

import { TaskHandlerTypes } from "@root/common/scheduler/@types/Tasks";

import { schedulePipelineIntervalWithStartupRun } from "../src/index";

describe("schedulePipelineIntervalWithStartupRun", () => {
    beforeEach(() => {
        mocks.mockPipelineJob.schedule.mockClear();
        mocks.mockPipelineJob.save.mockClear();
        mocks.mockAgendaEvery.mockClear();
        mocks.mockAgendaNow.mockClear();
        mocks.mockAgendaCreate.mockClear();
        mocks.mockAgendaDefine.mockClear();
        mocks.mockAgendaJobs.mockClear();
        mocks.mockAgendaStart.mockClear();
        mocks.mockCleanupStaleJobs.mockClear();
        mocks.mockScheduleAndWaitForJob.mockClear();
        mocks.mockRegisterConfigManagerService.mockClear();
        mocks.mockGetCurrentConfig.mockClear();
        mocks.mockSetupReportScheduler.mockClear();
        mocks.mockPipelineJob.attrs = {};
        mocks.mockPipelineJob.schedule.mockReturnValue(mocks.mockPipelineJob);
        mocks.mockAgendaEvery.mockResolvedValue(mocks.mockPipelineJob);
        mocks.mockAgendaJobs.mockResolvedValue([{ name: "registered" }]);
        mocks.mockScheduleAndWaitForJob.mockResolvedValue(true);
        mocks.mockGetCurrentConfig.mockResolvedValue({
            orchestrator: {
                pipelineIntervalInMinutes: 30,
                dataSeekTimeWindowInHours: 1
            },
            groupConfigs: {
                "group-a": {}
            }
        });
    });

    it("启动立即执行应复用唯一周期任务，不应额外插入一次性 RunPipeline", async () => {
        await schedulePipelineIntervalWithStartupRun(30);

        expect(mocks.mockAgendaEvery).toHaveBeenCalledWith("30 minutes", TaskHandlerTypes.RunPipeline, undefined, {
            skipImmediate: true
        });
        expect(mocks.mockPipelineJob.schedule).toHaveBeenCalledWith(expect.any(Date));
        expect(mocks.mockPipelineJob.save).toHaveBeenCalledTimes(1);
        expect(mocks.mockAgendaNow).not.toHaveBeenCalled();
    });

    it("启动立即执行应释放周期 RunPipeline 的残留锁", async () => {
        mocks.mockPipelineJob.attrs = {
            lockedAt: new Date("2026-06-09T03:33:38.645+08:00"),
            failedAt: new Date("2026-06-09T03:29:02.927+08:00"),
            failReason: "ProvideData task failed"
        };

        await schedulePipelineIntervalWithStartupRun(30);

        expect(mocks.mockPipelineJob.attrs.lockedAt).toBeUndefined();
        expect(mocks.mockPipelineJob.attrs.failedAt).toBeUndefined();
        expect(mocks.mockPipelineJob.attrs.failReason).toBeUndefined();
        expect(mocks.mockPipelineJob.schedule).toHaveBeenCalledWith(expect.any(Date));
        expect(mocks.mockPipelineJob.save).toHaveBeenCalledTimes(1);
        expect(mocks.mockAgendaNow).not.toHaveBeenCalled();
    });

    it("RunPipeline 应按 ProvideData、ImageUnderstanding、Preprocess、AudioTranscription、AISummarize 顺序调度", async () => {
        const ApplicationClass = mocks.mockBootstrap.mock.calls[0][0] as new () => { main: () => Promise<void> };
        const app = new ApplicationClass();

        await app.main();

        const runPipelineHandler = mocks.mockAgendaDefine.mock.calls.find(
            call => call[0] === TaskHandlerTypes.RunPipeline
        )?.[1] as (job: any) => Promise<void>;

        await runPipelineHandler({
            attrs: {
                name: TaskHandlerTypes.RunPipeline,
                data: {}
            },
            touch: vi.fn().mockResolvedValue(undefined),
            fail: vi.fn()
        });

        const scheduledTaskNames = mocks.mockScheduleAndWaitForJob.mock.calls.map(call => call[0]);

        expect(scheduledTaskNames).toEqual([
            TaskHandlerTypes.ProvideData,
            TaskHandlerTypes.ImageUnderstanding,
            TaskHandlerTypes.Preprocess,
            TaskHandlerTypes.AudioTranscription,
            TaskHandlerTypes.AISummarize,
            TaskHandlerTypes.GenerateEmbedding,
            TaskHandlerTypes.InterestScore,
            TaskHandlerTypes.LLMInterestEvaluationAndNotification
        ]);
        expect(mocks.mockCleanupStaleJobs).toHaveBeenCalledWith(
            expect.arrayContaining([TaskHandlerTypes.ImageUnderstanding, TaskHandlerTypes.AudioTranscription])
        );
        expect(mocks.mockAgendaJobs).toHaveBeenCalledWith({ name: TaskHandlerTypes.ImageUnderstanding });
        expect(mocks.mockAgendaJobs).toHaveBeenCalledWith({ name: TaskHandlerTypes.AudioTranscription });
    });
});
