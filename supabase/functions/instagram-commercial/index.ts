import {createClient} from 'npm:@supabase/supabase-js@2.91.0';
import {commercialMetrics,type Row} from './model.ts';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return json({});if(req.method!=='POST')return json({error:'Método não permitido'},405);
 try{
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const {data:{user}}=await db.auth.getUser((req.headers.get('authorization')||'').replace(/^Bearer\s+/i,''));
  if(!user)return json({error:'Entre novamente.'},401);
  const tenant=user.app_metadata?.tenant_id;if(!tenant)return json({error:'Empresa não identificada.'},403);
  const {data:member}=await db.from('team_members').select('is_active').eq('tenant_id',tenant).eq('auth_user_id',user.id).maybeSingle();
  if(!member?.is_active)return json({error:'Acesso não autorizado.'},403);
  async function rows(table:string,fields:string):Promise<Row[]>{
   const all:Row[]=[];
   for(let offset=0;offset<50000;offset+=1000){
    const {data,error}=await db.from(table).select(fields).eq('tenant_id',tenant).order('id').range(offset,offset+999);
    if(error)throw Error('Não foi possível consultar os resultados. Nenhuma contagem parcial será exibida.');
    all.push(...(data as unknown as Row[]||[]));if(!data||data.length<1000)return all;
   }
   throw Error('Volume acima do limite desta consulta. Solicite a ampliação do relatório.');
  }
  const [campaigns,recipients,conversations,leads,events,deals,intermediations]=await Promise.all([
   rows('instagram_comment_campaigns','id'),
   rows('instagram_comment_campaign_recipients','id,campaign_id,lead_id,replied_at,commenter_ig_id,recipient_psid,agent_session_id'),
   rows('instagram_conversations','id,lead_id,participant_instagram_id,agent_session_id'),
   rows('leads','id,bant_need,capture_valid'),
   rows('calendar_events','id,lead_id,status,start_datetime,created_at'),
   rows('deals','id,lead_id,status,won_at'),
   rows('intermediations','id,owner_lead_id,status,contract_status,contract_signed_at'),
  ]);
  return json(commercialMetrics({campaigns,recipients,conversations,leads,events,deals,intermediations}));
 }catch{return json({error:'Não foi possível carregar o resultado comercial completo. Atualize para tentar novamente.'},500);}
});
