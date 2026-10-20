-- Run as an administrator against an isolated database with the migration applied.
-- Fixtures and helper grants roll back, including on disconnect. Identity
-- sequences may advance, as PostgreSQL sequence increments are not transactional.
BEGIN;

CREATE SCHEMA portal_regression;
CREATE TABLE portal_regression.results (name text PRIMARY KEY);
CREATE TABLE portal_regression.fixtures (kind text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO portal_regression.fixtures(kind, id)
SELECT kind, pg_catalog.gen_random_uuid()
FROM (VALUES ('employee'), ('employee2'), ('ambassador'), ('other'), ('former'),
             ('null_metadata'), ('scalar_metadata'), ('null_name'), ('object_name'),
             ('long_name'), ('unicode_name'), ('blank_name'), ('no_email')) AS kinds(kind);

CREATE FUNCTION portal_regression.id(kind text)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT f.id FROM portal_regression.fixtures AS f WHERE f.kind = id.kind;
$$;

CREATE FUNCTION portal_regression.check_true(name text, passed boolean)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF passed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Regression failed: %', name;
  END IF;
  INSERT INTO portal_regression.results VALUES (name);
END;
$$;

CREATE FUNCTION portal_regression.expect_error(name text, command text, expected text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  BEGIN
    EXECUTE command;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> expected THEN
      RAISE EXCEPTION 'Regression failed: %; expected %, received %: %',
        name, expected, SQLSTATE, SQLERRM;
    END IF;
    INSERT INTO portal_regression.results VALUES (name);
    RETURN;
  END;
  RAISE EXCEPTION 'Regression failed: %; expected %, command succeeded', name, expected;
END;
$$;

CREATE FUNCTION portal_regression.claims(kind text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  actor_id uuid := portal_regression.id(kind);
BEGIN
  -- auth.uid() on Supabase and minimal test shims can use either representation.
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', COALESCE(actor_id::text, ''), true);
  PERFORM pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM pg_catalog.set_config('request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', actor_id, 'role', 'authenticated')::text, true);
END;
$$;

GRANT USAGE ON SCHEMA portal_regression TO authenticated, anon, service_role;
GRANT SELECT ON portal_regression.fixtures TO authenticated, anon, service_role;
GRANT INSERT, SELECT ON portal_regression.results TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA portal_regression TO authenticated, anon, service_role;

INSERT INTO auth.users(id, email, raw_user_meta_data)
SELECT f.id,
  CASE WHEN f.kind = 'no_email' THEN NULL ELSE f.id::text || '@example.invalid' END,
  CASE f.kind
    WHEN 'null_metadata' THEN NULL::jsonb
    WHEN 'scalar_metadata' THEN '42'::jsonb
    WHEN 'null_name' THEN '{"name":null,"role":"employee"}'::jsonb
    WHEN 'object_name' THEN '{"name":{},"full_name":"Ignored","role":"employee"}'::jsonb
    WHEN 'long_name' THEN pg_catalog.jsonb_build_object('name', pg_catalog.repeat('x', 10000))
    WHEN 'unicode_name' THEN pg_catalog.jsonb_build_object('name', pg_catalog.repeat('😀', 1000))
    WHEN 'blank_name' THEN pg_catalog.jsonb_build_object('name', U&'\0009\000A\00A0\2000\FEFF')
    WHEN 'no_email' THEN '{"name":null}'::jsonb
    ELSE pg_catalog.jsonb_build_object('name', f.kind, 'role', 'employee')
  END
FROM portal_regression.fixtures AS f;

DO $$
DECLARE
  role_name text;
  table_name text;
  signature text;
BEGIN
  PERFORM portal_regression.check_true('eight seeded catalogue products',
    (SELECT count(*) = 8 FROM public.products
     WHERE id IN ('fjord-pale', 'skog-ipa', 'kveld-pils', 'brew-kettle',
                  'fermenter', 'hop-citra', 'malt', 'glass') AND available));
  PERFORM portal_regression.check_true('metadata never provisions employees',
    (SELECT bool_and(p.role = 'ambassador') FROM public.profiles AS p
     JOIN portal_regression.fixtures AS f ON f.id = p.id));
  PERFORM portal_regression.check_true('all profile fixture names satisfy constraints',
    (SELECT count(*) = 13 AND bool_and(char_length(btrim(p.name)) BETWEEN 1 AND 160)
     FROM public.profiles AS p JOIN portal_regression.fixtures AS f ON f.id = p.id));
  PERFORM portal_regression.check_true('only name metadata supplies display name',
    (SELECT p.name = p.email FROM public.profiles AS p
     WHERE p.id = portal_regression.id('object_name')));
  PERFORM portal_regression.check_true('oversized names are safely truncated',
    (SELECT bool_and(char_length(p.name) = 160) FROM public.profiles AS p
     WHERE p.id IN (portal_regression.id('long_name'), portal_regression.id('unicode_name'))));
  PERFORM portal_regression.check_true('unicode whitespace name falls back to email',
    (SELECT p.name = p.email FROM public.profiles AS p WHERE p.id = portal_regression.id('blank_name')));
  PERFORM portal_regression.check_true('missing email and name have safe defaults',
    (SELECT p.name = 'Ambassadør' AND p.email = '' FROM public.profiles AS p
     WHERE p.id = portal_regression.id('no_email')));

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH table_name IN ARRAY ARRAY['profiles', 'products', 'tickets', 'messages'] LOOP
      PERFORM portal_regression.check_true(role_name || ' cannot directly mutate ' || table_name,
        NOT has_table_privilege(role_name, 'public.' || table_name,
                                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
      PERFORM portal_regression.check_true(role_name || ' read grant on ' || table_name,
        has_table_privilege(role_name, 'public.' || table_name, 'SELECT') = (role_name = 'authenticated'));
    END LOOP;
    PERFORM portal_regression.check_true(role_name || ' cannot use identity sequence',
      NOT has_sequence_privilege(role_name, 'public.tickets_number_seq', 'USAGE,UPDATE,SELECT'));
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'public.portal_workspace()', 'public.portal_create_ticket(jsonb)',
    'public.portal_update_ticket(uuid,jsonb)', 'public.portal_add_message(uuid,jsonb)'
  ] LOOP
    PERFORM portal_regression.check_true('authenticated RPC grant ' || signature,
      has_function_privilege('authenticated', signature, 'EXECUTE'));
    PERFORM portal_regression.check_true('anonymous RPC denial ' || signature,
      NOT has_function_privilege('anon', signature, 'EXECUTE'));
    PERFORM portal_regression.check_true('service role routine RPC denial ' || signature,
      NOT has_function_privilege('service_role', signature, 'EXECUTE'));
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'public.portal_actor()', 'public.portal_sync_profile()', 'public.portal_trim(text)',
    'public.portal_check_fields(jsonb,text[])', 'public.portal_text(jsonb,integer)',
    'public.portal_date(jsonb)', 'public.portal_uuid(jsonb)',
    'public.portal_ticket_json(public.tickets)', 'public.portal_message_json(public.messages)'
  ] LOOP
    PERFORM portal_regression.check_true('internal function is inaccessible ' || signature,
      NOT has_function_privilege('authenticated', signature, 'EXECUTE')
      AND NOT has_function_privilege('anon', signature, 'EXECUTE')
      AND NOT has_function_privilege('service_role', signature, 'EXECUTE'));
  END LOOP;
  PERFORM portal_regression.check_true('no portal function has PUBLIC execute',
    NOT EXISTS (
      SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
      WHERE n.nspname = 'public' AND p.proname LIKE 'portal_%'
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'));
  PERFORM portal_regression.check_true('all portal functions have an empty search path',
    NOT EXISTS (
      SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'portal_%'
        AND (p.proconfig IS NULL OR NOT ('search_path=""' = ANY(p.proconfig)))));
  PERFORM portal_regression.check_true('email result execute is service role only',
    has_function_privilege('service_role', 'public.portal_email_result(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.portal_email_result(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.portal_email_result(uuid,text)', 'EXECUTE'));
END;
$$;

-- Temporarily remove any pre-existing employee, so PT409 is tested even if the
-- isolated database already contained provisioned users. Restore them below.
CREATE TABLE portal_regression.previous_employees AS
SELECT id FROM public.profiles WHERE role = 'employee';
UPDATE public.profiles SET role = 'ambassador' WHERE role = 'employee';

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM portal_regression.claims(NULL);
  PERFORM portal_regression.expect_error('missing identity workspace', 'SELECT public.portal_workspace()', 'PT401');
  PERFORM portal_regression.expect_error('missing identity create', 'SELECT public.portal_create_ticket(''{}'')', 'PT401');
  PERFORM portal_regression.expect_error('missing identity update',
    'SELECT public.portal_update_ticket(portal_regression.id(''ambassador''), ''{}'')', 'PT401');
  PERFORM portal_regression.expect_error('missing identity message',
    'SELECT public.portal_add_message(portal_regression.id(''ambassador''), ''{}'')', 'PT401');
  PERFORM portal_regression.claims('ambassador');
  PERFORM portal_regression.expect_error('no employee contact',
    $q$SELECT public.portal_create_ticket('{"productId":"fjord-pale","subject":"Valid","description":"Valid","channel":"Instagram"}')$q$,
    'PT409');
END;
$$;
RESET ROLE;
UPDATE public.profiles SET role = 'employee'
WHERE id IN (SELECT id FROM portal_regression.previous_employees)
   OR id IN (portal_regression.id('employee'), portal_regression.id('employee2'));
UPDATE auth.users
SET email = id::text || '.updated@example.invalid',
    raw_user_meta_data = '{"name":" Updated employee ","role":"ambassador"}'
WHERE id = portal_regression.id('employee');
UPDATE auth.users SET raw_user_meta_data = '{"name":"ambassador","role":"employee"}'
WHERE id = portal_regression.id('ambassador');
UPDATE auth.users SET raw_user_meta_data = NULL
WHERE id = portal_regression.id('null_metadata');
UPDATE auth.users SET raw_user_meta_data = '{"name":null}'
WHERE id = portal_regression.id('null_name');

SELECT portal_regression.check_true('auth update synchronizes without demoting SQL employee',
  (SELECT role = 'employee' AND name = 'Updated employee'
          AND email = id::text || '.updated@example.invalid'
   FROM public.profiles WHERE id = portal_regression.id('employee')));
SELECT portal_regression.check_true('metadata update cannot promote an ambassador',
  (SELECT role = 'ambassador' FROM public.profiles WHERE id = portal_regression.id('ambassador')));
SELECT portal_regression.check_true('null metadata and null names synchronize safely',
  (SELECT bool_and(name = email) FROM public.profiles
   WHERE id IN (portal_regression.id('null_metadata'), portal_regression.id('null_name'))));

SET LOCAL ROLE authenticated;
DO $$
<<ticket_checks>>
DECLARE
  result jsonb;
  ticket_id uuid;
  bad_input jsonb;
BEGIN
  PERFORM portal_regression.claims('ambassador');
  result := public.portal_create_ticket(
    '{"productId":"fjord-pale","subject":" Own ticket ","description":" Description ","channel":"Instagram","dueDate":"2028-02-29"}');
  ticket_id := (result #>> '{ticket,id}')::uuid;
  PERFORM set_config('portal_test.ticket', ticket_id::text, true);
  PERFORM portal_regression.check_true('ticket initial shape and trimming',
    result #>> '{ticket,subject}' = 'Own ticket'
    AND result #>> '{ticket,description}' = 'Description'
    AND result #>> '{ticket,status}' = 'requested'
    AND result #>> '{ticket,productId}' = 'fjord-pale'
    AND (result #>> '{ticket,number}')::bigint >= 1001
    AND result #> '{ticket,messages}' = '[]'::jsonb
    AND result #>> '{ticket,dueDate}' = '2028-02-29'
    AND result #>> '{ticket,createdAt}' IS NOT NULL
    AND result #>> '{ticket,updatedAt}' IS NOT NULL);
  PERFORM portal_regression.check_true('default contact is deterministic employee',
    (result #>> '{ticket,assigneeId}')::uuid =
      (SELECT id FROM public.profiles WHERE role = 'employee' ORDER BY id LIMIT 1));
  PERFORM portal_regression.check_true('ambassador owns created ticket',
    (result #>> '{ticket,ambassadorId}')::uuid = portal_regression.id('ambassador'));

  FOREACH bad_input IN ARRAY ARRAY[
    'null'::jsonb, '[]'::jsonb, '{}'::jsonb, '{"unknown":true}'::jsonb,
    '{"productId":"missing","subject":"Valid","description":"Valid","channel":"Instagram"}'::jsonb,
    '{"productId":"fjord-pale","subject":42,"description":"Valid","channel":"Instagram"}'::jsonb,
    '{"productId":"fjord-pale","subject":"\t\n","description":"Valid","channel":"Instagram"}'::jsonb,
    '{"productId":"fjord-pale","subject":"Valid","description":null,"channel":"Instagram"}'::jsonb,
    '{"productId":"fjord-pale","subject":"Valid","description":"Valid","channel":" Instagram "}'::jsonb,
    '{"productId":"fjord-pale","subject":"Valid","description":"Valid","channel":true}'::jsonb,
    '{"productId":"fjord-pale","subject":"Valid","description":"Valid","channel":"Instagram","dueDate":"2026-02-30"}'::jsonb,
    '{"productId":"fjord-pale","subject":"Valid","description":"Valid","channel":"Instagram","dueDate":"0000-01-01"}'::jsonb,
    '{"productId":"fjord-pale","subject":"Valid","description":"Valid","channel":"Instagram","dueDate":false}'::jsonb,
    '{"productId":"fjord-pale","subject":"Valid","description":"Valid","channel":"Instagram","role":"employee"}'::jsonb,
    jsonb_build_object('productId','fjord-pale','subject',repeat('😀',81),'description','Valid','channel','Instagram'),
    jsonb_build_object('productId','fjord-pale','subject','Valid','description',repeat('x',5001),'channel','Instagram')
  ] LOOP
    PERFORM portal_regression.expect_error('reject create input ' || bad_input::text,
      format('SELECT public.portal_create_ticket(%L::jsonb)', bad_input::text), 'PT400');
  END LOOP;
  PERFORM portal_regression.expect_error('cannot create for another ambassador',
    format('SELECT public.portal_create_ticket(%L::jsonb)',
      jsonb_build_object('productId','fjord-pale','subject','Valid','description','Valid',
                        'channel','Instagram','ambassadorId',portal_regression.id('other'))::text), 'PT403');
  PERFORM portal_regression.expect_error('cannot elevate profile role',
    'UPDATE public.profiles SET role = ''employee'' WHERE id = auth.uid()', '42501');
  PERFORM portal_regression.expect_error('cannot directly insert products',
    'INSERT INTO public.products(id,name,category,description,price) VALUES (''denied'',''x'',''x'',''x'',1)', '42501');
  PERFORM portal_regression.expect_error('cannot directly update ticket',
    'UPDATE public.tickets SET status = ''completed''', '42501');
  PERFORM portal_regression.expect_error('cannot directly delete messages',
    'DELETE FROM public.messages', '42501');
  PERFORM portal_regression.expect_error('empty update rejected',
    format('SELECT public.portal_update_ticket(%L,''{}'')',ticket_id), 'PT400');
  PERFORM portal_regression.expect_error('requested task cannot be started',
    format('SELECT public.portal_update_ticket(%L,''{"status":"in_progress"}'')',ticket_id), 'PT403');
  PERFORM portal_regression.expect_error('ambassador cannot edit due date',
    format('SELECT public.portal_update_ticket(%L,''{"dueDate":null}'')',ticket_id), 'PT403');
  PERFORM portal_regression.expect_error('ambassador cannot assign employee',
    format('SELECT public.portal_update_ticket(%L,%L::jsonb)',ticket_id,
      jsonb_build_object('assigneeId',portal_regression.id('employee2'))::text), 'PT403');

  result := public.portal_add_message(ticket_id, '{"body":" First message ","sendEmail":true}');
  PERFORM set_config('portal_test.message', result #>> '{message,id}', true);
  PERFORM portal_regression.check_true('email-requested message persists as failed',
    result #>> '{message,emailStatus}' = 'failed'
    AND result #>> '{message,body}' = 'First message'
    AND (result #>> '{message,authorId}')::uuid = auth.uid());
  result := public.portal_add_message(ticket_id, '{"body":"Second message"}');
  PERFORM set_config('portal_test.no_email_message', result #>> '{message,id}', true);
  PERFORM portal_regression.check_true('email not requested by default',
    result #>> '{message,emailStatus}' = 'not_requested');
  PERFORM portal_regression.check_true('messages have chronological timestamps',
    (SELECT created_at FROM public.messages WHERE id = current_setting('portal_test.message')::uuid)
      < (result #>> '{message,createdAt}')::timestamptz);
  FOREACH bad_input IN ARRAY ARRAY[
    '{}'::jsonb, '[]'::jsonb, '{"body":null}'::jsonb, '{"body":"\t\n"}'::jsonb,
    '{"body":"Valid","sendEmail":null}'::jsonb, '{"body":"Valid","sendEmail":"true"}'::jsonb,
    '{"body":"Valid","authorId":"forged"}'::jsonb,
    jsonb_build_object('body',repeat('x',5001))
  ] LOOP
    PERFORM portal_regression.expect_error('reject message input ' || bad_input::text,
      format('SELECT public.portal_add_message(%L,%L::jsonb)',ticket_id,bad_input::text), 'PT400');
  END LOOP;
  PERFORM portal_regression.expect_error('authenticated email outcome denied',
    format('SELECT public.portal_email_result(%L,''sent'')',current_setting('portal_test.message')), '42501');

  PERFORM portal_regression.claims('other');
  result := public.portal_create_ticket(
    '{"productId":"glass","subject":"Other ticket","description":"Other description","channel":"Blogg","dueDate":""}');
  PERFORM set_config('portal_test.other_ticket',result #>> '{ticket,id}',true);
  PERFORM portal_regression.check_true('empty due date becomes null', result #> '{ticket,dueDate}' = 'null'::jsonb);
  PERFORM public.portal_add_message((result #>> '{ticket,id}')::uuid,'{"body":"Private other message"}');
  PERFORM portal_regression.check_true('other ambassador cannot read first ticket directly',
    NOT EXISTS (SELECT 1 FROM public.tickets WHERE id = ticket_id));
  PERFORM portal_regression.check_true('other ambassador cannot read first messages directly',
    NOT EXISTS (SELECT 1 FROM public.messages WHERE messages.ticket_id = ticket_checks.ticket_id));
  PERFORM portal_regression.expect_error('unauthorized update looks missing',
    format('SELECT public.portal_update_ticket(%L,''{"status":"approved"}'')',ticket_id), 'PT404');
  PERFORM portal_regression.expect_error('unauthorized message looks missing',
    format('SELECT public.portal_add_message(%L,''{"body":"Forbidden"}'')',ticket_id), 'PT404');
  PERFORM portal_regression.expect_error('nonexistent ticket looks missing',
    format('SELECT public.portal_update_ticket(%L,''{"status":"review"}'')',gen_random_uuid()), 'PT404');
END;
$$;
RESET ROLE;

UPDATE public.products SET available = false WHERE id = 'fjord-pale';
SET LOCAL ROLE authenticated;
SELECT portal_regression.claims('ambassador');
SELECT portal_regression.expect_error('unavailable product rejected',
  $q$SELECT public.portal_create_ticket('{"productId":"fjord-pale","subject":"Valid","description":"Valid","channel":"Instagram"}')$q$, 'PT400');
RESET ROLE;
UPDATE public.products SET available = true WHERE id = 'fjord-pale';
-- Former employees remain resolvable as authors, without exposing other users.
INSERT INTO public.messages(ticket_id, author_id, body)
VALUES (current_setting('portal_test.ticket')::uuid, portal_regression.id('former'), 'Historical reply');

SET LOCAL ROLE authenticated;
DO $$
<<workspace_checks>>
DECLARE
  result jsonb;
  ticket_id uuid := current_setting('portal_test.ticket')::uuid;
  bad_input jsonb;
  employee_status text;
BEGIN
  PERFORM portal_regression.claims('ambassador');
  result := public.portal_workspace();
  PERFORM portal_regression.check_true('workspace returns safe current user',
    result -> 'user' = jsonb_build_object('id',auth.uid(),'name','ambassador',
      'email',auth.uid()::text || '@example.invalid','role','ambassador'));
  PERFORM portal_regression.check_true('workspace exposes catalogue shape',
    EXISTS (SELECT 1 FROM jsonb_array_elements(result -> 'products') AS p
            WHERE p ->> 'id' = 'fjord-pale' AND p ?& ARRAY['name','category','description','price','available']));
  PERFORM portal_regression.check_true('definer workspace explicitly isolates tickets',
    jsonb_array_length(result -> 'tickets') = 1
    AND (result #>> '{tickets,0,id}')::uuid = ticket_id);
  PERFORM portal_regression.check_true('own message authors are visible through profile RLS',
    EXISTS (SELECT 1 FROM public.profiles WHERE id = portal_regression.id('former')));
  PERFORM portal_regression.check_true('other ambassador profile is private',
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = portal_regression.id('other')));
  PERFORM portal_regression.check_true('workspace safe users includes author but not unrelated ambassador',
    EXISTS (SELECT 1 FROM jsonb_array_elements(result -> 'users') AS p
            WHERE (p ->> 'id')::uuid = portal_regression.id('former'))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(result -> 'users') AS p
                    WHERE (p ->> 'id')::uuid = portal_regression.id('other'))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(result -> 'users') AS p
                    WHERE (SELECT count(*) FROM jsonb_object_keys(p)) <> 4));
  PERFORM portal_regression.check_true('own ticket direct RLS and nested messages',
    (SELECT count(*) = 1 FROM public.tickets)
    AND (SELECT count(*) = 3 FROM public.messages)
    AND jsonb_array_length(result #> '{tickets,0,messages}') = 3);

  PERFORM portal_regression.claims('employee');
  PERFORM portal_regression.check_true('employees read every profile fixture',
    (SELECT count(*) = 13 FROM public.profiles AS p JOIN portal_regression.fixtures AS f ON f.id = p.id));
  PERFORM portal_regression.check_true('employees read both tickets and their messages',
    (SELECT count(*) = 2 FROM public.tickets
     WHERE id IN (ticket_id,current_setting('portal_test.other_ticket')::uuid))
    AND (SELECT count(*) = 4 FROM public.messages
         WHERE messages.ticket_id IN (workspace_checks.ticket_id,current_setting('portal_test.other_ticket')::uuid)));
  result := public.portal_workspace();
  PERFORM portal_regression.check_true('employee workspace includes every fixture profile',
    NOT EXISTS (
      SELECT 1 FROM portal_regression.fixtures AS f
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(result -> 'users') AS p
                        WHERE (p ->> 'id')::uuid = f.id)));
  PERFORM portal_regression.check_true('employee workspace includes other ambassador messages',
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(result -> 'tickets') AS t
      WHERE (t ->> 'id')::uuid = current_setting('portal_test.other_ticket')::uuid
        AND jsonb_array_length(t -> 'messages') = 1));
  result := public.portal_update_ticket(ticket_id,
    jsonb_build_object('status','approved','assigneeId',portal_regression.id('employee2'),'dueDate',NULL));
  PERFORM portal_regression.check_true('employee can approve reassign and clear due date',
    result #>> '{ticket,status}' = 'approved'
    AND (result #>> '{ticket,assigneeId}')::uuid = portal_regression.id('employee2')
    AND result #> '{ticket,dueDate}' = 'null'::jsonb
    AND jsonb_array_length(result #> '{ticket,messages}') = 3);
  FOREACH bad_input IN ARRAY ARRAY[
    '[]'::jsonb, '{"status":null}'::jsonb, '{"status":"unknown"}'::jsonb,
    '{"status":" approved "}'::jsonb, '{"dueDate":42}'::jsonb,
    '{"dueDate":"2026-02-30"}'::jsonb, '{"assigneeId":null}'::jsonb,
    '{"assigneeId":"not-a-uuid"}'::jsonb, '{"role":"employee"}'::jsonb,
    jsonb_build_object('assigneeId',portal_regression.id('ambassador'))
  ] LOOP
    PERFORM portal_regression.expect_error('reject employee update input ' || bad_input::text,
      format('SELECT public.portal_update_ticket(%L,%L::jsonb)',ticket_id,bad_input::text), 'PT400');
  END LOOP;
  PERFORM portal_regression.expect_error('employee requires ambassador on create',
    $q$SELECT public.portal_create_ticket('{"productId":"glass","subject":"Valid","description":"Valid","channel":"Blogg"}')$q$, 'PT400');
  PERFORM portal_regression.expect_error('employee cannot choose employee as ambassador',
    format('SELECT public.portal_create_ticket(%L::jsonb)',
      jsonb_build_object('productId','glass','subject','Valid','description','Valid',
        'channel','Blogg','ambassadorId',portal_regression.id('employee2'))::text), 'PT400');
  result := public.portal_create_ticket(jsonb_build_object(
    'productId','glass','subject','Employee created','description','Valid','channel','Blogg',
    'ambassadorId',portal_regression.id('other'),'dueDate',NULL));
  PERFORM portal_regression.check_true('employee can create for selected ambassador',
    (result #>> '{ticket,ambassadorId}')::uuid = portal_regression.id('other'));
  PERFORM public.portal_add_message(ticket_id,'{"body":"Employee response","sendEmail":false}');

  PERFORM portal_regression.claims('ambassador');
  result := public.portal_update_ticket(ticket_id,'{"status":"in_progress"}');
  PERFORM portal_regression.check_true('approved task can start',result #>> '{ticket,status}' = 'in_progress');
  PERFORM portal_regression.expect_error('stale duplicate start is denied',
    format('SELECT public.portal_update_ticket(%L,''{"status":"in_progress"}'')',ticket_id), 'PT403');
  result := public.portal_update_ticket(ticket_id,'{"status":"review"}');
  PERFORM portal_regression.check_true('in progress task can enter review',result #>> '{ticket,status}' = 'review');
  PERFORM portal_regression.expect_error('ambassador cannot complete task',
    format('SELECT public.portal_update_ticket(%L,''{"status":"completed"}'')',ticket_id), 'PT403');
  PERFORM portal_regression.check_true('messages survive all updates',
    jsonb_array_length(result #> '{ticket,messages}') = 4);
  PERFORM portal_regression.claims('employee');
  result := public.portal_update_ticket(ticket_id,'{"status":"completed","dueDate":"2028-03-01"}');
  PERFORM portal_regression.check_true('employee can complete and set due date',
    result #>> '{ticket,status}' = 'completed' AND result #>> '{ticket,dueDate}' = '2028-03-01');
  FOREACH employee_status IN ARRAY ARRAY['requested','approved','in_progress','review','completed','declined'] LOOP
    result := public.portal_update_ticket(ticket_id,jsonb_build_object('status',employee_status));
    PERFORM portal_regression.check_true('employee may set status ' || employee_status,
      result #>> '{ticket,status}' = employee_status);
  END LOOP;
END;
$$;
RESET ROLE;

SELECT portal_regression.expect_error('owner cannot impersonate email service without service role',
  format('SELECT public.portal_email_result(%L,''sent'')',current_setting('portal_test.message')), 'PT403');

SET LOCAL ROLE service_role;
DO $$
BEGIN
  PERFORM public.portal_email_result(current_setting('portal_test.message')::uuid,'sent');
  PERFORM public.portal_email_result(current_setting('portal_test.no_email_message')::uuid,'sent');
  PERFORM portal_regression.expect_error('service rejects invalid delivery status',
    format('SELECT public.portal_email_result(%L,''pending'')',current_setting('portal_test.message')), 'PT400');
  PERFORM portal_regression.expect_error('service rejects null delivery status',
    format('SELECT public.portal_email_result(%L,NULL)',current_setting('portal_test.message')), 'PT400');
  PERFORM portal_regression.expect_error('service cannot run routine workspace RPC','SELECT public.portal_workspace()','42501');
  PERFORM portal_regression.expect_error('service cannot change profile roles','UPDATE public.profiles SET role = ''employee''','42501');
END;
$$;
RESET ROLE;
SELECT portal_regression.check_true('service records requested email outcome',
  (SELECT email_status = 'sent' FROM public.messages WHERE id = current_setting('portal_test.message')::uuid));
SELECT portal_regression.check_true('service cannot mark unrequested email as sent',
  (SELECT email_status = 'not_requested' FROM public.messages WHERE id = current_setting('portal_test.no_email_message')::uuid));
SET LOCAL ROLE service_role;
SELECT public.portal_email_result(current_setting('portal_test.message')::uuid,'failed');
RESET ROLE;
SELECT portal_regression.check_true('service can record failed delivery',
  (SELECT email_status = 'failed' FROM public.messages WHERE id = current_setting('portal_test.message')::uuid));

SET LOCAL ROLE anon;
SELECT portal_regression.expect_error('anonymous profile read denied','SELECT * FROM public.profiles','42501');
SELECT portal_regression.expect_error('anonymous catalogue read denied','SELECT * FROM public.products','42501');
SELECT portal_regression.expect_error('anonymous workspace denied','SELECT public.portal_workspace()','42501');
SELECT portal_regression.expect_error('anonymous delivery update denied',
  format('SELECT public.portal_email_result(%L,''sent'')',current_setting('portal_test.message')), '42501');
RESET ROLE;

SELECT pg_catalog.format('Portal SQL regression: %s checks passed.', count(*)) AS result
FROM portal_regression.results;
ROLLBACK;
