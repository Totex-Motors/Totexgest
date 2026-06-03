import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, X, BookOpen } from 'lucide-react';
import { useCreateTrainingCase, CreateTrainingCaseInput } from '@/hooks/useSalesTraining';
import { useToast } from '@/hooks/use-toast';

interface SaveToTrainingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultData: {
    title: string;
    source_type: 'call' | 'meeting' | 'manual';
    call_history_id?: string;
    meeting_id?: string;
    transcription?: any;
    ai_analysis?: any;
    record_url?: string;
    lead_id?: string;
    sales_rep_id?: string;
  };
}

const categoryOptions = [
  { value: 'sdr_call', label: 'Call SDR' },
  { value: 'closer_call', label: 'Call Closer' },
  { value: 'meeting', label: 'Reunião' },
  { value: 'objection_handling', label: 'Objeções' },
  { value: 'closing', label: 'Fechamento' },
  { value: 'discovery', label: 'Discovery' },
  { value: 'other', label: 'Outro' },
];

const difficultyOptions = [
  { value: 'beginner', label: 'Iniciante' },
  { value: 'intermediate', label: 'Intermediário' },
  { value: 'advanced', label: 'Avançado' },
];

const outcomeOptions = [
  { value: 'positive', label: 'Positivo' },
  { value: 'negative', label: 'Negativo' },
  { value: 'neutral', label: 'Neutro' },
];

export function SaveToTrainingModal({ open, onOpenChange, defaultData }: SaveToTrainingModalProps) {
  const { toast } = useToast();
  const createCase = useCreateTrainingCase();

  const [title, setTitle] = useState(defaultData.title);
  const [category, setCategory] = useState(defaultData.source_type === 'meeting' ? 'meeting' : 'sdr_call');
  const [difficulty, setDifficulty] = useState('');
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
      setTagInput('');
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag));
  };

  const handleSave = async () => {
    const input: CreateTrainingCaseInput = {
      title,
      category,
      source_type: defaultData.source_type,
      call_history_id: defaultData.call_history_id,
      meeting_id: defaultData.meeting_id,
      transcription: defaultData.transcription,
      ai_analysis: defaultData.ai_analysis,
      record_url: defaultData.record_url,
      lead_id: defaultData.lead_id,
      sales_rep_id: defaultData.sales_rep_id,
      tags,
      notes: notes || undefined,
      difficulty: difficulty || undefined,
      outcome: outcome || undefined,
    };

    try {
      await createCase.mutateAsync(input);
      toast({ title: 'Caso salvo na biblioteca de treinamento' });
      onOpenChange(false);
    } catch {
      toast({ title: 'Erro ao salvar caso', variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Salvar para Treinamento
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Título</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} />
          </div>

          <div>
            <Label>Categoria</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {categoryOptions.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Dificuldade</Label>
              <Select value={difficulty} onValueChange={setDifficulty}>
                <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                <SelectContent>
                  {difficultyOptions.map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Resultado</Label>
              <Select value={outcome} onValueChange={setOutcome}>
                <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                <SelectContent>
                  {outcomeOptions.map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Tags</Label>
            <div className="flex gap-2">
              <Input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                placeholder="Adicionar tag..."
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag())}
              />
              <Button variant="outline" size="sm" onClick={addTag}>+</Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map(tag => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    <X className="h-3 w-3 cursor-pointer" onClick={() => removeTag(tag)} />
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label>Observações do Gestor</Label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="O que há de relevante neste caso para treinamento?"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSave} disabled={!title || !category || createCase.isPending}>
            {createCase.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
