import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { instagramCampaignClient } from '@/lib/instagram-campaign-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { InstagramPublisher } from './InstagramPublisher';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { briefSchema, deliverySchema, bridgeMessage, type StudioBrief } from '@/lib/studio-protocol';

export type StudioPayload = { studio?: { brief: StudioBrief; delivery?: {caption:string;context:string;cover:string;materialUrl:string;reviewedAt:string}; state: string } };
export function StudioCampaignBridge({tenantId, campaign, agentSlug}: {
  tenantId:string; campaign?:{id:string;studio_payload?:StudioPayload}; agentSlug?:string;
}) {
  const [open,setOpen]=useState(false), [busy,setBusy]=useState(false), [waiting,setWaiting]=useState(false);
  const [form,setForm]=useState({name:'',topic:'',brand:'TotexMotors',audience:'Pessoas interessadas em comprar, vender ou trocar de carro',keyword:'QUERO',materialUrl:'',objective:'inventory_acquisition',format:'square'});
  const connection=useRef<{child:Window;nonce:string;brief:StudioBrief;origin:string}|null>(null);
  const receiving=useRef(false);
  const {toast}=useToast(); const qc=useQueryClient();
  useEffect(()=>{
    async function receive(event:MessageEvent) {
      const c=connection.current; if(!c)return;
      const msg=bridgeMessage(event,c.origin,c.child,c.nonce); if(!msg)return;
      if(msg.type==='totex.ready') c.child.postMessage({type:'totex.brief',nonce:c.nonce,payload:c.brief},c.origin);
      if(msg.type==='totex.delivery' && !receiving.current) {
        const d=deliverySchema.safeParse(msg.payload);
        if(!d.success || d.data.id!==c.brief.id || d.data.tenantId!==tenantId)return;
        receiving.current=true;
        try {
          const {images,...delivery}=d.data;
          // A delivery never activates the comment dispatcher. The operator links a real post next.
          const {data,error}=await instagramCampaignClient.from('instagram_comment_campaigns').update({
            status:'paused', post_caption:d.data.caption,
            dm_template: `${d.data.context}\n\n${d.data.materialUrl ? 'Material disponível: '+d.data.materialUrl : 'Não prometa PDF, guia ou link: esta campanha não tem material vinculado.'}`,
            studio_payload:{studio:{brief:c.brief,delivery,state:'ready'}}, updated_at:new Date().toISOString(),
          }).eq('id',c.brief.id).eq('tenant_id',tenantId).select('id').single();
          if(error || !data)throw error || Error('Campanha não encontrada.');
          if(images){const {data:staged,error:stageError}=await supabase.functions.invoke('instagram-publish',{body:{action:'stage',campaignId:c.brief.id,caption:delivery.caption,images}});if(stageError||staged?.error)throw Error(staged?.error||'Não foi possível receber as artes.');}
          await qc.invalidateQueries({queryKey:['ig-publication',c.brief.id]});
          c.child.postMessage({type:'totex.saved',nonce:c.nonce},c.origin);
          await qc.invalidateQueries({queryKey:['ig-campaigns',tenantId]});
          setWaiting(false); toast({title:'Conteúdo recebido e salvo',description:'Artes recebidas. Revise a conta e publique pelo botão da campanha.'});
        }catch {c.child.postMessage({type:'totex.error',nonce:c.nonce},c.origin);toast({title:'Não foi possível receber o conteúdo. Tente novamente.',variant:'destructive'});}
        finally {receiving.current=false;}
      }
    }
    window.addEventListener('message',receive);
    return ()=>{window.removeEventListener('message',receive);connection.current=null;};
  },[tenantId,qc,toast]);
  function connect(brief:StudioBrief) {
    const url=new URL(import.meta.env.VITE_CARROSSEL_STUDIO_URL || 'https://insta.totexmotors.com');
    if(url.protocol!=='https:')throw Error('Configure uma URL HTTPS para o Studio.');
    const nonce=crypto.randomUUID();
    url.pathname='/';url.search='';url.hash=new URLSearchParams({crm:window.location.origin,nonce}).toString();
    const child=window.open(url.toString(),'totex-studio-'+nonce);
    if(!child)throw Error('Permita abrir a janela do Studio neste navegador e tente novamente.');
    connection.current={child,nonce,brief,origin:url.origin};setWaiting(true);
  }
  async function create() {
    const result=briefSchema.safeParse({...form,id:crypto.randomUUID(),tenantId});
    if(!result.success){toast({title:'Confira o briefing',description:result.error.issues[0]?.message,variant:'destructive'});return;}
    setBusy(true);
    try {
      const b=result.data;
      const {error}=await instagramCampaignClient.from('instagram_comment_campaigns').insert({id:b.id,tenant_id:tenantId,name:b.name,
        post_id:'studio:'+b.id,status:'paused',keyword_mode:'contains',keywords:[b.keyword.toLowerCase()],
        reply_mode:'agent',agent_slug:agentSlug || null,once_per_user:true,process_existing:false,
        studio_payload:{studio:{brief:b,state:'brief'}},
      });
      if(error)throw error;
      await qc.invalidateQueries({queryKey:['ig-campaigns',tenantId]});setOpen(false);
      toast({title:'Briefing salvo',description:'Clique em Abrir no Studio na campanha para preparar o conteúdo.'});
    }catch(e){toast({title:'Não foi possível criar',description:(e as Error).message,variant:'destructive'});}finally{setBusy(false);}
  }
  const studio=campaign?.studio_payload?.studio;
  return <>
    {studio ? <div className="space-y-3">
      <Button variant="outline" onClick={()=>{try{connect(briefSchema.parse(studio.brief));}catch(e){toast({title:(e as Error).message,variant:'destructive'});}}}>Abrir no Studio</Button>
      {waiting && <p className="text-xs text-muted-foreground">Mantenha esta aba aberta. No Studio, revise e clique em “Devolver ao Totexgest”. Se a conexão cair, clique novamente em Abrir no Studio.</p>}
      {studio.delivery && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">Ver conteúdo recebido</summary>
        <img src={studio.delivery.cover} alt="Capa aprovada" className="mt-3 w-48 rounded-lg"/>
        <p className="mt-3 whitespace-pre-wrap text-sm">{studio.delivery.caption}</p>
        <p className="mt-2 text-xs text-muted-foreground">Recebido em {new Date(studio.delivery.reviewedAt).toLocaleString('pt-BR')}. Para baixar todas as artes, abra o Studio.</p>
      </details>}
      {campaign && studio.delivery && <InstagramPublisher campaignId={campaign.id} tenantId={tenantId}/> }
    </div> : <Button variant="outline" onClick={()=>setOpen(true)}>Criar com o Carrossel Studio</Button>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Criar campanha com o Heitor</DialogTitle></DialogHeader>
      <Label htmlFor="studio-name">Nome da campanha</Label><Input id="studio-name" value={form.name} maxLength={100} onChange={e=>setForm({...form,name:e.target.value})}/>
      <Label htmlFor="studio-objective">Objetivo</Label><select id="studio-objective" className="rounded border bg-background p-2" value={form.objective} onChange={e=>setForm({...form,objective:e.target.value})}>
        <option value="inventory_acquisition">Captar veículos</option><option value="vehicle_sale">Vender veículo / Janela Totex</option><option value="authority">Informar e orientar</option><option value="relationship">Relacionamento</option>
      </select>
      <Label htmlFor="studio-brand">Marca / loja</Label><Input id="studio-brand" value={form.brand} maxLength={40} onChange={e=>setForm({...form,brand:e.target.value})}/>
      <Label htmlFor="studio-topic">O que comunicar? Inclua dados e condições confirmadas.</Label><Textarea id="studio-topic" rows={4} maxLength={900} value={form.topic} onChange={e=>setForm({...form,topic:e.target.value})}/>
      <Label htmlFor="studio-audience">Público</Label><Input id="studio-audience" value={form.audience} maxLength={240} onChange={e=>setForm({...form,audience:e.target.value})}/>
      <Label htmlFor="studio-keyword">Palavra-chave dos comentários</Label><Input id="studio-keyword" value={form.keyword} maxLength={30} onChange={e=>setForm({...form,keyword:e.target.value})}/>
      <Label htmlFor="studio-material">Link de material já disponível (opcional)</Label><Input id="studio-material" type="url" value={form.materialUrl} onChange={e=>setForm({...form,materialUrl:e.target.value})}/>
      <p className="text-xs text-muted-foreground">Sem link, a chamada convida para conversar. Nenhum material será prometido.</p>
      <Label htmlFor="studio-format">Formato</Label><select id="studio-format" className="rounded border bg-background p-2" value={form.format} onChange={e=>setForm({...form,format:e.target.value})}><option value="square">Quadrado</option><option value="portrait">Vertical 4:5</option></select>
      <Button disabled={busy} onClick={create}>{busy?'Salvando…':'Salvar briefing'}</Button>
    </DialogContent></Dialog>
  </>;
}
