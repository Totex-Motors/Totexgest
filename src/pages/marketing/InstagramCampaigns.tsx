import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Instagram, Plus, Pencil, Trash2, Loader2, AlertTriangle, Megaphone,
  KeyRound, Bot, Settings, MessageCircle, Send, Reply, ExternalLink,
} from "lucide-react";

// ============================================================
// Marketing → Campanhas Instagram
// ============================================================
// Operação do dia a dia: campanhas comentário→DM e gatilhos de
// palavra-chave, com métricas por campanha. Tokens e modo teste
// ficam em Configurações → Instagram Oficial (config, não operação).
// ============================================================

interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  post_id: string;
  post_permalink: string | null;
  keyword_mode: string;
  keywords: string[] | null;
  reply_mode: string;
  dm_template: string | null;
  agent_slug: string | null;
  delay_min_seconds: number;
  delay_max_seconds: number;
  once_per_user: boolean;
  process_existing: boolean;
  status: string;
}

interface KeywordTrigger {
  id: string;
  label: string;
  keyword: string;
  material_link: string;
  active: boolean;
}

interface IGMedia {
  id: string;
  permalink?: string;
  caption?: string;
  media_url?: string;
  thumbnail_url?: string;
  comments_count?: number;
  timestamp?: string;
}

interface Metrics {
  comentaram: number;
  dms_enviadas: number;
  responderam: number;
  falhas: number;
}

// ---------- Métricas por campanha ----------
function CampaignMetrics({ metrics }: { metrics: Metrics }) {
  const taxa = metrics.dms_enviadas > 0
    ? Math.round((metrics.responderam / metrics.dms_enviadas) * 100) : 0;
  const items = [
    { icon: MessageCircle, label: "comentaram", value: metrics.comentaram },
    { icon: Send, label: "DMs enviadas", value: metrics.dms_enviadas },
    { icon: Reply, label: `responderam (${taxa}%)`, value: metrics.responderam },
  ];
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      {items.map((m) => (
        <span key={m.label} className="flex items-center gap-1.5 text-muted-foreground">
          <m.icon className="h-3.5 w-3.5" />
          <strong className="text-foreground">{m.value}</strong> {m.label}
        </span>
      ))}
      {metrics.falhas > 0 && (
        <span className="flex items-center gap-1.5 text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          <strong>{metrics.falhas}</strong> falhas
        </span>
      )}
    </div>
  );
}

