import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge, Handle, Position,
  type Node, type Edge, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  ArrowLeft, Save, Loader2, Mail, Clock, Zap, Plus, Trash2, Settings, Users, Target,
  GitBranch, Edit3, Tag, ListTodo, Square, MessageSquare, BarChart3,
} from 'lucide-react';
import AutomationReportSheet from '@/components/marketing/AutomationReportSheet';
import {
  useEmailAutomation,
  useSaveEmailAutomation,
  type TriggerEvent,
} from '@/hooks/useEmailAutomations';
import { useEmailTemplates } from '@/hooks/useEmailMarketing';
import { cn } from '@/lib/utils';

const TRIGGER_OPTIONS: { value: TriggerEvent; label: string; icon: any }[] = [
  { value: 'lead_created', label: 'Lead criado', icon: Users },
  { value: 'deal_won', label: 'Deal fechado (ganho)', icon: Target },
  { value: 'organization_created', label: 'Cliente novo', icon: Users },
  { value: 'custom', label: 'Customizado', icon: Zap },
];

// ===== Custom Nodes =====
function TriggerNode({ data }: { data: any }) {
  return (
    <div className="bg-blue-500/10 border-2 border-blue-500/40 rounded-2xl p-4 min-w-[220px] shadow-md">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg bg-blue-500 flex items-center justify-center">
          <Zap className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Gatilho</p>
          <p className="text-sm font-semibold">{data.label || 'Quando algo acontecer'}</p>
        </div>
      </div>
      {data.description && <p className="text-xs text-muted-foreground">{data.description}</p>}
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500" />
    </div>
  );
}

