-- Preserve migration 007 and correct AI classification when the winning card is a standalone keyword match.
-- In that case message_matches.ai_rule_id is NULL, while one or more NABD Needs AI results may still
-- carry a valid service category for the same message. Prefer the selected radar when present; otherwise
-- use the highest-confidence positive AI classification from this message.
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
    WHERE message_id=NEW.message_id AND is_match=true AND NULLIF(btrim(category),'') IS NOT NULL
      AND (ai_rule_id=NEW.ai_rule_id OR NEW.ai_rule_id IS NULL)
    ORDER BY CASE WHEN ai_rule_id=NEW.ai_rule_id THEN 0 ELSE 1 END, confidence DESC NULLS LAST, ai_rule_id
    LIMIT 1;
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
