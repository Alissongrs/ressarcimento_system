import { Sidebar } from "@/components/Sidebar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { 
  BarChart3, 
  TrendingUp, 
  Download, 
  Calendar,
  DollarSign,
  Clock,
  CheckCircle2,
  XCircle
} from "lucide-react";

const Relatorios = () => {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">Relatórios e Análises</h1>
              <p className="text-muted-foreground">Insights e métricas detalhadas do sistema</p>
            </div>
            <Button variant="gradient">
              <Download className="w-4 h-4" />
              Exportar Relatório
            </Button>
          </div>

          {/* Period Selector */}
          <Card className="p-4 shadow-soft">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Calendar className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium text-foreground">Período de Análise:</span>
                <span className="text-muted-foreground">Últimos 30 dias</span>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm">7 dias</Button>
                <Button variant="outline" size="sm">30 dias</Button>
                <Button variant="default" size="sm">90 dias</Button>
                <Button variant="outline" size="sm">Personalizado</Button>
              </div>
            </div>
          </Card>

          {/* Main Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card className="p-6 shadow-soft bg-gradient-to-br from-success/10 to-success/5 border-success/20">
              <div className="flex items-center justify-between mb-4">
                <div className="rounded-lg p-3 bg-success/10">
                  <CheckCircle2 className="w-6 h-6 text-success" />
                </div>
                <TrendingUp className="w-5 h-5 text-success" />
              </div>
              <p className="text-sm text-muted-foreground mb-1">Taxa de Aprovação</p>
              <p className="text-3xl font-bold text-foreground">66.7%</p>
              <p className="text-xs text-success mt-2">+8% vs mês anterior</p>
            </Card>

            <Card className="p-6 shadow-soft bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
              <div className="flex items-center justify-between mb-4">
                <div className="rounded-lg p-3 bg-primary/10">
                  <Clock className="w-6 h-6 text-primary" />
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-1">Tempo Médio</p>
              <p className="text-3xl font-bold text-foreground">12.5 dias</p>
              <p className="text-xs text-success mt-2">-2 dias (melhoria)</p>
            </Card>

            <Card className="p-6 shadow-soft bg-gradient-to-br from-warning/10 to-warning/5 border-warning/20">
              <div className="flex items-center justify-between mb-4">
                <div className="rounded-lg p-3 bg-warning/10">
                  <DollarSign className="w-6 h-6 text-warning" />
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-1">Valor Médio</p>
              <p className="text-3xl font-bold text-foreground">R$ 1.155</p>
              <p className="text-xs text-muted-foreground mt-2">por processo</p>
            </Card>

            <Card className="p-6 shadow-soft bg-gradient-to-br from-destructive/10 to-destructive/5 border-destructive/20">
              <div className="flex items-center justify-between mb-4">
                <div className="rounded-lg p-3 bg-destructive/10">
                  <XCircle className="w-6 h-6 text-destructive" />
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-1">Taxa de Rejeição</p>
              <p className="text-3xl font-bold text-foreground">9.4%</p>
              <p className="text-xs text-success mt-2">-5% (melhoria)</p>
            </Card>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Volume Chart */}
            <Card className="p-6 shadow-soft">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Volume de Processos</h3>
                  <p className="text-sm text-muted-foreground">Tendência mensal</p>
                </div>
                <BarChart3 className="w-5 h-5 text-muted-foreground" />
              </div>
              
              <div className="space-y-4">
                {[
                  { mes: "Agosto", processos: 387, cor: "bg-primary" },
                  { mes: "Setembro", processos: 412, cor: "bg-primary" },
                  { mes: "Outubro", processos: 448, cor: "bg-success" },
                ].map((item) => (
                  <div key={item.mes}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground">{item.mes}</span>
                      <span className="text-sm text-muted-foreground">{item.processos} processos</span>
                    </div>
                    <div className="h-3 bg-secondary rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${item.cor} transition-smooth`}
                        style={{ width: `${(item.processos / 500) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Distribution Chart */}
            <Card className="p-6 shadow-soft">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Distribuição por Status</h3>
                  <p className="text-sm text-muted-foreground">Situação atual</p>
                </div>
              </div>

              <div className="space-y-4">
                {[
                  { status: "Aprovados", count: 832, percent: 66.7, color: "bg-success" },
                  { status: "Em Análise", count: 298, percent: 23.9, color: "bg-warning" },
                  { status: "Indeferidos", count: 117, percent: 9.4, color: "bg-destructive" },
                ].map((item) => (
                  <div key={item.status} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground">{item.status}</span>
                      <div className="text-right">
                        <span className="text-sm font-bold text-foreground">{item.percent}%</span>
                        <span className="text-xs text-muted-foreground ml-2">({item.count})</span>
                      </div>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${item.color} transition-smooth`}
                        style={{ width: `${item.percent}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Top Performers */}
          <Card className="p-6 shadow-soft">
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-foreground mb-1">Top Responsáveis</h3>
              <p className="text-sm text-muted-foreground">Processos finalizados no período</p>
            </div>

            <div className="space-y-3">
              {[
                { nome: "Maria Santos", processos: 87, aprovacao: 94 },
                { nome: "João Silva", processos: 72, aprovacao: 89 },
                { nome: "Ana Costa", processos: 65, aprovacao: 86 },
                { nome: "Carlos Oliveira", processos: 58, aprovacao: 92 },
              ].map((item, index) => (
                <div key={item.nome} className="flex items-center gap-4 p-4 rounded-lg bg-muted/30 hover:bg-muted/50 transition-smooth">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full gradient-primary flex items-center justify-center text-primary-foreground font-bold">
                    {index + 1}
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-foreground">{item.nome}</p>
                    <p className="text-sm text-muted-foreground">{item.processos} processos finalizados</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-success">{item.aprovacao}%</p>
                    <p className="text-xs text-muted-foreground">aprovação</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Relatorios;
