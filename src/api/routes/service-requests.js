import express from 'express';
import { z } from 'zod';
import { query, one, many } from '../../lib/db.js';
import { h, need, paging, pageMeta, idParam } from '../middleware.js';
import { telegramLinks } from '../../telegram/links.js';
import { AppError } from '../../lib/errors.js';
const r = express.Router();
const STATUSES = ['new','reviewing','identified','responded','completed','irrelevant','duplicate'];
const BASE = `FROM service_requests sr JOIN message_matches mm ON mm.id=sr.match_id JOIN messages m ON m.id=mm.message_id LEFT JOIN telegram_sources s ON s.id=m.source_id LEFT JOIN telegram_accounts a ON a.id=m.account_id LEFT JOIN ai_rules ar ON ar.id=mm.ai_rule_id`;
function whereFor(q) {
  const parts = ['mm.deleted_at IS NULL','m.deleted_at IS NULL']; const vals=[];
  const add=(sql,v)=>{ vals.push(v); parts.push(sql.replaceAll('$#', `$${vals.length}`)); };
  if(q.q) { const i=vals.length+1; vals.push(q.q,q.q,q.q,q.q); parts.push(`(m.text ILIKE '%' || $${i} || '%' OR sr.service_type ILIKE '%' || $${i+1} || '%' OR sr.summary ILIKE '%' || $${i+2} || '%' OR s.title ILIKE '%' || $${i+3} || '%')`); }
  if(q.category) add('sr.category = $#', q.category);
  if(q.status) add('sr.request_status = $#', q.status);
  if(q.priority) add('mm.priority = $#', q.priority);
  if(q.source_id) add('m.source_id = $#', Number(q.source_id));
  if(q.from) add('sr.created_at >= $#::date', q.from);
  if(q.to) add("sr.created_at < ($#::date + interval '1 day')", q.to);
  if(q.min_confidence !== undefined && q.min_confidence !== '') { const n=Number(q.min_confidence); if(Number.isFinite(n)) add('mm.ai_confidence >= $#',Math.max(0,Math.min(100,n))); }
  if(q.confident === 'true') parts.push('mm.ai_confidence IS NOT NULL AND mm.ai_confidence >= 70');
  if(q.confident === 'false') parts.push('(mm.ai_confidence IS NULL OR mm.ai_confidence < 70)');
  if(q.new_only === 'true') add("sr.request_status = $#", 'new');
  return { sql:parts.join(' AND '), vals };
}
const SELECT = `SELECT sr.id, sr.match_id, sr.category, sr.service_type, sr.summary, sr.request_status, sr.category_corrected, sr.created_at, sr.updated_at,
 mm.priority, mm.score, mm.ai_confidence, mm.ai_reason, mm.intent, mm.keyword_text, mm.occurrences, m.text, m.sent_at, m.tg_message_id, m.tg_chat_id, m.sender_name, m.sender_username,
 s.title AS source_title, s.kind AS source_kind, s.username AS source_username, a.name AS account_name, ar.name AS radar_name`;
