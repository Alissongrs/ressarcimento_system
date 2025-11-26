import { Sidebar } from "@/components/Sidebar";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileText, Paperclip, DollarSign, Calendar, Search, Eye } from "lucide-react";

// Mock data
const requisicoes = [
  {
    id: "REQ-001",
    uc: "3013593026",
    descricao: "Ressarcimento por danos em equipamento devido a oscilação de energia",
    criacao: "2025-10-15T10:00:00",
    periodoIrregularidade: "2025-09-01 a 2025-09-30",
    valor: "R$ 1.250,00",
    status: "Em Análise",
    anexos: 3,
    faturas: 2,
  },
  {
    id: "REQ-002",
    uc: "14105119",
    descricao: "Ressarcimento por interrupção prolongada do fornecimento",
    criacao: "2025-10-10T14:30:00",
    periodoIrregularidade: "2025-08-15 a 2025-08-20",
    valor: "R$ 850,00",
    status: "Aprovado",
    anexos: 5,
    faturas: 1,
  },
  {
    id: "REQ-003",
    uc: "13105155",
    descricao: "Ressarcimento por cobrança indevida na fatura",
    criacao: "2025-10-05T09:15:00",
    periodoIrregularidade: "2025-07-01 a 2025-07-31",
    valor: "R$ 420,50",
    status: "Pendente",
    anexos: 2,
    faturas: 3,
  },
  {
    id: "REQ-004",
    uc: "2019483012",
    descricao: "Ressarcimento por danos em eletrodomésticos",
    criacao: "2025-09-28T16:45:00",
    periodoIrregularidade: "2025-06-10 a 2025-06-15",
    valor: "R$ 2.100,00",
    status: "Indeferido",
    anexos: 4,
    faturas: 1,
  },
];

const statusConfig: Record<string, { variant: any; color: string }> = {
  "Em Análise": { variant: "warning", color: "text-warning" },
  "Aprovado": { variant: "success", color: "text-success" },
  "Pendente": { variant: "secondary", color: "text-muted-foreground" },
  "Indeferido": { variant: "destructive", color: "text-destructive" },
};

const Requisicoes = () => {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">Requisições</h1>
              <p className="text-muted-foreground">Gerenciamento de solicitações de ressarcimento</p>
            </div>
            <Button variant="gradient">
              <FileText className="w-4 h-4" />
              Nova Requisição
            </Button>
          </div>

          {/* Search */}
          <Card className="p-4 shadow-soft">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input 
                placeholder="Buscar por UC, ID ou descrição..." 
                className="pl-10"
              />
            </div>
          </Card>

          {/* Requisições List */}
          <div className="space-y-4">
            {requisicoes.map((req) => {
              const statusStyle = statusConfig[req.status];
              return (
                <Card key={req.id} className="p-6 shadow-soft hover:shadow-medium transition-smooth">
                  <div className="space-y-4">
                    {/* Header */}
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-lg font-semibold text-foreground">{req.id}</h3>
                          <Badge variant="outline">UC {req.uc}</Badge>
                          <Badge variant={statusStyle.variant}>{req.status}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{req.descricao}</p>
                      </div>
                      <div className={`text-right ${statusStyle.color}`}>
                        <p className="text-2xl font-bold">{req.valor}</p>
                      </div>
                    </div>

                    {/* Info Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-border">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Calendar className="w-3.5 h-3.5" />
                          <span>Criação</span>
                        </div>
                        <p className="text-sm font-medium text-foreground">
                          {new Date(req.criacao).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                        </p>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Calendar className="w-3.5 h-3.5" />
                          <span>Período</span>
                        </div>
                        <p className="text-sm font-medium text-foreground">
                          {req.periodoIrregularidade}
                        </p>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Paperclip className="w-3.5 h-3.5" />
                          <span>Anexos</span>
                        </div>
                        <p className="text-sm font-medium text-foreground">
                          {req.anexos} arquivo{req.anexos !== 1 ? 's' : ''}
                        </p>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <FileText className="w-3.5 h-3.5" />
                          <span>Faturas</span>
                        </div>
                        <p className="text-sm font-medium text-foreground">
                          {req.faturas} fatura{req.faturas !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3 pt-2">
                      <Button variant="default" size="sm">
                        <Eye className="w-4 h-4" />
                        Ver Detalhes
                      </Button>
                      <Button variant="outline" size="sm">
                        <FileText className="w-4 h-4" />
                        Anexos
                      </Button>
                      <Button variant="outline" size="sm">
                        <DollarSign className="w-4 h-4" />
                        Faturas
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
};

export default Requisicoes;
