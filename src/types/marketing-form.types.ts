export type FieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'number'
  | 'select'
  | 'state'
  | 'city'
  | 'capital'
  | 'textarea'
  | 'hidden';

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  placeholder?: string;
  required: boolean;
  options?: string[]; // for select type
  width?: 'full' | 'half'; // layout
  map_to?: string; // maps to receive-lead field name (nome, email, phone, etc)
}

export interface FormStyle {
  // Container
  primary_color: string;          // cor de destaque (foco de input, ícones, acentos)
  bg_color: string;               // fundo do container do form
  text_color: string;             // cor padrão de texto (título, labels quando não específico)
  border_radius: number;          // arredondamento de cantos (px)
  font_family: string;            // família de fonte (ex: 'Inter, sans-serif')
  logo_url?: string;
  // Botão
  button_text: string;
  button_style: 'solid' | 'outline' | 'gradient';
  // === NOVOS (opcionais, com fallback retro-compatível) ===
  /** Cor de fundo dos inputs — default: bg_color */
  input_bg_color?: string;
  /** Cor do texto digitado nos inputs — default: text_color */
  input_text_color?: string;
  /** Cor do label dos campos — default: text_color */
  label_color?: string;
  /** Cor do botão — default: primary_color */
  button_color?: string;
  /** Cor do texto do botão — default: '#ffffff' (solid/gradient) ou button_color (outline) */
  button_text_color?: string;
}

/** Resolve campos opcionais aplicando fallback retro-compatível.
 *  Use em FormEmbed.tsx e no preview do editor pra não duplicar lógica. */
export function resolveStyle(s: FormStyle) {
  const input_bg = s.input_bg_color || s.bg_color;
  const input_text = s.input_text_color || s.text_color;
  const label = s.label_color || s.text_color;
  const button_bg = s.button_color || s.primary_color;
  const button_text_default =
    s.button_style === 'outline' ? button_bg : '#ffffff';
  const button_text = s.button_text_color || button_text_default;
  return { input_bg, input_text, label, button_bg, button_text };
}

/** Fontes Google disponíveis no editor. Carregadas via <link> on-demand. */
export const GOOGLE_FONTS: { value: string; label: string; family: string }[] = [
  { value: 'Inter',              label: 'Inter (padrão)',     family: 'Inter, system-ui, sans-serif' },
  { value: 'Roboto',             label: 'Roboto',             family: '"Roboto", sans-serif' },
  { value: 'Poppins',            label: 'Poppins',            family: '"Poppins", sans-serif' },
  { value: 'Open Sans',          label: 'Open Sans',          family: '"Open Sans", sans-serif' },
  { value: 'Montserrat',         label: 'Montserrat',         family: '"Montserrat", sans-serif' },
  { value: 'Lora',               label: 'Lora (serifa)',      family: '"Lora", serif' },
  { value: 'Playfair Display',   label: 'Playfair (serifa)',  family: '"Playfair Display", serif' },
  { value: 'DM Sans',            label: 'DM Sans',            family: '"DM Sans", sans-serif' },
  { value: 'Instrument Serif',   label: 'Instrument Serif',   family: '"Instrument Serif", serif' },
  { value: 'Nunito',             label: 'Nunito',             family: '"Nunito", sans-serif' },
];

