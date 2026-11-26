-- "Erro ao salvar veículo na troca" (26/11/2026): trade_in_vehicles.tenant_id é NOT NULL sem default e o
-- card "Veículo na Troca/Compra" (TradeInVehicleCard) não manda tenant_id. Trigger preenche a loja pelo
-- lead (ou deal, ou tenant do usuário) antes do insert. A RLS continua valendo (tenant do usuário).
CREATE OR REPLACE FUNCTION public.trade_in_set_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
BEGIN
  IF NEW.tenant_id IS NULL AND NEW.lead_id IS NOT NULL THEN
    SELECT tenant_id INTO NEW.tenant_id FROM leads WHERE id = NEW.lead_id;
  END IF;
  IF NEW.tenant_id IS NULL AND NEW.deal_id IS NOT NULL THEN
    SELECT tenant_id INTO NEW.tenant_id FROM deals WHERE id = NEW.deal_id;
  END IF;
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := public.get_tenant_id();
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_trade_in_set_tenant ON public.trade_in_vehicles;
CREATE TRIGGER trg_trade_in_set_tenant BEFORE INSERT ON public.trade_in_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.trade_in_set_tenant();
