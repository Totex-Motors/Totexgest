import {describe,it,expect} from 'vitest';
import {bridgeMessage,briefSchema,deliverySchema,isMetaPost} from '../studio-protocol';
const nonce='76dafb72-d2e1-4710-9942-a69438192ef8';
const source={}; const origin='https://insta.totexmotors.com';
const event={origin,source,data:{type:'totex.delivery',nonce}};
describe('Studio bridge boundary',()=>{
 it('only accepts the exact window, origin and per-opening nonce',()=>{
  expect(bridgeMessage(event,origin,source,nonce)?.type).toBe('totex.delivery');
  expect(bridgeMessage({...event,origin:origin+'.evil.com'},origin,source,nonce)).toBeNull();
  expect(bridgeMessage({...event,source:{}},origin,source,nonce)).toBeNull();
  expect(bridgeMessage(event,origin,source,'wrong')).toBeNull();
  expect(bridgeMessage({...event,data:null},origin,source,nonce)).toBeNull();
 });
 it('does not confuse a prepared Studio identifier with a published Instagram post',()=>{
  expect(isMetaPost('studio:'+nonce)).toBe(false); expect(isMetaPost('18068796110412287')).toBe(true);
  expect(isMetaPost('https://instagram.com/p/test')).toBe(false);
 });
 it('rejects executable material links and incomplete briefs',()=>{
  const b={id:nonce,tenantId:nonce,name:'Campanha',objective:'authority',brand:'Totex',audience:'Motoristas',topic:'Conteúdo automotivo verificado',keyword:'GUIA',materialUrl:'',format:'square'};
  expect(briefSchema.safeParse(b).success).toBe(true);
  expect(briefSchema.safeParse({...b,materialUrl:'javascript:alert(1)'}).success).toBe(false);
  expect(briefSchema.safeParse({...b,topic:''}).success).toBe(false);
 });
 it('rejects external images and oversized deliveries',()=>{
  const d={id:nonce,tenantId:nonce,name:'Campanha',caption:'',context:'Texto aprovado',cover:'data:image/jpeg;base64,/9j/',materialUrl:'',reviewedAt:new Date().toISOString()};
  expect(deliverySchema.safeParse(d).success).toBe(true);
  expect(deliverySchema.safeParse({...d,cover:'https://example.com/tracker'}).success).toBe(false);
  expect(deliverySchema.safeParse({...d,context:'x'.repeat(6001)}).success).toBe(false);
 });
});
