import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDialect } from "@fileshed/kysely-node-sqlite";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { homedir } from "node:os";
import { Model } from "kysely-model";
import { ReasoningEffortId, createUserMessage, joinAssistantStreamText } from "@deepseek-ai/dsh-llm";
import { getServerContext, getServerOptions } from "dsh-h3/utils";
import { defineWebServer } from "dsh-h3";
import { HTTPError, defineHandler, getQuery, getRouterParam, readBody } from "h3";
import { createStorage } from "unstorage";
import fs from "unstorage/drivers/fs";
import { access, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { realpathNormalize } from "@deepseek-ai/dsh-workspace";
import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promisify, stripVTControlCharacters } from "node:util";
import { createRouteDispatcher, proxyEnvironmentForChild } from "@deepseek-ai/dsh-http-proxy";
import { fetch } from "undici";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
const DSH_PLUGIN_HOME = `${process.env.DSH_HOME ?? join(homedir(), ".dsh")}/.supermesh`;
/** 代理工作区：角色会话的 cwd 与官方工作区条目都只指向这里，插件状态留在上一层。 */
const DSH_WORKSPACE_HOME = join(DSH_PLUGIN_HOME, "workspace");
// src/database/migrations.ts
/**
* 由 `pnpm run prisma:migrate` 从 `prisma/migrations` 搬运，不要手改。
*
* 一个键就是一个 Prisma 迁移目录，值是它 `migration.sql` 的全文。
*/
const migrations = {
	"20261113135519": `
    -- CreateTable
    CREATE TABLE "channel" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT false,
        "host" TEXT,
        "createdAt" TEXT NOT NULL
    );

    -- CreateTable
    CREATE TABLE "channel_account" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "channelId" TEXT NOT NULL,
        "role" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "avatar" TEXT,
        "status" TEXT NOT NULL DEFAULT 'offline',
        "createdAt" TEXT NOT NULL,
        CONSTRAINT "channel_account_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "ci_watch" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "channelId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "ref" TEXT NOT NULL,
        "fingerprint" TEXT NOT NULL,
        "revision" INTEGER NOT NULL DEFAULT 0,
        "head" TEXT,
        "updatedAt" TEXT NOT NULL,
        CONSTRAINT "ci_watch_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "source_state" (
        "channelId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL,

        PRIMARY KEY ("channelId", "name"),
        CONSTRAINT "source_state_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "inbox" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "seq" BIGINT NOT NULL,
        "type" TEXT NOT NULL,
        "projectId" TEXT,
        "supervisorId" TEXT,
        "origin" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "kind" TEXT NOT NULL,
        "title" TEXT,
        "message" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,
        "doneAt" TEXT,
        "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
        "deliveryError" TEXT,
        "nextRetryAt" TEXT,
        "readAt" TEXT,
        "escalations" INTEGER NOT NULL DEFAULT 0,
        "lastEscalatedAt" TEXT,
        "answer" TEXT,
        "answeredBy" TEXT,
        "answeredAt" TEXT,
        "triggerId" TEXT,
        "threadId" TEXT,
        "ticketId" TEXT,
        "workerId" TEXT,
        CONSTRAINT "inbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "inbox_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "supervisor" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "inbox_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "trigger" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "inbox_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "thread" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "inbox_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "inbox_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "worker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "project" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "channelId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "workspaceId" TEXT NOT NULL,
        "directory" TEXT NOT NULL,
        "orchestratorSessionId" TEXT,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL,
        CONSTRAINT "project_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "setting" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "maxWorkers" INTEGER NOT NULL DEFAULT 4,
        "backgroundLimitMinutes" INTEGER NOT NULL DEFAULT 30,
        "autoMerge" BOOLEAN NOT NULL DEFAULT false,
        "autoMergeMaxLines" INTEGER NOT NULL DEFAULT 200,
        "deliveryMaxAttempts" INTEGER NOT NULL DEFAULT 3,
        "deliveryRetryCeilingSeconds" INTEGER NOT NULL DEFAULT 60,
        "updatedAt" TEXT NOT NULL
    );

    -- CreateTable
    CREATE TABLE "supervisor" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "sessionId" TEXT,
        "title" TEXT NOT NULL,
        "reason" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'active',
        "createdAt" TEXT NOT NULL,
        "closedAt" TEXT
    );

    -- CreateTable
    CREATE TABLE "supervisor_ticket" (
        "supervisorId" TEXT NOT NULL,
        "ticketId" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,

        PRIMARY KEY ("supervisorId", "ticketId"),
        CONSTRAINT "supervisor_ticket_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "supervisor" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "supervisor_ticket_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "thread" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "channelId" TEXT NOT NULL,
        "projectId" TEXT,
        "refId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "url" TEXT,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL,
        "triage" TEXT NOT NULL DEFAULT 'pending',
        "triagedAt" TEXT,
        CONSTRAINT "thread_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "thread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "trigger" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "channelId" TEXT NOT NULL,
        "threadId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "actorName" TEXT,
        "human" BOOLEAN NOT NULL DEFAULT true,
        "mentioned" BOOLEAN NOT NULL DEFAULT false,
        "text" TEXT NOT NULL,
        "url" TEXT,
        "at" TEXT NOT NULL,
        "ref" TEXT,
        CONSTRAINT "trigger_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "trigger_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "ticket" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "projectId" TEXT NOT NULL,
        "channelId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "description" TEXT,
        "status" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL,
        "startedAt" TEXT,
        "endedAt" TEXT,
        "prUrl" TEXT,
        "prState" TEXT,
        "ciState" TEXT,
        "paused" BOOLEAN NOT NULL DEFAULT false,
        "prepareError" TEXT,
        CONSTRAINT "ticket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "ticket_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "ticket_thread" (
        "ticketId" TEXT NOT NULL,
        "threadId" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,

        PRIMARY KEY ("ticketId", "threadId"),
        CONSTRAINT "ticket_thread_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "ticket_thread_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "ticket_link" (
        "ticketId" TEXT NOT NULL,
        "relatedId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,

        PRIMARY KEY ("ticketId", "relatedId", "kind"),
        CONSTRAINT "ticket_link_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "ticket_link_relatedId_fkey" FOREIGN KEY ("relatedId") REFERENCES "ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    -- CreateTable
    CREATE TABLE "worker" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "ticketId" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,
        "startedAt" TEXT,
        "endedAt" TEXT,
        "title" TEXT,
        "endedReason" TEXT,
        "branch" TEXT,
        "worktree" TEXT,
        "reportState" TEXT,
        "report" TEXT,
        "reportAt" TEXT,
        "backgroundUntil" TEXT,
        "recoveryNote" TEXT,
        CONSTRAINT "worker_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    -- CreateIndex
    CREATE INDEX "channel_account_channelId_role_idx" ON "channel_account"("channelId", "role");

    -- CreateIndex
    CREATE UNIQUE INDEX "channel_account_channelId_role_name_key" ON "channel_account"("channelId", "role", "name");

    -- CreateIndex
    CREATE UNIQUE INDEX "ci_watch_channelId_kind_ref_key" ON "ci_watch"("channelId", "kind", "ref");

    -- CreateIndex
    CREATE INDEX "source_state_updatedAt_idx" ON "source_state"("updatedAt");

    -- CreateIndex
    CREATE INDEX "inbox_type_projectId_status_idx" ON "inbox"("type", "projectId", "status");

    -- CreateIndex
    CREATE INDEX "inbox_type_status_createdAt_idx" ON "inbox"("type", "status", "createdAt");

    -- CreateIndex
    CREATE INDEX "inbox_status_createdAt_idx" ON "inbox"("status", "createdAt");

    -- CreateIndex
    CREATE INDEX "inbox_ticketId_seq_idx" ON "inbox"("ticketId", "seq");

    -- CreateIndex
    CREATE INDEX "inbox_status_nextRetryAt_idx" ON "inbox"("status", "nextRetryAt");

    -- CreateIndex
    CREATE UNIQUE INDEX "project_workspaceId_key" ON "project"("workspaceId");

    -- CreateIndex
    CREATE UNIQUE INDEX "project_channelId_name_key" ON "project"("channelId", "name");

    -- CreateIndex
    CREATE INDEX "supervisor_status_idx" ON "supervisor"("status");

    -- CreateIndex
    CREATE INDEX "supervisor_ticket_ticketId_idx" ON "supervisor_ticket"("ticketId");

    -- CreateIndex
    CREATE INDEX "thread_updatedAt_idx" ON "thread"("updatedAt");

    -- CreateIndex
    CREATE INDEX "thread_projectId_idx" ON "thread"("projectId");

    -- CreateIndex
    CREATE INDEX "thread_triage_idx" ON "thread"("triage");

    -- CreateIndex
    CREATE UNIQUE INDEX "thread_channelId_refId_key" ON "thread"("channelId", "refId");

    -- CreateIndex
    CREATE INDEX "trigger_threadId_at_idx" ON "trigger"("threadId", "at");

    -- CreateIndex
    CREATE INDEX "trigger_channelId_at_idx" ON "trigger"("channelId", "at");

    -- CreateIndex
    CREATE INDEX "trigger_at_idx" ON "trigger"("at");

    -- CreateIndex
    CREATE INDEX "trigger_ref_idx" ON "trigger"("ref");

    -- CreateIndex
    CREATE INDEX "ticket_projectId_status_idx" ON "ticket"("projectId", "status");

    -- CreateIndex
    CREATE INDEX "ticket_status_updatedAt_idx" ON "ticket"("status", "updatedAt");

    -- CreateIndex
    CREATE INDEX "ticket_thread_ticketId_createdAt_idx" ON "ticket_thread"("ticketId", "createdAt");

    -- CreateIndex
    CREATE INDEX "ticket_thread_threadId_idx" ON "ticket_thread"("threadId");

    -- CreateIndex
    CREATE INDEX "ticket_link_relatedId_idx" ON "ticket_link"("relatedId");

    -- CreateIndex
    CREATE INDEX "worker_ticketId_createdAt_idx" ON "worker"("ticketId", "createdAt");

    -- CreateIndex
    CREATE INDEX "worker_status_idx" ON "worker"("status");
  `,
	"20261117170000_project_workspace": `
    -- RedefineTables
    PRAGMA defer_foreign_keys=ON;
    PRAGMA foreign_keys=OFF;
    CREATE TABLE "new_project" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "workspaceId" TEXT NOT NULL,
        "directory" TEXT NOT NULL,
        "remoteUrl" TEXT,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "orchestratorSessionId" TEXT,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
    );
    INSERT INTO "new_project" ("createdAt", "directory", "id", "name", "orchestratorSessionId", "updatedAt", "workspaceId") SELECT "createdAt", "directory", "id", "name", "orchestratorSessionId", "updatedAt", "workspaceId" FROM "project";
    DROP TABLE "project";
    ALTER TABLE "new_project" RENAME TO "project";
    CREATE UNIQUE INDEX "project_workspaceId_key" ON "project"("workspaceId");
    PRAGMA foreign_keys=ON;
    PRAGMA defer_foreign_keys=OFF;
  `,
	"20261124160208_answer_relayed_at": `
    -- AlterTable
    ALTER TABLE "inbox" ADD COLUMN "answerRelayedAt" TEXT;

    -- 已经答过、也早已被消费的历史答案不算待投递：不补这一列，升级后第一轮就会把它们
    -- 当成新答案重新播报一遍。
    UPDATE "inbox" SET "answerRelayedAt" = COALESCE("answeredAt", "doneAt", "createdAt") WHERE "answer" IS NOT NULL;
  `,
	"20261124230000_ticket_stage": `
    -- 票的阶段与官方对齐：waiting 拆成 queued（还没派工）与 idle（跑过一轮、等新触发）。
    -- 有 Worker 记录说明已经派过工，其余是还没派工的新票。
    UPDATE "ticket" SET "status" = 'idle' WHERE "status" = 'waiting' AND EXISTS (SELECT 1 FROM "worker" WHERE "worker"."ticketId" = "ticket"."id");
    UPDATE "ticket" SET "status" = 'queued' WHERE "status" = 'waiting';
  `
};
// src/database/models/channel.ts
var Channel = class extends Model {
	constructor(db) {
		super(db, "channel", "id");
	}
	async saveConfiguration(id, name, host, enabled, metadata, account, hostChanged = false) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		await this.db.transaction().execute(async (trx) => {
			const previous = await trx.selectFrom("channel").selectAll().where("id", "=", id).executeTakeFirst();
			const activation = await trx.selectFrom("source_state").select("name").where("channelId", "=", id).where("name", "=", "activation").executeTakeFirst();
			await trx.insertInto("channel").values({
				id,
				name,
				host,
				enabled: enabled ? 1 : 0,
				createdAt: now
			}).onConflict((oc) => oc.column("id").doUpdateSet({
				name,
				host,
				enabled: enabled ? 1 : 0
			})).execute();
			if (enabled && (!previous?.enabled || hostChanged || !activation)) {
				const observedAt = previous?.enabled && !hostChanged ? previous.createdAt : now;
				await trx.insertInto("source_state").values({
					channelId: id,
					name: "activation",
					value: JSON.stringify(observedAt),
					updatedAt: now
				}).onConflict((oc) => oc.columns(["channelId", "name"]).doUpdateSet({
					value: JSON.stringify(observedAt),
					updatedAt: now
				})).execute();
			}
			await trx.insertInto("source_state").values({
				channelId: id,
				name: "configuration",
				value: JSON.stringify(metadata),
				updatedAt: now
			}).onConflict((oc) => oc.columns(["channelId", "name"]).doUpdateSet({
				value: JSON.stringify(metadata),
				updatedAt: now
			})).execute();
			if (account) {
				await trx.deleteFrom("channel_account").where("channelId", "=", id).where("role", "=", "bot").execute();
				await trx.insertInto("channel_account").values({
					id: `${id}:bot`,
					channelId: id,
					role: "bot",
					name: account.name,
					avatar: account.avatar,
					status: "online",
					createdAt: now
				}).execute();
			}
		});
	}
	async removeCredentials(id) {
		await this.db.transaction().execute(async (trx) => {
			await trx.updateTable("channel").set({ enabled: 0 }).where("id", "=", id).execute();
			await trx.deleteFrom("channel_account").where("channelId", "=", id).where("role", "=", "bot").execute();
			await trx.updateTable("channel_account").set({ status: "offline" }).where("channelId", "=", id).where("role", "=", "admin").execute();
		});
	}
	async findEnabled() {
		return this.db.selectFrom("channel").selectAll().where("enabled", "=", 1).orderBy("id").execute();
	}
	async setEnabled(id, enabled) {
		await this.db.updateTable("channel").set({ enabled: enabled ? 1 : 0 }).where("id", "=", id).execute();
	}
	async findById(id) {
		return this.db.selectFrom("channel").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async listAll() {
		return this.db.selectFrom("channel").selectAll().orderBy("id").execute();
	}
};
// src/database/models/channel-account.ts
var ChannelAccount = class extends Model {
	constructor(db) {
		super(db, "channel_account", "id");
	}
	async findByChannel(channelId) {
		return this.db.selectFrom("channel_account").selectAll().where("channelId", "=", channelId).orderBy("role").orderBy("name").execute();
	}
	async findByRole(channelId, role) {
		return this.db.selectFrom("channel_account").selectAll().where("channelId", "=", channelId).where("role", "=", role).orderBy("name").execute();
	}
	async findByName(channelId, role, name) {
		return this.db.selectFrom("channel_account").selectAll().where("channelId", "=", channelId).where("role", "=", role).where("name", "=", name).executeTakeFirst();
	}
	async setStatus(id, status) {
		await this.db.updateTable("channel_account").set({ status }).where("id", "=", id).execute();
	}
	async findById(id) {
		return this.db.selectFrom("channel_account").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async listAll() {
		return this.db.selectFrom("channel_account").selectAll().orderBy("id").execute();
	}
};
// src/database/models/ci-watch.ts
var CiWatch = class CiWatch extends Model {
	constructor(db) {
		super(db, "ci_watch", "id");
	}
	async findTarget(channelId, kind, ref) {
		return this.db.selectFrom("ci_watch").selectAll().where("channelId", "=", channelId).where("kind", "=", kind).where("ref", "=", ref).executeTakeFirst();
	}
	async listByChannel(channelId) {
		return this.db.selectFrom("ci_watch").selectAll().where("channelId", "=", channelId).orderBy("ref").execute();
	}
	async rotate(id, fingerprint, updatedAt, head = null) {
		await this.db.updateTable("ci_watch").set((eb) => ({
			fingerprint,
			head,
			updatedAt,
			revision: eb("revision", "+", 1)
		})).where("id", "=", id).execute();
	}
	async recordRevision(value) {
		return this.db.transaction().execute(async (trx) => {
			const model = new CiWatch(trx);
			const previous = await model.findTarget(value.channelId, value.kind, value.ref);
			if (!previous) {
				await model.create({
					...value,
					revision: 0
				});
				return {
					row: await model.findTarget(value.channelId, value.kind, value.ref),
					changed: true
				};
			}
			const changed = previous.fingerprint !== value.fingerprint || previous.head !== (value.head ?? null);
			if (changed) await model.rotate(previous.id, value.fingerprint, value.updatedAt, value.head ?? null);
			return {
				row: await model.findTarget(value.channelId, value.kind, value.ref),
				changed
			};
		});
	}
};
// src/database/models/inbox.ts
var Inbox = class Inbox extends Model {
	constructor(db) {
		super(db, "inbox", "id");
	}
	async nextSeq() {
		const row = await this.db.selectFrom("inbox").select(this.db.fn.max("seq").as("max")).executeTakeFirst();
		return Number(row?.max ?? 0) + 1;
	}
	async listPending(type, projectId) {
		const query = this.db.selectFrom("inbox").selectAll().where("type", "=", type).where("status", "=", "pending");
		return (projectId === void 0 ? query : query.where("projectId", "=", projectId)).orderBy("seq").execute();
	}
	async countPending(type, projectId) {
		const query = this.db.selectFrom("inbox").select(this.db.fn.countAll().as("count")).where("type", "=", type).where("status", "=", "pending");
		const row = await (projectId === void 0 ? query : query.where("projectId", "=", projectId)).executeTakeFirst();
		return Number(row?.count ?? 0);
	}
	async listPendingAsk() {
		return this.db.selectFrom("inbox").selectAll().where("type", "=", "user").where("kind", "=", "ask").where("status", "=", "pending").orderBy("createdAt").execute();
	}
	async markRead(ids, readAt) {
		if (ids.length === 0) return;
		await this.db.updateTable("inbox").set({ readAt }).where("id", "in", ids).execute();
	}
	async markDone(id, doneAt) {
		await this.db.updateTable("inbox").set({
			status: "done",
			doneAt
		}).where("id", "=", id).execute();
	}
	async answer(id, answer, answeredBy, answeredAt) {
		await this.db.updateTable("inbox").set({
			answer,
			answeredBy,
			answeredAt,
			status: "done",
			doneAt: answeredAt
		}).where("id", "=", id).execute();
	}
	async recordDeliveryFailure(id, deliveryError, nextRetryAt) {
		await this.db.updateTable("inbox").set((eb) => ({
			deliveryAttempts: eb("deliveryAttempts", "+", 1),
			deliveryError,
			nextRetryAt
		})).where("id", "=", id).execute();
	}
	async resetDelivery(id) {
		await this.db.updateTable("inbox").set({
			deliveryAttempts: 0,
			deliveryError: null,
			nextRetryAt: null
		}).where("id", "=", id).execute();
	}
	async markStalled(id, deliveryError) {
		await this.db.updateTable("inbox").set({
			status: "stalled",
			deliveryError,
			nextRetryAt: null
		}).where("id", "=", id).execute();
	}
	async finishAnswer(id, doneAt) {
		await this.db.updateTable("inbox").set({
			status: "done",
			doneAt,
			answerRelayedAt: doneAt,
			deliveryAttempts: 0,
			deliveryError: null,
			nextRetryAt: null
		}).where("id", "=", id).execute();
	}
	async settleAnswer(id, doneAt) {
		await this.db.updateTable("inbox").set({
			status: "done",
			doneAt,
			answerRelayedAt: doneAt,
			nextRetryAt: null
		}).where("id", "=", id).execute();
	}
	async listRetryable(now) {
		return this.db.selectFrom("inbox").selectAll().where("status", "=", "pending").where("nextRetryAt", "is not", null).where("nextRetryAt", "<=", now).orderBy("nextRetryAt").execute();
	}
	async escalate(id, lastEscalatedAt) {
		await this.db.updateTable("inbox").set((eb) => ({
			escalations: eb("escalations", "+", 1),
			lastEscalatedAt
		})).where("id", "=", id).execute();
	}
	async reassign(id, type, refs = {}) {
		await this.db.updateTable("inbox").set({
			type,
			...refs
		}).where("id", "=", id).execute();
	}
	async findById(id) {
		return this.db.selectFrom("inbox").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async listRecent(limit = 100) {
		return this.db.selectFrom("inbox").selectAll().orderBy("createdAt", "desc").orderBy("id").limit(Math.max(1, Math.min(1e3, limit))).execute();
	}
	/**
	* 这条触发上是否已经有别的角色说过话。
	*
	* 提问不算占位：escalate 出去的提问还在等人回答，后面必然要跟一条结果，两者语义不同，都该出现。
	* 只有已经说出口的结论才占住这次事件。
	*/
	async repliedByOther(threadId, triggerId, role) {
		return await this.db.selectFrom("inbox").select("id").where("threadId", "=", threadId).where("triggerId", "=", triggerId).where("type", "=", "user").where("kind", "=", "notice").where("origin", "!=", role).executeTakeFirst() !== void 0;
	}
	async enqueue(value) {
		if (![
			"user",
			"main",
			"project",
			"supervisor"
		].includes(value.type)) throw new Error("invalid_inbox_recipient");
		const insert = async (trx) => {
			const model = new Inbox(trx);
			if (value.id) {
				const existing = await model.findById(value.id);
				if (existing) return existing;
			}
			const id = value.id ?? randomUUID();
			await model.create({
				id,
				seq: await model.nextSeq(),
				status: "pending",
				createdAt: (/* @__PURE__ */ new Date()).toISOString(),
				projectId: null,
				supervisorId: null,
				title: null,
				doneAt: null,
				deliveryError: null,
				nextRetryAt: null,
				readAt: null,
				lastEscalatedAt: null,
				answer: null,
				answeredBy: null,
				answeredAt: null,
				triggerId: null,
				threadId: null,
				ticketId: null,
				workerId: null,
				...value
			});
			return await model.findById(id);
		};
		return this.db.isTransaction ? insert(this.db) : this.db.transaction().execute(insert);
	}
	async listByTicket(ticketId) {
		return this.db.selectFrom("inbox").selectAll().where("ticketId", "=", ticketId).orderBy("createdAt").orderBy("seq").execute();
	}
	async listScoped(scope) {
		if (![
			"main",
			"project",
			"supervisor"
		].includes(scope.type)) throw new Error("invalid_inbox_recipient");
		const base = () => this.db.selectFrom("inbox").selectAll().where("status", "in", ["pending", "stalled"]);
		const incoming = base().where("type", "=", scope.type);
		const undelivered = base().where("type", "=", "user").where("kind", "=", "notice").where("status", "=", "stalled");
		const [own, failed] = await Promise.all([scope.type === "project" ? incoming.where("projectId", "=", scope.projectId).execute() : scope.type === "supervisor" ? incoming.where("supervisorId", "=", scope.supervisorId).execute() : incoming.execute(), scope.type === "project" ? undelivered.where("projectId", "=", scope.projectId).execute() : scope.type === "supervisor" ? undelivered.where("supervisorId", "=", scope.supervisorId).execute() : undelivered.where("projectId", "is", null).where("supervisorId", "is", null).execute()]);
		return [...own, ...failed].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
	}
	owns(row, scope) {
		if (![
			"main",
			"project",
			"supervisor"
		].includes(scope.type)) return false;
		const scoped = scope.type === "project" ? row.projectId === scope.projectId : scope.type === "supervisor" ? row.supervisorId === scope.supervisorId : true;
		if (row.type === scope.type) return scoped;
		return row.type === "user" && row.kind === "notice" && row.status === "stalled" && scoped && (scope.type !== "main" || row.projectId === null && row.supervisorId === null);
	}
	async completeScoped(ids, scope, now) {
		if (!ids.length) return 0;
		return this.db.transaction().execute(async (trx) => {
			const model = new Inbox(trx);
			const rows = await trx.selectFrom("inbox").selectAll().where("id", "in", [...new Set(ids)]).execute();
			if (rows.length !== new Set(ids).size || rows.some((row) => !model.owns(row, scope))) throw new Error("收件箱不存在或不属于当前身份");
			if (rows.some((row) => row.kind === "ask" && !row.answer)) throw new Error("answer_required");
			const result = await trx.updateTable("inbox").set({
				status: "done",
				doneAt: now
			}).where("id", "in", ids).where("status", "in", ["pending", "stalled"]).executeTakeFirst();
			return Number(result.numUpdatedRows);
		});
	}
	async answerScoped(id, text, scope, now) {
		return this.db.transaction().execute(async (trx) => {
			const model = new Inbox(trx);
			const row = await model.findById(id);
			if (!row || !model.owns(row, scope) || row.kind !== "ask" || row.status === "done") throw new Error("只能回答指向当前身份的 pending ask");
			await model.answer(id, text, scope.type, now);
			return row;
		});
	}
	async escalateScoped(id, scope, now) {
		return this.db.transaction().execute(async (trx) => {
			const model = new Inbox(trx);
			const row = await model.findById(id);
			if (!row || !model.owns(row, scope) || row.kind !== "ask" || row.status === "done") throw new Error("只能升级指向当前身份的 pending ask");
			if (scope.type === "main") throw new Error("主编排应通过 ask_user 询问人，不能自动升级");
			const supervisor = scope.type === "project" && row.ticketId ? await trx.selectFrom("supervisor_ticket").innerJoin("supervisor", "supervisor.id", "supervisor_ticket.supervisorId").select("supervisor.id").where("ticketId", "=", row.ticketId).where("supervisor.status", "=", "active").orderBy("supervisor.createdAt").executeTakeFirst() : void 0;
			await trx.updateTable("inbox").set((eb) => ({
				type: supervisor ? "supervisor" : "main",
				supervisorId: supervisor?.id ?? (row.origin === "supervisor" ? row.supervisorId : null),
				escalations: eb("escalations", "+", 1),
				lastEscalatedAt: now,
				readAt: null
			})).where("id", "=", id).execute();
			return await model.findById(id);
		});
	}
	async answerByUser(id, answer, answeredAt) {
		return this.db.updateTable("inbox").set({
			answer,
			answeredBy: "user",
			answeredAt,
			status: "done",
			doneAt: answeredAt
		}).where("id", "=", id).where("type", "=", "user").where("kind", "=", "ask").where("status", "=", "pending").returningAll().executeTakeFirst();
	}
	async enqueueAnswer(row) {
		if (!row.answer || !row.answeredBy || row.origin !== "main" && row.origin !== "project" && row.origin !== "supervisor") return;
		const origin = row.answeredBy === "user" ? "channel" : row.answeredBy;
		await this.enqueue({
			id: `supermesh:answer:${row.id}`,
			type: row.origin,
			origin,
			kind: "notice",
			title: row.title,
			message: row.answer,
			projectId: row.projectId,
			supervisorId: row.supervisorId,
			ticketId: row.ticketId,
			workerId: row.workerId,
			threadId: row.threadId,
			triggerId: row.triggerId
		});
	}
	/**
	* 还没交出去的答案。
	*
	* 判据是 `answerRelayedAt` 为空，不是「有没有 answer」：答案一写下就已经 done，
	* 按 answer 扫会把历史上所有答过的 ask 每一轮都捞出来重投一遍。
	*/
	async listAnswered() {
		return this.db.selectFrom("inbox").selectAll().where("kind", "=", "ask").where("answer", "is not", null).where("answerRelayedAt", "is", null).where("status", "in", ["done", "stalled"]).orderBy("seq").execute();
	}
	async relayAnswer(id, reason, doneAt) {
		await this.db.transaction().execute(async (trx) => {
			const model = new Inbox(trx);
			const row = await model.findById(id);
			if (!row?.answer || row.answerRelayedAt) return;
			await model.enqueue({
				id: `supermesh:answer-relay:${row.id}`,
				type: row.projectId ? "project" : "main",
				projectId: row.projectId,
				origin: "system",
				kind: "notice",
				ticketId: row.ticketId,
				title: "答案未送达",
				message: `${reason}：${row.answer}`
			});
			await model.settleAnswer(row.id, doneAt);
		});
	}
	async returnPendingTicket(ticketId, reason, now) {
		await this.db.updateTable("inbox").set({
			status: "stalled",
			deliveryError: reason,
			nextRetryAt: null,
			doneAt: now
		}).where("ticketId", "=", ticketId).where("status", "=", "pending").execute();
	}
	async listDelivery() {
		return this.db.selectFrom("inbox").selectAll().where("type", "in", [
			"main",
			"project",
			"supervisor"
		]).where("status", "in", ["pending", "stalled"]).orderBy("seq").execute();
	}
	async listOutgoing() {
		return this.db.selectFrom("inbox").selectAll().where("type", "=", "user").where("triggerId", "is not", null).where("kind", "in", ["notice", "ask"]).where("status", "in", ["pending", "stalled"]).orderBy("seq").execute();
	}
	async enqueueAsk(value) {
		return this.db.transaction().execute(async (trx) => {
			let query = trx.selectFrom("inbox").selectAll().where("kind", "=", "ask").where("status", "=", "pending").where("origin", "=", value.origin);
			if (value.workerId) query = query.where("workerId", "=", value.workerId);
			else if (value.origin === "project" && value.ticketId) query = query.where("projectId", value.projectId ? "=" : "is", value.projectId ?? null).where("ticketId", "=", value.ticketId);
			else query = query.where("projectId", value.projectId ? "=" : "is", value.projectId ?? null).where("supervisorId", value.supervisorId ? "=" : "is", value.supervisorId ?? null).where("triggerId", value.triggerId ? "=" : "is", value.triggerId ?? null).where("message", "=", value.message);
			const pending = await query.executeTakeFirst();
			if (pending) {
				if (pending.message !== value.message) throw new Error(`当前工作线已有 pending ask：${pending.id}`);
				return pending;
			}
			return new Inbox(trx).enqueue({
				...value,
				kind: "ask"
			});
		});
	}
};
// src/database/models/project.ts
var Project = class extends Model {
	constructor(db) {
		super(db, "project", "id");
	}
	async findByWorkspace(workspaceId) {
		return this.db.selectFrom("project").selectAll().where("workspaceId", "=", workspaceId).executeTakeFirst();
	}
	async setOrchestrator(id, orchestratorSessionId, updatedAt) {
		await this.db.updateTable("project").set({
			orchestratorSessionId,
			updatedAt
		}).where("id", "=", id).execute();
	}
	async findById(id) {
		return this.db.selectFrom("project").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async listAll() {
		return this.db.selectFrom("project").selectAll().orderBy("id").execute();
	}
	async findBySession(sessionId) {
		const rows = await this.db.selectFrom("project").selectAll().where("orchestratorSessionId", "=", sessionId).limit(2).execute();
		if (rows.length > 1) throw new Error("session_binding_conflict");
		return rows[0];
	}
	async findByRemote(remoteUrl) {
		return this.db.selectFrom("project").selectAll().where("remoteUrl", "=", remoteUrl).executeTakeFirst();
	}
	async setEnabled(id, enabled, updatedAt) {
		let query = this.db.updateTable("project").set({
			enabled: enabled ? 1 : 0,
			updatedAt
		}).where("id", "=", id);
		if (enabled) query = query.where("remoteUrl", "is not", null).where("remoteUrl", "!=", "");
		return query.returningAll().executeTakeFirst();
	}
	async setRemoteUrl(id, remoteUrl, updatedAt) {
		await this.db.updateTable("project").set({
			remoteUrl,
			updatedAt
		}).where("id", "=", id).execute();
	}
	async disableUnavailable(workspaceIds, updatedAt) {
		let query = this.db.updateTable("project").set({
			enabled: 0,
			updatedAt
		}).where("enabled", "=", 1);
		if (workspaceIds.length) query = query.where("workspaceId", "not in", workspaceIds);
		await query.execute();
	}
	async upsertWorkspace(value, updatedAt) {
		const hasRemote = Boolean(value.remoteUrl?.trim());
		const existing = await this.findByWorkspace(value.workspaceId);
		const remoteUrl = !hasRemote ? null : existing?.remoteUrl?.trim() ? existing.remoteUrl : value.remoteUrl;
		return this.db.insertInto("project").values({
			...value,
			remoteUrl,
			enabled: hasRemote ? 1 : 0,
			orchestratorSessionId: null,
			createdAt: updatedAt,
			updatedAt
		}).onConflict((oc) => oc.column("workspaceId").doUpdateSet({
			name: value.name,
			directory: value.directory,
			remoteUrl,
			...!hasRemote ? { enabled: 0 } : {},
			updatedAt
		})).returningAll().executeTakeFirstOrThrow();
	}
};
// src/database/models/source-state.ts
/**
* 渠道读到哪了：每个需要增量读取的目标一行。
*
* 主键是 `(channelId, name)`，所以不套 `Model` —— 它的按主键操作
* 只接受单个值，用在这里会误删同渠道的其它游标。
*/
var SourceState = class {
	db;
	constructor(db) {
		this.db = db;
	}
	/** 读一个游标；没读过时为空。 */
	async find(channelId, name) {
		return this.db.selectFrom("source_state").selectAll().where("channelId", "=", channelId).where("name", "=", name).executeTakeFirst();
	}
	/** 某渠道的全部游标。 */
	async listByChannel(channelId) {
		return this.db.selectFrom("source_state").selectAll().where("channelId", "=", channelId).orderBy("name").execute();
	}
	/** 按名字后缀取跨渠道状态，例如每个项目最近一次采集结果。 */
	async listBySuffix(suffix) {
		return this.db.selectFrom("source_state").selectAll().where("name", "like", `%:${suffix}`).execute();
	}
	/** 推进游标；不存在则插入。 */
	async set(channelId, name, value, updatedAt) {
		await this.db.insertInto("source_state").values({
			channelId,
			name,
			value,
			updatedAt
		}).onConflict((oc) => oc.columns(["channelId", "name"]).doUpdateSet({
			value,
			updatedAt
		})).execute();
	}
	/** 删一个游标，例如话题已不再会被读取。 */
	async remove(channelId, name) {
		await this.db.deleteFrom("source_state").where("channelId", "=", channelId).where("name", "=", name).execute();
	}
	/**
	* 仓库改名后把旧作用域的游标整体搬到新作用域。
	* 不搬的话采集会从「此刻」重新开始，改名瞬间未采集的增量就永久丢了。
	*/
	async renameScope(channelId, from, to, updatedAt) {
		for (const row of await this.listByChannel(channelId)) {
			if (!row.name.startsWith(`${from}:`)) continue;
			const name = `${to}:${row.name.slice(from.length + 1)}`;
			if (await this.find(channelId, name)) continue;
			await this.set(channelId, name, row.value, updatedAt);
			await this.remove(channelId, row.name);
		}
	}
};
// src/database/models/supervisor.ts
var Supervisor = class extends Model {
	constructor(db) {
		super(db, "supervisor", "id");
	}
	async listActive() {
		return this.db.selectFrom("supervisor").selectAll().where("status", "=", "active").orderBy("createdAt").execute();
	}
	async listByStatus(status) {
		return this.db.selectFrom("supervisor").selectAll().where("status", "=", status).orderBy("createdAt").execute();
	}
	async attachSession(id, sessionId) {
		await this.db.updateTable("supervisor").set({ sessionId }).where("id", "=", id).execute();
	}
	async close(id, closedAt) {
		await this.db.updateTable("supervisor").set({
			status: "closed",
			closedAt
		}).where("id", "=", id).execute();
	}
	async findById(id) {
		return this.db.selectFrom("supervisor").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async findBySession(sessionId) {
		const rows = await this.db.selectFrom("supervisor").selectAll().where("sessionId", "=", sessionId).limit(2).execute();
		if (rows.length > 1) throw new Error("session_binding_conflict");
		return rows[0];
	}
};
// src/database/models/supervisor-ticket.ts
var SupervisorTicket = class {
	db;
	constructor(db) {
		this.db = db;
	}
	async listBySupervisor(supervisorId) {
		return this.db.selectFrom("supervisor_ticket").selectAll().where("supervisorId", "=", supervisorId).orderBy("createdAt").execute();
	}
	async listByTicket(ticketId) {
		return this.db.selectFrom("supervisor_ticket").selectAll().where("ticketId", "=", ticketId).execute();
	}
	async link(supervisorId, ticketId, createdAt) {
		await this.db.insertInto("supervisor_ticket").values({
			supervisorId,
			ticketId,
			createdAt
		}).onConflict((oc) => oc.columns(["supervisorId", "ticketId"]).doNothing()).execute();
	}
	async unlink(supervisorId, ticketId) {
		await this.db.deleteFrom("supervisor_ticket").where("supervisorId", "=", supervisorId).where("ticketId", "=", ticketId).execute();
	}
	async listAll() {
		return this.db.selectFrom("supervisor_ticket").selectAll().orderBy("createdAt").execute();
	}
};
// src/database/models/thread.ts
var Thread = class extends Model {
	constructor(db) {
		super(db, "thread", "id");
	}
	async findByRef(channelId, refId) {
		return this.db.selectFrom("thread").selectAll().where("channelId", "=", channelId).where("refId", "=", refId).executeTakeFirst();
	}
	async listRecent(limit = 50) {
		return this.db.selectFrom("thread").selectAll().orderBy("updatedAt", "desc").limit(limit).execute();
	}
	async touch(id, updatedAt) {
		await this.db.updateTable("thread").set({ updatedAt }).where("id", "=", id).execute();
	}
	/** 只补标题：采集侧新建的占位标题由第一次读到远程详情时替换，不动 updatedAt 的轮询判据。 */
	async setTitle(id, title) {
		await this.db.updateTable("thread").set({ title }).where("id", "=", id).execute();
	}
	async claim(id, projectId, triagedAt) {
		await this.db.updateTable("thread").set({
			projectId,
			triage: "claimed",
			triagedAt
		}).where("id", "=", id).execute();
	}
	/** 采集侧按仓库补归属：只填还没有归属的话题，不覆盖主编排已经写下的结论。 */
	async bindProject(id, projectId) {
		await this.db.updateTable("thread").set({ projectId }).where("id", "=", id).where("projectId", "is", null).execute();
	}
	async ignore(id, triagedAt) {
		await this.db.updateTable("thread").set({
			triage: "ignored",
			triagedAt
		}).where("id", "=", id).execute();
	}
	async findById(id) {
		return this.db.selectFrom("thread").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async record(value) {
		await this.db.insertInto("thread").values(value).onConflict((oc) => oc.column("id").doUpdateSet({
			title: value.title,
			url: value.url,
			updatedAt: value.updatedAt
		})).execute();
		return await this.findById(value.id);
	}
	async listByChannel(channelId) {
		return this.db.selectFrom("thread").selectAll().where("channelId", "=", channelId).orderBy("id").execute();
	}
	async listUnbound(channelId) {
		return this.db.selectFrom("thread").selectAll().where("channelId", "=", channelId).where("projectId", "is", null).orderBy("id").execute();
	}
};
// src/database/models/ticket.ts
const CLOSED_STATUS = [
	"done",
	"completed",
	"cancelled"
];
const closedName = (threadId) => `thread_closed:${threadId}`;
let creation = Promise.resolve();
var Ticket = class Ticket extends Model {
	constructor(db) {
		super(db, "ticket", "id");
	}
	async listByProject(projectId, status) {
		const query = this.db.selectFrom("ticket").selectAll().where("projectId", "=", projectId);
		return (status ? query.where("status", "=", status) : query).orderBy("updatedAt", "desc").execute();
	}
	async listOpen() {
		return this.db.selectFrom("ticket").selectAll().where("status", "not in", [...CLOSED_STATUS]).orderBy("updatedAt", "desc").execute();
	}
	async countRunning() {
		const row = await this.db.selectFrom("ticket").select(this.db.fn.countAll().as("count")).where("status", "=", "running").executeTakeFirst();
		return Number(row?.count ?? 0);
	}
	async start(id, startedAt, updatedAt) {
		await this.db.updateTable("ticket").set({
			status: "running",
			startedAt,
			updatedAt
		}).where("id", "=", id).where("status", "not in", [...CLOSED_STATUS]).where((eb) => eb.or([eb("prState", "is", null), eb("prState", "not in", ["merged", "closed"])])).execute();
	}
	async finish(id, status, endedAt, updatedAt) {
		await this.db.transaction().execute(async (trx) => {
			await trx.updateTable("ticket").set({
				status,
				endedAt,
				updatedAt,
				prepareError: null
			}).where("id", "=", id).execute();
			await trx.updateTable("inbox").set({
				status: "done",
				doneAt: endedAt
			}).where("ticketId", "=", id).where("kind", "=", "ask").where("status", "in", ["pending", "stalled"]).execute();
		});
	}
	/** 按已挂上的变更请求反查票：采集侧靠它把 PR 话题接回票，不再依赖分支名。 */
	async listByPullRequest(projectId, prUrl) {
		return this.db.selectFrom("ticket").selectAll().where("projectId", "=", projectId).where("prUrl", "=", prUrl).execute();
	}
	/** 票是否已经归属某个变更请求：prUrl 或任一 PR 话题都算。ready 时据此决定 review 还是 completed。 */
	async hasPullRequest(id) {
		const ticket = await this.findById(id);
		if (!ticket) return false;
		return Boolean(ticket.prUrl) || (await this.pullThreads(id)).length > 0;
	}
	async setPullRequest(id, prUrl, prState, ciState) {
		await this.db.updateTable("ticket").set({
			prUrl,
			prState,
			ciState
		}).where("id", "=", id).execute();
	}
	async setPaused(id, paused, updatedAt) {
		await this.db.updateTable("ticket").set({
			paused: paused ? 1 : 0,
			updatedAt
		}).where("id", "=", id).execute();
	}
	async setPrepareError(id, prepareError, updatedAt) {
		await this.db.updateTable("ticket").set({
			prepareError,
			updatedAt
		}).where("id", "=", id).where("status", "not in", [...CLOSED_STATUS]).execute();
	}
	/**
	* 内部调度推进票的状态。票进了终态就不能再被后台路径写回非终态：
	* 停止是人的决定，派工、回收、结算都不能把它重新拉起。
	*
	* @returns 是否真的写入了（票已结束时为 false）。
	*/
	async setOpenStatus(id, status, updatedAt) {
		const result = await this.db.updateTable("ticket").set({
			status,
			updatedAt
		}).where("id", "=", id).where("status", "not in", [...CLOSED_STATUS]).executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}
	async save(id, patch) {
		await this.db.updateTable("ticket").set(patch).where("id", "=", id).execute();
	}
	async findById(id) {
		return this.db.selectFrom("ticket").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async listRecent(limit = 100) {
		return this.db.selectFrom("ticket").selectAll().orderBy("createdAt", "desc").orderBy("id").limit(Math.max(1, Math.min(1e3, limit))).execute();
	}
	findManyQuery() {
		return this.db.selectFrom("ticket").selectAll().orderBy("createdAt", "desc").orderBy("id");
	}
	async findManyPage(page = 1, pageSize = 8) {
		const size = Math.max(1, Math.min(100, pageSize));
		const offset = (Math.max(1, page) - 1) * size;
		const base = this.findManyQuery();
		const [counted, data] = await Promise.all([base.clearSelect().select(this.db.fn.count("ticket.id").as("count")).executeTakeFirst(), base.limit(size).offset(offset).execute()]);
		return {
			data,
			total: Number(counted?.count ?? 0)
		};
	}
	/** 全量票，供统计类接口使用；不受分页上限影响。 */
	async listAll() {
		return this.findManyQuery().execute();
	}
	async listFiltered(filters = {}) {
		let query = this.db.selectFrom("ticket").selectAll("ticket").select((eb) => eb.exists(eb.selectFrom("inbox").select("id").whereRef("inbox.ticketId", "=", "ticket.id").where("kind", "=", "ask").where("inbox.status", "=", "pending")).as("attention"));
		if (filters.projectId) query = query.where("ticket.projectId", "=", filters.projectId);
		if (filters.status) query = query.where("ticket.status", "=", filters.status);
		else query = query.where("ticket.status", "not in", [...CLOSED_STATUS]);
		if (filters.attentionOnly) query = query.where((eb) => eb.exists(eb.selectFrom("inbox").select("id").whereRef("inbox.ticketId", "=", "ticket.id").where("kind", "=", "ask").where("inbox.status", "=", "pending")));
		if (filters.supervisorId) query = query.where((eb) => eb.exists(eb.selectFrom("supervisor_ticket").select("ticketId").whereRef("supervisor_ticket.ticketId", "=", "ticket.id").where("supervisorId", "=", filters.supervisorId)));
		return query.orderBy("ticket.createdAt").orderBy("ticket.id").execute();
	}
	async createWithThreads(projectId, title, threadIds, description) {
		if (!threadIds.length) throw new Error("至少需要一条来源话题");
		const operation = creation.then(() => this.db.transaction().execute(async (trx) => {
			if (!await trx.selectFrom("project").selectAll().where("id", "=", projectId).executeTakeFirst()) throw new Error("项目不存在");
			const ids = [...new Set(threadIds)];
			const threads = await trx.selectFrom("thread").selectAll().where("id", "in", ids).execute();
			if (threads.length !== ids.length) throw new Error("来源话题不存在");
			const duplicate = await trx.selectFrom("ticket_thread").innerJoin("ticket", "ticket.id", "ticket_thread.ticketId").select("ticket_thread.ticketId").where("ticket_thread.threadId", "in", ids).where("ticket.projectId", "=", projectId).executeTakeFirst();
			if (duplicate) throw new Error(`来源话题已关联工单：${duplicate.ticketId}`);
			const now = (/* @__PURE__ */ new Date()).toISOString();
			let sequence = (await trx.selectFrom("ticket").select("id").execute()).reduce((max, row) => {
				const match = /^T-(\d+)$/.exec(row.id);
				return match ? Math.max(max, Number(match[1])) : max;
			}, 0);
			let id = `T-${String(sequence + 1).padStart(3, "0")}`;
			while (await trx.selectFrom("ticket").select("id").where("id", "=", id).executeTakeFirst()) {
				sequence++;
				id = `T-${String(sequence + 1).padStart(3, "0")}`;
			}
			const row = {
				id,
				projectId,
				channelId: threads.find((row) => row.id === ids[0]).channelId,
				title,
				description: description ?? null,
				status: "queued",
				createdAt: now,
				updatedAt: now,
				startedAt: null,
				endedAt: null,
				prUrl: null,
				prState: null,
				ciState: null,
				prepareError: null
			};
			await trx.insertInto("ticket").values(row).execute();
			await trx.updateTable("thread").set({
				projectId,
				triage: "claimed",
				triagedAt: now
			}).where("id", "in", ids).where("triage", "=", "pending").execute();
			for (const [index, threadId] of ids.entries()) await trx.insertInto("ticket_thread").values({
				ticketId: id,
				threadId,
				createdAt: new Date(Date.parse(now) + index).toISOString()
			}).execute();
			return await new Ticket(trx).findById(id);
		}));
		creation = operation.catch(() => void 0);
		return operation;
	}
	async requireOpen(id, projectId) {
		const row = await this.findById(id);
		if (!row || projectId !== void 0 && row.projectId !== projectId) throw new Error("工单不存在或不属于当前项目");
		if (CLOSED_STATUS.includes(row.status)) throw new Error("工单已结束");
		return row;
	}
	/**
	* 人在这条话题上又说话了，把做完的票唤醒。
	* 人叫停的票不在此列 —— 停止是人的决定，那里的新活要重新分诊，不能被一句 @ 唤醒。
	*
	* @returns 是否真的唤醒（票不是 done / completed 时为 false）。
	*/
	async revive(id, updatedAt) {
		const result = await this.db.updateTable("ticket").set({
			status: "queued",
			endedAt: null,
			updatedAt
		}).where("id", "=", id).where("status", "in", ["done", "completed"]).executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}
	async closeThread(threadId, outcome, at) {
		const thread = await this.db.selectFrom("thread").selectAll().where("id", "=", threadId).executeTakeFirst();
		if (!thread?.url || thread.kind !== "pull") return [];
		await this.threadClosed(thread, outcome, at);
		const ended = [];
		for (const { ticketId } of await this.db.selectFrom("ticket_thread").select("ticketId").where("threadId", "=", threadId).orderBy("createdAt").execute()) {
			const row = await this.findById(ticketId);
			if (!row || CLOSED_STATUS.includes(row.status)) continue;
			if (row.prUrl && row.prUrl !== thread.url) continue;
			if (row.prUrl === thread.url) await this.setPullRequest(ticketId, thread.url, outcome, row.ciState);
			const ticket = await this.findById(ticketId);
			const closed = await this.followsDone(ticket);
			if (!closed || await this.unfinished(ticketId, at)) continue;
			await this.end(ticket, closed.outcome, closed.at);
			ended.push(ticketId);
		}
		return ended;
	}
	async endOnReport(ticketId, at) {
		const ticket = await this.findById(ticketId);
		if (!ticket || CLOSED_STATUS.includes(ticket.status)) return false;
		const closed = await this.followsDone(ticket);
		if (!closed) return false;
		await this.end(ticket, closed.outcome, at);
		return true;
	}
	async end(ticket, outcome, at) {
		await this.finish(ticket.id, "done", at, (/* @__PURE__ */ new Date()).toISOString());
		const message = `${ticket.id} 的变更请求已${outcome === "merged" ? "合并" : "关闭"}：${ticket.prUrl ?? ticket.id}`;
		for (const type of ["project", "main"]) await new Inbox(this.db).enqueue({
			id: `supermesh:${outcome}:${ticket.id}:${type}`,
			type,
			origin: "system",
			kind: "notice",
			projectId: ticket.projectId,
			ticketId: ticket.id,
			title: outcome === "merged" ? "PR merged" : "PR closed",
			message
		});
	}
	async threadClosed(thread, outcome, at) {
		const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		const value = JSON.stringify({
			at,
			outcome
		});
		await this.db.insertInto("source_state").values({
			channelId: thread.channelId,
			name: closedName(thread.id),
			value,
			updatedAt
		}).onConflict((oc) => oc.columns(["channelId", "name"]).doUpdateSet({
			value,
			updatedAt
		})).execute();
	}
	async followsDone(ticket) {
		const threads = await this.pullThreads(ticket.id);
		const own = threads.filter((thread) => thread.url === ticket.prUrl);
		const counted = own.length ? own : threads;
		if (!counted.length) return void 0;
		const closes = [];
		for (const thread of counted) {
			const closed = await this.threadClosedAt(thread);
			if (!closed) return void 0;
			closes.push(closed);
		}
		return closes.sort((left, right) => left.at.localeCompare(right.at)).at(-1);
	}
	async threadClosedAt(thread) {
		const row = await this.db.selectFrom("source_state").select("value").where("channelId", "=", thread.channelId).where("name", "=", closedName(thread.id)).executeTakeFirst();
		return row ? JSON.parse(row.value) : void 0;
	}
	async pullThreads(ticketId) {
		return this.db.selectFrom("ticket_thread").innerJoin("thread", "thread.id", "ticket_thread.threadId").selectAll("thread").where("ticket_thread.ticketId", "=", ticketId).where("thread.kind", "=", "pull").orderBy("ticket_thread.createdAt").execute();
	}
	async unfinished(ticketId, at) {
		const worker = await this.latestWorker(ticketId);
		if (!worker || !((worker.startedAt ?? worker.createdAt) > at)) return false;
		return !["ready", "dropped"].includes(worker.reportState ?? "");
	}
	async latestWorker(ticketId) {
		return this.db.selectFrom("worker").selectAll().where("ticketId", "=", ticketId).orderBy("createdAt", "desc").orderBy("id", "desc").executeTakeFirst();
	}
	async setPausedIfOpen(id, paused, updatedAt) {
		return this.db.updateTable("ticket").set({
			paused: paused ? 1 : 0,
			updatedAt
		}).where("id", "=", id).where("status", "not in", [...CLOSED_STATUS]).returningAll().executeTakeFirst();
	}
};
// src/database/models/ticket-link.ts
var TicketLink = class {
	db;
	constructor(db) {
		this.db = db;
	}
	async listByTicket(ticketId) {
		return this.db.selectFrom("ticket_link").selectAll().where("ticketId", "=", ticketId).orderBy("kind").orderBy("relatedId").execute();
	}
	async listByRelated(relatedId) {
		return this.db.selectFrom("ticket_link").selectAll().where("relatedId", "=", relatedId).orderBy("kind").orderBy("ticketId").execute();
	}
	async listDependsOn(ticketId) {
		return this.db.selectFrom("ticket_link").selectAll().where("ticketId", "=", ticketId).where("kind", "=", "depends").execute();
	}
	async link(ticketId, relatedId, kind, createdAt) {
		await this.db.insertInto("ticket_link").values({
			ticketId,
			relatedId,
			kind,
			createdAt
		}).onConflict((oc) => oc.columns([
			"ticketId",
			"relatedId",
			"kind"
		]).doNothing()).execute();
	}
	async unlink(ticketId, relatedId, kind) {
		await this.db.deleteFrom("ticket_link").where("ticketId", "=", ticketId).where("relatedId", "=", relatedId).where("kind", "=", kind).execute();
	}
	async listAll() {
		return this.db.selectFrom("ticket_link").selectAll().orderBy("createdAt").execute();
	}
};
// src/database/models/ticket-thread.ts
var TicketThread = class {
	db;
	constructor(db) {
		this.db = db;
	}
	async listByTicket(ticketId) {
		return this.db.selectFrom("ticket_thread").selectAll().where("ticketId", "=", ticketId).orderBy("createdAt").execute();
	}
	async listByThread(threadId) {
		return this.db.selectFrom("ticket_thread").selectAll().where("threadId", "=", threadId).orderBy("createdAt").execute();
	}
	async listTicketIds(threadId) {
		return (await this.db.selectFrom("ticket_thread").select("ticketId").where("threadId", "=", threadId).orderBy("createdAt").execute()).map((row) => row.ticketId);
	}
	async link(ticketId, threadId, createdAt) {
		const result = await this.db.insertInto("ticket_thread").values({
			ticketId,
			threadId,
			createdAt
		}).onConflict((oc) => oc.columns(["ticketId", "threadId"]).doNothing()).executeTakeFirst();
		return Number(result.numInsertedOrUpdatedRows) > 0;
	}
	async unlink(ticketId, threadId) {
		await this.db.deleteFrom("ticket_thread").where("ticketId", "=", ticketId).where("threadId", "=", threadId).execute();
	}
	async listAll() {
		return this.db.selectFrom("ticket_thread").selectAll().orderBy("createdAt").execute();
	}
};
// src/database/models/trigger.ts
var Trigger = class extends Model {
	constructor(db) {
		super(db, "trigger", "id");
	}
	async listByThread(threadId, limit = 50) {
		return this.db.selectFrom("trigger").selectAll().where("threadId", "=", threadId).orderBy("at", "desc").orderBy("id", "desc").limit(limit).execute();
	}
	async lastByThread(threadId) {
		return this.db.selectFrom("trigger").selectAll().where("threadId", "=", threadId).orderBy("at", "desc").orderBy("id", "desc").executeTakeFirst();
	}
	async listByChannelSince(channelId, since) {
		return this.db.selectFrom("trigger").selectAll().where("channelId", "=", channelId).where("at", ">", since).orderBy("at").execute();
	}
	async listByRef(channelId, ref) {
		return this.db.selectFrom("trigger").selectAll().where("channelId", "=", channelId).where("ref", "=", ref).orderBy("at", "desc").execute();
	}
	async exists(id) {
		return await this.db.selectFrom("trigger").select("id").where("id", "=", id).executeTakeFirst() !== void 0;
	}
	async findById(id) {
		return this.db.selectFrom("trigger").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async findLatestByThread(threadId) {
		return this.db.selectFrom("trigger").selectAll().where("threadId", "=", threadId).orderBy("at", "desc").orderBy("id", "desc").executeTakeFirst();
	}
	async listRecent(limit = 100) {
		return this.db.selectFrom("trigger").selectAll().orderBy("at", "desc").orderBy("id").limit(Math.max(1, Math.min(1e3, limit))).execute();
	}
	/**
	* 同一条消息会被编辑：id 不变，正文、点名和时间都会变。
	* 重读时按最新事实覆盖，否则「先发评论、再补一句 @bot」会永久停在没点名的旧判定上，
	* 建票和回复两道闸都读这一行，会一起把人挡在外面。
	*/
	async ingest(value) {
		await this.db.insertInto("trigger").values(value).onConflict((oc) => oc.column("id").doUpdateSet({
			actorName: value.actorName ?? null,
			human: value.human ?? 1,
			mentioned: value.mentioned ?? 0,
			text: value.text,
			url: value.url ?? null,
			at: value.at,
			ref: value.ref ?? null
		})).execute();
		return await this.findById(value.id);
	}
};
// src/database/models/worker.ts
var Worker = class Worker extends Model {
	constructor(db) {
		super(db, "worker", "id");
	}
	async listByTicket(ticketId) {
		return this.db.selectFrom("worker").selectAll().where("ticketId", "=", ticketId).orderBy("createdAt").execute();
	}
	async listRunning() {
		return this.db.selectFrom("worker").selectAll().where("status", "=", "running").orderBy("startedAt").execute();
	}
	async findRunningByBranch(branch) {
		return this.db.selectFrom("worker").selectAll().where("branch", "=", branch).where("status", "=", "running").executeTakeFirst();
	}
	async start(id, startedAt) {
		await this.db.updateTable("worker").set((eb) => ({
			status: "running",
			startedAt: eb.fn.coalesce("startedAt", eb.val(startedAt))
		})).where("id", "=", id).execute();
	}
	async end(id, endedReason, endedAt) {
		await this.db.updateTable("worker").set({
			status: "ended",
			endedReason,
			endedAt
		}).where("id", "=", id).execute();
	}
	async setReport(id, reportState, report, reportAt) {
		await this.db.updateTable("worker").set({
			reportState,
			report,
			reportAt
		}).where("id", "=", id).execute();
	}
	async setBackgroundUntil(id, backgroundUntil) {
		await this.db.updateTable("worker").set({ backgroundUntil }).where("id", "=", id).execute();
	}
	async setRecoveryNote(id, recoveryNote) {
		await this.db.updateTable("worker").set({ recoveryNote }).where("id", "=", id).execute();
	}
	async findById(id) {
		return this.db.selectFrom("worker").selectAll().where("id", "=", id).executeTakeFirst();
	}
	async listRecent(limit = 100) {
		return this.db.selectFrom("worker").selectAll().orderBy("createdAt", "desc").orderBy("id").limit(Math.max(1, Math.min(1e3, limit))).execute();
	}
	async listQueued() {
		return this.db.selectFrom("worker").selectAll().where("status", "=", "queued").orderBy("createdAt").execute();
	}
	/**
	* 把票放进派工队列。`fresh` 为真时新建一个 worker 记录（沿用原分支与 worktree），
	* 用于旧会话已被归档、无法再激活的情形 —— 那时复用同一个 id 只会一直失败。
	*/
	async queue(ticketId, projectId, branch, fresh = false) {
		if (branch && !/^[\w./-]+$/.test(branch)) throw new Error("分支名只能是 ASCII");
		return this.db.transaction().execute(async (trx) => {
			const ticket = await trx.selectFrom("ticket").selectAll().where("id", "=", ticketId).where("projectId", "=", projectId).executeTakeFirst();
			if (!ticket || [
				"done",
				"completed",
				"cancelled"
			].includes(ticket.status)) throw new Error("工单不存在、已结束或不属于当前项目");
			if (ticket.paused) throw new Error("工单已暂停");
			if (!(await trx.selectFrom("project").selectAll().where("id", "=", projectId).executeTakeFirst())?.enabled) throw new Error("项目未启用");
			const depends = await trx.selectFrom("ticket_link").select("relatedId").where("ticketId", "=", ticketId).where("kind", "=", "depends").execute();
			for (const link of depends) {
				const related = await trx.selectFrom("ticket").select(["id", "status"]).where("id", "=", link.relatedId).executeTakeFirst();
				if (related && ![
					"done",
					"completed",
					"cancelled"
				].includes(related.status)) throw new Error(`依赖的 ${related.id} 还没完成`);
			}
			const existing = await trx.selectFrom("worker").selectAll().where("ticketId", "=", ticketId).where("status", "!=", "ended").executeTakeFirst();
			if (existing) return existing;
			const previous = await trx.selectFrom("worker").selectAll().where("ticketId", "=", ticketId).orderBy("createdAt", "desc").orderBy("id", "desc").executeTakeFirst();
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const queued = await trx.updateTable("ticket").set({
				status: "queued",
				prepareError: null,
				updatedAt: now
			}).where("id", "=", ticketId).where("status", "not in", [
				"done",
				"completed",
				"cancelled"
			]).executeTakeFirst();
			if (!Number(queued.numUpdatedRows ?? 0)) throw new Error("工单已结束");
			if (previous && !fresh) {
				await trx.updateTable("worker").set({
					status: "queued",
					startedAt: null,
					endedAt: null,
					endedReason: null,
					reportState: null,
					report: null,
					reportAt: null,
					backgroundUntil: null,
					recoveryNote: null,
					branch: branch ?? previous.branch
				}).where("id", "=", previous.id).execute();
				return await new Worker(trx).findById(previous.id);
			}
			const id = randomUUID();
			await trx.insertInto("worker").values({
				id,
				ticketId,
				status: "queued",
				createdAt: now,
				startedAt: null,
				endedAt: null,
				title: ticket.title,
				endedReason: null,
				branch: branch ?? previous?.branch ?? null,
				worktree: previous?.worktree ?? null,
				reportState: null,
				report: null,
				reportAt: null,
				backgroundUntil: null,
				recoveryNote: null
			}).execute();
			return await new Worker(trx).findById(id);
		});
	}
	async requeue(id) {
		await this.db.updateTable("worker").set({
			status: "queued",
			startedAt: null,
			endedAt: null,
			endedReason: null,
			reportState: null,
			report: null,
			reportAt: null,
			backgroundUntil: null
		}).where("id", "=", id).execute();
	}
	async reportProgress(id, reportState, report) {
		await this.db.transaction().execute(async (trx) => {
			const worker = await new Worker(trx).findById(id);
			if (!worker || worker.status === "ended") throw new Error("Worker 已结束或不存在");
			const ticket = await trx.selectFrom("ticket").selectAll().where("id", "=", worker.ticketId).executeTakeFirst();
			if (!ticket || [
				"done",
				"completed",
				"cancelled"
			].includes(ticket.status)) throw new Error("工单已结束或不存在");
			const now = (/* @__PURE__ */ new Date()).toISOString();
			await new Worker(trx).setReport(id, reportState, report, now);
			if (reportState === "ready") await new Ticket(trx).endOnReport(ticket.id, now);
		});
	}
};
// src/database/utils/migration.ts
/**
* 把 SQL 文本包成 Kysely 迁移。
*
* 两个坑都在这里绕开：
* 1. Kysely 的 SQLite 适配器用 `prepare()` 执行，多语句**不报错、只跑第一条**，
*    所以改用 `DatabaseSync.exec()`，让 SQLite 自己解析整段脚本。
* 2. 适配器的 `supportsTransactionalDdl` 为 false，迁移不会被自动包进事务，
*    所以这里手动 BEGIN/COMMIT，一个迁移文件要么整篇生效、要么整篇回滚。
*
* 没有用 `kysely-migrate-sql`：它 0.2.0 从 `kysely` 根导入 `Migrator`，
* 而 Kysely 0.29 起该导出只在 `kysely/migration`，模块加载即抛
* `SyntaxError: does not provide an export named 'Migrator'`。
*/
var MigrationProvider = class {
	database;
	migrations;
	/**
	* @param database - 执行迁移的连接；必须与实际使用的同一个实例。
	* @param migrations - 迁移名到 SQL 全文的映射，按名字排序执行。
	*/
	constructor(database, migrations) {
		this.database = database;
		this.migrations = migrations;
	}
	async getMigrations() {
		return Object.fromEntries(Object.entries(this.migrations).map(([name, sql]) => [name, { up: async () => {
			const foreignKeys = this.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
			this.database.exec("PRAGMA foreign_keys=OFF");
			this.database.exec("BEGIN");
			try {
				this.database.exec(sql);
				if (this.database.prepare("PRAGMA foreign_key_check").all().length) throw new Error(`Migration violates foreign key constraints: ${name}`);
				this.database.exec("COMMIT");
			} catch (error) {
				this.database.exec("ROLLBACK");
				throw error;
			} finally {
				this.database.exec(foreignKeys ? "PRAGMA foreign_keys=ON" : "PRAGMA foreign_keys=OFF");
			}
		} }]));
	}
};
// src/database/index.ts
const worker$1 = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID;
const name = worker$1 ? `data.worker-${worker$1}.db` : "data.db";
const file = worker$1 ? name : join(DSH_PLUGIN_HOME, name);
if (!worker$1) {
	mkdirSync(DSH_PLUGIN_HOME, { recursive: true });
	const legacy = join(process.cwd(), name);
	if (!existsSync(file) && existsSync(legacy)) copyFileSync(legacy, file);
}
const database = new DatabaseSync(file);
const connection = new Kysely({ dialect: new NodeSqliteDialect({ database }) });
const db = Object.assign(connection, {
	channel: new Channel(connection),
	channelAccount: new ChannelAccount(connection),
	ciWatch: new CiWatch(connection),
	inbox: new Inbox(connection),
	project: new Project(connection),
	sourceState: new SourceState(connection),
	supervisor: new Supervisor(connection),
	supervisorTicket: new SupervisorTicket(connection),
	thread: new Thread(connection),
	ticket: new Ticket(connection),
	ticketLink: new TicketLink(connection),
	ticketThread: new TicketThread(connection),
	trigger: new Trigger(connection),
	worker: new Worker(connection)
});
const { error } = await new Migrator({
	db,
	provider: new MigrationProvider(database, migrations)
}).migrateToLatest();
if (error) throw error;
// src/channel/_shared/admission.ts
/**
* 准入只回答「这条消息能不能进流程」，强度回答「它算不算开工请求」。
* 订阅话题上的消息按官方语义绕过准入：不查 @、不查发送者、不受 inferred 档位影响，只排除我们自己发的那条。
* 没 @ bot 的消息最多是 inferred 候选，只有管理员点名或已订阅话题上的跟进才是 explicit。
* 自己新开的 issue 是 self：只说明这是自己在别的仓库开的活，不表示有人批准过。
*/
function channelTriggerStrength(input) {
	const outcome = evaluate(input);
	return "strength" in outcome ? outcome.strength : null;
}
/** 被准入拒绝的原因码，用于把「消息被静默丢弃」变成可诊断的痕迹。 */
function channelTriggerRejection(input) {
	const outcome = evaluate(input);
	return "reason" in outcome ? outcome.reason : null;
}
function evaluate(input) {
	if (input.self) return input.kind === "open" && input.issue && !input.subscribed ? { strength: "self" } : { reason: "self_actor" };
	if (input.subscribed) return { strength: input.human && input.admin ? "explicit" : "inferred" };
	if (!input.human) return { reason: "bot_actor" };
	if (input.historical) return { reason: "historical" };
	if (!input.admin) return { reason: "not_administrator" };
	if (input.ignored && !input.mentioned) return { reason: "ignored_thread" };
	if (input.mentioned) return { strength: "explicit" };
	return input.kind === "open" && input.inferred !== "off" ? { strength: "inferred" } : { reason: "not_mentioned" };
}
/** 已投递的触发按当前事实判强度，供收件箱与建票闸使用；机器人不授予开工权限，只有自己新开的 issue 例外（self）。 */
function triggerStrengthOf(input) {
	if (input.self) return input.kind === "open" && input.issue && !input.subscribed ? "self" : "inferred";
	return input.human && input.admin && (input.mentioned || input.subscribed) ? "explicit" : "inferred";
}
/**
* 建票闸挑触发：先按发生时间，同一时刻优先真正点名的那条。
* issue 正文和它的评论可能落在同一秒，不点名的那条不是开工请求。
*/
function latestTrigger(rows) {
	const human = rows.filter((row) => row.human === 1);
	return [...human.length ? human : rows].sort((left, right) => right.at.localeCompare(left.at) || right.mentioned - left.mentioned || right.id.localeCompare(left.id))[0];
}
/** 建票闸：没有触发来源（人工建票）放行，inferred 候选只有 auto 模式才允许开票；self 是自己开的活，不等于 explicit，也不受 inferred 档位限制。 */
function ticketAllowed(strength, inferred) {
	return strength !== "inferred" || inferred === "auto";
}
/**
* 进流程不等于被点名。没 @ bot 的消息只是时间线记录：可以分诊，但不建票、不派工、也不在渠道上发言。
* 只有明确 @、或者这条话题已经被票订阅（人在跟进已有任务）才算在跟 bot 说话。
*/
function addressedToBot(input) {
	return input.mentioned || input.subscribed;
}
// src/runtime/singlet.ts
const pending = /* @__PURE__ */ new Map();
/** 超过这个时长还占着 key 的，视为卡死：不再复用它的 Promise，改为重新执行。 */
const STALE_MS = 12e4;
function resolveKey(keyOrGen, args) {
	return typeof keyOrGen === "function" ? keyOrGen(...args) : keyOrGen;
}
/**
* 【单飞原语】同一 key 正在执行时复用同一个 Promise，不排队、不阻塞调用方。
*
* 超过 `STALE_MS` 仍未结束的记录判定为卡死并让位：新调用重新执行，
* 而不是继续等一个可能永不 settle 的 Promise。原任务之后才结束时，
* 它的 settle 不会误删新记录（按记录身份比对）。
*
* @param keyOrGen 静态 key 或按入参生成 key 的函数
* @param fn 需要单飞保护的异步函数
*
* @example
* export const worker = defineService({
*   reconcile: singlet('worker:slots', async () => {
*     await db.worker.listRunning()
*   }),
*   process: singlet(id => `worker:process:${id}`, async (id: string) => {
*     await runFor(id)
*   }),
* })
*/
function singlet(keyOrGen, fn) {
	return ((...args) => {
		const key = resolveKey(keyOrGen, args);
		const current = pending.get(key);
		if (current && Date.now() - current.startedAt < 12e4) return current.promise;
		const task = Promise.resolve().then(() => fn(...args));
		const record = {
			promise: task,
			startedAt: Date.now(),
			key
		};
		pending.set(key, record);
		const settle = () => {
			if (pending.get(key) === record) pending.delete(key);
		};
		task.then(settle, settle);
		return task;
	});
}
/** 立即执行一次，等价于 `singlet(key, fn)(...args)`，省掉尾随的调用括号。 */
singlet.immediate = function immediate(keyOrGen, fn, ...args) {
	return singlet(keyOrGen, fn)(...args);
};
singlet.busy = function busy(key) {
	return key === void 0 ? pending.size > 0 : pending.has(key);
};
singlet.keys = function keys() {
	return [...pending.keys()];
};
/** 卡住超过 `STALE_MS` 的 key 与已运行时长，用于排查采集或投递停摆。 */
singlet.stale = function stale() {
	const now = Date.now();
	return [...pending.values()].map((record) => ({
		key: record.key,
		runningMs: now - record.startedAt
	})).filter((record) => record.runningMs >= STALE_MS);
};
singlet.drain = async function drain() {
	while (pending.size) await Promise.allSettled([...pending.values()].map((record) => record.promise));
};
// src/server/routes/agent.model.catalog.get.ts
var agent_model_catalog_get_default = defineHandler(async () => {
	return getServerContext(server).sessionController.modelCatalog();
});
// src/storage/index.ts
const storage = createStorage({ driver: fs({
	atomic: true,
	base: DSH_PLUGIN_HOME
}) });
// src/utils/service.ts
function defineService(service) {
	return service;
}
// src/service/setting.ts
const defaults = {
	models: {
		main: null,
		manager: null,
		project: null,
		worker: null,
		supervisor: null
	},
	administrators: [],
	inferred: "observe",
	maxWorkers: 10,
	backgroundLimitMinutes: 30,
	autoMerge: false,
	autoMergeMaxLines: 200,
	autoArchiveWorkers: false,
	deliveryMaxAttempts: 3,
	deliveryRetryCeilingSeconds: 60,
	updatedAt: ""
};
const limits = {
	maxWorkers: [1, 16],
	backgroundLimitMinutes: [1, 1440],
	autoMergeMaxLines: [1, 1e4],
	deliveryMaxAttempts: [1, 20],
	deliveryRetryCeilingSeconds: [2, 3600]
};
const roles$1 = [
	"main",
	"manager",
	"project",
	"worker",
	"supervisor"
];
let writing$2 = Promise.resolve();
const setting = defineService({
	async load() {
		const value = await storage.getItem("setting.json");
		if (value === null) return {
			...defaults,
			administrators: []
		};
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_stored_settings");
		const { updatedAt, ...patch } = value;
		if (updatedAt !== void 0 && typeof updatedAt !== "string" || !valid(patch, true)) throw new Error("invalid_stored_settings");
		return {
			...defaults,
			...patch,
			administrators: normalizeAdministrators(patch.administrators ?? []),
			models: normalizeModels(patch.models),
			...updatedAt === void 0 ? {} : { updatedAt }
		};
	},
	save(patch) {
		if (!valid(patch)) return Promise.reject(/* @__PURE__ */ new TypeError("invalid_config"));
		const updates = {
			...patch,
			...patch.administrators === void 0 ? {} : { administrators: normalizeAdministrators(patch.administrators) },
			...patch.models === void 0 ? {} : { models: normalizeModels(patch.models) }
		};
		const operation = writing$2.then(async () => {
			const next = {
				...await setting.load(),
				...updates,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			await storage.setItem("setting.json", next);
			return next;
		});
		writing$2 = operation.then(() => void 0, () => void 0);
		return operation;
	}
});
function valid(value, allowEmpty = false) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entries = Object.entries(value);
	if (!allowEmpty && entries.length === 0) return false;
	return entries.every(([key, entry]) => {
		if (key === "administrators") return Array.isArray(entry) && entry.length <= 100 && entry.every((name) => typeof name === "string" && /^[a-z0-9][\w.-]{0,254}$/i.test(name.trim()));
		if (key === "autoMerge" || key === "autoArchiveWorkers") return typeof entry === "boolean";
		if (key === "inferred") return entry === "off" || entry === "observe" || entry === "auto";
		if (key === "models") return validModels(entry);
		if (!Object.hasOwn(limits, key)) return false;
		const [min, max] = limits[key];
		return typeof entry === "number" && Number.isInteger(entry) && entry >= min && entry <= max;
	});
}
function validModels(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entries = Object.entries(value);
	return entries.length > 0 && entries.every(([role, model]) => roles$1.includes(role) && validModel(model));
}
function validModel(value) {
	if (value === null) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { provider, model, reasoningEffort } = value;
	return Object.keys(value).every((key) => key === "provider" || key === "model" || key === "reasoningEffort") && typeof provider === "string" && provider.trim().length > 0 && typeof model === "string" && model.trim().length > 0 && (reasoningEffort === void 0 || typeof reasoningEffort === "string" && reasoningEffort.trim().length > 0);
}
function normalizeModels(value) {
	const source = value ?? {};
	return Object.fromEntries(roles$1.map((role) => {
		const model = source[role];
		return [role, model ? {
			provider: model.provider,
			model: model.model,
			...model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}
		} : null];
	}));
}
function normalizeAdministrators(names) {
	const unique = /* @__PURE__ */ new Map();
	for (const entry of names) {
		const name = entry.trim();
		if (!unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
	}
	return [...unique.values()];
}
// src/server/routes/agent.model.get.ts
var agent_model_get_default = defineHandler(async () => (await setting.load()).models);
// src/service/role-model.ts
const roleModel = defineService({
	async resolve(model) {
		const llm = getServerContext(server).get("llm");
		if (!llm) throw new Error("llm_unavailable");
		const value = await llm.resolveCallConfig({
			provider: model.provider,
			model: model.model,
			...model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}
		});
		return {
			provider: value.provider,
			model: value.model,
			...value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}
		};
	},
	async initialize(agent, model) {
		if (!model) return;
		if (agent.session.requestHeader() || agent.session.snapshotEvents().some((event) => event.type === "model/selection")) return;
		const ctx = getServerContext(server);
		const selected = await roleModel.resolve(model);
		agent.session.append("model/selection", selected);
		let initial = true;
		let assembled;
		agent.ctx.effect(() => {
			const disposers = [
				agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
					const selection = initial ? selected : void 0;
					const result = await next();
					assembled = selection;
					return selection ? {
						...result,
						variables: {
							...result.variables,
							provider: selection.provider,
							model: selection.model
						}
					} : result;
				}, { prepend: true }),
				agent.ctx.on("agent/request", async (_payload, next) => {
					const result = await next();
					if (!assembled) return result;
					const { reasoningEffort: _inherited, ...rest } = result;
					return {
						...rest,
						...assembled
					};
				}, { prepend: true }),
				ctx.on("session/event", (session, event) => {
					if (session === agent.session && (event.type === "request/header" || event.type === "model/selection")) initial = false;
				})
			];
			return () => disposers.forEach((dispose) => dispose());
		});
		await getServerContext(server).get("sessionPersistence")?.flush();
	}
});
// src/server/routes/agent.model.patch.ts
const roles = [
	"main",
	"manager",
	"project",
	"worker",
	"supervisor"
];
var agent_model_patch_default = defineHandler(async (event) => {
	const body = await readBody(event);
	if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => ![
		"role",
		"provider",
		"model",
		"reasoningEffort"
	].includes(key)) || !roles.includes(body.role) || typeof body.provider !== "string" || typeof body.model !== "string" || body.reasoningEffort !== void 0 && typeof body.reasoningEffort !== "string") throw new HTTPError({
		status: 400,
		message: "invalid_agent_model"
	});
	const provider = body.provider.trim();
	const name = body.model.trim();
	const effort = body.reasoningEffort?.trim() ?? "";
	if ((provider || name || effort) && !(provider && name)) throw new HTTPError({
		status: 400,
		message: "invalid_agent_model"
	});
	const entry = provider && name ? {
		provider,
		model: name,
		...effort ? { reasoningEffort: effort } : {}
	} : null;
	if (entry) try {
		await roleModel.resolve(entry);
	} catch (error) {
		throw new HTTPError({
			status: 400,
			message: `unresolved_agent_model: ${error instanceof Error ? error.message : String(error)}`
		});
	}
	const models = {
		...(await setting.load()).models,
		[body.role]: entry
	};
	return (await setting.save({ models })).models;
});
// src/service/admission.ts
async function admin(actorName) {
	const name = (actorName ?? "").toLowerCase();
	return name !== "" && (await setting.load()).administrators.some((entry) => entry.toLowerCase() === name);
}
/** 触发作者是不是我们在该渠道的 bot 账号；读取时现查账号表，不额外存 self 列。 */
async function ownAccount(trigger) {
	const name = (trigger.actorName ?? "").toLowerCase();
	return name !== "" && (await db.channelAccount.findByChannel(trigger.channelId)).some((account) => account.role === "bot" && account.name.toLowerCase() === name);
}
/** 按触发自身的点名事实和话题订阅判强度；订阅状态每次现查，票可能在建票之后才挂上。 */
async function triggerStrength(trigger) {
	const thread = await db.thread.findById(trigger.threadId);
	const subscribed = (await db.ticketThread.listTicketIds(trigger.threadId)).length > 0;
	return triggerStrengthOf({
		self: await ownAccount(trigger),
		kind: trigger.kind,
		issue: thread?.kind === "issue",
		human: Boolean(trigger.human),
		mentioned: Boolean(trigger.mentioned),
		subscribed,
		admin: await admin(trigger.actorName)
	});
}
/** 建票闸用：指定 triggerId 时按那条触发判，否则取这些话题里最新的一条人类触发。带上判的是哪条，拒绝时才能指出实际触发。 */
async function latestTriggerStrength(threadIds, triggerId) {
	const trigger = triggerId ? await db.trigger.findById(triggerId) : latestTrigger((await Promise.all(threadIds.map((id) => db.trigger.listByThread(id, 20)))).flat());
	return trigger ? {
		strength: await triggerStrength(trigger),
		triggerId: trigger.id
	} : void 0;
}
// src/service/session.ts
const presets$1 = {
	main: "orchestrator",
	project: "manager",
	supervisor: "supervisor",
	worker: "worker"
};
const registered = /* @__PURE__ */ new Set();
let controller$2 = new AbortController();
let stopped$3 = false;
const session = defineService({
	register(id) {
		registered.add(id);
		return () => {
			registered.delete(id);
		};
	},
	/** 同步判定一个 Agent 是不是插件的四个角色会话：只按预设判断，不读会话历史。 */
	roleOf(agent) {
		const preset = getServerContext(server).agentPresets.composedPreset(agent.ctx);
		if (!preset || !registered.has(preset)) return null;
		return Object.keys(presets$1).find((role) => presets$1[role] === preset) ?? null;
	},
	async attach(agent) {
		const ctx = getServerContext(server);
		const preset = ctx.agentPresets.composedPreset(agent.ctx);
		if (!preset || !registered.has(preset) || agent.session.header.origin === "subagent" || agent.session.header.parentSession || ctx.workspaceRegistry.archivedSessionIds.includes(agent.session.id)) return null;
		const role = Object.keys(presets$1).find((role) => presets$1[role] === preset);
		if (!role) return null;
		if (role === "main") {
			const current = await session.findMain();
			if (current && current !== agent.session.id) throw new Error("ambiguous_main_session");
		}
		await bindWorkspace(agent.session.id, agent.session.header.cwd);
		if (role === "main") await storage.setItem("orchestrator.id", agent.session.id);
		return role;
	},
	start() {
		if (singlet.busy("session:workspace")) throw new Error("session_busy");
		controller$2 = new AbortController();
		stopped$3 = false;
		return async () => {
			stopped$3 = true;
			controller$2.abort(/* @__PURE__ */ new Error("session_stopped"));
			await Promise.allSettled([singlet.drain()]);
		};
	},
	async resolve(id) {
		const ctx = getServerContext(server);
		const sid = SessionId(id);
		if (ctx.workspaceRegistry.archivedSessionIds.includes(sid)) return null;
		let header;
		let preset;
		try {
			const snapshot = await ctx.sessionQuery.readSession(sid);
			header = snapshot.session;
			preset = ctx.agentPresets.presetForSession(Session.create(sid, snapshot.events, snapshot.session));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") return null;
			throw error;
		}
		if (!preset || !registered.has(preset) || header.origin === "subagent" || header.parentSession) return null;
		const [worker, project, supervisor] = await Promise.all([
			db.worker.findById(id),
			db.project.findBySession(id),
			db.supervisor.findBySession(id)
		]);
		if ([
			worker,
			project,
			supervisor
		].filter(Boolean).length > 1) throw new Error("session_binding_conflict");
		if (worker) {
			const agent = ctx.agents.get(sid);
			if (preset !== presets$1.worker || agent && ctx.agentPresets.composedPreset(agent.ctx) !== presets$1.worker) return null;
			const ticket = await db.ticket.findById(worker.ticketId);
			return ticket ? {
				role: "worker",
				projectId: ticket.projectId,
				ticketId: ticket.id,
				workerId: worker.id
			} : null;
		}
		if (project) return preset === presets$1.project ? {
			role: "project",
			projectId: project.id
		} : null;
		if (supervisor) return preset === presets$1.supervisor && supervisor.status === "active" ? {
			role: "supervisor",
			supervisorId: supervisor.id
		} : null;
		return preset === presets$1.main && await storage.getItem("orchestrator.id") === id ? { role: "main" } : null;
	},
	/**
	* 按会话日志重建一个 Session 实例。没有活动 Agent 的票（Worker 已结束）也要能读
	* 它自己的投影 —— 官方 forge-session 的绑定正是从这份日志折出来的。
	*/
	async instance(id) {
		const ctx = getServerContext(server);
		const sid = SessionId(id);
		if (ctx.workspaceRegistry.archivedSessionIds.includes(sid)) return null;
		try {
			const snapshot = await ctx.sessionQuery.readSession(sid);
			return Session.create(sid, snapshot.events, snapshot.session);
		} catch {
			return null;
		}
	},
	async findMain() {
		const id = await storage.getItem("orchestrator.id");
		return id && (await session.resolve(id))?.role === "main" ? id : null;
	},
	create: singlet((role, options) => `session:create:${role}:${role === "worker" ? options.sessionId : role === "project" ? options.projectId : role === "supervisor" ? options.supervisorId : "main"}`, async (role, options) => {
		if (stopped$3) throw new Error("runtime_stopping");
		const ctx = getServerContext(server);
		const project = options.projectId ? await db.project.findById(options.projectId) : void 0;
		const supervisor = options.supervisorId ? await db.supervisor.findById(options.supervisorId) : void 0;
		if (role === "project" && !project) throw new Error("project_not_found");
		if (role === "supervisor" && (!supervisor || supervisor.status !== "active")) throw new Error("supervisor_not_active");
		if (role === "main") {
			const existing = await session.findMain();
			if (existing) {
				await bindWorkspace(existing);
				await ctx.workspaceRegistry.pinSession(SessionId(existing)).catch(() => void 0);
				return existing;
			}
		}
		if (role === "project" && project?.orchestratorSessionId) {
			const identity = await session.resolve(project.orchestratorSessionId);
			if (identity?.role === "project" && identity.projectId === project.id) {
				await bindWorkspace(project.orchestratorSessionId);
				return project.orchestratorSessionId;
			}
			if (identity) throw new Error("session_binding_conflict");
		}
		if (role === "supervisor" && supervisor?.sessionId) {
			const identity = await session.resolve(supervisor.sessionId);
			if (identity?.role === "supervisor" && identity.supervisorId === supervisor.id) {
				await bindWorkspace(supervisor.sessionId);
				return supervisor.sessionId;
			}
			if (identity) throw new Error("session_binding_conflict");
		}
		const requestedId = options.sessionId ?? randomUUID();
		if (role === "worker") {
			const worker = await db.worker.findById(requestedId);
			if (!worker || worker.ticketId !== options.ticketId || worker.status === "ended") throw new Error("worker_binding_required");
			if (!options.directory) throw new Error("worker_directory_required");
		}
		const location = role === "worker" ? { cwd: options.directory } : { workspaceId: (await session.workspace()).id };
		const id = (await ctx.sessionController.create({
			sessionId: SessionId(requestedId),
			...location,
			agentPreset: presets$1[role]
		})).sessionId;
		if (id !== requestedId) throw new Error("session_identity_conflict");
		if (role === "main") await storage.setItem("orchestrator.id", id);
		if (project && role === "project") await db.project.setOrchestrator(project.id, id, (/* @__PURE__ */ new Date()).toISOString());
		if (supervisor && role === "supervisor") await db.supervisor.attachSession(supervisor.id, id);
		const title = role === "main" ? "[路由] 主编排" : role === "project" ? `[路由] ${project.name}` : role === "supervisor" ? `[协调] ${supervisor.title}` : void 0;
		if (title) await ctx.sessionController.rename({
			sessionId: id,
			title
		});
		if (role === "main") await ctx.workspaceRegistry.pinSession(SessionId(id)).catch(() => void 0);
		if (role !== "worker") await inbox.notify(await resolveAgent(id));
		if (options.prompt) await session.send(id, options.prompt);
		return id;
	}),
	send: singlet((id, text, _mode, requestId = "") => `session:send:${id}:${requestId}:${text.length}:${text.slice(0, 64)}`, async (id, text, mode = "queue", requestId = randomUUID()) => {
		if (!text.trim()) throw new Error("empty_message");
		if (stopped$3) throw new Error("runtime_stopping");
		if (!await session.resolve(id)) throw new Error(await db.worker.findById(id) ? "worker_session_unavailable" : "unknown_session");
		const ctx = getServerContext(server);
		if (mode === "interrupt") await session.cancel(id, true);
		const live = ctx.agents.get(SessionId(id));
		const target = mode === "interrupt" ? "steer" : mode === "queue" || live?.status !== "running" ? "queue" : "steer";
		const admitted = await ctx.sessionController.prompt({
			sessionId: SessionId(id),
			requestId,
			mode: target,
			content: [{
				type: "text",
				text
			}]
		}, controller$2.signal);
		if (admitted && typeof admitted === "object" && "ok" in admitted && admitted.ok === false) throw new Error(`prompt_rejected: ${String(admitted.error ?? "unknown")}`);
		return requestId;
	}),
	async cancel(id, keepInbox = false) {
		(await resolveAgent(id)).cancel({
			kind: "hook",
			reason: "supermesh_cancel"
		}, { keepInbox });
	},
	async rename(id, title) {
		if (!await session.resolve(id)) throw new Error("unknown_session");
		await getServerContext(server).sessionController.rename({
			sessionId: SessionId(id),
			title
		});
	},
	async view(id, offset = 0, limit = 12e3) {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5e4) throw new Error("invalid_page");
		if (!await session.resolve(id)) throw new Error("unknown_session");
		const { events } = await getServerContext(server).sessionQuery.readSession(SessionId(id));
		const text = events.flatMap((event) => {
			if (event.type !== "user/message" && event.type !== "assistant/message") return [];
			return (event.type === "assistant/message" ? event.data.message : event.data).content.flatMap((part) => part.type === "text" ? [part.text] : []);
		}).join(String.fromCharCode(10, 10));
		const end = Math.min(text.length, offset + limit);
		return {
			text: text.slice(offset, end),
			next_offset: end < text.length ? end : null
		};
	},
	workspace: singlet("session:workspace", async () => {
		const ctx = getServerContext(server);
		await mkdir(DSH_WORKSPACE_HOME, { recursive: true });
		await retireLegacyWorkspace(ctx);
		return ctx.workspaceRegistry.create(DSH_WORKSPACE_HOME, "代理工作区");
	}),
	activate: (id) => resolveAgent(id),
	async lookup(id) {
		if (!await session.resolve(id)) return null;
		return getServerContext(server).agents.get(SessionId(id)) ?? null;
	},
	async history(id) {
		return getServerContext(server).sessionQuery.readSession(SessionId(id));
	},
	async lastActivity(id) {
		try {
			const { events } = await getServerContext(server).sessionQuery.readSession(SessionId(id));
			let latest = 0;
			for (const event of events) {
				const time = Number(event.time ?? 0);
				if (time > latest) latest = time;
			}
			return latest || null;
		} catch {
			return null;
		}
	},
	async receipts(id) {
		const { events } = await getServerContext(server).sessionQuery.readSession(SessionId(id));
		const receipts = [];
		let pending = [];
		for (const event of events) {
			if (event.type === "turn/start") pending = [];
			if (event.type === "user/message" && "rpcId" in event.data.source && typeof event.data.source.rpcId === "string") pending.push(event.data.source.rpcId);
			if (event.type === "turn/end" && event.data.reason.kind === "completed") {
				receipts.push(...pending.map((requestId) => ({
					requestId,
					consumedAt: new Date(event.time).toISOString()
				})));
				pending = [];
			}
		}
		return receipts;
	},
	async activity(id) {
		const ctx = getServerContext(server);
		const activities = await ctx.waterfall("workspace/session-activity", { sessionId: SessionId(id) }, () => Promise.resolve([]));
		const state = await ctx.sessionController.state({ sessionId: SessionId(id) }, controller$2.signal);
		return {
			running: state.running,
			background: activities.some((item) => String(item.kind) !== "turn"),
			queued: Boolean(state.queue?.length)
		};
	},
	async stop(id) {
		const ctx = getServerContext(server);
		await ctx.parallel("workspace/session-stop", { sessionId: SessionId(id) });
		const result = await ctx.sessionController.resolveAgent(SessionId(id));
		if ("agent" in result) {
			result.agent.cancel({
				kind: "hook",
				reason: "supermesh_stop"
			}, { keepInbox: true });
			await result.agent.whenIdle();
		}
		if ((await session.activity(id)).background) throw new Error("background_stop_pending");
	}
});
/**
* 旧版本把「代理工作区」注册在 `.supermesh` 根本身，那里同时存着插件状态。
* 工作区路径不可改，只能删掉这条注册；目录与会话日志都保留，旧会话退化为未分组。
*/
async function retireLegacyWorkspace(ctx) {
	const legacy = await realpathNormalize(DSH_PLUGIN_HOME).catch(() => void 0);
	if (!legacy) return;
	for (const workspace of ctx.workspaceRegistry.list()) if (workspace.path === legacy) await ctx.workspaceRegistry.delete(workspace.id).catch(() => void 0);
}
async function bindWorkspace(id, cwd) {
	const ctx = getServerContext(server);
	const sid = SessionId(id);
	const directory = cwd ?? (await ctx.sessionQuery.readSession(sid)).session.cwd;
	if (!directory) return;
	const actual = await realpathNormalize(directory).catch(() => void 0);
	if (!actual) return;
	if (actual === await realpathNormalize(DSH_PLUGIN_HOME).catch(() => void 0)) return;
	for (const workspace of [await session.workspace(), ...ctx.workspaceRegistry.list()]) {
		if (workspace.sessionIds.includes(sid)) return;
		if (workspace.path !== actual) continue;
		await workspace.attachSession(sid).catch(() => void 0);
		return;
	}
	await (await ctx.workspaceRegistry.create(actual, basename(actual)).catch(() => void 0))?.attachSession(sid).catch(() => void 0);
}
async function resolveAgent(id) {
	if (!await session.resolve(id)) throw new Error("unknown_session");
	const result = await getServerContext(server).sessionController.resolveAgent(SessionId(id));
	if ("error" in result) throw result.error;
	return result.agent;
}
// src/utils/repository.ts
function parseGitRemote(value, site) {
	const invalid = () => /* @__PURE__ */ new Error("invalid_repository_remote");
	if (typeof value !== "string" || !value || value !== value.trim() || /[\s\\%]/.test(value)) throw invalid();
	const scp = /^git@([^/:]+):(.+)$/.exec(value);
	let url;
	try {
		url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);
	} catch {
		throw invalid();
	}
	if (![
		"http:",
		"https:",
		"ssh:"
	].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash) throw invalid();
	if (url.protocol === "ssh:" ? url.username !== "git" || Boolean(url.port) : Boolean(url.username) || url.hostname === "github.com" && (url.protocol !== "https:" || Boolean(url.port))) throw invalid();
	const segments = (scp ? scp[2] : value.slice(value.indexOf("://") + 3).replace(/^[^/]+\//, "")).replace(/\/$/, "").replace(/\.git$/, "").split("/");
	if (segments.length < 2 || !segments.every((segment) => /^\w[\w.-]*$/.test(segment) && !segment.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw invalid();
	const owner = segments.slice(0, -1).join("/");
	const name = segments.at(-1);
	const webUrl = `${webProtocol(site, url.host, url.protocol)}//${url.host}/${segments.join("/")}`;
	return {
		host: url.host,
		owner,
		name,
		remoteUrl: url.protocol === "ssh:" ? `git@${url.hostname}:${segments.join("/")}.git` : `${webUrl}.git`,
		webUrl
	};
}
/** ssh 远端没有网页协议，按渠道配置的站点协议归一；站点不是同一台主机时退回 https。 */
function webProtocol(site, host, protocol) {
	if (protocol !== "ssh:" || !site) return protocol;
	try {
		const configured = new URL(site);
		return configured.host === host && configured.protocol === "http:" ? "http:" : "https:";
	} catch {
		return "https:";
	}
}
/**
* 归一化仓库路径：git remote 与 issue / PR 网页地址都归到 `owner/repo`（小写）。
* 话题 refId、项目 remoteUrl 和邮件里的 repository 用同一种形式，匹配不再受大小写影响。
*/
function repositoryOf(value) {
	if (!value) return null;
	const scp = /^git@[^/:]+:(.+)$/.exec(value);
	let path;
	if (scp) path = scp[1];
	else try {
		path = new URL(value).pathname;
	} catch {
		return null;
	}
	const topic = /^\/(.+?)\/(?:-\/)?(?:issues|pull|merge_requests|work_items)\/[1-9]\d*\/?$/.exec(path);
	return (topic ? topic[1] : path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "")).toLowerCase() || null;
}
function parseRepositoryRemote(value, gitlabHost = "https://gitlab.com") {
	const invalid = () => /* @__PURE__ */ new Error("invalid_repository_remote");
	let configured;
	try {
		configured = new URL(gitlabHost);
	} catch {
		throw invalid();
	}
	if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== "/" || configured.search || configured.hash) throw invalid();
	const remote = parseGitRemote(value, gitlabHost);
	const platform = remote.host === "github.com" ? "github" : remote.host === configured.host ? "gitlab" : null;
	if (!platform || platform === "github" && remote.owner.includes("/")) throw invalid();
	return {
		...remote,
		platform,
		defaultName: `${platform}/${remote.name}`
	};
}
// src/service/inbox.ts
let stopped$2 = false;
const inbox = defineService({
	notify: singlet((agent) => `inbox:notify:${agent.session.id}`, async (agent) => {
		if (agent.status !== "idle") return;
		const mailbox = await inbox.peek(agent.session.id);
		if (!mailbox) return;
		const revision = mailbox.messages.map((message) => [message.id, message.escalations]).sort().map((parts) => parts.join(":")).join("|");
		if (!revision) return;
		const { events } = await session.history(agent.session.id);
		if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => message.source.kind === "supermesh-mailbox" && message.source.revision === revision)) return;
		if (events.some((event) => (event.type === "user/message" ? [event.data] : event.type === "agent/inbox/spliced" ? event.data.inserted : []).some((message) => message.source.kind === "supermesh-mailbox" && message.source.revision === revision))) return;
		const text = `你有${mailbox.pendingCount}个未处理邮件。用 read_mailbox 读取邮件和项目上下文，处理完成后显式完成邮件。`;
		const message = createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "supermesh-mailbox",
				form: "notice",
				summary: text,
				revision
			}
		});
		if (stopped$2 || !await session.resolve(agent.session.id)) return;
		agent.followup(message);
	}),
	async peek(id) {
		const identity = await session.resolve(id);
		if (!identity) return null;
		const scope = scopeOf(identity);
		if (!scope) return null;
		const rows = await db.inbox.listScoped(scope);
		const triggers = /* @__PURE__ */ new Map();
		for (const triggerId of new Set(rows.map((message) => message.triggerId).filter(Boolean))) {
			const trigger = await db.trigger.findById(triggerId);
			if (trigger) triggers.set(triggerId, {
				kind: trigger.kind,
				actorName: trigger.actorName,
				human: Boolean(trigger.human),
				mentioned: Boolean(trigger.mentioned),
				strength: await triggerStrength(trigger)
			});
		}
		const threads = /* @__PURE__ */ new Map();
		for (const threadId of new Set(rows.map((message) => message.threadId).filter(Boolean))) {
			const thread = await db.thread.findById(threadId);
			if (!thread) continue;
			const owner = thread.projectId ? await db.project.findById(thread.projectId) : void 0;
			threads.set(thread.id, {
				id: thread.id,
				kind: thread.kind,
				refId: thread.refId,
				title: thread.title,
				url: thread.url,
				triage: thread.triage,
				projectId: thread.projectId,
				repository: thread.channelId === "github" || thread.channelId === "gitlab" ? repositoryOf(thread.url) : null,
				project: owner ? {
					id: owner.id,
					name: owner.name,
					enabled: Boolean(owner.enabled)
				} : null
			});
		}
		const messages = rows.map((message) => ({
			...message,
			...message.triggerId && triggers.has(message.triggerId) ? { trigger: triggers.get(message.triggerId) } : {},
			...message.threadId && threads.has(message.threadId) ? { thread: threads.get(message.threadId) } : {}
		}));
		const projects = (await db.project.listAll()).filter((project) => project.enabled && (identity.role === "main" || project.id === identity.projectId)).map(({ id, name, directory, remoteUrl }) => ({
			id,
			name,
			directory,
			remoteUrl,
			repository: repositoryOf(remoteUrl)
		}));
		return {
			sessionId: id,
			role: scope.type,
			projects,
			pendingCount: messages.length,
			messages
		};
	},
	async read(id, ids) {
		const mailbox = await inbox.peek(id);
		if (!mailbox) throw new Error("unknown_session");
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const selected = ids?.length ? mailbox.messages.filter((message) => ids.includes(message.id)) : mailbox.messages;
		await db.inbox.markRead(selected.filter((message) => !message.readAt).map((message) => message.id), now);
		if (!ids?.length) return mailbox;
		const missing = ids.filter((id) => !mailbox.messages.some((message) => message.id === id));
		return {
			...mailbox,
			messages: selected,
			missing
		};
	},
	async complete(id, ids) {
		const identity = await session.resolve(id);
		if (!identity) throw new Error("unknown_session");
		const scope = scopeOf(identity);
		if (!scope) throw new Error("unknown_session");
		return db.inbox.completeScoped(ids, scope, (/* @__PURE__ */ new Date()).toISOString());
	},
	start() {
		if (singlet.busy("inbox:delivery") || singlet.busy("inbox:answers")) throw new Error("inbox_busy");
		stopped$2 = false;
		return async () => {
			stopped$2 = true;
			await Promise.allSettled([singlet.drain()]);
		};
	},
	deliver: singlet("inbox:delivery", async () => {
		const settings = await setting.load();
		const notified = /* @__PURE__ */ new Set();
		const woken = /* @__PURE__ */ new Set();
		for (const message of await db.inbox.listDelivery()) {
			if (stopped$2) break;
			const key = [
				message.type,
				message.projectId,
				message.supervisorId,
				message.ticketId
			].join(":");
			if (message.ticketId && (await db.ticket.findById(message.ticketId))?.paused) continue;
			if (message.type === "project" && message.projectId && !(await db.project.findById(message.projectId))?.enabled) continue;
			if (message.type === "supervisor" && message.supervisorId && (await db.supervisor.findById(message.supervisorId))?.status !== "active") continue;
			if (notified.has(key)) continue;
			if (message.status === "stalled" || message.nextRetryAt && message.nextRetryAt > (/* @__PURE__ */ new Date()).toISOString()) continue;
			try {
				const id = await recipient(message);
				if (!id) throw new Error("recipient_session_unavailable");
				const agent = await session.activate(id);
				if (stopped$2) break;
				if (agent.status === "idle" && !woken.has(id)) {
					woken.add(id);
					await inbox.notify(agent);
				}
				notified.add(key);
				await db.inbox.resetDelivery(message.id);
			} catch (error) {
				if (stopped$2) break;
				const reason = error instanceof Error ? error.message : String(error);
				const attempts = message.deliveryAttempts + 1;
				const delay = Math.min(2 ** Math.min(attempts, 20), settings.deliveryRetryCeilingSeconds) * 1e3;
				await db.inbox.recordDeliveryFailure(message.id, reason, new Date(Date.now() + delay).toISOString());
				if (attempts >= settings.deliveryMaxAttempts) await db.inbox.markStalled(message.id, reason);
			}
		}
	}),
	deliverAnswers: singlet("inbox:answers", async () => {
		for (const message of await db.inbox.listAnswered()) {
			if (stopped$2) break;
			if (!message.answer || message.nextRetryAt && message.nextRetryAt > (/* @__PURE__ */ new Date()).toISOString()) continue;
			try {
				if (message.origin !== "worker") {
					await db.inbox.enqueueAnswer(message);
					await db.inbox.settleAnswer(message.id, (/* @__PURE__ */ new Date()).toISOString());
					continue;
				}
				if (message.ticketId && (await db.ticket.findById(message.ticketId))?.paused) continue;
				const worker = message.workerId ? await db.worker.findById(message.workerId) : void 0;
				if (!worker) {
					await db.inbox.relayAnswer(message.id, "提问的 Worker 记录已不存在，答案没能送到它手里", (/* @__PURE__ */ new Date()).toISOString());
					continue;
				}
				if (worker.status === "queued") continue;
				if (!await session.resolve(worker.id)) {
					await db.inbox.relayAnswer(message.id, `${worker.id} 的会话已归档或日志缺失，答案没能送到它手里`, (/* @__PURE__ */ new Date()).toISOString());
					continue;
				}
				await resumeWorker(worker);
				await session.activate(worker.id);
				await session.send(worker.id, `[Answer ${message.id}] ${message.answer}`, "reply", `supermesh:answer:${message.id}`);
				await db.inbox.finishAnswer(message.id, (/* @__PURE__ */ new Date()).toISOString());
			} catch (error) {
				if (stopped$2) break;
				const reason = error instanceof Error ? error.message : String(error);
				const settings = await setting.load();
				const attempts = message.deliveryAttempts + 1;
				const delays = Math.min(2 ** Math.min(attempts, 20), settings.deliveryRetryCeilingSeconds) * 1e3;
				await db.inbox.recordDeliveryFailure(message.id, reason, new Date(Date.now() + delays).toISOString());
				if (attempts >= settings.deliveryMaxAttempts) await db.inbox.relayAnswer(message.id, `答案投递失败（${reason}）`, (/* @__PURE__ */ new Date()).toISOString());
			}
		}
	})
});
/**
* 把已经结束、但会话还在的 Worker 重新拉起来。
*
* 答案要送进一个 ended 的 Worker，光 send 不够：worker 记录不回到 running，
* 这一轮结束时就没人收尾（observe 只认 running），票会一直停在原状态。
*/
async function resumeWorker(worker) {
	if (worker.status !== "ended") return;
	const now = (/* @__PURE__ */ new Date()).toISOString();
	await db.worker.update(worker.id, {
		status: "running",
		endedAt: null,
		endedReason: null
	});
	const ticket = await db.ticket.findById(worker.ticketId);
	if (ticket && ![
		"done",
		"completed",
		"cancelled"
	].includes(ticket.status)) await db.ticket.start(ticket.id, now, now);
}
async function recipient(message) {
	if (message.type === "main") return session.create("main", {});
	if (message.type === "project" && message.projectId) return session.create("project", { projectId: message.projectId });
	if (message.type === "supervisor" && message.supervisorId) return session.create("supervisor", { supervisorId: message.supervisorId });
	throw new Error("invalid_inbox_recipient");
}
function scopeOf(identity) {
	if (identity.role === "main") return { type: "main" };
	if (identity.role === "project" && identity.projectId) return {
		type: "project",
		projectId: identity.projectId
	};
	if (identity.role === "supervisor" && identity.supervisorId) return {
		type: "supervisor",
		supervisorId: identity.supervisorId
	};
	return null;
}
// src/server/routes/ask.[id].answer.post.ts
var ask__id__answer_post_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id", { decode: true });
	const body = await readBody(event);
	if (!id?.trim() || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "answer") || typeof body.answer !== "string" || !body.answer.trim()) throw new HTTPError({
		status: 400,
		message: "answer_required"
	});
	const current = await db.inbox.findById(id);
	if (!current) throw new HTTPError({
		status: 404,
		message: "not_found"
	});
	if (current.type !== "user" || current.kind !== "ask") throw new HTTPError({
		status: 403,
		message: "scope_denied"
	});
	if (![
		"worker",
		"project",
		"supervisor",
		"main"
	].includes(current.origin)) throw new HTTPError({
		status: 409,
		message: "unsupported_reply_target"
	});
	const answer = await db.inbox.answerByUser(id, body.answer.trim(), (/* @__PURE__ */ new Date()).toISOString());
	if (!answer) throw new HTTPError({
		status: 409,
		message: "already_answered"
	});
	await inbox.deliverAnswers();
	return answer;
});
// src/channel/_shared/proxy.ts
async function channelProxyEnvironment(url, inherited) {
	const env = { ...inherited };
	const overlay = proxyEnvironmentForChild();
	const explicit = Object.entries(inherited).some(([name, value]) => /^(?:https?|all)_proxy$/i.test(name) && Boolean(value?.trim()));
	for (const [name, value] of Object.entries(overlay)) if (value === void 0) delete env[name];
	else env[name] = value;
	if (process.platform !== "win32" || explicit || Object.keys(overlay).length) return env;
	const settings = await new Promise((resolve) => {
		execFile("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
			windowsHide: true,
			timeout: 3e3,
			maxBuffer: 65536
		}, (error, stdout) => resolve(error ? "" : stdout));
	});
	if (!/^\s*ProxyEnable\s+REG_DWORD\s+0x0*1\s*$/im.test(settings)) return env;
	if ((/^\s*ProxyOverride\s+REG_SZ\s+(\S.*)$/im.exec(settings)?.[1].trim())?.split(";").some((pattern) => bypasses(url.hostname, pattern.trim()))) return env;
	const raw = /^\s*ProxyServer\s+REG_SZ\s+(\S.*)$/im.exec(settings)?.[1].trim();
	if (!raw) return env;
	const selected = raw.includes("=") ? raw.split(";").map((part) => part.trim()).find((part) => part.toLowerCase().startsWith(`${url.protocol.slice(0, -1)}=`))?.slice(url.protocol.length) : raw;
	if (!selected) return env;
	try {
		const proxy = new URL(selected.includes("://") ? selected : `http://${selected}`);
		if (!["http:", "https:"].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== "/" || proxy.search || proxy.hash) return env;
		env.HTTP_PROXY = proxy.href;
		env.HTTPS_PROXY = proxy.href;
		delete env.http_proxy;
		delete env.https_proxy;
	} catch {}
	return env;
}
function bypasses(hostname, pattern) {
	if (!pattern) return false;
	if (pattern.toLowerCase() === "<local>") return !hostname.includes(".") && !hostname.includes(":");
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`, "i").test(hostname);
}
// src/utils/git-identity.ts
/**
* 平台按邮箱归属提交，名字只影响显示。用账号的 noreply 地址才能让 bot 的提交记在 bot 名下。
* GitHub：`<id>+<login>@users.noreply.github.com`；GitLab：`<username>@users.noreply.<host>`。
*/
function noreplyEmail(kind, login, providerId, host) {
	const name = login.trim();
	if (!name) return "";
	if (kind === "github") {
		const id = providerId.trim();
		return /^\d+$/.test(id) ? `${id}+${name}@users.noreply.github.com` : "";
	}
	try {
		return `${name}@users.noreply.${new URL(host).host}`;
	} catch {
		return "";
	}
}
// src/service/channel.ts
const presets = [
	{
		id: "github",
		name: "GitHub"
	},
	{
		id: "gitlab",
		name: "GitLab"
	},
	{
		id: "feishu",
		name: "飞书"
	}
];
let writing$1 = Promise.resolve();
const channel = defineService({
	async list() {
		const [rows, accounts] = await Promise.all([db.channel.listAll(), db.channelAccount.listAll()]);
		return Promise.all(presets.map(async (preset) => {
			const row = rows.find((row) => row.id === preset.id);
			const members = accounts.filter((account) => account.channelId === preset.id).map(({ id, channelId, role, name, avatar, status, createdAt }) => ({
				id,
				channelId,
				role,
				name,
				avatar,
				status,
				createdAt
			}));
			const supported = preset.id !== "feishu";
			const hasCredential = preset.id !== "feishu" && Boolean((await credentials().resolve(ref(preset.id)))?.value?.trim() || (await credentials().resolve(legacyRef(preset.id)))?.value?.trim());
			const enabled = supported && Boolean(row?.enabled);
			const stored = await db.sourceState.find(preset.id, "configuration");
			const configured = hasCredential || members.length > 0 || Boolean(stored);
			const metadata = readMetadata(stored?.value);
			const bot = members.find((account) => account.role === "bot");
			const suggestion = bot && (preset.id === "github" || preset.id === "gitlab") ? noreplyEmail(preset.id, bot.name, metadata.providerId, row?.host ?? (preset.id === "gitlab" ? "https://gitlab.com" : "https://github.com")) : "";
			return {
				id: preset.id,
				kind: preset.id,
				name: row?.name ?? preset.name,
				host: row?.host ?? (preset.id === "gitlab" ? "https://gitlab.com" : null),
				enabled,
				createdAt: row?.createdAt ?? "",
				accounts: members,
				configured,
				supported,
				hasCredential,
				status: !supported ? "unsupported" : !configured ? "unconfigured" : !enabled ? "disabled" : members.some((account) => account.role === "bot" && account.status === "online") ? "online" : "offline",
				commitName: metadata.commitName,
				commitEmail: metadata.commitEmail,
				commitEmailSuggestion: suggestion,
				providerId: metadata.providerId,
				lastDrop: dropOf(await db.sourceState.find(preset.id, "admission:last_drop"))
			};
		}));
	},
	serialize(action) {
		const operation = writing$1.then(action);
		writing$1 = operation.then(() => void 0, () => void 0);
		return operation;
	},
	connection(kind) {
		return channel.serialize(async () => {
			const row = await db.channel.findById(kind);
			const token = kind === "feishu" ? void 0 : await channel.resolveCredential(kind);
			return Object.freeze({
				host: row?.host ?? (kind === "gitlab" ? "https://gitlab.com" : null),
				token,
				enabled: kind !== "feishu" && Boolean(row?.enabled)
			});
		});
	},
	async resolveCredential(kind) {
		if (kind === "feishu") return void 0;
		const stored = await credentials().resolve(ref(kind));
		if (stored?.value?.trim()) return stored.value;
		return (await credentials().resolve(legacyRef(kind)))?.value;
	},
	async storeCredential(kind, token) {
		const previous = await credentials().resolve(ref(kind));
		await credentials().set(ref(kind), token);
		return previous?.value;
	},
	async clearCredential(kind) {
		const previous = await credentials().resolve(ref(kind));
		await credentials().unset(ref(kind));
		return previous?.value;
	}
});
function credentials() {
	return getServerContext(server).credentials;
}
function ref(kind) {
	return credentialRef(kind === "github" ? "SUPERMESH_GITHUB_TOKEN" : "SUPERMESH_GITLAB_TOKEN");
}
function legacyRef(kind) {
	return credentialRef(kind === "github" ? "NEXUS_GITHUB_TOKEN" : "NEXUS_GITLAB_TOKEN");
}
function readMetadata(raw) {
	if (!raw) return {
		commitName: "",
		commitEmail: "",
		providerId: ""
	};
	const value = JSON.parse(raw);
	if (!value || typeof value !== "object" || !("commitName" in value) || !("commitEmail" in value) || typeof value.commitName !== "string" || typeof value.commitEmail !== "string" || "providerId" in value && value.providerId !== void 0 && typeof value.providerId !== "string") throw new Error("invalid_channel_metadata");
	return {
		commitName: value.commitName,
		commitEmail: value.commitEmail,
		providerId: "providerId" in value && typeof value.providerId === "string" ? value.providerId : ""
	};
}
function dropOf(row) {
	if (!row) return null;
	let value;
	try {
		value = JSON.parse(row.value);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || !("reason" in value) || !("actor" in value) || !("at" in value)) return null;
	const { reason, actor, at } = value;
	return typeof reason === "string" && typeof actor === "string" && typeof at === "string" ? {
		reason,
		actor,
		at
	} : null;
}
// src/service/shell.ts
const directory = join(DSH_PLUGIN_HOME, "cli");
const bin = join(directory, "bin");
const gitconfig = join(directory, "gitconfig");
const tokens = [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GITLAB_TOKEN",
	"GLAB_TOKEN",
	"OAUTH_TOKEN",
	"CI_JOB_TOKEN"
];
const identities = [
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL"
];
/** 角色会话标记：由 `ctx.shellEnv` 按调用会话注入，shim 只在这个变量存在时才切到 bot 身份。 */
const ROLE_MARKER = "DSH_SUPERMESH_ROLE";
let restore;
let writing = Promise.resolve();
let basePath = "";
const shell = defineService({
	async start() {
		if (restore) throw new Error("shell_already_started");
		basePath = (process.env.PATH ?? "").split(delimiter).filter((path) => resolve(path).toLowerCase() !== resolve(bin).toLowerCase()).join(delimiter);
		await refresh();
		const release = getServerContext(server).get("shellEnv")?.register({
			name: "supermesh-role",
			variables: { DSH_SUPERMESH_ROLE: { description: "Supermesh 角色会话标记，决定 gh / glab / git 是否使用插件的机器人身份。" } },
			resolve: (execution) => {
				const agent = execution.agent;
				const role = agent ? session.roleOf(agent) : null;
				return role ? { DSH_SUPERMESH_ROLE: role } : {};
			}
		});
		const previous = process.env.PATH;
		process.env.PATH = [bin, basePath].join(delimiter);
		restore = () => {
			release?.();
			if (previous === void 0) delete process.env.PATH;
			else process.env.PATH = previous;
		};
		return async () => {
			const release = restore;
			restore = void 0;
			release?.();
			await writing;
		};
	},
	commandEnvironment() {
		return { ...process.env };
	},
	refresh() {
		if (!restore) return Promise.resolve();
		const next = writing.then(refresh);
		writing = next.catch(() => void 0);
		return next;
	}
});
async function refresh() {
	const [github, gitlab, views, projects] = await Promise.all([
		channel.connection("github"),
		channel.connection("gitlab"),
		channel.list(),
		db.project.listAll()
	]);
	await Promise.all([
		bin,
		join(directory, "gh"),
		join(directory, "glab")
	].map((path) => mkdir(path, {
		recursive: true,
		mode: 448
	})));
	const gitlabSite = new URL(gitlab.host ?? "https://gitlab.com");
	const gitlabHost = gitlabSite.host;
	const bot = (kind) => views.find((view) => view.id === kind)?.accounts.find((account) => account.role === "bot")?.name ?? "";
	await own(join(directory, "gh", "hosts.yml"), JSON.stringify(github.enabled && github.token ? { "github.com": {
		oauth_token: github.token,
		user: bot("github"),
		git_protocol: "https"
	} } : {}));
	await own(join(directory, "glab", "config.yml"), JSON.stringify({
		git_protocol: "https",
		hosts: gitlab.enabled && gitlab.token ? { [gitlabHost]: {
			token: gitlab.token,
			user: bot("gitlab"),
			api_protocol: gitlabSite.protocol.slice(0, -1),
			git_protocol: "https"
		} } : {}
	}));
	const shellPath = shellPathOf(basePath);
	for (const cli of ["gh", "glab"]) {
		const executable = await nativeCli(cli);
		const configKey = cli === "gh" ? "GH_CONFIG_DIR" : "GLAB_CONFIG_DIR";
		const hostKey = cli === "gh" ? "GH_HOST" : "GITLAB_HOST";
		const host = cli === "gh" ? "github.com" : gitlabHost;
		const keyringKeys = cli === "glab" ? ["GLAB_USE_KEYRING"] : [];
		const botEnv = [
			...tokens.map((key) => `unset ${key}`),
			`export PATH=${quote(shellPath)}`,
			`export ${configKey}=${quote(join(directory, cli).replaceAll("\\", "/"))}`,
			`export ${hostKey}=${quote(host)}`,
			...keyringKeys.map((key) => `export ${key}=false`)
		];
		await own(join(bin, cli), [
			"#!/bin/sh",
			`if [ -z "$${ROLE_MARKER}" ]; then exec ${executable ? quote(executable.replaceAll("\\", "/")) : "exit 127"} "$@"; fi`,
			...botEnv,
			executable ? `exec ${quote(executable.replaceAll("\\", "/"))} "$@"` : `echo '${cli} is not installed' >&2; exit 127`,
			""
		].join("\n"), 448);
		const cmd = (value) => value.replaceAll("%", "%%");
		const botCmd = [
			...tokens.map((key) => `set "${key}="`),
			`set "PATH=${cmd(basePath)}"`,
			`set "${configKey}=${cmd(join(directory, cli))}"`,
			`set "${hostKey}=${host}"`,
			...keyringKeys.map((key) => `set "${key}=false"`)
		];
		await own(join(bin, `${cli}.cmd`), [
			"@echo off",
			"setlocal",
			`if not defined ${ROLE_MARKER} goto plain`,
			...botCmd,
			executable ? `"${cmd(executable)}" %*` : `echo ${cli} is not installed 1>&2 & exit /b 127`,
			"exit /b %errorlevel%",
			":plain",
			executable ? `"${cmd(executable)}" %*` : `echo ${cli} is not installed 1>&2 & exit /b 127`,
			"exit /b %errorlevel%",
			""
		].join("\r\n"), 448);
	}
	const nativeGh = await nativeCli("gh");
	const escaping = [
		"GH_CONFIG_DIR",
		"GH_HOST",
		...tokens
	];
	await own(join(bin, "gh-default"), [
		"#!/bin/sh",
		`if [ -z "$${ROLE_MARKER}" ]; then exec ${nativeGh ? quote(nativeGh.replaceAll("\\", "/")) : "exit 127"} "$@"; fi`,
		...escaping.map((key) => `unset ${key}`),
		`export PATH=${quote(shellPath)}`,
		nativeGh ? `exec ${quote(nativeGh.replaceAll("\\", "/"))} "$@"` : "echo gh is not installed >&2; exit 127",
		""
	].join("\n"), 448);
	await own(join(bin, "gh-default.cmd"), [
		"@echo off",
		"setlocal",
		`if not defined ${ROLE_MARKER} goto plain`,
		...escaping.map((key) => `set "${key}="`),
		`set "PATH=${basePath.replaceAll("%", "%%")}"`,
		nativeGh ? `"${nativeGh.replaceAll("%", "%%")}" %*` : "echo gh is not installed 1>&2 & exit /b 127",
		"exit /b %errorlevel%",
		":plain",
		nativeGh ? `"${nativeGh.replaceAll("%", "%%")}" %*` : "echo gh is not installed 1>&2 & exit /b 127",
		"exit /b %errorlevel%",
		""
	].join("\r\n"), 448);
	const gitQuote = (value) => JSON.stringify(value);
	if (process.platform === "win32") await Promise.all(["git", "git.cmd"].map((name) => rm(join(bin, name), { force: true })));
	else {
		const nativeGit = await nativeCli("git");
		const gitEnv = [
			...identities.map((key) => `unset ${key}`),
			`export GIT_CONFIG_GLOBAL=${quote(gitconfig.replaceAll("\\", "/"))}`,
			"export GIT_CONFIG_NOSYSTEM=1",
			"export GIT_ASKPASS=",
			"export GIT_TERMINAL_PROMPT=0"
		];
		await own(join(bin, "git"), [
			"#!/bin/sh",
			`if [ -z "$${ROLE_MARKER}" ]; then exec ${nativeGit ? quote(nativeGit.replaceAll("\\", "/")) : "exit 127"} "$@"; fi`,
			...gitEnv,
			nativeGit ? `exec ${quote(nativeGit.replaceAll("\\", "/"))} "$@"` : "echo git is not installed >&2; exit 127",
			""
		].join("\n"), 448);
	}
	const cliPath = (cli) => quote(join(bin, cli).replaceAll("\\", "/"));
	const lines = [
		"[user]",
		"	useConfigOnly = true",
		"[credential]",
		"	helper =",
		"[credential \"https://github.com\"]",
		`\thelper = ${gitQuote(`!${cliPath("gh")} auth git-credential`)}`,
		`[credential "${gitlabSite.origin}"]`,
		`\thelper = ${gitQuote(`!f() { if test "$1" = get; then token=$( ${cliPath("glab")} config get token --host ${quote(gitlabHost)} ) || exit; test -n "$token" || exit; printf 'username=oauth2\\npassword=%s\\n' "$token"; fi; }; f`)}`,
		"[url \"https://github.com/\"]",
		"	insteadOf = git@github.com:",
		"	insteadOf = ssh://git@github.com/",
		`[url "${gitlabSite.origin}/"]`,
		`\tinsteadOf = git@${gitlabHost}:`,
		`\tinsteadOf = ssh://git@${gitlabHost}/`,
		"[filter \"lfs\"]",
		"	clean = git-lfs clean -- %f",
		"	smudge = git-lfs smudge -- %f",
		"	process = git-lfs filter-process",
		"	required = true"
	];
	for (const project of projects) {
		if (!project.remoteUrl) continue;
		const metadata = views.find((view) => view.id === (/github\.com[:/]/i.test(project.remoteUrl) ? "github" : "gitlab"));
		if (!metadata?.commitName || !metadata.commitEmail) continue;
		const identity = join(directory, `${project.id}.gitconfig`);
		await own(identity, `[user]\n\tname = ${gitQuote(metadata.commitName)}\n\temail = ${gitQuote(metadata.commitEmail)}\n`);
		const repositoryGitdir = join(project.directory, ".git").replaceAll("\\", "/");
		for (const pattern of [repositoryGitdir, `${repositoryGitdir}/`]) lines.push(`[includeIf ${gitQuote(`gitdir/i:${pattern}`)}]`, `\tpath = ${gitQuote(identity)}`);
	}
	await own(gitconfig, `${lines.join("\n")}\n`);
}
function shellPathOf(value) {
	if (process.platform !== "win32") return value;
	return value.split(delimiter).map((path) => path.replaceAll("\\", "/").replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`)).join(":");
}
async function nativeCli(cli) {
	for (const folder of basePath.split(delimiter)) {
		if (!folder) continue;
		const executable = join(folder, process.platform === "win32" ? `${cli}.exe` : cli);
		try {
			await access(executable);
			return executable;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
}
async function own(path, content, mode = 384) {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, content, { mode });
	await rename(temporary, path);
}
function quote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
// src/service/devops.ts
const authentications = /* @__PURE__ */ new Map();
const active = /* @__PURE__ */ new Map();
const lifetime = 6e5;
const devops = defineService({
	async start(channelId, host) {
		if (channelId !== "github" && channelId !== "gitlab") throw new TypeError("channel_unsupported");
		const origin = host !== void 0 ? site(channelId, host) : channelId === "github" ? "https://github.com" : void 0;
		const pending = active.get(channelId);
		if (pending) {
			if (origin && pending.origin && origin !== pending.origin) throw new Error("channel_auth_in_progress");
			return snapshot(pending);
		}
		prune();
		const task = {
			view: {
				id: randomUUID(),
				channelId,
				status: "pending",
				output: channelId === "github" ? "Waiting for GitHub authorization." : "Waiting for GitLab device authorization (GitLab 17.9+)."
			},
			origin,
			controller: new AbortController(),
			done: Promise.resolve()
		};
		const dispose = getServerContext(server).effect(() => () => cancel(task), "supermesh:devops");
		authentications.set(task.view.id, task);
		active.set(channelId, task);
		task.done = Promise.resolve().then(() => authenticate(task)).finally(() => {
			active.delete(channelId);
			task.finishedAt = Date.now();
		});
		task.done.then(() => dispose());
		return snapshot(task);
	},
	lookup(channelId, authenticationId) {
		prune();
		const task = authentications.get(authenticationId);
		return task?.view.channelId === channelId ? snapshot(task) : null;
	},
	async cancel(channelId) {
		if (channelId !== "github" && channelId !== "gitlab") throw new TypeError("channel_unsupported");
		const pending = active.get(channelId);
		if (pending) await cancel(pending);
	},
	async cleanup() {
		await Promise.all([...active.values()].map(cancel));
	},
	save(kind, patch) {
		return channel.serialize(() => save(kind, patch)).then(async (view) => {
			const { shell } = await import("./shell-BKWo3wWF.js");
			await shell.refresh();
			return view;
		});
	},
	removeCredentials(kind) {
		return channel.serialize(() => removeCredentials(kind)).then(async (view) => {
			const { shell } = await import("./shell-BKWo3wWF.js");
			await shell.refresh();
			return view;
		});
	}
});
async function removeCredentials(kind) {
	if (kind !== "github" && kind !== "gitlab") throw new TypeError("channel_unsupported");
	const previous = await channel.clearCredential(kind);
	try {
		await db.channel.removeCredentials(kind);
	} catch {
		if (previous) await channel.storeCredential(kind, previous);
		throw new Error("channel_credentials_delete_failed");
	}
	return (await channel.list()).find((item) => item.kind === kind);
}
async function save(kind, patch) {
	if (kind !== "github" && kind !== "gitlab") throw new TypeError("channel_unsupported");
	if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => ![
		"host",
		"enabled",
		"commitName",
		"commitEmail",
		"token"
	].includes(key)) || patch.enabled !== void 0 && typeof patch.enabled !== "boolean" || [
		"host",
		"commitName",
		"commitEmail",
		"token"
	].some((key) => patch[key] !== void 0 && typeof patch[key] !== "string")) throw new TypeError("invalid_channel_config");
	if (patch.token !== void 0 && (!patch.token.trim() || patch.token.length > 8192 || /[\r\n]/.test(patch.token))) throw new TypeError("invalid_channel_token");
	if ((patch.commitName?.length ?? 0) > 200 || (patch.commitEmail?.length ?? 0) > 254 || /[\r\n]/.test((patch.commitName ?? "") + (patch.commitEmail ?? "")) || patch.commitEmail && !/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(patch.commitEmail.trim())) throw new TypeError("invalid_commit_identity");
	const current = (await channel.list()).find((item) => item.kind === kind);
	let url;
	try {
		url = new URL(patch.host ?? current.host ?? (kind === "github" ? "https://github.com" : "https://gitlab.com"));
	} catch {
		throw new TypeError("invalid_channel_host");
	}
	if (!(url.protocol === "https:" || kind === "gitlab" && url.protocol === "http:") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || kind === "github" && url.origin !== "https://github.com") throw new TypeError("invalid_channel_host");
	const hostChanged = kind === "gitlab" && url.origin !== new URL(current.host ?? "https://gitlab.com").origin;
	const token = patch.token?.trim();
	let account;
	if (hostChanged && (current.hasCredential || current.accounts.length > 0) && !token) throw new TypeError("channel_account_required");
	if (token) account = await verify(kind, url, token);
	const enabled = patch.enabled ?? (Boolean(account) || current.enabled);
	if (enabled && !account && !current.accounts.some((account) => account.role === "bot" && account.status === "online")) throw new TypeError("channel_account_required");
	let identity = account;
	if (!identity && !current.providerId && (patch.commitName !== void 0 || patch.commitEmail !== void 0)) {
		const stored = await channel.resolveCredential(kind);
		if (stored) identity = await verify(kind, url, stored).catch(() => void 0);
	}
	const providerId = identity?.providerId ?? current.providerId;
	const login = identity?.name ?? current.accounts.find((account) => account.role === "bot")?.name ?? "";
	const commitEmail = (patch.commitEmail?.trim() ?? current.commitEmail) || noreplyEmail(kind, login, providerId, url.origin);
	const previous = token ? await channel.storeCredential(kind, token) : void 0;
	try {
		await db.channel.saveConfiguration(kind, current.name, kind === "gitlab" ? url.origin : null, enabled, {
			commitName: patch.commitName?.trim() ?? current.commitName,
			commitEmail,
			providerId
		}, account, ...hostChanged ? [true] : []);
	} catch {
		if (token) {
			if (previous) await channel.storeCredential(kind, previous);
			else await channel.clearCredential(kind);
		}
		throw new Error("channel_save_failed");
	}
	return (await channel.list()).find((item) => item.kind === kind);
}
async function verify(kind, url, token) {
	const endpoint = kind === "github" ? "https://api.github.com/user" : `${url.origin}/api/v4/user`;
	const env = await channelProxyEnvironment(new URL(endpoint), process.env);
	const dispatcher = await createRouteDispatcher({ get: (name) => env[name] === void 0 ? void 0 : { value: env[name] } }, { allowH2: false });
	try {
		let response;
		try {
			response = await fetch(endpoint, {
				dispatcher,
				headers: {
					authorization: `Bearer ${token}`,
					accept: kind === "github" ? "application/vnd.github+json" : "application/json"
				},
				signal: AbortSignal.timeout(15e3),
				redirect: "error"
			});
		} catch {
			throw new Error("channel_verification_failed");
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("channel_auth_failed");
		}
		let identity;
		try {
			identity = await response.json();
		} catch {
			throw new Error("channel_auth_failed");
		}
		if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("channel_auth_failed");
		const user = identity;
		const login = kind === "github" ? user.login : user.username ?? user.name;
		if (typeof login !== "string" || !login.trim() || login.length > 200 || /[\r\n]/.test(login)) throw new Error("channel_auth_failed");
		const id = user.id;
		if (typeof id !== "number" && typeof id !== "string") throw new Error("channel_auth_failed");
		const providerId = String(id);
		if (!/^\d+$/.test(providerId)) throw new Error("channel_auth_failed");
		return {
			name: login.trim(),
			avatar: null,
			providerId
		};
	} finally {
		await dispatcher.close();
	}
}
function snapshot(task) {
	return {
		...task.view,
		...task.view.account ? { account: { ...task.view.account } } : {}
	};
}
function prune() {
	for (const [id, task] of authentications) if (task.finishedAt && (Date.now() - task.finishedAt > lifetime || authentications.size >= 32)) authentications.delete(id);
}
async function cancel(task) {
	if (!task.finishedAt) task.controller.abort();
	await task.done;
}
async function authenticate(task) {
	const directory = join(DSH_PLUGIN_HOME, `${task.view.channelId}-auth`, task.view.id);
	let env = Object.fromEntries(Object.entries(shell.commandEnvironment()).filter(([key]) => key === "GITLAB_CLIENT_ID" || !/^(?:GH_|GITHUB_|GLAB_|GITLAB_|OAUTH_TOKEN$|CI_JOB_TOKEN$|GL_HOST$|BROWSER$|API_PROTOCOL$|SKIP_TLS_VERIFY$|NO_PROMPT$|PROMPT_DISABLED$)/i.test(key)));
	env.GH_CONFIG_DIR = directory;
	env.GLAB_CONFIG_DIR = directory;
	env.GH_HOST = "github.com";
	env.GH_BROWSER = `"${process.execPath.replaceAll("\\", "/")}" -e "process.exit(0)"`;
	env.ELECTRON_RUN_AS_NODE = "1";
	env.GLAB_BROWSER = env.GH_BROWSER;
	env.GLAB_CHECK_UPDATE = "false";
	env.GLAB_SKIP_TLS_VERIFY = "false";
	env.GLAB_API_PROTOCOL = "https";
	env.GLAB_USE_KEYRING = "false";
	env.GH_PAGER = "cat";
	env.NO_COLOR = "1";
	const timeout = setTimeout(() => task.controller.abort(), lifetime);
	timeout.unref();
	try {
		task.controller.signal.throwIfAborted();
		await mkdir(directory, {
			recursive: true,
			mode: 448
		});
		if (!task.origin) task.origin = site(task.view.channelId, (await channel.list()).find((item) => item.id === task.view.channelId)?.host ?? "https://gitlab.com");
		env = await channelProxyEnvironment(new URL(task.origin), env);
		const hostname = new URL(task.origin).host;
		const args = task.view.channelId === "github" ? [
			"auth",
			"login",
			"--hostname",
			hostname,
			"--git-protocol",
			"https",
			"--web",
			"--insecure-storage"
		] : [
			"auth",
			"login",
			"--hostname",
			hostname,
			"--git-protocol",
			"https",
			"--api-protocol",
			"https",
			"--device",
			"--insecure-storage"
		];
		if (task.view.channelId === "gitlab") throw new TypeError("channel_gitlab_token_only");
		await command(task, args, env, true);
		task.controller.signal.throwIfAborted();
		const token = (await command(task, task.view.channelId === "github" ? [
			"auth",
			"token",
			"--hostname",
			hostname
		] : [
			"config",
			"get",
			"token",
			"--host",
			hostname
		], env, false)).trim();
		if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new Error("channel_auth_token_failed");
		task.controller.signal.throwIfAborted();
		const account = (await devops.save(task.view.channelId, {
			token,
			...task.view.channelId === "gitlab" ? { host: task.origin } : {}
		})).accounts.find((account) => account.role === "bot");
		if (!account) throw new Error("channel_auth_verification_failed");
		task.view.account = { login: account.name };
		task.view.status = "succeeded";
	} catch (error) {
		task.view.status = "failed";
		const missing = error instanceof Error && error.code === "ENOENT";
		task.view.error = task.controller.signal.aborted ? "channel_auth_cancelled" : missing ? task.view.channelId === "github" ? "gh_missing" : "glab_missing" : task.networkTimeout ? "channel_auth_network_timeout" : "channel_auth_failed";
		publish(task.view, missing ? `Required CLI is not installed: ${task.view.channelId === "github" ? "gh" : "glab"}.` : task.controller.signal.aborted ? "Authentication cancelled." : task.networkTimeout ? `连接授权服务器超时，尚未完成登录。${env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy ? "CLI已继承代理配置（宿主或Windows已启用配置），请检查代理连通性及绕过规则。" : "CLI未收到HTTP(S)代理配置，当前使用直连；请检查宿主或Windows系统代理设置。"}终端可登录不代表宿主子进程使用相同网络路径。` : "Authentication failed. Review the CLI output above.");
	} finally {
		clearTimeout(timeout);
		try {
			await rm(directory, {
				recursive: true,
				force: true
			});
		} catch {
			if (task.view.status !== "succeeded") task.view.status = "failed";
			task.view.error = "channel_auth_cleanup_failed";
		}
	}
}
function command(task, args, env, login) {
	return new Promise((resolve, reject) => {
		task.controller.signal.throwIfAborted();
		const child = spawn(task.view.channelId === "github" ? "gh" : "glab", args, {
			env,
			cwd: env.GH_CONFIG_DIR,
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			signal: task.controller.signal
		});
		let output = "";
		const stdout = lines(task);
		const stderr = lines(task);
		let failure;
		let force;
		const abort = () => {
			force = setTimeout(() => child.kill("SIGKILL"), 1e3);
			force.unref();
		};
		task.controller.signal.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => {
			failure = error;
		});
		child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk) => {
			if (login) stdout.write(chunk);
			else {
				output = (output + chunk.toString("utf8")).slice(0, 8193);
				if (output.length > 8192) {
					failure = /* @__PURE__ */ new Error("channel_auth_output_limit");
					task.controller.abort();
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			if (login) stderr.write(chunk);
		});
		child.once("close", (code) => {
			clearTimeout(force);
			task.controller.signal.removeEventListener("abort", abort);
			if (login) {
				stdout.end();
				stderr.end();
			}
			if (failure || code !== 0 || task.controller.signal.aborted) {
				if (login && code !== 0 && !task.controller.signal.aborted && !failure) publish(task.view, `CLI exited with status ${code ?? "unknown"}.`);
				reject(failure ?? /* @__PURE__ */ new Error("channel_auth_process_failed"));
			} else resolve(output);
		});
		child.stdin.end(login ? "\n" : void 0);
	});
}
function authorize$1(task, raw) {
	const view = task.view;
	const text = stripVTControlCharacters(raw);
	const code = /(?:one[- ]time|device|user) code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(text);
	if (code) view.userCode = code[1].toUpperCase();
	for (const match of text.matchAll(/https:\/\/[^\s'"<>]+/gi)) try {
		const url = new URL(match[0]);
		const allowed = view.channelId === "github" ? ["/login/device"] : ["/oauth/device", "/-/oauth/device"];
		if (url.origin === task.origin && !url.username && !url.password && !url.search && !url.hash && allowed.includes(url.pathname)) view.verificationUri = url.href;
	} catch {}
	publish(view, text);
}
function site(channelId, host) {
	try {
		const url = new URL(host);
		if ((url.protocol === "https:" || channelId === "gitlab" && url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && (channelId !== "github" || url.origin === "https://github.com")) return url.origin;
	} catch {}
	throw new TypeError("invalid_channel_host");
}
function publish(view, line) {
	view.output = [view.output, line].filter(Boolean).join("\n").slice(-1024);
}
function lines(task) {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let discarded = false;
	const complete = () => {
		const text = [...stripVTControlCharacters(pending)].filter((char) => char.charCodeAt(0) >= 32 || char === "	").join("").trim();
		if (!discarded && /(?:dial tcp|connectex|connection|connect|i\/o|TLS handshake|request|context deadline).*(?:timed? out|timeout|deadline exceeded)|(?:timed? out|timeout).*(?:connect|request)/i.test(text)) task.networkTimeout = true;
		if (!discarded && text && !/token|password|authorization|secret|gh[pousr]_|github_pat_|glpat[-_]|Bearer\s|\b[\w=-]{40,}\b/i.test(text)) authorize$1(task, text.replace(/https?:\/\/[^\s'"<>]+/gi, (raw) => {
			try {
				const url = new URL(raw);
				const paths = task.view.channelId === "github" ? [
					"/login/device",
					"/login/device/code",
					"/login/oauth/access_token"
				] : [
					"/oauth/device",
					"/-/oauth/device",
					"/oauth/device/code",
					"/oauth/token"
				];
				if (url.origin === task.origin && !url.username && !url.password && paths.includes(url.pathname)) return `${url.origin}${url.pathname}`;
			} catch {}
			return "[URL omitted]";
		}));
		pending = "";
		discarded = false;
	};
	return {
		write(chunk) {
			const parts = decoder.write(chunk).split("\n");
			for (let index = 0; index < parts.length; index++) {
				if (!discarded) {
					if (pending.length + parts[index].length > 4096) {
						pending = "";
						discarded = true;
					} else pending += parts[index];
				}
				if (index < parts.length - 1) complete();
			}
		},
		end() {
			pending += decoder.end();
			complete();
		}
	};
}
// src/server/routes/channel.[id].authentication.[authenticationId].get.ts
var channel__id__authentication__authenticationId__get_default = defineHandler((event) => {
	const id = getRouterParam(event, "id");
	const authenticationId = getRouterParam(event, "authenticationId");
	if (!id || !authenticationId) throw new HTTPError({
		status: 400,
		message: "invalid_authentication"
	});
	const authentication = devops.lookup(id, authenticationId);
	if (!authentication) throw new HTTPError({
		status: 404,
		message: "channel_auth_not_found"
	});
	return authentication;
});
// src/server/routes/channel.[id].authentication.post.ts
var channel__id__authentication_post_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id");
	if (!id) throw new HTTPError({
		status: 400,
		message: "invalid_channel"
	});
	const body = await readBody(event);
	if (body !== void 0 && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "host") || body.host !== void 0 && typeof body.host !== "string")) throw new HTTPError({
		status: 400,
		message: "invalid_authentication"
	});
	try {
		return await devops.start(id, body?.host);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message === "channel_unsupported" || message === "invalid_channel_host") throw new HTTPError({
			status: 400,
			message
		});
		if (message === "channel_auth_in_progress") throw new HTTPError({
			status: 409,
			message
		});
		throw new HTTPError({
			status: 503,
			message: "channel_auth_unavailable"
		});
	}
});
// src/server/routes/channel.[id].configuration.put.ts
var channel__id__configuration_put_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id");
	const body = await readBody(event);
	if (!id || !body) throw new HTTPError({
		status: 400,
		message: "invalid_channel_config"
	});
	try {
		return { channel: await devops.save(id, body) };
	} catch (error) {
		const message = error instanceof Error && [
			"channel_unsupported",
			"invalid_channel_config",
			"invalid_channel_token",
			"invalid_commit_identity",
			"invalid_channel_host",
			"invalid_expected_account",
			"channel_identity_mismatch",
			"channel_account_required",
			"channel_auth_failed",
			"channel_verification_failed"
		].includes(error.message) ? error.message : "channel_save_failed";
		throw new HTTPError({
			status: error instanceof TypeError ? 400 : message === "channel_auth_failed" ? 422 : 502,
			message
		});
	}
});
// src/server/routes/channel.[id].credential.delete.ts
var channel__id__credential_delete_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id");
	if (!id) throw new HTTPError({
		status: 400,
		message: "channel_unsupported"
	});
	try {
		await devops.cancel(id);
		return { channel: await devops.removeCredentials(id) };
	} catch (error) {
		const unsupported = error instanceof TypeError && error.message === "channel_unsupported";
		throw new HTTPError({
			status: unsupported ? 400 : 502,
			message: unsupported ? "channel_unsupported" : "channel_credentials_delete_failed"
		});
	}
});
// src/server/routes/channel.get.ts
var channel_get_default = defineHandler(async () => channel.list());
// src/server/routes/delivery.get.ts
var delivery_get_default = defineHandler(async () => db.inbox.listRecent());
// src/server/routes/edge.get.ts
var edge_get_default = defineHandler(async () => {
	const [runningWorkers, queuedWorkers, links, openTickets] = await Promise.all([
		db.worker.listRunning(),
		db.worker.listQueued(),
		db.ticketLink.listAll(),
		db.ticket.listOpen()
	]);
	const activeWorkers = [...new Map([...queuedWorkers, ...runningWorkers].map((worker) => [worker.id, worker])).values()];
	const runningTicketIds = new Set(runningWorkers.map((worker) => worker.ticketId));
	const ticketMap = new Map(openTickets.map((ticket) => [ticket.id, ticket]));
	for (const ticket of await Promise.all([...new Set(activeWorkers.map((worker) => worker.ticketId))].filter((id) => !ticketMap.has(id)).map((id) => db.ticket.findById(id)))) if (ticket) ticketMap.set(ticket.id, ticket);
	return [
		...[...new Set([...ticketMap.values()].map((ticket) => ticket.projectId))].map((projectId) => ({
			source: "orchestrator",
			target: `project:${projectId}`,
			kind: "flow"
		})),
		...[...ticketMap.values()].map((ticket) => ({
			source: `project:${ticket.projectId}`,
			target: `ticket:${ticket.id}`,
			kind: "flow"
		})),
		...activeWorkers.filter((worker) => runningTicketIds.has(worker.ticketId) || ticketMap.has(worker.ticketId)).map((worker) => ({
			source: `ticket:${worker.ticketId}`,
			target: `worker:${worker.id}`,
			kind: "flow"
		})),
		...links.map((link) => ({
			source: `ticket:${link.ticketId}`,
			target: `ticket:${link.relatedId}`,
			kind: link.kind === "depends" ? "dependency" : "association"
		}))
	];
});
// src/server/routes/group.get.ts
var group_get_default = defineHandler(async () => {
	const [supervisors, scopes, runningWorkers, queuedWorkers, openTickets] = await Promise.all([
		db.supervisor.listActive(),
		db.supervisorTicket.listAll(),
		db.worker.listRunning(),
		db.worker.listQueued(),
		db.ticket.listOpen()
	]);
	const activeWorkers = [...new Map([...queuedWorkers, ...runningWorkers].map((worker) => [worker.id, worker])).values()];
	const runningTicketIds = new Set(runningWorkers.map((worker) => worker.ticketId));
	const ticketMap = new Map(openTickets.map((ticket) => [ticket.id, ticket]));
	for (const ticket of await Promise.all([...new Set(activeWorkers.map((worker) => worker.ticketId))].filter((id) => !ticketMap.has(id)).map((id) => db.ticket.findById(id)))) if (ticket) ticketMap.set(ticket.id, ticket);
	const current = [...ticketMap.values()].filter((ticket) => ![
		"closed",
		"done",
		"completed",
		"cancelled"
	].includes(ticket.status) || runningTicketIds.has(ticket.id));
	return supervisors.map((supervisor) => ({
		id: `supervisor:${supervisor.id}`,
		label: supervisor.title,
		sessionId: supervisor.sessionId,
		nodeIds: [...new Set(scopes.filter((scope) => scope.supervisorId === supervisor.id).flatMap((scope) => {
			const ticket = current.find((item) => item.id === scope.ticketId);
			return ticket ? [`project:${ticket.projectId}`] : [];
		}))]
	})).filter((group) => group.nodeIds.length);
});
// src/server/routes/message.get.ts
var message_get_default = defineHandler(async () => db.inbox.listRecent());
// src/service/worktree.ts
const execute = promisify(execFile);
let controller$1 = new AbortController();
const worktree = defineService({
	start() {
		if (singlet.busy()) throw new Error("worktree_busy");
		controller$1 = new AbortController();
		return async () => {
			controller$1.abort(/* @__PURE__ */ new Error("worktree_stopped"));
			await Promise.allSettled([singlet.drain()]);
		};
	},
	peek: singlet((directory) => `worktree:peek:${resolve(directory)}`, async (directory) => {
		const root = await realpath(directory);
		let gitRoot;
		try {
			gitRoot = await git(root, ["rev-parse", "--show-toplevel"]);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === 128 && "stderr" in error && typeof error.stderr === "string" && error.stderr.includes("not a git repository")) return null;
			throw error;
		}
		if (!samePath$1(gitRoot, root)) return null;
		return {
			directory: root,
			remoteUrl: (await git(root, ["remote"])).split(String.fromCharCode(10)).includes("origin") ? await git(root, [
				"config",
				"--get",
				"remote.origin.url"
			]) : null
		};
	}),
	clone: singlet((remoteUrl, target) => `worktree:clone:${process.platform === "win32" ? resolve(target).toLowerCase() : resolve(target)}:${remoteUrl}`, async (remoteUrl, target, gitlabHost, signal) => {
		signal?.throwIfAborted();
		const repository = parseRepositoryRemote(remoteUrl, gitlabHost);
		const result = await (async () => {
			if (!isAbsolute(target)) throw new Error("invalid_repository_path");
			const existing = await existingRepository(target, repository.webUrl, gitlabHost);
			if (existing) return existing;
			await mkdir(dirname(target), { recursive: true });
			if (!samePath$1(await realpath(dirname(target)), dirname(target))) throw new Error("repository_path_conflict");
			const temporary = await mkdtemp(join(dirname(target), ".supermesh-clone-"));
			try {
				await git(temporary, [
					"-c",
					"http.followRedirects=false",
					"-c",
					"protocol.file.allow=never",
					"clone",
					"--",
					repository.remoteUrl,
					temporary
				], signal, 12e4);
				const facts = await worktree.peek(temporary);
				if (!facts?.remoteUrl || parseRepositoryRemote(facts.remoteUrl, gitlabHost).webUrl !== repository.webUrl) throw new Error("repository_remote_mismatch");
				signal?.throwIfAborted();
				controller$1.signal.throwIfAborted();
				const raced = await existingRepository(target, repository.webUrl, gitlabHost);
				if (raced) return raced;
				await rename(temporary, target);
				return {
					directory: await realpath(target),
					remoteUrl: repository.remoteUrl
				};
			} finally {
				await rm(temporary, {
					recursive: true,
					force: true
				});
			}
		})();
		if (parseRepositoryRemote(result.remoteUrl, gitlabHost).webUrl !== repository.webUrl) throw new Error("repository_path_conflict");
		return result;
	}),
	async create(agent, branch) {
		const ctx = getServerContext(server);
		if (!ctx.worktrees) throw new Error("worktrees_unavailable");
		let failure;
		for (let attempt = 1; attempt <= 5; attempt++) {
			const name = attempt === 1 ? branch : `${branch}-${attempt}`;
			try {
				const created = await ctx.worktrees.create(agent, {
					name,
					from: "HEAD"
				});
				return {
					branch: created.branch,
					worktree: created.path,
					baseCommit: created.baseCommit,
					repositoryRoot: created.repositoryRoot
				};
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("already exists")) throw createFailure(name, error);
				failure = error;
			}
		}
		throw createFailure(branch, failure ?? /* @__PURE__ */ new Error("worktree_branch_conflict"));
	},
	verify: singlet((_directory, target) => `worktree:verify:${resolve(target)}`, async (directory, target, branch) => {
		const root = await realpath(directory);
		const actual = await realpath(target);
		if (samePath$1(root, actual) || !samePath$1(target, actual)) throw new Error("worktree_path_conflict");
		const registered = (await git(root, [
			"worktree",
			"list",
			"--porcelain",
			"-z"
		])).split("\0\0").map((entry) => entry.split("\0")).find((fields) => fields.some((field) => field.startsWith("worktree ") && samePath$1(field.slice(9), actual)));
		if (!registered || registered.some((field) => field === "locked" || field.startsWith("locked "))) throw new Error("worktree_registration_conflict");
		if (!samePath$1(resolve(root, await git(root, ["rev-parse", "--git-common-dir"])), resolve(actual, await git(actual, ["rev-parse", "--git-common-dir"]))) || await git(actual, ["branch", "--show-current"]) !== branch) throw new Error("worktree_branch_conflict");
	})
});
function createFailure(branch, error) {
	return new Error(`worktree.create(${branch}, from HEAD) failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
async function existingRepository(target, webUrl, gitlabHost) {
	try {
		const entry = await lstat(target);
		if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath$1(target, await realpath(target))) throw new Error("repository_path_conflict");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	const facts = await worktree.peek(target);
	if (!facts?.remoteUrl) throw new Error("repository_path_conflict");
	let remote;
	try {
		remote = parseRepositoryRemote(facts.remoteUrl, gitlabHost);
	} catch {
		throw new Error("repository_path_conflict");
	}
	if (remote.webUrl !== webUrl) throw new Error("repository_path_conflict");
	return {
		directory: facts.directory,
		remoteUrl: remote.remoteUrl
	};
}
async function git(cwd, args, signal, timeout = 15e3) {
	const operationSignal = signal ? AbortSignal.any([controller$1.signal, signal]) : controller$1.signal;
	operationSignal.throwIfAborted();
	return (await execute("git", args, {
		cwd,
		signal: operationSignal,
		timeout,
		maxBuffer: 4194304,
		windowsHide: true,
		env: {
			...process.env,
			LC_ALL: "C",
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=15"
		}
	})).stdout.trim();
}
function samePath$1(left, right) {
	return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}
// src/service/project.ts
let syncing;
let controller = new AbortController();
let stopped$1 = false;
const repositories = /* @__PURE__ */ new Map();
const COLLECTION_STATE = "collection_status";
const project = defineService({
	start() {
		if (repositories.size || syncing) throw new Error("project_busy");
		controller = new AbortController();
		stopped$1 = false;
		return async () => {
			stopped$1 = true;
			controller.abort(/* @__PURE__ */ new Error("project_stopped"));
			await Promise.allSettled([...repositories.values(), ...syncing ? [syncing] : []]);
		};
	},
	async list() {
		const [rows, gitlabHost, statuses] = await Promise.all([
			db.project.listAll(),
			gitlabChannelHost(),
			db.sourceState.listBySuffix(COLLECTION_STATE)
		]);
		const collection = new Map(statuses.map((row) => [row.name.slice(0, row.name.length - 17 - 1), collectionStatus(row.value)]));
		const workspaces = getServerContext(server).workspaceRegistry.list();
		return Promise.all(rows.map(async (current) => {
			const workspace = workspaces.find((workspace) => workspace.id === current.workspaceId);
			const facts = workspace && await workspace.status() === "ok" ? await repositoryFacts(workspace.path, gitlabHost) : null;
			return {
				...current,
				available: Boolean(facts?.remoteUrl && samePath(facts.directory, current.directory)),
				collection: collection.get(current.id) ?? null
			};
		}));
	},
	addRepository(remoteUrl, name, signal) {
		return addRepository(remoteUrl, name, signal);
	},
	async open(id, signal) {
		const current = await db.project.findById(id);
		if (!current) throw new Error("project_not_found");
		const ctx = getServerContext(server);
		if (!ctx.sessionController.canOpenWorkspacePath()) throw new Error("native_open_unavailable");
		return ctx.sessionController.openWorkspacePath({ path: current.directory }, signal);
	},
	sync() {
		if (stopped$1) return Promise.reject(/* @__PURE__ */ new Error("project_stopped"));
		return queueSync();
	}
});
async function addRepository(remoteUrl, name, requestSignal) {
	if (stopped$1) throw new Error("project_stopped");
	const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
	const gitlabHost = await gitlabChannelHost();
	const remote = parseGitRemote(remoteUrl, gitlabHost);
	const platform = remote.host === "github.com" ? "github" : remote.host;
	if (name !== void 0 && (typeof name !== "string" || !name.trim() || name.trim().length > 200 || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new Error("invalid_workspace_name");
	const active = repositories.get(remote.webUrl);
	if (active) return active;
	const task = (async () => {
		signal?.throwIfAborted();
		const registry = getServerContext(server).workspaceRegistry;
		let directory;
		for (const workspace of registry.list()) {
			if (await workspace.status() !== "ok") continue;
			const facts = await repositoryFacts(workspace.path, gitlabHost);
			if (facts?.remoteUrl === remote.webUrl) {
				directory = facts.directory;
				break;
			}
		}
		if (!directory) {
			const target = join(DSH_PLUGIN_HOME, "repositories", platform, remote.host.replace(":", "_"), remote.owner, remote.name);
			try {
				directory = (await worktree.clone(remote.remoteUrl, resolve(target), gitlabHost, signal)).directory;
			} catch (error) {
				if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw new Error("repository_clone_cancelled");
				if (error instanceof Error && [
					"repository_path_conflict",
					"repository_remote_mismatch",
					"worktree_stopped"
				].includes(error.message)) throw error;
				if (error instanceof Error && "killed" in error && error.killed) throw new Error("repository_clone_timeout");
				throw new Error("repository_clone_failed");
			}
		}
		signal.throwIfAborted();
		if (parseGitRemote(remoteUrl, gitlabHost).webUrl !== remote.webUrl || (await repositoryFacts(directory, gitlabHost))?.remoteUrl !== remote.webUrl) throw new Error("repository_remote_mismatch");
		signal.throwIfAborted();
		const workspace = await registry.create(directory, name?.trim() ?? `${platform}/${remote.name}`);
		await queueSync();
		const current = await db.project.findByWorkspace(workspace.id);
		if (!current) throw new Error("repository_registration_failed");
		return {
			project: current,
			workspaceId: workspace.id
		};
	})().finally(() => repositories.delete(remote.webUrl));
	repositories.set(remote.webUrl, task);
	return task;
}
function queueSync() {
	const task = (syncing ? syncing.then(synchronize, synchronize) : synchronize()).finally(() => {
		if (syncing === task) syncing = void 0;
	});
	syncing = task;
	return task;
}
async function synchronize() {
	const registry = getServerContext(server).workspaceRegistry;
	const gitlabHost = await gitlabChannelHost();
	const available = [];
	const now = (/* @__PURE__ */ new Date()).toISOString();
	for (const workspace of registry.list()) {
		if (await workspace.status() !== "ok") continue;
		const facts = await repositoryFacts(workspace.path, gitlabHost);
		if (!facts) continue;
		const current = await db.project.findByWorkspace(workspace.id);
		if (!current && !facts.remoteUrl) continue;
		if (facts.remoteUrl) available.push(workspace.id);
		await db.project.upsertWorkspace({
			id: current?.id ?? workspace.id,
			workspaceId: workspace.id,
			name: workspace.title,
			directory: facts.directory,
			remoteUrl: facts.remoteUrl
		}, now);
	}
	await db.project.disableUnavailable(available, now);
	return db.project.listAll();
}
async function repositoryFacts(directory, gitlabHost) {
	let facts;
	try {
		facts = await worktree.peek(directory);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	if (!facts?.remoteUrl) return facts;
	try {
		return {
			...facts,
			remoteUrl: parseGitRemote(facts.remoteUrl, gitlabHost).webUrl
		};
	} catch {
		return {
			...facts,
			remoteUrl: null
		};
	}
}
async function gitlabChannelHost() {
	return (await db.channel.findById("gitlab"))?.host ?? void 0;
}
function collectionStatus(value) {
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("ok" in parsed) || !("reasons" in parsed) || !("collectedAt" in parsed)) return null;
	const { ok, reasons, collectedAt } = parsed;
	if (typeof ok !== "boolean" || !Array.isArray(reasons) || typeof collectedAt !== "string") return null;
	return {
		ok,
		reasons: reasons.filter((reason) => typeof reason === "string"),
		collectedAt
	};
}
function samePath(left, right) {
	return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}
// src/server/routes/node.get.ts
var node_get_default = defineHandler(async () => {
	const [projects, runningWorkers, queuedWorkers, openTickets, channelCatalog] = await Promise.all([
		project.list(),
		db.worker.listRunning(),
		db.worker.listQueued(),
		db.ticket.listOpen(),
		channel.list()
	]);
	async function activity(id, role, projectId) {
		if (!id) return {
			sessionId: null,
			status: "not_created"
		};
		const identity = await session.resolve(id);
		if (identity?.role !== role || role === "project" && identity.projectId !== projectId) return {
			sessionId: null,
			status: "not_created"
		};
		const state = await session.activity(id);
		return {
			sessionId: id,
			status: state.running ? "running" : state.background ? "background" : state.queued ? "queued" : "idle"
		};
	}
	const mainBinding = await activity(await session.findMain(), "main");
	const projectBindings = await Promise.all(projects.map(async (item) => ({
		id: item.id,
		...await activity(item.orchestratorSessionId ?? null, "project", item.id)
	})));
	const projectSessions = new Map(projectBindings.map((item) => [item.id, item]));
	const activeWorkers = [...new Map([...queuedWorkers, ...runningWorkers].map((worker) => [worker.id, worker])).values()];
	const runningTicketIds = new Set(runningWorkers.map((worker) => worker.ticketId));
	const ticketMap = new Map(openTickets.map((ticket) => [ticket.id, ticket]));
	for (const ticket of await Promise.all([...new Set(activeWorkers.map((worker) => worker.ticketId))].filter((id) => !ticketMap.has(id)).map((id) => db.ticket.findById(id)))) if (ticket) ticketMap.set(ticket.id, ticket);
	const currentTickets = [...ticketMap.values()].filter((ticket) => ![
		"closed",
		"done",
		"completed",
		"cancelled"
	].includes(ticket.status) || runningTicketIds.has(ticket.id));
	const currentTicketIds = new Set(currentTickets.map((ticket) => ticket.id));
	const currentWorkers = activeWorkers.filter((worker) => currentTicketIds.has(worker.ticketId) && (worker.status === "running" || ![
		"closed",
		"done",
		"completed",
		"cancelled"
	].includes(ticketMap.get(worker.ticketId).status)));
	const currentProjects = projects.filter((item) => [
		"running",
		"background",
		"queued"
	].includes(projectSessions.get(item.id).status) || currentTickets.some((ticket) => ticket.projectId === item.id));
	const hasRuntime = currentTickets.length > 0 || currentProjects.length > 0 || [
		"running",
		"background",
		"queued"
	].includes(mainBinding.status);
	const channels = channelCatalog.filter((item) => item.configured && item.supported && currentTickets.some((ticket) => ticket.channelId === item.id));
	return [
		...channels.length ? [{
			id: "channel",
			kind: "channel",
			label: channels.map((item) => item.name).join(" · "),
			status: "configured",
			projectId: null,
			ticketId: null,
			sessionId: null
		}] : [],
		...hasRuntime ? [{
			id: "orchestrator",
			kind: "orchestrator",
			label: mainBinding.sessionId ?? "",
			status: mainBinding.status,
			projectId: null,
			ticketId: null,
			sessionId: mainBinding.sessionId
		}] : [],
		...currentProjects.map((item) => ({
			id: `project:${item.id}`,
			kind: "project",
			label: item.name,
			status: projectSessions.get(item.id).status,
			projectId: item.id,
			ticketId: null,
			sessionId: projectSessions.get(item.id).sessionId
		})),
		...currentTickets.map((ticket) => ({
			id: `ticket:${ticket.id}`,
			kind: "ticket",
			label: ticket.title,
			status: ticket.paused ? "paused" : ticket.prepareError ? "error" : ticket.status,
			projectId: ticket.projectId,
			ticketId: ticket.id,
			sessionId: null
		})),
		...currentWorkers.map((worker) => ({
			id: `worker:${worker.id}`,
			kind: "worker",
			label: worker.title,
			status: worker.status,
			projectId: ticketMap.get(worker.ticketId).projectId,
			ticketId: worker.ticketId,
			sessionId: worker.status === "running" ? worker.id : null
		}))
	];
});
// src/server/routes/pending.get.ts
var pending_get_default = defineHandler(async () => {
	const [pending, openTickets] = await Promise.all([db.inbox.listPending("user"), db.ticket.listOpen()]);
	return pending.filter((message) => !message.ticketId || openTickets.some((ticket) => ticket.id === message.ticketId));
});
// src/server/routes/project.[id].opening.post.ts
var project__id__opening_post_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id", { decode: true });
	if (!id?.trim()) throw new HTTPError({
		status: 400,
		message: "project_id_required"
	});
	try {
		return await project.open(id, event.req.signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : "repository_open_failed";
		throw new HTTPError({
			status: message === "project_not_found" ? 404 : message === "native_open_unavailable" ? 503 : 502,
			message
		});
	}
});
// src/server/routes/project.[id].patch.ts
var project__id__patch_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id", { decode: true });
	const body = await readBody(event);
	if (!id?.trim() || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "enabled") || typeof body.enabled !== "boolean") throw new HTTPError({
		status: 400,
		message: "invalid_enabled"
	});
	const current = await db.project.findById(id);
	if (!current) throw new HTTPError({
		status: 404,
		message: "not_found"
	});
	if (body.enabled && !current.remoteUrl?.trim()) throw new HTTPError({
		status: 409,
		message: "repository_identity_unverified"
	});
	const project = await db.project.setEnabled(id, body.enabled, (/* @__PURE__ */ new Date()).toISOString());
	if (!project) throw new HTTPError({
		status: 409,
		message: "project_unavailable"
	});
	return project;
});
// src/server/routes/project.[id].session.put.ts
var project__id__session_put_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id", { decode: true });
	if (!id?.trim()) throw new HTTPError({
		status: 400,
		message: "project_id_required"
	});
	try {
		return { sessionId: await session.create("project", { projectId: id }) };
	} catch (error) {
		const message = error instanceof Error ? error.message : "session_open_failed";
		throw new HTTPError({
			status: message === "project_not_found" ? 404 : message === "session_binding_conflict" ? 409 : message === "runtime_stopping" ? 503 : 502,
			message
		});
	}
});
// src/server/routes/project.get.ts
var project_get_default = defineHandler(async () => {
	const projects = await project.list();
	return Promise.all(projects.map(async (item) => {
		const id = item.orchestratorSessionId ?? null;
		let status = "not_created";
		let sessionId = null;
		if (id) {
			const identity = await session.resolve(id);
			if (identity?.role === "project" && identity.projectId === item.id) {
				const activity = await session.activity(id);
				status = activity.running ? "running" : activity.background ? "background" : activity.queued ? "queued" : "idle";
				sessionId = id;
			}
		}
		return {
			...item,
			session: {
				sessionId,
				status
			}
		};
	}));
});
// src/server/routes/project.post.ts
var project_post_default = defineHandler(async () => project.sync());
// src/server/routes/project.repository.post.ts
var project_repository_post_default = defineHandler(async (event) => {
	const body = await readBody(event);
	if (!body || typeof body.remoteUrl !== "string" || body.name !== void 0 && typeof body.name !== "string") throw new HTTPError({
		status: 400,
		message: "invalid_repository_request"
	});
	try {
		return await project.addRepository(body.remoteUrl, body.name, event.req.signal);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "";
		const invalid = ["invalid_repository_remote", "invalid_workspace_name"].includes(reason);
		const conflict = ["repository_path_conflict", "repository_remote_mismatch"].includes(reason);
		const cancelled = reason === "repository_clone_cancelled";
		const message = invalid || conflict || cancelled || [
			"repository_clone_timeout",
			"repository_clone_failed",
			"repository_registration_failed"
		].includes(reason) ? reason : "repository_registration_failed";
		throw new HTTPError({
			status: invalid ? 400 : conflict ? 409 : cancelled ? 408 : message === "repository_clone_timeout" ? 504 : 502,
			message
		});
	}
});
// src/server/routes/scope.get.ts
var scope_get_default = defineHandler(async () => db.supervisorTicket.listAll());
// src/server/routes/session.[id].context.get.ts
var session__id__context_get_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id", { decode: true });
	if (!id?.trim()) throw new HTTPError({
		status: 400,
		message: "invalid_session"
	});
	const identity = await session.resolve(id);
	if (!identity) throw new HTTPError({
		status: 404,
		message: "unknown_session"
	});
	const context = await session.view(id, 0, 12e3);
	return {
		sessionId: id,
		role: identity.role,
		pendingCount: (await inbox.peek(id)).pendingCount,
		...context
	};
});
// src/server/routes/session.[id].mailbox.[messageId].patch.ts
var session__id__mailbox__messageId__patch_default = defineHandler(async (event) => {
	const body = await readBody(event);
	if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "status") || body.status !== "done") throw new HTTPError({
		status: 400,
		message: "invalid_mail_patch"
	});
	const id = getRouterParam(event, "id", { decode: true });
	const messageId = getRouterParam(event, "messageId", { decode: true });
	if (!id?.trim() || !messageId?.trim()) throw new HTTPError({
		status: 400,
		message: "invalid_parameters"
	});
	const mailbox = await inbox.peek(id);
	if (!mailbox) throw new HTTPError({
		status: 404,
		message: "unknown_session"
	});
	const message = mailbox.messages.find((message) => message.id === messageId);
	if (!message) throw new HTTPError({
		status: 403,
		message: "scope_denied"
	});
	if (message.kind === "ask" && !message.answer) throw new HTTPError({
		status: 409,
		message: "answer_required"
	});
	return { completed: await inbox.complete(id, [messageId]) };
});
// src/server/routes/session.[id].mailbox.get.ts
var session__id__mailbox_get_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id", { decode: true });
	if (!id?.trim()) throw new HTTPError({
		status: 400,
		message: "invalid_session"
	});
	return { mailbox: await inbox.peek(id) };
});
// src/server/routes/session.open.post.ts
var session_open_post_default = defineHandler(async () => {
	try {
		return { sessionId: await session.create("main", {}) };
	} catch (error) {
		const message = error instanceof Error ? error.message : "session_open_failed";
		throw new HTTPError({
			status: message === "ambiguous_main_session" ? 409 : message === "runtime_stopping" ? 503 : 502,
			message
		});
	}
});
// src/server/routes/session.role.get.ts
var session_role_get_default = defineHandler(async () => {
	const [mainSessionId, projects, supervisors, workers] = await Promise.all([
		storage.getItem("orchestrator.id"),
		db.project.listAll(),
		db.supervisor.listByStatus("active"),
		db.worker.listRecent()
	]);
	return { sessions: [
		...mainSessionId ? [{
			sessionId: mainSessionId,
			role: "main"
		}] : [],
		...projects.flatMap((project) => project.orchestratorSessionId ? [{
			sessionId: project.orchestratorSessionId,
			role: "project"
		}] : []),
		...supervisors.flatMap((supervisor) => supervisor.sessionId ? [{
			sessionId: supervisor.sessionId,
			role: "supervisor"
		}] : []),
		...workers.map((worker) => ({
			sessionId: worker.id,
			role: "worker"
		}))
	] };
});
// src/server/routes/setting.get.ts
var setting_get_default = defineHandler(async () => setting.load());
// src/server/routes/setting.patch.ts
var setting_patch_default = defineHandler(async (event) => {
	const body = await readBody(event);
	if (!body) throw new HTTPError({
		status: 400,
		message: "invalid_config"
	});
	try {
		return await setting.save(body);
	} catch (error) {
		if (error instanceof TypeError && error.message === "invalid_config") throw new HTTPError({
			status: 400,
			message: "invalid_config"
		});
		throw error;
	}
});
// src/server/routes/status.get.ts
var status_get_default = defineHandler(async () => {
	const [projects, runningWorkers, queuedWorkers, messages, mainSessionId] = await Promise.all([
		project.list(),
		db.worker.listRunning(),
		db.worker.listQueued(),
		db.inbox.listRecent(),
		session.findMain()
	]);
	const bindings = [...mainSessionId ? [{ sessionId: mainSessionId }] : [], ...projects.flatMap((item) => item.orchestratorSessionId ? [{ sessionId: item.orchestratorSessionId }] : [])];
	const activities = await Promise.all(bindings.map(async (binding) => await session.resolve(binding.sessionId) ? await session.activity(binding.sessionId) : {
		running: false,
		background: false,
		queued: false
	}));
	const failed = messages.find((message) => message.status === "stalled" || message.status === "pending" && message.deliveryError);
	const active = activities.some((activity) => activity.running || activity.background);
	const queued = queuedWorkers.length > 0 || activities.some((activity) => activity.queued);
	return {
		state: failed ? "delivery_failed" : runningWorkers.length || active ? "running" : queued ? "queued" : "idle",
		reason: failed?.deliveryError ?? null
	};
});
// src/server/routes/subscription.get.ts
var subscription_get_default = defineHandler(async () => db.ticketThread.listAll());
// src/server/routes/supervisor.get.ts
var supervisor_get_default = defineHandler(async () => db.supervisor.listActive());
// src/server/routes/thread.get.ts
var thread_get_default = defineHandler(async () => db.thread.listRecent(1e3));
// src/server/routes/ticket.[id].get.ts
var ticket__id__get_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id", { decode: true });
	if (!id?.trim()) throw new HTTPError({
		status: 400,
		message: "invalid_ticket"
	});
	const ticket = await db.ticket.findById(id);
	if (!ticket) throw new HTTPError({
		status: 404,
		message: "not_found"
	});
	const [project, executions, outgoing, incoming, subscriptions, inbox] = await Promise.all([
		db.project.findById(ticket.projectId),
		db.worker.listByTicket(id),
		db.ticketLink.listByTicket(id),
		db.ticketLink.listByRelated(id),
		db.ticketThread.listByTicket(id),
		db.inbox.listByTicket(id)
	]);
	const topics = (await Promise.all(subscriptions.map((link) => db.thread.findById(link.threadId)))).filter((topic) => topic !== void 0);
	const triggers = (await Promise.all(topics.map((topic) => db.trigger.listByThread(topic.id)))).flat();
	const dependencies = [...outgoing, ...incoming.filter((link) => !outgoing.some((other) => other.ticketId === link.ticketId && other.relatedId === link.relatedId && other.kind === link.kind))];
	return {
		ticket,
		project: project ?? null,
		executions,
		dependencies,
		subscriptions,
		topics,
		triggers,
		inbox
	};
});
// src/server/routes/ticket.[id].patch.ts
var ticket__id__patch_default = defineHandler(async (event) => {
	const id = getRouterParam(event, "id", { decode: true });
	const body = await readBody(event);
	const allowed = [
		"reason",
		"paused",
		"status"
	];
	const validShape = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => allowed.includes(key)) && (body.paused === void 0 || typeof body.paused === "boolean") && (body.status === void 0 || body.status === "cancelled") && (body.reason === void 0 || typeof body.reason === "string" && body.reason.trim().length > 0) && (body.paused !== void 0 || body.status !== void 0);
	if (!id?.trim() || !validShape) throw new HTTPError({
		status: 400,
		message: "invalid_ticket_patch"
	});
	const ticket = await db.ticket.findById(id);
	if (!ticket) throw new HTTPError({
		status: 404,
		message: "not_found"
	});
	if ([
		"done",
		"completed",
		"cancelled"
	].includes(ticket.status)) throw new HTTPError({
		status: 409,
		message: "ticket_closed"
	});
	const now = (/* @__PURE__ */ new Date()).toISOString();
	if (body.status === "cancelled") {
		await worker.cancel(id);
		await db.ticket.finish(id, "cancelled", now, now);
		await worker.archiveSessions(id);
		return await db.ticket.findById(id);
	}
	const updated = await db.ticket.setPausedIfOpen(id, body.paused, now);
	if (!updated) throw new HTTPError({
		status: 409,
		message: "ticket_closed"
	});
	return updated;
});
// src/server/routes/ticket.count.get.ts
/** 任务卡片的统计：全量计数，不受分页与列表取数上限影响。 */
var ticket_count_get_default = defineHandler(async () => {
	const rows = await db.ticket.listAll();
	const since = Date.now() - 864e5;
	let added = 0;
	let inProgress = 0;
	let completed = 0;
	let blocked = 0;
	for (const ticket of rows) {
		if (Date.parse(ticket.createdAt) >= since) added++;
		const closed = [
			"done",
			"completed",
			"cancelled"
		].includes(ticket.status);
		if (ticket.status === "done" || ticket.status === "completed") completed++;
		else if (!closed && (ticket.paused || ticket.prepareError)) blocked++;
		else if (!closed && !ticket.paused && !ticket.prepareError && [
			"running",
			"queued",
			"review"
		].includes(ticket.status)) inProgress++;
	}
	return {
		all: rows.length,
		added,
		inProgress,
		completed,
		blocked
	};
});
// src/server/routes/ticket.current.get.ts
var ticket_current_get_default = defineHandler(async () => {
	const [runningWorkers, queuedWorkers, openTickets] = await Promise.all([
		db.worker.listRunning(),
		db.worker.listQueued(),
		db.ticket.listOpen()
	]);
	const runningTicketIds = new Set(runningWorkers.map((worker) => worker.ticketId));
	const activeWorkers = [...new Map([...queuedWorkers, ...runningWorkers].map((worker) => [worker.id, worker])).values()];
	const ticketMap = new Map(openTickets.map((ticket) => [ticket.id, ticket]));
	for (const ticket of await Promise.all([...new Set(activeWorkers.map((worker) => worker.ticketId))].filter((id) => !ticketMap.has(id)).map((id) => db.ticket.findById(id)))) if (ticket) ticketMap.set(ticket.id, ticket);
	return [...ticketMap.values()].filter((ticket) => ![
		"closed",
		"done",
		"completed",
		"cancelled"
	].includes(ticket.status) || runningTicketIds.has(ticket.id));
});
// src/server/routes/ticket.get.ts
var ticket_get_default = defineHandler(async (event) => {
	const query = getQuery(event);
	const page = Math.max(1, Number(query.page) || 1);
	const pageSize = Math.max(1, Math.min(100, Number(query.pageSize) || 8));
	return {
		...await db.ticket.findManyPage(page, pageSize),
		page,
		pageSize
	};
});
// src/service/topic.ts
/** 一条触发按投递事实推出的状态：有受阻就是受阻，有排队就是排队。 */
function eventStatus(event) {
	if (event.deliveries.some((item) => item.status === "stalled")) return "stalled";
	if (event.deliveries.some((item) => item.status === "pending")) return "pending";
	return event.deliveries.length ? "done" : "not-delivered";
}
function matchEvent(event, filters, thread, projectName) {
	const query = (filters.query ?? "").trim().toLocaleLowerCase();
	if (filters.channel && filters.channel !== "all" && event.channel !== filters.channel) return false;
	if (filters.kind && filters.kind !== "all" && event.kind !== filters.kind) return false;
	if (filters.mentionedOnly && !event.mentioned) return false;
	if (filters.status && filters.status !== "all") {
		if (eventStatus(event) !== filters.status) return false;
	}
	if (query) {
		if (![
			event.id,
			event.actor,
			event.channel,
			thread.refId,
			projectName,
			event.ref,
			thread.title,
			event.text,
			...event.tickets
		].filter(Boolean).join(" ").toLocaleLowerCase().includes(query)) return false;
	}
	return true;
}
const topic = defineService({
	async page(filters, page = 1, pageSize = 5) {
		const size = Math.max(1, Math.min(100, pageSize));
		const rows = await collect(filters);
		const offset = (Math.max(1, page) - 1) * size;
		return {
			data: rows.slice(offset, offset + size),
			total: rows.length,
			page: Math.max(1, page),
			pageSize: size
		};
	},
	/** 统计卡片用：按话题去重的全量计数，与分页和当前页数据无关。 */
	async count(filters) {
		const rows = await collect({
			...filters,
			status: void 0
		});
		const counts = {
			all: rows.length,
			pending: 0,
			done: 0,
			stalled: 0
		};
		for (const row of rows) {
			const status = eventStatus(row.latest);
			if (status === "pending") counts.pending++;
			else if (status === "done") counts.done++;
			else if (status === "stalled") counts.stalled++;
		}
		return counts;
	}
});
/** 按筛选条件装配全量话题行（未分页），page 与 count 共用。 */
async function collect(filters) {
	const [triggers, threads, projects, subscriptions, deliveries] = await Promise.all([
		db.trigger.listRecent(1e3),
		db.thread.listRecent(1e3),
		db.project.listAll(),
		db.ticketThread.listAll(),
		db.inbox.listRecent()
	]);
	const threadById = new Map(threads.map((item) => [item.id, item]));
	const projectById = new Map(projects.map((item) => [item.id, item]));
	const grouped = /* @__PURE__ */ new Map();
	for (const item of triggers) {
		const thread = threadById.get(item.threadId);
		if (!thread) continue;
		const event = {
			id: item.id,
			channel: item.channelId,
			kind: item.kind,
			actor: item.actorName ?? "",
			human: Boolean(item.human),
			mentioned: Boolean(item.mentioned),
			text: item.text,
			at: item.at,
			ref: item.ref ?? void 0,
			url: item.url ?? void 0,
			thread: {
				id: thread.id,
				kind: thread.kind,
				ref: thread.refId,
				title: thread.title,
				triage: thread.triage,
				project: thread.projectId ? projectById.get(thread.projectId)?.name : void 0,
				url: thread.url ?? void 0
			},
			tickets: subscriptions.filter((link) => link.threadId === thread.id).map((link) => link.ticketId),
			deliveries: deliveries.filter((message) => message.triggerId === item.id).map((message) => ({
				target: message.type,
				project: message.projectId ? projectById.get(message.projectId)?.name : void 0,
				status: message.status,
				read: Boolean(message.readAt),
				attempts: message.deliveryAttempts,
				error: message.deliveryError ?? void 0
			}))
		};
		if (!matchEvent(event, filters, thread, projectById.get(thread.projectId ?? "")?.name)) continue;
		const events = grouped.get(thread.id) ?? [];
		events.push(event);
		grouped.set(thread.id, events);
	}
	const rows = [...grouped.values()].map((events) => {
		events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
		return {
			latest: events[0],
			events
		};
	});
	rows.sort((a, b) => Date.parse(b.latest.at) - Date.parse(a.latest.at) || b.latest.id.localeCompare(a.latest.id));
	return rows;
}
// src/server/routes/topic.count.get.ts
var topic_count_get_default = defineHandler(async (event) => {
	const query = getQuery(event);
	return topic.count({
		query: query.query || void 0,
		channel: query.channel || void 0,
		kind: query.kind,
		mentionedOnly: query.mentionedOnly === "true"
	});
});
// src/server/routes/topic.get.ts
var topic_get_default = defineHandler(async (event) => {
	const query = getQuery(event);
	const page = Math.max(1, Number(query.page) || 1);
	const pageSize = Math.max(1, Math.min(100, Number(query.pageSize) || 5));
	return topic.page({
		query: query.query,
		channel: query.channel,
		status: query.status,
		kind: query.kind,
		mentionedOnly: query.mentionedOnly === "true"
	}, page, pageSize);
});
// src/server/routes/trigger.get.ts
var trigger_get_default = defineHandler(async () => db.trigger.listRecent());
// src/server/routes/worker.get.ts
var worker_get_default = defineHandler(async () => {
	const [running, queued] = await Promise.all([db.worker.listRunning(), db.worker.listQueued()]);
	return [...new Map([...queued, ...running].map((worker) => [worker.id, worker])).values()];
});
// src/server/index.ts
const authorize = defineHandler(async (event) => {
	const options = getServerOptions(event);
	event.res.headers.set("cache-control", "no-store");
	const origin = event.req.headers.get("origin");
	const host = event.req.headers.get("host");
	if (origin && origin !== options.origin || host && host !== new URL(options.origin).host) throw new HTTPError({
		status: 403,
		message: "origin_denied"
	});
	if (!options.owner || !await options.owner(event)) throw new HTTPError({
		status: 401,
		message: "owner_required"
	});
});
const server = defineWebServer((app) => {
	app.use(authorize);
	app.get("/api/supermesh/project", project_get_default);
	app.post("/api/supermesh/project", project_post_default);
	app.patch("/api/supermesh/project/:id", project__id__patch_default);
	app.put("/api/supermesh/project/:id/session", project__id__session_put_default);
	app.post("/api/supermesh/project/:id/opening", project__id__opening_post_default);
	app.post("/api/supermesh/repository", project_repository_post_default);
	app.get("/api/supermesh/ticket", ticket_get_default);
	app.get("/api/supermesh/ticket/count", ticket_count_get_default);
	app.get("/api/supermesh/ticket/current", ticket_current_get_default);
	app.get("/api/supermesh/ticket/:id", ticket__id__get_default);
	app.patch("/api/supermesh/ticket/:id", ticket__id__patch_default);
	app.post("/api/supermesh/ask/:id/answer", ask__id__answer_post_default);
	app.get("/api/supermesh/worker", worker_get_default);
	app.get("/api/supermesh/supervisor", supervisor_get_default);
	app.get("/api/supermesh/scope", scope_get_default);
	app.get("/api/supermesh/node", node_get_default);
	app.get("/api/supermesh/edge", edge_get_default);
	app.get("/api/supermesh/group", group_get_default);
	app.get("/api/supermesh/status", status_get_default);
	app.get("/api/supermesh/message", message_get_default);
	app.get("/api/supermesh/pending", pending_get_default);
	app.get("/api/supermesh/delivery", delivery_get_default);
	app.get("/api/supermesh/thread", thread_get_default);
	app.get("/api/supermesh/trigger", trigger_get_default);
	app.get("/api/supermesh/topic", topic_get_default);
	app.get("/api/supermesh/topic/count", topic_count_get_default);
	app.get("/api/supermesh/subscription", subscription_get_default);
	app.get("/api/supermesh/channel", channel_get_default);
	app.put("/api/supermesh/channel/:id/configuration", channel__id__configuration_put_default);
	app.delete("/api/supermesh/channel/:id/credential", channel__id__credential_delete_default);
	app.post("/api/supermesh/channel/:id/authentication", channel__id__authentication_post_default);
	app.get("/api/supermesh/channel/:id/authentication/:authenticationId", channel__id__authentication__authenticationId__get_default);
	app.get("/api/supermesh/setting", setting_get_default);
	app.patch("/api/supermesh/setting", setting_patch_default);
	app.get("/api/supermesh/agent/model", agent_model_get_default);
	app.patch("/api/supermesh/agent/model", agent_model_patch_default);
	app.get("/api/supermesh/agent/model/catalog", agent_model_catalog_get_default);
	app.put("/api/supermesh/session/main", session_open_post_default);
	app.get("/api/supermesh/session/role", session_role_get_default);
	app.get("/api/supermesh/session/:id/context", session__id__context_get_default);
	app.get("/api/supermesh/session/:id/mailbox", session__id__mailbox_get_default);
	app.patch("/api/supermesh/session/:id/mailbox/:messageId", session__id__mailbox__messageId__patch_default);
});
// src/service/archive.ts
const archive = defineService({ async session(id) {
	if (!(await setting.load()).autoArchiveWorkers) return false;
	const ctx = getServerContext(server);
	if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) return false;
	await session.stop(id).catch(() => void 0);
	for (let attempt = 0; attempt < 3; attempt++) try {
		await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true });
		return true;
	} catch (error) {
		if (attempt === 2) {
			ctx.logger.warn("supermesh: archiving session %s failed: %s", id, error instanceof Error ? error.message : String(error));
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
} });
// src/utils/branch.ts
/**
* 分支名固定为 `dsh/<任务名称>`，只用 ASCII 字母数字：标题里的字母数字压成一段，
* 标题本身没有可用的 ASCII 时用任务号的短摘要兜底。
* PR 归哪张票只看会话证据，分支名不参与匹配。
*/
function worktreeBranch(title, ticketId) {
	const slug = title.normalize("NFKD").replace(/[\u0300-\u036F]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
	if (slug.length >= 3) return `dsh/${slug}`;
	const digest = createHash("sha256").update(ticketId).digest("hex").slice(0, 6);
	return `dsh/${slug ? `${slug}-${digest}` : `task-${digest}`}`;
}
// src/service/worker.ts
const eventQueues = /* @__PURE__ */ new Map();
let stopped = false;
let observing = false;
/** 终态：不再派工、不再投递、授权已收回。 */
const closed = (ticket) => ticket.status === "done" || ticket.status === "completed" || ticket.status === "cancelled";
/** 票进终态后归档它名下所有已结束的 Worker 会话：已归档跳过，单个失败只告警，不阻断结单。 */
const archiveEndedWorkers = singlet((ticketId) => `worker:archive:${ticketId}`, async (ticketId) => {
	for (const current of await db.worker.listByTicket(ticketId)) {
		if (current.status !== "ended" || !current.startedAt) continue;
		await archive.session(current.id).catch((error) => {
			getServerContext(server).logger.warn("supermesh: archiving worker %s failed: %s", current.id, error instanceof Error ? error.message : String(error));
		});
	}
});
const finish = singlet((current) => `worker:finish:${current.id}`, async (current, reason) => {
	const worker = await db.worker.findById(current.id);
	if (!worker || worker.status === "ended") return;
	const asks = (await db.inbox.listByTicket(worker.ticketId)).filter((message) => message.kind === "ask" && message.workerId === worker.id);
	if (!reason) {
		if (asks.some((message) => message.status === "pending")) {
			await deferWhileWaiting(worker);
			return;
		}
		const answered = asks.filter((message) => message.answer);
		if (answered.length) {
			const receipts = await session.receipts(worker.id);
			if (answered.some((message) => !receipts.some((receipt) => receipt.requestId === `supermesh:answer:${message.id}`))) {
				await deferWhileWaiting(worker);
				return;
			}
		}
	}
	if (stopped) return;
	const now = (/* @__PURE__ */ new Date()).toISOString();
	await db.worker.setBackgroundUntil(worker.id, null);
	await db.worker.end(worker.id, reason ?? (worker.reportState === "failed" ? "failed" : "completed"), now);
	const ticket = await db.ticket.findById(worker.ticketId);
	if (ticket && !closed(ticket)) {
		if (ticket.prState === "merged" || ticket.prState === "closed") await finishTicket(ticket.id, "done", now, now);
		else if (!reason && worker.reportState === "dropped") await finishTicket(ticket.id, "completed", now, now);
		else if (!reason && worker.reportState === "ready") await settleReady(ticket, now);
		else await db.ticket.setOpenStatus(ticket.id, "idle", now);
	}
	const ended = await db.ticket.findById(worker.ticketId);
	if (ended && closed(ended)) await archiveEndedWorkers(ended.id);
	await notifyRouter(worker, reason);
});
const worker = defineService({
	start() {
		if (singlet.busy("worker:slots") || eventQueues.size) throw new Error("worker_busy");
		stopped = false;
		observing = true;
		return async () => {
			stopped = true;
			observing = false;
			while (singlet.keys().some((key) => key.startsWith("worker:")) || eventQueues.size) await Promise.allSettled([singlet.drain(), ...[...eventQueues.values()]]);
		};
	},
	reconcile: singlet("worker:slots", async () => {
		const settings = await setting.load();
		for (const worker of await db.worker.listRunning()) {
			if (stopped) break;
			const ticket = await db.ticket.findById(worker.ticketId);
			if (!ticket) {
				await db.worker.end(worker.id, "stopped", (/* @__PURE__ */ new Date()).toISOString());
				continue;
			}
			if (closed(ticket)) {
				if (await session.lookup(worker.id)) await session.send(worker.id, `票 ${ticket.id} 已${ticket.status === "cancelled" ? "取消" : "完成"}，本次授权已收回：立即停手，不要再提交、推送或开 PR。`, "interrupt").catch(() => void 0);
				await db.worker.end(worker.id, "stopped", (/* @__PURE__ */ new Date()).toISOString());
				await archiveEndedWorkers(ticket.id);
				continue;
			}
			if (ticket.prState === "merged" || ticket.prState === "closed") {
				const now = (/* @__PURE__ */ new Date()).toISOString();
				await db.worker.end(worker.id, "stopped", now);
				await finishTicket(ticket.id, "done", now, now);
				continue;
			}
			const activity = await session.activity(worker.id).catch(() => null);
			if (activity && (activity.running || activity.background || activity.queued)) continue;
			const started = worker.startedAt ? Date.parse(worker.startedAt) : NaN;
			if (Number.isFinite(started) && Date.now() - started < 12e4) continue;
			const last = await session.lastActivity(worker.id);
			if (last && Date.now() - last < 12e4) continue;
			const now = (/* @__PURE__ */ new Date()).toISOString();
			await db.worker.end(worker.id, worker.reportState === "ready" ? "completed" : "stopped", now);
			if (worker.reportState === "ready") await settleReady(ticket, now);
			else await db.ticket.setOpenStatus(ticket.id, "idle", now);
		}
		for (const queued of await db.ticket.listFiltered({ status: "queued" })) {
			if (stopped) break;
			await notifyDispatchable(queued);
		}
		let running = (await db.worker.listRunning()).length;
		const queueable = /* @__PURE__ */ new Map();
		for (const worker of await db.worker.listQueued()) queueable.set(worker.id, worker);
		for (const worker of queueable.values()) {
			if (stopped || running >= settings.maxWorkers) break;
			const current = await db.worker.findById(worker.id);
			if (!current || current.status !== "queued") continue;
			const ticket = await db.ticket.findById(worker.ticketId);
			if (!ticket || closed(ticket)) {
				await db.worker.end(worker.id, "stopped", (/* @__PURE__ */ new Date()).toISOString());
				continue;
			}
			if (ticket.prState === "merged" || ticket.prState === "closed") {
				const now = (/* @__PURE__ */ new Date()).toISOString();
				await db.worker.end(worker.id, "stopped", now);
				await finishTicket(ticket.id, "done", now, now);
				continue;
			}
			if (ticket.paused) continue;
			if (await blockedByDependency(ticket.id)) continue;
			if ((await db.inbox.listByTicket(ticket.id)).some((message) => message.kind === "ask" && message.status === "pending" && message.workerId === worker.id)) continue;
			const project = await db.project.findById(ticket.projectId);
			if (!project) {
				await db.ticket.setPrepareError(ticket.id, "project_not_found", (/* @__PURE__ */ new Date()).toISOString());
				continue;
			}
			if (!project.enabled) continue;
			let started = false;
			try {
				let directory = worker.worktree && worker.branch ? worker.worktree : null;
				if (directory && worker.branch) await worktree.verify(project.directory, directory, worker.branch).catch(() => {
					directory = null;
				});
				if (!await session.resolve(worker.id).then(Boolean).catch(() => false)) {
					await session.create("worker", {
						sessionId: worker.id,
						ticketId: ticket.id,
						projectId: project.id,
						directory: directory ?? project.directory
					});
					if (stopped) throw new Error("worker_stopped");
				}
				const agent = await session.activate(worker.id);
				if (!directory) {
					const created = await worktree.create(agent, worker.branch ?? worktreeBranch(ticket.title, ticket.id));
					directory = created.worktree;
					await db.worker.update(worker.id, {
						branch: created.branch,
						worktree: directory
					});
				}
				if (stopped) throw new Error("worker_stopped");
				const threads = await db.ticketThread.listByTicket(ticket.id);
				const sources = await Promise.all(threads.map(async (thread) => {
					const latest = await db.trigger.findLatestByThread(thread.threadId);
					return latest ? `${thread.threadId}（trigger ${latest.id}）` : thread.threadId;
				}));
				const prompt = [
					`${ticket.id}: ${ticket.title}`,
					ticket.description ?? "",
					`执行配置：${JSON.stringify({
						autoMerge: settings.autoMerge,
						autoMergeMaxLines: settings.autoMergeMaxLines
					})}`,
					"来源话题：",
					...sources,
					worker.recoveryNote ?? "",
					"你的最后一条消息会原样转给项目编排。"
				].filter(Boolean).join(String.fromCharCode(10));
				const now = (/* @__PURE__ */ new Date()).toISOString();
				await db.worker.start(worker.id, now);
				await db.ticket.start(ticket.id, now, now);
				running++;
				started = true;
				await session.send(worker.id, prompt, "queue", `supermesh:worker:${worker.id}:${randomUUID()}`);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const now = (/* @__PURE__ */ new Date()).toISOString();
				if (reason === "unknown_session" || reason === "session_identity_conflict") {
					await db.worker.end(worker.id, "stopped", now);
					await db.worker.queue(ticket.id, ticket.projectId, worker.branch ?? void 0, true).catch(() => void 0);
					if (stopped) break;
					continue;
				}
				if (started) {
					await session.stop(worker.id);
					running--;
				}
				await db.worker.end(worker.id, "failed", now);
				await db.ticket.setPrepareError(ticket.id, reason, now);
				const latest = await db.ticket.findById(ticket.id);
				if (latest && latest.prState === "merged" && !closed(latest)) await finishTicket(latest.id, "done", now, now);
				else await db.ticket.setOpenStatus(ticket.id, "queued", now);
				await notifyDispatchFailure(ticket.id, reason, now);
				if (stopped) break;
			}
		}
	}),
	reconcileBackground: singlet("worker:background", async () => {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		for (const worker of await db.worker.listRunning()) {
			if (stopped) break;
			if (!worker.backgroundUntil) continue;
			const activity = await session.activity(worker.id);
			const expired = worker.backgroundUntil <= now;
			if (!expired && (activity.running || activity.background || activity.queued)) continue;
			if (expired) await session.stop(worker.id);
			await finish(worker, expired ? "stopped" : void 0);
		}
	}),
	archiveSessions: archiveEndedWorkers,
	cancel: singlet((ticketId) => `worker:cancel:${ticketId}`, async (ticketId) => {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		for (const current of await db.worker.listByTicket(ticketId)) {
			if (current.status === "ended") continue;
			await session.stop(current.id).catch(() => void 0);
			await db.worker.end(current.id, "stopped", now);
		}
	}),
	/** 事实结单的兜底：改动请求已经合并 / 关闭的票不再需要 Worker，直接收掉。 */
	rescue: singlet("worker:rescue", async () => {
		for (const ticket of await db.ticket.listOpen()) {
			if (stopped) break;
			if (ticket.status !== "idle" || ticket.prState !== "merged" && ticket.prState !== "closed") continue;
			const now = (/* @__PURE__ */ new Date()).toISOString();
			await finishTicket(ticket.id, "done", now, now);
		}
	}),
	recover: singlet("worker:recovery", async () => {
		for (const worker of await db.worker.listRunning()) {
			if (stopped) break;
			const ticket = await db.ticket.findById(worker.ticketId);
			if (!ticket) continue;
			if (closed(ticket)) {
				if (await session.lookup(worker.id)) await session.stop(worker.id);
				await db.worker.end(worker.id, "stopped", (/* @__PURE__ */ new Date()).toISOString());
				continue;
			}
			if (ticket.paused) continue;
			try {
				const project = await db.project.findById(ticket.projectId);
				if (project && !project.enabled) continue;
				if (ticket.prState === "merged") {
					await db.worker.end(worker.id, "stopped", (/* @__PURE__ */ new Date()).toISOString());
					await finishTicket(ticket.id, "done", (/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString());
					continue;
				}
				if (!project) {
					await db.worker.requeue(worker.id);
					continue;
				}
				if (worker.worktree && worker.branch) await worktree.verify(project.directory, worker.worktree, worker.branch);
				if (!await session.resolve(worker.id)) {
					await db.worker.requeue(worker.id);
					continue;
				}
				const activity = await session.activity(worker.id);
				if (activity.background && !worker.backgroundUntil) {
					const settings = await setting.load();
					await db.worker.setBackgroundUntil(worker.id, new Date(Date.now() + Math.min(30, settings.backgroundLimitMinutes) * 6e4).toISOString());
				}
				if (activity.running || activity.background || activity.queued) continue;
				const note = "运行已恢复。先检查目录、git 历史与渠道的当前事实，再决定是否重做外部动作；不要重复开 PR 或发布评论。";
				await db.worker.setRecoveryNote(worker.id, note);
				if (!(await db.inbox.listByTicket(ticket.id)).some((message) => message.kind === "ask" && message.status === "pending" && message.workerId === worker.id)) await session.send(worker.id, note, "queue", `supermesh:recovery:${randomUUID()}`);
			} catch (error) {
				if (stopped) break;
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const latest = await db.ticket.findById(ticket.id);
				if (latest && (closed(latest) || latest.prState === "merged")) {
					if (latest.prState === "merged" && !closed(latest)) await finishTicket(latest.id, "done", now, now);
					await db.worker.end(worker.id, "stopped", now);
					continue;
				}
				await db.ticket.setPrepareError(ticket.id, error instanceof Error ? error.message : String(error), now);
				await db.ticket.setOpenStatus(ticket.id, "idle", now);
				await db.worker.end(worker.id, "failed", now);
			}
		}
	}),
	observe: singlet((source) => `worker:event:${source.id}`, async (source, event) => {
		if (!observing || stopped || event.type !== "turn/end") return;
		const previous = eventQueues.get(source.id) ?? Promise.resolve();
		const action = () => stopped ? Promise.resolve() : (async () => {
			if (event.data.reason.kind === "aborted" && event.data.reason.reason.kind === "hook" && event.data.reason.reason.reason === "supermesh_cancel") return;
			const identity = await session.resolve(source.id);
			if (!identity || identity.role !== "worker" || !identity.workerId) return;
			const current = await db.worker.findById(identity.workerId);
			if (!current || current.status !== "running") return;
			const activity = await session.activity(current.id);
			if (activity.background) {
				const settings = await setting.load();
				if (!current.backgroundUntil) await db.worker.setBackgroundUntil(current.id, new Date(Date.now() + Math.min(30, settings.backgroundLimitMinutes) * 6e4).toISOString());
				return;
			}
			if (activity.queued) return;
			await finish(current, event.data.reason.kind === "error" ? "failed" : event.data.reason.kind === "aborted" ? "stopped" : void 0);
		})();
		const current = previous.then(action, action).finally(() => {
			if (eventQueues.get(source.id) === current) eventQueues.delete(source.id);
		});
		eventQueues.set(source.id, current);
		return current;
	})
});
/**
* 报 ready 的落点：票归属某个变更请求就等人审，没有就是正常完成。
* 没有 PR 可审的票不该停在 review，也不该退回 idle 等一个永远不会来的触发。
*/
async function settleReady(ticket, now) {
	if (await db.ticket.hasPullRequest(ticket.id)) await db.ticket.setOpenStatus(ticket.id, "review", now);
	else await finishTicket(ticket.id, "completed", now, now);
}
async function blockedByDependency(ticketId) {
	const links = await db.ticketLink.listDependsOn(ticketId);
	if (!links.length) return false;
	for (const link of links) {
		const related = await db.ticket.findById(link.relatedId);
		if (!related || closed(related)) continue;
		return true;
	}
	return false;
}
/**
* 票进终态时通知它所属的 supervisor。
* 不要求两票之间有 depends —— 跨项目协调里 supervisor 往往靠「这张做完了」才能派下一张，
* 漏掉这条通知，整条链路就停在原地，票却不报错。
*/
/** 结单并通知相关方：所有终态路径都必须经过这里，否则 supervisor 收不到「这张做完了」。 */
async function finishTicket(id, status, endedAt, updatedAt) {
	await db.ticket.finish(id, status, endedAt, updatedAt);
	await archiveEndedWorkers(id);
	await notifySupervisor(id);
}
async function notifySupervisor(ticketId) {
	const ticket = await db.ticket.findById(ticketId);
	if (!ticket || !closed(ticket)) return;
	for (const link of await db.supervisorTicket.listByTicket(ticketId)) {
		const supervisor = await db.supervisor.findById(link.supervisorId);
		if (!supervisor || supervisor.status !== "active") continue;
		await db.inbox.enqueue({
			id: `supervisor:${link.supervisorId}:ticket:${ticketId}:${ticket.status}`,
			type: "supervisor",
			origin: "system",
			kind: "notice",
			supervisorId: link.supervisorId,
			message: `${ticketId} ${ticket.status === "cancelled" ? "已取消" : "已完成"}：${ticket.title}`,
			title: ticket.title
		}).catch(() => void 0);
	}
}
/**
* 票可以派工时通知项目编排一次。派工不由内部调度发起：分支和工作树由编排的 create_worker 决定，
* 插件只负责告诉它「这张票现在能开工了」。通知 id 固定，重复扫描不会重复投递；
* 被依赖卡住的票不发，依赖满足的那一刻才发。
*/
async function notifyDispatchable(ticket) {
	if (ticket.paused || ticket.prepareError) return;
	if (ticket.prState === "merged" || ticket.prState === "closed") return;
	if (await db.inbox.findById(`supermesh:dispatch:${ticket.id}`)) return;
	if (await blockedByDependency(ticket.id)) return;
	if ((await db.worker.listByTicket(ticket.id)).length) return;
	const project = await db.project.findById(ticket.projectId);
	if (!project?.enabled) return;
	await db.inbox.enqueue({
		id: `supermesh:dispatch:${ticket.id}`,
		type: "project",
		projectId: project.id,
		origin: "system",
		kind: "ticket",
		ticketId: ticket.id,
		title: ticket.title,
		message: `${ticket.id} 可以派工：没有未完成的前置依赖。用 create_worker 指定分支后开工。`
	}).catch(() => void 0);
}
/** 派工失败必须让编排看见原因：票退回 queued 后不会自动重试，只能由它显式重派。 */
async function notifyDispatchFailure(ticketId, reason, at) {
	const ticket = await db.ticket.findById(ticketId);
	if (!ticket || closed(ticket)) return;
	await db.inbox.enqueue({
		id: `supermesh:dispatch-failed:${ticket.id}:${at}`,
		type: "project",
		projectId: ticket.projectId,
		origin: "system",
		kind: "notice",
		ticketId: ticket.id,
		title: ticket.title,
		message: `${ticket.id} 派工失败：${reason}。票已退回 queued，没有工作树就不会开工；用 create_worker 重新派工。`
	}).catch(() => void 0);
}
async function deferWhileWaiting(current) {
	const ticket = await db.ticket.findById(current.ticketId);
	if (!ticket || closed(ticket)) return;
	const now = (/* @__PURE__ */ new Date()).toISOString();
	await db.worker.end(current.id, "completed", now);
	if (ticket.prState === "merged") await finishTicket(ticket.id, "done", now, now);
	else await db.ticket.setOpenStatus(ticket.id, "idle", now);
	await notifyRouter(current);
}
function settlementSummary(name, stopReason) {
	const subject = `Worker ${name}`;
	if (stopReason === "completed") return `${subject} finished. It cannot receive follow-up messages.`;
	if (stopReason === "aborted") return `${subject} was stopped before it finished.`;
	return `${subject} failed before it finished.`;
}
/** 官方结算只带子级最后一条非空 assistant 消息；没有正文时用流式拼接兜底。 */
async function closingText(id) {
	const { events } = await session.history(id);
	let message = [];
	let streamed = "";
	for (const event of events) if (event.type === "assistant/message") {
		const content = event.data.message.content;
		if (content.length > 0) message = content.flatMap((part) => part.type === "text" && part.text.length > 0 ? [part.text] : []);
		streamed += joinAssistantStreamText(event.data.stream);
	} else if (event.type === "assistant/attempt") streamed += joinAssistantStreamText(event.data.stream);
	return message.length ? message : streamed ? [streamed] : [];
}
/**
* Worker 是独立根会话，不在官方 subagent 树里，拿不到官方的结算通知。
* 结算落成项目编排的一条邮件：会话里只留紧凑通知，收尾文本由 read_mailbox 取。
*/
async function notifyRouter(current, reason) {
	try {
		const ticket = await db.ticket.findById(current.ticketId);
		if (!ticket) return;
		const project = await db.project.findById(ticket.projectId);
		if (!project?.enabled) return;
		const stopReason = reason === "failed" ? "error" : reason === "stopped" ? "aborted" : "completed";
		const summary = settlementSummary(ticket.id, stopReason);
		const closing = await closingText(current.id);
		const settledAt = (await db.worker.findById(current.id))?.endedAt ?? (/* @__PURE__ */ new Date()).toISOString();
		await db.inbox.enqueue({
			id: `supermesh:settlement:${current.id}:${settledAt}`,
			type: "project",
			projectId: project.id,
			origin: "worker",
			kind: "notice",
			ticketId: ticket.id,
			workerId: current.id,
			title: summary,
			message: [summary, ...closing.length === 0 ? ["It left no closing message."] : ["Its closing message:", ...closing]].join(String.fromCharCode(10))
		});
		const existing = project.orchestratorSessionId;
		const id = existing && await session.resolve(existing).then(Boolean, () => false) ? existing : await session.create("project", { projectId: project.id });
		await inbox.notify(await session.activate(id));
	} catch (error) {
		getServerContext(server).logger.warn("supermesh: worker %s settlement notice failed: %s", current.id, error instanceof Error ? error.message : String(error));
	}
}
export { channelTriggerRejection as _, worktree as a, db as b, channel as c, session as d, latestTriggerStrength as f, addressedToBot as g, singlet as h, project as i, channelProxyEnvironment as l, defineService as m, archive as n, devops as o, setting as p, server as r, shell as s, worker as t, inbox as u, channelTriggerStrength as v, DSH_PLUGIN_HOME as x, ticketAllowed as y };
