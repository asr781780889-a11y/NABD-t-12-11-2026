-- Extend Smart Needs Detection without rewriting the already-applied 006 migration.
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS subcategory text,
  ADD COLUMN IF NOT EXISTS priority_override text CHECK (priority_override IS NULL OR priority_override IN ('low','medium','high','critical')),
  ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_to bigint REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by bigint REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS excluded_at timestamptz,
  ADD COLUMN IF NOT EXISTS excluded_by bigint REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exclusion_reason text,
  ADD COLUMN IF NOT EXISTS classification_method text NOT NULL DEFAULT 'rules';

ALTER TABLE service_requests DROP CONSTRAINT IF EXISTS service_requests_classification_method_check;
ALTER TABLE service_requests ADD CONSTRAINT service_requests_classification_method_check
  CHECK (classification_method IN ('ai','rules','manual'));

ALTER TABLE service_requests DROP CONSTRAINT IF EXISTS service_requests_request_status_check;
ALTER TABLE service_requests ADD CONSTRAINT service_requests_request_status_check
  CHECK (request_status IN ('new','reviewing','identified','qualified','contacting','responded','in_progress','completed','cancelled','irrelevant','duplicate'));

INSERT INTO service_categories (name, color) VALUES ('ترجمة ولغات','cyan') ON CONFLICT (name) DO NOTHING;

