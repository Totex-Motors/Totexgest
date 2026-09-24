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

// Error Boundary para rotas ‚Äî tela cheia com reload
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
              {this.state.error?.message || 'Erro inesperado na aplica√ß√£o'}
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

// Gest√£o b√°sica
import TaskManagement from "./pages/TaskManagement";
import TeamCalendar from "./pages/TeamCalendar";
import TeamMeetings from "./pages/TeamMeetings";

// Marketing (Email + WhatsApp + Automa√ß√µes) ‚Äî disparo de campanhas multi-tenant
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

// Intelig√™ncia de Demanda (dashboards de comportamento do consumidor)
const DemandIntelligence = React.lazy(() => import("./pages/DemandIntelligence"));

// Lead Ads Meta + Canais de Entrada + Importa√ß√£o (portados do template v3)
const MetaLeadAds = React.lazy(() => import("./pages/MetaLeadAds"));
const InstagramCampaigns = React.lazy(() => import("./pages/marketing/InstagramCampaigns"));
const CanaisEntrada = React.lazy(() => import("./pages/CanaisEntrada"));
const OperationTower = React.lazy(() => import("./pages/OperationTower"));
const IntermediationDashboard = React.lazy(() => import("./pages/IntermediationDashboard"));
const NetworkDashboard = React.lazy(() => import("./pages/NetworkDashboard"));
const ApprovalsInbox = React.lazy(() => import("./pages/ApprovalsInbox"));
const ImportLeads = React.lazy(() => import("./pages/ImportLeads"));
const MarketingForms = React.lazy(() => import("./pages/MarketingForms"));

// Capta√ß√£o de ve√≠culos (promotoras) ‚Äî workspace mobile-first separado do CRM
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
// Unsubscribe p√∫blico (LGPD) ‚Äî sem auth
const Unsubscribe = React.lazy(() => import("./pages/public/Unsubscribe"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        const status = error?.status || error?.code;
        const msg = error?.message || '';
        console.warn(`[RQ] Query falhou (tentativa ${failureCount + 1}):`, status, msg);
        // N√£o retry em erros de auth (401/403) ‚Äî recovery cuida disso
        if (status === 401 || status === 403) return false;
        // At√© 3 retries com backoff para erros de rede/timeout
        return failureCount < 3;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
      staleTime: 30000, // 30s - evita refetch excessivo
      refetchOnWindowFocus: true, // Re-habilitado ‚Äî essencial para recovery de queries que falharam
      refetchOnReconnect: true,
      gcTime: 1000 * 60 * 10, // 10 min ‚Äî cache persiste mais tempo, evita loading ao voltar
    },
  },
});

