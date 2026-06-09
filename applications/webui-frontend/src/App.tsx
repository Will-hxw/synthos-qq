import { lazy, Suspense } from "react";

import { Spinner } from "@heroui/react";
import { Navigate, Route, Routes } from "react-router-dom";

const LatestTopicsPage = lazy(() => import("./pages/latest-topics/latest-topics"));
const ReportsPage = lazy(() => import("./pages/reports/reports"));
const AIDigestPage = lazy(() => import("@/pages/ai-digest"));
const GroupsPage = lazy(() => import("@/pages/groups"));
const AiChatPage = lazy(() => import("@/pages/ai-chat/ai-chat"));
const ConfigPage = lazy(() => import("@/pages/config-panel/config"));
const DigestDiagnosisPage = lazy(() => import("@/pages/digest-diagnosis/digest-diagnosis"));
const MediaDiagnosisPage = lazy(() => import("@/pages/media-diagnosis/media-diagnosis"));

function PageFallback() {
    return (
        <div className="min-h-screen flex items-center justify-center bg-background">
            <Spinner label="加载中" size="sm" />
        </div>
    );
}

function App() {
    return (
        <Suspense fallback={<PageFallback />}>
            <Routes>
                <Route element={<Navigate replace to="/latest-topics" />} path="/" />
                <Route element={<Navigate replace to="/latest-topics" />} path="/chat-messages" />
                <Route element={<AIDigestPage />} path="/ai-digest" />
                <Route element={<GroupsPage />} path="/groups" />
                <Route element={<LatestTopicsPage />} path="/latest-topics" />
                <Route element={<DigestDiagnosisPage />} path="/digest-diagnosis" />
                <Route element={<MediaDiagnosisPage />} path="/media-diagnosis" />
                <Route element={<ReportsPage />} path="/reports" />
                <Route element={<AiChatPage />} path="/ai-chat" />
                <Route element={<Navigate replace to="/ai-chat" />} path="/rag" />
                <Route element={<ConfigPage />} path="/config" />
                <Route element={<Navigate replace to="/latest-topics" />} path="/system-monitor" />
                <Route element={<Navigate replace to="/latest-topics" />} path="/system-monitor/logs" />
            </Routes>
        </Suspense>
    );
}

export default App;
