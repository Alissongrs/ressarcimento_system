import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: {
    value: string;
    positive: boolean;
  };
  variant?: "default" | "success" | "warning" | "destructive";
}

export const StatCard = ({ title, value, icon: Icon, trend, variant = "default" }: StatCardProps) => {
  const variantStyles = {
    default: "from-primary/10 to-primary/5 border-primary/20",
    success: "from-success/10 to-success/5 border-success/20",
    warning: "from-warning/10 to-warning/5 border-warning/20",
    destructive: "from-destructive/10 to-destructive/5 border-destructive/20",
  };

  const iconVariants = {
    default: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  };

  return (
    <div className={cn(
      "relative overflow-hidden rounded-xl border bg-gradient-to-br p-6 shadow-soft transition-smooth hover:shadow-medium",
      variantStyles[variant]
    )}>
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="text-3xl font-bold text-foreground">{value}</p>
          {trend && (
            <p className={cn(
              "text-xs font-medium flex items-center gap-1",
              trend.positive ? "text-success" : "text-destructive"
            )}>
              <span>{trend.positive ? "↑" : "↓"}</span>
              <span>{trend.value}</span>
            </p>
          )}
        </div>
        <div className={cn(
          "rounded-lg p-3",
          iconVariants[variant]
        )}>
          <Icon className="w-6 h-6" />
        </div>
      </div>
    </div>
  );
};