function view(x) { return { ...x, links: telegramLinks({ chatId:x.tg_chat_id, kind:x.source_kind, username:x.source_username, messageId:x.tg_message_id }) }; }
r.get('/service-requests', need('viewer'), h(async (req,res)=>{
 const p=paging(req.query,{max:100,def:30}); const w=whereFor(req.query);
 const [rows,total]=await Promise.all([many(`${SELECT} ${BASE} WHERE ${w.sql} ORDER BY sr.created_at DESC,sr.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`,w.vals),one(`SELECT count(*)::int AS n ${BASE} WHERE ${w.sql}`,w.vals)]);
 res.json({data:rows.map(view),meta:pageMeta(total.n,p)});
}));
r.get('/service-requests/stats',need('viewer'),h(async(_req,res)=>{
 const data=await one(`SELECT count(*)::int AS total, count(*) FILTER(WHERE sr.created_at::date=CURRENT_DATE)::int AS today,
 count(*) FILTER(WHERE sr.category='خدمات طلابية وجامعية' AND sr.created_at::date=CURRENT_DATE)::int AS student_today,
 count(*) FILTER(WHERE sr.category='تقنية وتكنولوجيا' AND sr.created_at::date=CURRENT_DATE)::int AS tech_today,
 count(*) FILTER(WHERE sr.category='مساعدة واستفسارات عامة' AND sr.created_at::date=CURRENT_DATE)::int AS general_today,
 count(*) FILTER(WHERE sr.request_status='new')::int AS new_count,
 count(*) FILTER(WHERE sr.request_status IN ('reviewing','identified','responded','completed'))::int AS reviewed,
 count(*) FILTER(WHERE mm.priority IN ('high','critical'))::int AS high_count ${BASE} WHERE mm.deleted_at IS NULL AND m.deleted_at IS NULL`);
 const categories=await many(`SELECT sr.category,count(*)::int AS count FROM service_requests sr JOIN message_matches mm ON mm.id=sr.match_id WHERE mm.deleted_at IS NULL GROUP BY sr.category ORDER BY count DESC`);
 res.json({data,categories});
}));
r.get('/service-requests/categories',need('viewer'),h(async(_req,res)=>res.json({data:await many('SELECT id,name,color,enabled FROM service_categories ORDER BY id')})));
r.post('/service-requests/categories',need('operator'),h(async(req,res)=>{
 const b=z.object({name:z.string().trim().min(2).max(100),color:z.string().regex(/^[a-z-]{2,20}$/).default('blue')}).parse(req.body);
 const row=await one('INSERT INTO service_categories(name,color) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET enabled=true RETURNING id,name,color,enabled',[b.name,b.color]);
 await req.audit('SERVICE_CATEGORY_CREATED',{entity:'service_category',entityId:row.id});res.status(201).json({data:row});
}));
r.patch('/service-requests/categories/:id',need('operator'),h(async(req,res)=>{
 const id=idParam(req);const b=z.object({name:z.string().trim().min(2).max(100).optional(),enabled:z.boolean().optional(),color:z.string().regex(/^[a-z-]{2,20}$/).optional()}).parse(req.body);
 const keys=Object.keys(b);if(!keys.length)throw new AppError('VALIDATION');const sets=keys.map((k,i)=>`${({name:'name',enabled:'enabled',color:'color'})[k]}=$${i+2}`);
 const row=await one(`UPDATE service_categories SET ${sets.join(',')} WHERE id=$1 RETURNING id,name,color,enabled`,[id,...keys.map(k=>b[k])]);if(!row)throw new AppError('NOT_FOUND',{status:404});res.json({data:row});
}));
r.patch('/service-requests/:id',need('operator'),h(async(req,res)=>{
 const id=idParam(req);const b=z.object({status:z.enum(STATUSES).optional(),category:z.string().trim().min(2).max(100).optional()}).refine(x=>Object.keys(x).length>0).parse(req.body);
 const before=await one('SELECT category FROM service_requests WHERE id=$1',[id]);if(!before)throw new AppError('NOT_FOUND',{status:404});
 const fields=[];const vals=[id];if(b.status){vals.push(b.status);fields.push(`request_status=$${vals.length}`);}if(b.category){vals.push(b.category);fields.push(`category=$${vals.length}`,`category_corrected=true`);}
 fields.push('updated_at=now()');const row=await one(`UPDATE service_requests SET ${fields.join(',')} WHERE id=$1 RETURNING id,category,request_status,category_corrected`,vals);if(!row)throw new AppError('NOT_FOUND',{status:404});
 if(b.category&&b.category!==before.category)await query('INSERT INTO service_request_feedback(service_request_id,previous_category,corrected_category,created_by) VALUES($1,$2,$3,$4)',[id,before.category,b.category,req.user.id]);
 await req.audit(b.category?'SERVICE_REQUEST_CLASSIFIED':'SERVICE_REQUEST_STATUS',{entity:'service_request',entityId:id,details:b});res.json({data:row});
}));
export default r;
