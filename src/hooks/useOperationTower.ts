import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

// Torre de Controle da operação de leads:
// - Entradas das últimas 24h (leads novos + reconversões) via lead_conversions
// - SLA de primeiro contato: procura o primeiro sinal de SAÍDA depois da entrada
//   (WhatsApp enviado pelo time, ligação, atividade concluída)
// - Follow-ups vencidos (company_activities pendentes com scheduled_at no passado)

export interface TowerEntry {
  conversion_id: string;
  lead_id: string;
  lead_name: string;
  lead_phone: string | null;
  conversion_type: 'new' | 'reconversion';
  source: string | null;
  utm_campaign: string | null;
  created_at: string;
  sales_rep_id: string | null;
  sales_rep_name: string | null;
  note_subject: string | null;
  attended: boolean;
  first_contact_at: string | null;
  minutes_to_contact: number | null;
  minutes_waiting: number;
}

export interface OverdueFollowup {
  id: string;
  name: string;
  lead_id: string | null;
  lead_name: string | null;
  scheduled_at: string;
  hours_overdue: number;
  responsavel_id: string | null;
  responsavel_name: string | null;
  priority: string | null;
}

export interface TowerData {
  entries: TowerEntry[];
  unattended: TowerEntry[];
  overdueFollowups: OverdueFollowup[];
  overdueByRep: { rep_id: string | null; rep_name: string; count: number; oldest_hours: number }[];
  stats: {
    entries24h: number;
    newCount: number;
    reconversionCount: number;
    unattendedCount: number;
    slaPct15min: number | null; // % dos atendidos em até 15min
    avgMinutesToContact: number | null;
    overdueCount: number;
  };
}

