import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, History, FileSpreadsheet, Calendar, User, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import ImportLeadsWizard from '@/components/campaigns/ImportLeadsWizard';

interface ImportJob {
  id: string;
  file_name: string | null;
  total_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  failed_count: number;
  config: Record<string, any>;
  created_at: string;
  created_by_member?: { name: string } | null;
}

function useImportJobs() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: ['import-jobs', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('import_jobs')
        .select('*, created_by_member:team_members!created_by(name)')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as ImportJob[];
    },
    enabled: !!tenantId,
  });
}

export default function ImportLeads() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'import';
  const { teamMember, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const { data: importJobs, isLoading: jobsLoading } = useImportJobs();

  const handleTabChange = (value: string) => {
    setSearchParams(value === 'import' ? {} : { tab: value });
  };

  const handleImportComplete = async (result: {
    fileName: string;
    totalRows: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    config: Record<string, any>;
  }) => {
    // Save to import_jobs
    try {
      await supabase.from('import_jobs').insert({
        tenant_id: tenantId,
        created_by: teamMember?.id || null,
        file_name: result.fileName,
        total_rows: result.totalRows,
        created_count: result.created,
        updated_count: result.updated,
        skipped_count: result.skipped,
        failed_count: result.failed,
        config: result.config,
      });
      queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    } catch (err) {
      console.error('Failed to save import job:', err);
    }
  };

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Upload className="h-6 w-6" />
            Importar Leads
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Importe leads de arquivos CSV ou Excel
          </p>
        </div>

        <Tabs value={currentTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="import" className="gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              Nova Importacao
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-1.5">
              <History className="h-3.5 w-3.5" />
              Historico
              {importJobs && importJobs.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">
                  {importJobs.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="import" className="mt-4">
            <ImportLeadsWizard onImportComplete={handleImportComplete} />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <History className="h-5 w-5" />
                  Historico de Importacoes
                </CardTitle>
              </CardHeader>
              <CardContent>
                {jobsLoading ? (
                  <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
                    Carregando...
                  </div>
                ) : !importJobs || importJobs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                    <FileSpreadsheet className="h-10 w-10 mb-2 opacity-50" />
                    <p className="text-sm">Nenhuma importacao realizada ainda</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Data</TableHead>
                          <TableHead className="text-xs">Arquivo</TableHead>
                          <TableHead className="text-xs">Importado por</TableHead>
                          <TableHead className="text-xs text-center">Total</TableHead>
                          <TableHead className="text-xs text-center">Criados</TableHead>
                          <TableHead className="text-xs text-center">Atualizados</TableHead>
                          <TableHead className="text-xs text-center">Pulados</TableHead>
                          <TableHead className="text-xs text-center">Falhas</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {importJobs.map((job) => (
                          <TableRow key={job.id}>
                            <TableCell className="text-xs py-2 whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <Calendar className="h-3 w-3 text-muted-foreground" />
                                {new Date(job.created_at).toLocaleDateString('pt-BR', {
                                  day: '2-digit', month: '2-digit', year: '2-digit',
                                  hour: '2-digit', minute: '2-digit',
                                })}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs py-2 max-w-[200px] truncate font-medium">
                              {job.file_name || '-'}
                            </TableCell>
                            <TableCell className="text-xs py-2">
                              <div className="flex items-center gap-1.5">
                                <User className="h-3 w-3 text-muted-foreground" />
                                {job.created_by_member?.name || '-'}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs py-2 text-center font-medium">
                              {job.total_rows}
                            </TableCell>
                            <TableCell className="text-xs py-2 text-center">
                              <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20 text-xs px-1.5">
                                <CheckCircle2 className="h-3 w-3 mr-0.5" />
                                {job.created_count}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs py-2 text-center">
                              {job.updated_count > 0 ? (
                                <Badge className="bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 text-xs px-1.5">
                                  {job.updated_count}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs py-2 text-center">
                              {job.skipped_count > 0 ? (
                                <Badge className="bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20 text-xs px-1.5">
                                  <AlertCircle className="h-3 w-3 mr-0.5" />
                                  {job.skipped_count}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs py-2 text-center">
                              {job.failed_count > 0 ? (
                                <Badge variant="destructive" className="text-xs px-1.5">
                                  <XCircle className="h-3 w-3 mr-0.5" />
                                  {job.failed_count}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
