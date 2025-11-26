import { Calendar, User, Building2, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ProcessCardProps {
  id: string;
  uc: string;
  status: string;
  etapa: string;
  dataMovimentacao: string;
  responsavel?: string;
  relevancia?: boolean;
}

const statusColors: Record<string, string> = {
  "Em Análise": "bg-warning/10 text-warning border-warning/20",
  "Aprovado": "bg-success/10 text-success border-success/20",
  "Improcedente": "bg-destructive/10 text-destructive border-destructive/20",
  "Pendente": "bg-muted text-muted-foreground border-border",
};

export const ProcessCard = ({ id, uc, status, etapa, dataMovimentacao, responsavel, relevancia }: ProcessCardProps) => {
  return (
    <div className="group bg-card rounded-lg border border-border p-4 shadow-soft hover:shadow-medium transition-smooth cursor-pointer">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-foreground">UC {uc}</h3>
            {relevancia && (
              <Badge variant="outline" className="text-xs">
                Relevante
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">ID: {id}</p>
        </div>
        <Badge className={cn("text-xs", statusColors[status] || statusColors["Pendente"])}>
          {status}
        </Badge>
      </div>

      <div className="space-y-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Building2 className="w-3.5 h-3.5" />
          <span className="font-medium">{etapa}</span>
        </div>
        <div className="flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" />
          <span>{new Date(dataMovimentacao).toLocaleDateString('pt-BR')}</span>
        </div>
        {responsavel && (
          <div className="flex items-center gap-2">
            <User className="w-3.5 h-3.5" />
            <span>{responsavel}</span>
          </div>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-border flex gap-2">
        <Button size="sm" variant="ghost" className="flex-1 text-xs">
          Ver Detalhes
        </Button>
        <Button size="sm" variant="outline" className="flex-1 text-xs">
          Movimentar
        </Button>
      </div>
    </div>
  );
};
