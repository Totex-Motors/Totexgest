import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Phone, Video, FileText, Star, Eye } from 'lucide-react';
import { TrainingCase } from '@/hooks/useSalesTraining';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const categoryConfig: Record<string, { label: string; icon: typeof Phone; color: string }> = {
  sdr_call: { label: 'Call SDR', icon: Phone, color: 'text-blue-600 bg-blue-50' },
  closer_call: { label: 'Call Closer', icon: Phone, color: 'text-purple-600 bg-purple-50' },
  meeting: { label: 'Reunião', icon: Video, color: 'text-green-600 bg-green-50' },
  objection_handling: { label: 'Objeções', icon: FileText, color: 'text-teal-600 bg-teal-50' },
  closing: { label: 'Fechamento', icon: FileText, color: 'text-red-600 bg-red-50' },
  discovery: { label: 'Discovery', icon: FileText, color: 'text-teal-600 bg-teal-50' },
  other: { label: 'Outro', icon: FileText, color: 'text-gray-600 bg-gray-50' },
};

const outcomeConfig: Record<string, { label: string; color: string }> = {
  positive: { label: 'Positivo', color: 'bg-green-100 text-green-700' },
  negative: { label: 'Negativo', color: 'bg-red-100 text-red-700' },
  neutral: { label: 'Neutro', color: 'bg-gray-100 text-gray-700' },
};

const difficultyConfig: Record<string, { label: string; color: string }> = {
  beginner: { label: 'Iniciante', color: 'bg-green-100 text-green-700' },
  intermediate: { label: 'Intermediário', color: 'bg-yellow-100 text-yellow-700' },
  advanced: { label: 'Avançado', color: 'bg-red-100 text-red-700' },
};

interface TrainingCaseCardProps {
  trainingCase: TrainingCase;
  onClick: () => void;
}

export function TrainingCaseCard({ trainingCase, onClick }: TrainingCaseCardProps) {
  const cat = categoryConfig[trainingCase.category] || categoryConfig.other;
  const Icon = cat.icon;

  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn('p-2 rounded-lg', cat.color)}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-sm truncate">{trainingCase.title}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {trainingCase.sales_rep?.name || 'Sem vendedor'}
              {' · '}
              {formatDistanceToNow(new Date(trainingCase.created_at), { addSuffix: true, locale: ptBR })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          <Badge variant="outline" className={cn('text-[10px]', cat.color)}>{cat.label}</Badge>
          {trainingCase.outcome && outcomeConfig[trainingCase.outcome] && (
            <Badge variant="secondary" className={cn('text-[10px]', outcomeConfig[trainingCase.outcome].color)}>
              {outcomeConfig[trainingCase.outcome].label}
            </Badge>
          )}
          {trainingCase.difficulty && difficultyConfig[trainingCase.difficulty] && (
            <Badge variant="secondary" className={cn('text-[10px]', difficultyConfig[trainingCase.difficulty].color)}>
              {difficultyConfig[trainingCase.difficulty].label}
            </Badge>
          )}
        </div>

        {trainingCase.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {trainingCase.tags.slice(0, 3).map(tag => (
              <span key={tag} className="text-[10px] text-muted-foreground">#{tag}</span>
            ))}
            {trainingCase.tags.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{trainingCase.tags.length - 3}</span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between mt-3 pt-2 border-t">
          <div className="flex items-center gap-1 text-muted-foreground">
            {trainingCase.rating && (
              <>
                <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                <span className="text-xs">{trainingCase.rating}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <Eye className="h-3 w-3" />
            <span className="text-xs">{trainingCase.view_count}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

