import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const db = drizzle(pool, { schema })

let panelSchemaReady: Promise<void> | null = null

/**
 * Lightweight compatibility migration for deployments that already have the
 * BlockCtrl database. It is intentionally idempotent so old installations can
 * be upgraded without manually running SQL first.
 */
export function ensurePanelSchema() {
  if (!panelSchemaReady) {
    panelSchemaReady = (async () => {
      await pool.query(`ALTER TABLE "server_permissions" ADD COLUMN IF NOT EXISTS "sections" jsonb NOT NULL DEFAULT '[]'::jsonb`)
      await pool.query(`ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text`)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "server_schedules" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "userId" text NOT NULL,
          "serverId" uuid NOT NULL,
          "name" text NOT NULL,
          "taskType" text NOT NULL,
          "cadence" text NOT NULL DEFAULT 'daily',
          "timeOfDay" text,
          "weekday" integer,
          "intervalMinutes" integer,
          "timezoneOffsetMinutes" integer NOT NULL DEFAULT 0,
          "enabled" boolean NOT NULL DEFAULT true,
          "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "lastRunAt" timestamp,
          "nextRunAt" timestamp NOT NULL,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await pool.query(`CREATE INDEX IF NOT EXISTS "server_schedules_due_idx" ON "server_schedules" ("enabled","nextRunAt")`)
      await pool.query(`CREATE INDEX IF NOT EXISTS "server_schedules_server_idx" ON "server_schedules" ("serverId")`)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "managed_databases" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "userId" text NOT NULL,
          "serverId" uuid NOT NULL,
          "nodeId" uuid NOT NULL,
          "engine" text NOT NULL DEFAULT 'mariadb',
          "databaseName" text NOT NULL,
          "databaseUser" text NOT NULL,
          "host" text NOT NULL DEFAULT '127.0.0.1',
          "port" integer NOT NULL DEFAULT 3306,
          "credentialsPath" text,
          "status" text NOT NULL DEFAULT 'queued',
          "lastError" text,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `)
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS "managed_databases_name_idx" ON "managed_databases" ("serverId","databaseName")`)
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS "managed_databases_user_idx" ON "managed_databases" ("serverId","databaseUser")`)
    })().catch(error => {
      panelSchemaReady = null
      throw error
    })
  }
  return panelSchemaReady
}