// ---------- Aviso: agente do Instagram ainda não existe ----------
function AgentMissingAlert({ agents }: { agents: { slug: string }[] }) {
  if (agents.length > 0) return null;
  return (
    <Alert>
      <Bot className="h-4 w-4" />
      <AlertTitle>Você ainda não criou o agente do Instagram</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-sm">
          As campanhas no modo agente precisam de um agente criado — senão a DM não sai.
          Em <strong>Agentes IA → Meus agentes → + Novo agente</strong> escolha o template
          <strong> "Instagram — Primeiro Contato"</strong> e preencha seu nome, seu @ e o
          que o negócio faz. É essa calibração que faz o agente não soar como robô.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link to="/agentes">
            <Bot className="mr-2 h-4 w-4" /> Criar o agente agora
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// ---------- Campanhas ----------
function CampaignsPanel({ tenantId, agents }: {
  tenantId: string; agents: { slug: string; display_name: string }[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ["ig-campaigns", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("instagram_comment_campaigns")
        .select("*").eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as Campaign[];
    },
    enabled: !!tenantId,
  });

  // Métricas de todas as campanhas numa query só (agrupadas no cliente)
  const { data: metrics = {} } = useQuery({
    queryKey: ["ig-campaign-metrics", tenantId],
    queryFn: async () => {
      const { data } = await supabase
        .from("instagram_comment_campaign_recipients")
        .select("campaign_id, dm_status, replied_at")
        .eq("tenant_id", tenantId);
      const acc: Record<string, Metrics> = {};
      for (const r of data || []) {
        const m = acc[r.campaign_id] ||= { comentaram: 0, dms_enviadas: 0, responderam: 0, falhas: 0 };
        m.comentaram++;
        if (r.dm_status === "sent") m.dms_enviadas++;
        if (r.dm_status === "failed") m.falhas++;
        if (r.replied_at) m.responderam++;
      }
      return acc;
    },
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });

  const toggle = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase.from("instagram_comment_campaigns")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id).eq("tenant_id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ig-campaigns", tenantId] }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("instagram_comment_campaigns")
        .delete().eq("id", id).eq("tenant_id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ig-campaigns", tenantId] });
      toast({ title: "Campanha removida" });
    },
  });

  return (
    <div className="space-y-4">
      <AgentMissingAlert agents={agents} />

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Crie a campanha ANTES de publicar o post</AlertTitle>
        <AlertDescription className="text-sm">
          Se alguém comentar antes da campanha existir, o agente responde sem contexto e
          pode prometer material que não existe.
        </AlertDescription>
      </Alert>

      <div className="flex justify-end">
        <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="mr-2 h-4 w-4" /> Nova campanha
        </Button>
      </div>

      {isLoading && <Loader2 className="h-5 w-5 animate-spin" />}
      {!isLoading && campaigns.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhuma campanha ainda. Crie uma para que quem comentar a palavra-chave
            no seu post receba uma DM automática.
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {campaigns.map((c) => (
          <Card key={c.id}>
            <CardContent className="space-y-3 pt-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <Badge variant={c.status === "active" ? "secondary" : "outline"}>
                      {c.status === "active" ? "ativa" : c.status}
                    </Badge>
                    <Badge variant="outline">
                      {c.reply_mode === "agent" ? `agente: ${c.agent_slug}` : "mensagem fixa"}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    post {c.post_id}
                    {c.keyword_mode === "all"
                      ? " · qualquer comentário"
                      : ` · palavra: ${(c.keywords || []).join(", ")}`}
                    {c.post_permalink && (
                      <a href={c.post_permalink} target="_blank" rel="noreferrer"
                        className="ml-2 inline-flex items-center gap-1 underline">
                        ver post <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch checked={c.status === "active"}
                    onCheckedChange={(on) => toggle.mutate({ id: c.id, status: on ? "active" : "paused" })} />
                  <Button variant="ghost" size="icon"
                    onClick={() => { setEditing(c); setModalOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => {
                    if (confirm(`Remover a campanha "${c.name}"?`)) del.mutate(c.id);
                  }}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <CampaignMetrics
                metrics={metrics[c.id] || { comentaram: 0, dms_enviadas: 0, responderam: 0, falhas: 0 }} />
            </CardContent>
          </Card>
        ))}
      </div>

      <CampaignModal
        open={modalOpen} onOpenChange={setModalOpen}
        campaign={editing} tenantId={tenantId} agents={agents}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["ig-campaigns", tenantId] });
          qc.invalidateQueries({ queryKey: ["ig-campaign-metrics", tenantId] });
        }}
      />
    </div>
  );
}

