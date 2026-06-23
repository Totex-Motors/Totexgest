import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ChevronLeft } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import CampaignDetailPanel from '@/components/campaigns/CampaignDetailPanel';
import CampaignLeadsTable from '@/components/campaigns/CampaignLeadsTable';
import { useCampaign } from '@/hooks/useCampaigns';

export default function SalesCampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: campaign, isLoading } = useCampaign(id);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </AppLayout>
    );
  }

  if (!campaign) {
    return (
      <AppLayout>
        <div className="p-6 text-center">
          <p className="text-muted-foreground">Campanha não encontrada</p>
          <Button variant="ghost" className="mt-4" onClick={() => navigate('/comercial/campanhas')}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            Voltar
          </Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate('/comercial/campanhas')}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          Voltar para Campanhas
        </Button>

        <CampaignDetailPanel campaign={campaign} />

        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-3">Leads da Campanha</h3>
          <CampaignLeadsTable campaignId={campaign.id} campaignStatus={campaign.status} />
        </div>
      </div>
    </AppLayout>
  );
}
