import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  DollarSign,
  UserCheck,
  Target,
  Clock,
  Check,
  X,
  HelpCircle,
  Building2,
  Users,
  Pencil,
  Snowflake,
  Thermometer,
  Flame,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BANTQualification, SalesLead } from "@/types/sales.types";

interface BANTIndicatorProps {
  bant: BANTQualification;
  size?: "sm" | "md" | "lg";
  showLabels?: boolean;
  onUpdate?: (key: keyof BANTQualification, value: boolean | null) => void;
  interactive?: boolean;
}

const bantConfig = {
  budget: {
    label: "Budget",
    description: "Tem orçamento disponível?",
    icon: DollarSign,
    color: "emerald",
  },
  authority: {
    label: "Authority",
    description: "É o decisor ou influenciador?",
    icon: UserCheck,
    color: "blue",
  },
  need: {
    label: "Need",
    description: "Tem necessidade clara do produto?",
    icon: Target,
    color: "purple",
  },
  timeline: {
    label: "Timeline",
    description: "Tem prazo definido para decisão?",
    icon: Clock,
    color: "amber",
  },
};

const sizeClasses = {
  sm: {
    container: "gap-1",
    icon: "h-4 w-4",
    wrapper: "w-6 h-6",
  },
  md: {
    container: "gap-1.5",
    icon: "h-4 w-4",
    wrapper: "w-7 h-7",
  },
  lg: {
    container: "gap-2",
    icon: "h-5 w-5",
    wrapper: "w-8 h-8",
  },
};

function getStatusStyle(value: boolean | null | undefined, color: string) {
  if (value === true) {
    return {
      bg: `bg-${color}-100`,
      border: `border-${color}-300`,
      text: `text-${color}-600`,
      statusIcon: Check,
    };
  }
  if (value === false) {
    return {
      bg: "bg-red-50",
      border: "border-red-200",
      text: "text-red-400",
      statusIcon: X,
    };
  }
  return {
    bg: "bg-muted/50",
    border: "border-muted-foreground/20",
    text: "text-muted-foreground/50",
    statusIcon: HelpCircle,
  };
}

