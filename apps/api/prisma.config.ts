import { defineConfig } from 'prisma/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const dbUrl = process.env['ROOMER_DATABASE_URL'] ?? process.env['DATABASE_URL']

export default defineConfig({
  datasource: {
    url: dbUrl!,
  },
  migrate: {
    async adapter(env: NodeJS.ProcessEnv) {
      const url = env['ROOMER_DATABASE_URL'] ?? env['DATABASE_URL']
      const pool = new Pool({ connectionString: url })
      return new PrismaPg(pool)
    },
  },
})
