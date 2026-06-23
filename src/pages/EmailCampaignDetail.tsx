import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronLeft, Pause, XCircle, RotateCcw, Pencil } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  useEmailCampaign,
  usePauseEmailCampaign,
  useResumeEmailCampaign,
  useCancelEmailCampaign,
} from '@/hooks/useEmailMarketing';
import { EMAIL_CAMPAIGN_STATUS_CONFIG } from '@/types/email.types';
import EmailCampaignMetrics from '@/components/email-marketing/EmailCampaignMetrics';
import EmailCampaignLeadsTable from '@/components/email-marketing/EmailCampaignLeadsTable';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export default function EmailCampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: campaign, isLoading } = useEmailCampaign(id);
  const pauseCampaign = usePauseEmailCampaign();
  const resumeCampaign = useResumeEmailCampaign();
  const cancelCampaign = useCancelEmailCampaign();

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
          <p className="text-muted-foreground">Campanha nao encontrada</p>
          <Button variant="ghost" className="mt-4" onClick={() => navigate('/marketing/campanhas')}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Voltar
          </Button>
        </div>
      </AppLayout>
    );
  }

  const statusCfg = EMAIL_CAMPAIGN_STATUS_CONFIG[campaign.status];

  const handlePause = async () => {
    try {
      await pauseCampaign.mutateAsync({ campaignId: campaign.id });
      toast({ title: 'Campanha pausada' });
    } catch { toast({ title: 'Erro ao pausar', variant: 'destructive' }); }
  };

  const handleResume = async () => {
    try {
      await resumeCampaign.mutateAsync(campaign.id);
      toast({ title: 'Campanha retomada' });
    } catch { toast({ title: 'Erro ao retomar', variant: 'destructive' }); }
  };

  const handleCancel = async () => {
    try {
      await cancelCampaign.mutateAsync(campaign.id);
      toast({ title: 'Campanha cancelada' });
    } catch { toast({ title: 'Erro ao cancelar', variant: 'destructive' }); }
  };

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate('/marketing/campanhas')}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Voltar
        </Button>

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl font-bold">{campaign.name}</h1>
              <Badge className={`${statusCfg.bgColor} ${statusCfg.color}`}>{statusCfg.label}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Assunto: {campaign.subject} | De: {campaign.from_name} &lt;{campaign.from_email}&gt;
            </p>
            <div className="flex gap-4 text-xs text-muted-foreground mt-1">
              {campaign.started_at && <span>Iniciada: {format(new Date(campaign.started_at), 'dd/MM/yy HH:mm', { locale: ptBR })}</span>}
              {campaign.completed_at && <span>Concluida: {format(new Date(campaign.completed_at), 'dd/MM/yy HH:mm', { locale: ptBR })}</span>}
              {campaign.pause_reason && <span className="text-orange-600">Motivo pausa: {campaign.pause_reason}</span>}
            </div>
          </div>

          <div className="flex gap-2">
            {(campaign.status === 'draft' || campaign.status === 'scheduled') && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/marketing/campanhas?edit=${campaign.id}`)}
              >
                <Pencil className="h-4 w-4 mr-1" /> Editar
              </Button>
            )}
            {campaign.status === 'sending' && (
              <Button variant="outline" size="sm" onClick={handlePause}>
                <Pause className="h-4 w-4 mr-1" /> Pausar
              </Button>
            )}
            {campaign.status === 'paused' && (
              <Button variant="outline" size="sm" onClick={handleResume}>
                <RotateCcw className="h-4 w-4 mr-1" /> Retomar
              </Button>
            )}
            {(campaign.status === 'sending' || campaign.status === 'paused') && (
              <Button variant="destructive" size="sm" onClick={handleCancel}>
                <XCircle className="h-4 w-4 mr-1" /> Cancelar
              </Button>
            )}
          </div>
        </div>

        {/* Metrics */}
        <EmailCampaignMetrics campaign={campaign} />

        {/* Progress bar */}
        {campaign.total_leads > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium">Progresso</span>
                <span className="text-xs text-muted-foreground">
                  {campaign.sent_count}/{campaign.total_leads} ({Math.round((campaign.sent_count / campaign.total_leads) * 100)}%)
                </span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${Math.round((campaign.sent_count / campaign.total_leads) * 100)}%` }}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Leads table */}
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-3">Leads da Campanha</h3>
          <EmailCampaignLeadsTable campaignId={campaign.id} campaignStatus={campaign.status} />
        </div>
      </div>
    </AppLayout>
  );
}
