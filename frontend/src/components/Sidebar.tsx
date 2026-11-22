
import { NavLink } from "react-router-dom";
import {
    LayoutDashboard,
    Zap,
    Workflow,
    History,
    Settings,
    Activity,
} from "lucide-react";

import "./Sidebar.css";

const menus = [
    { path: "/dashboard", label: "대시보드", icon: LayoutDashboard },
    { path: "/single", label: "단일 API 테스트", icon: Zap },
    { path: "/scenario", label: "시나리오 테스트", icon: Workflow },
    { path: "/history", label: "테스트 이력", icon: History },
    { path: "/settings", label: "설정", icon: Settings },
];

export default function Sidebar() {
    return (
        <aside className="sidebar">
            <div className="sidebar-brand">
                <Activity size={22} />
                <span>API Performance</span>
            </div>

            <nav className="sidebar-nav">
                {menus.map(({ path, label, icon: Icon }) => (
                    <NavLink
                        key={path}
                        to={path}
                        className={({ isActive }) =>
                            `sidebar-link ${isActive ? "active" : ""}`
                        }
                    >
                        <Icon size={18} />
                        <span>{label}</span>
                    </NavLink>
                ))}
            </nav>
        </aside>
    );
}
