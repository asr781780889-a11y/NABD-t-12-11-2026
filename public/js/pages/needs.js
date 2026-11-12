import { h, clear } from '../lib/dom.js';
import { fmt } from '../lib/i18n.js';
import { get, post, patch, del } from '../lib/api.js';
import { pageHead, kpi, card, btn, badge, emptyState, errorBox, can, toast, modal, exportMenu } from '../lib/ui.js';
import * as ws from '../lib/ws.js';

const STATUS=[['new','جديد'],['reviewing','تمت المراجعة'],['identified','تم تحديد الخدمة'],['qualified','مؤهل للمتابعة'],['contacting','قيد التواصل'],['responded','تمت الاستجابة'],['in_progress','قيد التنفيذ'],['completed','مكتمل'],['cancelled','ملغي'],['irrelevant','غير مناسب'],['duplicate','مكرر']];
const PRIORITY=[['critical','حرجة'],['high','عالية'],['medium','متوسطة'],['low','منخفضة']];
const CLASSIFICATION={ai:'تصنيف AI',rules:'تصنيف قواعد/نص',manual:'تصنيف يدوي'};
const setSelect=(items,value,onChange,disabled=false,label='')=>h('select',{value:value??'',disabled,'aria-label':label,onChange:e=>onChange(e.target.value)},items.map(([v,l])=>h('option',{value:v},l)));
export default async function serviceNeeds(ctx){
  const statsBox=h('div',{class:'grid g4'}),filters=h('div',{class:'filters'}),rows=h('div',{class:'stack'}),categoriesHost=h('div'),pager=h('div'),clustersHost=h('div');
  const state={q:'',category:'',subcategory:'',status:'',priority:'',account_id:'',source_id:'',page:1};let cats=[],accounts=[],sources=[],assignees=[];let meta=null,timer;
  const getFilters=()=>Object.fromEntries(Object.entries(state).filter(([k,v])=>k!=='page'&&k!=='limit'&&v!==''&&v!=null));
  const load=async()=>{try{const [s,c,src,acc]=await Promise.all([get('/service-requests/stats'),get('/service-requests/categories'),get('/sources',{limit:200}),get('/accounts',{limit:200})]);cats=c.data.filter(x=>x.enabled);sources=src.data;accounts=acc.data;paintStats(s.data);paintCategories(c.data);drawFilters();await loadRows();}catch(e){clear(rows).append(errorBox(e,load));}};
  const paintStats=s=>clear(statsBox).append(
    kpi({label:'طلبات اليوم',value:fmt.num(s.today),ic:'activity'}),kpi({label:'طلبات الطلاب اليوم',value:fmt.num(s.student_today),ic:'book'}),
    kpi({label:'طلبات التقنية اليوم',value:fmt.num(s.tech_today),ic:'cpu'}),kpi({label:'طلبات جديدة',value:fmt.num(s.new_count),ic:'sparkles',tone:'warn'}),
    kpi({label:'تمت مراجعتها',value:fmt.num(s.reviewed),ic:'check',tone:'ok'}),kpi({label:'أولوية عالية',value:fmt.num(s.high_count),ic:'zap',tone:'bad'}),
    kpi({label:'مؤرشفة',value:fmt.num(s.archived),ic:'archive'}),kpi({label:'إجمالي نشط',value:fmt.num(s.total),ic:'layers'}));
  const drawFilters=()=>{
    const search=h('input',{type:'search',placeholder:'ابحث في نص الرسالة أو الخدمة أو المجموعة…',value:state.q,onInput:()=>{state.q=search.value;debounceLoad();}});
    const category=h('select',{value:state.category,onChange:()=>{state.category=category.value;resetPage();loadRows();}},h('option',{value:''},'كل المجالات'),cats.map(x=>h('option',{value:x.name},x.name)));
    const status=setSelect([['','كل الحالات'],...STATUS],state.status,v=>{state.status=v;resetPage();loadRows();});
    const priority=setSelect([['','كل الأولويات'],...PRIORITY],state.priority,v=>{state.priority=v;resetPage();loadRows();});
    const account=h('select',{value:state.account_id,onChange:()=>{state.account_id=account.value;resetPage();loadRows();}},h('option',{value:''},'كل الحسابات'),accounts.map(a=>h('option',{value:a.id},a.name||a.phone_masked||`حساب ${a.id}`)));
    const source=h('select',{value:state.source_id,onChange:()=>{state.source_id=source.value;resetPage();loadRows();}},h('option',{value:''},'كل المجموعات/القنوات'),sources.map(x=>h('option',{value:x.id},`${x.title||x.tg_chat_id}${x.account_name?` · ${x.account_name}`:''}`)));
    const subcategory=h('input',{type:'search',placeholder:'التصنيف الفرعي…',value:state.subcategory,onInput:()=>{state.subcategory=subcategory.value;debounceLoad();}});
    const from=h('input',{type:'date',title:'من تاريخ',value:state.from||'',onChange:()=>{state.from=from.value;resetPage();loadRows();}}),to=h('input',{type:'date',title:'إلى تاريخ',value:state.to||'',onChange:()=>{state.to=to.value;resetPage();loadRows();}});
    const confidence=h('input',{type:'number',min:0,max:100,placeholder:'أدنى ثقة AI %',value:state.min_confidence??'',onInput:()=>{state.min_confidence=confidence.value;debounceLoad();}});
    clear(filters).append(search,category,subcategory,status,priority,account,source,from,to,confidence,
      btn(state.new_only?'إلغاء جديد فقط':'جديدة فقط',()=>{state.new_only=state.new_only?'':'true';resetPage();loadRows();},{sm:true,kind:state.new_only?'on':''}),
      btn(state.favorite==='true'?'إلغاء المفضلة':'المفضلة فقط',()=>{state.favorite=state.favorite?'':'true';resetPage();loadRows();},{sm:true,kind:state.favorite?'on':''}),
      btn(state.archived==='true'?'عرض النشطة':'المؤرشفة',()=>{state.archived=state.archived?'':'true';resetPage();loadRows();},{sm:true,kind:state.archived?'on':''}),
      btn(state.excluded==='true'?'عرض غير المستبعدة':'المستبعدة',()=>{state.excluded=state.excluded?'':'true';resetPage();loadRows();},{sm:true,kind:state.excluded?'on':''}),
      btn('ثقة ≥ 70%',()=>{state.confident=state.confident?'':'true';resetPage();loadRows();},{sm:true,kind:state.confident?'on':''}),btn('مسح الفلاتر',()=>{for(const k of Object.keys(state))if(k!=='page')state[k]='';resetPage();drawFilters();loadRows();},{sm:true}));
  };
  const resetPage=()=>{state.page=1;};const debounceLoad=()=>{clearTimeout(timer);timer=setTimeout(()=>{resetPage();loadRows();},300);};
  const paintCategories=items=>{
    const editor=h('div',{class:'row',style:{flexWrap:'wrap'}});
    for(const item of items)editor.append(h('label',{class:'chip row tight'},h('input',{type:'checkbox',checked:item.enabled,disabled:!can('operator'),onChange:async()=>{try{await patch(`/service-requests/categories/${item.id}`,{enabled:!item.enabled});await load();}catch(e){ctx.root.append(errorBox(e,load));}}}),item.name));
    const name=h('input',{placeholder:'إضافة مجال جديد',style:{maxWidth:'220px'}});
    if(can('operator'))editor.append(name,btn('إضافة',async()=>{if(!name.value.trim())return;try{await post('/service-requests/categories',{name:name.value.trim()});await load();}catch(e){ctx.root.append(errorBox(e,load));}},{sm:true,ic:'plus'}));clear(categoriesHost).append(editor);
  };
  const loadRows=async()=>{try{const res=await get('/service-requests',{...getFilters(),page:state.page,limit:20});meta=res.meta;clear(rows);if(!res.data.length){rows.append(emptyState('لا توجد طلبات مطابقة للفلاتر. الرسائل الأصلية والمطابقات لا تُحذف عند الأرشفة أو الاستبعاد.','search'));clear(pager);return;}for(const r of res.data)rows.append(renderRequest(r));clear(pager).append(h('div',{class:'row',style:{justifyContent:'center',marginTop:'10px'}},btn('السابق',()=>{state.page--;loadRows();},{sm:true,disabled:meta.page<=1}),h('span',{class:'muted'},`صفحة ${meta.page} من ${meta.pages} · ${fmt.num(meta.total)} طلب`),btn('التالي',()=>{state.page++;loadRows();},{sm:true,disabled:meta.page>=meta.pages})));}catch(e){clear(rows).append(errorBox(e,loadRows));}};
  const action=async(id,path,body={})=>{try{await post(`/service-requests/${id}/${path}`,body);toast('تم تحديث الطلب.');await load();}catch(e){ctx.root.append(errorBox(e,load));}};
  const renderRequest=r=>{
    const status=setSelect(STATUS,r.request_status,v=>patch(`/service-requests/${r.id}`,{status:v}).then(load).catch(e=>ctx.root.append(errorBox(e,loadRows))),!can('operator'),'حالة الطلب');
    const category=setSelect(cats.map(x=>[x.name,x.name]),r.category,v=>patch(`/service-requests/${r.id}`,{category:v}).then(load).catch(e=>ctx.root.append(errorBox(e,loadRows))),!can('operator'),'مجال الطلب');
    const priority=setSelect(PRIORITY,r.priority,v=>patch(`/service-requests/${r.id}`,{priority:v}).then(load).catch(e=>ctx.root.append(errorBox(e,loadRows))),!can('operator'),'الأولوية');
    return h('article',{class:`card need-card priority-${r.priority}`},
      h('div',{class:'row'},h('div',{class:'grow'},h('h3',null,r.service_type||r.intent||'طلب خدمة'),h('div',{class:'meta'},badge(r.category,r.category_corrected?'warn':'info'),badge(CLASSIFICATION[r.classification_method]||CLASSIFICATION.rules,r.classification_method==='ai'?'ok':''),r.subcategory&&badge(r.subcategory),badge(`أولوية ${({critical:'حرجة',high:'عالية',medium:'متوسطة',low:'منخفضة'})[r.priority]||'غير محددة'}`,r.priority==='critical'||r.priority==='high'?'warn':''),r.ai_confidence==null?badge('ثقة AI غير متاحة',''):badge(`ثقة AI ${Math.round(Number(r.ai_confidence))}%`,'ok'),r.category_corrected&&badge('تصنيف مصحح','ok'))),h('span',{class:'num xs muted'},`${fmt.date(r.sent_at)} ${fmt.time(r.sent_at)}`)),
      r.summary&&h('p',{class:'need-summary'},r.summary),h('blockquote',{class:'need-message',dir:'auto'},r.text),
      h('div',{class:'meta'},h('b',null,r.source_title||'مجموعة غير معروفة'),' · ',r.account_name||'حساب Telegram',' · ',r.sender_username?`@${r.sender_username}`:(r.sender_name||'مرسل غير معروف')),
      h('div',{class:'row need-actions'},h('label',{class:'need-control'},'الحالة',status),h('label',{class:'need-control'},'المجال',category),h('label',{class:'need-control'},'الأولوية',priority),
        btn(r.is_favorite?'إزالة من المفضلة':'حفظ للمفضلة',()=>patch(`/service-requests/${r.id}`,{favorite:!r.is_favorite}).then(load).catch(e=>ctx.root.append(errorBox(e,loadRows))),{sm:true,kind:r.is_favorite?'on':''}),
        btn('التفاصيل / الملاحظات',()=>openDetails(r.id),{sm:true,ic:'file'}),
        r.archived_at?btn('استعادة',()=>action(r.id,'restore'),{sm:true}):btn('أرشفة',()=>action(r.id,'archive'),{sm:true}),
        r.excluded_at?btn('إلغاء الاستبعاد',()=>action(r.id,'unexclude'),{sm:true}):btn('استبعاد',()=>action(r.id,'exclude',{reason:'استبعاد يدوي من لوحة الاحتياجات'}),{sm:true}),
        r.links?.message&&h('a',{class:'btn sm',href:r.links.message,target:'_blank',rel:'noopener'},'فتح في Telegram'),h('a',{class:'btn sm ghost',href:`#/feed?q=${encodeURIComponent(r.text||'')}`},'عرض المطابقة')));
  };
  const openDetails=async id=>{
    try{
      const [{data:d},{data:users}]=await Promise.all([get(`/service-requests/${id}`),can('operator')?get('/service-requests/assignees'):{data:[]}]);
      const type=h('input',{value:d.service_type||'',placeholder:'نوع الخدمة'}),sub=h('input',{value:d.subcategory||'',placeholder:'التصنيف الفرعي'}),summary=h('textarea',{rows:3,placeholder:'وصف مختصر'},d.summary||'');
      const assignee=setSelect([['','غير معيّن'],...users.map(u=>[String(u.id),u.display_name||u.username])],d.assigned_to?String(d.assigned_to):'',()=>{},!can('operator'),'المسؤول');
      const addNote=h('textarea',{rows:2,placeholder:'إضافة ملاحظة متابعة…'});
      const notes=h('div',{class:'stack tight'},d.notes.length?d.notes.map(n=>h('div',{class:'need-note'},h('p',null,n.note),h('small',{class:'muted'},`${n.display_name||n.username||'مستخدم'} · ${fmt.dt(n.created_at)}`))):h('p',{class:'muted'},'لا توجد ملاحظات بعد.'));
      const events=h('div',{class:'stack tight'},d.events.length?d.events.map(e=>h('div',{class:'need-event'},h('b',null,e.event_type),h('small',{class:'muted'},` · ${e.display_name||e.username||'مستخدم'} · ${fmt.dt(e.created_at)}`))):h('p',{class:'muted'},'لا يوجد سجل تغييرات بعد.'));
      const body=h('div',{class:'stack'},h('p',{class:'need-message',dir:'auto'},d.text),h('div',{class:'grid g2'},h('div',null,h('b',null,'المجال: '),d.category),h('div',null,h('b',null,'مصدر التصنيف: '),CLASSIFICATION[d.classification_method]||CLASSIFICATION.rules),h('div',null,h('b',null,'التصنيف الفرعي: '),d.subcategory||'—'),h('div',null,h('b',null,'المصدر: '),d.source_title||'—'),h('div',null,h('b',null,'الحساب: '),d.account_name||'—'),h('div',null,h('b',null,'الثقة: '),d.ai_confidence==null?'غير متاحة':`${d.ai_confidence}%`),h('div',null,h('b',null,'رابط Telegram: '),d.links?.message?h('a',{href:d.links.message,target:'_blank',rel:'noopener'},'فتح الرسالة'):'—')),
        can('operator')&&h('div',{class:'grid g2'},h('label',{class:'field'},'نوع الخدمة',type),h('label',{class:'field'},'التصنيف الفرعي',sub),h('label',{class:'field'},'المسؤول',assignee),h('label',{class:'field'},'الوصف',summary)),
        h('div',{class:'row'},h('h3',null,'الملاحظات'),can('operator')&&btn('إضافة ملاحظة',async()=>{try{await post(`/service-requests/${id}/notes`,{note:addNote.value});m.close();await openDetails(id);toast('تمت إضافة الملاحظة.');}catch(e){toast(e.message,'error');}},{sm:true})),can('operator')&&addNote,notes,
        h('h3',null,'سجل الأحداث'),events,d.clusters.length&&h('div',null,h('h3',null,'مجموعة تشابه'),d.clusters.map(c=>badge(c.name,'info'))));
      const m=modal({title:`تفاصيل الطلب #${id}`,body,size:'wide',footer:[h('button',{class:'btn',onClick:()=>m.close()},'إغلاق'),can('operator')&&h('button',{class:'btn primary',onClick:async()=>{try{await patch(`/service-requests/${id}`,{service_type:type.value||null,subcategory:sub.value||null,summary:summary.value||null,assigned_to:assignee.value?Number(assignee.value):null});m.close();toast('تم حفظ تفاصيل الطلب.');await load();}catch(e){toast(e.message,'error');}}},'حفظ التفاصيل')]});
    }catch(e){toast(e.message,'error');}
  };
  const showSuggestions=async()=>{try{const {data,note}=await get('/service-requests/clusters/suggestions');const body=h('div',{class:'stack'},h('p',{class:'muted'},note||'اقتراحات لغوية فقط، دون دمج أو حذف.'),data.length?data.map((g,i)=>h('article',{class:'card'},h('div',{class:'row'},h('b',null,`${g.category} · ${g.request_ids.length} طلبات`),can('operator')&&btn('اعتماد كمجموعة',async()=>{const name=prompt('اسم المجموعة');if(!name)return;try{await post('/service-requests/clusters',{name,category:g.category,description:'اقتراح تشابه لغوي يحتاج مراجعة',request_ids:g.request_ids});toast('تم إنشاء المجموعة دون دمج الطلبات.');m.close();await loadClusters();}catch(e){toast(e.message,'error');}},{sm:true})),g.items.map(x=>h('div',{class:'need-event'},`#${x.id} · ${x.service_type||''} · ${x.summary||x.text}`)))):emptyState('لا توجد مجموعات مرشحة الآن.','search'));
      const m=modal({title:'اقتراحات تشابه الطلبات',body,size:'wide'});
      clear(m.body).append(body);
    }catch(e){toast(e.message,'error');}};
  const loadClusters=async()=>{try{const {data}=await get('/service-requests/clusters',{limit:100});const cards=data.map(c=>h('article',{class:'card'},h('div',{class:'row'},h('div',{class:'grow'},h('b',null,c.name),h('div',{class:'muted xs'},`${c.category||'غير مصنف'} · ${c.request_count} طلبات`)),can('operator')&&btn('حذف المجموعة فقط',async()=>{try{await del(`/service-requests/clusters/${c.id}`);await loadClusters();}catch(e){toast(e.message,'error');}},{sm:true}))));clear(clustersHost).append(cards.length?cards:emptyState('لا توجد مجموعات محفوظة.','layers'));}catch(e){clear(clustersHost).append(errorBox(e,loadClusters));}};
  ctx.root.append(pageHead('احتياجات الخدمات','طلبات ومساعدات من المطابقات المؤهلة في مصادر Telegram المصرّح بها.',btn('تحديث',load,{ic:'refresh'}),btn('اقتراح أنماط متشابهة',showSuggestions,{ic:'layers'}),btn('إعدادات القسم',()=>ctx.go('/needs-settings'),{ic:'settings'})),statsBox,
    card('البحث والفلاتر',filters,exportMenu('/export/service-requests',getFilters())),card('إدارة المجالات',h('p',{class:'muted'},'عند تفعيل مزود AI صالح تُستخدم فئة النموذج ضمن المجالات المفعّلة؛ عند غيابه يعمل تصنيف احتياطي من القواعد والنص، ويُعرض مصدر التصنيف لكل طلب.'),categoriesHost),
    card('مجموعات التشابه',clustersHost,btn('تحديث المجموعات',loadClusters,{sm:true,ic:'refresh'})),h('div',{class:'needs-list'},rows),pager);
  await load();await loadClusters();ctx.onLeave(ws.on('match.new',()=>{clearTimeout(timer);timer=setTimeout(()=>load(),700);}));ctx.onLeave(()=>clearTimeout(timer));
}
