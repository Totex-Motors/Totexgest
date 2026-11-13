-- Outros nomes da mesma loja (13/11/2026). O totem passou a mandar "da loja Cardoso Prime" (unidade
-- de Alphaville, loja separada no marketplace) e o gatilho de distribuição do whatsapp-cloud-webhook
-- (matchStoreTenant) só reconhecia "Cardoso Veículos": o lead ficava preso no tenant da Totex e a
-- promotora não achava o cliente em "Vincular atendimento". aliases entra no casamento de nome.
ALTER TABLE public.tenant_lead_destinations ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}';
UPDATE public.tenant_lead_destinations SET aliases = ARRAY['Cardoso Prime','Cardoso Prime Alphaville']
WHERE tenant_id = '1a108c13-7fa4-47e9-8264-17e110332549' AND NOT ('Cardoso Prime' = ANY(aliases));
