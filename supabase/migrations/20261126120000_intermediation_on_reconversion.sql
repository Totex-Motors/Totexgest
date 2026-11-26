-- Intermediação também nasce quando a captação RECONVERTE um lead que já existia (26/11/2026).
-- create_capture_lead, quando o telefone já é lead na loja, faz UPDATE (captured_by_member_id passa a valer)
-- em vez de INSERT — e o trigger trg_intermediation_from_lead era só AFTER INSERT: o lead virava captação,
-- o carro entrava em seller_vehicles, mas a intermediação (INT-xxxxx, contrato, funil) não era criada.
-- Mesmo função, agora também no UPDATE em que a captação é atribuída (null → membro).
DROP TRIGGER IF EXISTS trg_intermediation_from_lead_upd ON public.leads;
CREATE TRIGGER trg_intermediation_from_lead_upd AFTER UPDATE OF captured_by_member_id ON public.leads
  FOR EACH ROW WHEN (OLD.captured_by_member_id IS NULL AND NEW.captured_by_member_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_intermediation_from_lead();
