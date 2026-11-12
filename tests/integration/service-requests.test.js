import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, setupAdmin } from '../helpers/harness.js';
import { Ingestor } from '../../src/services/ingest.js';
import { stageProcess, stageKeyword, stageAi } from '../../src/workers/pipeline.js';

let h, userId, accountId, sourceId, req1, req2;
async function addMatch(text,{confidence=88,priority='high',score=88,intent='مساعدة في تطوير تطبيق Android',keyword='تطوير تطبيق'}={}){
  const message=await h.db.one(`INSERT INTO messages(account_id,source_id,tg_chat_id,tg_message_id,sender_id,sender_username,sender_name,text,sent_at,state)
    VALUES($1,$2,-100777000001,$3,7001,'test-user','Test User',$4,now(),'done') RETURNING id`,[accountId,sourceId,Date.now()+Math.floor(Math.random()*100000),text]);
  return h.db.one(`INSERT INTO message_matches(message_id,account_id,source_id,match_type,score,priority,intent,ai_confidence,ai_reason,keyword_text,sender_id,chat_id)
    VALUES($1,$2,$3,'semantic',$4,$5,$6,$7,'تم العثور على طلب خدمة تجريبي',$8,7001,-100777000001) RETURNING id`,[message.id,accountId,sourceId,score,priority,intent,confidence,keyword]);
}

before(async()=>{
  h=await startHarness({workers:false});await setupAdmin(h);
  userId=(await h.db.one("SELECT id FROM users WHERE username='admin'" )).id;
  accountId=(await h.db.one(`INSERT INTO telegram_accounts(name,phone_enc,phone_masked,phone_hash,api_id_enc,api_hash_enc,status,enabled,created_by)
    VALUES('اختبار محلي','fake-phone','***0001','test-needs-phone-hash','fake-api-id','fake-api-hash','connected',true,$1) RETURNING id`,[userId])).id;
  sourceId=(await h.db.one(`INSERT INTO telegram_sources(account_id,tg_chat_id,kind,title,monitoring_enabled) VALUES($1,-100777000001,'supergroup','مجموعة اختبار معزولة',true) RETURNING id`,[accountId])).id;
  req1=(await addMatch('هل يوجد شخص متخصص في برمجة تطبيق أندرويد يساعدني؟')).id;
  req2=(await addMatch('أبحث عن مبرمج لتطوير تطبيق Android مشابه، أحتاج مساعدة', {confidence:95,intent:'مساعدة في تطوير تطبيق Android'})).id;
  await addMatch('أقدم خدمات تصميم المواقع والتطبيقات، تواصلوا معي');
  await addMatch('صباح الخير يا شباب');
});
after(async()=>{if(h)await h.stop();});

test('service request detection is bounded to request intent and known service offers/noise stay out',async()=>{
  const result=await h.ok('GET','/api/service-requests?limit=50');
  assert.equal(result.data.length,2);
  assert.ok(result.data.some(x=>x.id===req1));assert.ok(result.data.some(x=>x.id===req2));
  assert.equal(result.data[0].category,'تقنية وتكنولوجيا');
  assert.equal(result.data[0].priority,'high');
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,2);
});

