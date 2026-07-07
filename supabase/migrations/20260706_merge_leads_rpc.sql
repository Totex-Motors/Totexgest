-- RPC merge_leads: mescla dois leads, movendo todos os dados do duplicado para o keeper.
-- Chamada pelo frontend em useMergeLeads.ts via supabase.rpc("merge_leads", { p_keeper_id, p_duplicate_id }).

create or replace function merge_leads(p_keeper_id uuid, p_duplicate_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  -- Garante que ambos os leads existem e pertencem ao mesmo tenant (RLS segurança extra)
  select tenant_id into v_tenant_id from leads where id = p_keeper_id;
  if not found then
    raise exception 'Lead keeper não encontrado: %', p_keeper_id;
  end if;
  if not exists (select 1 from leads where id = p_duplicate_id and tenant_id = v_tenant_id) then
    raise exception 'Lead duplicado não encontrado ou pertence a outro tenant';
  end if;
  if p_keeper_id = p_duplicate_id then
    raise exception 'keeper e duplicate não podem ser o mesmo lead';
  end if;

  -- Reatribuir registros filhos do duplicado para o keeper
  update deals             set lead_id = p_keeper_id where lead_id = p_duplicate_id;
  update tasks             set lead_id = p_keeper_id where lead_id = p_duplicate_id;
  update meetings          set lead_id = p_keeper_id where lead_id = p_duplicate_id;
  update whatsapp_messages set lead_id = p_keeper_id where lead_id = p_duplicate_id;
  update call_history      set lead_id = p_keeper_id where lead_id = p_duplicate_id;

  -- Apagar o lead duplicado
  delete from leads where id = p_duplicate_id;

  -- Marcar keeper como atualizado
  update leads set updated_at = now() where id = p_keeper_id;
end;
$$;

-- Permissão: apenas usuários autenticados (RLS garante o resto via security definer)
grant execute on function merge_leads(uuid, uuid) to authenticated;
