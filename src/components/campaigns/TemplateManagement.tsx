import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Pencil, Trash2, FileText } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useCampaignTemplates, useCreateCampaignTemplate, useUpdateCampaignTemplate, useDeleteCampaignTemplate } from '@/hooks/useCampaigns';
import { CAMPAIGN_VARIABLES } from '@/types/campaign.types';
import type { CampaignTemplate } from '@/types/campaign.types';

export default function TemplateManagement() {
  const { toast } = useToast();
  const { data: templates, isLoading } = useCampaignTemplates();
  const createTemplate = useCreateCampaignTemplate();
  const updateTemplate = useUpdateCampaignTemplate();
  const deleteTemplate = useDeleteCampaignTemplate();

  const [isOpen, setIsOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<CampaignTemplate | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');

  const openNew = () => {
    setEditingTemplate(null);
    setName('');
    setContent('');
    setIsOpen(true);
  };

  const openEdit = (template: CampaignTemplate) => {
    setEditingTemplate(template);
    setName(template.name);
    setContent(template.content);
    setIsOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim() || !content.trim()) {
      toast({ title: 'Preencha nome e conteúdo', variant: 'destructive' });
      return;
    }

    // Extract variables used in content
    const usedVars = CAMPAIGN_VARIABLES
      .filter(v => content.includes(v.key))
      .map(v => v.key);

    try {
      if (editingTemplate) {
        await updateTemplate.mutateAsync({ id: editingTemplate.id, name, content, variables: usedVars });
        toast({ title: 'Template atualizado!' });
      } else {
        await createTemplate.mutateAsync({ name, content, variables: usedVars });
        toast({ title: 'Template criado!' });
      }
      setIsOpen(false);
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Desativar este template?')) return;
    try {
      await deleteTemplate.mutateAsync(id);
      toast({ title: 'Template desativado' });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Templates de Mensagem</h3>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" />
          Novo Template
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </div>
      ) : (templates || []).length === 0 ? (
        <div className="text-center py-12">
          <FileText className="h-10 w-10 mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">Nenhum template criado</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(templates || []).map(t => (
            <Card key={t.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h4 className="font-medium text-sm">{t.name}</h4>
                    <span className="text-[10px] text-muted-foreground">
                      Usado {t.usage_count}x
                      {t.last_used_at && ` · Último uso: ${new Date(t.last_used_at).toLocaleDateString('pt-BR')}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(t)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500" onClick={() => handleDelete(t.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">{t.content}</p>
                {t.variables.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {t.variables.map(v => (
                      <Badge key={v} variant="outline" className="text-[10px]">{v}</Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? 'Editar Template' : 'Novo Template'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nome</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Reativação Geral" className="mt-1" />
            </div>
            <div>
              <Label>Conteúdo</Label>
              <div className="flex flex-wrap gap-1 mt-1 mb-2">
                {CAMPAIGN_VARIABLES.map(v => (
                  <Badge
                    key={v.key}
                    variant="outline"
                    className="cursor-pointer text-[10px] hover:bg-primary/10"
                    onClick={() => setContent(prev => prev + v.key)}
                  >
                    {v.key}
                  </Badge>
                ))}
              </div>
              <Textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Oi {{primeiro_nome}}, tudo bem?..."
                className="min-h-[120px] font-mono text-sm"
              />
              <span className="text-xs text-muted-foreground">{content.length} caracteres</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setIsOpen(false)}>Cancelar</Button>
              <Button onClick={handleSave} disabled={createTemplate.isPending || updateTemplate.isPending}>
                {editingTemplate ? 'Salvar' : 'Criar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