/** Carrega a fonte do Google Fonts no documento (idempotente). */
export function loadGoogleFont(fontName: string) {
  if (typeof document === 'undefined') return;
  if (!fontName || fontName.toLowerCase().includes('inter')) return; // Inter já carregada pela app
  const id = `gf-${fontName.replace(/\s+/g, '-').toLowerCase()}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

export interface FormSettings {
  distribution_key: string; // API key for receive-lead
  source_name?: string; // source field sent to receive-lead
  show_logo: boolean;
  compact_mode: boolean;
  auto_capture_utm: boolean;
}

export interface MarketingForm {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  fields: FormField[];
  style: FormStyle;
  settings: FormSettings;
  redirect_url?: string;
  success_message: string;
  is_active: boolean;
  submissions_count: number;
  last_submission_at?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_STYLE: FormStyle = {
  primary_color: '#c8952e',
  bg_color: '#ffffff',
  text_color: '#1a1a1a',
  border_radius: 8,
  font_family: 'Inter, system-ui, sans-serif',
  button_text: 'Enviar',
  button_style: 'solid',
};

export const DEFAULT_SETTINGS: FormSettings = {
  // Preencher com a distribution key do tenant (API key do receive-lead) ao criar o formulário
  distribution_key: '',
  show_logo: false,
  compact_mode: false,
  auto_capture_utm: true,
};

export const FIELD_TYPE_OPTIONS: { value: FieldType; label: string; icon: string }[] = [
  { value: 'text', label: 'Texto', icon: 'Type' },
  { value: 'email', label: 'Email', icon: 'Mail' },
  { value: 'phone', label: 'Telefone', icon: 'Phone' },
  { value: 'number', label: 'Número', icon: 'Hash' },
  { value: 'select', label: 'Seleção', icon: 'List' },
  { value: 'state', label: 'Estado (UF)', icon: 'MapPin' },
  { value: 'city', label: 'Cidade', icon: 'Building2' },
  { value: 'capital', label: 'Capital Disponível', icon: 'DollarSign' },
  { value: 'textarea', label: 'Texto Longo', icon: 'AlignLeft' },
  { value: 'hidden', label: 'Oculto', icon: 'EyeOff' },
];

export const CAPITAL_OPTIONS = [
  'Acima de R$100mil',
  'Acima de R$200mil',
  'Acima de R$300mil',
  'Acima de R$400mil',
];

export const FIELD_MAP_OPTIONS = [
  { value: 'nome', label: 'Nome' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Telefone' },
  { value: 'cidade', label: 'Cidade' },
  { value: 'estado', label: 'Estado' },
  { value: 'capital_disponivel', label: 'Capital Disponível' },
  { value: 'ocupacao', label: 'Ocupação' },
  { value: 'melhor_horario', label: 'Melhor Horário' },
  { value: 'utm_source', label: 'UTM Source' },
  { value: 'utm_medium', label: 'UTM Medium' },
  { value: 'utm_campaign', label: 'UTM Campaign' },
  { value: 'utm_content', label: 'UTM Content' },
  { value: 'utm_term', label: 'UTM Term' },
];

// Preset templates
export const FORM_TEMPLATES: { name: string; description: string; fields: FormField[] }[] = [
  {
    name: 'Captação Simples',
    description: 'Nome, email e telefone',
    fields: [
      { id: 'nome', type: 'text', label: 'Nome', placeholder: 'Seu nome', required: true, width: 'full', map_to: 'nome' },
      { id: 'email', type: 'email', label: 'E-mail', placeholder: 'seu@email.com', required: true, width: 'half', map_to: 'email' },
      { id: 'phone', type: 'phone', label: 'Telefone', placeholder: '(31) 99999-0000', required: true, width: 'half', map_to: 'phone' },
    ],
  },
  {
    name: 'Captação Completa',
    description: 'Todos os campos de qualificação',
    fields: [
      { id: 'nome', type: 'text', label: 'Nome completo', placeholder: 'Seu nome', required: true, width: 'full', map_to: 'nome' },
      { id: 'email', type: 'email', label: 'E-mail', placeholder: 'seu@email.com', required: true, width: 'half', map_to: 'email' },
      { id: 'phone', type: 'phone', label: 'WhatsApp', placeholder: '(31) 99999-0000', required: true, width: 'half', map_to: 'phone' },
      { id: 'estado', type: 'state', label: 'Estado', placeholder: 'Selecione', required: true, width: 'half', map_to: 'estado' },
      { id: 'cidade', type: 'city', label: 'Cidade', placeholder: 'Selecione', required: true, width: 'half', map_to: 'cidade' },
      { id: 'capital', type: 'capital', label: 'Capital disponível', placeholder: 'Selecione', required: true, width: 'full', map_to: 'capital_disponivel', options: ['Acima de R$100mil', 'Acima de R$200mil', 'Acima de R$300mil', 'Acima de R$400mil'] },
      { id: 'ocupacao', type: 'text', label: 'Ocupação atual', placeholder: 'Ex: Empresário', required: false, width: 'half', map_to: 'ocupacao' },
      { id: 'horario', type: 'select', label: 'Melhor horário', placeholder: 'Selecione', required: false, width: 'half', map_to: 'melhor_horario', options: ['Manhã', 'Tarde', 'Noite'] },
    ],
  },
];
