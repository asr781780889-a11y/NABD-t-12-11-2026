-- Persistent service-needs workflow built on top of existing, permissioned Telegram matches.
CREATE TABLE service_categories (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  color text NOT NULL DEFAULT 'blue',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO service_categories (name, color) VALUES
  ('خدمات طلابية وجامعية','blue'), ('تقنية وتكنولوجيا','purple'), ('تصميم وإبداع','pink'),
  ('تجارية وعملية','green'), ('مساعدة واستفسارات عامة','amber'), ('غير مصنف','slate')
ON CONFLICT (name) DO NOTHING;
CREATE TABLE service_requests (
  id bigserial PRIMARY KEY,
  match_id bigint NOT NULL UNIQUE REFERENCES message_matches(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'غير مصنف',
  service_type text,
  summary text,
  request_status text NOT NULL DEFAULT 'new' CHECK (request_status IN ('new','reviewing','identified','responded','completed','irrelevant','duplicate')),
  category_corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_requests_created_idx ON service_requests (created_at DESC);
CREATE INDEX service_requests_status_idx ON service_requests (request_status, created_at DESC);
CREATE INDEX service_requests_category_idx ON service_requests (category, created_at DESC);
CREATE TABLE service_request_feedback (
  id bigserial PRIMARY KEY,
  service_request_id bigint NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  previous_category text NOT NULL,
  corrected_category text NOT NULL,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_request_feedback_created_idx ON service_request_feedback (created_at DESC);
CREATE OR REPLACE FUNCTION nabd_service_category(p_intent text, p_rule text, p_keyword text, p_text text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text := lower(concat_ws(' ', p_intent, p_rule, p_keyword, p_text));
BEGIN
  IF v ~ '(جامع|طالب|دراس|واجب|بحث|تخرج|مادة|منح|ielts|toefl|excel|spss|power.?bi)' THEN RETURN 'خدمات طلابية وجامعية'; END IF;
  IF v ~ '(برمج|موقع|تطبيق|تقني|سيرفر|استضاف|قاعدة بيانات|شبك|بوت|ذكاء اصطناعي|dashboard|ui.?ux)' THEN RETURN 'تقنية وتكنولوجيا'; END IF;
  IF v ~ '(تصميم|شعار|اعلان|هوية بصرية|جرافيك|صورة|powerpoint)' THEN RETURN 'تصميم وإبداع'; END IF;
  IF v ~ '(تسويق|محاسب|تجاري|مورد|بيع|شراء|ترجمة|كتابة|موظف|عمل حر)' THEN RETURN 'تجارية وعملية'; END IF;
  IF nullif(concat_ws('', p_intent, p_rule, p_keyword), '') IS NOT NULL THEN RETURN 'مساعدة واستفسارات عامة'; END IF;
  RETURN 'غير مصنف';
END $$;
-- Keep the service board focused: a domain/rule match alone is not a service request.
CREATE OR REPLACE FUNCTION nabd_is_service_need(p_text text, p_intent text, p_rule text, p_keyword text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text := lower(concat_ws(' ', p_text, p_intent, p_rule, p_keyword));
BEGIN
  RETURN v ~ '(احتاج|أحتاج|محتاج|محتاجه|نحتاج|نبي|ابغى|أبغى|ابي|أبي|أبحث|ابحث|أدور|ادور|من يعرف|من عنده|في احد|في أحد|أحد يساعد|احد يساعد|ساعدوني|ممكن احد|ممكن أحد|عندي مشكلة|أواجه مشكلة|يبحث عن|أبحث عن|looking for|need help|i need|anyone know|anyone can|seeking|need a|want a|hire a|recommend (me|someone)|help me)'
    AND v ~ '(خدم|مساعد|شخص|متخصص|مدرس|معلم|مبرمج|مصمم|حل|مشكلة|مشروع|واجب|بحث|تخرج|شرح|ترجمة|كتابة|تصميم|شعار|موقع|تطبيق|برمج|استضاف|سيرفر|بوت|محاسب|تسويق|وظيف|مورد|بيانات|اكسل|excel|spss|power.?bi|ielts|toefl|service|developer|designer|tutor|programmer|website|app|software|accountant|translator|consultant|support|project|assignment)';
END $$;
CREATE OR REPLACE FUNCTION nabd_sync_service_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_rule text; v_category text;
BEGIN
  SELECT name INTO v_rule FROM ai_rules WHERE id = NEW.ai_rule_id;
  SELECT nabd_service_category(NEW.intent, v_rule, NEW.keyword_text, m.text) INTO v_category FROM messages m
    WHERE m.id = NEW.message_id AND nabd_is_service_need(m.text, NEW.intent, v_rule, NEW.keyword_text);
  INSERT INTO service_requests (match_id, category, service_type, summary)
    SELECT NEW.id, v_category, COALESCE(NULLIF(NEW.intent,''), NULLIF(NEW.keyword_text,''), NULLIF(v_rule,'')), NULLIF(NEW.ai_reason,'')
    WHERE v_category IS NOT NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.message_id AND m.deleted_at IS NULL)
  ON CONFLICT (match_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER message_matches_service_request AFTER INSERT ON message_matches FOR EACH ROW EXECUTE FUNCTION nabd_sync_service_request();
-- Existing detected matches become visible too; this is real application data, not fixtures.
INSERT INTO service_requests (match_id, category, service_type, summary, request_status)
SELECT mm.id, nabd_service_category(mm.intent, ar.name, mm.keyword_text, m.text),
       COALESCE(NULLIF(mm.intent,''), NULLIF(mm.keyword_text,''), NULLIF(ar.name,'')), NULLIF(mm.ai_reason,''),
       CASE mm.status WHEN 'ignored' THEN 'irrelevant' WHEN 'seen' THEN 'reviewing' ELSE 'new' END
FROM message_matches mm JOIN messages m ON m.id = mm.message_id LEFT JOIN ai_rules ar ON ar.id = mm.ai_rule_id
WHERE mm.deleted_at IS NULL AND m.deleted_at IS NULL AND nabd_is_service_need(m.text, mm.intent, ar.name, mm.keyword_text)
ON CONFLICT (match_id) DO NOTHING;
