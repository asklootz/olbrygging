BEGIN;

-- Match String.trim(), including whitespace not removed by SQL's default btrim.
CREATE FUNCTION public.portal_trim(value text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = ''
AS $$
  SELECT pg_catalog.btrim(value,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  email text NOT NULL CHECK (char_length(email) <= 254),
  role text NOT NULL DEFAULT 'ambassador' CHECK (role IN ('employee', 'ambassador'))
);

CREATE TABLE public.products (
  id text PRIMARY KEY CHECK (char_length(btrim(id)) BETWEEN 1 AND 100),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  category text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 100),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 5000),
  price numeric(12,2) NOT NULL CHECK (price >= 0 AND price <> 'NaN'::numeric),
  available boolean NOT NULL DEFAULT true
);

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
  subject text NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 5000),
  product_id text NOT NULL REFERENCES public.products(id),
  ambassador_id uuid NOT NULL REFERENCES public.profiles(id),
  assignee_id uuid NOT NULL REFERENCES public.profiles(id),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'in_progress', 'review', 'completed', 'declined')),
  channel text NOT NULL CHECK (channel IN ('Instagram', 'TikTok', 'YouTube', 'Blogg', 'Annet')),
  due_date date CHECK (due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.profiles(id),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  email_status text NOT NULL DEFAULT 'not_requested'
    CHECK (email_status IN ('not_requested', 'sent', 'failed'))
);

CREATE INDEX profiles_role_idx ON public.profiles(role);
CREATE INDEX tickets_ambassador_idx ON public.tickets(ambassador_id);
CREATE INDEX tickets_assignee_idx ON public.tickets(assignee_id);
CREATE INDEX tickets_product_idx ON public.tickets(product_id);
CREATE INDEX messages_ticket_created_idx ON public.messages(ticket_id, created_at, id);
CREATE INDEX messages_author_idx ON public.messages(author_id);

-- Metadata is untrusted. In particular, role is never copied from metadata,
-- and resynchronizing an existing profile never changes its SQL-managed role.
CREATE FUNCTION public.portal_sync_profile()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  profile_name text;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.raw_user_meta_data -> 'name') = 'string' THEN
    profile_name := public.portal_trim(NEW.raw_user_meta_data ->> 'name');
  END IF;
  profile_name := pg_catalog.left(
    COALESCE(NULLIF(profile_name, ''), NULLIF(NEW.email, ''), 'Ambassadør'), 160);
  INSERT INTO public.profiles(id, name, email)
  VALUES (NEW.id, profile_name, COALESCE(NEW.email, ''))
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_auth_profile
AFTER INSERT OR UPDATE OF email, raw_user_meta_data ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.portal_sync_profile();

INSERT INTO public.profiles(id, name, email)
SELECT u.id,
  pg_catalog.left(COALESCE(
    NULLIF(public.portal_trim(CASE
      WHEN pg_catalog.jsonb_typeof(u.raw_user_meta_data -> 'name') = 'string'
      THEN u.raw_user_meta_data ->> 'name' END), ''),
    NULLIF(u.email, ''), 'Ambassadør'), 160),
  COALESCE(u.email, '')
FROM auth.users AS u
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email;

INSERT INTO public.products(id, name, category, description, price) VALUES
  ('fjord-pale', 'Fjordglød Pale Ale', 'Ølsett', 'Friskt allgrain-sett med sitrus, norsk bryggeglede og en gyllen avslutning. 20 liter.', 449),
  ('skog-ipa', 'Skogbris IPA', 'Ølsett', 'Et aromatisk ølsett med tropiske toner og en tydelig, balansert bitterhet. 20 liter.', 529),
  ('kveld-pils', 'Lys kveld Pilsner', 'Ølsett', 'Ren og lettdrikkelig pilsner til lange sommerkvelder. 20 liter.', 399),
  ('brew-kettle', 'Bryggekjele 30 L', 'Bryggeutstyr', 'Solid rustfri bryggekjele med tappekran og tydelig literskala.', 1890),
  ('fermenter', 'Gjæringskar 30 L', 'Bryggeutstyr', 'Praktisk gjæringskar med gjærlås, lokk og tappekran.', 349),
  ('hop-citra', 'Citra humle 100 g', 'Råvarer', 'Pelletshumle med frisk sitrus, pasjonsfrukt og et tropisk løft.', 109),
  ('malt', 'Pale Ale malt 5 kg', 'Råvarer', 'En allsidig basemalt med lett brødpreg til ditt neste hjemmebrygg.', 189),
  ('glass', 'Smaksglass, 2-pakning', 'Tilbehør', 'Tulipanformede glass som gir plass til både aroma og skumkrone.', 249);

