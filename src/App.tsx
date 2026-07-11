import React, { useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
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

// Settings unificada + WhatsApp
import SettingsUnified from "./pages/SettingsUnified";
const MyWhatsApp = React.lazy(() => import("./pages/MyWhatsApp"));

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
const CanaisEntrada = React.lazy(() => import("./pages/CanaisEntrada"));
const ImportLeads = React.lazy(() => import("./pages/ImportLeads"));

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

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, isPasswordRecovery } = useAuth();

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

      {/* Home → Dashboard Comercial */}
      <Route path="/" element={<Navigate to="/comercial" replace />} />

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
      <Route path="/agentes/:slug/metricas" element={<ProtectedRoute><React.Suspense fallback={<div />}><AgentMetricsPage /></React.Suspense></ProtectedRoute>} />

      {/* Sales/Commercial routes */}
      <Route path="/comercial/cockpit" element={<ProtectedRoute><CockpitShell /></ProtectedRoute>} />
      <Route path="/comercial/meu-dia" element={<Navigate to="/comercial/cockpit" replace />} />
      <Route path="/comercial/agenda" element={<ProtectedRoute><SalesAgenda /></ProtectedRoute>} />
      <Route path="/comercial" element={<ProtectedRoute><SalesDashboard /></ProtectedRoute>} />
      <Route path="/comercial/workspace" element={<ProtectedRoute><SalesWorkspace /></ProtectedRoute>} />
      <Route path="/comercial/leads" element={<ProtectedRoute><SalesLeads /></ProtectedRoute>} />
      <Route path="/comercial/leads/:id" element={<ProtectedRoute><SalesLeadDetail /></ProtectedRoute>} />
      <Route path="/comercial/pipeline" element={<ProtectedRoute><SalesPipeline /></ProtectedRoute>} />
      <Route path="/comercial/deals" element={<ProtectedRoute><SalesDeals /></ProtectedRoute>} />
      <Route path="/comercial/deals/:id" element={<ProtectedRoute><SalesDealDetail /></ProtectedRoute>} />

      {/* Marketing — Email + WhatsApp + Automações (disparo de campanhas, multi-tenant) */}
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
      <Route path="/marketing/canais" element={<ProtectedRoute><React.Suspense fallback={<div />}><CanaisEntrada /></React.Suspense></ProtectedRoute>} />
      <Route path="/marketing/importar" element={<ProtectedRoute><React.Suspense fallback={<div />}><ImportLeads /></React.Suspense></ProtectedRoute>} />
      <Route path="/marketing/whatsapp-templates/novo" element={<ProtectedRoute><WhatsAppTemplateNew /></ProtectedRoute>} />
      <Route path="/comercial/campanhas" element={<ProtectedRoute><SalesCampaigns /></ProtectedRoute>} />
      <Route path="/comercial/campanhas/nova" element={<ProtectedRoute><SalesCampaignNew /></ProtectedRoute>} />
      <Route path="/comercial/campanhas/:id" element={<ProtectedRoute><SalesCampaignDetail /></ProtectedRoute>} />

      {/* Unsubscribe público (LGPD) — sem auth */}
      <Route path="/unsubscribe" element={<React.Suspense fallback={null}><Unsubscribe /></React.Suspense>} />
      <Route path="/comercial/inbox" element={<ProtectedRoute><SalesWhatsAppInbox /></ProtectedRoute>} />
      <Route path="/comercial/relatorios" element={<Navigate to="/comercial?tab=gestao" replace />} />
      <Route path="/comercial/comissoes" element={<ProtectedRoute><Commissions /></ProtectedRoute>} />
      <Route path="/comercial/playbook" element={<ProtectedRoute><SalesPlaybook /></ProtectedRoute>} />
      <Route path="/comercial/configuracoes" element={<Navigate to="/configuracoes?s=pipeline" replace />} />
      <Route path="/comercial/materiais" element={<ProtectedRoute><SalesMaterialsConfig /></ProtectedRoute>} />
      <Route path="/comercial/credere" element={<ProtectedRoute><CredereLeads /></ProtectedRoute>} />
      <Route path="/comercial/marketplace" element={<ProtectedRoute><MarketplaceLeads /></ProtectedRoute>} />
      <Route path="/comercial/totem" element={<ProtectedRoute><TotemLeads /></ProtectedRoute>} />
      <Route path="/comercial/inteligencia" element={<ProtectedRoute><React.Suspense fallback={<div />}><DemandIntelligence /></React.Suspense></ProtectedRoute>} />
      <Route path="/comercial/agente-ia" element={<Navigate to="/configuracoes?s=agente-ia" replace />} />

      {/* Gestão básica (tarefas, calendário, reuniões) */}
      <Route path="/gestao/tarefas" element={<ProtectedRoute><TaskManagement /></ProtectedRoute>} />
      <Route path="/gestao/calendario" element={<ProtectedRoute><TeamCalendar /></ProtectedRoute>} />
      <Route path="/gestao/reunioes" element={<ProtectedRoute><TeamMeetings /></ProtectedRoute>} />

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

const App = () => (
  <ThemeProvider>
  <QueryClientProvider client={queryClient}>
  <DemoModeProvider>
    <AuthProvider>
      <CallProvider>
        <MeetingProvider>
          <NotificationProvider>
            <TooltipProvider>
              <Toaster />
              <Sonner />
              <BrowserRouter>
                <NavigationListener />
                <FocusModeProvider>
                  <ErrorBoundary name="Calls"><CallModals /></ErrorBoundary>
                  <ErrorBoundary name="Meeting"><GlobalTranscriptionPanel /><MeetingRecoveryBanner /></ErrorBoundary>
                  <FocusModeOverlay />
                  <RouteErrorBoundary><AppRoutes /></RouteErrorBoundary>
                </FocusModeProvider>
              </BrowserRouter>
            </TooltipProvider>
          </NotificationProvider>
        </MeetingProvider>
      </CallProvider>
    </AuthProvider>
  </DemoModeProvider>
  </QueryClientProvider>
  </ThemeProvider>
);

export default App;

