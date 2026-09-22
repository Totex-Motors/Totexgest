import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Copy, Share2, QrCode, Car, Instagram } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

// Compartilhar o Totexcar Co-pilot (isca de pós-venda pro DONO do carro) com o
// código da promotora embutido, pra rastrear o lead e amarrar a ela.
//
// Fluxo: a promotora compartilha o pitch → a pessoa toca no link → abre o WhatsApp
// do Co-pilot com a mensagem "#stand totexmotors <code>" pré-preenchida → ao enviar,
// o Co-pilot registra o lead atribuído (e o robô import-copilot-leads traz pro CRM).
//
// TODO: mover número/handle pra config quando houver mais de uma loja usando.
const COPILOT_WA = "5511963786699"; // WhatsApp do Totexcar Co-pilot
const IG_HANDLE = "totexmotors";

export function CopilotShareCard({ code }: { code: string | null | undefined }) {
  const [showQr, setShowQr] = useState(false);

  // Link que a PESSOA envia pro Co-pilot (com a atribuição da promotora).
  const activationLink = useMemo(() => {
    if (!code) return "";
    const msg = `Quero ativar o Totexcar Co-pilot 🚗 #stand totexmotors ${code}`;
    return `https://wa.me/${COPILOT_WA}?text=${encodeURIComponent(msg)}`;
  }, [code]);

  // Pitch que a PROMOTORA compartilha (com a isca + CTA do Instagram).
  const pitch = useMemo(
    () =>
      `🚗 Ganhe o *Totexcar Co-pilot* de graça — ele cuida do seu carro pra você: ` +
      `avisa IPVA, revisão, multas e o valor de FIPE.\n\n` +
      `Ative agora 👉 ${activationLink}\n\n` +
      `E segue a gente no Instagram: instagram.com/${IG_HANDLE} 💚`,
    [activationLink],
  );

  async function copyPitch() {
    if (!pitch) return;
    try {
      await navigator.clipboard.writeText(pitch);
      toast.success("Mensagem copiada! Cole no WhatsApp da pessoa.");
    } catch {
      toast.error("Não consegui copiar. Segure o texto pra copiar manualmente.");
    }
  }

  async function sharePitch() {
    if (!pitch) return;
    if (navigator.share) {
      try { await navigator.share({ title: "Totexcar Co-pilot", text: pitch }); } catch { /* cancelado */ }
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(pitch)}`, "_blank");
    }
  }

  if (!code) return null;

  return (
    <Card className="border-sky-200/70 bg-sky-50/50 dark:bg-sky-950/20 dark:border-sky-900/50">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="h-8 w-8 rounded-lg bg-sky-600/15 text-sky-700 dark:text-sky-400 flex items-center justify-center shrink-0">
            <Car className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Presenteie o Co-pilot 🎁</p>
            <p className="text-[11px] text-muted-foreground">
              Dá o Totexcar Co-pilot de graça pro dono do carro — quebra o gelo e traz o lead pra você.
            </p>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-2">
          <button type="button" onClick={copyPitch} className="flex flex-col items-center gap-1 rounded-lg border border-border/70 py-2 text-xs font-medium hover:bg-muted/50">
            <Copy className="h-4 w-4" /> Copiar
          </button>
          <button type="button" onClick={sharePitch} className="flex flex-col items-center gap-1 rounded-lg border border-border/70 py-2 text-xs font-medium hover:bg-muted/50">
            <Share2 className="h-4 w-4" /> Compartilhar
          </button>
          <button type="button" onClick={() => setShowQr((v) => !v)} className="flex flex-col items-center gap-1 rounded-lg border border-border/70 py-2 text-xs font-medium hover:bg-muted/50">
            <QrCode className="h-4 w-4" /> {showQr ? "Ocultar" : "QR Code"}
          </button>
        </div>

        {showQr && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <div className="rounded-xl bg-white p-3 shadow-sm">
              <QRCodeSVG value={activationLink} size={180} level="M" marginSize={0} />
            </div>
            <p className="text-[11px] text-muted-foreground text-center">A pessoa aponta a câmera → abre o Co-pilot já ativando por você.</p>
          </div>
        )}

        <p className="mt-3 text-[11px] text-muted-foreground flex items-center gap-1">
          <Instagram className="h-3 w-3" /> A mensagem já convida a seguir o @{IG_HANDLE}.
        </p>
      </CardContent>
    </Card>
  );
}
