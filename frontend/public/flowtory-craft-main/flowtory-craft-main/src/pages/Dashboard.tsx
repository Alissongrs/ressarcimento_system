import { Sidebar } from "@/components/Sidebar";
import { StatCard } from "@/components/StatCard";
import { ProcessCard } from "@/components/ProcessCard";
import { 
  FileText, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  TrendingUp,
  BarChart3
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Mock data - later connect to API
const stats = [
  { title: "Total de Processos", value: "1,247", icon: FileText, trend: { value: "+12%", positive: true } },
  { title: "Aprovados", value: "832", icon: CheckCircle2, variant: "success" as const, trend: { value: "+8%", positive: true } },
  { title: "Em Análise", value: "298", icon: Clock, variant: "warning" as const },
  { title: "Pendentes", value: "117", icon: AlertCircle, variant: "destructive" as const, trend: { value: "-5%", positive: true } },
];

const recentProcesses = [
  { id: "P-001", uc: "3013593026", status: "Em Análise", etapa: "Análise Técnica", dataMovimentacao: "2025-11-06", responsavel: "João Silva", relevancia: true },
  { id: "P-002", uc: "14105119", status: "Aprovado", etapa: "Deferidos", dataMovimentacao: "2025-11-05", responsavel: "Maria Santos" },
  { id: "P-003", uc: "13105155", status: "Pendente", etapa: "Documentação", dataMovimentacao: "2025-11-04", relevancia: true },
  { id: "P-004", uc: "2019483012", status: "Improcedente", etapa: "Indeferidos", dataMovimentacao: "2025-11-03" },
];

const Dashboard = () => {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-7xl mx-auto space-y-8">
          {/* Header */}
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">Dashboard</h1>
            <p className="text-muted-foreground">Visão geral do sistema de processos</p>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {stats.map((stat) => (
              <StatCard key={stat.title} {...stat} />
            ))}
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="p-6 shadow-soft">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Processos por Etapa</h3>
                  <p className="text-sm text-muted-foreground">Distribuição atual</p>
                </div>
                <BarChart3 className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="space-y-4">
                {[
                  { etapa: "Análise Técnica", count: 298, color: "bg-warning" },
                  { etapa: "Deferidos", count: 832, color: "bg-success" },
                  { etapa: "Indeferidos", count: 117, color: "bg-destructive" },
                ].map((item) => (
                  <div key={item.etapa}>
                    <div className="flex items-center justify-between mb-2 text-sm">
                      <span className="text-foreground font-medium">{item.etapa}</span>
                      <span className="text-muted-foreground">{item.count}</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${item.color} transition-smooth`}
                        style={{ width: `${(item.count / 1247) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-6 shadow-soft">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Tendência Mensal</h3>
                  <p className="text-sm text-muted-foreground">Últimos 30 dias</p>
                </div>
                <TrendingUp className="w-5 h-5 text-success" />
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-success/5 border border-success/20">
                  <div>
                    <p className="text-sm text-muted-foreground">Taxa de Aprovação</p>
                    <p className="text-2xl font-bold text-foreground">66.7%</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-success font-medium">+8%</p>
                    <p className="text-xs text-muted-foreground">vs mês anterior</p>
                  </div>
                </div>
                <div className="flex items-center justify-between p-4 rounded-lg bg-primary/5 border border-primary/20">
                  <div>
                    <p className="text-sm text-muted-foreground">Tempo Médio</p>
                    <p className="text-2xl font-bold text-foreground">12.5 dias</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-success font-medium">-2 dias</p>
                    <p className="text-xs text-muted-foreground">melhoria</p>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* Recent Processes */}
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-semibold text-foreground">Processos Recentes</h2>
                <p className="text-sm text-muted-foreground">Últimas movimentações</p>
              </div>
              <Button variant="outline">Ver Todos</Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {recentProcesses.map((process) => (
                <ProcessCard key={process.id} {...process} />
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
