create table if not exists public.app_config (
  id text primary key,
  config jsonb not null default '{}'::jsonb
);

create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  name text not null,
  type text not null check (type in ('pdf', 'pptx')),
  size bigint not null,
  page_count integer not null,
  pages jsonb not null default '[]'::jsonb,
  summary_status jsonb not null default '{}'::jsonb,
  summary_en jsonb,
  summary_ar jsonb,
  created_at timestamptz not null default now()
);

create index if not exists documents_course_id_idx on public.documents(course_id);

alter table public.app_config enable row level security;
alter table public.courses enable row level security;
alter table public.documents enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values ('study-uploads', 'study-uploads', false, 4194304)
on conflict (id) do update set public = false, file_size_limit = 4194304;