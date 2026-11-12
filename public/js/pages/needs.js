import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, patch } from '../lib/api.js';
import { pageHead, kpi, card, btn, badge, emptyState, errorBox, can, toast } from '../lib/ui.js';
import * as ws from '../lib/ws.js';

const STATUS = [
  ['new','جديد'],['reviewing','قيد المراجعة'],['identified','تم تحديد الخدمة'],['responded','تمت الاستجابة'],['completed','مكتمل'],['irrelevant','غير مناسب'],['duplicate','مكرر'],
];
export default async function serviceNeeds(ctx) {
  const statsBox=h('div',{class:'grid g4'}), filters=h('div',{class:'filters'}), rows=h('div',{class:'stack'}), categoriesHost=h('div'), pager=h('div');
  const state={q:'',category:'',status:'',priority:'',page:1};let cats=[];let meta=null;let timer;
  const load=async()=>{
    try {
      const [s,c,src]=await Promise.all([get('/service-requests/stats'),get('/service-requests/categories'),get('/sources',{limit:100})]);
      cats=c.data.filter(x=>x.enabled);paintStats(s.data);paintCategories(c.data);drawFilters(src.data);
      await loadRows();
    } catch(e){clear(rows).append(errorBox(e,load));}
  };
  const paintStats=(s)=>clear(statsBox).append(
    kpi({label:'طلبات اليوم',value:fmt.num(s.today),ic:'activity'}),kpi({label:'طلبات الطلاب اليوم',value:fmt.num(s.student_today),ic:'book'}),
    kpi({label:'طلبات التقنية اليوم',value:fmt.num(s.tech_today),ic:'cpu'}),kpi({label:'الطلبات العامة اليوم',value:fmt.num(s.general_today),ic:'help'}),
    kpi({label:'طلبات جديدة',value:fmt.num(s.new_count),ic:'sparkles',tone:'warn'}),kpi({label:'تمت مراجعتها',value:fmt.num(s.reviewed),ic:'check',tone:'ok'}),
    kpi({label:'أولوية عالية',value:fmt.num(s.high_count),ic:'zap',tone:'bad'}),kpi({label:'إجمالي الطلبات',value:fmt.num(s.total),ic:'layers'}));
  const drawFilters=(sources)=>{
    const search=h('input',{type:'search',placeholder:'ابحث في نص الرسالة أو الخدمة أو المجموعة…',value:state.q,onInput:()=>{state.q=search.value;debounceLoad();}});
    const category=h('select',{value:state.category,onChange:()=>{state.category=category.value;state.page=1;loadRows();}},h('option',{value:''},'كل المجالات'),cats.map(x=>h('option',{value:x.name},x.name)));
    const status=h('select',{value:state.status,onChange:()=>{state.status=status.value;state.page=1;loadRows();}},h('option',{value:''},'كل الحالات'),STATUS.map(([v,l])=>h('option',{value:v},l)));
    const priority=h('select',{value:state.priority,onChange:()=>{state.priority=priority.value;state.page=1;loadRows();}},h('option',{value:''},'كل الأولويات'),[['critical','حرجة'],['high','عالية'],['medium','متوسطة'],['low','منخفضة']].map(([v,l])=>h('option',{value:v},l)));
    const source=h('select',{onChange:()=>{state.source_id=source.value;state.page=1;loadRows();}},h('option',{value:''},'كل المجموعات'),sources.map(x=>h('option',{value:x.id},x.title||x.tg_chat_id)));
    const from=h('input',{type:'date',title:'من تاريخ',onChange:()=>{state.from=from.value;state.page=1;loadRows();}}),to=h('input',{type:'date',title:'إلى تاريخ',onChange:()=>{state.to=to.value;state.page=1;loadRows();}});
    const confidence=h('input',{type:'number',min:0,max:100,placeholder:'أدنى ثقة AI %',value:state.min_confidence??'',onInput:()=>{state.min_confidence=confidence.value;debounceLoad();}});
    clear(filters).append(search,category,status,priority,source,from,to,confidence,btn('جديدة فقط',()=>{state.new_only=state.new_only?'':'true';loadRows();},{sm:true,kind:state.new_only?'on':''}),btn('ثقة ≥ 70%',()=>{state.confident=state.confident?'':'true';loadRows();},{sm:true,kind:state.confident?'on':''}));
  };
  const debounceLoad=()=>{clearTimeout(timer);timer=setTimeout(()=>{state.page=1;loadRows();},250);};
  const paintCategories=(items)=>{
    const editor=h('div',{class:'row',style:{flexWrap:'wrap'}});
    for(const item of items) editor.append(h('label',{class:'chip row tight'},h('input',{type:'checkbox',checked:item.enabled,disabled:!can('operator'),onChange:async()=>{try{await patch(`/service-requests/categories/${item.id}`,{enabled:!item.enabled});load();}catch(e){ctx.root.append(errorBox(e,load));}}}),item.name));
    const name=h('input',{placeholder:'إضافة مجال جديد',style:{maxWidth:'220px'}});
    if(can('operator'))editor.append(name,btn('إضافة',async()=>{if(!name.value.trim())return;try{await post('/service-requests/categories',{name:name.value.trim()});load();}catch(e){ctx.root.append(errorBox(e,load));}},{sm:true,ic:'plus'}));
    clear(categoriesHost).append(editor);
  };
  const loadRows=async()=>{
    try{
      const res=await get('/service-requests',{...state,limit:20});meta=res.meta;
      clear(rows);
      if(!res.data.length){rows.append(emptyState('لا توجد طلبات مطابقة للفلاتر. لن تظهر هنا الرسائل العادية غير المكتشفة.','search'));clear(pager);return;}
      for(const r of res.data) rows.append(renderRequest(r));
      clear(pager).append(h('div',{class:'row',style:{justifyContent:'center',marginTop:'10px'}},btn('السابق',()=>{state.page--;loadRows();},{sm:true,disabled:meta.page<=1}),h('span',{class:'muted'},`صفحة ${meta.page} من ${meta.pages} · ${fmt.num(meta.total)} طلب`),btn('التالي',()=>{state.page++;loadRows();},{sm:true,disabled:meta.page>=meta.pages})));
    }catch(e){clear(rows).append(errorBox(e,loadRows));}
  };
  const renderRequest=(r)=>{
    const statusSelect=h('select',{value:r.request_status,disabled:!can('operator'),onChange:async()=>{try{await patch(`/service-requests/${r.id}`,{status:statusSelect.value});r.request_status=statusSelect.value;refreshStats();}catch(e){ctx.root.append(errorBox(e,loadRows));}},'aria-label':'حالة الطلب'},STATUS.map(([v,l])=>h('option',{value:v},l)));
    const categorySelect=h('select',{value:r.category,disabled:!can('operator'),onChange:async()=>{try{await patch(`/service-requests/${r.id}`,{category:categorySelect.value});r.category=categorySelect.value;r.category_corrected=true;categorySelect.title='تم تصحيح التصنيف يدويًا';}catch(e){ctx.root.append(errorBox(e,loadRows));}},'aria-label':'تصنيف الطلب'},cats.map(x=>h('option',{value:x.name},x.name)),!cats.some(x=>x.name===r.category)?h('option',{value:r.category},r.category):null);
    return h('article',{class:`card need-card priority-${r.priority}`},
      h('div',{class:'row'},h('div',{class:'grow'},h('h3',null,r.service_type||r.intent||'طلب خدمة'),h('div',{class:'meta'},badge(r.category,r.category_corrected?'warn':'info'),badge(r.priority==='critical'||r.priority==='high'?'أولوية '+(r.priority==='critical'?'حرجة':'عالية'):'أولوية '+(r.priority==='medium'?'متوسطة':'منخفضة'),r.priority==='critical'||r.priority==='high'?'warn':''),r.ai_confidence==null?badge('ثقة AI غير متاحة',''):badge(`ثقة AI ${Math.round(Number(r.ai_confidence))}%`,'ok'),r.category_corrected&&badge('تصنيف مصحح','ok'))),h('span',{class:'num xs muted'},`${fmt.date(r.sent_at)} ${fmt.time(r.sent_at)}`)),
      r.summary&&h('p',{class:'need-summary'},r.summary),h('blockquote',{class:'need-message',dir:'auto'},r.text),
      h('div',{class:'meta'},h('b',null,r.source_title||'مجموعة غير معروفة'),' · ',r.sender_username?`@${r.sender_username}`:(r.sender_name||'مرسل غير معروف'),' · ',r.account_name||'حساب Telegram'),
      h('div',{class:'row need-actions'},h('label',{class:'need-control'},'الحالة',statusSelect),h('label',{class:'need-control'},'المجال',categorySelect),r.links?.message&&h('a',{class:'btn sm',href:r.links.message,target:'_blank',rel:'noopener'},'فتح في Telegram'),h('a',{class:'btn sm ghost',href:`#/feed?q=${encodeURIComponent(r.text||'')}`},'عرض المطابقة'),can('operator')&&h('button',{class:'btn sm ghost',onClick:async()=>{try{await post(`/matches/${r.match_id}/save`);toast('تم حفظ الطلب ضمن المحفوظات.');}catch(e){ctx.root.append(errorBox(e,loadRows));}}},'حفظ الطلب')));
  };
  const refreshStats=async()=>{try{paintStats((await get('/service-requests/stats')).data);}catch{}};
  ctx.root.append(pageHead('احتياجات الخدمات','طلبات ومساعدات اكتشفها محرك NABD AI من مصادر Telegram المصرّح بها فقط.',btn('تحديث',load,{ic:'refresh'})),statsBox,
    card('البحث والفلاتر',filters),card('إدارة المجالات',h('p',{class:'muted'},'المجالات المفعّلة تظهر في خيارات التصنيف. التصنيف الآلي يعتمد حاليًا على نية الرادار والكلمات وقواعد NABD الحالية.'),categoriesHost),h('div',{class:'needs-list'},rows),pager);
  await load();
  ctx.onLeave(ws.on('match.new',()=>{clearTimeout(timer);timer=setTimeout(()=>{load();},600);}));
  ctx.onLeave(()=>clearTimeout(timer));
}
