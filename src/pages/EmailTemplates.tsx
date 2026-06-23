import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import EmailTemplateGallery from '@/components/email-marketing/EmailTemplateGallery';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';

export default function EmailTemplates() {
  const navigate = useNavigate();

  return (
    <AppLayout>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <MarketingPageHeader
          eyebrow="Marketing · Email"
          title="Templates"
          description="Reutilize templates em campanhas e automações. Cada template é editado com o Maily, em PT-BR e com variáveis (@nome, @vendedor, etc)."
          action={
            <Button
              size="sm"
              className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5"
              onClick={() => navigate('/marketing/templates/novo')}
            >
              <Plus className="h-3.5 w-3.5" /> Novo template
            </Button>
          }
        />

        <EmailTemplateGallery
          onEditTemplate={(id) => navigate(`/marketing/templates/${id}`)}
          onNewTemplate={() => navigate('/marketing/templates/novo')}
        />
      </div>
    </AppLayout>
  );
}
