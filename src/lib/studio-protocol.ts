import { z } from 'zod';
export const briefSchema = z.object({
  id: z.string().uuid(), tenantId: z.string().uuid(), name: z.string().trim().min(2).max(100),
  objective: z.enum(['vehicle_sale','inventory_acquisition','authority','relationship']),
  brand: z.string().trim().min(1).max(40), audience: z.string().max(240),
  topic: z.string().trim().min(10).max(900), keyword: z.string().regex(/^[\p{L}\p{N}_-]{2,30}$/u),
  materialUrl: z.union([z.literal(''),z.string().url().regex(/^https:\/\//).max(500)]),
  format: z.enum(['square','portrait']),
});
export const deliverySchema = z.object({
  id: z.string().uuid(), tenantId: z.string().uuid(), name: z.string().min(1).max(100),
  caption: z.string().max(2200), context: z.string().min(1).max(6000),
  cover: z.string().max(700000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/),
  materialUrl: z.union([z.literal(''),z.string().url().regex(/^https:\/\//).max(500)]),
  reviewedAt: z.string().datetime(),
});
export type StudioBrief = z.infer<typeof briefSchema>;
export type StudioDelivery = z.infer<typeof deliverySchema>;
export const isMetaPost = (id: string) => /^\d+$/.test(id);
export function bridgeMessage(event: {origin:string;source:unknown;data:unknown}, origin:string, source:unknown, nonce:string) {
  if(event.origin!==origin || event.source!==source || !source) return null;
  const parsed=z.object({type:z.enum(['totex.ready','totex.brief','totex.delivery','totex.saved','totex.error']),nonce:z.string().uuid(),payload:z.unknown().optional()}).safeParse(event.data);
  return parsed.success && parsed.data.nonce===nonce ? parsed.data : null;
}