export function useOperationTower() {
  return useQuery({
    queryKey: ['operation-tower'],
    queryFn: async (): Promise<TowerData> => {
      const now = new Date();
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

      // 1. Entradas das últimas 24h
      const { data: conversions, error: convError } = await supabase
        .from('lead_conversions')
        .select(`
          id, lead_id, conversion_type, source, utm_campaign, created_at, sales_rep_id,
          lead:leads(id, name, phone),
          sales_rep:team_members(id, name)
        `)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(300);
      if (convError) throw convError;

      const rows = (conversions || []) as any[];
      const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];

      // 2. Sinais de atendimento (saída) + notas de tratativa, em paralelo
      const [wppRes, callsRes, actsRes, notesRes] = leadIds.length
        ? await Promise.all([
            supabase
              .from('whatsapp_messages')
              .select('lead_id, sent_at')
              .in('lead_id', leadIds)
              .eq('is_from_me', true)
              .gte('sent_at', since)
              .order('sent_at', { ascending: true })
              .limit(1000),
            supabase
              .from('call_history')
              .select('lead_id, started_at')
              .in('lead_id', leadIds)
              .gte('started_at', since)
              .order('started_at', { ascending: true })
              .limit(500),
            supabase
              .from('company_activities')
              .select('lead_id, updated_at, created_at, task_type, completed, metadata')
              .in('lead_id', leadIds)
              .eq('completed', true)
              .gte('created_at', since)
              .limit(500),
            supabase
              .from('company_activities')
              .select('lead_id, name, created_at, metadata')
              .in('lead_id', leadIds)
              .eq('task_type', 'note')
              .gte('created_at', since)
              .order('created_at', { ascending: false })
              .limit(500),
          ])
        : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

      // Sinais de contato por lead (timestamps ordenados)
      const contactSignals = new Map<string, string[]>();
      const pushSignal = (leadId: string | null, ts: string | null) => {
        if (!leadId || !ts) return;
        const arr = contactSignals.get(leadId) || [];
        arr.push(ts);
        contactSignals.set(leadId, arr);
      };
      for (const m of (wppRes.data || []) as any[]) pushSignal(m.lead_id, m.sent_at);
      for (const c of (callsRes.data || []) as any[]) pushSignal(c.lead_id, c.started_at);
      for (const a of (actsRes.data || []) as any[]) {
        // Atividade concluída por humano conta como contato (ignora automações)
        const src = a.metadata?.source;
        if (src === 'focus_auto' || src === 'receive-lead' || src === 'franchise_distribution') continue;
        pushSignal(a.lead_id, a.updated_at || a.created_at);
      }
      for (const arr of contactSignals.values()) arr.sort();

      // Última nota de tratativa (inbound_note) por lead
      const noteSubjectByLead = new Map<string, string>();
      for (const n of (notesRes.data || []) as any[]) {
        if (n.metadata?.inbound_note && n.lead_id && !noteSubjectByLead.has(n.lead_id)) {
          noteSubjectByLead.set(n.lead_id, n.name);
        }
      }

      const entries: TowerEntry[] = rows.map((r) => {
        const entryTime = new Date(r.created_at).getTime();
        const signals = contactSignals.get(r.lead_id) || [];
        const first = signals.find((ts) => new Date(ts).getTime() > entryTime) || null;
        const minutesToContact = first
          ? Math.round((new Date(first).getTime() - entryTime) / 60000)
          : null;
        return {
          conversion_id: r.id,
          lead_id: r.lead_id,
          lead_name: r.lead?.name || 'Lead',
          lead_phone: r.lead?.phone || null,
          conversion_type: r.conversion_type === 'reconversion' ? 'reconversion' : 'new',
          source: r.source,
          utm_campaign: r.utm_campaign,
          created_at: r.created_at,
          sales_rep_id: r.sales_rep_id,
          sales_rep_name: r.sales_rep?.name || null,
          note_subject: noteSubjectByLead.get(r.lead_id) || null,
          attended: !!first,
          first_contact_at: first,
          minutes_to_contact: minutesToContact,
          minutes_waiting: Math.round((now.getTime() - entryTime) / 60000),
        };
      });

      const unattended = entries
        .filter((e) => !e.attended)
        .sort((a, b) => b.minutes_waiting - a.minutes_waiting);

      // 3. Follow-ups vencidos (pendentes, agendados pro passado)
      const { data: overdue } = await supabase
        .from('company_activities')
        .select('id, name, lead_id, scheduled_at, priority, responsavel_id, lead:leads(name), responsavel:team_members!company_activities_responsavel_id_fkey(name)')
        .eq('completed', false)
        .lt('scheduled_at', now.toISOString())
        .not('scheduled_at', 'is', null)
        .order('scheduled_at', { ascending: true })
        .limit(200);

      const overdueFollowups: OverdueFollowup[] = ((overdue || []) as any[]).map((o) => ({
        id: o.id,
        name: o.name,
        lead_id: o.lead_id,
        lead_name: o.lead?.name || null,
        scheduled_at: o.scheduled_at,
        hours_overdue: Math.round((now.getTime() - new Date(o.scheduled_at).getTime()) / 3600000),
        responsavel_id: o.responsavel_id,
        responsavel_name: o.responsavel?.name || null,
        priority: o.priority,
      }));

      const byRepMap = new Map<string, { rep_id: string | null; rep_name: string; count: number; oldest_hours: number }>();
      for (const f of overdueFollowups) {
        const key = f.responsavel_id || '__sem__';
        const cur = byRepMap.get(key) || {
          rep_id: f.responsavel_id,
          rep_name: f.responsavel_name || 'Sem responsável',
          count: 0,
          oldest_hours: 0,
        };
        cur.count++;
        cur.oldest_hours = Math.max(cur.oldest_hours, f.hours_overdue);
        byRepMap.set(key, cur);
      }
      const overdueByRep = [...byRepMap.values()].sort((a, b) => b.count - a.count);

      const attended = entries.filter((e) => e.attended);
      const within15 = attended.filter((e) => (e.minutes_to_contact ?? Infinity) <= 15);

      return {
        entries,
        unattended,
        overdueFollowups,
        overdueByRep,
        stats: {
          entries24h: entries.length,
          newCount: entries.filter((e) => e.conversion_type === 'new').length,
          reconversionCount: entries.filter((e) => e.conversion_type === 'reconversion').length,
          unattendedCount: unattended.length,
          slaPct15min: attended.length > 0 ? Math.round((within15.length / attended.length) * 100) : null,
          avgMinutesToContact: attended.length > 0
            ? Math.round(attended.reduce((s, e) => s + (e.minutes_to_contact || 0), 0) / attended.length)
            : null,
          overdueCount: overdueFollowups.length,
        },
      };
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}