/**
 * Guarda de SESS√ÉO. Tamb√©m segura a promotora dentro do /captacao: qualquer
 * rota do CRM completo (que n√£o seja `scope="captacao"`) redireciona ela pra
 * home dela. Esconder item da sidebar n√£o basta ‚Äî a URL digitada tem que bater aqui.
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

// Escuta eventos 'app-navigate' disparados de fora do BrowserRouter (ex: notifica√ß√µes)
// e faz navega√ß√£o client-side sem recarregar a p√°gina (preserva chamadas WaVoIP ativas)
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
      {/* Rotas p√∫blicas */}
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/agendar" element={
        <React.Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-500"></div></div>}>
          <BookMeeting />
        </React.Suspense>
      } />
      {/* Consentimento OAuth do Segundo C√©rebro (MCP) ‚Äî login + autorizar a IA */}
      <Route path="/oauth/consent" element={
        <React.Suspense fallback={<div className="min-h-screen bg-slate-950 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div></div>}>
          <McpConsent />
        </React.Suspense>
      } />
      {/* Landing p√∫blica do cart√£o NFC de repasse (confirma WhatsApp ‚Üí grupo) */}
      <Route path="/r/:code" element={
        <React.Suspense fallback={<div className="min-h-screen bg-emerald-50 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div></div>}>
          <RepasseLanding />
        </React.Suspense>
      } />

      {/* Home ‚Üí Dashboard Comercial (promotora √© redirecionada pra /captacao pelo ProtectedRoute) */}
      <Route path="/" element={<Navigate to="/comercial" replace />} />
      {/* Atalhos PWA antigos apontavam pra /app/ (manifest cacheado) ‚Üí n√£o davam 404.
          Redireciona /app e /app/* pra home, sem depender do cache do manifest. */}
      <Route path="/app" element={<Navigate to="/comercial" replace />} />
      <Route path="/app/*" element={<Navigate to="/comercial" replace />} />

      {/* Capta√ß√£o de ve√≠culos ‚Äî promotora (e gestores/admin pra acompanhar). Sem AppSidebar. */}
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
        {/* rotas antigas ‚Üí abas da tela Pr√™mios */}
        <Route path="treino" element={<Navigate to="/captacao/premios?tab=treino" replace />} />
        <Route path="perfil" element={<Navigate to="/captacao/premios?tab=perfil" replace />} />
      </Route>

      {/* Configura√ß√µes */}
      <Route path="/configuracoes" element={<ProtectedRoute><SettingsUnified /></ProtectedRoute>} />
      <Route path="/settings" element={<Navigate to="/configuracoes" replace />} />
      <Route path="/whatsapp" element={<Navigate to="/configuracoes?s=whatsapp" replace />} />
      <Route path="/meu-whatsapp" element={<ProtectedRoute><React.Suspense fallback={<div />}><MyWhatsApp /></React.Suspense></ProtectedRoute>} />

      {/* Plataforma de Agentes IA ‚Äî rotas FIXAS antes das :slug (sen√£o "habilidades" vira slug) */}
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
      <Route path="/agentes/:slug/metricas" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentMetricsPage /></React.Suspense></ProtectedRoute>} />

      {/* Sales/Commercial routes */}
      <Route path="/comercial/treinamento" element={
        <ProtectedRoute>
          <RoleRoute allow={["admin", "comercial", "closer", "sdr"]}>
            <React.Suspense fallback={<div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Carregando treinamento‚Ä¶</div>}>
              <CommercialTraining />
            </React.Suspense>
          </RoleRoute>
        </ProtectedRoute>
      } />
      <Route path="/comercial/operacao" element={<ProtectedRoute><React.Suspense fallback={<div />}><OperationTower /></React.Suspense></ProtectedRoute>} />
      <Route path="/comercial/intermediacao" element={<ProtectedRoute><React.Suspense fallback={<div />}><IntermediationDashboard /></React.Suspense></ProtectedRoute>} />
      <Route path="/comercial/rede" element={<ProtectedRoute><React.Suspense fallback={<div />}><NetworkDashboard /></React.Suspense></ProtectedRoute>} />
      <Route path="/comercial/aprovacoes" element={<ProtectedRoute><React.Suspense fallback={<div />}><ApprovalsInbox /></React.Suspense></ProtectedRoute>} />
      <Route path="/comercial/cockpit" element={<ProtectedRoute><CockpitShell /></ProtectedRoute>} />
      <Route path="/comercial/meu-dia" element={<Navigate to="/comercial/cockpit" replace />} />
      <Route path="/comercial/agenda" element={<ProtectedRoute><SalesAgenda /></ProtectedRoute>} />
      <Route path="/comercial" element={<ProtectedRoute><SalesDashboard /></ProtectedRoute>} />
      <Route path="/comercial/vendedores" element={<ProtectedRoute><SalesTeamView /></ProtectedRoute>} />
      <Route path="/comercial/workspace" element={<ProtectedRoute><SalesWorkspace /></ProtectedRoute>} />
      <Route path="/comercial/leads" element={<ProtectedRoute><SalesLeads /></ProtectedRoute>} />
      <Route path="/comercial/leads/:id" element={<ProtectedRoute><SalesLeadDetail /></ProtectedRoute>} />
      <Route path="/comercial/pipeline" element={<ProtectedRoute><SalesPipeline /></ProtectedRoute>} />
      <Route path="/comercial/deals" element={<ProtectedRoute><SalesDeals /></ProtectedRoute>} />
      <Route path="/comercial/deals/:id" element={<ProtectedRoute><SalesDealDetail /></ProtectedRoute>} />

      {/* Marketing ‚Äî Email + WhatsApp + Automa√ß√µes (disparo de campanhas, multi-tenant) */}
      <Route path="/marketing" element={<ProtectedRoute><MarketingDashboard /></ProtectedRoute>} />
      <Route path="/marketing/campanhas" element={<ProtectedRoute><EmailMarketingHub /></ProtectedRoute>} />
      <Route path="/marketing/campanhas/nova" element={<ProtectedRoute><EmailCampaignNew /></ProtectedRoute>} />
      <Route path="/marketing/campanhas/:id" element={<ProtectedRoute><EmailCampaignDetail /></ProtectedRoute>} />
      <Route path="/marketing/templates" element={<ProtectedRoute><EmailTemplates /></ProtectedRoute>} />
      <Route path="/marketing/templates/:id" element={<ProtectedRoute><EmailTemplateEditor /></ProtectedRoute>} />
      <Route path="/marketing/automacoes" element={<ProtectedRoute><MarketingAutomations /></ProtectedRoute>} />
      <Route path="/marketing/automacoes/nova" element={<ProtectedRoute><MarketingAutomationEditor /></ProtectedRoute>} />
      <Route path="/marketing/automacoes/:id" element={<ProtectedRoute><MarketingAutomationEditor /></ProtectedRoute>} />
      <Route path="/marketing/whatsapp-templates" element={<ProtectedRoute><WhatsAppTemplates /></ProtectedRoute>} />
      <Route path="/marketing/lead-ads" element={<ProtectedRoute><React.Suspense fallback={<div />}><MetaLeadAds /></React.Suspense></ProtectedRoute>} />
      <Route path="/marketing/instagram" element={<ProtectedRoute><React.Suspense fallback={<div />}><InstagramCampaigns /></React.Suspense></ProtectedRoute>} />
      <Route path="/marketing/canais" element={<ProtectedRoute><React.Suspense fallback={<div />}><CanaisEntrada /></React.Suspense></ProtectedRoute>} />
      <Route path="/marketing/importar" element={<ProtectedRoute><React.Suspense fallback={<div />}><ImportLeads /></React.Suspense></ProtectedRoute>} />
      <Route path="/marketing/formularios" element={<ProtectedRoute><React.Suspense fallback={<div />}><MarketingForms /></React.Suspense></ProtectedRoute>} />
      <Route path="/marketing/whatsapp-templates/novo" element={<ProtectedRoute><WhatsAppTemplateNew /></ProtectedRoute>} />
      <Route path="/comercial/campanhas" element={<ProtectedRoute><SalesCampaigns /></ProtectedRoute>} />
      <Route path="/comercial/campanhas/nova" element={<ProtectedRoute><SalesCampaignNew /></ProtectedRoute>} />
      <Route path="/comercial/campanhas/:id" element={<Pro~µÔÀhëÈÏ∂ªßq´^v\–€€\ŸY	âà
à]à€\‹”ò[YOHôõ^][\ÀXŸ[ù\àù\›YûKXô]ŸY[àL»ãLHèÇà‹[à€\‹”ò[YOHù^VÃLHõ€ù\Ÿ[ZXõ€\\òÿ\ŸHòX⁄⁄[ôÀVÃåN[WH^\⁄YXò\ã[]]YÕÃèÇà‹ŸX›[€ãõXô[Bà‹‹[èÇàÀ àZ[öKZ[ôXÿY‹àX€‹ò]]õ»
ãﬂBà‹[à€\‹”ò[YOHö\õ^LH[L»ôÀY‹òYY[ù]À\àúõ€K\⁄YXò\ãXõ‹ô\ãÕLÀ]ò[ú‹\ô[ùàœÇàŸ]èÇà
_BÇàò]à\öXK[Xô[^‹ŸX›[€ãõXô[H€\‹”ò[YOHôõ^õ^X€€ÿ\LçHèÇà‹ŸX›[€ãö][\ÀõX\

][JHOà¬à€€ú›X›]ôHH\–X›]ôJ][Kù\õ
N¬à€€ú›⁄›–òYŸHH][Kù\õOOHãÿ€€Y\ò⁄X[⁄[òõﬁà	âà[úôXY€›[ùà¬àô]\õà
àò]í][S[ö¬àŸ^O^⁄][Kù\õBà][O^⁄][_BàX›]ôO^ÿX›]ô_Bà\–€€\ŸY^⁄\–€€\ŸYBàòYŸO^‹⁄›–òYŸH»[úôXY€›[ùà[ôYö[ôYBàœÇà
N¬àJ_Bà€ò]èÇàŸ]èÇà
N¬üBÇã àKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKBà
àò]í][S[ö»8†%[ö»[ô]öYX[
€€HX›]ôH[ôXÿ]‹àôYö[òY Bà
àKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKH
ã¬Çö[ù\ôòXŸHò]í][S[ö‘õ‹»¬à][Nàò]í][N¬àX›]ôNàõ€€X[é¬à\–€€\ŸYàõ€€X[é¬àòYŸOŒàù[Xô\é¬üBÇôù[ò›[€àò]í][S[ö »][KX›]ôK\–€€\ŸYòYŸHNàò]í][S[ö‘õ‹ H¬à€€ú›X€€àH][KöX€€é¬Çà€€ú›€€ù[ùH
àò]ì[ö¬àœ^⁄][Kù\õBà\öXKX›\úô[ù^ÿX›]ôH»úYŸHàà[ôYö[ôYBà€\‹”ò[YO^ÿ€äàô‹õ›\ô[]]ôHõ^][\ÀXŸ[ù\àÿ\L»LLõ›[ôY[»^VÃL‹Hò[ú⁄][€ãX[\ò][€ãLåãàôõÿ›\À]ö\⁄XõNõ›][ôK[õ€ôHõÿ›\À]ö\⁄XõNúö[ôÀLàõÿ›\À]ö\⁄XõNúö[ôÀ\⁄YXò\ã\ö[ô»õÿ›\À]ö\⁄XõNúö[ôÀ[ŸôúŸ]Lãà\–€€\ŸY»úLù\›YûKXŸ[ù\àÀLL^X]]»ààúL»ãàX›]ôBà»ù^\⁄YXò\ãXXÿŸ[ùYõ‹ôY‹õ›[ôõ€ù[YY][HôÀ\⁄YXò\ãXXÿŸ[ùŒÇààù^\⁄YXò\ãYõ‹ôY‹õ›[ôŒ›ô\éù^\⁄YXò\ãXXÿŸ[ùYõ‹ôY‹õ›[ô›ô\éòôÀ\⁄YXò\ãXXÿŸ[ùÕÇà
_BàÇàÀ à[ôXÿY‹à]\ò[
ò\úòH›\òYH0Ë\‹]Y\ôJH
ãﬂBà‹[Çà\öXKZY[Çà€\‹”ò[YO^ÿ€äàòXú€€]HYùL‹LKçHõ›€KLKçHÀVÃ‹Hõ›[ôY\ãYù[ò[ú⁄][€ãX[\ò][€ãLÃãàX›]ôBà»òôÀ\⁄YXò\ã\ö[X\ûH‹X⁄]KLLÿÿ[K^KLLÇààòôÀ\⁄YXò\ã\ö[X\ûH‹X⁄]KLÿÿ[K^KML‹õ›\Z›ô\éõ‹X⁄]KM‹õ›\Z›ô\éúÿÿ[K^KMÕHÇà
_BàœÇÇàX€€Çà€\‹”ò[YO^ÿ€äàöVÃNHÀVÃNH⁄ö[öÀLò[ú⁄][€ãX€€‹ú»ãàX›]ôH»ù^\⁄YXò\ã\ö[X\ûHààù^\⁄YXò\ãYõ‹ôY‹õ›[ôÕå‹õ›\Z›ô\éù^\⁄YXò\ãXXÿŸ[ùYõ‹ôY‹õ›[ôÇà
_Bà›õ⁄ŸU⁄Y^ÿX›]ôH»ãåçHàKé_BàœÇÇà»Z\–€€\ŸY	âà
àÇà‹[à€\‹”ò[YOHôõ^LHù[òÿ]Hèû⁄][Kù]_O‹‹[èÇàÿòYŸHOOH[ôYö[ôY	âà
àòYŸBà€\‹”ò[YO^ÿ€äàöMHZ[ã]ÀVÃåHLKçH^VÃLHõ€ù\Ÿ[ZXõ€Xù[\ã[ù[\»ãàòôÀ\⁄YXò\ã\ö[X\ûH^\⁄YXò\ã\ö[X\ûKYõ‹ôY‹õ›[ôõ‹ô\ãLãàú⁄Y›ÀVÃÃÃÃ⁄€
ò\äK\⁄YXò\ã\ö[X\ûJKÃçJWHãàò[ö[X]KV‹[ŸK\ö[ô◊Ããç\◊ŸX\ŸK[›]⁄[ôö[ö]WHÇà
_BàÇàÿòYŸHàNH»éNJ»ààòYŸ_Bà–òYŸOÇà
_BàœÇà
_Bà”ò]ì[öœÇà
N¬ÇàYà
\–€€\ŸY
H¬àô]\õà
à€€\Çà€€\öYŸŸ\à\–⁄[ûÿ€€ù[ùO’€€\öYŸŸ\èÇà€€\€€ù[ù⁄YOHúöY⁄à€\‹”ò[YOHôõ^][\ÀXŸ[ù\àÿ\LàèÇà‹[èû⁄][Kù]_O‹‹[èÇàÿòYŸHOOH[ôYö[ôY	âà
àòYŸH€\‹”ò[YOHöMLH^VÃLHôÀ\⁄YXò\ã\ö[X\ûH^\⁄YXò\ã\ö[X\ûKYõ‹ôY‹õ›[ôõ‹ô\ãLèÇàÿòYŸHàNH»éNJ»ààòYŸ_Bà–òYŸOÇà
_Bà’€€\€€ù[ùÇà’€€\Çà
N¬àBÇàô]\õà€€ù[ù¬üBÇ