-- These helpers bypass profile RLS, preventing recursive profile policies.
CREATE FUNCTION public.portal_is_employee()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = auth.uid() AND p.role = 'employee'
  );
$$;

CREATE FUNCTION public.portal_can_read_profile(profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles AS viewer WHERE viewer.id = auth.uid()
    AND (viewer.role = 'employee' OR profile_id = viewer.id
      OR EXISTS (SELECT 1 FROM public.profiles AS p
                 WHERE p.id = profile_id AND p.role = 'employee')
      OR EXISTS (
        SELECT 1 FROM public.messages AS m
        JOIN public.tickets AS t ON t.id = m.ticket_id
        WHERE t.ambassador_id = viewer.id AND m.author_id = profile_id
      ))
  );
$$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated
USING (public.portal_can_read_profile(id));
CREATE POLICY products_read ON public.products FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL);
CREATE POLICY tickets_read ON public.tickets FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL
  AND (ambassador_id = auth.uid() OR public.portal_is_employee()));
CREATE POLICY messages_read ON public.messages FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL AND EXISTS (
  SELECT 1 FROM public.tickets AS t WHERE t.id = ticket_id
  AND (t.ambassador_id = auth.uid() OR public.portal_is_employee())
));

CREATE FUNCTION public.portal_actor()
RETURNS public.profiles
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  actor public.profiles;
BEGIN
  SELECT p.* INTO actor FROM public.profiles AS p WHERE p.id = auth.uid();
  IF auth.uid() IS NULL OR actor.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'PT401', MESSAGE = 'Logg inn for å fortsette.';
  END IF;
  RETURN actor;
END;
$$;

CREATE FUNCTION public.portal_check_fields(input jsonb, allowed text[])
RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF pg_catalog.jsonb_typeof(input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Forventet et JSON-objekt.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(input) AS k(key)
             WHERE NOT (k.key = ANY(allowed))) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Forespørselen inneholder ukjente felt.';
  END IF;
END;
$$;

CREATE FUNCTION public.portal_text(value jsonb, max_length integer)
RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  result text;
  utf16_length integer;
BEGIN
  IF pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Forventet tekst.';
  END IF;
  result := value #>> '{}';
  -- JavaScript's limits count UTF-16 code units, not Unicode code points.
  SELECT COALESCE(pg_catalog.sum(CASE
    WHEN pg_catalog.ascii(pg_catalog.substr(result, n, 1)) > 65535 THEN 2 ELSE 1 END), 0)
  INTO utf16_length
  FROM pg_catalog.generate_series(1, pg_catalog.char_length(result)) AS positions(n);
  IF utf16_length > max_length OR public.portal_trim(result) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Teksten er tom eller for lang.';
  END IF;
  RETURN public.portal_trim(result);
END;
$$;

CREATE FUNCTION public.portal_date(value jsonb)
RETURNS date
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  raw_date text;
  result date;
BEGIN
  IF value IS NULL OR value = 'null'::jsonb OR value = '""'::jsonb THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Frist må være en gyldig dato (ÅÅÅÅ-MM-DD).';
  END IF;
  raw_date := value #>> '{}';
  IF raw_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Frist må være en gyldig dato (ÅÅÅÅ-MM-DD).';
  END IF;
  BEGIN
    result := raw_date::date;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Frist må være en gyldig dato (ÅÅÅÅ-MM-DD).';
  END;
  IF pg_catalog.to_char(result, 'YYYY-MM-DD') <> raw_date THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Frist må være en gyldig dato (ÅÅÅÅ-MM-DD).';
  END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.portal_uuid(value jsonb)
RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  raw_id text;
BEGIN
  raw_id := public.portal_text(value, 100);
  BEGIN
    RETURN raw_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Ugyldig bruker-ID.';
  END;
END;
$$;

CREATE FUNCTION public.portal_message_json(message public.messages)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', message.id, 'authorId', message.author_id, 'body', message.body,
    'createdAt', message.created_at, 'emailStatus', message.email_status);
$$;

CREATE FUNCTION public.portal_ticket_json(ticket public.tickets)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', ticket.id, 'number', ticket.number, 'subject', ticket.subject,
    'description', ticket.description, 'productId', ticket.product_id,
    'ambassadorId', ticket.ambassador_id, 'assigneeId', ticket.assignee_id,
    'status', ticket.status, 'channel', ticket.channel, 'dueDate', ticket.due_date,
    'createdAt', ticket.created_at, 'updatedAt', ticket.updated_at,
    'messages', COALESCE((
      SELECT pg_catalog.jsonb_agg(public.portal_message_json(m) ORDER BY m.created_at, m.id)
      FROM public.messages AS m WHERE m.ticket_id = ticket.id
    ), '[]'::jsonb));
$$;

