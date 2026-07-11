import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { X, MessageCircle, Building2, Phone } from 'lucide-react';
import { DistributionConfig, useUpdateDistributionConfig } from '@/hooks/useLeadDistribution';
import { useAvailableWhatsAppInstances } from '@/hooks/useSendWhatsAppMessage';
import { useToast } from '@/hooks/use-toast';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: DistributionConfig;
}

/**
 * Editor das regras de roteamento WhatsApp pra uma distribuição.
 * Decide quando ESSA distribuição é aplicada quando msg chega via WhatsApp.
 * - instance_id: NULL = qualquer instância
 * - keywords: NULL/vazio = qualquer mensagem
 * - match_type: any/all/none
 * - priority: ordem de avaliação (menor = primeiro)
 */
export function WhatsAppRoutingDialog({ open, onOpenChange, config }: Props) {
  const { data: instances = [] } = useAvailableWhatsAppInstances();
  const update = useUpdateDistributionConfig();
  const { toast } = useToast();

  const [instanceId, setInstanceId] = useState<string>('any');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [kwInput, setKwInput] = useState('');
  const [matchType, setMatchType] = useState<'any' | 'all' | 'none'>('any');
  const [priority, setPriority] = useState<number>(100);

  // Hidrata estado quando abre
  useEffect(() => {
    if (!open) return;
    setInstanceId(config.match_instance_id || 'any');
    setKeywords(Array.isArray(config.match_keywords) ? config.match_keywords : []);
    setMatchType(config.match_type || 'any');
    setPriority(typeof config.priority === 'number' ? config.priority : 100);
    setKwInput('');
  }, [open, config]);

  const addKeyword = () => {
    const k = kwInput.trim().toLowerCase();
    if (!k) return;
    if (keywords.includes(k)) {
      setKwInput('');
      return;
    }
    setKeywords([...keywords, k]);
    setKwInput('');
  };

  const removeKeyword = (k: string) => setKeywords(keywords.filter(x => x !== k));

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        id: config.id,
        match_instance_id: instanceId === 'any' ? null : (instanceId as any),
        match_keywords: keywords.length > 0 ? (keywords as any) : null,
        match_type: matchType as any,
        priority,
      } as any);
      toast({ title: 'Regras salvas', description: 'A próxima mensagem que entrar usará essas regras.' });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Erro ao salvar', description: e?.message || 'Tente novamente', variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-emerald-600" />
            Regras WhatsApp — {config.name}
          </DialogTitle>
          <DialogDescription>
            Quando uma mensagem nova chega pelo WhatsApp, o sistema avalia essas regras pra decidir se
            esta distribuição é aplicada. Regras vazias = casa com tudo (comportamento default).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Instância */}
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Instância</Label>
            <Select value={instanceId} onValueChange={setInstanceId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">
                  <span className="text-muted-foreground">Qualquer instância</span>
                </SelectItem>
                {instances.map((inst: any) => (
                  <SelectItem key={inst.id} value={inst.id}>
                    <span className="inline-flex items-center gap-1.5">
                      {inst.provider === 'meta_cloud' ? (
                        <Building2 className="h-3.5 w-3.5 text-blue-600" />
                      ) : (
                        <Phone className="h-3.5 w-3.5 text-emerald-600" />
                      )}
                      {inst.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Aplica esta regra só quando a msg chega por essa instância. "Qualquer" = ignora canal.
            </p>
          </div>

          {/* Keywords */}
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Palavras-chave na 1ª mensagem
            </Label>
            <div className="flex gap-1.5">
              <Input
                value={kwInput}
                onChange={e => setKwInput(e.target.value)}
                placeholder="comprar, contratar, orçamento..."
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" onClick={addKeyword}>
                Add
              </Button>
            </div>
            {keywords.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {keywords.map(k => (
                  <Badge key={k} variant="secondary" className="gap-1 pr-1">
                    {k}
                    <button
                      type="button"
                      onClick={() => removeKeyword(k)}
                      className="ml-0.5 rounded hover:bg-background/60 p-0.5"
                      aria-label={`Remover ${k}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Sem keywords = casa com qualquer mensagem. Use Enter ou vírgula pra adicionar.
            </p>
          </div>

          {/* Match type — só relevante se tiver keywords */}
          {keywords.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Modo de match</Label>
              <RadioGroup value={matchType} onValueChange={(v: any) => setMatchType(v)} className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="any" id="m-any" />
                  <span><strong>Qualquer</strong> — pelo menos 1 keyword bate</span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="all" id="m-all" />
                  <span><strong>Todas</strong> — todas as keywords presentes</span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="none" id="m-none" />
                  <span><strong>Nenhuma</strong> — match negativo (excluir essas)</span>
                </label>
              </RadioGroup>
            </div>
          )}

          {/* Priority */}
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Prioridade</Label>
            <Input
              type="number"
              value={priority}
              min={0}
              onChange={e => setPriority(parseInt(e.target.value) || 100)}
              className="w-32"
            />
            <p className="text-[11px] text-muted-foreground">
              Menor valor = avaliada primeiro. Use 1-10 pra regras específicas, 100+ pra fallback.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? 'Salvando...' : 'Salvar regras'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
