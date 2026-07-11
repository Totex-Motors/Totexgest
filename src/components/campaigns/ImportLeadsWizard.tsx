/**
 * ImportLeadsWizard — importação de leads via CSV (automotivo).
 *
 * Fluxo: escolher arquivo → mapear colunas (auto-detecta nome/telefone/email/
 * veículo/cidade) → prévia → importar em lotes com dedup por telefone.
 * Registra o resultado em import_jobs (histórico da página Importar Leads).
 *
 * Dois modos de uso:
 *  - inline (página /marketing/importar): <ImportLeadsWizard onImportComplete={...} />
 *  - dialog (SalesCampaigns): <ImportLeadsWizard open={...} onOpenChange={...} />
 */
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Upload, FileSpreadsheet, Loader2, CheckCircle2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

interface ImportLeadsWizardProps {
  onImportComplete?: () => void;
  onComplete?: () => void;
  /** modo dialog (legado SalesCampaigns) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// Campos do CRM disponíveis pro mapeamento
const CRM_FIELDS = [
  { value: "ignore", label: "— Ignorar —" },
  { value: "name", label: "Nome" },
  { value: "phone", label: "Telefone" },
  { value: "email", label: "E-mail" },
  { value: "veiculo", label: "Veículo de interesse" },
  { value: "city_name", label: "Cidade" },
  { value: "state", label: "Estado (UF)" },
  { value: "notes", label: "Observações" },
] as const;

// Auto-detecção de coluna pelo cabeçalho
function guessField(header: string): string {
  const h = header.trim().toLowerCase();
  if (/nome|name/.test(h)) return "name";
  if (/fone|phone|celular|whats|contato/.test(h)) return "phone";
  if (/mail/.test(h)) return "email";
  if (/ve[ií]culo|carro|modelo|interesse|vehicle/.test(h)) return "veiculo";
  if (/cidade|city/.test(h)) return "city_name";
  if (/estado|^uf$|state/.test(h)) return "state";
  if (/obs|nota|coment/.test(h)) return "notes";
  return "ignore";
}

// Parser CSV simples com suporte a aspas e separador , ou ;
function parseCSV(text: string): string[][] {
  const firstLine = text.slice(0, text.indexOf("\n") > 0 ? text.indexOf("\n") : text.length);
  const sep = (firstLine.match(/;/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0) ? ";" : ",";
  const rows: string[][] = [];
  let cur = "", row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); if (row.some((v) => v.trim() !== "")) rows.push(row); }
  return rows;
}

const normPhone = (v: string) => v.replace(/\D/g, "");

export default function ImportLeadsWizard({ onImportComplete, onComplete, open, onOpenChange }: ImportLeadsWizardProps) {
  const { teamMember } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<{ created: number; skipped: number; failed: number } | null>(null);

  const handleFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseCSV(text);
    if (parsed.length < 2) {
      toast.error("Arquivo vazio ou sem linhas de dados.");
      return;
    }
    setFileName(file.name);
    setHeaders(parsed[0]);
    setRows(parsed.slice(1));
    setMapping(parsed[0].map(guessField));
    setDone(null);
  };

  const mappedPreview = useMemo(() => rows.slice(0, 5), [rows]);
  const hasNameOrPhone = mapping.includes("name") || mapping.includes("phone");

  const handleImport = async () => {
    if (!hasNameOrPhone) {
      toast.error("Mapeie pelo menos a coluna de Nome ou Telefone.");
      return;
    }
    setImporting(true);
    let created = 0, skipped = 0, failed = 0;
    try {
      // Dedup por telefone contra a base existente
      const phoneIdx = mapping.indexOf("phone");
      const phones = phoneIdx >= 0
        ? rows.map((r) => normPhone(r[phoneIdx] || "")).filter((p) => p.length >= 8)
        : [];
      const existing = new Set<string>();
      for (let i = 0; i < phones.length; i += 200) {
        const chunk = phones.slice(i, i + 200);
        const { data } = await supabase.from("leads").select("phone").in("phone", chunk);
        (data || []).forEach((l: any) => l.phone && existing.add(normPhone(l.phone)));
      }

      const get = (r: string[], field: string) => {
        const idx = mapping.indexOf(field);
        return idx >= 0 ? (r[idx] || "").trim() : "";
      };

      const inserts: Record<string, unknown>[] = [];
      for (const r of rows) {
        const phone = normPhone(get(r, "phone"));
        const name = get(r, "name");
        if (!name && !phone) { skipped++; continue; }
        if (phone && existing.has(phone)) { skipped++; continue; }
        if (phone) existing.add(phone);
        const veiculo = get(r, "veiculo");
        inserts.push({
          name: name || `Lead ${phone}`,
          phone: phone || null,
          email: get(r, "email") || null,
          city_name: get(r, "city_name") || null,
          state: get(r, "state") || null,
          source: "import_csv",
          status: "new",
          sales_stage: "new",
          context: get(r, "notes") || null,
          metadata: veiculo ? { veiculo_interesse_texto: veiculo } : {},
        });
      }

      for (let i = 0; i < inserts.length; i += 100) {
        const chunk = inserts.slice(i, i + 100);
        const { error } = await supabase.from("leads").insert(chunk);
        if (error) failed += chunk.length;
        else created += chunk.length;
      }

      await supabase.from("import_jobs").insert({
        created_by: teamMember?.id || null,
        file_name: fileName,
        total_rows: rows.length,
        created_count: created,
        updated_count: 0,
        skipped_count: skipped,
        failed_count: failed,
        config: { mapping, headers },
      });

      setDone({ created, skipped, failed });
      toast.success(`Importação concluída: ${created} leads criados.`);
      onImportComplete?.();
      onComplete?.();
    } catch (e: any) {
      toast.error(`Erro na importação: ${e?.message || e}`);
    } finally {
      setImporting(false);
    }
  };

  const reset = () => { setHeaders([]); setRows([]); setDone(null); setFileName(""); };

  const body = done ? (
    <Card className="p-8 text-center border-0 shadow-none">
      <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-500" />
      <p className="font-semibold">Importação concluída!</p>
      <p className="text-sm text-muted-foreground mt-1">
        {done.created} criados · {done.skipped} pulados (duplicados/vazios) · {done.failed} falhas
      </p>
      <Button variant="outline" className="mt-4" onClick={reset}>
        Nova importação
      </Button>
    </Card>
  ) : headers.length === 0 ? (
    <Card
      className="p-10 text-center border-dashed cursor-pointer hover:bg-muted/40 transition-colors"
      onClick={() => fileRef.current?.click()}
    >
      <Upload className="h-8 w-8 mx-auto mb-3 opacity-60" />
      <p className="text-sm font-medium">Clique pra escolher um arquivo CSV</p>
      <p className="text-xs text-muted-foreground mt-1">
        Colunas sugeridas: nome, telefone, email, veículo, cidade. Separador vírgula ou ponto e vírgula.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
      />
    </Card>
  ) : (
    <Card className="border-0 shadow-none">
      <CardContent className="p-1 sm:p-4 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm">
            <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
            <span className="font-medium">{fileName}</span>
            <Badge variant="secondary">{rows.length} linhas</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={reset}>
            Trocar arquivo
          </Button>
        </div>

        {/* Mapeamento de colunas + prévia */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {headers.map((h, i) => (
                  <TableHead key={i} className="min-w-[150px]">
                    <div className="space-y-1 py-1">
                      <p className="text-xs font-semibold truncate" title={h}>{h}</p>
                      <Select value={mapping[i]} onValueChange={(v) => setMapping((m) => m.map((x, j) => (j === i ? v : x)))}>
                        <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CRM_FIELDS.map((f) => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappedPreview.map((r, ri) => (
                <TableRow key={ri}>
                  {headers.map((_, ci) => (
                    <TableCell key={ci} className="text-xs text-muted-foreground truncate max-w-[180px]">
                      {r[ci]}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground">
            Duplicados por telefone são pulados. Veículo vai pro perfil de compra do lead.
          </p>
          <Button onClick={handleImport} disabled={importing || !hasNameOrPhone}>
            {importing && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
            Importar {rows.length} leads
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  // Modo dialog (compatibilidade com SalesCampaigns)
  if (open !== undefined && onOpenChange) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" /> Importar Leads
            </DialogTitle>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return body;
}
