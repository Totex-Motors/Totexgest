import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CommissionSummaryCard,
  CommissionsTable,
  CommissionRulesTable,
} from "@/components/sales/commissions";
import { DollarSign, Settings, List } from "lucide-react";

const Commissions = () => {
  const [activeTab, setActiveTab] = useState("commissions");

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <DollarSign className="h-6 w-6 text-primary shrink-0" />
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground">Comissões</h1>
            <p className="text-sm text-muted-foreground">Gerencie comissões e regras de pagamento</p>
          </div>
        </div>

        {/* Summary Cards */}
        <CommissionSummaryCard />

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="commissions" className="gap-2">
              <List className="h-4 w-4" />
              Comissoes
            </TabsTrigger>
            <TabsTrigger value="rules" className="gap-2">
              <Settings className="h-4 w-4" />
              Regras
            </TabsTrigger>
          </TabsList>

          <TabsContent value="commissions" className="mt-6">
            <CommissionsTable />
          </TabsContent>

          <TabsContent value="rules" className="mt-6">
            <CommissionRulesTable />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
};

export default Commissions;
