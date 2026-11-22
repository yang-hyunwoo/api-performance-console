import { createBrowserRouter, Navigate } from "react-router-dom";

import MainLayout from "../layouts/MainLayout";
import SingleApiTestPage from "../pages/SingleApiTestPage";
import ScenarioTestPage from "../pages/ScenarioTestPage";
import TestHistoryPage from "../pages/TestHistoryPage";
// import DashboardPage from "../pages/DashboardPage";
// import SettingsPage from "../pages/SettingsPage";

export const router = createBrowserRouter([
    {
        path: "/",
        element: <MainLayout />,
        children: [
            {
                index: true,
                element: <Navigate to="/single" replace />,
            },
            {
                path: "single",
                element: <SingleApiTestPage />,
            },
            {
                path: "scenario",
                element: <ScenarioTestPage />,
            },
            // {
            //     path: "dashboard",
            //     element: <DashboardPage />,
            // },
            {
                path: "history",
                element: <TestHistoryPage />,
            },
            // {
            //     path: "settings",
            //     element: <SettingsPage />,
            // },
            {
                path: "*",
                element: <Navigate to="/single" replace />,
            },
        ],
    },
]);