test('request details, notes, history, state/category/priority/assignee/subcategory/favorite and archive/exclude/restore',async()=>{
  const detail=await h.ok('GET',`/api/service-requests/${req1}`);
  assert.equal(detail.data.text,'هل يوجد شخص متخصص في برمجة تطبيق أندرويد يساعدني؟');
  await h.ok('POST',`/api/service-requests/${req1}/notes`,{note:'تمت مراجعة الطلب، يرجى التواصل بعد التحقق.'});
  const patch=await h.ok('PATCH',`/api/service-requests/${req1}`,{status:'in_progress',category:'تقنية وتكنولوجيا',subcategory:'تطبيقات Android',priority:'critical',service_type:'تطوير تطبيق جوال',summary:'طلب تجريبي للتطبيق',assigned_to:userId,favorite:true});
  assert.equal(patch.data.request_status,'in_progress');assert.equal(patch.data.priority_override,'critical');assert.equal(patch.data.assigned_to,userId);
  await h.ok('PATCH',`/api/service-requests/${req1}`,{category:'تصميم وإبداع'});
  await h.ok('PATCH',`/api/service-requests/${req1}`,{category:'تقنية وتكنولوجيا'});
  const after=await h.ok('GET',`/api/service-requests/${req1}`);
  assert.equal(after.data.notes.length,1);assert.ok(after.data.events.some(x=>x.event_type==='updated'));assert.ok(after.data.events.some(x=>x.event_type==='note_added'));
  assert.equal(after.data.subcategory,'تطبيقات Android');assert.equal(after.data.is_favorite,true);assert.equal(after.data.classification_method,'manual');
  assert.equal((await h.ok('GET',`/api/service-requests?account_id=${accountId}&subcategory=${encodeURIComponent('تطبيقات Android')}&favorite=true`)).data.length,1);
  await h.ok('POST',`/api/service-requests/${req1}/archive`);
  assert.equal((await h.ok('GET','/api/service-requests')).data.length,1);
  assert.equal((await h.ok('GET','/api/service-requests?archived=true')).data.length,1);
  await h.ok('POST',`/api/service-requests/${req1}/restore`);
  await h.ok('POST',`/api/service-requests/${req1}/exclude`,{reason:'اختبار استبعاد'});
  assert.equal((await h.ok('GET','/api/service-requests')).data.length,1);
  assert.equal((await h.ok('GET','/api/service-requests?excluded=true')).data.length,1);
  await h.ok('POST',`/api/service-requests/${req1}/unexclude`);
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM messages')).n,4,'source messages remain untouched');
});

test('filters, safe category lifecycle, exports and non-destructive similarity clusters',async()=>{
  const today=new Date().toISOString().slice(0,10);
  const filtered=await h.ok('GET',`/api/service-requests?account_id=${accountId}&source_id=${sourceId}&category=${encodeURIComponent('تقنية وتكنولوجيا')}&status=new&priority=high&from=${today}&to=${today}&min_confidence=90`);
  assert.equal(filtered.data.length,1);assert.equal(filtered.data[0].id,req2);
  await h.ok('PATCH',`/api/service-requests/${req2}`,{service_type:'تطوير تطبيق جوال'});
  const category=await h.ok('POST','/api/service-requests/categories',{name:'فئة تجريبية'});
  await h.ok('PATCH',`/api/service-requests/categories/${category.data.id}`,{enabled:false});
  await h.ok('DELETE',`/api/service-requests/categories/${category.data.id}`);
  const suggestion=await h.ok('GET','/api/service-requests/clusters/suggestions');
  assert.ok(suggestion.data.some(g=>g.request_ids.includes(req1)&&g.request_ids.includes(req2)));
  const cluster=await h.ok('POST','/api/service-requests/clusters',{name:'تطوير تطبيقات Android',category:'تقنية وتكنولوجيا',request_ids:[req1,req2]});
  assert.equal((await h.ok('GET','/api/service-requests/clusters')).data.length,1);
  assert.equal((await h.ok('GET',`/api/service-requests/clusters/${cluster.data.id}`)).data.requests.length,2);
  const csv=await h.api('GET','/api/export/service-requests?format=csv');assert.equal(csv.status,200);assert.ok(csv.buf.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])));assert.ok(csv.text.includes('تقنية وتكنولوجيا'));
  const xlsx=await h.api('GET','/api/export/service-requests?format=xlsx');assert.equal(xlsx.status,200);assert.equal(xlsx.buf.subarray(0,2).toString(),'PK');
  const printable=await h.api('GET','/api/export/service-requests?format=html');assert.equal(printable.status,200);assert.ok(printable.text.includes('dir="rtl"'));
  const pdf=await h.api('GET','/api/export/service-requests?format=pdf');assert.equal(pdf.status,200);assert.ok((pdf.headers.get('content-type')||'').includes('application/pdf'));assert.equal(pdf.buf.subarray(0,5).toString(),'%PDF-');
  await h.ok('DELETE',`/api/service-requests/clusters/${cluster.data.id}`);
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,2,'removing a cluster must not delete requests');
});

