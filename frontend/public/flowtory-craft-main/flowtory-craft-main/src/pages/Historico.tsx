import { Sidebar } from "@/components/Sidebar";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock, User, ArrowRight, Search, Calendar } from "lucide-react";

// Mock data
const historico = [
  {
    id: "H-001",
    processo: "P-001",
    uc: "3013593026",
    de: "Documentação",
    para: "Análise Técnica",
    responsavel: "João Silva",
    data: "2025-11-06T14:30:00",
    observacao: "Documentação completa, enviado para análise técnica",
  },
  {
    id: "H-002",
    processo: "P-002",
    uc: "14105119",
    de: "Análise Técnica",
    para: "Deferidos",
    responsavel: "Maria Santos",
    data: "2025-11-05T16:45:00",
    observacao: "Processo aprovado após análise técnica",
  },
  {
    id: "H-003",
    processo: "P-003",
    uc: "13105155",
    de: "Análise Técnica",
    para: "Documentação",
    responsavel: "Ana Costa",
    data: "2025-11-04T09:15:00",
    observacao: "Documentação adicional necessária",
  },
  {
    id: "H-004",
    processo: "P-004",
    uc: "2019483012",
    de: "Análise Técnica",
    para: "Indeferidos",
    responsavel: "Carlos Oliveira",
    data: "2025-11-03T11:20:00",
    observacao: "Processo indeferido por falta de evidências",
  },
];

const Historico = () => {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">Histórico de Movimentações</h1>
            <p className="text-muted-foreground">Rastreamento completo de todas as movimentações de processos</p>
          </div>

          {/* Filters */}
          <Card className="p-4 shadow-soft">
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input 
                  placeholder="Buscar por UC, processo ou responsável..." 
                  className="pl-10"
                />
              </div>
              <Button variant="outline">
                <Calendar className="w-4 h-4" />
                Filtrar por Data
              </Button>
            </div>
          </Card>

          {/* Timeline */}
          <div className="space-y-4">
            {historico.map((item, index) => (
              <Card key={item.id} className="p-6 shadow-soft hover:shadow-medium transition-smooth">
                <div className="flex gap-6">
                  {/* Timeline indicator */}
                  <div className="flex flex-col items-center">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <Clock className="w-5 h-5 text-primary" />
                    </div>
                    {index < historico.length - 1 && (
                      <div className="w-px h-full bg-border mt-2" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="font-semibold text-foreground">UC {item.uc}</h3>
                          <Badge variant="outline">{item.processo}</Badge>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <User className="w-4 h-4" />
                          <span>{item.responsavel}</span>
                          <span>•</span>
                          <span>{new Date(item.data).toLocaleString('pt-BR', { 
                            timeZone: 'America/Sao_Paulo',
                            dateStyle: 'short',
                            timeStyle: 'short'
                          })}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 py-3 px-4 bg-muted/50 rounded-lg">
                      <Badge variant="secondary">{item.de}</Badge>
                      <ArrowRight className="w-4 h-4 text-muted-foreground" />
                      <Badge variant="success">{item.para}</Badge>
                    </div>

                    {item.observacao && (
                      <p className="text-sm text-muted-foreground border-l-2 border-primary/20 pl-4">
                        {item.observacao}
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Load More */}
          <div className="flex justify-center pt-4">
            <Button variant="outline">Carregar Mais</Button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Historico;
