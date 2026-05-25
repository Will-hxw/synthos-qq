/**
 * 最新话题控制器
 */
import { Request, Response } from "express";
import { injectable, inject } from "tsyringe";

import { TOKENS } from "../di/tokens";
import { LatestTopicsService } from "../services/LatestTopicsService";
import { GetLatestTopicsSchema } from "../schemas/index";

@injectable()
export class LatestTopicsController {
    public constructor(@inject(TOKENS.LatestTopicsService) private latestTopicsService: LatestTopicsService) {}

    /**
     * POST /api/latest-topics
     */
    public async getLatestTopics(req: Request, res: Response): Promise<void> {
        const params = GetLatestTopicsSchema.parse(req.body);
        const result = await this.latestTopicsService.getLatestTopics(params);

        res.json({ success: true, data: result });
    }
}
