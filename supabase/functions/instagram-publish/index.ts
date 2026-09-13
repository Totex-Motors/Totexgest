import { createClient } from "npm:@supabase/supabase-js@2.91.0";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const bucket='instagram-publications';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
function check(error:unknown){if(error)throw Error('Não foi possível salvar a operação. Atualize para consultar o estado antes de tentar novamente.');}
function view(row:Record<string,unknown>|null){if(!row)return null;return {status:row.status,caption:row.caption,count:Array.isArray(row.paths)?row.paths.length:0,media_id:row.media_id,permalink:row.permalink,error:row.error,account_id:row.account_id};}

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return json({});
 if(req.method!=='POST')return json({error:'Método não permitido'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 let campaignId='',tenantId='',lockId='',publishing=false;
 try{
  const {data:{user}}=await db.auth.getUser((req.headers.get('authorization')||'').replace(/^Bearer\s+/i,''));
  if(!user)return json({error:'Sessão expirada. Entre novamente.'},401);
  tenantId=user.app_metadata?.tenant_id;
  if(!tenantId)return json({error:'Empresa não identificada.'},403);
  const {data:member}=await db.from('team_members').select('is_active').eq('tenant_id',tenantId).eq('auth_user_id',user.id).maybeSingle();
  if(!member?.is_active)return json({error:'Acesso não autorizado.'},403);
  const body=await req.json();campaignId=body.campaignId;
  if(!uuid.test(campaignId||''))return json({error:'Campanha inválida.'},400);
  const {data:campaign,error:ce}=await db.from('instagram_comment_campaigns').select('id,post_id,post_caption,studio_payload').eq('id',campaignId).eq('tenant_id',tenantId).single();
  if(ce||!campaign)return json({error:'Campanha não encontrada.'},404);
  const read=async()=>{const {data,error}=await db.from('instagram_publications').select('*').eq('campaign_id',campaignId).eq('tenant_id',tenantId).maybeSingle();check(error);return data;};
  let row=await read();
  if(body.action==='status')return json({publication:view(row)});
  if(body.action==='accounts'){
   const {data,error}=await db.from('instagram_business_accounts').select('id,instagram_username').eq('tenant_id',tenantId).eq('status','connected');check(error);
   const previews:string[]=[];if(row?.paths?.length){for(const path of row.paths){const {data:signed}=await db.storage.from(bucket).createSignedUrl(path,900);if(signed)previews.push(signed.signedUrl);}}
   return json({accounts:data||[],publication:view(row),previews});
  }
  if(body.action==='stage'){
   const images=body.images;
   if(!Array.isArray(images)||images.length<1||images.length>8||images.some(x=>typeof x!=='string'||x.length>2000000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(x)))return json({error:'Envie de 1 a 8 artes JPEG pelo Studio.'},400);
   if(typeof body.caption!=='string'||body.caption.length>2200||campaign.post_caption!==body.caption||campaign.studio_payload?.studio?.state!=='ready')return json({error:'Devolva a versão aprovada do Studio primeiro.'},409);
   if(/^\d+$/.test(campaign.post_id))return json({error:'Esta campanha já está vinculada a um post. Crie outra campanha para uma nova publicação.'},409);
   if(!row){const {error}=await db.from('instagram_publications').upsert({campaign_id:campaignId,tenant_id:tenantId},{onConflict:'campaign_id',ignoreDuplicates:true});check(error);row=await read();}
   lockId=crypto.randomUUID();
   const {data:claimed,error}=await db.from('instagram_publications').update({status:'staging',lock_id:lockId,locked_until:new Date(Date.now()+120000).toISOString()}).eq('campaign_id',campaignId).eq('tenant_id',tenantId).in('status',['staging','draft','error']).lt('locked_until',new Date().toISOString()).select('campaign_id').maybeSingle();check(error);
   if(!claimed)return json({error:'Há uma publicação em andamento ou já concluída. Consulte o estado.'},409);
   const paths:string[]=[];
   for(let i=0;i<images.length;i++){
    const bytes=Uint8Array.from(atob(images[i].split(',')[1]),c=>c.charCodeAt(0));
    if(bytes[0]!==255||bytes[1]!==216)throw Error('Arquivo JPEG inválido.');
    const path=`${tenantId}/${campaignId}/${lockId}/${i}.jpg`;
    const {error}=await db.storage.from(bucket).upload(path,bytes,{contentType:'image/jpeg',upsert:false});check(error);paths.push(path);
   }
   const {error:save}=await db.from('instagram_publications').update({caption:body.caption,paths,status:'draft',children:[],ready_children:0,container_id:null,account_id:null,error:null,locked_until:new Date(0).toISOString(),updated_at:new Date().toISOString()}).eq('campaign_id',campaignId).eq('lock_id',lockId);check(save);
   return json({publication:view(await read())});
  }
  if(!['publish','continue','check'].includes(body.action))return json({error:'Ação inválida.'},400);
  const accountId=body.action==='continue'?row?.account_id:body.accountId;
  if(!uuid.test(accountId||''))return json({error:'Selecione a conta do Instagram.'},400);
  const {data:account}=await db.from('instagram_business_accounts').select('id,instagram_business_id,instagram_username,access_token,page_access_token,ig_login_id,ig_login_token').eq('tenant_id',tenantId).eq('status','connected').eq('id',accountId).single();
  if(!account)return json({error:'Conta desconectada. Revise Conta e tokens.'},409);
  const ig=!!account.ig_login_token,token=account.ig_login_token||account.access_token||account.page_access_token;
  const root=`https://${ig?'graph.instagram.com':'graph.facebook.com'}/${Deno.env.get('INSTAGRAM_GRAPH_VERSION')||'v23.0'}`;
  const accountMetaId=ig?account.ig_login_id:account.instagram_business_id;
  if(!token||!/^\d+$/.test(accountMetaId||''))throw Error('Reconecte a conta em Conta e tokens.');
  async function graph(path:string,params:Record<string,string>={},method='GET'){
   const url=new URL(root+'/'+path);const p=new URLSearchParams({...params,access_token:token});
   if(method==='GET')url.search=p.toString();
   let r:Response;let result;
   try{r=await fetch(url,{method,body:method==='POST'?p:undefined,signal:AbortSignal.timeout(20000)});result=await r.json();}
   catch{throw Error('A Meta não respondeu a tempo. Consulte o estado antes de tentar novamente.');}
   // Never return tokens or raw provider messages (which can contain signed URLs).
   if(!r.ok||result.error)throw Error(`Meta recusou a operação (código ${Number(result.error?.code)||r.status}). Revise a conta, as permissões e o formato das imagens.`);
   return result;
  }
  if(body.action==='check'||body.action==='publish'){
   // Read-only endpoint requires the content-publishing permission itself.
   await graph(`${accountMetaId}/content_publishing_limit`,{fields:'quota_usage,config'});
   if(body.action==='check')return json({allowed:true,publication:view(row)});
  }
  if(!row)return json({error:'Abra o Studio e devolva novamente para receber todas as artes.'},409);
  if(row.status==='published')return json({publication:view(row)});
  if(row.status==='publishing'||row.status==='uncertain')return json({publication:view(row),warning:'Confirmação pendente. Confira o Instagram e vincule o post existente. O sistema não reenviará automaticamente.'});
  if(body.action==='publish'&&row.status!=='draft')return json({error:'Consulte a publicação em andamento.'},409);
  if(body.action==='continue'&&row.status!=='preparing')return json({publication:view(row)});
  if(body.action==='publish'&&campaign.post_caption!==row.caption)return json({error:'A legenda mudou. Devolva a versão aprovada do Studio novamente.'},409);
  lockId=crypto.randomUUID();
  const {data:claimed,error}=await db.from('instagram_publications').update({status:'preparing',account_id:accountId,lock_id:lockId,locked_until:new Date(Date.now()+60000).toISOString()}).eq('campaign_id',campaignId).eq('tenant_id',tenantId).eq('status',row.status).lt('locked_until',new Date().toISOString()).select('*').maybeSingle();check(error);
  if(!claimed)return json({publication:view(await read()),warning:'Operação em andamento.'});
  row=claimed;
  async function save(patch:Record<string,unknown>){const {error}=await db.from('instagram_publications').update({...patch,updated_at:new Date().toISOString(),locked_until:new Date(0).toISOString()}).eq('campaign_id',campaignId).eq('lock_id',lockId).select('campaign_id').single();check(error);}
  // One provider step per request: recoverable preparation without long-running workers.
  if(row.children.length<row.paths.length){
   const path=row.paths[row.children.length];
   const {data,error}=await db.storage.from(bucket).createSignedUrl(path,3600);check(error);if(!data)throw Error('Arte indisponível.');
   const result=await graph(`${accountMetaId}/media`,{image_url:data.signedUrl,...(row.paths.length>1?{is_carousel_item:'true'}:{caption:row.caption})},'POST');
   if(!/^\d+$/.test(result.id||''))throw Error('A Meta não confirmou o recebimento da arte.');
   await save({children:[...row.children,result.id],...(row.paths.length===1?{container_id:result.id}:{})});
  }else if(!row.container_id){
   if(row.ready_children<row.children.length){const s=await graph(row.children[row.ready_children],{fields:'status_code'});if(['ERROR','EXPIRED'].includes(s.status_code))throw Error('A Meta não processou uma das artes. Devolva novamente pelo Studio.');await save(s.status_code==='FINISHED'?{ready_children:row.ready_children+1}:{});return json({publication:view(await read())});}
   const result=await graph(`${accountMetaId}/media`,{media_type:'CAROUSEL',children:row.children.join(','),caption:row.caption},'POST');
   if(!/^\d+$/.test(result.id||''))throw Error('A Meta não confirmou o carrossel.');await save({container_id:result.id});
  }else{
   const s=await graph(row.container_id,{fields:'status_code'});
   if(['ERROR','EXPIRED'].includes(s.status_code))throw Error('O carrossel expirou ou não foi processado. Devolva novamente pelo Studio.');
   if(s.status_code==='FINISHED'){
    // Durable fence BEFORE the non-idempotent publish call. Never auto-retry it.
    await save({status:'publishing'});publishing=true;
    const result=await graph(`${accountMetaId}/media_publish`,{creation_id:row.container_id},'POST');
    if(!/^\d+$/.test(result.id||''))throw Error('Sem identificador confirmado.');
    await save({status:'published',media_id:result.id,error:null});
    publishing=false;
    let permalink:string|null=null;
    try{const media=await graph(result.id,{fields:'permalink'});if(/^https:\/\/(www\.)?instagram\.com\//.test(media.permalink||''))permalink=media.permalink;}catch{/* ID is already confirmed and persisted. */}
    if(permalink)await save({permalink});
    const {error:linkError}=await db.from('instagram_comment_campaigns').update({post_id:result.id,post_permalink:permalink,status:'paused',updated_at:new Date().toISOString()}).eq('id',campaignId).eq('tenant_id',tenantId);
    if(linkError)await save({error:'Publicado. Vincule o ID do post na campanha antes de ativar o atendimento.'});
   }else if(s.status_code==='PUBLISHED'){await save({status:'uncertain',error:'Confira o Instagram e vincule o post existente. Não reenvie.'});}
   else await save({});
  }
  return json({publication:view(await read())});
 }catch(e){
  const message=e instanceof Error?e.message:'Não foi possível concluir.';
  if(lockId&&campaignId){await db.from('instagram_publications').update({status:publishing?'uncertain':'error',error:publishing?'Envio sem confirmação. Confira o Instagram e vincule o post existente antes de qualquer nova tentativa.':message,locked_until:new Date(0).toISOString()}).eq('campaign_id',campaignId).eq('tenant_id',tenantId).eq('lock_id',lockId).neq('status','published');}
  return json({error:message},502);
 }
});
