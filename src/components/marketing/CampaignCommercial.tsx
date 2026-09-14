import {useQuery} from '@tanstack/react-query';
import {supabase} from '@/lib/supabase';
import {Button} from '@/components/ui/button';
type Metric={conversations:number;qualified:number;appointments:number;sales:number;captures:number;unlinked:number};
type Report={byCampaign:Record<string,Metric>;total:Metric;updatedAt:string;attribution:string};
export function CampaignCommercial({tenantId,campaignId}:{tenantId:string;campaignId?:string}){
 const q=useQuery({queryKey:['ig-commercial',tenantId],staleTime:60000,refetchOnWindowFocus:true,retry:false,queryFn:async()=>{
  const {data,error}=await supabase.functions.invoke('instagram-commercial',{body:{}});
  if(error||data?.error)throw Error('Não foi possível carregar os resultados comerciais.');return data as Report;
 }});
 const m=campaignId?q.data?.byCampaign[campaignId]:q.data?.total;
 return <section className="my-3 space-y-3 rounded-lg border p-4">
  <div className="flex items-center justify-between"><h3 className="font-medium">{campaignId?'Resultado comercial':'Resultado comercial das campanhas'}</h3>{!campaignId&&<Button size="sm" variant="ghost" disabled={q.isFetching} onClick={()=>void q.refetch()}>Atualizar</Button>}</div>
  {q.isLoading&&<p className="text-sm">Consultando os registros do CRM…</p>}
  {q.isError&&<p className="text-sm text-destructive">{q.error.message}</p>}
  {m&&!q.isError&&<><div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{([
   ['Conversas vinculadas',m.conversations],['Qualificadas',m.qualified],['Com agendamento',m.appointments],['Com venda',m.sales],['Com captação formalizada',m.captures],
  ] as const).map(([label,value])=><div key={label}><strong className="block text-xl">{value}</strong><span className="text-xs text-muted-foreground">{label}</span></div>)}</div>
  {m.unlinked>0&&<p className="text-sm text-amber-700">{m.unlinked} participante(s) com resposta ainda sem lead identificado. Vincule o atendimento ao lead no CRM para medir os próximos resultados.</p>}
  {!campaignId&&<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Como contamos</summary><p className="mt-2">{q.data?.attribution}</p><p>Qualificada: necessidade registrada no BANT ou captação validada. Agendamento: evento não cancelado na agenda sincronizada, criado após a resposta. Venda: negócio ganho com data confirmada. Captação formalizada: contrato de intermediação assinado após a resposta.</p><p>As etapas são independentes: um resultado não presume etapas anteriores. As contagens representam pessoas, não quantidade de carros nem faturamento. Registros antigos sem vínculo não são atribuídos automaticamente.</p><p>Atualizado em {new Date(q.data!.updatedAt).toLocaleString('pt-BR')}.</p></details>}
  </>}
 </section>;
}
