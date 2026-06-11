import { AppLayout } from "@/components/layout/AppLayout";
import { ProductsTable } from "@/components/products";
import { Package } from "lucide-react";

const Products = () => {
  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Package className="h-6 w-6 text-primary shrink-0" />
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground">Produtos</h1>
            <p className="text-sm text-muted-foreground">Gerencie os produtos disponíveis para venda</p>
          </div>
        </div>
        <ProductsTable />
      </div>
    </AppLayout>
  );
};

export default Products;
