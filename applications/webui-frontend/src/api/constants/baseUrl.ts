function getApiBaseUrl(): string {
    const hostname = window.location.hostname;
    const isLocalHostname = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1";
    const isViteDevServer = window.location.port === "3011";

    if (isLocalHostname || isViteDevServer) {
        const protocol = window.location.protocol === "https:" ? "https:" : "http:";

        return `${protocol}//${hostname}:3002`;
    }

    return "";
}

const API_BASE_URL = getApiBaseUrl();

export default API_BASE_URL;
