export type Row = Record<string, unknown>;
type Metric={conversations:number;qualified:number;appointments:number;sales:number;captures:number;unlinked:number};
const blank=():Metric=>({conversations:0,qualified:0,appointments:0,sales:0,captures:0,unlinked:0});
const date=(v:unknown)=>typeof v==='string'?Date.parse(v):NaN;
export function commercialMetrics(input:{campaigns:Row[];recipients:Row[];conversations:Row[];leads:Row[];events:Row[];deals:Row[];intermediations:Row[]}){
 const byCampaign:Record<string,Metric>={};for(const c of input.campaigns)byCampaign[String(c.id)]=blank();
 const leads=new Map(input.leads.map(l=>[l.id,l]));
 const identities=new Map<string,Set<unknown>>();
 for(const c of input.conversations){if(!c.lead_id||!leads.has(c.lead_id))continue;for(const [kind,value] of [['session',c.agent_session_id],['psid',c.participant_instagram_id]]){if(!value)continue;const key=kind+':'+String(value),set=identities.get(key)||new Set();set.add(c.lead_id);identities.set(key,set);}}
 const candidates=new Map<unknown,{campaign:string;at:number;id:string}>();
 const gaps=new Set<string>();
 for(const r of input.recipients){
  const campaign=String(r.campaign_id),at=date(r.replied_at);if(!byCampaign[campaign]||!Number.isFinite(at))continue;
  let lead=r.lead_id;
  if(!lead){
   const found=new Set([...(identities.get('session:'+String(r.agent_session_id))||[]),...(identities.get('psid:'+String(r.recipient_psid))||[])]);
   if(found.size===1)lead=[...found][0];
  }
  if(!lead||!leads.has(lead)){
   const key=campaign+':'+String(r.commenter_ig_id||r.recipient_psid||r.id);
   if(!gaps.has(key)){byCampaign[campaign].unlinked++;gaps.add(key);}continue;
  }
  const current=candidates.get(lead),id=String(r.id);
  if(!current||at<current.at||(at===current.at&&id<current.id))candidates.set(lead,{campaign,at,id});
 }
 const appointments=new Set(),sales=new Set(),captures=new Set();
 for(const e of input.events){const a=candidates.get(e.lead_id);if(a&&!['cancelled','canceled'].includes(String(e.status))&&date(e.created_at)>=a.at&&date(e.start_datetime)>=a.at)appointments.add(e.lead_id);}
 for(const d of input.deals){const a=candidates.get(d.lead_id);if(a&&d.status==='won'&&date(d.won_at)>=a.at)sales.add(d.lead_id);}
 for(const i of input.intermediations){const a=candidates.get(i.owner_lead_id);if(a&&['signed','imported'].includes(String(i.contract_status))&&date(i.contract_signed_at)>=a.at&&['active','completed','paused','docs_pending'].includes(String(i.status)))captures.add(i.owner_lead_id);}
 for(const [leadId,a] of candidates){
  const m=byCampaign[a.campaign],lead=leads.get(leadId)!;m.conversations++;
  if(lead.bant_need===true||lead.capture_valid===true)m.qualified++;
  if(appointments.has(leadId))m.appointments++;
  if(sales.has(leadId))m.sales++;
  if(captures.has(leadId))m.captures++;
 }
 const total=blank();for(const m of Object.values(byCampaign))for(const k of Object.keys(total) as (keyof Metric)[])total[k]+=m[k];
 return {byCampaign,total,attribution:'Primeira campanha com resposta registrada por lead. Pessoas únicas; resultados posteriores à resposta. Não comprova causalidade.',updatedAt:new Date().toISOString()};
}
