import { Sidebar } from "@/components/Sidebar";
import { ProcessCard } from "@/components/ProcessCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Filter, Plus } from "lucide-react";

// Mock data
const etapas = [
  { nome: "Documentação", count: 45, color: "border-muted" },
  { nome: "Análise Técnica", count: 298, color: "border-warning" },
  { nome: "Deferidos", count: 832, color: "border-success" },
  { nome: "Indeferidos", count: 117, color: "border-destructive" },
];

const processosPorEtapa: Record<string, any[]> = {
  "Documentação": [
    { id: "P-010", uc: "3014523987", status: "Pendente", etapa: "Documentação", dataMovimentacao: "2025-11-06", relevancia: true },
    { id: "P-011", uc: "3015612034", status: "Pendente", etapa: "Documentação", dataMovimentacao: "2025-11-05" },
  ],
  "Análise Técnica": [
    { id: "P-001", uc: "3013593026", status: "Em Análise", etapa: "Análise Técnica", dataMovimentacao: "2025-11-06", responsavel: "João Silva", relevancia: true },
    { id: "P-005", uc: "3014782901", status: "Em Análise", etapa: "Análise Técnica", dataMovimentacao: "2025-11-05", responsavel: "Ana Costa" },
  ],
  "Deferidos": [
    { id: "P-002", uc: "14105119", status: "Aprovado", etapa: "Deferidos", dataMovimentacao: "2025-11-05", responsavel: "Maria Santos" },
    { id: "P-006", uc: "13206178", status: "Aprovado", etapa: "Deferidos", dataMovimentacao: "2025-11-04" },
  ],
  "Indeferidos": [
    { id: "P-004", uc: "2019483012", status: "Improcedente", etapa: "Indeferidos", dataMovimentacao: "2025-11-03" },
  ],
};

const Processos = () => {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-[1600px] mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">Processos</h1>
              <p className="text-muted-foreground">Gestão visual por etapas (Kanban)</p>
            </div>
            <div className="flex gap-3">
              <Button variant="outline">
                <Filter className="w-4 h-4" />
                Filtros
              </Button>
              <Button variant="gradient">
                <Plus className="w-4 h-4" />
                Novo Processo
              </Button>
            </div>
          </div>

          {/* Search Bar */}
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input 
                placeholder="Buscar por UC, ID ou responsável..." 
                className="pl-10"
              />
            </div>
          </div>

          {/* Kanban Board */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {etapas.map((etapa) => (
              <div key={etapa.nome} className={`rounded-xl border-2 ${etapa.color} bg-card/50 p-4 space-y-4`}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-foreground">{etapa.nome}</h3>
                    <Badge variant="secondary" className="mt-1">
                      {etapa.count} processos
                    </Badge>
                  </div>
                </div>

                <div className="space-y-3 max-h-[calc(100vh-300px)] overflow-y-auto pr-2 custom-scrollbar">
                  {processosPorEtapa[etapa.nome]?.map((processo) => (
                    <ProcessCard key={processo.id} {...processo} />
                  ))}
                  
                  {(!processosPorEtapa[etapa.nome] || processosPorEtapa[etapa.nome].length === 0) && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      Nenhum processo nesta etapa
                    </div>
                  )}
                </div>

                <Button variant="ghost" className="w-full" size="sm">
                  <Plus className="w-4 h-4" />
                  Adicionar Processo
                </Button>
              </div>
            ))}
          </div>
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: hsl(var(--muted));
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: hsl(var(--muted-foreground) / 0.3);
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: hsl(var(--muted-foreground) / 0.5);
        }
      `}</style>
    </div>
  );
};

export default Processos;