-- Curated bilingual service-needs Radar templates. These are drafts only; an operator must review and activate them.
INSERT INTO ai_rules(name,description,intent,intent_description,signals,negative_signals,min_score,ai_mode,context_mode,status)
SELECT s.name,s.description,s.intent,s.intent_description,s.signals,s.negative_signals,70,'always','none','draft'
FROM (VALUES
  ('NABD Needs | تعليم وطلاب','مسودة مراجعة متعددة اللهجات لطلبات الدروس والواجبات والبحث الأكاديمي. لا تُفعّل قبل تجربة مصدر مصرح.','مساعدة تعليمية وطلابية','طلب طالب مساعدة تعليمية أو تدريسية، لا إعلان مدرس عن خدماته.',ARRAY['أحتاج مدرس','ابي مدرس','ابغى شرح','محتاج مساعدة في الواجب','أبحث عن مدرس خصوصي','مين يشرح لي','ممكن أحد يساعدني في المادة','need a tutor','looking for a tutor','help with my assignment','need help studying'],ARRAY['أقدم دروس','مدرس خصوصي متاح','نقدم خدمات تعليمية','my tutoring services','tutoring available']),
  ('NABD Needs | التقنية والبرمجة','مسودة مراجعة لطلبات تطوير البرامج والمواقع والدعم التقني بالعربية والإنجليزية.','طلب خدمة تقنية','طلب عميل مبرمجًا أو دعمًا تقنيًا، لا عرض مقدم خدمة.',ARRAY['أحتاج مبرمج','أبحث عن مبرمج','محتاج مطور تطبيق','أحتاج إنشاء موقع','عندي مشكلة في التطبيق','من يستطيع برمجة','هل يعرف أحد مبرمج','من يعرف مطور','أحد يعرف مبرمج','مين يقدر يبني','ممكن ترشيح مطور','need a developer','looking for a programmer','need an app built','need technical support','can someone build a website','anyone know a developer','recommend a programmer'],ARRAY['أقدم خدمات برمجة','نطور مواقع وتطبيقات','خدماتنا التقنية','we offer software development','my programming services','developer for hire']),
  ('NABD Needs | التصميم والإبداع','مسودة مراجعة لطلبات تصميم الشعارات والهوية والمحتوى البصري.','طلب تصميم','طلب تصميم مخصص من عميل، لا معرض أعمال أو إعلان مصمم.',ARRAY['أحتاج مصمم','أبحث عن مصمم شعار','محتاج تصميم هوية','من يصمم لي إعلان','احتاج تصميم بوستر','need a logo designer','looking for a graphic designer','need a brand identity','can someone design a poster'],ARRAY['أقدم خدمات التصميم','مصمم متاح للعمل','أعمالي في التصميم','my design services','graphic designer portfolio','design packages available']),
  ('NABD Needs | الترجمة واللغات','مسودة مراجعة لطلبات الترجمة والتدقيق والتعليم اللغوي.','طلب ترجمة أو لغة','طلب ترجمة أو تدقيق أو مدرس لغة، لا إعلان مقدم الخدمة.',ARRAY['أحتاج ترجمة','أبحث عن مترجم','محتاج تدقيق لغوي','من يترجم لي','أحتاج مدرس لغة إنجليزية','need a translator','looking for an Arabic translator','need proofreading','looking for an English tutor'],ARRAY['أقدم خدمات الترجمة','مترجم معتمد متاح','نقدم خدمات لغوية','my translation services','translation services available','translator portfolio']),
  ('NABD Needs | مساعدة وخدمات عامة','مسودة مراجعة لطلبات المساعدة المهنية والخدمات غير المصنفة ضمن التخصصات الأخرى.','طلب مساعدة أو خدمة عامة','طلب مباشر أو غير مباشر لمساعدة قابلة للتقديم، لا تحية أو عرض خدمات.',ARRAY['من يعرف شخص يساعدني','من يعرف فني','ممكن أحد يفيدني','أحتاج فني','أبحث عن مختص','هل يوجد من يساعد في','عندي استفسار يحتاج خبير','can anyone help me with','looking for a professional','need someone to help','does anyone know a good'],ARRAY['أقدم خدماتي','لدينا عروض خدمات','متوفر لدينا','we offer services','our services include','contact us for services'])
) AS s(name,description,intent,intent_description,signals,negative_signals)
WHERE NOT EXISTS (SELECT 1 FROM ai_rules r WHERE r.name=s.name AND r.deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS service_requests_assignee_idx ON service_requests (assigned_to, updated_at DESC);
CREATE INDEX IF NOT EXISTS service_requests_active_idx ON service_requests (archived_at, excluded_at, created_at DESC);
CREATE INDEX IF NOT EXISTS service_requests_favorite_idx ON service_requests (is_favorite, updated_at DESC) WHERE is_favorite;
CREATE INDEX IF NOT EXISTS service_requests_subcategory_idx ON service_requests (subcategory, created_at DESC);

CREATE TABLE service_request_notes (
  id bigserial PRIMARY KEY,
  service_request_id bigint NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 4000),
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_request_notes_request_idx ON service_request_notes (service_request_id, created_at DESC, id DESC);

CREATE TABLE service_request_events (
  id bigserial PRIMARY KEY,
  service_request_id bigint NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_value jsonb,
  to_value jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_request_events_request_idx ON service_request_events (service_request_id, created_at DESC, id DESC);

CREATE TABLE service_request_clusters (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  category text,
  description text,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_request_cluster_members (
  cluster_id bigint NOT NULL REFERENCES service_request_clusters(id) ON DELETE CASCADE,
  service_request_id bigint NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, service_request_id),
  UNIQUE (service_request_id)
);
CREATE INDEX service_request_cluster_members_request_idx ON service_request_cluster_members (service_request_id);

-- Improve deterministic request detection while keeping ordinary chat and service offers out.
CREATE OR REPLACE FUNCTION nabd_is_service_need(p_text text, p_intent text, p_rule text, p_keyword text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text := lower(concat_ws(' ', p_text, p_intent, p_rule, p_keyword));
BEGIN
  IF v ~ '(أقدم خدمات|اقدم خدمات|أوفر خدمات|اوفر خدمات|خدماتي|we offer services|i offer services|offering services|my services)' THEN RETURN false; END IF;
  RETURN v ~ '(احتاج|أحتاج|محتاج|محتاجه|نحتاج|نبي|ابغى|أبغى|ابي|أبي|أبحث|ابحث|أدور|ادور|من يعرف|هل يعرف أحد|هل يعرف احد|من عنده|في احد|في أحد|أحد يساعد|احد يساعد|ساعدوني|ممكن احد|ممكن أحد|هل يوجد|يوجد شخص|يوجد أحد|من يقدر|مين يقدر|تعبت.*ابحث|يبحث عن|أبحث عن|looking for|need help|i need|anyone know|anyone can|can someone|is anyone|seeking|need a|want a|hire a|recommend (me|someone))'
    AND v ~ '(خدم|مساعد|شخص|متخصص|فني|خبير|مدرس|معلم|مبرمج|مصمم|حل|مشكلة|مشروع|واجب|بحث|تخرج|شرح|ترجمة|تعليم|لغة|انجليزي|إنجليزي|تصميم|شعار|موقع|تطبيق|برمج|اندرويد|android|استضاف|سيرفر|بوت|محاسب|تسويق|وظيف|مورد|بيانات|اكسل|excel|spss|power.?bi|ielts|toefl|service|developer|designer|tutor|programmer|website|app|software|accountant|translator|consultant|support|project|assignment|programming|data analysis|mechanic|repair)';
END $$;

CREATE OR REPLACE FUNCTION nabd_service_category(p_intent text, p_rule text, p_keyword text, p_text text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text := lower(concat_ws(' ', p_intent, p_rule, p_keyword, p_text));
BEGIN
  IF v ~ '(ترجم|ترجمة|لغات|لغة|انجليزي|إنجليزي|english|ielts|toefl|لغة انجليزية|تعلم اللغة)' THEN RETURN 'ترجمة ولغات'; END IF;
  IF v ~ '(جامع|طالب|طلاب|مدرس|معلم|تعليم|دراس|واجب|مشروع تخرج|بحث جامعي|بحث علمي|بحث تخرج|مادة|منح|power.?bi|excel|spss|student|tutor|teacher|homework|scholarship)' THEN RETURN 'خدمات طلابية وجامعية'; END IF;
  IF v ~ '(برمج|موقع|تطبيق|تقني|سيرفر|استضاف|قاعدة بيانات|شبك|بوت|ذكاء اصطناعي|dashboard|ui.?ux|اندرويد|android)' THEN RETURN 'تقنية وتكنولوجيا'; END IF;
  IF v ~ '(تصميم|شعار|اعلان|هوية بصرية|جرافيك|صورة|powerpoint)' THEN RETURN 'تصميم وإبداع'; END IF;
  IF v ~ '(تسويق|محاسب|تجاري|مورد|بيع|شراء|كتابة|موظف|عمل حر)' THEN RETURN 'تجارية وعملية'; END IF;
  IF nullif(concat_ws('', p_intent, p_rule, p_keyword), '') IS NOT NULL THEN RETURN 'مساعدة واستفسارات عامة'; END IF;
  RETURN 'غير مصنف';
END $$;

-- Make capture controls in the Service Needs settings page effective for future matches.
CREATE OR REPLACE FUNCTION nabd_sync_service_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_rule text;
  v_category text;
  v_ai_category text;
  v_ai_entities jsonb := '[]'::jsonb;
  v_service_type text;
  v_subcategory text;
  v_summary text;
  v_method text := 'rules';
  v_text text;
  v_account bigint;
  v_source bigint;
  v_enabled boolean := true;
  v_min_confidence integer := 0;
  v_sensitivity text := 'balanced';
  v_accounts jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
BEGIN
  SELECT COALESCE((value #>> '{}')::boolean, true) INTO v_enabled FROM settings WHERE key='service_requests.enabled';
  IF NOT COALESCE(v_enabled, true) THEN RETURN NEW; END IF;
  SELECT COALESCE((value #>> '{}')::integer, 0) INTO v_min_confidence FROM settings WHERE key='service_requests.min_confidence';
  SELECT COALESCE(value #>> '{}', 'balanced') INTO v_sensitivity FROM settings WHERE key='service_requests.sensitivity';
  SELECT COALESCE(value, '[]'::jsonb) INTO v_accounts FROM settings WHERE key='service_requests.account_ids';
  SELECT COALESCE(value, '[]'::jsonb) INTO v_sources FROM settings WHERE key='service_requests.source_ids';
  SELECT m.text,m.account_id,m.source_id INTO v_text,v_account,v_source FROM messages m WHERE m.id=NEW.message_id AND m.deleted_at IS NULL;
  IF v_text IS NULL THEN RETURN NEW; END IF;
  IF NEW.ai_confidence IS NOT NULL AND NEW.ai_confidence < COALESCE(v_min_confidence,0) THEN RETURN NEW; END IF;
  IF (v_sensitivity='strict' AND NEW.score<85) OR (v_sensitivity='balanced' AND NEW.score<70) OR (v_sensitivity='high_recall' AND NEW.score<50) THEN RETURN NEW; END IF;
  IF jsonb_typeof(v_accounts)='array' AND jsonb_array_length(v_accounts)>0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_accounts) AS ids(value) WHERE ids.value=v_account::text) THEN RETURN NEW; END IF;
  IF jsonb_typeof(v_sources)='array' AND jsonb_array_length(v_sources)>0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_sources) AS ids(value) WHERE ids.value=v_source::text) THEN RETURN NEW; END IF;
  SELECT name INTO v_rule FROM ai_rules WHERE id=NEW.ai_rule_id;
  IF NOT nabd_is_service_need(v_text,NEW.intent,v_rule,NEW.keyword_text) THEN RETURN NEW; END IF;
  SELECT category,entities INTO v_ai_category,v_ai_entities FROM ai_results
    WHERE message_id=NEW.message_id AND ai_rule_id=NEW.ai_rule_id AND is_match=true;
  SELECT name INTO v_category FROM service_categories
    WHERE enabled=true AND lower(name)=lower(btrim(COALESCE(v_ai_category,'')));
  IF v_category IS NOT NULL THEN v_method := 'ai';
  ELSE v_category := nabd_service_category(NEW.intent,v_rule,NEW.keyword_text,v_text);
  END IF;
  SELECT NULLIF(btrim(e.value->>'value'),'') INTO v_service_type FROM jsonb_array_elements(v_ai_entities) AS e(value) WHERE e.value->>'type'='service_type' LIMIT 1;
  SELECT NULLIF(btrim(e.value->>'value'),'') INTO v_subcategory FROM jsonb_array_elements(v_ai_entities) AS e(value) WHERE e.value->>'type'='subcategory' LIMIT 1;
  SELECT NULLIF(btrim(e.value->>'value'),'') INTO v_summary FROM jsonb_array_elements(v_ai_entities) AS e(value) WHERE e.value->>'type'='summary' LIMIT 1;
  INSERT INTO service_requests(match_id,category,service_type,summary,subcategory,classification_method)
  VALUES(NEW.id,v_category,COALESCE(v_service_type,NULLIF(NEW.intent,''),NULLIF(NEW.keyword_text,''),NULLIF(v_rule,'')),COALESCE(v_summary,NULLIF(NEW.ai_reason,'')),v_subcategory,v_method)
  ON CONFLICT(match_id) DO NOTHING;
  RETURN NEW;
END $$;
