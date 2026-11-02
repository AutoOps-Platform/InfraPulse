import { defineConfig } from 'prisma/config';

// Code generation/validation are offline. Only the migration wrapper supplies a URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(process.env.PRISMA_MIGRATION_URL
    ? { datasource: { url: process.env.PRISMA_MIGRATION_URL } }
    : {}),
});
