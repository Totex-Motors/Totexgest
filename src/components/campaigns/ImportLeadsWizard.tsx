/**
 * ImportLeadsWizard — stub
 *
 * Componente não veio no pacote de marketing (referência em SalesCampaigns.tsx).
 * Quando o fluxo "Importar leads" for solicitado, substitua este stub pela
 * implementação real. Por ora só renderiza um placeholder pra não quebrar build.
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Upload } from "lucide-react";

interface ImportLeadsWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

export default function ImportLeadsWizard({ open, onOpenChange }: ImportLeadsWizardProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Importar Leads
          </DialogTitle>
          <DialogDescription>
            Funcionalidade ainda não disponível neste módulo. Em breve.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
