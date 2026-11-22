import { Outlet } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import { RequestSettingsProvider } from "../components/api/RequestHeadersEditor";
import "./MainLayout.css";

export default function MainLayout() {
    return (
        <div className="app-layout">
            <Sidebar />

            <main className="app-content">
                <RequestSettingsProvider>
                    <Outlet />
                </RequestSettingsProvider>
            </main>
        </div>
    );
}