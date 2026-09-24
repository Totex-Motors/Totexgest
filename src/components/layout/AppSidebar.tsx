import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard,
  Calendar,
  Settings,
  MessageSquare,
  Smartphone,
  ClipboardList,
  CheckSquare,
  Video,
  Headphones,
  Radar,
  Kanban,
  LogOut,
  TrendingUp,
  User2,
  Car,
  ShoppingBag,
  MonitorSmartphone,
  Users,
  Bot,
  Library,
  KeyRound,
  Network,
  Megaphone,
  Mail,
  FileText,
  Workflow,
  Send,
  BrainCircuit,
  Share2,
  Upload,
  Lightbulb,
  Instagram,
  HandCoins,
  Handshake,
  ShieldCheck,
  GraduationCap,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useNotificationContext } from "@/hooks/useNotifications";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useEnabledModules } from "@/components/settings/sections/ModulesSection";

/* ---------------------------------------------------------------
 * Types & menu data
 * --------------------------------------------------------------- */

interface NavItem {
  title: string;
  url: string;
  icon: React.ElementType;
  /** opcional: id do mÃ³dulo necessÃ¡rio pra exibir */
  moduleId?: string;
  /** opcional: sÃ³ aparece para super-admin (tenant Totex) */
  superAdminOnly?: boolean;
  /** opcional: sÃ³ para gestÃ£o (admin/comercial) â€” ex.: comissÃµes por vendedor */
  adminOnly?: boolean;
  /** opcional: restringe o item aos papÃ©is que podem abrir a rota comercial */
  commercialOnly?: boolean;
}

interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
  /** mÃ³dulo que deve estar ativo pra seÃ§Ã£o aparecer */
  moduleId?: string;
  /** seÃ§Ã£o inteira sÃ³ aparece pro super-admin (HQ Totex) â€” lojas veem o menu enxuto */
  superAdminOnly?: boolean;
}

/**
 * URLs que sÃ£o prefixo de outra rota da navegaÃ§Ã£o. Esses itens sÃ³ devem ser
 * marcados como ativos em match exato (ex: "/comercial" nÃ£o pode ficar ativo
 * quando estamos em "/comercial/cockpit").
 */
const buildExactOnlyPaths = (secs: NavSection[]) => {
  const urls = secs.flatMap((s) => s.items.map((i) => i.url));
  return new Set(
    urls.filter((url) => urls.some((other) => other !== url && other.startsWith(url + "/")))
  );
};

