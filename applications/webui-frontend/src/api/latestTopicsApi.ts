import type { ApiResponse } from "@/types/api";
import type { LatestTopicsRequest, LatestTopicsResponse } from "@/types/topic";

import API_BASE_URL from "./constants/baseUrl";

import fetchWrapper from "@/util/fetchWrapper";
import { mockConfig } from "@/config/mock";
import { mockGetLatestTopics } from "@/mock/latestTopicsMock";

export const getLatestTopics = async (params: LatestTopicsRequest, signal?: AbortSignal): Promise<ApiResponse<LatestTopicsResponse>> => {
    if (mockConfig.latestTopics) {
        return mockGetLatestTopics(params);
    }

    const response = await fetchWrapper(`${API_BASE_URL}/api/latest-topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal
    });

    return response.json();
};
