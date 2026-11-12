import express from 'express';
import { z } from 'zod';
import { query, one, many, tx } from '../../lib/db.js';
import { h, need, paging, pageMeta, idParam } from '../middleware.js';
import { telegramLinks } from '../../telegram/links.js';
import { AppError } from '../../lib/errors.js';
import { sendExport, MAX_EXPORT_ROWS } from '../../services/export.js';

const r = express.Router();
const STATUSES = ['new','reviewing','identified','qualified','contacting','responded','in_progress','completed','cancelled','irrelevant','duplicate'];
const PRIORITIES = ['low','medium','high','critical'];
const BASE = `FROM service_requests sr JOIN message_matches mm ON mm.id=sr.match_id JOIN messages m ON m.id=mm.message_id LEFT JOIN telegram_sources s ON s.id=m.source_id LEFT JOIN telegram_accounts a ON a.id=m.account_id LEFT JOIN ai_rules ar ON ar.id=mm.ai_rule_id LEFT JOIN users assignee ON assignee.id=sr.assigned_to`;
const SELECT = `SELECT sr.id, sr.match_id, sr.category, sr.subcategory, sr.service_type, sr.summary, sr.request_status, sr.category_corrected, sr.classification_method, sr.priority_override,
 sr.is_favorite, sr.assigned_to, assignee.username AS assignee_username, assignee.display_name AS assignee_name,
 sr.archived_at, sr.excluded_at, sr.exclusion_reason, sr.created_at, sr.updated_at,
 COALESCE(sr.priority_override,mm.priority) AS priority, mm.priority AS detected_priority, mm.score, mm.ai_confidence, mm.ai_reason, mm.intent, mm.keyword_text, mm.occurrences,
 m.text, m.sent_at, m.tg_message_id, m.tg_chat_id, m.sender_name, m.sender_username, m.account_id,
 s.id AS source_id, s.title AS source_title, s.kind AS source_kind, s.username AS source_username, a.name AS account_name, ar.name AS radar_name`;

function whereFor(q = {}) {
  const parts = ['mm.deleted_at IS NULL','m.deleted_at IS NULL']; const vals=[];
  const add=(sql,v)=>{ vals.push(v); parts.push(sql.replaceAll('$#', `$${vals.length}`)); };
  if(q.q) { const i=vals.length+1; vals.push(q.q,q.q,q.q,q.q,q.q); parts.push(`(m.text ILIKE '%' || $${i} || '%' OR sr.service_type ILIKE '%' || $${i+1} || '%' OR sr.summary ILIKE '%' || $${i+2} || '%' OR s.title ILIKE '%' || $${i+3} || '%' OR sr.subcategory ILIKE '%' || $${i+4} || '%')`); }
  if(q.category) add('sr.category = $#', q.category);
  if(q.subcategory) add('sr.subcategory = $#', q.subcategory);
  if(q.status) add('sr.request_status = $#', q.status);
  if(q.priority) add('COALESCE(sr.priority_override,mm.priority) = $#', q.priority);
  if(q.source_id) add('m.source_id = $#', Number(q.source_id));
  if(q.account_id) add('m.account_id = $#', Number(q.account_id));
  if(q.assigned_to) add('sr.assigned_to = $#', Number(q.assigned_to));
  if(q.from) add('sr.created_at >= $#::date', q.from);
  if(q.to) add("sr.created_at < ($#::date + interval '1 day')", q.to);
  if(q.min_confidence !== undefined && q.min_confidence !== '') { const n=Number(q.min_confidence); if(Number.isFinite(n)) add('mm.ai_confidence >= $#',Math.max(0,Math.min(100,n))); }
  if(q.confident === 'true') parts.push('mm.ai_confidence IS NOT NULL AND mm.ai_confidence >= 70');
  if(q.confident === 'false') parts.push('(mm.ai_confidence IS NULL OR mm.ai_confidence < 70)');
  if(q.new_only === 'true') add('sr.request_status = $#','new');
  if(q.favorite === 'true') parts.push('sr.is_favorite = true');
  if(q.archived === 'true') parts.push('sr.archived_at IS NOT NULL'); else parts.push('sr.archived_at IS NULL');
  if(q.excluded === 'true') parts.push('sr.excluded_at IS NOT NULL'); else parts.push('sr.excluded_at IS NULL');
  return { sql:parts.join(' AND '), vals };
}
const asView = (x) => ({ ...x, links: telegramLinks({ chatId:x.tg_chat_id, kind:x.source_kind, username:x.source_username, messageId:x.tg_message_id }) });
const exists = async (id) => { const row=await one('SELECT id FROM service_requests WHERE id=$1',[id]); if(!row) throw new AppError('NOT_FOUND',{status:404}); return row; };
async function addEvent(c, {id,type,before=null,after=null,details={},userId=null}) {
  await c.query('INSERT INTO service_request_events(service_request_id,event_type,from_value,to_value,details,created_by) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6)',
    [id,type,before===null?null:JSON.stringify(before),after===null?null:JSON.stringify(after),JSON.stringify(details),userId]);
}

