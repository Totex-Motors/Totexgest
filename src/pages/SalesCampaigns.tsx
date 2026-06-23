import { useNavigate, useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Megaphone, FileText, Smartphone, Upload, Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import CampaignList from '@/components/campaigns/CampaignList';
import TemplateManagement from '@/components/campaigns/TemplateManagement';
import CampaignInstancesManager from '@/components/campaigns/CampaignInstancesManager';
import ImportLeadsWizard from '@/components/campaigns/ImportLeadsWizard';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';

export default function SalesCampaigns() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'campaigns';

  const handleTabChange = (value: string) => {
    setSearchParams(value === 'campaigns' ? {} : { tab: value });
  };

  return (
    <AppLayout>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <MarketingPageHeader
          eyebrow="Marketing · WhatsApp"
          title="Campanhas"
          description="Dispare mensagens em massa via API Oficial Meta ou UAZAPI."
          action={
            currentTab === 'campaigns' ? (
              <Button
                size="sm"
                className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5"
                onClick={() => navigate('/comercial/campanhas/nova')}
              >
                <Plus className="h-3.5 w-3.5" /> Nova campanha
              </Button>
            ) : undefined
          }
        />

        <Tabs value={currentTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="campaigns" className="gap-1.5">
              <Megaphone className="h-3.5 w-3.5" />
              Campanhas
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              Mensagens salvas
            </TabsTrigger>
            <TabsTrigger value="instances" className="gap-1.5">
              <Smartphone className="h-3.5 w-3.5" />
              Instâncias
            </TabsTrigger>
            <TabsTrigger value="import" className="gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              Importação
            </TabsTrigger>
          </TabsList>

          <TabsContent value="campaigns" className="mt-4">
            <CampaignList onNewCampaign={() => navigate('/comercial/campanhas/nova')} />
          </TabsContent>

          <TabsContent value="templates" className="mt-4">
            <TemplateManagement />
          </TabsContent>

          <TabsContent value="instances" className="mt-4">
            <CampaignInstancesManager />
          </TabsContent>

          <TabsContent value="import" className="mt-4">
            <ImportLeadsWizard />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