CREATE FUNCTION public.portal_workspace()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor public.profiles;
BEGIN
  actor := public.portal_actor();
  -- SECURITY DEFINER bypasses RLS: every collection is filtered explicitly.
  RETURN pg_catalog.jsonb_build_object(
    'user', pg_catalog.to_jsonb(actor),
    'users', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.name, p.id)
      FROM public.profiles AS p
      WHERE actor.role = 'employee' OR p.id = actor.id OR p.role = 'employee'
      OR EXISTS (
        SELECT 1 FROM public.messages AS m
        JOIN public.tickets AS t ON t.id = m.ticket_id
        WHERE t.ambassador_id = actor.id AND m.author_id = p.id
      )
    ), '[]'::jsonb),
    'products', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id)
      FROM public.products AS p
    ), '[]'::jsonb),
    'tickets', COALESCE((
      SELECT pg_catalog.jsonb_agg(public.portal_ticket_json(t) ORDER BY t.number)
      FROM public.tickets AS t WHERE actor.role = 'employee' OR t.ambassador_id = actor.id
    ), '[]'::jsonb)
  );
END;
$$;

CREATE FUNCTION public.portal_create_ticket(input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor public.profiles;
  chosen_product text;
  chosen_ambassador uuid;
  chosen_assignee uuid;
  chosen_subject text;
  chosen_description text;
  chosen_channel text;
  chosen_date date;
  ticket public.tickets;
  created_time timestamptz;
BEGIN
  actor := public.portal_actor();
  PERFORM public.portal_check_fields(input,
    ARRAY['productId', 'subject', 'description', 'channel', 'dueDate', 'ambassadorId']);
  chosen_product := public.portal_text(input -> 'productId', 100);
  IF NOT EXISTS (SELECT 1 FROM public.products AS p WHERE p.id = chosen_product AND p.available) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Velg et tilgjengelig produkt.';
  END IF;
  chosen_ambassador := actor.id;
  IF actor.role = 'employee' THEN
    chosen_ambassador := public.portal_uuid(input -> 'ambassadorId');
    IF NOT EXISTS (SELECT 1 FROM public.profiles AS p
                   WHERE p.id = chosen_ambassador AND p.role = 'ambassador') THEN
      RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Velg en gyldig ambassadør.';
    END IF;
  ELSIF input ? 'ambassadorId' THEN
    chosen_ambassador := public.portal_uuid(input -> 'ambassadorId');
    IF chosen_ambassador <> actor.id THEN
      RAISE EXCEPTION USING ERRCODE = 'PT403', MESSAGE = 'Du kan bare opprette egne forespørsler.';
    END IF;
  END IF;
  chosen_subject := public.portal_text(input -> 'subject', 160);
  chosen_description := public.portal_text(input -> 'description', 5000);
  PERFORM public.portal_text(input -> 'channel', 100);
  chosen_channel := input ->> 'channel';
  IF chosen_channel NOT IN ('Instagram', 'TikTok', 'YouTube', 'Blogg', 'Annet') THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Velg en gyldig kanal.';
  END IF;
  chosen_date := public.portal_date(input -> 'dueDate');
  SELECT p.id INTO chosen_assignee FROM public.profiles AS p
  WHERE p.role = 'employee' ORDER BY p.id LIMIT 1;
  IF chosen_assignee IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'Ingen medarbeider er tilgjengelig.';
  END IF;
  created_time := pg_catalog.clock_timestamp();
  INSERT INTO public.tickets(subject, description, product_id, ambassador_id,
    assignee_id, channel, due_date, created_at, updated_at)
  VALUES (chosen_subject, chosen_description, chosen_product, chosen_ambassador,
    chosen_assignee, chosen_channel, chosen_date, created_time, created_time)
  RETURNING * INTO ticket;
  RETURN pg_catalog.jsonb_build_object('ticket', public.portal_ticket_json(ticket));
END;
$$;

CREATE FUNCTION public.portal_update_ticket(ticket_id uuid, input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor public.profiles;
  ticket public.tickets;
  chosen_status text;
  chosen_assignee uuid;
  chosen_date date;
BEGIN
  actor := public.portal_actor();
  SELECT t.* INTO ticket FROM public.tickets AS t
  WHERE t.id = portal_update_ticket.ticket_id FOR UPDATE;
  IF ticket.id IS NULL OR (actor.role <> 'employee' AND ticket.ambassador_id <> actor.id) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Fant ikke forespørselen.';
  END IF;
  PERFORM public.portal_check_fields(input, ARRAY['status', 'assigneeId', 'dueDate']);
  IF input = '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Ingen endringer er oppgitt.';
  END IF;
  chosen_status := ticket.status;
  chosen_assignee := ticket.assignee_id;
  chosen_date := ticket.due_date;
  IF input ? 'status' THEN
    PERFORM public.portal_text(input -> 'status', 100);
    chosen_status := input ->> 'status';
    IF chosen_status NOT IN ('requested', 'approved', 'in_progress', 'review', 'completed', 'declined') THEN
      RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Ugyldig status.';
    END IF;
  END IF;
  IF actor.role <> 'employee' AND (
    input ? 'assigneeId' OR input ? 'dueDate' OR NOT (input ? 'status')
    OR NOT ((ticket.status = 'approved' AND chosen_status = 'in_progress')
         OR (ticket.status = 'in_progress' AND chosen_status = 'review'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT403',
      MESSAGE = 'Du kan bare starte en godkjent oppgave eller sende en pågående oppgave til vurdering.';
  END IF;
  IF input ? 'assigneeId' THEN
    chosen_assignee := public.portal_uuid(input -> 'assigneeId');
    IF NOT EXISTS (SELECT 1 FROM public.profiles AS p
                   WHERE p.id = chosen_assignee AND p.role = 'employee') THEN
      RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Ansvarlig må være en medarbeider.';
    END IF;
  END IF;
  IF input ? 'dueDate' THEN
    chosen_date := public.portal_date(input -> 'dueDate');
  END IF;
  UPDATE public.tickets AS t
  SET status = chosen_status, assignee_id = chosen_assignee, due_date = chosen_date,
    updated_at = GREATEST(pg_catalog.clock_timestamp(), t.updated_at + interval '1 microsecond')
  WHERE t.id = ticket.id RETURNING t.* INTO ticket;
  RETURN pg_catalog.jsonb_build_object('ticket', public.portal_ticket_json(ticket));
END;
$$;

CREATE FUNCTION public.portal_add_message(ticket_id uuid, input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor public.profiles;
  ticket public.tickets;
  message public.messages;
  message_body text;
  message_time timestamptz;
BEGIN
  actor := public.portal_actor();
  SELECT t.* INTO ticket FROM public.tickets AS t
  WHERE t.id = portal_add_message.ticket_id FOR UPDATE;
  IF ticket.id IS NULL OR (actor.role <> 'employee' AND ticket.ambassador_id <> actor.id) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Fant ikke forespørselen.';
  END IF;
  PERFORM public.portal_check_fields(input, ARRAY['body', 'sendEmail']);
  message_body := public.portal_text(input -> 'body', 5000);
  IF input ? 'sendEmail' AND pg_catalog.jsonb_typeof(input -> 'sendEmail') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'sendEmail må være true eller false.';
  END IF;
  message_time := GREATEST(pg_catalog.clock_timestamp(), ticket.updated_at + interval '1 microsecond');
  INSERT INTO public.messages(ticket_id, author_id, body, created_at, email_status)
  VALUES (ticket.id, actor.id, message_body, message_time,
    CASE WHEN input -> 'sendEmail' = 'true'::jsonb THEN 'failed' ELSE 'not_requested' END)
  RETURNING * INTO message;
  UPDATE public.tickets AS t SET updated_at = message_time WHERE t.id = ticket.id;
  RETURN pg_catalog.jsonb_build_object('message', public.portal_message_json(message));
END;
$$;

CREATE FUNCTION public.portal_email_result(message_id uuid, delivery_status text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- current_user is the definer here; inspect the PostgREST caller role instead.
  IF COALESCE(pg_catalog.current_setting('role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT403', MESSAGE = 'Kun varslingstjenesten kan registrere e-postresultatet.';
  END IF;
  IF delivery_status IS NULL OR delivery_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = 'PT400', MESSAGE = 'Ugyldig e-poststatus.';
  END IF;
  UPDATE public.messages AS m SET email_status = delivery_status
  WHERE m.id = portal_email_result.message_id AND m.email_status <> 'not_requested';
END;
$$;

-- Supabase may have broad default grants; revoke them explicitly, including
-- service_role table access. Only trusted administrative SQL can change roles.
REVOKE ALL ON TABLE public.profiles, public.products, public.tickets, public.messages
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.tickets_number_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.profiles, public.products, public.tickets, public.messages TO authenticated;

REVOKE ALL ON FUNCTION public.portal_sync_profile() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_trim(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_is_employee() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_can_read_profile(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_actor() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_check_fields(jsonb, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_text(jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_date(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_uuid(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_message_json(public.messages) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_ticket_json(public.tickets) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_workspace() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_create_ticket(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_update_ticket(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_add_message(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.portal_email_result(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.portal_is_employee(), public.portal_can_read_profile(uuid),
  public.portal_workspace(), public.portal_create_ticket(jsonb),
  public.portal_update_ticket(uuid, jsonb), public.portal_add_message(uuid, jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_email_result(uuid, text) TO service_role;

COMMIT;
