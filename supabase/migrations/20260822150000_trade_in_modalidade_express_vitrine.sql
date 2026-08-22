-- Adiciona 'express' e 'vitrine' às modalidades do veículo (pedido do Marco):
-- alinha com as modalidades de venda do TotexCar Co-pilot.
ALTER TABLE public.trade_in_vehicles DROP CONSTRAINT IF EXISTS trade_in_vehicles_modalidade_check;
ALTER TABLE public.trade_in_vehicles
  ADD CONSTRAINT trade_in_vehicles_modalidade_check
  CHECK (modalidade IS NULL OR modalidade IN ('troca','compra','intermediacao','consignacao','anuncio_trafego','express','vitrine'));
