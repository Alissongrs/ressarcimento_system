import { Sidebar } from "@/components/Sidebar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { 
  Settings, 
  User, 
  Bell, 
  Shield, 
  Database,
  Mail
} from "lucide-react";

const Config = () => {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">Configurações</h1>
            <p className="text-muted-foreground">Personalize o sistema de acordo com suas preferências</p>
          </div>

          {/* Profile Settings */}
          <Card className="p-6 shadow-soft">
            <div className="flex items-center gap-3 mb-6">
              <div className="rounded-lg p-2 bg-primary/10">
                <User className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Perfil do Usuário</h3>
                <p className="text-sm text-muted-foreground">Gerencie suas informações pessoais</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="nome">Nome Completo</Label>
                  <Input id="nome" placeholder="Seu nome" defaultValue="Administrador" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" placeholder="seu@email.com" defaultValue="admin@bpm.com" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cargo">Cargo</Label>
                <Input id="cargo" placeholder="Seu cargo" defaultValue="Gerente de Processos" />
              </div>
              <div className="flex justify-end">
                <Button variant="default">Salvar Alterações</Button>
              </div>
            </div>
          </Card>

          {/* Notifications */}
          <Card className="p-6 shadow-soft">
            <div className="flex items-center gap-3 mb-6">
              <div className="rounded-lg p-2 bg-warning/10">
                <Bell className="w-5 h-5 text-warning" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Notificações</h3>
                <p className="text-sm text-muted-foreground">Configure como deseja ser notificado</p>
              </div>
            </div>

            <div className="space-y-4">
              {[
                { id: "email", label: "Notificações por Email", description: "Receba atualizações importantes por email" },
                { id: "processo", label: "Novas Movimentações", description: "Notificar quando um processo for movimentado" },
                { id: "aprovacao", label: "Aprovações Pendentes", description: "Alertas de processos aguardando aprovação" },
                { id: "relatorio", label: "Relatórios Semanais", description: "Resumo semanal de processos e métricas" },
              ].map((item) => (
                <div key={item.id} className="flex items-center justify-between p-4 rounded-lg bg-muted/30">
                  <div className="flex-1">
                    <p className="font-medium text-foreground">{item.label}</p>
                    <p className="text-sm text-muted-foreground">{item.description}</p>
                  </div>
                  <Switch defaultChecked />
                </div>
              ))}
            </div>
          </Card>

          {/* System Settings */}
          <Card className="p-6 shadow-soft">
            <div className="flex items-center gap-3 mb-6">
              <div className="rounded-lg p-2 bg-success/10">
                <Settings className="w-5 h-5 text-success" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Sistema</h3>
                <p className="text-sm text-muted-foreground">Configurações gerais do sistema</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-lg bg-muted/30">
                <div className="flex items-center gap-3">
                  <Database className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-foreground">Backup Automático</p>
                    <p className="text-sm text-muted-foreground">Fazer backup diário dos dados</p>
                  </div>
                </div>
                <Switch defaultChecked />
              </div>

              <div className="flex items-center justify-between p-4 rounded-lg bg-muted/30">
                <div className="flex items-center gap-3">
                  <Shield className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-foreground">Autenticação de Dois Fatores</p>
                    <p className="text-sm text-muted-foreground">Camada extra de segurança</p>
                  </div>
                </div>
                <Switch />
              </div>

              <div className="flex items-center justify-between p-4 rounded-lg bg-muted/30">
                <div className="flex items-center gap-3">
                  <Mail className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-foreground">Servidor SMTP</p>
                    <p className="text-sm text-muted-foreground">Configurar servidor de email</p>
                  </div>
                </div>
                <Button variant="outline" size="sm">Configurar</Button>
              </div>
            </div>
          </Card>

          {/* Danger Zone */}
          <Card className="p-6 shadow-soft border-destructive/20">
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-destructive mb-1">Zona de Perigo</h3>
              <p className="text-sm text-muted-foreground">Ações irreversíveis - use com cuidado</p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 rounded-lg bg-destructive/5 border border-destructive/20">
                <div>
                  <p className="font-medium text-foreground">Limpar Cache do Sistema</p>
                  <p className="text-sm text-muted-foreground">Remove dados temporários e cache</p>
                </div>
                <Button variant="outline" size="sm">Limpar Cache</Button>
              </div>

              <div className="flex items-center justify-between p-4 rounded-lg bg-destructive/5 border border-destructive/20">
                <div>
                  <p className="font-medium text-foreground">Exportar Todos os Dados</p>
                  <p className="text-sm text-muted-foreground">Baixar cópia completa do banco de dados</p>
                </div>
                <Button variant="outline" size="sm">Exportar</Button>
              </div>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Config;
