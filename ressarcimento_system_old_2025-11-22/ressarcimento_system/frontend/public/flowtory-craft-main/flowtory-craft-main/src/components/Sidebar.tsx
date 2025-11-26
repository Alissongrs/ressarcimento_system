import { LayoutDashboard, Workflow, History, Settings, FileText, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { NavLink } from "./NavLink";

const menuItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/" },
  { icon: Workflow, label: "Processos", path: "/processos" },
  { icon: History, label: "Histórico", path: "/historico" },
  { icon: BarChart3, label: "Relatórios", path: "/relatorios" },
  { icon: FileText, label: "Requisições", path: "/requisicoes" },
  { icon: Settings, label: "Configurações", path: "/config" },
];

export const Sidebar = () => {
  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg gradient-primary flex items-center justify-center">
            <Workflow className="w-6 h-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-sidebar-foreground">SURE</h1>
            <p className="text-xs text-sidebar-foreground/60">Gestão de Processos</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {menuItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className="flex items-center gap-3 px-4 py-3 rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-smooth"
            activeClassName="bg-sidebar-accent text-sidebar-foreground font-medium"
          >
            <item.icon className="w-5 h-5" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="p-4 border-t border-sidebar-border">
        <div className="p-3 rounded-lg bg-sidebar-accent/50">
          <p className="text-xs font-medium text-sidebar-foreground">Sistema de Ressarcimento</p>
          <p className="text-xs text-sidebar-foreground/60 mt-1">v1.0.0</p>
        </div>
      </div>
    </aside>
  );
};
