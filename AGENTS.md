# 星杳 · 璇玑

This is the independent product runtime. The design is ../design/xingyao-xuanji-v2.md.
Keep OpenCode coupling inside src/adapter.ts. Do not import upstream private modules or modify its database.
Use Bun, TypeScript strict mode and bun:sqlite. Keep the domain database single-writer with transactions.
Never use model-generated narrative as proof of external success. Preserve provenance, scope and revisions.
Run bun test and bun run typecheck in this directory. Tests must use temporary identities and directories.
Do not read or print credentials. Do not modify the user's existing OpenCode data during development.