test('capture settings constrain future requests without changing existing records',async()=>{
  await h.ok('PUT','/api/settings',{values:{'service_requests.enabled':false}});
  await addMatch('أحتاج مدرسًا لمساعدتي في اختبار اللغة الإنجليزية',{intent:'مساعدة تعليمية',keyword:'مدرس'});
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,2);
  await h.ok('PUT','/api/settings',{values:{'service_requests.enabled':true,'service_requests.account_ids':[999999]}});
  await addMatch('أحتاج مختص ترجمة للغة الإنجليزية',{intent:'طلب ترجمة',keyword:'ترجمة'});
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,2);
  await h.ok('PUT','/api/settings',{values:{'service_requests.account_ids':[],'service_requests.min_confidence':90}});
  await addMatch('أبحث عن دعم تقني لمشكلة في تطبيق Android',{confidence:45,intent:'دعم تقني',keyword:'دعم تقني'});
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,2);
  await h.ok('PUT','/api/settings',{values:{'service_requests.min_confidence':0}});
  await h.ok('PUT','/api/settings',{values:{'service_requests.sensitivity':'strict'}});
  await addMatch('أبحث عن مبرمج لموقع صغير',{score:78,confidence:91,intent:'خدمة تقنية',keyword:'مبرمج'});
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,2,'strict mode rejects scores under 85');
  await h.ok('PUT','/api/settings',{values:{'service_requests.sensitivity':'balanced'}});
  await addMatch('أبحث عن مطور تطبيق بسيط',{score:78,confidence:91,intent:'خدمة تقنية',keyword:'مطور تطبيق'});
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,3,'balanced mode accepts scores at or above 70');
  await addMatch('أحتاج مبرمجًا لإعداد تطبيق تعليمي على Android',{confidence:92,intent:'تطوير تطبيق Android',keyword:'مبرمج'});
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,4);
});

