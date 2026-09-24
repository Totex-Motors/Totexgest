import React, { useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { RoleRoute } from "@/components/auth/RoleRoute";
import { CallProvider } from "@/contexts/CallContext";
import { MeetingProvider } from "@/contexts/MeetingContext";
import { GlobalTranscriptionPanel } from "@/components/meeting/GlobalTranscriptionPanel";
import { MeetingRecoveryBanner } from "@/components/meeting/MeetingRecoveryBanner";
import { NotificationProvider } from "@/hooks/useNotifications";
import { CallModals } from "@/components/calls";
import { FocusModeProvider } from "@/contexts/FocusModeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { DemoModeProvider } from "@/contexts/DemoModeContext";
import { FocusModeOverlay } from "@/components/focus-mode/FocusModeOverlay";

// Error Boundary para componentes auxiliares (toast discreto)
class ErrorBoundary extends Component<{ children: ReactNode; name?: string }, { hasError: boolean; error?: Error }> {
  state = { hasError: false, error: undefined as Error | undefined };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}]`, error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed bottom-4 right-4 z-50 bg-red-50 border border-red-200 rounded-lg p-3 max-w-sm shadow-lg">
          <p className="text-sm font-medium text-red-800">Erro no componente{this.props.name ? ` ${this.props.name}` : ''}</p>
          <p className="text-xs text-red-600 mt-1">{this.state.error?.message}</p>
          <button className="text-xs text-red-700 underline mt-2" onClick={() => this.setState({ hasError: false })}>Tentar novamente</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Error Boundary para rotas — tela cheia com reload
class RouteErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  state = { hasError: false, error: undefined as Error | undefined };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[RouteErrorBoundary]', error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <div className="text-center max-w-md space-y-4">
            <div className="text-4xl">:(</div>
            <h1 className="text-xl font-bold text-foreground">Algo deu errado</h1>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message || 'Erro inesperado na aplicação'}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
                onClick={() => this.setState({ hasError: false })}
              >
                Tentar novamente
              </button>
              <button
                className="px-4 py-2 bg-muted text-foreground rounded-md text-sm font-medium hover:bg-muted/80"
                onClick={() => window.location.reload()}
              >
                Recarregar pagina
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Auth pages
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import NotFound from "./pages/NotFound";
const RepasseLanding = React.lazy(() => import("./pages/RepasseLanding"));
const McpConsent = React.lazy(() => import("./pages/McpConsent"));

// Settings unificada + WhatsApp
import SettingsUnified from "./pages/SettingsUnified";
const MyWhatsApp = React.lazy(() => import("./pages/MyWhatsApp"));
const GestaoMelhorias = React.lazy(() => import("./pages/GestaoMelhorias"));

// Plataforma de Agentes IA
const AgentList = React.lazy(() => import("./agents-platform/pages/AgentList"));
const AgentConfigPage = React.lazy(() => import("./agents-platform/pages/AgentConfigPage"));
const AgentChatPage = React.lazy(() => import("./agents-platform/pages/AgentChatPage"));
const AgentPlaygroundPage = React.lazy(() => import("./agents-platform/pages/AgentPlaygroundPage"));
const AgentSkillsLibraryPage = React.lazy(() => import("./agents-platform/pages/AgentSkillsLibraryPage"));
const AgentCredentialsPage = React.lazy(() => import("./agents-platform/pages/AgentCredentialsPage"));
const AgentSessionsPage = React.lazy(() => import("./agents-platform/pages/AgentSessionsPage"));
const AgentMetricsPage = React.lazy(() => import("./agents-platform/pages/AgentMetricsPage"));
const AgentOrgChartPage = React.lazy(() => import("./agents-platform/pages/AgentOrgChartPage"));

// Sales/Commercial pages (core CRM)
import SalesDashboard from "./pages/SalesDashboardV3";
import SalesTeamView from "./pages/SalesTeamView";
import SalesLeads from "./pages/SalesLeads";
import SalesPipeline from "./pages/SalesPipeline";
import SalesDeals from "./pages/SalesDeals";
import SalesWhatsAppInbox from "./pages/SalesWhatsAppInbox";
import SalesLeadDetail from "./pages/SalesLeadDetail";
import SalesDealDetail from "./pages/SalesDealDetail";
import Commissions from "./pages/Commissions";
import SalesPlaybook from "./pages/SalesPlaybook";
import SalesWorkspace from "./pages/SalesWorkspace";
import SalesAgenda from "./pages/SalesAgendaV2";
import SalesMaterialsConfig from "./pages/SalesMaterialsConfig";
import CockpitShell from "./pages/CockpitShell";
import CredereLeads from "./pages/CredereLeads";
import MarketplaceLeads from "./pages/MarketplaceLeads";
import TotemLeads from "./pages/TotemLeads";

// Gestão básica
import TaskManagement from "./pages/TaskManagement";
import TeamCalendar from "./pages/TeamCalendar";
import TeamMeetings from "./pages/TeamMeetings";

// Marketing (Email + WhatsApp + Automações) — disparo de campanhas multi-tenant
import MarketingDashboard from "./pages/MarketingDashboard";
import EmailMarketingHub from "./pages/EmailMarketingHub";
import EmailCampaignNew from "./pages/EmailCampaignNew";
import EmailCampaignDetail from "./pages/EmailCampaignDetail";
import EmailTemplates from "./pages/EmailTemplates";
import EmailTemplateEditor from "./pages/EmailTemplateEditor";
import MarketingAutomations from "./pages/marketing/MarketingAutomations";
import MarketingAutomationEditor from "./pages/marketing/MarketingAutomationEditor";
import WhatsAppTemplates from "./pages/WhatsAppTemplates";
import WhatsAppTemplateNew from "./pages/WhatsAppTemplateNew";
import SalesCampaigns from "./pages/SalesCampaigns";
import SalesCampaignNew from "./pages/SalesCampaignNew";
import SalesCampaignDetail from "./pages/SalesCampaignDetail";

// Inteligência de Demanda (dashboards de comportamento do consumidor)
const DemandIntelligence = React.lazy(() => import("./pages/DemandIntelligence"));

// Lead Ads Meta + Canais de Entrada + Importação (portados do template v3)
const MetaLeadAds = React.lazy(() => import("./pages/MetaLeadAds"));
const InstagramCampaigns = React.lazy(() => import("./pages/marketing/InstagramCampaigns"));
const CanaisEntrada = React.lazy(() => import("./pages/CanaisEntrada"));
const OperationTower = React.lazy(() => import("./pages/OperationTower"));
const IntermediationDashboard = React.lazy(() => import("./pages/IntermediationDashboard"));
const NetworkDashboard = React.lazy(() => import("./pages/NetworkDashboard"));
const ApprovalsInbox = React.lazy(() => import("./pages/ApprovalsInbox"));
const ImportLeads = React.lazy(() => import("./pages/ImportLeads"));
const MarketingForms = React.lazy(() => import("./pages/MarketingForms"));

// Captação de veículos (promotoras) — workspace mobile-first separado do CRM
const CaptureLayout = React.lazy(() => import("./layouts/CaptureLayout"));
const CaptureHome = React.lazy(() => import("./pages/capture/CaptureHome"));
const CaptureNewLead = React.lazy(() => import("./pages/capture/CaptureNewLead"));
const CaptureMyLeads = React.lazy(() => import("./pages/capture/CaptureMyLeads"));
const CaptureMyVehicles = React.lazy(() => import("./pages/capture/CaptureMyVehicles"));
const CapturePrizes = React.lazy(() => import("./pages/capture/CapturePrizes"));
const CaptureRepasse = React.lazy(() => import("./pages/capture/CaptureRepasse"));
const CommercialTraining = React.lazy(() => import("./pages/CommercialTraining"));

// Public booking
const BookMeeting = React.lazy(() => import("./pages/BookMeeting"));
// Unsubscribe público (LGPD) — sem auth
const Unsubscribe = React.lazy(() => import("./pages/public/Unsubscribe"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        const status = error?.status || error?.code;
        const msg = error?.message || '';
        console.warn(`[RQ] Query falhou (tentativa ${failureCount + 1}):`, status, msg);
        // Não retry em erros de auth (401/403) — recovery cuida disso
        if (status === 401 || status === 403) return false;
        // Até 3 retries com backoff para erros de rede/timeout
        return failureCount < 3;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
      staleTime: 30000, // 30s - evita refetch excessivo
      refetchOnWindowFocus: true, // Re-habilitado — essencial para recovery de queries que falharam
      refetchOnReconnect: true,
      gcTime: 1000 * 60 * 10, // 10 min — cache persiste mais tempo, evita loading ao voltar
    },
  },
});

/**
 * Guarda de SESSÃO. Também segura a promotora dentro do /captacao: qualquer
 * rota do CRM completo (que não seja `scope="captacao"`) redireciona ela pra
 * home dela. Esconder item da sidebar não basta — a URL digitada tem que bater aqui.
 */
function ProtectedRoute({ children, scope = "crm" }: { children: React.ReactNode; scope?: "crm" | "captacao" }) {
  const { user, loading, isPasswordRecovery, isPromotora } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  // If user is in password recovery mode, redirect to reset page
  if (isPasswordRecovery) {
    return <Navigate to="/reset-password" replace />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (scope === "crm" && isPromotora) {
    return <Navigate to="/captacao" replace />;
  }

  return <>{children}</>;
}

// Escuta eventos 'app-navigate' disparados de fora do BrowserRouter (ex: notificações)
// e faz navegação client-side sem recarregar a página (preserva chamadas WaVoIP ativas)
const NavigationListener = () => {
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (e: Event) => {
      const url = (e as CustomEvent<string>).detail;
      if (url) navigate(url);
    };
    window.addEventListener('app-navigate', handler);
    return () => window.removeEventListener('app-navigate', handler);
  }, [navigate]);
  return null;
};

const AppRoutes = () => {
  return (
    <Routes>
      {/* Rotas públicas */}
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/agendar" element={
        <React.Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-500"></div></div>}>
          <BookMeeting />
        </React.Suspense>
      } />
      {/* Consentimento OAuth do Segundo Cérebro (MCP) — login + autorizar a IA */}
      <Route path="/oauth/consent" element={
        <React.Suspense fallback={<div className="min-h-screen bg-slate-950 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div></div>}>
          <McpConsent />
        </React.Suspense>
      } />
      {/* Landing pública do cartão NFC de repasse (confirma WhatsApp → grupo) */}
      <Route path="/r/:code" element={
        <React.Suspense fallback={<div className="min-h-screen bg-emerald-50 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div></div>}>
          <RepasseLanding />
        </React.Suspense>
      } />

      {/* Home → Dashboard Comercial (promotora é redirecionada pra /captacao pelo ProtectedRoute) */}
      <Route path="/" element={<Navigate to="/comercial" replace />} />
      {/* Atalhos PWA antigos apontavam pra /app/ (manifest cacheado) → não davam 404.
          Redireciona /app e /app/* pra home, sem depender do cache do manifest. */}
      <Route path="/app" element={<Navigate to="/comercial" replace />} />
      <Route path="/app/*" element={<Navigate to="/comercial" replace />} />

      {/* Captação de veículos — promotora (e gestores/admin pra acompanhar). Sem AppSidebar. */}
      <Route
        path="/captacao"
        element={
          <ProtectedRoute scope="captacao">
            <RoleRoute allow={["promotora", "admin", "comercial", "closer", "sdr", "geral"]}>
              <React.Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>}>
                <CaptureLayout />
              </React.Suspense>
            </RoleRoute>
          </ProtectedRoute>
        }
      >
        <Route index element={<React.Suspense fallback={<div />}><CaptureHome /></React.Suspense>} />
        <Route path="novo" element={<React.Suspense fallback={<div />}><CaptureNewLead /></React.Suspense>} />
        <Route path="leads" element={<React.Suspense fallback={<div />}><CaptureMyLeads /></React.Suspense>} />
        <Route path="carros" element={<React.Suspense fallback={<div />}><CaptureMyVehicles /></React.Suspense>} />
        <Route path="premios" element={<React.Suspense fallback={<div />}><CapturePrizes /></React.Suspense>} />
        <Route path="repasse" element={<React.Suspense fallback={<div />}><CaptureRepasse /></React.Suspense>} />
        {/* rotas antigas → abas da tela Prêmios */}
        <Route path="treino" element={<Navigate to="/captacao/premios?tab=treino" replace />} />
        <Route path="perfil" element={<Navigate to="/captacao/premios?tab=perfil" replace />} />
      </Route>

      {/* Configurações */}
      <Route path="/configuracoes" element={<ProtectedRoute><SettingsUnified /></ProtectedRoute>} />
      <Route path="/settings" element={<Navigate to="/configuracoes" replace />} />
      <Route path="/whatsapp" element={<Navigate to="/configuracoes?s=whatsapp" replace />} />
      <Route path="/meu-whatsapp" element={<ProtectedRoute><React.Suspense fallback={<div />}><MyWhatsApp /></React.Suspense></ProtectedRoute>} />

      {/* Plataforma de Agentes IA — rotas FIXAS antes das :slug (senão "habilidades" vira slug) */}
      <Route path="/agentes" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentList /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/habilidades" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentSkillsLibraryPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/credenciais" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentCredentialsPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/organograma" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentOrgChartPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/sessoes" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentSessionsPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/metricas" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentMetricsPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/playground" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentPlaygroundPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/:slug" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentChatPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/:slug/config" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentConfigPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/:slug/chat" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentChatPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/:slug/playground" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentPlaygroundPage /></React.Suspense></ProtectedRoute>} />
      <Route path="/agentes/:slug/sessoes" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentSessionsPage /></React.Suspense></ProtectedRoute>} />
      <Route x�h��춻�q�^vea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type TrainingAssignment = {
  id: string;
  tenant_id: string;
  member_id: string;
  title: string;
  description: string | null;
  storage_path: string;
  is_published: boolean;
  created_at: string;
};

type TrainingMember = { id: string; name: string; email: string };
const BUCKET = "commercial-training";
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export default function CommercialTraining() {
  const { teamMember, tenantId, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [memberId, setMemberId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [loadingVideoId, setLoadingVideoId] = useState<string | null>(null);

  useEffect(() => () => {
    if (playing?.url) URL.revokeObjectURL(playing.url);
  }, [playing]);

  const assignments = useQuery({
    queryKey: ["commercial-training-videos", tenantId, teamMember?.id, isAdmin],
    enabled: !!tenantId && !!teamMember,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("training_video_assignments")
        .select("id, tenant_id, member_id, title, description, storage_path, is_published, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TrainingAssignment[];
    },
  });

  const members = useQuery({
    queryKey: ["commercial-training-members", tenantId],
    enabled: isAdmin && !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("team_members")
        .select("id, name, email, role")
        .eq("tenant_id", tenantId!)
        .eq("is_active", true)
        .in("role", ["comercial", "closer", "sdr"])
        .order("name");
      if (error) throw error;
      return (data ?? []) as TrainingMember[];
    },
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!tenantId || !teamMember || !memberId || !file || !title.trim()) {
        throw new Error("Preencha o título, escolha o vendedor e selecione o vídeo.");
      }
      if (!members.data?.some((member) => member.id === memberId)) {
        throw new Error("Escolha um vendedor ativo deste tenant.");
      }
      if (file.size > MAX_VIDEO_BYTES) throw new Error("O vídeo deve ter no máximo 100 MB.");
      if (file.type !== "video/mp4" && !file.name.toLowerCase().endsWith(".mp4")) {
        throw new Error("Envie o vídeo em formato MP4.");
      }

      const path = `${tenantId}/${memberId}/${crypto.randomUUID()}.mp4`;
      const { error: storageError } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: "video/mp4",
        cacheControl: "3600",
        upsert: false,
      });
      if (storageError) throw storageError;

      const { error: insertError } = await (supabase as any)
        .from("training_video_assignments")
        .insert({
          tenant_id: tenantId,
          member_id: memberId,
          title: title.trim(),
          description: description.trim() || null,
          storage_path: path,
          is_published: true,
        });

      if (insertError) {
        await supabase.storage.from(BUCKET).remove([path]);
        throw insertError;
      }
      return path;
    },
    onSuccess: async () => {
      toast.success("Vídeo enviado e atribuído ao vendedor.");
      setTitle("");
      setDescription("");
      setMemberId("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await queryClient.invalidateQueries({ queryKey: ["commercial-training-videos"] });
    },
    onError: (error) => toast.error((error as Error).message || "Não foi possível enviar o vídeo."),
  });

  const play = async (item: TrainingAssignment) => {
    setLoadingVideoId(item.id);
    try {
      // download() exige o JWT da sessão e revalida o RLS do objeto; não cria URL
      // assinada compartilhável que continue acessível a outro tenant.
      const { data, error } = await supabase.storage.from(BUCKET).download(item.storage_path);
      if (error || !data) throw error ?? new Error("Vídeo indisponível.");
      setPlaying({ id: item.id, url: URL.createObjectURL(data) });
    } catch {
      toast.error("Não foi possível abrir este treinamento. Confirme se ele está atribuído à sua conta.");
    } finally {
      setLoadingVideoId(null);
    }
  };

  const visibleItems = useMemo(() => assignments.data ?? [], [assignments.data]);
  const currentName = teamMember?.name || "vendedor";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Treinamento comercial</h1>
        </div>
        <p className="text-sm text-muted-foreground">Vídeos atribuídos para você, com o passo a passo das telas e da rotina Totex.</p>
      </header>

      {isAdmin && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Upload className="h-4 w-4" /> Atribuir treinamento a um vendedor</CardTitle>
            <p className="text-sm text-muted-foreground">O vídeo fica privado e só aparece para o membro escolhido e os administradores deste tenant.</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input aria-label="Título do vídeo" placeholder="Ex.: Treinamento CRM — Glauter" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
              <Select value={memberId} onValueChange={setMemberId}>
                <SelectTrigger aria-label="Vendedor que receberá o treinamento"><SelectValue placeholder="Selecione o vendedor" /></SelectTrigger>
                <SelectContent>
                  {(members.data ?? []).map((member) => <SelectItem key={member.id} value={member.id}>{member.name} · {member.email}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Textarea aria-label="Descrição do treinamento" placeholder="O que o vendedor aprenderá neste vídeo?" rows={2} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <input ref={fileRef} type="file" accept="video/mp4,.mp4" className="sr-only" id="training-video-file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}><Video className="mr-2 h-4 w-4" />Escolher MP4</Button>
                <span className="truncate text-xs text-muted-foreground">{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "Até 100 MB"}</span>
                {file && <Button type="button" variant="ghost" size="icon" aria-label="Remover vídeo selecionado" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}><X className="h-4 w-4" /></Button>}
              </div>
              <Button type="button" disabled={upload.isPending || !title.trim() || !memberId || !file || members.isLoading} onClick={() => upload.mutate()}>
                {upload.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enviando…</> : "Enviar e atribuir"}
              </Button>
            </div>
            {members.isError && <p className="text-sm text-destructive">Não foi possível carregar os vendedores deste tenant.</p>}
            {members.data?.length === 0 && <p className="text-sm text-muted-foreground">Não há vendedores ativos com perfil comercial neste tenant.</p>}
          </CardContent>
        </Card>
      )}

      {assignments.isLoading ? (
        <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">Carregando treinamentos…</div>
      ) : assignments.isError ? (
        <div className="rounded-lg border border-destructive/40 p-6 text-center text-sm text-destructive">Não foi possível carregar seus treinamentos. Atualize a página ou fale com o administrador.</div>
      ) : visibleItems.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">Nenhum vídeo atribuído ainda</p>
          <p className="max-w-md text-sm text-muted-foreground">Quando o administrador atribuir um treinamento a {currentName}, ele aparecerá aqui. Os vídeos de outros membros e tenants não são listados.</p>
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {visibleItems.map((item) => (
            <Card key={item.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1"><CardTitle className="text-base">{item.title}</CardTitle>{item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}</div>
                  <Badge variant="secondary" className="shrink-0">Privado</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {playing?.id === item.id ? (
                  <div className="space-y-2">
                    <video className="aspect-video w-full rounded-md bg-black" controls playsInline preload="metadata" src={playing.url} />
                    <Button variant="outline" size="sm" onClick={() => setPlaying(null)}>Fechar vídeo</Button>
                  </div>
                ) : (
                  <Button className="w-full" disabled={loadingVideoId !== null} onClick={() => void play(item)}>
                    {loadingVideoId === item.id ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Preparando vídeo…</> : <><PlayCircle className="mr-2 h-4 w-4" />Assistir treinamento</>}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
