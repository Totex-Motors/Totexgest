-- Exclusão definitiva de um membro do time, de forma segura:
-- 1) NULL em todas as FKs anuláveis que referenciam team_members (atores/criadores);
-- 2) apaga linhas de config NOT NULL que travariam o delete (seguras de remover);
-- 3) protege histórico financeiro: aborta se o membro tiver comissões;
-- 4) apaga o membro (FKs CASCADE/SET NULL cuidam do resto).
-- SECURITY DEFINER: a edge function manage-team-member valida admin + tenant ANTES de chamar.
create or replace function public.admin_delete_team_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_has_commissions boolean;
begin
  if p_member_id is null then
    raise exception 'member_id obrigatório';
  end if;

  -- protege histórico financeiro (comissões são NOT NULL -> não dá pra anular)
  select exists(select 1 from commissions where sales_rep_id = p_member_id) into v_has_commissions;
  if v_has_commissions then
    raise exception 'Membro tem comissões registradas (histórico financeiro). Desative-o em vez de excluir.';
  end if;

  -- 1) NULL em toda FK anulável (NO ACTION / RESTRICT) que aponta pra team_members.
  --    (FKs SET NULL/CASCADE se resolvem sozinhas no delete final.)
  for r in
    select con.conrelid::regclass::text as child_table, att.attname as child_column
    from pg_constraint con
    join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'f'
      and con.confrelid = 'public.team_members'::regclass
      and att.attnotnull = false
      and con.confdeltype in ('a','r')
  loop
    execute format('update public.%I set %I = null where %I = $1',
                   split_part(r.child_table, '.', -1), r.child_column, r.child_column)
      using p_member_id;
  end loop;

  -- 2) apaga linhas de config NOT NULL que travariam (seguras de remover)
  delete from admin_impersonation_tokens where admin_member_id = p_member_id or target_member_id = p_member_id;
  delete from calendar_sync_channels where team_member_id = p_member_id;
  delete from lead_distribution_members where team_member_id = p_member_id;
  delete from sdr_closer_transfers where sdr_id = p_member_id or closer_id = p_member_id;
  delete from wavoip_devices where team_member_id = p_member_id;

  -- 3) apaga o membro
  delete from team_members where id = p_member_id;
end;
$$;

revoke all on function public.admin_delete_team_member(uuid) from public, anon, authenticated;
