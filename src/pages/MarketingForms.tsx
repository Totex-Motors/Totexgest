import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Plus,
  Copy,
  Trash2,
  Pencil,
  GripVertical,
  ChevronDown,
  ChevronUp,
  FileText,
  LayoutGrid,
  Type,
  Mail,
  Phone,
  Hash,
  List,
  MapPin,
  Building2,
  DollarSign,
  AlignLeft,
  EyeOff,
  Loader2,
  ToggleLeft,
  ToggleRight,
  ArrowLeft,
  Eye,
  Columns2,
  Columns3,
  X,
  Calendar,
  Users,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  useMarketingForms,
  useCreateMarketingForm,
  useUpdateMarketingForm,
  useDeleteMarketingForm,
  useToggleMarketingForm,
  useFormLeads,
} from '@/hooks/useMarketingForms';
import { useDistributionConfigs } from '@/hooks/useLeadDistribution';

function DistributionSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: configs } = useDistributionConfigs();
  const actualValue = value || '__none__';
  return (
    <Select value={actualValue} onValueChange={(v) => onChange(v === '__none__' ? '' : v)}>
      <SelectTrigger>
        <SelectValue placeholder="Nenhuma (lead fica sem distribuir)" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">Nenhuma (lead fica sem responsável)</SelectItem>
        {(configs || []).filter(c => c.is_active).map(c => (
          <SelectItem key={c.id} value={c.id}>{c.name || 'Sem nome'}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
import type {
  MarketingForm,
  FormField,
  FormStyle,
  FormSettings,
  FieldType,
} from '@/types/marketing-form.types';
import {
  DEFAULT_STYLE,
  DEFAULT_SETTINGS,
  FIELD_TYPE_OPTIONS,
  CAPITAL_OPTIONS,
  FIELD_MAP_OPTIONS,
  FORM_TEMPLATES,
  GOOGLE_FONTS,
  loadGoogleFont,
  resolveStyle,
} from '@/types/marketing-form.types';
import { cn } from '@/lib/utils';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';

// ─── Icon map ────────────────────────────────────────────────────────
const FIELD_ICON: Record<FieldType, React.ReactNode> = {
  text: <Type className="h-4 w-4" />,
  email: <Mail className="h-4 w-4" />,
  phone: <Phone className="h-4 w-4" />,
  number: <Hash className="h-4 w-4" />,
  select: <List className="h-4 w-4" />,
  state: <MapPin className="h-4 w-4" />,
  city: <Building2 className="h-4 w-4" />,
  capital: <DollarSign className="h-4 w-4" />,
  textarea: <AlignLeft className="h-4 w-4" />,
  hidden: <EyeOff className="h-4 w-4" />,
};

// ─── Sortable Field Item ──────────────────────────────────────────────
function SortableFieldItem({
  field,
  isExpanded,
  onToggleExpand,
  onUpdate,
  onDelete,
}: {
  field: FormField;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (updates: Partial<FormField>) => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-lg border border-border/50 bg-card transition-all',
        isDragging && 'opacity-50 shadow-lg z-50',
      )}
    >
      {/* Header row */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
        onClick={onToggleExpand}
      >
        <button
          className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <span className="text-muted-foreground shrink-0">{FIELD_ICON[field.type]}</span>

        <span className="text-sm font-medium truncate flex-1">{field.label || 'Sem nome'}</span>

        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  'shrink-0 p-1 rounded text-xs',
                  field.width === 'half'
                    ? 'text-primary bg-primary/10'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate({ width: field.width === 'half' ? 'full' : 'half' });
                }}
              >
                {field.width === 'half' ? (
                  <Columns3 className="h-4 w-4" />
                ) : (
                  <Columns2 className="h-4 w-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {field.width === 'half' ? 'Metade da largura' : 'Largura total'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={field.required}
                  onCheckedChange={(checked) => onUpdate({ required: checked })}
                  className="scale-75"
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>{field.required ? 'Obrigatório' : 'Opcional'}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {field.map_to && (
          <Badge variant="secondary" className="text-[10px] shrink-0">
            {field.map_to}
          </Badge>
        )}

        <button
          className="shrink-0 p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>

        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </div>

      {/* Expanded section */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-1 border-t border-border/30 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Label</Label>
              <Input
                value={field.label}
                onChange={(e) => onUpdate({ label: e.target.value })}
                placeholder="Nome do campo"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Placeholder</Label>
              <Input
                value={field.placeholder || ''}
                onChange={(e) => onUpdate({ placeholder: e.target.value })}
                placeholder="Texto de ajuda"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Tipo</Label>
              <Select
                value={field.type}
                onValueChange={(v) => onUpdate({ type: v as FieldType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Mapear para</Label>
              <Select
                value={field.map_to || '_none'}
                onValueChange={(v) => onUpdate({ map_to: v === '_none' ? undefined : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Nenhum" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">Nenhum</SelectItem>
                  {FIELD_MAP_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {(field.type === 'select' || field.type === 'capital') && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                Opções (uma por linha)
              </Label>
              <Textarea
                value={(field.options && field.options.length > 0 ? field.options : field.type === 'capital' ? CAPITAL_OPTIONS : []).join('\n')}
                onChange={(e) =>
                  onUpdate({
                    options: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                rows={4}
                placeholder="Opção 1&#10;Opção 2&#10;Opção 3"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Phone Input with Country Selector ────────────────────────────────
import { PhoneInput } from 'react-international-phone';
import 'react-international-phone/style.css';

const phoneInputOverrides = `
.react-international-phone-custom .react-international-phone-input-container {
  width: 100% !important;
  display: flex !important;
}
.react-international-phone-custom .react-international-phone-input {
  flex: 1 !important;
}
.react-international-phone-custom .react-international-phone-country-selector-button {
  margin: 0 !important;
}
.react-international-phone-custom .react-international-phone-country-selector-dropdown {
  z-index: 100 !important;
}
`;
// Inject styles once
if (typeof document !== 'undefined' && !document.getElementById('rip-overrides')) {
  const s = document.createElement('style');
  s.id = 'rip-overrides';
  s.textContent = phoneInputOverrides;
  document.head.appendChild(s);
}

// ─── City Search Input ────────────────────────────────────────────────
function CitySearchInput({
  cities, loading, value, onChange, placeholder, disabled, inputStyle, hasError, primaryColor, bgColor, textColor, borderRadius,
}: {
  cities: string[]; loading: boolean; value: string; onChange: (v: string) => void;
  placeholder: string; disabled: boolean; inputStyle: React.CSSProperties; hasError: boolean;
  primaryColor: string; bgColor: string; textColor: string; borderRadius: number;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return cities.slice(0, 50);
    const q = query.toLowerCase();
    return cities.filter(c => c.toLowerCase().includes(q)).slice(0, 50);
  }, [cities, query]);

  const iStyle = hasError ? { ...inputStyle, borderColor: '#ef4444' } : inputStyle;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        style={iStyle}
        type="text"
        placeholder={loading ? 'Carregando cidades...' : disabled ? 'Selecione o estado primeiro' : placeholder}
        disabled={disabled || loading}
        value={query}
        onChange={e => { setQuery(e.target.value); onChange(''); setOpen(true); }}
        onFocus={() => { if (cities.length > 0) setOpen(true); }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          maxHeight: 200, overflowY: 'auto', backgroundColor: bgColor,
          border: `1px solid ${textColor}22`, borderRadius,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', marginTop: 4,
        }}>
          {filtered.map(city => (
            <div
              key={city}
              style={{
                padding: '8px 12px', cursor: 'pointer', fontSize: 14, color: textColor,
                backgroundColor: city === value ? `${primaryColor}15` : 'transparent',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = `${primaryColor}10`)}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = city === value ? `${primaryColor}15` : 'transparent')}
              onClick={() => { onChange(city); setQuery(city); setOpen(false); }}
            >
              {city}
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: '8px 12px', fontSize: 13, color: `${textColor}66` }}>Nenhuma cidade encontrada</div>}
        </div>
      )}
    </div>
  );
}

// ─── Brazilian States ─────────────────────────────────────────────────
const BRAZILIAN_STATES = [
  'AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT',
  'PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO',
];

function phoneMask(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits.length ? `(${digits}` : '';
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

// ─── Form Preview (Interactive) ───────────────────────────────────────
function FormPreview({
  fields,
  style,
  successMessage,
}: {
  fields: FormField[];
  style: FormStyle;
  successMessage: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cities, setCities] = useState<string[]>([]);
  const [loadingCities, setLoadingCities] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Carrega Google Font no preview quando muda
  useEffect(() => {
    const firstFontName = (style.font_family || '').split(',')[0].replace(/["']/g, '').trim();
    if (firstFontName) loadGoogleFont(firstFontName);
  }, [style.font_family]);

  const selectedState = fields.find(f => f.type === 'state')?.id;
  const stateValue = selectedState ? values[selectedState] : '';

  // Load cities when state changes
  useEffect(() => {
    if (!stateValue) { setCities([]); return; }
    setLoadingCities(true);
    fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${stateValue}/municipios?orderBy=nome`)
      .then(r => r.json())
      .then((data: any[]) => setCities(data.map(c => c.nome)))
      .catch(() => setCities([]))
      .finally(() => setLoadingCities(false));
  }, [stateValue]);

  const handleChange = (fieldId: string, value: string) => {
    setValues(prev => ({ ...prev, [fieldId]: value }));
    if (errors[fieldId]) setErrors(prev => { const n = { ...prev }; delete n[fieldId]; return n; });
  };

  const handleSubmit = () => {
    const newErrors: Record<string, string> = {};
    fields.forEach(f => {
      if (f.required && !values[f.id]?.trim()) newErrors[f.id] = 'Campo obrigatório';
      if (f.type === 'email' && values[f.id] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values[f.id])) newErrors[f.id] = 'Email inválido';
      if (f.type === 'phone' && values[f.id] && values[f.id].replace(/\D/g, '').length < 10) newErrors[f.id] = 'Telefone inválido';
    });
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setSubmitting(true);
    setTimeout(() => {
      setSubmitting(false);
      setSubmitted(true);
    }, 1500);
  };

  const handleReset = () => {
    setSubmitted(false);
    setValues({});
    setErrors({});
  };

  const btnStyle = useMemo(() => {
    const base: React.CSSProperties = {
      padding: '12px 24px',
      borderRadius: style.border_radius,
      fontSize: 15,
      fontWeight: 600,
      fontFamily: style.font_family,
      cursor: submitting ? 'wait' : 'pointer',
      width: '100%',
      border: 'none',
      marginTop: 12,
      transition: 'all 0.2s ease',
      opacity: submitting ? 0.7 : 1,
    };
    // 🎨 Usa cores resolvidas (button_color e button_text_color com fallback)
    const r = resolveStyle(style);
    if (style.button_style === 'outline') {
      return { ...base, backgroundColor: 'transparent', border: `2px solid ${r.button_bg}`, color: r.button_text };
    }
    if (style.button_style === 'gradient') {
      return { ...base, background: `linear-gradient(135deg, ${r.button_bg}, ${r.button_bg}dd)`, color: r.button_text };
    }
    return { ...base, backgroundColor: r.button_bg, color: r.button_text };
  }, [style, submitting]);

  // 🎨 Inputs usam input_bg_color / input_text_color resolvidos
  const _r = resolveStyle(style);
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    border: `1px solid ${style.text_color}22`,
    borderRadius: style.border_radius,
    fontSize: 14,
    fontFamily: style.font_family,
    backgroundColor: _r.input_bg,
    color: _r.input_text,
    outline: 'none',
    transition: 'border-color 0.2s ease',
  };

  const errorInputStyle: React.CSSProperties = { ...inputStyle, borderColor: '#ef4444' };

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'none' as const,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
  };

  const visibleFields = fields.filter((f) => f.type !== 'hidden');

  if (submitted) {
    return (
      <div className="rounded-lg overflow-hidden" style={{ backgroundColor: style.bg_color === 'transparent' ? 'rgba(15,15,20,0.75)' : style.bg_color, backdropFilter: style.bg_color === 'transparent' ? 'blur(16px)' : undefined, border: style.bg_color === 'transparent' ? '1px solid rgba(255,255,255,0.1)' : undefined, color: style.bg_color === 'transparent' ? '#ffffff' : style.text_color, fontFamily: style.font_family, padding: 32, textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', backgroundColor: `${style.primary_color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={style.primary_color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </div>
        <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{successMessage || 'Obrigado! Entraremos em contato em breve.'}</p>
        <button onClick={handleReset} style={{ ...btnStyle, width: 'auto', padding: '8px 20px', marginTop: 16, fontSize: 13 }}>Testar novamente</button>
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden" style={{ backgroundColor: style.bg_color === 'transparent' ? 'rgba(15,15,20,0.75)' : style.bg_color, backdropFilter: style.bg_color === 'transparent' ? 'blur(16px)' : undefined, border: style.bg_color === 'transparent' ? '1px solid rgba(255,255,255,0.1)' : undefined, color: style.bg_color === 'transparent' ? '#ffffff' : style.text_color, fontFamily: style.font_family, padding: 24 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {visibleFields.map((field) => {
          const hasError = !!errors[field.id];
          const iStyle = hasError ? errorInputStyle : inputStyle;
          const sStyle = hasError ? { ...selectStyle, borderColor: '#ef4444' } : selectStyle;

          return (
            <div key={field.id} style={{ width: field.width === 'half' ? 'calc(50% - 8px)' : '100%', minWidth: 0 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4, color: _r.label }}>
                {field.label}
                {field.required && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
              </label>

              {field.type === 'textarea' ? (
                <textarea
                  style={{ ...iStyle, minHeight: 80, resize: 'vertical' }}
                  placeholder={field.placeholder}
                  value={values[field.id] || ''}
                  onChange={e => handleChange(field.id, e.target.value)}
                />
              ) : field.type === 'state' ? (
                <select style={sStyle} value={values[field.id] || ''} onChange={e => { handleChange(field.id, e.target.value); const cityField = fields.find(f => f.type === 'city'); if (cityField) handleChange(cityField.id, ''); }}>
                  <option value="">{field.placeholder || 'Selecione o estado'}</option>
                  {BRAZILIAN_STATES.map(uf => <option key={uf} value={uf}>{uf}</option>)}
                </select>
              ) : field.type === 'city' ? (
                <CitySearchInput
                  cities={cities}
                  loading={loadingCities}
                  value={values[field.id] || ''}
                  onChange={v => handleChange(field.id, v)}
                  placeholder={field.placeholder || 'Digite para buscar...'}
                  disabled={cities.length === 0 && !loadingCities}
                  inputStyle={iStyle}
                  hasError={hasError}
                  primaryColor={style.primary_color}
                  bgColor={style.bg_color}
                  textColor={style.text_color}
                  borderRadius={style.border_radius}
                />
              ) : field.type === 'capital' ? (
                <select style={sStyle} value={values[field.id] || ''} onChange={e => handleChange(field.id, e.target.value)}>
                  <option value="">{field.placeholder || 'Selecione'}</option>
                  {(field.options && field.options.length > 0 ? field.options : CAPITAL_OPTIONS).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : field.type === 'select' ? (
                <select style={sStyle} value={values[field.id] || ''} onChange={e => handleChange(field.id, e.target.value)}>
                  <option value="">{field.placeholder || 'Selecione'}</option>
                  {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : field.type === 'phone' ? (
                <div className="react-international-phone-custom" style={{ ['--rip-border' as string]: `1px solid ${hasError ? '#ef4444' : style.text_color + '22'}`, ['--rip-radius' as string]: `${style.border_radius}px`, ['--rip-bg' as string]: _r.input_bg, ['--rip-color' as string]: _r.input_text, ['--rip-font' as string]: style.font_family }}>
                  <PhoneInput
                    defaultCountry="br"
                    value={values[field.id] || ''}
                    onChange={phone => handleChange(field.id, phone)}
                    style={{ width: '100%' }}
                    inputStyle={{
                      width: '100%', height: 40, padding: '0 12px', fontSize: 14,
                      fontFamily: style.font_family, backgroundColor: _r.input_bg,
                      color: _r.input_text, border: `1px solid ${hasError ? '#ef4444' : style.text_color + '22'}`,
                      borderLeft: 'none',
                      borderRadius: `0 ${style.border_radius}px ${style.border_radius}px 0`,
                      outline: 'none',
                    }}
                    countrySelectorStyleProps={{
                      buttonStyle: {
                        height: 40,
                        border: `1px solid ${hasError ? '#ef4444' : style.text_color + '22'}`,
                        borderRight: 'none',
                        borderRadius: `${style.border_radius}px 0 0 ${style.border_radius}px`,
                        backgroundColor: _r.input_bg,
                        padding: '0 6px 0 10px',
                      },
                    }}
                  />
                </div>
              ) : field.type === 'number' ? (
                <input
                  style={iStyle}
                  type="text"
                  inputMode="numeric"
                  placeholder={field.placeholder}
                  value={values[field.id] || ''}
                  onChange={e => handleChange(field.id, e.target.value.replace(/\D/g, ''))}
                />
              ) : (
                <input
                  style={iStyle}
                  type={field.type === 'email' ? 'email' : 'text'}
                  placeholder={field.placeholder}
                  value={values[field.id] || ''}
                  onChange={e => handleChange(field.id, e.target.value)}
                />
              )}

              {hasError && <span style={{ fontSize: 12, color: '#ef4444', marginTop: 2, display: 'block' }}>{errors[field.id]}</span>}
            </div>
          );
        })}
      </div>

      <button style={btnStyle} onClick={handleSubmit} disabled={submitting}>
        {submitting ? '⏳ Enviando...' : (style.button_text || 'Enviar')}
      </button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function MarketingForms() {
  const { toast } = useToast();
  const { data: forms, isLoading } = useMarketingForms();
  const createForm = useCreateMarketingForm();
  const updateForm = useUpdateMarketingForm();
  const deleteForm = useDeleteMarketingForm();
  const toggleForm = useToggleMarketingForm();

  // View state
  const [view, setView] = useState<'list' | 'builder'>('list');
  const [editingForm, setEditingForm] = useState<MarketingForm | null>(null);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [leadsFormId, setLeadsFormId] = useState<string | null>(null);
  const [leadsFormName, setLeadsFormName] = useState('');
  const { data: formLeads, isLoading: leadsLoading } = useFormLeads(leadsFormId);

  // Builder state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);
  const [style, setStyle] = useState<FormStyle>({ ...DEFAULT_STYLE });
  const [settings, setSettings] = useState<FormSettings>({ ...DEFAULT_SETTINGS });
  const [redirectUrl, setRedirectUrl] = useState('');
  const [successMessage, setSuccessMessage] = useState('Obrigado! Entraremos em contato em breve.');
  const [distributionConfigId, setDistributionConfigId] = useState<string>('');
  const [expandedFieldId, setExpandedFieldId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ─── Handlers ───────────────────────────────────────────────────────
  const openBuilder = useCallback(
    (form?: MarketingForm, templateFields?: FormField[]) => {
      if (form) {
        setEditingForm(form);
        setFormName(form.name);
        setFormDescription(form.description || '');
        setFields(form.fields);
        setStyle(form.style);
        setSettings(form.settings);
        setRedirectUrl(form.redirect_url || '');
        setSuccessMessage(form.success_message);
        setDistributionConfigId((form as any).distribution_config_id || '');
      } else {
        setEditingForm(null);
        setFormName('');
        setFormDescription('');
        setFields(templateFields || []);
        setStyle({ ...DEFAULT_STYLE });
        setSettings({ ...DEFAULT_SETTINGS });
        setRedirectUrl('');
        setSuccessMessage('Obrigado! Entraremos em contato em breve.');
        setDistributionConfigId('');
      }
      setExpandedFieldId(null);
      setView('builder');
    },
    [],
  );

  const handleSelectTemplate = useCallback(
    (templateIndex: number | null) => {
      setShowTemplateDialog(false);
      if (templateIndex === null) {
        openBuilder();
      } else {
        const tpl = FORM_TEMPLATES[templateIndex];
        openBuilder(undefined, tpl.fields.map((f) => ({ ...f, id: crypto.randomUUID() })));
        setFormName(tpl.name);
        setFormDescription(tpl.description);
      }
    },
    [openBuilder],
  );

  const handleSave = async () => {
    if (!formName.trim()) {
      toast({ title: 'Informe o nome do formulário', variant: 'destructive' });
      return;
    }
    if (fields.length === 0) {
      toast({ title: 'Adicione pelo menos um campo', variant: 'destructive' });
      return;
    }

    setIsSaving(true);
    try {
      if (editingForm) {
        await updateForm.mutateAsync({
          id: editingForm.id,
          name: formName,
          description: formDescription || undefined,
          fields,
          style,
          settings,
          redirect_url: redirectUrl || undefined,
          success_message: successMessage,
          distribution_config_id: distributionConfigId || null,
        } as any);
        toast({ title: 'Formulário atualizado' });
      } else {
        await createForm.mutateAsync({
          name: formName,
          description: formDescription || undefined,
          fields,
          style,
          settings,
          redirect_url: redirectUrl || undefined,
          success_message: successMessage,
          distribution_config_id: distributionConfigId || null,
        });
        toast({ title: 'Formulário criado' });
      }
      setView('list');
    } catch (err: any) {
      toast({ title: 'Erro ao salvar', description: err?.message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteForm.mutateAsync(id);
      toast({ title: 'Formulário excluído' });
    } catch (err: any) {
      toast({ title: 'Erro ao excluir', description: err?.message, variant: 'destructive' });
    }
  };

  const handleToggle = async (id: string, is_active: boolean) => {
    try {
      await toggleForm.mutateAsync({ id, is_active: !is_active });
      toast({ title: is_active ? 'Formulário desativado' : 'Formulário ativado' });
    } catch {
      toast({ title: 'Erro ao alterar status', variant: 'destructive' });
    }
  };

  const copyEmbed = (id: string) => {
    // URL do embed derivada do próprio domínio onde o CRM está hospedado
    const formUrl = `${window.location.origin}/form/${id}`;
    const code = `<div id="np-form-${id}"><iframe src="${formUrl}" style="width:100%;border:none;overflow:hidden;min-height:600px" id="nf-${id}" loading="lazy" scrolling="no" allowtransparency="true"></iframe></div><script>(function(){var f=document.getElementById("nf-${id}");if(!f)return;var p=new URLSearchParams(window.location.search);var u=["utm_source","utm_medium","utm_campaign","utm_content","utm_term","gclid","fbclid","_gl","ttclid","msclkid","li_fat_id"];var q=[];u.forEach(function(k){var v=p.get(k);if(v)q.push(k+"="+encodeURIComponent(v))});q.push("_lp="+encodeURIComponent(window.location.href));q.push("_ref="+encodeURIComponent(document.referrer||""));q.push("_t="+Date.now());f.src=f.src+(f.src.indexOf("?")>-1?"&":"?")+q.join("&");window.addEventListener("message",function(e){if(e.data&&e.data.type==="np-form-height"){f.style.height=e.data.height+"px"}})})();</script>`;
    navigator.clipboard.writeText(code);
    toast({ title: 'Código embed copiado!' });
  };

  const addField = (type: FieldType) => {
    const opt = FIELD_TYPE_OPTIONS.find((o) => o.value === type);
    const newField: FormField = {
      id: crypto.randomUUID(),
      type,
      label: opt?.label || 'Campo',
      placeholder: '',
      required: false,
      width: 'full',
      options: type === 'select' ? ['Opção 1', 'Opção 2'] : type === 'capital' ? [...CAPITAL_OPTIONS] : undefined,
    };
    setFields((prev) => [...prev, newField]);
    setExpandedFieldId(newField.id);
  };

  const updateField = (id: string, updates: Partial<FormField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  };

  const deleteField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (expandedFieldId === id) setExpandedFieldId(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setFields((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <AppLayout>
      <div className="flex-1 overflow-auto">
        {view === 'list' ? (
          <ListView
            forms={forms || []}
            isLoading={isLoading}
            onNewForm={() => setShowTemplateDialog(true)}
            onEdit={(form) => openBuilder(form)}
            onCopyEmbed={copyEmbed}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onViewLeads={(id, name) => { setLeadsFormId(id); setLeadsFormName(name); }}
          />
        ) : (
          <BuilderView
            formName={formName}
            formDescription={formDescription}
            fields={fields}
            style={style}
            settings={settings}
            redirectUrl={redirectUrl}
            successMessage={successMessage}
            distributionConfigId={distributionConfigId}
            expandedFieldId={expandedFieldId}
            isSaving={isSaving}
            isEditing={!!editingForm}
            sensors={sensors}
            onFormNameChange={setFormName}
            onFormDescriptionChange={setFormDescription}
            onStyleChange={(updates) => setStyle((prev) => ({ ...prev, ...updates }))}
            onRedirectUrlChange={setRedirectUrl}
            onSuccessMessageChange={setSuccessMessage}
            onDistributionConfigIdChange={setDistributionConfigId}
            onExpandField={setExpandedFieldId}
            onUpdateField={updateField}
            onDeleteField={deleteField}
            onAddField={addField}
            onDragEnd={handleDragEnd}
            onSave={handleSave}
            onCancel={() => setView('list')}
          />
        )}
      </div>

      {/* Template selection dialog */}
      <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Novo Formulário</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <button
              className="w-full text-left p-4 rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/5 transition-all group"
              onClick={() => handleSelectTemplate(null)}
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                  <FileText className="h-5 w-5 text-muted-foreground group-hover:text-primary" />
                </div>
                <div>
                  <p className="font-medium text-sm">Em branco</p>
                  <p className="text-xs text-muted-foreground">Comece do zero</p>
                </div>
              </div>
            </button>

            {FORM_TEMPLATES.map((tpl, idx) => (
              <button
                key={idx}
                className="w-full text-left p-4 rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/5 transition-all group"
                onClick={() => handleSelectTemplate(idx)}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                    <LayoutGrid className="h-5 w-5 text-muted-foreground group-hover:text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">{tpl.name}</p>
                    <p className="text-xs text-muted-foreground">{tpl.description}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Leads Dialog */}
      <Dialog open={!!leadsFormId} onOpenChange={(open) => { if (!open) setLeadsFormId(null); }}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Leads — {leadsFormName}
              {formLeads && formLeads.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">{formLeads.length} leads</Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto -mx-6 px-6">
            {leadsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !formLeads || formLeads.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Nenhum lead recebido por este formulário ainda</p>
                <p className="text-xs mt-1">Os leads aparecerão aqui após o primeiro envio com o novo embed</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {formLeads.map((lead: any) => {
                  const payload = lead.raw_payload || {};
                  return (
                    <div key={lead.id} className="rounded-lg border border-border/30 hover:border-border/60 transition-colors p-3 space-y-2">
                      {/* Row 1: Name, contact, status, date */}
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-sm">{lead.lead_name || '—'}</span>
                          <div className="flex items-center gap-3 mt-0.5">
                            {lead.lead_email && <span className="text-xs text-muted-foreground truncate">{lead.lead_email}</span>}
                            {lead.lead_phone && <span className="text-xs text-muted-foreground">{lead.lead_phone}</span>}
                          </div>
                        </div>
                        <Badge variant={lead.status === 'success' ? 'default' : 'destructive'} className="text-[10px] shrink-0">
                          {lead.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                          {new Date(lead.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>

                      {/* Row 2: Location + Capital */}
                      {(payload.cidade || payload.estado || payload.capital_disponivel) && (
                        <div className="flex items-center gap-3 flex-wrap">
                          {(payload.cidade || payload.estado) && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {[payload.cidade, payload.estado].filter(Boolean).join(' / ')}
                            </span>
                          )}
                          {payload.capital_disponivel && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <DollarSign className="h-3 w-3" />
                              {payload.capital_disponivel}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Row 3: UTMs */}
                      {(payload.utm_source || payload.utm_medium || payload.utm_campaign || payload.utm_content || payload.utm_term) && (
                        <div className="flex items-center gap-2 flex-wrap">
                          {payload.utm_source && (
                            <Badge variant="outline" className="text-[10px] font-normal gap-1">
                              source: {payload.utm_source}
                            </Badge>
                          )}
                          {payload.utm_medium && (
                            <Badge variant="outline" className="text-[10px] font-normal gap-1">
                              medium: {payload.utm_medium}
                            </Badge>
                          )}
                          {payload.utm_campaign && (
                            <Badge variant="outline" className="text-[10px] font-normal gap-1">
                              campaign: {payload.utm_campaign}
                            </Badge>
                          )}
                          {payload.utm_content && (
                            <Badge variant="outline" className="text-[10px] font-normal gap-1">
                              content: {payload.utm_content}
                            </Badge>
                          )}
                          {payload.utm_term && (
                            <Badge variant="outline" className="text-[10px] font-normal gap-1">
                              term: {payload.utm_term}
                            </Badge>
                          )}
                        </div>
                      )}

                      {/* Row 4: Click IDs + Landing Page */}
                      {(payload.gclid || payload.fbclid || payload.landing_page || payload.referrer) && (
                        <div className="flex items-center gap-2 flex-wrap">
                          {payload.gclid && (
                            <Badge variant="outline" className="text-[10px] font-normal text-blue-400 border-blue-400/30">
                              Google Ads
                            </Badge>
                          )}
                          {payload.fbclid && (
                            <Badge variant="outline" className="text-[10px] font-normal text-indigo-400 border-indigo-400/30">
                              Meta Ads
                            </Badge>
                          )}
                          {payload.landing_page && (
                            <span className="text-[10px] text-muted-foreground truncate max-w-[300px]" title={payload.landing_page}>
                              LP: {payload.landing_page.replace(/https?:\/\//, '').split('?')[0]}
                            </span>
                          )}
                          {payload.referrer && !payload.landing_page && (
                            <span className="text-[10px] text-muted-foreground truncate max-w-[300px]" title={payload.referrer}>
                              Ref: {payload.referrer.replace(/https?:\/\//, '')}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

// ─── List View ────────────────────────────────────────────────────────
function ListView({
  forms,
  isLoading,
  onNewForm,
  onEdit,
  onCopyEmbed,
  onToggle,
  onDelete,
  onViewLeads,
}: {
  forms: MarketingForm[];
  isLoading: boolean;
  onNewForm: () => void;
  onEdit: (form: MarketingForm) => void;
  onCopyEmbed: (id: string) => void;
  onToggle: (id: string, is_active: boolean) => void;
  onDelete: (id: string) => void;
  onViewLeads: (id: string, name: string) => void;
}) {
  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <MarketingPageHeader
        eyebrow="Marketing · Captura"
        title="Formulários"
        description="Crie formulários embeddáveis para suas landing pages, distribua leads e acompanhe respostas."
        action={
          <Button size="sm" className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5" onClick={onNewForm}>
            <Plus className="h-3.5 w-3.5" /> Novo formulário
          </Button>
        }
      />

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : forms.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <p className="text-lg font-medium">Nenhum formulário ainda</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Crie seu primeiro formulário para começar a captar leads
            </p>
            <Button onClick={onNewForm} variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              Criar formulário
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {forms.map((form) => (
            <Card
              key={form.id}
              className="group relative overflow-hidden hover:shadow-lg hover:shadow-primary/5 hover:border-primary/20 transition-all duration-300"
            >
              {/* Status indicator bar */}
              <div className={cn(
                "absolute top-0 left-0 right-0 h-0.5",
                form.is_active ? "bg-green-500" : "bg-muted-foreground/20"
              )} />

              <CardContent className="p-0">
                {/* Header — clickable to edit */}
                <div
                  className="p-5 pb-4 cursor-pointer"
                  onClick={() => onEdit(form)}
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-[15px] truncate group-hover:text-primary transition-colors">
                        {form.name}
                      </h3>
                      {form.description && (
                        <p className="text-xs text-muted-foreground truncate mt-1">
                          {form.description}
                        </p>
                      )}
                    </div>
                    <div className={cn(
                      "shrink-0 flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full",
                      form.is_active
                        ? "bg-green-500/10 text-green-500"
                        : "bg-muted text-muted-foreground"
                    )}>
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        form.is_active ? "bg-green-500" : "bg-muted-foreground"
                      )} />
                      {form.is_active ? 'Ativo' : 'Inativo'}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-5">
                    <div className="flex items-center gap-1.5">
                      <div className="h-7 w-7 rounded-md bg-muted/60 flex items-center justify-center">
                        <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold leading-none">{form.fields.length}</p>
                        <p className="text-[10px] text-muted-foreground">campos</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="h-7 w-7 rounded-md bg-muted/60 flex items-center justify-center">
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold leading-none">{form.submissions_count || 0}</p>
                        <p className="text-[10px] text-muted-foreground">leads</p>
                      </div>
                    </div>
                    {form.last_submission_at && (
                      <div className="flex items-center gap-1.5 ml-auto">
                        <div className="text-right">
                          <p className="text-[10px] text-muted-foreground">Último lead</p>
                          <p className="text-[11px] font-medium">
                            {format(new Date(form.last_submission_at), "dd/MM 'às' HH:mm", { locale: ptBR })}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions bar */}
                <div
                  className="flex items-center border-t border-border/40 divide-x divide-border/40"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    onClick={() => onEdit(form)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Editar
                  </button>
                  <button
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    onClick={() => onCopyEmbed(form.id)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Embed
                  </button>
                  <button
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    onClick={() => onViewLeads(form.id, form.name)}
                  >
                    <Users className="h-3.5 w-3.5" />
                    Leads
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="px-3 flex items-center justify-center py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onClick={() => onToggle(form.id, form.is_active)}>
                        {form.is_active ? <ToggleLeft className="h-4 w-4 mr-2" /> : <ToggleRight className="h-4 w-4 mr-2" />}
                        {form.is_active ? 'Desativar' : 'Ativar'}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onDelete(form.id)}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Excluir
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helper: linha compacta de color picker reutilizável ─────────────
function StyleColorRow({
  label, value, onChange, disabled,
}: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-7 w-7 rounded cursor-pointer border border-border/50 shrink-0 disabled:opacity-50"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-7 text-[11px] font-mono px-1.5"
        />
      </div>
    </div>
  );
}

// ─── Builder View ─────────────────────────────────────────────────────
function BuilderView({
  formName,
  formDescription,
  fields,
  style,
  settings,
  redirectUrl,
  successMessage,
  distributionConfigId,
  expandedFieldId,
  isSaving,
  isEditing,
  sensors,
  onFormNameChange,
  onFormDescriptionChange,
  onStyleChange,
  onRedirectUrlChange,
  onSuccessMessageChange,
  onDistributionConfigIdChange,
  onExpandField,
  onUpdateField,
  onDeleteField,
  onAddField,
  onDragEnd,
  onSave,
  onCancel,
}: {
  formName: string;
  formDescription: string;
  fields: FormField[];
  style: FormStyle;
  settings: FormSettings;
  redirectUrl: string;
  successMessage: string;
  distributionConfigId: string;
  expandedFieldId: string | null;
  isSaving: boolean;
  isEditing: boolean;
  sensors: ReturnType<typeof useSensors>;
  onFormNameChange: (v: string) => void;
  onFormDescriptionChange: (v: string) => void;
  onStyleChange: (updates: Partial<FormStyle>) => void;
  onRedirectUrlChange: (v: string) => void;
  onSuccessMessageChange: (v: string) => void;
  onDistributionConfigIdChange: (v: string) => void;
  onExpandField: (id: string | null) => void;
  onUpdateField: (id: string, updates: Partial<FormField>) => void;
  onDeleteField: (id: string) => void;
  onAddField: (type: FieldType) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border/40 bg-background/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onCancel} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
          <div className="h-5 w-px bg-border/40" />
          <span className="text-sm font-medium text-muted-foreground">
            {isEditing ? 'Editar formulário' : 'Novo formulário'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
          <Button size="sm" onClick={onSave} disabled={isSaving} className="gap-1.5">
            {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Salvar
          </Button>
        </div>
      </div>

      {/* Split layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel - Editor */}
        <div className="w-[60%] border-r border-border/40 overflow-y-auto p-6 space-y-6">
          {/* Form identity */}
          <div className="space-y-3">
            <Input
              value={formName}
              onChange={(e) => onFormNameChange(e.target.value)}
              placeholder="Nome do formulário"
              className="text-lg font-semibold border-none shadow-none px-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/40"
            />
            <Input
              value={formDescription}
              onChange={(e) => onFormDescriptionChange(e.target.value)}
              placeholder="Descrição (opcional)"
              className="text-sm border-none shadow-none px-0 h-auto focus-visible:ring-0 text-muted-foreground placeholder:text-muted-foreground/30"
            />
          </div>

          {/* Fields */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Campos
              </h3>
              <span className="text-xs text-muted-foreground">{fields.length} campos</span>
            </div>

            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={fields.map((f) => f.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-2">
                  {fields.map((field) => (
                    <SortableFieldItem
                      key={field.id}
                      field={field}
                      isExpanded={expandedFieldId === field.id}
                      onToggleExpand={() =>
                        onExpandField(expandedFieldId === field.id ? null : field.id)
                      }
                      onUpdate={(updates) => onUpdateField(field.id, updates)}
                      onDelete={() => onDeleteField(field.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {/* Add field */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full gap-2 mt-2 border-dashed">
                  <Plus className="h-4 w-4" />
                  Adicionar Campo
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-48">
                {FIELD_TYPE_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => onAddField(opt.value)}
                    className="gap-2"
                  >
                    {FIELD_ICON[opt.value]}
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Style section — organizado em accordions com controles granulares */}
          <div className="space-y-2 pt-4 border-t border-border/30">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Estilo
            </h3>

            <StyleColorRow label="Cor de destaque (foco, ícones)"
              value={style.primary_color}
              onChange={(v) => onStyleChange({ primary_color: v })}
            />

            {/* === Container === */}
            <details open className="rounded-lg border border-border/30 bg-card/40 group">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground px-3 py-2 list-none flex items-center justify-between hover:bg-muted/30 rounded-lg">
                <span>Container do formulário</span>
                <ChevronDown className="h-3.5 w-3.5 group-open:rotate-180 transition-transform" />
              </summary>
              <div className="p-3 pt-2 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <StyleColorRow label="Fundo do form"
                    value={style.bg_color === 'transparent' ? '#ffffff' : style.bg_color}
                    onChange={(v) => onStyleChange({ bg_color: v })}
                    disabled={style.bg_color === 'transparent'}
                  />
                  <StyleColorRow label="Texto geral (título)"
                    value={style.text_color}
                    onChange={(v) => onStyleChange({ text_color: v })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={style.bg_color === 'transparent'}
                    onCheckedChange={(checked) => onStyleChange({ bg_color: checked ? 'transparent' : '#ffffff' })}
                  />
                  <Label className="text-xs text-muted-foreground cursor-pointer">
                    Vidro fosco (para fundos escuros/imagens)
                  </Label>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Arredondamento dos cantos: {style.border_radius}px
                  </Label>
                  <Slider
                    value={[style.border_radius]}
                    onValueChange={([v]) => onStyleChange({ border_radius: v })}
                    min={0} max={24} step={1}
                  />
                </div>
              </div>
            </details>

            {/* === Inputs (NOVO — cores granulares) === */}
            <details className="rounded-lg border border-border/30 bg-card/40 group">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground px-3 py-2 list-none flex items-center justify-between hover:bg-muted/30 rounded-lg">
                <span>Inputs (campos)</span>
                <ChevronDown className="h-3.5 w-3.5 group-open:rotate-180 transition-transform" />
              </summary>
              <div className="p-3 pt-2 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <StyleColorRow label="Fundo do input"
                    value={style.input_bg_color || style.bg_color}
                    onChange={(v) => onStyleChange({ input_bg_color: v })}
                  />
                  <StyleColorRow label="Texto digitado"
                    value={style.input_text_color || style.text_color}
                    onChange={(v) => onStyleChange({ input_text_color: v })}
                  />
                  <StyleColorRow label="Cor do label"
                    value={style.label_color || style.text_color}
                    onChange={(v) => onStyleChange({ label_color: v })}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground/70">
                  💡 Permite, por exemplo, ter inputs brancos num formulário com fundo colorido.
                </p>
              </div>
            </details>

            {/* === Botão (NOVO — separado da cor principal) === */}
            <details className="rounded-lg border border-border/30 bg-card/40 group">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground px-3 py-2 list-none flex items-center justify-between hover:bg-muted/30 rounded-lg">
                <span>Botão</span>
                <ChevronDown className="h-3.5 w-3.5 group-open:rotate-180 transition-transform" />
              </summary>
              <div className="p-3 pt-2 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Texto do botão</Label>
                    <Input
                      value={style.button_text}
                      onChange={(e) => onStyleChange({ button_text: e.target.value })}
                      placeholder="Enviar"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Estilo</Label>
                    <Select
                      value={style.button_style}
                      onValueChange={(v) => onStyleChange({ button_style: v as 'solid' | 'outline' | 'gradient' })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="solid">Sólido</SelectItem>
                        <SelectItem value="outline">Outline (borda)</SelectItem>
                        <SelectItem value="gradient">Gradiente</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <StyleColorRow label="Cor do botão"
                    value={style.button_color || style.primary_color}
                    onChange={(v) => onStyleChange({ button_color: v })}
                  />
                  <StyleColorRow label="Cor do texto do botão"
                    value={style.button_text_color || (style.button_style === 'outline' ? (style.button_color || style.primary_color) : '#ffffff')}
                    onChange={(v) => onStyleChange({ button_text_color: v })}
                  />
                </div>
              </div>
            </details>

            {/* === Tipografia (NOVO — font picker com Google Fonts) === */}
            <details className="rounded-lg border border-border/30 bg-card/40 group">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground px-3 py-2 list-none flex items-center justify-between hover:bg-muted/30 rounded-lg">
                <span>Tipografia</span>
                <ChevronDown className="h-3.5 w-3.5 group-open:rotate-180 transition-transform" />
              </summary>
              <div className="p-3 pt-2 space-y-2">
                <Label className="text-xs text-muted-foreground">Fonte do formulário</Label>
                <Select
                  value={(() => {
                    const match = GOOGLE_FONTS.find(f => style.font_family.includes(f.value));
                    return match?.value || '__custom__';
                  })()}
                  onValueChange={(v) => {
                    if (v === '__custom__') return;
                    const font = GOOGLE_FONTS.find(f => f.value === v);
                    if (font) {
                      loadGoogleFont(font.value);
                      onStyleChange({ font_family: font.family });
                    }
                  }}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GOOGLE_FONTS.map(f => (
                      <SelectItem
                        key={f.value}
                        value={f.value}
                        onMouseEnter={() => loadGoogleFont(f.value)}
                      >
                        <span style={{ fontFamily: f.family }}>{f.label}</span>
                      </SelectItem>
                    ))}
                    <SelectItem value="__custom__">
                      <span className="italic text-muted-foreground">Customizada (atual: {style.font_family.split(',')[0]})</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={style.font_family}
                  onChange={(e) => onStyleChange({ font_family: e.target.value })}
                  placeholder="Ex: 'Inter', sans-serif"
                  className="h-8 text-xs font-mono"
                />
                <p className="text-[10px] text-muted-foreground/70">
                  💡 Escolha uma fonte do dropdown OU digite uma família CSS customizada.
                </p>
              </div>
            </details>
          </div>

          {/* Distribution section */}
          <div className="space-y-4 pt-4 border-t border-border/30">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Distribuição dos Leads
            </h3>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                Regra que recebe os leads deste formulário
              </Label>
              <DistributionSelector value={distributionConfigId} onChange={onDistributionConfigIdChange} />
              <p className="text-[10px] text-muted-foreground">
                Configure as regras em <strong>Configurações → Distribuição de Leads</strong>.
              </p>
            </div>
          </div>

          {/* Behavior section */}
          <div className="space-y-4 pt-4 border-t border-border/30">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Comportamento
            </h3>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">URL de redirecionamento (opcional)</Label>
              <Input
                value={redirectUrl}
                onChange={(e) => onRedirectUrlChange(e.target.value)}
                placeholder="https://seusite.com/obrigado"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Mensagem de sucesso</Label>
              <Textarea
                value={successMessage}
                onChange={(e) => onSuccessMessageChange(e.target.value)}
                rows={2}
                placeholder="Obrigado! Entraremos em contato em breve."
              />
            </div>
          </div>
        </div>

        {/* Right panel - Preview */}
        <div className="w-[40%] bg-muted/30 overflow-y-auto">
          <div className="p-6 space-y-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              <span className="font-medium uppercase tracking-wider">Preview</span>
            </div>

            <div className="rounded-xl border border-border/40 overflow-hidden shadow-sm bg-background">
              {fields.length > 0 ? (
                <FormPreview
                  fields={fields}
                  style={style}
                  successMessage={successMessage}
                />
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center px-6">
                  <LayoutGrid className="h-10 w-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Adicione campos para ver o preview
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
