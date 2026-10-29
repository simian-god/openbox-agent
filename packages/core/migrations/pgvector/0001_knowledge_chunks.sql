-- KNOW-4 and DATA-3: the pgvector retriever's own table, applied only by
-- `openbox migrate --pgvector`.
--
-- Separate because DATA-3 rules extensions out of the core schema, and an
-- agent on the `local` retriever should never be asked to install one. The
-- core migrations do not reference anything in here, so an agent that
-- never runs this file is not missing a thing.
--
-- The width is declared on purpose. pgvector 0.8.2 does allow a plain
-- `vector` column with no width, and it is a trap: it accepts vectors of
-- different widths happily and then fails at search time with "different
-- vector dimensions", long after the wrong data went in, and no index can
-- be built on it at all. Declared, a wrong vector is refused by the insert
-- that tried it. 1536 is what OpenAI's text-embedding-3-small and ada-002
-- both return. A different embedder means editing this one number, and the
-- retriever says so plainly when the widths disagree.
-- Into its own schema, not public, so DATA-3's "no stored functions" stays
-- literally true: the extension brings about seventy functions of its own
-- with it, and in public they would sit in the same namespace as the
-- tables and be exposed over PostgREST as callable endpoints.
--
-- Checked on the local stack rather than assumed: Supabase sets the
-- database search_path to "$user", public, extensions, so a bare
-- `vector(1536)` and a bare `<=>` both still resolve with no qualifying.
-- On a Postgres that is not Supabase, put `extensions` on the search_path
-- or this retriever's queries will not find the type.
--
-- If the extension is already installed in public, this leaves it there
-- and everything still works. Only the DATA-3 test about public having no
-- functions will have something to say about it.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists ob_knowledge_chunks (
  -- DATA-1: every table has agent_id, and it is half the key here rather
  -- than only a filter. Chunk ids are a hash of the text (KNOW-1), so two
  -- agents loading the same file produce the same id, and keyed on the id
  -- alone one agent would quietly overwrite the other's row.
  agent_id   text         not null,
  id         text         not null,

  text       text         not null,
  -- KNOW-3: the source file or entry, like `menu.md#Drinks`.
  source     text         not null,
  embedding  vector(1536) not null,

  created_at timestamptz  not null default now(),

  primary key (agent_id, id)
);

-- No vector index yet, so every search is exact.
--
-- An HNSW index is approximate: it trades recall for speed, and at this
-- size there is no speed to win. A knowledge folder is hundreds or a few
-- thousand chunks, which Postgres scans in milliseconds, and a wrong
-- answer that the index simply failed to find would be very hard to tell
-- from a bad embedding. The index to add when a corpus outgrows this is
-- `create index on ob_knowledge_chunks using hnsw (embedding
-- vector_cosine_ops)`, which needs the declared width above.

alter table ob_knowledge_chunks enable row level security;
