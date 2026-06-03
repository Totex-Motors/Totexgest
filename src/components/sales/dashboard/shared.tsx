import { useState, useMemo, useCallback } from 'react';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

// ==================== FORMAT HELPERS ====================

export function formatCurrency(value: number): string {
  if (value >= 1000000) return `R$ ${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `R$ ${(value / 1000).toFixed(1)}k`;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(value);
}

export function formatCurrencyFull(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 }).format(value);
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

// ==================== DATE PRESET LABELS ====================

import type { DatePreset } from '@/hooks/useSalesDashboardV2';

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Hoje' },
  { value: 'this_week', label: 'Essa semana' },
  { value: 'this_month', label: 'Este mês' },
  { value: 'last_month', label: 'Mês passado' },
];

// ==================== SESSION STATE HOOK ====================

export function useSessionState<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch (_e) {
      return defaultValue;
    }
  });
  const setPersistedState = useCallback((value: T | ((prev: T) => T)) => {
    setState(prev => {
      const next = typeof value === 'function' ? (value as (prev: T) => T)(prev) : value;
      try { sessionStorage.setItem(key, JSON.stringify(next)); } catch (_e) {}
      return next;
    });
  }, [key]);
  return [state, setPersistedState];
}

// ==================== DEMO MODE ====================

const DEMO_MULTIPLIER = 5;

/** Hook that returns the current demo multiplier (1 = off, 5 = demo) */
export function useDemoMultiplier(): number {
  const { isDemoMode } = useDemoMode();
  return isDemoMode ? DEMO_MULTIPLIER : 1;
}

/** Apply demo multiplier to a numeric value (rounds to integer for counts) */
export function dv(value: number, multiplier: number): number {
  if (multiplier === 1) return value;
  return Math.round(value * multiplier);
}

// ==================== SPARKLINE COMPONENT ====================

export function Sparkline({ data, color = '#22c55e', height = 32, width = 80 }: { data: number[]; color?: string; height?: number; width?: number }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={width} height={height} className="opacity-60">
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

// ==================== KPI CARD COMPONENT ====================

export interface KPICardProps {
  title: string;
  value: string;
  subtitle?: string;
  change?: number;
  icon: React.ReactNode;
  gradient: string;
  sparkline?: number[];
  progress?: number;
  onClick?: () => void;
}

export function KPICard({ title, value, subtitle, change, icon, gradient, sparkline, progress, onClick }: KPICardProps) {
  return (
    <Card className={cn('relative overflow-hidden border-0 shadow-lg', onClick && 'cursor-pointer hover:shadow-xl transition-shadow', gradient)} onClick={onClick}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-white/70">{title}</p>
            <p className="text-2xl font-bold text-white tracking-tight">{value}</p>
            {subtitle && <p className="text-xs text-white/60">{subtitle}</p>}
            {change !== undefined && change !== 0 && (
              <div className={cn('flex items-center gap-1 text-xs font-medium', change > 0 ? 'text-emerald-200' : 'text-red-200')}>
                {change > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {Math.abs(Math.round(change))}% vs anterior
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="rounded-xl bg-white/15 p-2.5">{icon}</div>
            {sparkline && <Sparkline data={sparkline} color="rgba(255,255,255,0.6)" />}
          </div>
        </div>
        {progress !== undefined && (
          <div className="mt-3">
            <div className="h-2 rounded-full bg-white/20 overflow-hidden">
              <div className="h-full rounded-full bg-white/60 transition-all duration-700" style={{ width: `${Math.min(100, progress)}%` }} />
            </div>
            <p className="text-[10px] text-white/50 mt-1">{formatPercent(progress)} da meta</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ==================== HORIZONTAL FUNNEL COMPONENT ====================

export function HorizontalFunnel({ stages, isLoading }: { stages: any[] | undefined; isLoading: boolean }) {
  const maxCount = useMemo(() => {
    if (!stages) return 1;
    return Math.max(...stages.map((s: any) => s.count), 1);
  }, [stages]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-7 rounded" style={{ width: `${100 - i * 15}%` }} />
        ))}
      </div>
    );
  }

  if (!stages || stages.length === 0) {
    return <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">Nenhum deal no pipeline</div>;
  }

  return (
    <div className="space-y-1.5">
      {stages.map((stage: any, idx: number) => {
        const widthPercent = maxCount > 0 ? Math.max(8, (stage.count / maxCount) * 100) : 8;
        const bgColor = stage.isWon ? '#22c55e' : stage.isLost ? '#ef4444' : (stage.color || '#6366f1');

        return (
          <div key={stage.stageId || idx} className="group">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[11px] font-medium text-foreground/80 truncate min-w-0 flex-1">
                {stage.name}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs font-bold text-foreground tabular-nums">{stage.count}</span>
                {idx > 0 && (
                  <span className={cn(
                    'text-[10px] font-semibold tabular-nums w-8 text-right',
                    stage.conversionFromPrev >= 50 ? 'text-emerald-500' :
                    stage.conversionFromPrev >= 25 ? 'text-amber-500' : 'text-red-500'
                  )}>
                    {stage.conversionFromPrev}%
                  </span>
                )}
                {idx === 0 && <span className="w-8" />}
                <span className="text-[10px] text-muted-foreground/60 tabular-nums w-16 text-right">
                  {formatCurrency(stage.value)}
                </span>
              </div>
            </div>
            <div className="relative h-5 w-full overflow-hidden rounded bg-muted/50">
              <div
                className="h-full rounded transition-all duration-500 group-hover:brightness-110"
                style={{ width: `${widthPercent}%`, backgroundColor: bgColor, opacity: 0.85 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== ACTIVITY PROGRESS BAR ====================

export function ActivityProgressBar({
  label,
  current,
  target,
  icon,
}: {
  label: string;
  current: number;
  target: number;
  icon: React.ReactNode;
}) {
  const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-xs font-medium">{label}</span>
        </div>
        <span className="text-xs font-bold">
          {current}/{target}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-700', color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ==================== TRAFFIC LIGHT BADGE ====================

export function TrafficLightBadge({ percent }: { percent: number }) {
  const color = percent >= 80
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
    : percent >= 50
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
    : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';

  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold', color)}>
      {formatPercent(percent)}
    </span>
  );
}
