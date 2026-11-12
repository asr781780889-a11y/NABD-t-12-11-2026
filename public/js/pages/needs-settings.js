import { h, clear } from '../lib/dom.js';
import { get, put } from '../lib/api.js';
import { pageHead, card, form, btn, toast, errorBox, can } from '../lib/ui.js';

export default async function needsSettings(ctx) {
  const host=h('div',{class:'stack'});
  ctx.root.append(pageHead('إعدادات احتياجات الخدمات','إعدادات الالتقاط تُطبّق على المطابقات الجديدة فقط. لا تُعدّل رسائل Telegram ولا إعدادات مزود الذكاء الاصطناعي.',h('a',{class:'btn',href:'#/needs'},'العودة إلى الاحتياجات'),h('a',{class:'btn',href:'#/ai'},'إعدادات مزود AI')) ,host);
  if(!can('admin')) { host.append(h('p',{class:'muted'},'هذه الإعدادات متاحة للمدير فقط.'));return; }
  async function load(){
    clear(host).append(h('div',{class:'skeleton'}));
    try{
      const [settings,accounts,sources]=await Promise.all([get('/settings'),get('/accounts',{limit:200}),get('/sources',{limit:200})]);
      const reg=settings.data;const values={
        enabled:reg['service_requests.enabled']?.value??true,
        min_confidence:reg['service_requests.min_confidence']?.value??0,
        sensitivity:reg['service_requests.sensitivity']?.value??'balanced',
        account_ids:(reg['service_requests.account_ids']?.value??[]).map(String),
        source_ids:(reg['service_requests.source_ids']?.value??[]).map(String),
      };
      const fields=[
        {key:'enabled',label:'التقاط الطلبات الجديدة تلقائيًا من المطابقات المؤهلة',type:'toggle',hint:'إيقاف هذا الخيار يوقف إنشاء طلبات جديدة، ولا يحذف السجلات الموجودة.'},
        {key:'min_confidence',label:'الحد الأدنى لثقة AI (0–100)',type:'number',min:0,max:100,value:values.min_confidence,hint:'يستبعد النتائج ذات الثقة المعروفة الأقل من الحد. النتائج التي لا تملك درجة AI تبقى مؤهلة.'},
        {key:'sensitivity',label:'حساسية الكشف',type:'select',value:values.sensitivity,options:[{value:'strict',label:'دقيق — درجة مطابقة 85 فأعلى'},{value:'balanced',label:'متوازن — 70 فأعلى'},{value:'high_recall',label:'استدعاء أعلى — 50 فأعلى'}]},
        {key:'account_ids',label:'نطاق حسابات Telegram',type:'checks',options:accounts.data.map(a=>({value:String(a.id),label:`${a.name||a.phone_masked||`الحساب ${a.id}`} · ${a.status}`})),hint:'اترك كل الخيارات دون تحديد لتطبيق الإعداد على جميع الحسابات.'},
        {key:'source_ids',label:'نطاق المجموعات والقنوات',type:'checks',options:sources.data.map(s=>({value:String(s.id),label:`${s.title||s.tg_chat_id} · ${s.account_name||'حساب'}`})),hint:'اترك كل الخيارات دون تحديد لتطبيق الإعداد على جميع المصادر. يظل احترام إعداد المراقبة الحالي كما هو.'},
      ];
      const f=form(fields,values);
      const save=btn('حفظ إعدادات الالتقاط',async()=>{
        const v=f.get();const ids=(a)=>a.map(Number).filter(Number.isSafeInteger);
        try{
          await put('/settings',{values:{
            'service_requests.enabled':v.enabled,
            'service_requests.min_confidence':Number(v.min_confidence??0),
            'service_requests.sensitivity':v.sensitivity,
            'service_requests.account_ids':ids(v.account_ids),
            'service_requests.source_ids':ids(v.source_ids),
          }});
          toast('تم حفظ إعدادات احتياجات الخدمات.');
        }catch(e){host.append(errorBox(e,load));}
      },{kind:'primary',ic:'save'});
      clear(host).append(
        card('نطاق الالتقاط',h('div',{class:'stack'},h('p',{class:'muted'},'الإعدادات التالية تعمل على الرسائل التي اجتازت بالفعل محرك المصادر/الرادار والمطابقة. لا يتم استيراد محادثات جديدة بسبب حفظ هذه الخيارات.'),f.el,save)),
        card('المحرك والإعدادات المرتبطة',h('div',{class:'row'},h('a',{class:'btn',href:'#/ai'},'إعدادات مزود AI'),h('a',{class:'btn',href:'#/radar'},'قواعد Radar'),h('a',{class:'btn',href:'#/settings?tab=notifications'},'الإشعارات'),h('a',{class:'btn',href:'#/settings?tab=workers'},'معالجة الرسائل'),h('a',{class:'btn',href:'#/needs'},'إدارة المجالات والتصنيفات'))),
        card('التكرار وسلامة المصدر',h('p',{class:'muted'},'كل سجل احتياج مرتبط بمعرّف مطابقة فريد (UNIQUE)؛ وإدخال Telegram ومطابقات الرسائل idempotent. لا تُدمج الطلبات في التجميع التحليلي ولا تُحذف الرسائل الأصلية.')),
        card('حسابات AI',h('div',{class:'stack'},h('p',null,'مفتاح المزود لا يُطلب هنا ولا يُعرض؛ تُدار المفاتيح مشفّرة في صفحة إعدادات AI الحالية.'),h('a',{class:'btn',href:'#/ai'},'فتح صفحة إعدادات AI'))),
      );
    }catch(e){clear(host).append(errorBox(e,load));}
  }
  await load();
}
