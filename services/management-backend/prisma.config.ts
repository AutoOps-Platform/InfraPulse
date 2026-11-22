import { defineConfig } from 'prisma/config';

const url = process.env.DATABASE_URL || process.env.PRISMA_MIGRATION_URL;

// Code generation/validation are offline. Supply DATABASE_URL for db push or migrations.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  ...(url ? { datasource: { url } } : {}),
});
