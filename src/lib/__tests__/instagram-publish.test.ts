// @vitest-environment node
import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const source=readFileSync('supabase/functions/instagram-publish/index.ts','utf8').replace(/^import .*;$/gm,'');
const code=transformSync(source,{loader:'ts',format:'cjs'}).code;
const id='11111111-1111-4111-8111-111111111111',accountId='22222222-2222-4222-8222-222222222222';
function setup(options:{timeout?:boolean;denied?:boolean;tenant?:string}={}){
 let handler:(r:Request)=>Promise<Response>;
 const calls:string[]=[];
 const publication:Record<string,any>={campaign_id:id,tenant_id:'tenant',caption:'Aprovada',paths:['a.jpg','b.jpg'],status:'draft',children:[],ready_children:0,locked_until:new Date(0).toISOString()};
 const campaign={id,tenant_id:'tenant',post_id:'studio:'+id,post_caption:'Aprovada',studio_payload:{studio:{state:'ready'}}};
 const tables:Record<string,any[]>={instagram_publications:[publication],instagram_comment_campaigns:[campaign],team_members:[{tenant_id:'tenant',auth_user_id:'user',is_active:true}],instagram_business_accounts:[{id:accountId,tenant_id:'tenant',status:'connected',ig_login_token:'SECRET',ig_login_id:'1234'}]};
 const db={auth:{getUser:async()=>({data:{user:{id:'user',app_metadata:{tenant_id:options.tenant||'tenant'}}}})},storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://example.org/a.jpg'}})})},from(table:string){
  let patch:any=null;const filters:((r:any)=>boolean)[]=[];let single=false;
  const q:any={select(){return q},update(p:any){patch=p;return q},eq(k:string,v:any){filters.push(r=>r[k]===v);return q},neq(k:string,v:any){filters.push(r=>r[k]!==v);return q},lt(k:string,v:any){filters.push(r=>r[k]<v);return q},in(k:string,v:any[]){filters.push(r=>v.includes(r[k]));return q},single(){single=true;return q},maybeSingle(){single=true;return q},then(resolve:any){const rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));if(patch)rows.forEach(r=>Object.assign(r,patch));resolve({data:single?(rows[0]?structuredClone(rows[0]):null):structuredClone(rows),error:null});}};return q;
 }};
 let next=100;
 const fetcher=async(url:URL,init:RequestInit)=>{
  const path=url.pathname;calls.push(`${init.method}:${path}`);
  if(path.endsWith('/content_publishing_limit'))return new Response(JSON.stringify(options.denied?{error:{code:10}}:{data:[{quota_usage:0}]}),{status:options.denied?403:200});
  if(path.endsWith('/media_publish')){if(options.timeout)throw Error('network '+url.toString());return new Response(JSON.stringify({id:'999'}));}
  if(init.method==='POST')return new Response(JSON.stringify({id:String(++next)}));
  if(url.searchParams.get('fields')==='permalink')return new Response(JSON.stringify({permalink:'https://www.instagram.com/p/test/'}));
  return new Response(JSON.stringify({status_code:'FINISHED'}));
 };
 new Function('Deno','createClient','fetch',code)({env:{get:()=>undefined},serve:(h:any)=>{handler=h}},()=>db,fetcher);
 const call=async(action:string)=>{const r=await handler(new Request('https://local.test',{method:'POST',headers:{authorization:'Bearer user'},body:JSON.stringify({action,campaignId:id,accountId})}));return {status:r.status,...await r.json()};};
 return {call,calls,publication,campaign};
}
describe('Instagram publication server',()=>{
 it('rejects another tenant before reading a campaign or calling Meta',async()=>{const x=setup({tenant:'other'});expect((await x.call('publish')).status).toBe(403);expect(x.calls).toHaveLength(0)});
 it('does not publish when permission check fails',async()=>{const x=setup({denied:true});expect((await x.call('publish')).status).toBe(502);expect(x.publication.status).toBe('draft');expect(x.calls.some(c=>c.startsWith('POST'))).toBe(false)});
 it('publishes the ordered carousel once and links its confirmed ID paused',async()=>{const x=setup();await x.call('publish');for(let i=0;i<8&&x.publication.status==='preparing';i++)await x.call('continue');expect(x.publication.status).toBe('published');expect(x.publication.children).toEqual(['101','102']);expect(x.campaign.post_id).toBe('999');expect((x.campaign as any).status).toBe('paused');await x.call('publish');expect(x.calls.filter(c=>c.endsWith('/media_publish'))).toHaveLength(1)});
 it('does not retry an ambiguous publish or expose its token',async()=>{const x=setup({timeout:true});await x.call('publish');let result;for(let i=0;i<8&&x.publication.status==='preparing';i++)result=await x.call('continue');expect(x.publication.status).toBe('uncertain');expect(JSON.stringify(result)).not.toContain('SECRET');await x.call('publish');expect(x.calls.filter(c=>c.endsWith('/media_publish'))).toHaveLength(1)});
 it('does not create two child containers for concurrent calls',async()=>{const x=setup();await Promise.all([x.call('publish'),x.call('publish')]);expect(x.calls.filter(c=>c==='POST:/v23.0/1234/media')).toHaveLength(1)});
});
