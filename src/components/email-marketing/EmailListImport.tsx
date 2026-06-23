import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Upload, FileText, X, Check, AlertCircle, Download, Table } from "lucide-react";
import { toast } from "sonner";

interface Props {
  value: string[];
  onChange: (emails: string[]) => void;
}

// Regex de validação de email
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
// Regex universal pra extrair emails de qualquer formato (XML, TXT, JSON, etc).
const EMAIL_EXTRACT_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

type ParseResult = {
  valid: string[];
  total: number;
  invalid: number;
  mode: "structured" | "universal";
};

// Parser CSV simples (sem aspas escapadas — cobre 99% dos casos)
function parseCSV(text: string): string[][] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  return lines.map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")));
}

function extractFromCSV(text: string): ParseResult | null {
  const rows = parseCSV(text);
  if (rows.length < 1) return null;

  // Procura coluna "email" no header (case-insensitive)
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const emailIdx = header.findIndex((h) => h === "email" || h === "e-mail" || h === "endereco_email");

  if (emailIdx === -1) return null; // header não bate → cai pro modo universal

  const set = new Set<string>();
  let total = 0;
  let invalid = 0;
  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i][emailIdx]?.trim().toLowerCase();
    if (!raw) continue;
    total++;
    if (EMAIL_REGEX.test(raw)) set.add(raw);
    else invalid++;
  }
  return { valid: [...set], total, invalid, mode: "structured" };
}

function extractUniversal(text: string): ParseResult {
  const matches = text.match(EMAIL_EXTRACT_REGEX) || [];
  const set = new Set(matches.map((e) => e.trim().toLowerCase()));
  return { valid: [...set], total: matches.length, invalid: 0, mode: "universal" };
}

export default function EmailListImport({ value, onChange }: Props) {
  const [parsing, setParsing] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [lastMode, setLastMode] = useState<"structured" | "universal" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setParsing(true);
    try {
      const text = await file.text();
      // Primeiro tenta CSV estruturado (coluna `email`), depois cai pro regex universal
      let result: ParseResult | null = null;
      if (file.name.toLowerCase().endsWith(".csv") || text.includes(",")) {
        result = extractFromCSV(text);
      }
      if (!result) result = extractUniversal(text);

      if (result.valid.length === 0) {
        toast.error("Nenhum email válido encontrado no arquivo");
        return;
      }
      onChange(result.valid);
      setLastMode(result.mode);
      const dedupedOut = result.total - result.valid.length - result.invalid;
      const desc: string[] = [];
      if (result.invalid > 0) desc.push(`${result.invalid} inválidos descartados`);
      if (dedupedOut > 0) desc.push(`${dedupedOut} duplicados removidos`);
      toast.success(`${result.valid.length} emails únicos`, {
        description: desc.join(" · ") || undefined,
      });
    } catch (err: any) {
      toast.error("Erro ao ler arquivo", { description: err.message });
    } finally {
      setParsing(false);
    }
  };

  const handlePaste = () => {
    if (!pasteText.trim()) {
      toast.error("Cole emails na caixa de texto primeiro");
      return;
    }
    const r = extractUniversal(pasteText);
    if (r.valid.length === 0) {
      toast.error("Nenhum email válido detectado no texto colado");
      return;
    }
    onChange(r.valid);
    setLastMode("universal");
    toast.success(`${r.valid.length} emails únicos extraídos`, {
      description: r.total > r.valid.length ? `(${r.total - r.valid.length} duplicados removidos)` : undefined,
    });
    setPasteText("");
  };

  const handleClear = () => {
    onChange([]);
    setLastMode(null);
  };

  return (
    <div className="space-y-4">
      {/* Banner do template */}
      <div className="rounded-lg border bg-primary/5 border-primary/20 p-3 flex items-center justify-between gap-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <Table className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium">Tem uma planilha pronta?</p>
            <p className="text-xs text-muted-foreground">
              Baixa o modelo, preenche com os dados (1 email por linha) e sobe aqui. Funciona com Excel,
              Google Sheets e qualquer editor de planilha — salva como <code className="font-mono bg-muted px-1 rounded">.csv</code>.
            </p>
          </div>
        </div>
        <Button asChild type="button" variant="outline" size="sm" className="flex-shrink-0">
          <a href="/modelo-campanha-emails.csv" download="modelo-campanha-emails.csv">
            <Download className="h-4 w-4 mr-1.5" />
            Baixar modelo
          </a>
        </Button>
      </div>

      {/* Upload de arquivo */}
      <div className="border-2 border-dashed rounded-lg p-6 text-center hover:border-primary transition-colors">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xml,.txt,.json,.xlsx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
          className="hidden"
        />
        <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium mb-1">
          Importar lista de emails
        </p>
        <p className="text-xs text-muted-foreground mb-3">
          CSV (recomendado) · XML · TXT · JSON
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={parsing}
        >
          <FileText className="h-4 w-4 mr-1.5" />
          {parsing ? "Lendo..." : "Selecionar arquivo"}
        </Button>
      </div>

      {/* Ou colar texto */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Ou cole uma lista de emails (separados por espaço, vírgula, quebra de linha — tanto faz):
        </p>
        <Textarea
          rows={4}
          placeholder="ex: maria@empresa.com, joao@cliente.com&#10;pedro@outro.com"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
        <Button type="button" variant="outline" size="sm" onClick={handlePaste}>
          <Check className="h-4 w-4 mr-1.5" />
          Extrair emails do texto
        </Button>
      </div>

      {/* Preview dos emails carregados */}
      {value.length > 0 && (
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="default" className="bg-emerald-600">
                <Check className="h-3 w-3 mr-1" /> {value.length} emails
              </Badge>
              <span className="text-xs text-muted-foreground">prontos pra disparo</span>
              {lastMode === "structured" && (
                <Badge variant="outline" className="text-[10px]">
                  CSV estruturado
                </Badge>
              )}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={handleClear} className="text-destructive">
              <X className="h-3 w-3 mr-1" /> Limpar
            </Button>
          </div>
          <div className="max-h-32 overflow-y-auto text-xs font-mono text-muted-foreground space-y-0.5">
            {value.slice(0, 50).map((e) => (
              <div key={e}>{e}</div>
            ))}
            {value.length > 50 && (
              <div className="text-muted-foreground/70">
                ... + {value.length - 50} outros
              </div>
            )}
          </div>
        </div>
      )}

      {/* Aviso LGPD */}
      <div className="text-xs text-muted-foreground flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-900">
        <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div>
          <strong>Atenção LGPD:</strong> só envie pra emails que opt-in pra receber sua comunicação.
          Cada email recebe link de descadastro automaticamente. Listas compradas ou sem consentimento
          podem violar a LGPD e prejudicar a reputação do seu domínio no Resend.
        </div>
      </div>
    </div>
  );
}
