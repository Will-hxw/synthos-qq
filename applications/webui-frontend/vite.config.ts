import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), tsconfigPaths(), tailwindcss()],
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    const normalizedId = id.split("\\").join("/");

                    if (!normalizedId.includes("node_modules")) {
                        return undefined;
                    }

                    if (normalizedId.includes("monaco-editor") || normalizedId.includes("@monaco-editor")) {
                        return "vendor-monaco";
                    }

                    if (normalizedId.includes("zrender")) {
                        return "vendor-zrender";
                    }

                    if (normalizedId.includes("echarts")) {
                        return "vendor-charts";
                    }

                    if (
                        normalizedId.includes("react-markdown") ||
                        normalizedId.includes("remark-gfm") ||
                        normalizedId.includes("micromark") ||
                        normalizedId.includes("mdast-util") ||
                        normalizedId.includes("hast-util") ||
                        normalizedId.includes("unified")
                    ) {
                        return "vendor-markdown";
                    }

                    if (normalizedId.includes("framer-motion")) {
                        return "vendor-motion";
                    }

                    if (normalizedId.includes("/node_modules/@heroui/")) {
                        const packageName = normalizedId.split("/node_modules/@heroui/")[1].split("/")[0].split("-").join("_");

                        if (packageName === "react") {
                            return undefined;
                        }

                        return `vendor-heroui-${packageName}`;
                    }

                    if (normalizedId.includes("/node_modules/@react-aria/")) {
                        return "vendor-react-aria";
                    }

                    if (normalizedId.includes("/node_modules/@react-stately/")) {
                        return "vendor-react-stately";
                    }

                    if (normalizedId.includes("react") || normalizedId.includes("react-dom") || normalizedId.includes("react-router-dom")) {
                        return "vendor-react";
                    }

                    return undefined;
                }
            }
        }
    },
    server: {
        host: "127.0.0.1", // 强制使用 IPv4，避免 IPv6 权限问题
        port: 3011, // 避开 Windows Hyper-V 保留端口范围
        allowedHosts: ["intimiste-patriotically-addyson.ngrok-free.dev"],
        proxy: {
            // SSE 长连接：禁用超时，避免首 token 慢或长时间无事件导致 504
            "/api/agent/ask/stream": {
                target: "http://localhost:3002",
                changeOrigin: true,
                secure: false,
                timeout: 0,
                proxyTimeout: 0
            },
            "/api": {
                target: "http://localhost:3002",
                changeOrigin: true,
                secure: false // 忽略 HTTPS 证书验证（开发用）
            },
            "/health": {
                target: "http://localhost:3002",
                changeOrigin: true,
                secure: false // 忽略 HTTPS 证书验证（开发用）
            },
            // tRPC WebSocket (subscriptions)
            "/trpc": {
                target: "http://localhost:3002",
                ws: true,
                changeOrigin: true,
                secure: false
            }
        }
    }
});