function CampaignModal({ open, onOpenChange, campaign, tenantId, agents, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  campaign: Campaign | null; tenantId: string;
  agents: { slug: string; display_name: string }[]; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [form, setForm] = useState({
    name: "", post_id: "", post_permalink: "", keyword_mode: "contains", keyword: "",
    reply_mode: "agent", agent_slug: "", dm_template: "",
    delay_min_seconds: 15, delay_max_seconds: 45,
    once_per_user: true, process_existing: true,
  });

  // Posts da conta conectada — o usuário escolhe pela miniatura, nunca digita ID.
  const { data: media = [], isLoading: loadingMedia } = useQuery({
    queryKey: ["ig-recent-media", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("instagram-list-media", { body: {} });
      if (error) throw error;
      return (data?.media || []) as IGMedia[];
    },
    enabled: open,
    staleTime: 60_000,
  });
  const selectedMedia = media.find((m) => m.id === form.post_id);

  if (open && !initialized) {
    setForm({
      name: campaign?.name || "",
      post_id: campaign?.post_id || "",
      post_permalink: campaign?.post_permalink || "",
      keyword_mode: campaign?.keyword_mode || "contains",
      keyword: (campaign?.keywords || [])[0] || "",
      reply_mode: campaign?.reply_mode || "agent",
      agent_slug: campaign?.agent_slug || agents[0]?.slug || "",
      dm_template: campaign?.dm_template || "",
      delay_min_seconds: campaign?.delay_min_seconds ?? 15,
      delay_max_seconds: campaign?.delay_max_seconds ?? 45,
      once_per_user: campaign?.once_per_user ?? true,
      process_existing: campaign?.process_existing ?? true,
    });
    setInitialized(true);
  }
  if (!open && initialized) setInitialized(false);

  const save = async () => {
    if (!form.name.trim()) return toast({ title: "Dê um nome à campanha", variant: "destructive" });
    if (!form.post_id.trim()) {
      return toast({ title: "Escolha o post da campanha", variant: "destructive" });
    }
    if (form.keyword_mode === "contains" && !form.keyword.trim()) {
      return toast({ title: "Informe a palavra-chave", variant: "destructive" });
    }
    // Template não tria comentário: com "qualquer comentário" o material iria
    // pra quem só elogiou. Só o agente consegue triar comentário livre.
    if (form.reply_mode === "template" && form.keyword_mode === "all") {
      return toast({
        title: "Combinação não permitida",
        description: "Mensagem fixa + qualquer comentário mandaria o material pra quem só elogiou. Use uma palavra-chave, ou mude para o modo agente.",
        variant: "destructive",
      });
    }
    if (form.reply_mode === "agent" && !form.agent_slug) {
      return toast({
        title: "Escolha o agente",
        description: "Sem agente criado a DM não sai. Crie um em Agentes IA.",
        variant: "destructive",
      });
    }

    setSaving(true);
    try {
      const payload = {
        tenant_id: tenantId,
        name: form.name.trim(),
        post_id: form.post_id.trim(),
        post_permalink: form.post_permalink.trim() || null,
        keyword_mode: form.keyword_mode,
        keywords: form.keyword_mode === "contains" ? [form.keyword.trim().toLowerCase()] : [],
        reply_mode: form.reply_mode,
        agent_slug: form.reply_mode === "agent" ? form.agent_slug : null,
        dm_template: form.dm_template.trim() || null,
        delay_min_seconds: form.delay_min_seconds,
        delay_max_seconds: form.delay_max_seconds,
        once_per_user: form.once_per_user,
        process_existing: form.process_existing,
        updated_at: new Date().toISOString(),
      };
      const { error } = campaign
        ? await supabase.from("instagram_comment_campaigns")
            .update(payload).eq("id", campaign.id).eq("tenant_id", tenantId)
        : await supabase.from("instagram_comment_campaigns")
            .insert({ ...payload, status: "active" });
      if (error) throw error;
      toast({ title: campaign ? "Campanha atualizada" : "Campanha criada" });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Erro ao salvar", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{campaign ? "Editar campanha" : "Nova campanha comentário → DM"}</DialogTitle>
          <DialogDescription>
            Quem comentar no post recebe uma DM automática — a Meta permite 1 por comentário,
            válida por 7 dias.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Nome *</Label>
            <Input value={form.name} placeholder="Aula de captação — post 12/07"
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>

          <div className="space-y-2">
            <Label>Escolha o post *</Label>
            {loadingMedia ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> carregando seus posts...
              </p>
            ) : media.length === 0 ? (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  Nenhum post encontrado nessa conta. Publique um post no Instagram
                  (de preferência com um CTA, tipo "comenta QUERO que eu te mando") e
                  reabra essa tela.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="grid max-h-60 grid-cols-4 gap-2 overflow-y-auto rounded-lg border p-2">
                  {media.map((m) => (
                    <button
                      key={m.id} type="button"
                      onClick={() => setForm({
                        ...form,
                        post_id: m.id,
                        post_permalink: m.permalink || "",
                      })}
                      className={`relative overflow-hidden rounded-lg border-2 transition-colors ${
                        form.post_id === m.id
                          ? "border-primary"
                          : "border-transparent hover:border-muted-foreground/30"
                      }`}
                    >
                      {m.thumbnail_url || m.media_url ? (
                        <img src={m.thumbnail_url || m.media_url} alt=""
                          className="aspect-square w-full object-cover" />
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center bg-muted">
                          <Instagram className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                      <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                        {m.comments_count ?? 0} coment.
                      </span>
                    </button>
                  ))}
                </div>
                {selectedMedia && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    Selecionado: {(selectedMedia.caption || "(sem legenda)").slice(0, 140)}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Quem entra na campanha</Label>
              <Select value={form.keyword_mode}
                onValueChange={(v) => setForm({ ...form, keyword_mode: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">Quem comentar a palavra-chave</SelectItem>
                  <SelectItem value="all">Qualquer comentário</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.keyword_mode === "contains" && (
              <div className="space-y-1.5">
                <Label>Palavra-chave *</Label>
                <Input value={form.keyword} placeholder="quero"
                  onChange={(e) => setForm({ ...form, keyword: e.target.value })} />
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Quem responde</Label>
              <Select value={form.reply_mode}
                onValueChange={(v) => setForm({ ...form, reply_mode: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Agente de IA (recomendado)</SelectItem>
                  <SelectItem value="template">Mensagem fixa</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.reply_mode === "agent" && (
              <div className="space-y-1.5">
                <Label>Agente</Label>
                <Select value={form.agent_slug}
                  onValueChange={(v) => setForm({ ...form, agent_slug: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder={agents.length ? "Escolha o agente" : "Nenhum agente criado"} />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.slug} value={a.slug}>{a.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{form.reply_mode === "agent" ? "Material da campanha" : "Mensagem da DM"}</Label>
            <Textarea rows={3} value={form.dm_template}
              placeholder={"Aula de captação\nhttps://seusite.com/aula"}
              onChange={(e) => setForm({ ...form, dm_template: e.target.value })} />
            <p className="text-xs text-muted-foreground">
              {form.reply_mode === "agent"
                ? "No modo agente isso NÃO é enviado literal — é o material que o agente vai entregar. O que importa aqui é o LINK; a mensagem o agente escreve no tom dele."
                : "Essa mensagem é enviada exatamente como está."}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Espera mínima (s)</Label>
              <Input type="number" value={form.delay_min_seconds}
                onChange={(e) => setForm({ ...form, delay_min_seconds: Number(e.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label>Espera máxima (s)</Label>
              <Input type="number" value={form.delay_max_seconds}
                onChange={(e) => setForm({ ...form, delay_max_seconds: Number(e.target.value) })} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            A DM sai após uma espera aleatória nesse intervalo — responder no mesmo segundo
            denuncia automação.
          </p>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Uma DM por pessoa</Label>
                <p className="text-xs text-muted-foreground">Se comentar de novo, não recebe duplicado.</p>
              </div>
              <Switch checked={form.once_per_user}
                onCheckedChange={(v) => setForm({ ...form, once_per_user: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Processar comentários já existentes</Label>
                <p className="text-xs text-muted-foreground">
                  Pega quem comentou antes da campanha ser criada (limite de 7 dias da Meta).
                </p>
              </div>
              <Switch checked={form.process_existing}
                onCheckedChange={(v) => setForm({ ...form, process_existing: v })} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Gatilhos de palavra-chave ----------
function TriggersPanel({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ label: "", keyword: "", material_link: "" });

  const { data: triggers = [] } = useQuery({
    queryKey: ["ig-triggers", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from("ig_dm_keyword_triggers")
        .select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as KeywordTrigger[];
    },
    enabled: !!tenantId,
  });

  const add = async () => {
    if (!form.label.trim() || !form.keyword.trim() || !form.material_link.trim()) {
      return toast({ title: "Preencha nome, palavra e link", variant: "destructive" });
    }
    if (!/^https?:\/\//.test(form.material_link.trim())) {
      return toast({ title: "O link precisa começar com http", variant: "destructive" });
    }
    setSaving(true);
    try {
      const kw = form.keyword.trim().toLowerCase();
      const { error } = await supabase.from("ig_dm_keyword_triggers").insert({
        tenant_id: tenantId,
        label: form.label.trim(),
        keyword: kw,
        material_link: form.material_link.trim(),
        utm_campaign: kw,
        utm_medium: "story",
        agent_slug: "ig-primeiro-contato",
        active: true,
      });
      if (error) throw error;
      setForm({ label: "", keyword: "", material_link: "" });
      qc.invalidateQueries({ queryKey: ["ig-triggers", tenantId] });
      toast({ title: "Gatilho criado" });
    } catch (e) {
      toast({ title: "Erro", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (t: KeywordTrigger) => {
    await supabase.from("ig_dm_keyword_triggers")
      .update({ active: !t.active, updated_at: new Date().toISOString() })
      .eq("id", t.id).eq("tenant_id", tenantId);
    qc.invalidateQueries({ queryKey: ["ig-triggers", tenantId] });
  };

  const remove = async (id: string) => {
    await supabase.from("ig_dm_keyword_triggers").delete().eq("id", id).eq("tenant_id", tenantId);
    qc.invalidateQueries({ queryKey: ["ig-triggers", tenantId] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" /> Gatilhos de palavra-chave
        </CardTitle>
        <CardDescription>
          Quando alguém manda a palavra no direct (respondendo um story, por exemplo),
          o agente entrega o material — mesmo sem ter comentado em post nenhum.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Nome</Label>
            <Input value={form.label} placeholder="Aula de captação"
              onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Palavra</Label>
            <Input value={form.keyword} placeholder="call"
              onChange={(e) => setForm({ ...form, keyword: e.target.value })} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Link do material</Label>
          <Input value={form.material_link} placeholder="https://seusite.com/aula"
            onChange={(e) => setForm({ ...form, material_link: e.target.value })} />
        </div>
        <Button onClick={add} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Plus className="mr-2 h-4 w-4" /> Adicionar gatilho
        </Button>

        <div className="space-y-2 pt-2">
          {triggers.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  palavra "{t.keyword}" → {t.material_link}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch checked={t.active} onCheckedChange={() => toggle(t)} />
                <Button variant="ghost" size="icon" onClick={() => remove(t.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Página ----------
export default function InstagramCampaigns() {
  const { tenantId } = useAuth();

  // Conta conectada? Sem ela nada funciona — avisa e manda pra Configurações.
  const { data: accounts = [] } = useQuery({
    queryKey: ["ig-accounts-check", tenantId],
    queryFn: async () => {
      const { data } = await supabase.from("instagram_business_accounts")
        .select("id, instagram_username").eq("tenant_id", tenantId!).eq("status", "connected");
      return data || [];
    },
    enabled: !!tenantId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ["agents-for-ig", tenantId],
    queryFn: async () => {
      const { data } = await supabase.from("agents_registry")
        .select("slug, display_name").eq("is_template", false).eq("is_active", true)
        .order("display_name");
      return (data || []) as { slug: string; display_name: string }[];
    },
    enabled: !!tenantId,
  });

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Instagram className="h-6 w-6" /> Campanhas Instagram
            </h1>
            <p className="text-sm text-muted-foreground">
              Comentou no post → recebe DM do agente. Acompanhe quantos entraram e responderam.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/configuracoes?s=instagram">
              <Settings className="mr-2 h-4 w-4" /> Conta e tokens
            </Link>
          </Button>
        </div>

        {!tenantId ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : accounts.length === 0 ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Nenhuma conta do Instagram conectada</AlertTitle>
            <AlertDescription className="space-y-2">
              <p className="text-sm">
                Conecte a conta em Configurações → Instagram Oficial antes de criar campanhas.
              </p>
              <Button asChild size="sm" variant="outline">
                <Link to="/configuracoes?s=instagram">Conectar conta</Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Tabs defaultValue="campanhas" className="space-y-4">
            <TabsList>
              <TabsTrigger value="campanhas" className="gap-1.5">
                <Megaphone className="h-4 w-4" /> Campanhas
              </TabsTrigger>
              <TabsTrigger value="gatilhos" className="gap-1.5">
                <KeyRound className="h-4 w-4" /> Gatilhos
              </TabsTrigger>
            </TabsList>
            <TabsContent value="campanhas">
              <CampaignsPanel tenantId={tenantId} agents={agents} />
            </TabsContent>
            <TabsContent value="gatilhos">
              <TriggersPanel tenantId={tenantId} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}
