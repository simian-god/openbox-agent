# migrations

Core schema, as plain Postgres DDL: tables, keys, constraints and indexes.
No triggers, stored functions or extensions (DATA-3). Every table has RLS
switched on (DATA-5).

`openbox migrate` applies these over `DATABASE_URL`, then fails if any table
was left without RLS (DATA-6).

The first migrations land in T1.3. pgvector gets its own optional migration,
used only by the pgvector retriever.
