-- ============================================================================
-- SLA do agente (Plataforma v2) — tempos de resposta por mensagem.
--
-- Uma linha por mensagem do CLIENTE, com o horário da primeira resposta do
-- agente depois dela e o tempo em segundos. respondido=false destaca mensagens
-- que ficaram sem resposta (radar "nenhum lead sem resposta").
--
-- security_invoker: a view respeita a RLS de quem consulta (não vaza entre
-- tenants via API).
-- ============================================================================

create or replace view public.vw_agent_sla_mensagens
with (security_invoker = true) as
select
  m.id                                                    as message_id,
  m.session_id,
  s.tenant_id,
  a.display_name                                          as agente,
  s.channel,
  m.created_at                                            as cliente_em,
  r.reply_at                                              as respondido_em,
  extract(epoch from (r.reply_at - m.created_at))::int    as segundos_resposta,
  (r.reply_at is not null)                                as respondido
from public.agents_messages m
join public.agents_sessions s on s.id = m.session_id
join public.agents_registry a on a.id = s.agent_id
left join lateral (
  select min(m2.created_at) as reply_at
  from public.agents_messages m2
  where m2.session_id = m.session_id
    and m2.role = 'assistant'
    and coalesce(m2.content, '') <> ''
    and m2.created_at > m.created_at
) r on true
where m.role = 'user';

comment on view public.vw_agent_sla_mensagens is
  'SLA do agente v2: cada mensagem de cliente com o tempo até a 1ª resposta do agente. respondido=false = lead sem resposta.';
