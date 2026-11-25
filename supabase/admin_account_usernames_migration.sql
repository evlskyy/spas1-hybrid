-- Separate admin login usernames from the verified Supabase Auth email used for recovery.
-- Run in Supabase SQL Editor before deploying the admin-account-auth Edge Function.

create table if not exists public.spas1_admin_usernames (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spas1_admin_usernames_format_check
    check (username = lower(username) and username ~ '^[a-z0-9._-]{3,48}$')
);

alter table public.spas1_admin_usernames enable row level security;
revoke all on public.spas1_admin_usernames from public, anon, authenticated;
grant select, insert, update, delete on public.spas1_admin_usernames to service_role;

create table if not exists public.spas1_admin_login_attempts (
  login_key_hash text primary key
    check (login_key_hash ~ '^[0-9a-f]{64}$'),
  failed_attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz
);

alter table public.spas1_admin_login_attempts enable row level security;
revoke all on public.spas1_admin_login_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.spas1_admin_login_attempts to service_role;

create or replace function public.spas1_admin_login_resolve_email(p_email text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select id
  from auth.users
  where lower(email) = lower(p_email)
    and raw_app_meta_data ->> 'role' = 'admin'
  limit 1;
$$;

create or replace function public.spas1_admin_login_is_locked(p_login_key_hash text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.spas1_admin_login_attempts
    where login_key_hash = p_login_key_hash
      and blocked_until > now()
  );
$$;

create or replace function public.spas1_admin_login_record_failure(p_login_key_hash text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.spas1_admin_login_attempts as attempts (
    login_key_hash, failed_attempts, window_started_at, blocked_until
  )
  values (p_login_key_hash, 1, now(), null)
  on conflict (login_key_hash) do update
  set failed_attempts = case
        when attempts.window_started_at <= now() - interval '15 minutes' then 1
        else attempts.failed_attempts + 1
      end,
      window_started_at = case
        when attempts.window_started_at <= now() - interval '15 minutes' then now()
        else attempts.window_started_at
      end,
      blocked_until = case
        when (
          case
            when attempts.window_started_at <= now() - interval '15 minutes' then 1
            else attempts.failed_attempts + 1
          end
        ) >= 5 then now() + interval '15 minutes'
        else null
      end;
end;
$$;

create or replace function public.spas1_admin_login_clear(p_login_key_hash text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.spas1_admin_login_attempts
  where login_key_hash = p_login_key_hash;
$$;

revoke all on function public.spas1_admin_login_is_locked(text) from public, anon, authenticated;
revoke all on function public.spas1_admin_login_resolve_email(text) from public, anon, authenticated;
revoke all on function public.spas1_admin_login_record_failure(text) from public, anon, authenticated;
revoke all on function public.spas1_admin_login_clear(text) from public, anon, authenticated;
grant execute on function public.spas1_admin_login_resolve_email(text) to service_role;
grant execute on function public.spas1_admin_login_is_locked(text) to service_role;
grant execute on function public.spas1_admin_login_record_failure(text) to service_role;
grant execute on function public.spas1_admin_login_clear(text) to service_role;

-- Existing admins retain their current login identity as their initial username.
-- The Auth email itself is never changed by this migration.
insert into public.spas1_admin_usernames (user_id, username)
select
  users.id,
  lower(split_part(users.email, '@', 1))
from auth.users as users
where users.raw_app_meta_data ->> 'role' = 'admin'
  and users.email is not null
  and lower(split_part(users.email, '@', 1)) ~ '^[a-z0-9._-]{3,48}$'
on conflict (user_id) do nothing;