export function BANTIndicator({
  bant,
  size = "md",
  showLabels = false,
  onUpdate,
  interactive = false,
}: BANTIndicatorProps) {
  const sizeClass = sizeClasses[size];

  const handleClick = (key: keyof BANTQualification) => {
    if (!interactive || !onUpdate) return;

    const currentValue = bant[key];
    // Cycle through: null -> true -> false -> null
    let newValue: boolean | null;
    if (currentValue === null || currentValue === undefined) {
      newValue = true;
    } else if (currentValue === true) {
      newValue = false;
    } else {
      newValue = null;
    }
    onUpdate(key, newValue);
  };

  return (
    <TooltipProvider>
      <div className={cn("flex items-center", sizeClass.container)}>
        {(Object.keys(bantConfig) as Array<keyof typeof bantConfig>).map((key) => {
          const config = bantConfig[key];
          const value = bant[key];
          const style = getStatusStyle(value, config.color);
          const Icon = config.icon;

          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => handleClick(key)}
                  disabled={!interactive}
                  className={cn(
                    "rounded-full flex items-center justify-center border transition-all",
                    sizeClass.wrapper,
                    style.bg,
                    style.border,
                    style.text,
                    interactive && "hover:scale-110 cursor-pointer",
                    !interactive && "cursor-default"
                  )}
                >
                  <Icon className={sizeClass.icon} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-center">
                <p className="font-medium">{config.label}</p>
                <p className="text-xs text-muted-foreground">{config.description}</p>
                <p className="text-xs mt-1">
                  Status:{" "}
                  <span className={style.text}>
                    {value === true ? "Sim" : value === false ? "Não" : "Não verificado"}
                  </span>
                </p>
                {interactive && (
                  <p className="text-xs text-muted-foreground mt-1">Clique para alterar</p>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}

        {showLabels && (
          <span className="ml-1 text-xs text-muted-foreground">
            {Object.values(bant).filter(Boolean).length}/4 BANT
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}

// Full BANT card with details
export function BANTCard({
  bant,
  onUpdate,
  className,
}: {
  bant: BANTQualification;
  onUpdate?: (key: keyof BANTQualification, value: boolean | null) => void;
  className?: string;
}) {
  const score = Object.values(bant).filter(Boolean).length;
  const scorePercent = (score / 4) * 100;

  return (
    <div className={cn("rounded-lg border p-4 space-y-4", className)}>
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">Qualificação BANT</h4>
        <span className={cn(
          "text-sm font-bold",
          scorePercent >= 75 ? "text-emerald-600" :
          scorePercent >= 50 ? "text-amber-600" :
          "text-muted-foreground"
        )}>
          {score}/4
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {(Object.keys(bantConfig) as Array<keyof typeof bantConfig>).map((key) => {
          const config = bantConfig[key];
          const value = bant[key];
          const style = getStatusStyle(value, config.color);
          const Icon = config.icon;

          return (
            <button
              key={key}
              onClick={() => {
                if (!onUpdate) return;
                const currentValue = bant[key];
                let newValue: boolean | null;
                if (currentValue === null || currentValue === undefined) {
                  newValue = true;
                } else if (currentValue === true) {
                  newValue = false;
                } else {
                  newValue = null;
                }
                onUpdate(key, newValue);
              }}
              disabled={!onUpdate}
              className={cn(
                "flex items-center gap-2 p-2 rounded-lg border transition-all text-left",
                style.bg,
                style.border,
                onUpdate && "hover:scale-[1.02] cursor-pointer",
                !onUpdate && "cursor-default"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center",
                value === true ? `bg-${config.color}-200` : "bg-muted"
              )}>
                <Icon className={cn("h-4 w-4", style.text)} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{config.label}</p>
                <p className={cn("text-xs", style.text)}>
                  {value === true ? "Confirmado" : value === false ? "Negativo" : "Pendente"}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full transition-all duration-300 rounded-full",
            scorePercent >= 75 ? "bg-emerald-500" :
            scorePercent >= 50 ? "bg-amber-500" :
            scorePercent >= 25 ? "bg-blue-500" :
            "bg-slate-400"
          )}
          style={{ width: `${scorePercent}%` }}
        />
      </div>
    </div>
  );
}

// =====================================================
// QUALIFICATION CARD — Temperatura do lead (frio / morno / quente)
// =====================================================

export type LeadTemperature = 'frio' | 'morno' | 'quente';

const temperatureOptions: Array<{
  value: LeadTemperature;
  label: string;
  description: string;
  icon: typeof Building2;
  activeClass: string;
  iconClass: string;
}> = [
  {
    value: 'frio',
    label: 'Frio',
    description: 'Pouco interesse ou sem urgência. Precisa de nutrição.',
    icon: Snowflake,
    activeClass: 'border-blue-400 bg-blue-50',
    iconClass: 'text-blue-500',
  },
  {
    value: 'morno',
    label: 'Morno',
    description: 'Interesse moderado, ainda avaliando.',
    icon: Thermometer,
    activeClass: 'border-amber-400 bg-amber-50',
    iconClass: 'text-amber-500',
  },
  {
    value: 'quente',
    label: 'Quente',
    description: 'Alto interesse, pronto para fechar.',
    icon: Flame,
    activeClass: 'border-red-400 bg-red-50',
    iconClass: 'text-red-500',
  },
];

export function QualificationCard({
  temperature,
  onChange,
  className,
}: {
  temperature?: string | null;
  onChange: (value: LeadTemperature) => void;
  className?: string;
}) {
  const current = (temperature ?? '').toLowerCase();
  const selected = temperatureOptions.find((o) => o.value === current);

  return (
    <div className={cn("rounded-lg border p-4 space-y-3", className)}>
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">Qualificação do lead</h4>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {temperatureOptions.map((opt) => {
          const Icon = opt.icon;
          const active = current === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              title={opt.description}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-all",
                active
                  ? opt.activeClass
                  : "border-muted-foreground/15 bg-muted/20 hover:bg-muted/40"
              )}
            >
              <Icon
                className={cn(
                  "h-5 w-5",
                  active ? opt.iconClass : "text-muted-foreground/50"
                )}
              />
              <span
                className={cn(
                  "text-xs font-medium",
                  active ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {opt.label}
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {selected ? selected.description : "Classifique o interesse do lead."}
      </p>
    </div>
  );
}
