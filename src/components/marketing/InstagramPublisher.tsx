import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';

type Publication={status:string;caption:string;count:number;media_id?:string;permalink?:string;error?:string;account_id?:string};
type Result={previews?:string[];accounts?:{id:string;instagram_username:string}[];publication:Publication|null;allowed?:boolean;error?:string};
export function InstagramPublisher({campaignId,tenantId}:{campaignId:string;tenantId:string}){
 const [accountId,setAccountId]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[verified,setVerified]=useState('');
 const qc=useQueryClient();
 async function call(action:string):Promise<Result>{
  const {data,error}=await supabase.functions.invoke('instagram-publish',{body:{action,campaignId,accountId}});
  if(error){let message='Não foi possível consultar o Instagram. Atualize para conferir o estado.';try{const detail=await error.context?.json();if(detail?.error)message=detail.error;}catch{/* offline */}throw Error(message);}
  if(data?.error)throw Error(data.error);return data;
 }
 const query=useQuery({queryKey:['ig-publication',campaignId],queryFn:()=>call('accounts'),retry:false});
 const p=query.data?.publication;
 async function verify(){setBusy(true);setNotice('');try{await call('check');setVerified(accountId);setNotice('Conta autorizada para publicação. Confira as artes e a legenda antes de confirmar.');}catch(e){setNotice((e as Error).message);setVerified('');}finally{setBusy(false);}}
 async function publish(resume=false){
  if(!resume&&!window.confirm(`Publicar agora ${p?.count} arte(s) na conta selecionada, com a legenda recebida do Studio?`))return;
  setBusy(true);setNotice('Preparando a publicação…');
  try{
   let result=await call(resume?'continue':'publish');
   for(let i=0;i<35&&result.publication?.status==='preparing';i++){
    qc.setQueryData(['ig-publication',campaignId],(old:Result|undefined)=>({...old,publication:result.publication}));
    await new Promise(resolve=>setTimeout(resolve,1500));result=await call('continue');
   }
   setNotice(result.publication?.status==='published'?'Publicado no Instagram. Revise e ative o atendimento da campanha.':'Consulte o estado abaixo antes de continuar.');
  }catch(e){setNotice((e as Error).message);}
  finally{await query.refetch();await qc.invalidateQueries({queryKey:['ig-campaigns',tenantId]});setBusy(false);}
 }
 return <section className="space-y-3 rounded-lg border p-3">
  <p className="text-sm font-medium">Publicação no Instagram</p>
  {query.isError&&<p className="text-sm text-destructive">{(query.error as Error).message}</p>}
  {!p&&!query.isLoading&&!query.isError&&<p className="text-sm">Abra no Studio e clique em Devolver ao Totexgest para receber todas as artes.</p>}
  {p&&<p className="text-sm">{p.count} arte(s) • {({draft:'Pronto para revisão',staging:'Recebendo artes',preparing:'Preparando no Instagram',publishing:'Aguardando confirmação',published:'Publicado',error:'Requer correção',uncertain:'Envio sem confirmação'} as Record<string,string>)[p.status]||p.status}</p>}
  {!!query.data?.previews?.length&&<div className="flex gap-2 overflow-x-auto">{query.data.previews.map((url,i)=><img key={url} src={url} alt={`Arte ${i+1} na ordem de publicação`} className="w-32 shrink-0 rounded border object-contain"/>)}</div>}
  {p?.status==='draft'&&<>
   <label className="block text-sm">Conta de publicação<select aria-label="Conta de publicação" className="ml-2 rounded border bg-background p-2" value={accountId} disabled={busy} onChange={e=>{setAccountId(e.target.value);setVerified('');}}><option value="">Selecione a conta</option>{query.data?.accounts?.map(a=><option key={a.id} value={a.id}>{a.instagram_username}</option>)}</select></label>
   <details><summary className="cursor-pointer text-sm">Conferir legenda que será publicada</summary><p className="whitespace-pre-wrap text-sm">{p.caption}</p></details>
   <Button variant="outline" disabled={busy||!accountId} onClick={()=>void verify()}>Verificar autorização</Button>{' '}
   <Button disabled={busy||!verified||verified!==accountId} onClick={()=>void publish()}>Publicar no Instagram</Button>
  </>}
  {p?.status==='preparing'&&<Button disabled={busy} onClick={()=>void publish(true)}>Continuar publicação autorizada</Button>}
  {p?.status==='published'&&<p className="text-sm">Post confirmado: {p.media_id}. {p.permalink&&<a className="underline" href={p.permalink} target="_blank" rel="noreferrer">Ver no Instagram</a>}</p>}
  {['publishing','uncertain'].includes(p?.status||'')&&<p className="text-sm">Confira o Instagram. Não reenvie: o post pode já estar publicado. Use a edição da campanha para vincular o post existente.</p>}
  {p?.error&&<p className="text-sm text-destructive">{p.error}</p>}
  {notice&&<p role="status" className="text-sm">{notice}</p>}
  <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void query.refetch()}>Atualizar estado</Button>
 </section>;
}
