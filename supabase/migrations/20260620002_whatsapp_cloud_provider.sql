-- Adiciona o provider WhatsApp Cloud API (oficial Meta) aos credenciais V2.
-- Também inclui 'meta_ads' no CHECK (estava no frontend mas faltava no banco — drift).
-- Idempotente.

ALTER TABLE public.agents_provider_credentials
  DROP CONSTRAINT IF EXISTS agents_provider_credentials_provider_type_check;

ALTER TABLE public.agents_provider_credentials
  ADD CONSTRAINT agents_provider_credentials_provider_type_check
  CHECK (provider_type = ANY (ARRAY[
    'anthropic_api','openai_api','openai_codex','google_gemini','groq','together',
    'fireworks','deepseek','custom',
    'borapostar','buffer','scrape_creators','gemini_image','uazapi','jina_reader','tavily',
    'meta_ads','whatsapp_cloud'
  ]));

-- Catálogo de providers (pra views que listam integrações disponíveis).
INSERT INTO public.agents_integration_providers (slug, display_name, description, icon, category, credential_type, setup_url)
SELECT 'whatsapp_cloud', 'WhatsApp Cloud API (Meta)',
       'API oficial do WhatsApp Business (Meta). Envia/recebe sem risco de ban; abertura fria exige template aprovado.',
       '🟢', 'messaging', 'whatsapp_cloud',
       'https://developers.facebook.com/docs/whatsapp/cloud-api'
WHERE NOT EXISTS (SELECT 1 FROM public.agents_integration_providers WHERE slug='whatsapp_cloud');
