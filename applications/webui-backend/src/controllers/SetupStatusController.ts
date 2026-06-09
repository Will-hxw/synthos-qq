import { Request, Response } from "express";
import { injectable, inject } from "tsyringe";

import { TOKENS } from "../di/tokens";
import { SetupStatusService } from "../services/SetupStatusService";
import { DigestCoverageDiagnosisService } from "../services/DigestCoverageDiagnosisService";
import { MediaProcessingDiagnosisService } from "../services/MediaProcessingDiagnosisService";
import { GetDigestCoverageSchema, GetMediaProcessingDiagnosisSchema } from "../schemas/index";

@injectable()
export class SetupStatusController {
    public constructor(
        @inject(TOKENS.SetupStatusService) private setupStatusService: SetupStatusService,
        @inject(TOKENS.DigestCoverageDiagnosisService)
        private digestCoverageDiagnosisService: DigestCoverageDiagnosisService,
        @inject(TOKENS.MediaProcessingDiagnosisService)
        private mediaProcessingDiagnosisService: MediaProcessingDiagnosisService
    ) {}

    /**
     * GET /api/setup-status
     */
    public async getSetupStatus(_req: Request, res: Response): Promise<void> {
        const status = await this.setupStatusService.getSetupStatus();

        res.json({
            success: true,
            data: status
        });
    }

    /**
     * POST /api/setup-status/digest-coverage
     */
    public async getDigestCoverage(req: Request, res: Response): Promise<void> {
        const params = GetDigestCoverageSchema.parse(req.body);
        const result = await this.digestCoverageDiagnosisService.getDigestCoverage(params);

        res.json({
            success: true,
            data: result
        });
    }

    /**
     * POST /api/setup-status/media-processing-diagnosis
     */
    public async getMediaProcessingDiagnosis(req: Request, res: Response): Promise<void> {
        const params = GetMediaProcessingDiagnosisSchema.parse(req.body);
        const result = await this.mediaProcessingDiagnosisService.getMediaProcessingDiagnosis(params);

        res.json({
            success: true,
            data: result
        });
    }
}
