-- ============================================================================
-- 20260620004_whatsapp_templates.sql
-- Tabela de templates da WhatsApp Cloud API — fonte única do TEXTO dos templates
-- aprovados na Meta. Usada por send-whatsapp-cloud (buildTemplateText) pra logar no
-- inbox o conteúdo real enviado (em vez de "[Template: nome]").
--
-- IMPORTANTE: cadastrar aqui NÃO cria/aprova o template na Meta — isso é feito no
-- painel (Meta Business → WhatsApp Manager → Templates). O body_text aqui deve ser
-- IGUAL ao corpo aprovado, com {{1}}, {{2}}... nas mesmas posições.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  language    text NOT NULL DEFAULT 'pt_BR',
  category    text,
  body_text   text NOT NULL,
  status      text NOT NULL DEFAULT 'approved',
  tenant_id   uuid DEFAULT public.get_tenant_id(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;

-- Leitura/escrita escopada ao tenant (edge fns usam service_role e ignoram RLS).
DROP POLICY IF EXISTS whatsapp_templates_tenant ON public.whatsapp_templates;
CREATE POLICY whatsapp_templates_tenant ON public.whatsapp_templates
  FOR ALL TO authenticated
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

-- Template de abertura do Agente do Stand (tenant Totex Motors super-admin).
-- {{1}} = primeiro nome do cliente.
INSERT INTO public.whatsapp_templates (name, language, category, body_text, status, tenant_id)
VALUES (
  'primeiro_contato_qualificacao',
  'pt_BR',
  'MARKETING',
  'Oi {{1}}! Tudo bem? Aqui é da Totex Motors 🚗 Vi que você passou no nosso stand e demonstrou interesse. Posso te ajudar com algumas informações sobre o carro?',
  'pending',
  'c13681e3-5db9-48d1-9c5c-856e6041d77f'
)
ON CONFLICT (name) DO UPDATE
  SET body_text = EXCLUDED.body_text,
      category  = EXCLUDED.category,
      updated_at = now();