function SendEmailNode({ data }: { data: any }) {
  return (
    <div className="bg-[#BAA05E]/10 border-2 border-[#BAA05E]/40 rounded-2xl p-4 min-w-[220px] shadow-md">
      <Handle type="target" position={Position.Top} className="!bg-[#BAA05E]" />
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg bg-[#BAA05E] flex items-center justify-center">
          <Mail className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-[#BAA05E] font-bold">Enviar Email</p>
          <p className="text-sm font-semibold truncate max-w-[160px]">{data.template_name || 'Sem template'}</p>
        </div>
      </div>
      {data.subject && <p className="text-xs text-muted-foreground truncate">📧 {data.subject}</p>}
      <Handle type="source" position={Position.Bottom} className="!bg-[#BAA05E]" />
    </div>
  );
}

function WaitNode({ data }: { data: any }) {
  return (
    <div className="bg-amber-500/10 border-2 border-amber-500/40 rounded-2xl p-4 min-w-[180px] shadow-md">
      <Handle type="target" position={Position.Top} className="!bg-amber-500" />
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center">
          <Clock className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-amber-600 font-bold">Esperar</p>
          <p className="text-sm font-semibold">
            {data.duration || 1} {data.unit || 'dias'}
          </p>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500" />
    </div>
  );
}

function GenericNode({ data, color, label, icon: Icon, summary }: any) {
  return (
    <div
      className="border-2 rounded-2xl p-4 min-w-[200px] shadow-md"
      style={{ backgroundColor: `${color}15`, borderColor: `${color}66` }}
    >
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: color }}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider font-bold" style={{ color }}>{label}</p>
          <p className="text-sm font-semibold truncate max-w-[160px]">{summary}</p>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}

function UpdateFieldNode({ data }: { data: any }) {
  const summary = data.field ? `${data.field} = ${data.value || '?'}` : 'Configurar';
  return <GenericNode data={data} color="#6366f1" label="Atualizar Campo" icon={Edit3} summary={summary} />;
}

function AddTagNode({ data }: { data: any }) {
  return <GenericNode data={data} color="#10b981" label="Adicionar Tag" icon={Tag} summary={data.tag || 'Configurar'} />;
}

function CreateTaskNode({ data }: { data: any }) {
  return <GenericNode data={data} color="#f59e0b" label="Criar Tarefa" icon={ListTodo} summary={data.title || 'Configurar'} />;
}

function BranchNode({ data }: { data: any }) {
  const summary = data.condition_field ? `Se ${data.condition_field} ${data.condition_op || '='} ${data.condition_value || '?'}` : 'Configurar';
  return (
    <div className="bg-purple-500/10 border-2 border-purple-500/40 rounded-2xl p-4 min-w-[220px] shadow-md">
      <Handle type="target" position={Position.Top} className="!bg-purple-500" />
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg bg-purple-500 flex items-center justify-center">
          <GitBranch className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-purple-600 font-bold">Condição</p>
          <p className="text-sm font-semibold truncate max-w-[160px]">{summary}</p>
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span className="text-emerald-600">↙ Sim</span>
        <span className="text-red-500">Não ↘</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="yes" style={{ left: '25%', background: '#10b981' }} />
      <Handle type="source" position={Position.Bottom} id="no" style={{ left: '75%', background: '#ef4444' }} />
    </div>
  );
}

function EndNode({ data }: { data: any }) {
  return (
    <div className="bg-gray-500/10 border-2 border-gray-500/40 rounded-2xl p-4 min-w-[160px] shadow-md">
      <Handle type="target" position={Position.Top} className="!bg-gray-500" />
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-gray-500 flex items-center justify-center">
          <Square className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-600 font-bold">Fim</p>
          <p className="text-sm font-semibold">{data.reason || 'Encerrar'}</p>
        </div>
      </div>
    </div>
  );
}

function SendWhatsAppNode({ data }: { data: any }) {
  return <GenericNode data={data} color="#22c55e" label="Enviar WhatsApp" icon={MessageSquare} summary={data.message ? data.message.slice(0, 30) + '...' : 'Configurar mensagem'} />;
}

const nodeTypes = {
  trigger: TriggerNode,
  sendEmail: SendEmailNode,
  wait: WaitNode,
  updateField: UpdateFieldNode,
  addTag: AddTagNode,
  createTask: CreateTaskNode,
  branch: BranchNode,
  end: EndNode,
  sendWhatsapp: SendWhatsAppNode,
};

const initialNodes: Node[] = [
  {
    id: 'trigger-1',
    type: 'trigger',
    position: { x: 250, y: 50 },
    data: { label: 'Lead criado', description: 'Quando um lead novo entrar' },
  },
];

export default function MarketingAutomationEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'nova';
  const navigate = useNavigate();

  const { data: existing, isLoading } = useEmailAutomation(isNew ? undefined : id);
  const saveAutomation = useSaveEmailAutomation();
  const { data: templates = [] } = useEmailTemplates();

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState('Nova automação');
  const [description, setDescription] = useState('');
  const [triggerEvent, setTriggerEvent] = useState<TriggerEvent>('lead_created');
  const [reportOpen, setReportOpen] = useState(false);

  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description || '');
      setTriggerEvent(existing.trigger_event);
      if (existing.flow_json?.nodes) setNodes(existing.flow_json.nodes);
      if (existing.flow_json?.edges) setEdges(existing.flow_json.edges);
    }
  }, [existing]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    [setEdges],
  );

  const defaultDataFor = (type: string): any => {
    switch (type) {
      case 'sendEmail': return { template_id: null, template_name: null, subject: '' };
      case 'wait': return { duration: 1, unit: 'dias' };
      case 'updateField': return { field: 'sales_stage', value: '' };
      case 'addTag': return { tag: '' };
      case 'createTask': return { title: '', team: 'comercial' };
      case 'branch': return { condition_field: 'sales_stage', condition_op: '=', condition_value: '' };
      case 'end': return { reason: 'completed' };
      case 'sendWhatsapp': return { message: '', use_lead_phone: true };
      default: return {};
    }
  };

  const addNode = (type: string) => {
    const lastNode = nodes[nodes.length - 1];
    const newY = (lastNode?.position.y || 50) + 150;
    const newNode: Node = {
      id: `${type}-${Date.now()}`,
      type,
      position: { x: 250, y: newY },
      data: defaultDataFor(type),
    };
    setNodes((nds) => [...nds, newNode]);

    if (lastNode) {
      setEdges((eds) => addEdge({ source: lastNode.id, target: newNode.id, animated: true }, eds));
    }
  };

  const updateNodeData = (nodeId: string, data: any) => {
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n)),
    );
    if (selectedNode?.id === nodeId) {
      setSelectedNode({ ...selectedNode, data: { ...selectedNode.data, ...data } });
    }
  };

  const deleteNode = (nodeId: string) => {
    if (nodeId.startsWith('trigger-')) return;
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedNode(null);
  };

  const handleSave = async () => {
    const flow = { nodes, edges };
    const saved = await saveAutomation.mutateAsync({
      id: isNew ? undefined : id,
      name,
      description: description || null,
      trigger_event: triggerEvent,
      flow_json: flow,
    });
    if (isNew) navigate(`/marketing/automacoes/${saved.id}`, { replace: true });
  };

  if (!isNew && isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-[#BAA05E]" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-4rem)]">
        {/* Topbar */}
        <div className="border-b bg-background/80 backdrop-blur-sm">
          <div className="px-6 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate('/marketing/automacoes')}
                className="-ml-2"
              >
                <ArrowLeft className="h-4 w-4 mr-1.5" /> Voltar
              </Button>
              <div className="h-5 w-px bg-border" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome da automação"
                className="h-9 text-sm font-semibold border-none shadow-none px-2 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-1 max-w-md"
              />
            </div>
            <div className="flex items-center gap-2">
              {id && id !== 'nova' && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setReportOpen(true)}>
                  <BarChart3 className="h-3.5 w-3.5" /> Relatório
                </Button>
              )}
              <Button
                onClick={handleSave}
                disabled={saveAutomation.isPending || !name.trim()}
                size="sm"
                className="bg-[#BAA05E] hover:bg-[#917D3D] gap-1.5"
              >
                {saveAutomation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Salvar
              </Button>
            </div>
          </div>
        </div>

        {/* Body: 3 colunas */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[260px_1fr] overflow-hidden">
          {/* Sidebar config + add nodes */}
          <aside className="border-r overflow-y-auto p-4 space-y-5 bg-muted/10">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Gatilho</Label>
              <Select value={triggerEvent} onValueChange={(v) => setTriggerEvent(v as TriggerEvent)}>
                <SelectTrigger className="mt-1.5 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label className="text-xs mt-3 block">Descrição</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="O que essa automação faz?"
                className="text-xs resize-none mt-1.5"
              />
            </div>

            <div className="border-t pt-4">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">
                Adicionar passo
              </Label>
              <div className="space-y-1.5">
                {[
                  { type: 'sendEmail',     label: 'Enviar Email',    desc: 'Disparar template',   icon: Mail,         color: '#BAA05E' },
                  { type: 'sendWhatsapp',  label: 'Enviar WhatsApp', desc: 'Mensagem via UAZAPI', icon: MessageSquare,color: '#22c55e' },
                  { type: 'wait',          label: 'Esperar',         desc: 'Atrasar execução',    icon: Clock,        color: '#f59e0b' },
                  { type: 'branch',        label: 'Condição (Se/Então)', desc: 'Bifurcar fluxo',  icon: GitBranch,    color: '#a855f7' },
                  { type: 'updateField',   label: 'Atualizar Campo', desc: 'Mudar stage/score',   icon: Edit3,        color: '#6366f1' },
                  { type: 'addTag',        label: 'Adicionar Tag',   desc: 'Marcar lead',         icon: Tag,          color: '#10b981' },
                  { type: 'createTask',    label: 'Criar Tarefa',    desc: 'Pra vendedor',        icon: ListTodo,     color: '#f59e0b' },
                  { type: 'end',           label: 'Fim',             desc: 'Encerrar fluxo',      icon: Square,       color: '#6b7280' },
                ].map((it) => (
                  <button
                    key={it.type}
                    onClick={() => addNode(it.type)}
                    className="w-full flex items-center gap-2 p-2 rounded-lg border hover:border-[#BAA05E]/50 hover:bg-[#BAA05E]/5 transition-all text-left"
                  >
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${it.color}20` }}
                    >
                      <it.icon className="h-3.5 w-3.5" style={{ color: it.color }} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{it.label}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{it.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <Card className="bg-blue-500/5 border-blue-500/20">
              <CardContent className="p-3 text-xs space-y-1">
                <p className="font-semibold flex items-center gap-1.5">
                  <Settings className="h-3 w-3" /> Como usar
                </p>
                <ul className="text-muted-foreground space-y-1 mt-1.5 list-disc list-inside">
                  <li>Adicione passos pela barra esquerda</li>
                  <li>Conecte arrastando do círculo de baixo pro próximo passo</li>
                  <li>Clique num passo pra configurar</li>
                  <li>Salve e ative a automação na lista</li>
                </ul>
              </CardContent>
            </Card>
          </aside>

          {/* Canvas */}
          <main className="relative bg-muted/5">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, n) => setSelectedNode(n)}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} size={1} color="#BAA05E33" />
              <Controls />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => {
                  if (n.type === 'trigger') return '#3b82f6';
                  if (n.type === 'sendEmail') return '#BAA05E';
                  if (n.type === 'wait') return '#f59e0b';
                  return '#888';
                }}
              />
            </ReactFlow>
          </main>
        </div>
      </div>

      {/* Modal pra editar node selecionado */}
      <Dialog open={!!selectedNode} onOpenChange={(open) => !open && setSelectedNode(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {selectedNode?.type === 'trigger' && '⚡ Configurar gatilho'}
              {selectedNode?.type === 'sendEmail' && '📧 Configurar envio de email'}
              {selectedNode?.type === 'sendWhatsapp' && '💬 Configurar WhatsApp'}
              {selectedNode?.type === 'wait' && '⏰ Configurar espera'}
              {selectedNode?.type === 'updateField' && '✏️ Atualizar campo do lead'}
              {selectedNode?.type === 'addTag' && '🏷️ Adicionar tag'}
              {selectedNode?.type === 'createTask' && '✅ Criar tarefa'}
              {selectedNode?.type === 'branch' && '🔀 Configurar condição'}
              {selectedNode?.type === 'end' && '⏹️ Encerrar fluxo'}
            </DialogTitle>
            <DialogDescription>
              {selectedNode?.type === 'trigger' && 'Esse gatilho dispara o fluxo. Configure o tipo de evento na barra lateral esquerda.'}
              {selectedNode?.type === 'sendEmail' && 'Escolha o template e personalize o assunto.'}
              {selectedNode?.type === 'sendWhatsapp' && 'Mensagem enviada via instância WhatsApp ativa.'}
              {selectedNode?.type === 'wait' && 'Pausa o fluxo antes de executar o próximo passo.'}
              {selectedNode?.type === 'updateField' && 'Modifica um campo do lead atual.'}
              {selectedNode?.type === 'addTag' && 'Marca o lead com uma tag pra segmentação.'}
              {selectedNode?.type === 'createTask' && 'Cria uma tarefa pro time selecionado.'}
              {selectedNode?.type === 'branch' && 'Avalia condição e bifurca fluxo em sim/não.'}
              {selectedNode?.type === 'end' && 'Encerra o fluxo pra esse lead.'}
            </DialogDescription>
          </DialogHeader>
          {selectedNode && (
            <div className="space-y-4 py-2">
              {selectedNode.type === 'sendEmail' && (
                <>
                  <div>
                    <Label className="text-xs">Template</Label>
                    <Select
                      value={(selectedNode.data.template_id as string) || ''}
                      onValueChange={(v) => {
                        const tpl = templates.find((t) => t.id === v);
                        updateNodeData(selectedNode.id, {
                          template_id: v,
                          template_name: tpl?.name,
                          subject: tpl?.subject,
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                      <SelectContent>
                        {templates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Assunto (sobrescreve do template)</Label>
                    <Input
                      value={(selectedNode.data.subject as string) || ''}
                      onChange={(e) => updateNodeData(selectedNode.id, { subject: e.target.value })}
                      placeholder="Use {{nome}} pra personalizar"
                    />
                  </div>
                </>
              )}

              {selectedNode.type === 'wait' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Duração</Label>
                    <Input
                      type="number"
                      min="1"
                      value={(selectedNode.data.duration as number) || 1}
                      onChange={(e) => updateNodeData(selectedNode.id, { duration: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Unidade</Label>
                    <Select
                      value={(selectedNode.data.unit as string) || 'dias'}
                      onValueChange={(v) => updateNodeData(selectedNode.id, { unit: v })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minutos">Minutos</SelectItem>
                        <SelectItem value="horas">Horas</SelectItem>
                        <SelectItem value="dias">Dias</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {selectedNode.type === 'updateField' && (
                <>
                  <div>
                    <Label className="text-xs">Campo</Label>
                    <Select
                      value={(selectedNode.data.field as string) || 'sales_stage'}
                      onValueChange={(v) => updateNodeData(selectedNode.id, { field: v })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sales_stage">Estágio do funil</SelectItem>
                        <SelectItem value="sales_score">Score</SelectItem>
                        <SelectItem value="status">Status</SelectItem>
                        <SelectItem value="source">Origem</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Novo valor</Label>
                    <Input
                      value={(selectedNode.data.value as string) || ''}
                      onChange={(e) => updateNodeData(selectedNode.id, { value: e.target.value })}
                      placeholder="qualificacao, 75, etc"
                    />
                  </div>
                </>
              )}

              {selectedNode.type === 'addTag' && (
                <div>
                  <Label className="text-xs">Tag</Label>
                  <Input
                    value={(selectedNode.data.tag as string) || ''}
                    onChange={(e) => updateNodeData(selectedNode.id, { tag: e.target.value })}
                    placeholder="ex: hot-lead, vip, follow-up"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Tags permitem segmentar leads</p>
                </div>
              )}

              {selectedNode.type === 'createTask' && (
                <>
                  <div>
                    <Label className="text-xs">Título da tarefa</Label>
                    <Input
                      value={(selectedNode.data.title as string) || ''}
                      onChange={(e) => updateNodeData(selectedNode.id, { title: e.target.value })}
                      placeholder="Ligar pro lead"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Time</Label>
                    <Select
                      value={(selectedNode.data.team as string) || 'comercial'}
                      onValueChange={(v) => updateNodeData(selectedNode.id, { team: v })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="comercial">Comercial</SelectItem>
                        <SelectItem value="cs">CS</SelectItem>
                        <SelectItem value="suporte">Suporte</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              {selectedNode.type === 'branch' && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Avalia uma condição. Conecta nó "sim" no handle esquerdo (verde), "não" no direito (vermelho).
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Campo</Label>
                      <Select
                        value={(selectedNode.data.condition_field as string) || 'sales_stage'}
                        onValueChange={(v) => updateNodeData(selectedNode.id, { condition_field: v })}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sales_stage">Estágio</SelectItem>
                          <SelectItem value="sales_score">Score</SelectItem>
                          <SelectItem value="email_opened">Abriu email</SelectItem>
                          <SelectItem value="email_clicked">Clicou email</SelectItem>
                          <SelectItem value="has_tag">Tem tag</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Operador</Label>
                      <Select
                        value={(selectedNode.data.condition_op as string) || '='}
                        onValueChange={(v) => updateNodeData(selectedNode.id, { condition_op: v })}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="=">igual</SelectItem>
                          <SelectItem value="!=">diferente</SelectItem>
                          <SelectItem value=">">maior</SelectItem>
                          <SelectItem value="<">menor</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Valor</Label>
                      <Input
                        value={(selectedNode.data.condition_value as string) || ''}
                        onChange={(e) => updateNodeData(selectedNode.id, { condition_value: e.target.value })}
                      />
                    </div>
                  </div>
                </>
              )}

              {selectedNode.type === 'sendWhatsapp' && (
                <>
                  <div>
                    <Label className="text-xs">Mensagem</Label>
                    <Textarea
                      value={(selectedNode.data.message as string) || ''}
                      onChange={(e) => updateNodeData(selectedNode.id, { message: e.target.value })}
                      placeholder="Olá {{nome}}, tudo bem?"
                      rows={4}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Use {'{{nome}}'}, {'{{empresa}}'} pra personalizar
                    </p>
                  </div>
                </>
              )}

              {selectedNode.type === 'end' && (
                <div>
                  <Label className="text-xs">Motivo do fim</Label>
                  <Select
                    value={(selectedNode.data.reason as string) || 'completed'}
                    onValueChange={(v) => updateNodeData(selectedNode.id, { reason: v })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="completed">Concluído (objetivo atingido)</SelectItem>
                      <SelectItem value="goal">Goal alcançado</SelectItem>
                      <SelectItem value="cancelled">Cancelado</SelectItem>
                      <SelectItem value="no_match">Não se aplica mais</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

            </div>
          )}
          <DialogFooter className="flex sm:justify-between gap-2">
            {selectedNode && selectedNode.type !== 'trigger' ? (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive gap-2"
                onClick={() => deleteNode(selectedNode.id)}
              >
                <Trash2 className="h-4 w-4" /> Remover passo
              </Button>
            ) : <div />}
            <Button
              onClick={() => setSelectedNode(null)}
              className="bg-[#BAA05E] hover:bg-[#917D3D]"
            >
              Pronto
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {id && id !== 'nova' && (
        <AutomationReportSheet
          open={reportOpen}
          onOpenChange={setReportOpen}
          automationId={id}
          automationName={name}
        />
      )}
    </AppLayout>
  );
}