const sections: NavSection[] = [
  {
    id: "comercial",
    label: "Comercial",
    moduleId: "comercial",
    items: [
      { title: "Torre de Controle", url: "/comercial/operacao", icon: Radar, superAdminOnly: true },
      { title: "Cockpit", url: "/comercial/cockpit", icon: Headphones },
      { title: "Dashboard", url: "/comercial", icon: LayoutDashboard },
      { title: "Pipeline", url: "/comercial/pipeline", icon: Kanban },
      { title: "Treinamento", url: "/comercial/treinamento", icon: GraduationCap, commercialOnly: true },
      { title: "Vendedores", url: "/comercial/vendedores", icon: Users, adminOnly: true },
      { title: "Inbox", url: "/comercial/inbox", icon: MessageSquare },
      { title: "IntermediaÃ§Ã£o", url: "/comercial/intermediacao", icon: Handshake, superAdminOnly: true },
      { title: "Rede", url: "/comercial/rede", icon: Network, superAdminOnly: true },
      { title: "AprovaÃ§Ãµes", url: "/comercial/aprovacoes", icon: ShieldCheck, superAdminOnly: true },
    ],
  },
  {
    id: "origens",
    label: "Origens",
    items: [
      { title: "Marketplace Digital", url: "/comercial/marketplace", icon: ShoppingBag, moduleId: "marketplace" },
      { title: "Credere", url: "/comercial/credere", icon: Car, moduleId: "credere" },
      { title: "IA de QualificaÃ§Ã£o", url: "/comercial/totem", icon: MonitorSmartphone, superAdminOnly: true },
      { title: "Canais de Entrada", url: "/marketing/canais", icon: Share2, superAdminOnly: true },
      { title: "CaptaÃ§Ã£o (promotoras)", url: "/captacao", icon: HandCoins, superAdminOnly: true },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    moduleId: "marketing",
    superAdminOnly: true,
    items: [
      { title: "Dashboard", url: "/marketing", icon: Megaphone },
      { title: "Campanhas Email", url: "/marketing/campanhas", icon: Mail },
      { title: "Templates Email", url: "/marketing/templates", icon: FileText },
      { title: "AutomaÃ§Ãµes", url: "/marketing/automacoes", icon: Workflow },
      { title: "Campanhas WhatsApp", url: "/comercial/campanhas", icon: Send },
      { title: "Campanhas Instagram", url: "/marketing/instagram", icon: Instagram },
      { title: "Templates WhatsApp", url: "/marketing/whatsapp-templates", icon: FileText },
      { title: "Lead Ads (Meta)", url: "/marketing/lead-ads", icon: Megaphone },
      { title: "Importar Leads", url: "/marketing/importar", icon: Upload },
      { title: "FormulÃ¡rios", url: "/marketing/formularios", icon: FileText },
    ],
  },
  {
    id: "gestao",
    label: "GestÃ£o",
    moduleId: "gestao",
    items: [
      { title: "Tarefas", url: "/gestao/tarefas", icon: CheckSquare },
      { title: "CalendÃ¡rio", url: "/gestao/calendario", icon: Calendar },
      { title: "Agendamentos", url: "/gestao/reunioes", icon: Video },
      { title: "Melhorias", url: "/gestao/melhorias", icon: Lightbulb, superAdminOnly: true },
    ],
  },
  {
    id: "agentes",
    label: "Agentes IA",
    superAdminOnly: true,
    items: [
      { title: "Meus agentes", url: "/agentes", icon: Bot },
      { title: "Habilidades", url: "/agentes/habilidades", icon: Library },
      { title: "Credenciais", url: "/agentes/credenciais", icon: KeyRound },
      { title: "Organograma", url: "/agentes/organograma", icon: Network },
    ],
  },
  {
    id: "pessoal",
    label: "Meu EspaÃ§o",
    superAdminOnly: true,
    items: [
      { title: "Meu WhatsApp", url: "/meu-whatsapp", icon: Smartphone },
    ],
  },
];

const bottomItems: NavItem[] = [
  { title: "ConfiguraÃ§Ãµes", url: "/configuracoes", icon: Settings },
];

const exactOnlyPaths = buildExactOnlyPaths(sections);

/* ---------------------------------------------------------------
 * AppSidebar
 * --------------------------------------------------------------- */

export function AppSidebar() {
  const location = useLocation();
  const currentPath = location.pathname;
  const { unreadWhatsAppCount, markWhatsAppAsRead } = useNotificationContext();
  const { teamMember, signOut, isSuperAdmin, isComercial } = useAuth();
  const isAdmin = teamMember?.role === "admin" || teamMember?.role === "comercial" || teamMember?.team === "admin";
  const { isModuleEnabled } = useEnabledModules();

  // Sidebar do shadcn expÃµe o estado (expanded/collapsed)
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  // Marca inbox como lido ao abrir
  useEffect(() => {
    if (currentPath === "/comercial/inbox") markWhatsAppAsRead();
  }, [currentPath, markWhatsAppAsRead]);

  const isActive = (path: string) => {
    if (path === "/") return currentPath === "/";
    // URLs que sÃ£o prefixo de outra rota (ex: "/comercial" Ã© prefixo de
    // "/comercial/cockpit") sÃ³ ficam ativas em match exato, senÃ£o o item raiz
    // (Dashboard) ficaria sempre destacado ao navegar nas rotas filhas.
    if (exactOnlyPaths.has(path)) return currentPath === path;
    return currentPath === path || currentPath.startsWith(path + "/");
  };

  // Filtra seÃ§Ãµes conforme mÃ³dulos ativos
  const visibleSections = useMemo(() => {
    return sections
      .filter((s) => (!s.moduleId || isModuleEnabled(s.moduleId)) && (!s.superAdminOnly || isSuperAdmin))
      .map((s) => ({
        ...s,
        items: s.items.filter(
          (i) => (!i.moduleId || isModuleEnabled(i.moduleId)) && (!i.superAdminOnly || isSuperAdmin) && (!i.adminOnly || isAdmin) && (!i.commercialOnly || isAdmin || isComercial || teamMember?.role === "closer" || teamMember?.role === "sdr"),
        ),
      }))
      .filter((s) => s.items.length > 0);
  }, [isModuleEnabled, isSuperAdmin, isAdmin, isComercial, teamMember?.role]);

  const userInitials =
    teamMember?.name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .substring(0, 2)
      .toUpperCase() || "??";

  return (
    <TooltipProvider delayDuration={200}>
      <Sidebar
        className={cn(
          // borda direita refinada
          "border-r border-sidebar-border/60",
          // fundo com gradiente sutil que dÃ¡ profundidade
          "bg-[linear-gradient(180deg,hsl(var(--sidebar-background))_0%,hsl(var(--sidebar-background))_60%,hsl(var(--sidebar-background)/0.97)_100%)]"
        )}
      >
        {/* =========================================================
         *  HEADER â€” Brand
         * ========================================================= */}
        <SidebarHeader
          className={cn(
            "h-16 px-4 flex items-center border-b border-sidebar-border/50",
            isCollapsed && "px-2 justify-center"
          )}
        >
          <NavLink
            to="/comercial"
            aria-label="Ir para o inÃ­cio"
            className="flex items-center gap-3 w-full group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring rounded-lg"
          >
            <div
              className={cn(
                "relative shrink-0 w-20 h-12",
                "flex items-center justify-center",
                "transition-transform duration-300 group-hover:scale-105"
              )}
            >
              <img
                src="/logo_totex1.png"
                alt="Totex Motors"
                className="w-[140%] h-[140%] object-contain"
              />
            </div>

            {!isCollapsed && (
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="text-[15px] font-semibold tracking-tight text-sidebar-accent-foreground truncate">
                  TotexGest
                </span>
              </div>
            )}
          </NavLink>
        </SidebarHeader>

        {/* =========================================================
         *  BODY â€” NavegaÃ§Ã£o
         * ========================================================= */}
        <SidebarContent
          className={cn(
            "px-3 py-5 gap-6",
            // scroll refinado
            "[&::-webkit-scrollbar]:w-1.5",
            "[&::-webkit-scrollbar-track]:bg-transparent",
            "[&::-webkit-scrollbar-thumb]:bg-sidebar-border/60",
            "[&::-webkit-scrollbar-thumb]:rounded-full",
            "[&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border",
            isCollapsed && "px-2"
          )}
        >
          {visibleSections.map((section) => (
            <Section
              key={section.id}
              section={section}
              isCollapsed={isCollapsed}
              isActive={isActive}
              unreadCount={unreadWhatsAppCount}
            />
          ))}

          {/* push para baixo: divisor + settings */}
          <div className="mt-auto flex flex-col gap-1 pt-4 border-t border-sidebar-border/50">
            {!isCollapsed && (
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-sidebar-muted/70">
                Sistema
              </p>
            )}
            {bottomItems.map((item) => (
              <NavItemLink
                key={item.url}
                item={item}
                active={isActive(item.url)}
                isCollapsed={isCollapsed}
              />
            ))}
          </div>
        </SidebarContent>

        {/* =========================================================
         *  FOOTER â€” User
         * ========================================================= */}
        <SidebarFooter
          className={cn(
            "p-3 border-t border-sidebar-border/50",
            isCollapsed && "p-2"
          )}
        >
          {isCollapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={signOut}
                  aria-label="Sair"
                  className="w-full flex items-center justify-center h-10 rounded-lg hover:bg-sidebar-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <Avatar className="h-8 w-8 ring-1 ring-sidebar-border">
                    <AvatarFallback className="bg-sidebar-primary/15 text-sidebar-primary text-[11px] font-semibold">
                      {userInitials}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="flex flex-col gap-0.5">
                <span className="font-medium">{teamMember?.name || "UsuÃ¡rio"}</span>
                <span className="text-xs text-muted-foreground capitalize">
                  {teamMember?.role || ""}
                </span>
              </TooltipContent>
            </Tooltip>
          ) : (
            <div className="group/user flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-sidebar-accent/40 transition-colors">
              <Avatar className="h-9 w-9 ring-1 ring-sidebar-border shrink-0">
                <AvatarFallback className="bg-sidebar-primary/15 text-sidebar-primary text-[12px] font-semibold">
                  {userInitials}
                </AvatarFallback>
              </Avatar>

              <div className="flex flex-col flex-1 min-w-0 leading-tight">
                <span className="text-[13px] font-medium text-sidebar-accent-foreground truncate">
                  {teamMember?.name || "UsuÃ¡rio"}
                </span>
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-sidebar-muted/80 truncate">
                  {teamMember?.role || "membro"}
                </span>
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={signOut}
                    aria-label="Sair da conta"
                    className={cn(
                      "shrink-0 p-2 rounded-lg transition-all",
                      "text-sidebar-muted hover:text-red-400",
                      "hover:bg-red-500/10",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40",
            #7¶‰žËkºwµçqÍÁ…¸±…ÍÍ9…µ”ô‰ µÁà™±•à´Äµ°´Ì‰œµÉ…‘¥•¹ÐµÑ¼µÈ™É½´µÍ¥‘•‰…Èµ‰½É‘•È¼ÔÀÑ¼µÑÉ…¹ÍÁ…É•¹Ðˆ€¼ø4(€€€€€€€€ð½‘¥Øø4(€€€€€€¥ô4(4(€€€€€€ñ¹…Ø…É¥„µ±…‰•°õíÍ•Ñ¥½¸¹±…‰•±ô±…ÍÍ9…µ”ô‰™±•à™±•àµ½°…À´À¸Ôˆø4(€€€€€€€íÍ•Ñ¥½¸¹¥Ñ•µÌ¹µ…À ¡¥Ñ•´¤€ôøì4(€€€€€€€€€½¹ÍÐ…Ñ¥Ù”€ô¥ÍÑ¥Ù”¡¥Ñ•´¹ÕÉ°¤ì4(€€€€€€€€€½¹ÍÐÍ¡½Ý	…‘”€ô¥Ñ•´¹ÕÉ°€ôôô€ˆ½½µ•É¥…°½¥¹‰½àˆ€˜˜Õ¹É•…‘½Õ¹Ð€ø€Àì4(€€€€€€€€€É•ÑÕÉ¸€ 4(€€€€€€€€€€€€ñ9…Ù%Ñ•µ1¥¹¬4(€€€€€€€€€€€€€­•äõí¥Ñ•´¹ÕÉ±ô4(€€€€€€€€€€€€€¥Ñ•´õí¥Ñ•µô4(€€€€€€€€€€€€€…Ñ¥Ù”õí…Ñ¥Ù•ô4(€€€€€€€€€€€€€¥Í½±±…ÁÍ•õí¥Í½±±…ÁÍ•‘ô4(€€€€€€€€€€€€€‰…‘”õíÍ¡½Ý	…‘”€üÕ¹É•…‘½Õ¹Ð€èÕ¹‘•™¥¹•‘ô4(€€€€€€€€€€€€¼ø4(€€€€€€€€€€¤ì4(€€€€€€€ô¥ô4(€€€€€€ð½¹…Øø4(€€€€ð½‘¥Øø4(€€¤ì4)ô4(4(¼¨€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´4(€¨9…Ù%Ñ•µ1¥¹¬ƒŠP±¥¹¬¥¹‘¥Ù¥‘Õ…°€¡½´…Ñ¥Ù”¥¹‘¥…Ñ½ÈÉ•™¥¹…‘¼¤4(€¨€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´€¨¼4(4)¥¹Ñ•É™…”9…Ù%Ñ•µ1¥¹­AÉ½ÁÌì4(€¥Ñ•´è9…Ù%Ñ•´ì4(€…Ñ¥Ù”è‰½½±•…¸ì4(€¥Í½±±…ÁÍ•è‰½½±•…¸ì4(€‰…‘”üè¹Õµ‰•Èì4)ô4(4)™Õ¹Ñ¥½¸9…Ù%Ñ•µ1¥¹¬¡ì¥Ñ•´°…Ñ¥Ù”°¥Í½±±…ÁÍ•°‰…‘”ôè9…Ù%Ñ•µ1¥¹­AÉ½ÁÌ¤ì4(€½¹ÍÐ%½¸€ô¥Ñ•´¹¥½¸ì4(4(€½¹ÍÐ½¹Ñ•¹Ð€ô€ 4(€€€€ñ9…Ù1¥¹¬4(€€€€€Ñ¼õí¥Ñ•´¹ÕÉ±ô4(€€€€€…É¥„µÕÉÉ•¹Ðõí…Ñ¥Ù”€ü€‰Á…”ˆ€èÕ¹‘•™¥¹•‘ô4(€€€€€±…ÍÍ9…µ”õí¸ 4(€€€€€€€€‰É½ÕÀÉ•±…Ñ¥Ù”™±•à¥Ñ•µÌµ•¹Ñ•È…À´Ì ´ÄÀÉ½Õ¹‘•µ±œÑ•áÐµlÄÍÁátÑÉ…¹Í¥Ñ¥½¸µ…±°‘ÕÉ…Ñ¥½¸´ÈÀÀˆ°4(€€€€€€€€‰™½ÕÌµÙ¥Í¥‰±”é½ÕÑ±¥¹”µ¹½¹”™½ÕÌµÙ¥Í¥‰±”éÉ¥¹œ´È™½ÕÌµÙ¥Í¥‰±”éÉ¥¹œµÍ¥‘•‰…ÈµÉ¥¹œ™½ÕÌµÙ¥Í¥‰±”éÉ¥¹œµ½™™Í•Ð´Àˆ°4(€€€€€€€¥Í½±±…ÁÍ•€ü€‰Áà´À©ÕÍÑ¥™äµ•¹Ñ•ÈÜ´ÄÀµàµ…ÕÑ¼ˆ€è€‰Áà´Ìˆ°4(€€€€€€€…Ñ¥Ù”4(€€€€€€€€€€ü€‰Ñ•áÐµÍ¥‘•‰…Èµ…•¹Ðµ™½É•É½Õ¹™½¹Ðµµ•‘¥Õ´‰œµÍ¥‘•‰…Èµ…•¹Ð¼àÀˆ4(€€€€€€€€€€è€‰Ñ•áÐµÍ¥‘•‰…Èµ™½É•É½Õ¹¼àÀ¡½Ù•ÈéÑ•áÐµÍ¥‘•‰…Èµ…•¹Ðµ™½É•É½Õ¹¡½Ù•Èé‰œµÍ¥‘•‰…Èµ…•¹Ð¼ÐÀˆ4(€€€€€€¥ô4(€€€€ø4(€€€€€ì¼¨%¹‘¥…‘½È±…Ñ•É…°€¡‰…ÉÉ„‘½ÕÉ…‘„ƒ€•ÍÅÕ•É‘„¤€¨½ô4(€€€€€€ñÍÁ…¸4(€€€€€€€…É¥„µ¡¥‘‘•¸4(€€€€€€€±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€‰…‰Í½±ÕÑ”±•™Ð´ÀÑ½À´Ä¸Ô‰½ÑÑ½´´Ä¸ÔÜµlÍÁátÉ½Õ¹‘•µÈµ™Õ±°ÑÉ…¹Í¥Ñ¥½¸µ…±°‘ÕÉ…Ñ¥½¸´ÌÀÀˆ°4(€€€€€€€€€…Ñ¥Ù”4(€€€€€€€€€€€€ü€‰‰œµÍ¥‘•‰…ÈµÁÉ¥µ…Éä½Á…¥Ñä´ÄÀÀÍ…±”µä´ÄÀÀˆ4(€€€€€€€€€€€€è€‰‰œµÍ¥‘•‰…ÈµÁÉ¥µ…Éä½Á…¥Ñä´ÀÍ…±”µä´ÔÀÉ½ÕÀµ¡½Ù•Èé½Á…¥Ñä´ÐÀÉ½ÕÀµ¡½Ù•ÈéÍ…±”µä´ÜÔˆ4(€€€€€€€€¥ô4(€€€€€€¼ø4(4(€€€€€€ñ%½¸4(€€€€€€€±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€‰ µlÄáÁátÜµlÄáÁátÍ¡É¥¹¬´ÀÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌˆ°4(€€€€€€€€€…Ñ¥Ù”€ü€‰Ñ•áÐµÍ¥‘•‰…ÈµÁÉ¥µ…Éäˆ€è€‰Ñ•áÐµÍ¥‘•‰…Èµ™½É•É½Õ¹¼ØÀÉ½ÕÀµ¡½Ù•ÈéÑ•áÐµÍ¥‘•‰…Èµ…•¹Ðµ™½É•É½Õ¹ˆ4(€€€€€€€€¥ô4(€€€€€€€ÍÑÉ½­•]¥‘Ñ õí…Ñ¥Ù”€ü€È¸ÈÔ€è€Ä¸åô4(€€€€€€¼ø4(4(€€€€€ì…¥Í½±±…ÁÍ•€˜˜€ 4(€€€€€€€€ðø4(€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰™±•à´ÄÑÉÕ¹…Ñ”ˆùí¥Ñ•´¹Ñ¥Ñ±•ôð½ÍÁ…¸ø4(€€€€€€€€€í‰…‘”€„ôôÕ¹‘•™¥¹•€˜˜€ 4(€€€€€€€€€€€€ñ	…‘”4(€€€€€€€€€€€€€±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€€€€€€€‰ ´Ôµ¥¸µÜµlÈÁÁátÁà´Ä¸ÔÑ•áÐµlÄÁÁát™½¹ÐµÍ•µ¥‰½±Ñ…‰Õ±…Èµ¹ÕµÌˆ°4(€€€€€€€€€€€€€€€€‰‰œµÍ¥‘•‰…ÈµÁÉ¥µ…ÉäÑ•áÐµÍ¥‘•‰…ÈµÁÉ¥µ…Éäµ™½É•É½Õ¹‰½É‘•È´Àˆ°4(€€€€€€€€€€€€€€€€‰Í¡…‘½ÜµlÁ|Á|Á|Á}¡Í°¡Ù…È ´µÍ¥‘•‰…ÈµÁÉ¥µ…Éä¤¼À¸ÐÔ¥tˆ°4(€€€€€€€€€€€€€€€€‰…¹¥µ…Ñ”µmÁÕ±Í”µÉ¥¹|È¸ÕÍ}•…Í”µ½ÕÑ}¥¹™¥¹¥Ñ•tˆ4(€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€ø4(€€€€€€€€€€€€€í‰…‘”€ø€ää€ü€ˆää¬ˆ€è‰…‘•ô4(€€€€€€€€€€€€ð½	…‘”ø4(€€€€€€€€€€¥ô4(€€€€€€€€ð¼ø4(€€€€€€¥ô4(€€€€ð½9…Ù1¥¹¬ø4(€€¤ì4(4(€¥˜€¡¥Í½±±…ÁÍ•¤ì4(€€€É•ÑÕÉ¸€ 4(€€€€€€ñQ½½±Ñ¥Àø4(€€€€€€€€ñQ½½±Ñ¥ÁQÉ¥•È…Í¡¥±ùí½¹Ñ•¹Ñôð½Q½½±Ñ¥ÁQÉ¥•Èø4(€€€€€€€€ñQ½½±Ñ¥Á½¹Ñ•¹ÐÍ¥‘”ô‰É¥¡Ðˆ±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´Èˆø4(€€€€€€€€€€ñÍÁ…¸ùí¥Ñ•´¹Ñ¥Ñ±•ôð½ÍÁ…¸ø4(€€€€€€€€€í‰…‘”€„ôôÕ¹‘•™¥¹•€˜˜€ 4(€€€€€€€€€€€€ñ	…‘”±…ÍÍ9…µ”ô‰ ´ÐÁà´ÄÑ•áÐµlÄÁÁát‰œµÍ¥‘•‰…ÈµÁÉ¥µ…ÉäÑ•áÐµÍ¥‘•‰…ÈµÁÉ¥µ…Éäµ™½É•É½Õ¹‰½É‘•È´Àˆø4(€€€€€€€€€€€€€í‰…‘”€ø€ää€ü€ˆää¬ˆ€è‰…‘•ô4(€€€€€€€€€€€€ð½	…‘”ø4(€€€€€€€€€€¥ô4(€€€€€€€€ð½Q½½±Ñ¥Á½¹Ñ•¹Ðø4(€€€€€€ð½Q½½±Ñ¥Àø4(€€€€¤ì4(€ô4(4(€É•ÑÕÉ¸½¹Ñ•¹Ðì4)ô4(4(