r.get('/service-requests', need('viewer'), h(async (req,res)=>{
  const p=paging(req.query,{max:100,def:30}); const w=whereFor(req.query);
  const [rows,total]=await Promise.all([many(`${SELECT} ${BASE} WHERE ${w.sql} ORDER BY sr.created_at DESC,sr.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`,w.vals),one(`SELECT count(*)::int AS n ${BASE} WHERE ${w.sql}`,w.vals)]);
  res.json({data:rows.map(asView),meta:pageMeta(total.n,p)});
}));
r.get('/service-requests/stats',need('viewer'),h(async(_req,res)=>{
  const data=await one(`SELECT count(*) FILTER(WHERE sr.archived_at IS NULL AND sr.excluded_at IS NULL)::int AS total,
    count(*) FILTER(WHERE sr.created_at::date=CURRENT_DATE AND sr.archived_at IS NULL AND sr.excluded_at IS NULL)::int AS today,
    count(*) FILTER(WHERE sr.category='خدمات طلابية وجامعية' AND sr.created_at::date=CURRENT_DATE AND sr.archived_at IS NULL AND sr.excluded_at IS NULL)::int AS student_today,
    count(*) FILTER(WHERE sr.category='تقنية وتكنولوجيا' AND sr.created_at::date=CURRENT_DATE AND sr.archived_at IS NULL AND sr.excluded_at IS NULL)::int AS tech_today,
    count(*) FILTER(WHERE sr.category='مساعدة واستفسارات عامة' AND sr.created_at::date=CURRENT_DATE AND sr.archived_at IS NULL AND sr.excluded_at IS NULL)::int AS general_today,
    count(*) FILTER(WHERE sr.request_status='new' AND sr.archived_at IS NULL AND sr.excluded_at IS NULL)::int AS new_count,
    count(*) FILTER(WHERE sr.request_status IN ('reviewing','identified','qualified','contacting','responded','in_progress','completed') AND sr.archived_at IS NULL AND sr.excluded_at IS NULL)::int AS reviewed,
    count(*) FILTER(WHERE COALESCE(sr.priority_override,mm.priority) IN ('high','critical') AND sr.archived_at IS NULL AND sr.excluded_at IS NULL)::int AS high_count,
    count(*) FILTER(WHERE sr.archived_at IS NOT NULL)::int AS archived,
    count(*) FILTER(WHERE sr.excluded_at IS NOT NULL)::int AS excluded ${BASE} WHERE mm.deleted_at IS NULL AND m.deleted_at IS NULL`);
  const categories=await many(`SELECT sr.category,count(*)::int AS count ${BASE} WHERE mm.deleted_at IS NULL AND m.deleted_at IS NULL AND sr.archived_at IS NULL AND sr.excluded_at IS NULL GROUP BY sr.category ORDER BY count DESC`);
  res.json({data,categories});
}));
r.get('/service-requests/categories',need('viewer'),h(async(_req,res)=>res.json({data:await many('SELECT id,name,color,enabled FROM service_categories ORDER BY id')})));
r.post('/service-requests/categories',need('operator'),h(async(req,res)=>{
  const b=z.object({name:z.string().trim().min(2).max(100),color:z.string().regex(/^[a-z-]{2,20}$/).default('blue')}).parse(req.body);
  const row=await one('INSERT INTO service_categories(name,color) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET enabled=true RETURNING id,name,color,enabled',[b.name,b.color]);
  await req.audit('SERVICE_CATEGORY_CREATED',{entity:'service_category',entityId:row.id});res.status(201).json({data:row});
}));
r.patch('/service-requests/categories/:id',need('operator'),h(async(req,res)=>{
  const id=idParam(req);const b=z.object({name:z.string().trim().min(2).max(100).optional(),enabled:z.boolean().optional(),color:z.string().regex(/^[a-z-]{2,20}$/).optional()}).refine(x=>Object.keys(x).length>0).parse(req.body);
  const keys=Object.keys(b);const sets=keys.map((k,i)=>`${({name:'name',enabled:'enabled',color:'color'})[k]}=$${i+2}`);
  const row=await one(`UPDATE service_categories SET ${sets.join(',')} WHERE id=$1 RETURNING id,name,color,enabled`,[id,...keys.map(k=>b[k])]);if(!row)throw new AppError('NOT_FOUND',{status:404});
  await req.audit('SERVICE_CATEGORY_UPDATED',{entity:'service_category',entityId:id,details:b});res.json({data:row});
}));
r.delete('/service-requests/categories/:id',need('operator'),h(async(req,res)=>{
  const id=idParam(req);const row=await one('SELECT name FROM service_categories WHERE id=$1',[id]);if(!row)throw new AppError('NOT_FOUND',{status:404});
  const used=await one('SELECT 1 FROM service_requests WHERE category=$1 LIMIT 1',[row.name]);if(used)throw new AppError('CONFLICT',{status:409,message:'category is referenced; disable it instead'});
  await query('DELETE FROM service_categories WHERE id=$1',[id]);await req.audit('SERVICE_CATEGORY_DELETED',{entity:'service_category',entityId:id});res.json({ok:true});
}));
r.get('/service-requests/assignees',need('operator'),h(async(_req,res)=>res.json({data:await many("SELECT id,username,display_name,role FROM users WHERE is_active AND deleted_at IS NULL ORDER BY display_name,username")})));
r.get('/service-requests/:id(\\d+)',need('viewer'),h(async(req,res)=>{
  const id=idParam(req);const row=await one(`${SELECT}, (SELECT count(*)::int FROM service_request_cluster_members cm WHERE cm.service_request_id=sr.id) AS cluster_count ${BASE} WHERE sr.id=$1`,[id]);
  if(!row)throw new AppError('NOT_FOUND',{status:404});
  const [notes,events,clusters]=await Promise.all([many('SELECT n.id,n.note,n.created_at,n.created_by,u.username,u.display_name FROM service_request_notes n LEFT JOIN users u ON u.id=n.created_by WHERE n.service_request_id=$1 ORDER BY n.id DESC',[id]),many('SELECT e.id,e.event_type,e.from_value,e.to_value,e.details,e.created_at,e.created_by,u.username,u.display_name FROM service_request_events e LEFT JOIN users u ON u.id=e.created_by WHERE e.service_request_id=$1 ORDER BY e.id DESC LIMIT 200',[id]),many('SELECT c.id,c.name,c.category,c.description FROM service_request_clusters c JOIN service_request_cluster_members cm ON cm.cluster_id=c.id WHERE cm.service_request_id=$1',[id])]);
  res.json({data:{...asView(row),notes,events,clusters}});
}));
r.patch('/service-requests/:id',need('operator'),h(async(req,res)=>{
  const id=idParam(req);const b=z.object({
    status:z.enum(STATUSES).optional(),category:z.string().trim().min(2).max(100).optional(),subcategory:z.string().trim().max(100).nullable().optional(),
    priority:z.enum(PRIORITIES).nullable().optional(),service_type:z.string().trim().max(200).nullable().optional(),summary:z.string().trim().max(1000).nullable().optional(),
    assigned_to:z.number().int().positive().nullable().optional(),favorite:z.boolean().optional(),
  }).refine(x=>Object.keys(x).length>0).parse(req.body);
  const result=await tx(async(c)=>{
    const before=(await c.query('SELECT id,request_status,category,subcategory,priority_override,service_type,summary,assigned_to,is_favorite,classification_method FROM service_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw new AppError('NOT_FOUND',{status:404});
    const map={status:'request_status',category:'category',subcategory:'subcategory',priority:'priority_override',service_type:'service_type',summary:'summary',assigned_to:'assigned_to',favorite:'is_favorite'};
    const keys=Object.keys(b);const vals=[id];const sets=[];const changes={};
    for(const k of keys){const col=map[k];const v=b[k];const old=before[col];if(old===v)continue;vals.push(v);sets.push(`${col}=$${vals.length}`);changes[k]={from:old,to:v};}
    if(!sets.length)return {row:before,changes:{}};
    if(b.category!==undefined&&b.category!==before.category){sets.push('category_corrected=true');sets.push("classification_method='manual'");}
    sets.push('updated_at=now()');
    const after=(await c.query(`UPDATE service_requests SET ${sets.join(',')} WHERE id=$1 RETURNING id,request_status,category,subcategory,priority_override,service_type,summary,assigned_to,is_favorite,category_corrected,classification_method,updated_at`,vals)).rows[0];
    if(changes.category)await c.query('INSERT INTO service_request_feedback(service_request_id,previous_category,corrected_category,created_by) VALUES($1,$2,$3,$4)',[id,changes.category.from,changes.category.to,req.user.id]);
    await addEvent(c,{id,type:'updated',before:Object.fromEntries(Object.entries(changes).map(([k,v])=>[k,v.from])),after:Object.fromEntries(Object.entries(changes).map(([k,v])=>[k,v.to])),userId:req.user.id});
    return {row:after,changes};
  });
  await req.audit('SERVICE_REQUEST_UPDATED',{entity:'service_request',entityId:id,details:{fields:Object.keys(result.changes)}});res.json({data:result.row});
}));
r.get('/service-requests/:id/notes',need('viewer'),h(async(req,res)=>{const id=idParam(req);await exists(id);res.json({data:await many('SELECT n.id,n.note,n.created_at,n.created_by,u.username,u.display_name FROM service_request_notes n LEFT JOIN users u ON u.id=n.created_by WHERE n.service_request_id=$1 ORDER BY n.id DESC',[id])});}));
r.post('/service-requests/:id/notes',need('operator'),h(async(req,res)=>{
  const id=idParam(req);const {note}=z.object({note:z.string().trim().min(1).max(4000)}).parse(req.body);await exists(id);
  const created=await tx(async(c)=>{const n=(await c.query('INSERT INTO service_request_notes(service_request_id,note,created_by) VALUES($1,$2,$3) RETURNING *',[id,note,req.user.id])).rows[0];await addEvent(c,{id,type:'note_added',after:{note_id:n.id},userId:req.user.id});return n;});
  await req.audit('SERVICE_REQUEST_NOTE_ADDED',{entity:'service_request',entityId:id});res.status(201).json({data:created});
}));
r.get('/service-requests/:id/history',need('viewer'),h(async(req,res)=>{const id=idParam(req);await exists(id);res.json({data:await many('SELECT e.id,e.event_type,e.from_value,e.to_value,e.details,e.created_at,e.created_by,u.username,u.display_name FROM service_request_events e LEFT JOIN users u ON u.id=e.created_by WHERE e.service_request_id=$1 ORDER BY e.id DESC LIMIT 200',[id])});}));
for(const [op,sql,type] of [
  ['archive','archived_at=now(), archived_by=$2','archived'],['restore','archived_at=NULL, archived_by=NULL','restored'],
  ['exclude','excluded_at=now(), excluded_by=$2','excluded'],['unexclude','excluded_at=NULL, excluded_by=NULL, exclusion_reason=NULL','unexcluded'],
]) r.post(`/service-requests/:id/${op}`,need('operator'),h(async(req,res)=>{
  const id=idParam(req);const reason=op==='exclude'?z.object({reason:z.string().trim().max(500).optional()}).parse(req.body??{}).reason:null;
  const before=await one('SELECT archived_at,excluded_at,exclusion_reason FROM service_requests WHERE id=$1',[id]);if(!before)throw new AppError('NOT_FOUND',{status:404});
  let sets=sql;if(op==='exclude')sets+=', exclusion_reason=$3';
  const vals=op==='exclude'?[id,req.user.id,reason]:op==='archive'?[id,req.user.id]:[id];
  await tx(async(c)=>{await c.query(`UPDATE service_requests SET ${sets},updated_at=now() WHERE id=$1`,vals);await addEvent(c,{id,type,before,after:{operation:op,reason},userId:req.user.id});});
  await req.audit(`SERVICE_REQUEST_${op.toUpperCase()}`,{entity:'service_request',entityId:id,details:reason?{reason}:{}});res.json({ok:true});
}));

r.get('/service-requests/clusters',need('viewer'),h(async(req,res)=>{
  const p=paging(req.query,{max:100,def:30});
  const data=await many(`SELECT c.id,c.name,c.category,c.description,c.created_at,c.updated_at,count(cm.service_request_id)::int AS request_count
    FROM service_request_clusters c LEFT JOIN service_request_cluster_members cm ON cm.cluster_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`);
  res.json({data,meta:pageMeta(data.length,p)});
}));
r.get('/service-requests/clusters/suggestions',need('viewer'),h(async(_req,res)=>{
  const rows=await many(`SELECT sr.id,sr.category,sr.service_type,sr.subcategory,sr.summary,m.text FROM service_requests sr
    JOIN message_matches mm ON mm.id=sr.match_id JOIN messages m ON m.id=mm.message_id
    WHERE sr.archived_at IS NULL AND sr.excluded_at IS NULL AND mm.deleted_at IS NULL AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM service_request_cluster_members cm WHERE cm.service_request_id=sr.id)
    ORDER BY sr.created_at DESC LIMIT 300`);
  const stop=new Set(['احتاج','أحتاج','محتاج','ابي','أبي','ابغى','اريد','أريد','من','في','على','الى','عن','مع','هذا','هذه','the','and','for','with','need','help','someone','anyone','please','looking','i','a','an','to','in','of']);
  const words=(r)=>new Set(String([r.service_type,r.subcategory,r.summary,r.text].filter(Boolean).join(' ')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').split(/\s+/).filter(x=>x.length>2&&!stop.has(x)));
  const terms=rows.map(words),serviceKeys=rows.map(r=>[...words({service_type:r.service_type})].sort().join(' ')),parent=rows.map((_,i)=>i),find=(x)=>parent[x]===x?x:(parent[x]=find(parent[x]));
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    if(rows[i].category!==rows[j].category)continue;
    const a=terms[i],b=terms[j],inter=[...a].filter(x=>b.has(x)).length,union=new Set([...a,...b]).size;
    if((serviceKeys[i]&&serviceKeys[i]===serviceKeys[j]&&serviceKeys[i].split(' ').length>=2)||(union&&inter/union>=0.38)){const x=find(i),y=find(j);if(x!==y)parent[y]=x;}
  }
  const groups=new Map();for(let i=0;i<rows.length;i++){const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(i);}
  const data=[...groups.values()].filter(g=>g.length>1).slice(0,30).map(g=>({category:rows[g[0]].category,request_ids:g.map(i=>rows[i].id),items:g.map(i=>({id:rows[i].id,service_type:rows[i].service_type,summary:rows[i].summary,text:rows[i].text.slice(0,220)})),method:'lexical_jaccard'}));
  res.json({data,note:'Suggestions are lexical candidates only. They never merge or edit source requests; an operator must review and create a cluster.'});
}));
r.post('/service-requests/clusters',need('operator'),h(async(req,res)=>{
  const b=z.object({name:z.string().trim().min(2).max(160),category:z.string().trim().max(100).nullable().optional(),description:z.string().trim().max(1000).nullable().optional(),request_ids:z.array(z.number().int().positive()).min(2).max(100)}).parse(req.body);
  if(new Set(b.request_ids).size!==b.request_ids.length)throw new AppError('VALIDATION');
  const out=await tx(async(c)=>{
    const found=(await c.query('SELECT id FROM service_requests WHERE id=ANY($1::bigint[]) AND archived_at IS NULL AND excluded_at IS NULL',[b.request_ids])).rows;
    if(found.length!==b.request_ids.length)throw new AppError('VALIDATION',{status:409,message:'all requests must exist and be active'});
    const cRow=(await c.query('INSERT INTO service_request_clusters(name,category,description,created_by) VALUES($1,$2,$3,$4) RETURNING *',[b.name,b.category??null,b.description??null,req.user.id])).rows[0];
    for(const requestId of b.request_ids)await c.query('INSERT INTO service_request_cluster_members(cluster_id,service_request_id,created_by) VALUES($1,$2,$3)',[cRow.id,requestId,req.user.id]);
    for(const requestId of b.request_ids)await addEvent(c,{id:requestId,type:'clustered',after:{cluster_id:cRow.id},userId:req.user.id});
    return cRow;
  });
  await req.audit('SERVICE_REQUEST_CLUSTER_CREATED',{entity:'service_request_cluster',entityId:out.id,details:{count:b.request_ids.length}});res.status(201).json({data:out});
}));
r.get('/service-requests/clusters/:id',need('viewer'),h(async(req,res)=>{
  const id=idParam(req);const cluster=await one('SELECT * FROM service_request_clusters WHERE id=$1',[id]);if(!cluster)throw new AppError('NOT_FOUND',{status:404});
  const rows=await many(`${SELECT} ${BASE} JOIN service_request_cluster_members cm ON cm.service_request_id=sr.id WHERE cm.cluster_id=$1 ORDER BY sr.created_at DESC`,[id]);res.json({data:{...cluster,requests:rows.map(asView)}});
}));
r.delete('/service-requests/clusters/:id',need('operator'),h(async(req,res)=>{const id=idParam(req);const row=await one('DELETE FROM service_request_clusters WHERE id=$1 RETURNING id',[id]);if(!row)throw new AppError('NOT_FOUND',{status:404});await req.audit('SERVICE_REQUEST_CLUSTER_DELETED',{entity:'service_request_cluster',entityId:id});res.json({ok:true});}));
r.get('/export/service-requests',need('viewer'),h(async(req,res)=>{
  const w=whereFor(req.query);const rows=await many(`${SELECT} ${BASE} WHERE ${w.sql} ORDER BY sr.created_at DESC,sr.id DESC LIMIT ${MAX_EXPORT_ROWS}`,w.vals);
  const cols=[['id','رقم الطلب'],['created_at','تاريخ الإنشاء'],['category','المجال'],['subcategory','التصنيف الفرعي'],['service_type','الخدمة'],['summary','الوصف'],['request_status','الحالة'],['priority','الأولوية'],['ai_confidence','ثقة الذكاء الاصطناعي'],['text','الرسالة'],['source_title','المجموعة'],['account_name','حساب Telegram'],['sender_username','اسم المرسل'],['assignee_name','المسؤول']].map(([key,label])=>({key,label}));
  await req.audit('EXPORT_SERVICE_REQUESTS',{details:{format:req.query.format??'csv',rows:rows.length}});await sendExport(res,{format:req.query.format,name:'nabd-service-requests',title:'NABD AI — احتياجات الخدمات',lang:req.query.lang??'ar',columns:cols,rows});
}));

export default r;