test('mock Telegram ingestion traverses Radar/worker stages, classifies five domains, rejects offers/chat, and is idempotent',async()=>{
  const {data:rules}=await h.ok('GET','/api/radar');
  const seeds=rules.filter(r=>r.name.startsWith('NABD Needs |'));
  assert.equal(seeds.length,5);
  assert.ok(seeds.every(r=>r.status==='draft'),'starter radars are drafts until reviewed on a real installation');
  for(const rule of seeds)await h.ok('POST',`/api/radar/${rule.id}/activate`,{confirm:true});
  const ingestor=new Ingestor({flushMs:60000,maxBatch:10});let tgId=810000;
  async function roundTrip(text,{ai=false}={}){
    const current=tgId++;
    ingestor.push({accountId,sourceId,chatId:-100777000001,tgMessageId:current,senderId:7002,senderUsername:'mock-sender',senderName:'Mock Sender',text,date:new Date(),hasMedia:false,replyToId:null});
    assert.equal(await ingestor.flush(),1,'Telegram ingest stores the message before queue work');
    const message=(await h.db.one('SELECT id FROM messages WHERE account_id=$1 AND tg_chat_id=$2 AND tg_message_id=$3',[accountId,-100777000001,current])).id;
    await stageProcess(message);
    if(ai)await stageAi(message,seeds.map(r=>r.id),{final:true});else await stageKeyword(message);
    assert.equal((await h.db.one('SELECT state FROM messages WHERE id=$1',[message])).state,'done');
    return message;
  }
  await h.ok('PUT','/api/ai/providers/custom',{enabled:true,base_url:`${h.svc.url}/v1`,model:'fake-model',api_key:'local-test-only-not-a-provider-key'});
  await h.ok('PUT','/api/settings',{values:{'ai.primary':'custom','ai.semantic_enabled':true,'ai.classification_enabled':true,'ai.summarization_enabled':true}});
  h.svc.ai.forceMatch=true;h.svc.ai.categoryOverride='تصميم وإبداع';
  const aiMessage=await roundTrip('أحتاج مصمم واجهات لموقع شركتي',{ai:true});
  const aiResult=await h.db.one('SELECT category,entities,is_match FROM ai_results WHERE message_id=$1 ORDER BY ai_rule_id LIMIT 1',[aiMessage]);
  const aiRequest=await h.db.one(`SELECT sr.category,sr.classification_method,sr.service_type,sr.subcategory,sr.summary FROM service_requests sr JOIN message_matches mm ON mm.id=sr.match_id WHERE mm.message_id=$1`,[aiMessage]);
  assert.equal(aiRequest.category,'تصميم وإبداع',`a valid AI category overrides the deterministic text fallback; ai=${JSON.stringify(aiResult)} request=${JSON.stringify(aiRequest)} calls=${h.svc.ai.calls}`);
  assert.equal(aiRequest.classification_method,'ai');assert.equal(aiRequest.service_type,'تصميم واجهات');assert.equal(aiRequest.subcategory,'تصميم مواقع');assert.equal(aiRequest.summary,'طلب تصميم واجهات لموقع الشركة');
  assert.ok(h.svc.ai.lastUser.includes('Service-request classification:')&&h.svc.ai.lastUser.includes('تصميم وإبداع'),'service taxonomy and contextual-classification instruction reach the AI adapter');
  h.svc.ai.forceMatch=null;h.svc.ai.categoryOverride=null;
  for(const provider of (await h.ok('GET','/api/ai/providers')).data)await h.ok('PUT',`/api/ai/providers/${provider.id}`,{enabled:false,api_key:''});
  await h.ok('PUT','/api/settings',{values:{'ai.primary':'grok','ai.fallback':'','ai.failover_enabled':false}});
  const cases=[
    ['هل يعرف أحد مبرمجًا لبناء تطبيق Android؟','تقنية وتكنولوجيا'],
    ['أحتاج مدرسًا للرياضيات والشرح قبل الاختبار','خدمات طلابية وجامعية'],
    ['أحتاج مصمم شعار لهوية مشروعي الجديد','تصميم وإبداع'],
    ['أحتاج ترجمة مقال من العربية إلى الإنجليزية','ترجمة ولغات'],
    ['من يعرف فنيًا يساعدني في إصلاح الجهاز؟','مساعدة واستفسارات عامة'],
    ['anyone know a developer for an Android app?','تقنية وتكنولوجيا'],
  ];
  const processed=[];
  for(const [text,category] of cases){const messageId=await roundTrip(text);processed.push(messageId);const row=await h.db.one('SELECT sr.category FROM service_requests sr JOIN message_matches mm ON mm.id=sr.match_id WHERE mm.message_id=$1',[messageId]);assert.equal(row?.category,category,text);}
  const offer=await roundTrip('أقدم خدمات برمجة المواقع والتطبيقات، تواصلوا معي.');
  const greeting=await roundTrip('صباح الخير يا أصدقاء، يومكم سعيد.');
  assert.equal(await h.db.one('SELECT count(*)::int AS n FROM service_requests sr JOIN message_matches mm ON mm.id=sr.match_id WHERE mm.message_id=ANY($1::bigint[])',[ [offer,greeting] ]).then(x=>x.n),0);
  const duplicateTgId=810000; // the first message in the sequence
  ingestor.push({accountId,sourceId,chatId:-100777000001,tgMessageId:duplicateTgId,senderId:7002,senderUsername:'mock-sender',senderName:'Mock Sender',text:cases[0][0],date:new Date(),hasMedia:false,replyToId:null});
  assert.equal(await ingestor.flush(),0,'same Telegram message is ignored on replay');
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM messages WHERE account_id=$1 AND tg_chat_id=$2 AND tg_message_id=$3',[accountId,-100777000001,duplicateTgId])).n,1);
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM service_requests')).n,11,'four service requests pre-exist; the mock pass creates six deterministic and one AI-classified request');
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM ai_results WHERE message_id=ANY($1::bigint[])',[processed])).n,0,'no AI score is fabricated when no provider/key is configured');
});
