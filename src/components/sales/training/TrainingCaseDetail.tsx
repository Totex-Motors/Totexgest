import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Phone,
  Video,
  FileText,
  Star,
  Eye,
  User,
  Calendar,
  ExternalLink,
  Play,
  Trash2,
  Mic,
  Copy,
  ClipboardCheck,
} from 'lucide-react';
import { TrainingCase, useDeleteTrainingCase } from '@/hooks/useSalesTraining';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useToast } from '@/hooks/use-toast';

interface TranscriptionSegment {
  text: string;
  speaker?: string;
  channel?: number;
  timestamp?: number;
}

const categoryLabels: Record<string, string> = {
  sdr_call: 'Call SDR',
  closer_call: 'Call Closer',
  meeting: 'Reunião',
  objection_handling: 'Objeções',
  closing: 'Fechamento',
  discovery: 'Discovery',
  other: 'Outro',
};

interface TrainingCaseDetailProps {
  trainingCase: TrainingCase | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TrainingCaseDetail({ trainingCase, open, onOpenChange }: TrainingCaseDetailProps) {
  const { toast } = useToast();
  const deleteCase = useDeleteTrainingCase();
  const [activeTab, setActiveTab] = useState('overview');
  const [copied, setCopied] = useState(false);

  if (!trainingCase) return null;

  const analysis = trainingCase.ai_analysis;
  const transcription = trainingCase.transcription as TranscriptionSegment[] | null;

  const handleDelete = async () => {
    if (!confirm('Tem certeza que deseja excluir este caso?')) return;
    try {
      await deleteCase.mutateAsync(trainingCase.id);
      toast({ title: 'Caso excluído' });
      onOpenChange(false);
    } catch {
      toast({ title: 'Erro ao excluir', variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-start justify-between">
            <div>
              <DialogTitle className="text-lg">{trainingCase.title}</DialogTitle>
              <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
                {trainingCase.sales_rep?.name && (
                  <span className="flex items-center gap-1">
                    <User className="h-3 w-3" />
                    {trainingCase.sales_rep.name}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {format(new Date(trainingCase.created_at), "dd/MM/yyyy", { locale: ptBR })}
                </span>
                <span className="flex items-center gap-1">
                  <Eye className="h-3 w-3" />
                  {trainingCase.view_count} views
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {trainingCase.lead_id && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`/comercial/leads/${trainingCase.lead_id}`, '_blank')}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1" />
                  Lead
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={handleDelete} className="text-red-500 hover:text-red-700">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 mt-3">
            <Badge variant="outline">{categoryLabels[trainingCase.category] || trainingCase.category}</Badge>
            {trainingCase.outcome && <Badge variant="secondary">{trainingCase.outcome}</Badge>}
            {trainingCase.difficulty && <Badge variant="secondary">{trainingCase.difficulty}</Badge>}
            {trainingCase.tags.map(tag => (
              <Badge key={tag} variant="outline" className="text-xs">#{tag}</Badge>
            ))}
          </div>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 min-h-0">
          <TabsList className="mx-6 mt-2">
            <TabsTrigger value="overview">Resumo</TabsTrigger>
            {transcription && <TabsTrigger value="transcription">Transcrição</TabsTrigger>}
            {analysis && <TabsTrigger value="analysis">Análise IA</TabsTrigger>}
          </TabsList>

          <ScrollArea className="flex-1 px-6 pb-6" style={{ height: 'calc(85vh - 280px)' }}>
            <TabsContent value="overview" className="mt-4 space-y-4">
              {trainingCase.notes && (
                <div>
                  <h4 className="font-medium text-sm mb-1">Observações do Gestor</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{trainingCase.notes}</p>
                </div>
              )}

              {trainingCase.record_url && (
                <div>
                  <h4 className="font-medium text-sm mb-2">Gravação</h4>
                  <audio controls src={trainingCase.record_url} className="w-full" />
                </div>
              )}

              {analysis?.summary && (
                <div>
                  <h4 className="font-medium text-sm mb-1">Resumo da IA</h4>
                  <p className="text-sm text-muted-foreground">{analysis.summary}</p>
                </div>
              )}

              {analysis?.key_points && analysis.key_points.length > 0 && (
                <div>
                  <h4 className="font-medium text-sm mb-1">Pontos-chave</h4>
                  <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                    {analysis.key_points.map((point: string, i: number) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                </div>
              )}

              {analysis?.suggested_tasks && analysis.suggested_tasks.length > 0 && (
                <div>
                  <h4 className="font-medium text-sm mb-1">Tarefas Sugeridas</h4>
                  <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                    {analysis.suggested_tasks.map((task: any, i: number) => (
                      <li key={i}>{typeof task === 'string' ? task : task.title || task.description}</li>
                    ))}
                  </ul>
                </div>
              )}
            </TabsContent>

            <TabsContent value="transcription" className="mt-4">
              {transcription && (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => {
                        const text = transcription
                          .map(s => `${s.speaker || (s.channel === 0 ? 'Vendedor' : 'Lead')}: ${s.text}`)
                          .join('\n');
                        navigator.clipboard.writeText(text);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                        toast({ title: 'Transcrição copiada!' });
                      }}
                    >
                      {copied ? (
                        <><ClipboardCheck className="h-3.5 w-3.5 text-emerald-500" /> Copiado</>
                      ) : (
                        <><Copy className="h-3.5 w-3.5" /> Copiar tudo</>
                      )}
                    </Button>
                  </div>
                  <div className="space-y-2 select-text">
                    {transcription.map((seg, i) => (
                      <div key={i} className="flex gap-2 text-sm">
                        <span className={cn(
                          'font-medium shrink-0 w-20 text-right',
                          seg.channel === 0 || seg.speaker === 'Vendedor' ? 'text-blue-600' : 'text-green-600'
                        )}>
                          <Mic className="h-3 w-3 inline mr-1" />
                          {seg.speaker || (seg.channel === 0 ? 'Vendedor' : 'Lead')}
                        </span>
                        <span className="text-muted-foreground">{seg.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="analysis" className="mt-4">
              {analysis && (
                <pre className="text-xs bg-muted p-4 rounded-lg overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(analysis, null, 2)}
                </pre>
              )}
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
