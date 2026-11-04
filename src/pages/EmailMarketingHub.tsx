import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Mail, UserMinus, Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import EmailCampaignList from '@/components/email-marketing/EmailCampaignList';
import EmailCampaignForm from '@/components/email-marketing/EmailCampaignForm';
import EmailUnsubscribeList from '@/components/email-marketing/EmailUnsubscribeList';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useMarketingTenant } from '@/hooks/useMarketingTenant';

export default function EmailMarketingHub() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const currentTab = searchParams.get('tab') || 'campaigns';
  const marketingLoja = useMarketingTenant();
  const editParam = searchParams.get('edit');

  useEffect(() => {
    if (currentTab === 'sequences') {
      window.location.replace('/marketing/automacoes');
    }
  }, [currentTab]);

  // Cliques em "Editar" abrem o EmailCampaignForm (Dialog 4 steps)
  // via ?edit=ID. Novo wizard fica em /marketing/campanhas/nova.
  useEffect(() => {
    if (editParam) {
      setEditId(editParam);
      setIsFormOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('edit');
      setSearchParams(next, { replace: true });
    }
  }, [editParam, searchParams, setSearchParams]);

  const handleFormOpenChange = (open: boolean) => {
    setIsFormOpen(open);
    if (!open) setEditId(null);
  };

  const handleTabChange = (value: string) => {
    setSearchParams(value === 'campaigns' ? {} : { tab: value });
  };

  return (
    <AppLayout>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <MarketingPageHeader
          eyebrow="Marketing · Email"
          title="Campanhas"
          description={marketingLoja.somenteLeitura
            ? 'Você está vendo as campanhas de outra loja (só visualização). Pra criar ou disparar, volte pra sua loja.'
            : 'Dispare emails em massa para listas filtradas ou leads específicos.'}
          rightAccessory={marketingLoja.isSuperAdmin && marketingLoja.lojas.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Loja:</span>
              <Select value={marketingLoja.loja} onValueChange={marketingLoja.setLoja}>
                <SelectTrigger className="h-8 w-[220px] text-sm"><SelectValue placeholder="Escolha a loja" /></SelectTrigger>
                <SelectContent>{marketingLoja.lojas.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : undefined}
          action={
            currentTab === 'campaigns' && !marketingLoja.somenteLeitura ? (
              <Button
                size="sm"
                className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5"
                onClick={() => navigate('/marketing/campanhas/nova')}
              >
                <Plus className="h-3.5 w-3.5" /> Nova campanha
              </Button>
            ) : undefined
          }
        />

        <Tabs value={currentTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="campaigns" className="gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Campanhas
            </TabsTrigger>
            <TabsTrigger value="unsubscribes" className="gap-1.5">
              <UserMinus className="h-3.5 w-3.5" />
              Descadastros
            </TabsTrigger>
          </TabsList>

          <TabsContent value="campaigns" className="mt-4">
            <EmailCampaignList
              onNewCampaign={() => navigate('/marketing/campanhas/nova')}
              onEditCampaign={(id) => { setEditId(id); setIsFormOpen(true); }}
            />
          </TabsContent>

          <TabsContent value="unsubscribes" className="mt-4">
            <EmailUnsubscribeList />
          </TabsContent>
        </Tabs>

        <EmailCampaignForm open={isFormOpen} onOpenChange={handleFormOpenChange} editId={editId} />
      </div>
    </AppLayout>
  );
}
