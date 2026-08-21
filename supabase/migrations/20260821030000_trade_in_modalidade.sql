-- Modalidade do negócio com o veículo do cliente (pedido do Marco 21/08):
-- troca | compra | intermediacao | consignacao | anuncio_trafego
ALTER TABLE public.trade_in_vehicles
  ADD COLUMN IF NOT EXISTS modalidade text
  CHECK (modalidade IS NULL OR modalidade IN ('troca','compra','intermediacao','consignacao','anuncio_trafego'));
