import { _ as channelTriggerRejection, a as worktree, b as db, c as channel, d as session, f as latestTriggerStrength, g as addressedToBot, h as singlet, i as project, l as channelProxyEnvironment, m as defineService, n as archive, o as devops, p as setting, r as server, s as shell, t as worker$1, u as inbox, v as channelTriggerStrength, x as DSH_PLUGIN_HOME, y as ticketAllowed } from "./worker-Boli6UWL.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomUUID } from "node:crypto";
import { getServerContext } from "dsh-h3/utils";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRouteDispatcher } from "@deepseek-ai/dsh-http-proxy";
import { fetch } from "undici";
import { Cron } from "croner";
// src/ai/_shared/prompt-file.ts
let cached;
/**
* 从当前模块往上找 `package.json` 得到包根目录。
* 不能写死 `../..`：源码在 `src/ai/_shared/`、打包后在 `dist/`，层级不同。
* 与官方 `infra/paths.ts` 的 `packageRoot` 同一策略。
*/
function packageRoot() {
	if (cached) return cached;
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 6; depth++) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) try {
			if (JSON.parse(readFileSync(manifest, "utf8")).name === "dsh-supermesh") return cached = directory;
		} catch {}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("dsh-supermesh package root not found");
}
function packaged(name) {
	const path = join(packageRoot(), "assets", "prompts", `${name}.md`);
	let text;
	try {
		text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
	} catch (error) {
		throw error.code === "ENOENT" ? new Error(`Missing packaged prompt: ${path}`, { cause: error }) : error;
	}
	if (!text.trim()) throw new Error(`Empty packaged prompt: ${path}`);
	return text;
}
const cache = /* @__PURE__ */ new Map();
/**
* 读 `assets/prompts/<name>.md`，段内换行合并为空格、段间只留单换行。
* 与官方 `skill-files.ts` 的 `promptFile` 一致：让模型按段落读，不被手写换行干扰。
*/
function promptFile(name) {
	const hit = cache.get(name);
	if (hit !== void 0) return hit;
	const text = packaged(name).trim().split(/\n(?:[ \t]*\n)+/).map((paragraph) => paragraph.split("\n").map((line) => line.trim()).join(" ")).join("\n");
	cache.set(name, text);
	return text;
}
// src/ai/_shared/compose-prompt.ts
/** 所有角色都读：职责划分 + 话题订阅 + 回复规则。 */
function common() {
	return [
		promptFile("shared"),
		promptFile("subscriptions"),
		promptFile("replies")
	];
}
/** 团队可改的三个段落：沟通、任务范围、交付要求（含合并与署名规则）。 */
function teamSections() {
	return [
		promptFile("team/communication"),
		promptFile("team/scope"),
		promptFile("team/delivery")
	];
}
/** 只有编排类角色读：渠道 CLI 用法。 */
function channelNotes() {
	return [promptFile("cli")];
}
/**
* 组装一个角色的系统提示词，顺序对齐官方 `promptParts`：
* 共用段 → 角色段 → 团队段落 → 执行细则 → 渠道说明。
*/
function composePrompt(role) {
	return [
		...common(),
		promptFile(role),
		...teamSections(),
		role === "worker" ? promptFile("work") : "",
		...channelNotes()
	].filter(Boolean).join("\n\n");
}
// src/ai/_shared/plugins/index.ts
const IS_WINDOWS = process.platform === "win32";
const agentInstructions = {
	id: "agent-instructions",
	name: "@deepseek-ai/dsh-agent-instructions",
	config: { maxBytes: 65536 }
};
const timeContext = {
	id: "time-context",
	name: "@deepseek-ai/dsh-time-context"
};
const toolBash = {
	id: "tool-bash",
	name: "@deepseek-ai/dsh-tool-bash",
	disabled: IS_WINDOWS
};
const toolPwsh = {
	id: "tool-pwsh",
	name: "@deepseek-ai/dsh-tool-pwsh",
	disabled: !IS_WINDOWS
};
const toolFs = {
	id: "tool-fs",
	name: "@deepseek-ai/dsh-tool-fs",
	config: { applyPatch: false }
};
const toolFsSearch = {
	id: "tool-fs-search",
	name: "@deepseek-ai/dsh-tool-fs-search",
	config: { sampleOverCapGlobResults: false }
};
const toolJobs = {
	id: "tool-jobs",
	name: "@deepseek-ai/dsh-tool-jobs"
};
const skillFilesystem = {
	id: "skill-filesystem",
	name: "@deepseek-ai/dsh-skill-filesystem"
};
const toolSkill = {
	id: "tool-skill",
	name: "@deepseek-ai/dsh-tool-skill"
};
const commandGoal = {
	id: "command-goal",
	name: "@deepseek-ai/dsh-command-goal"
};
const compaction = {
	id: "compaction",
	name: "cordis:group",
	group: true,
	isolate: {
		compaction: true,
		toolResultPruner: true
	},
	config: [
		{
			id: "compaction-basic",
			name: "@deepseek-ai/dsh-compaction-basic"
		},
		{
			id: "command-compact",
			name: "@deepseek-ai/dsh-command-compact"
		},
		{
			id: "tool-result-pruner",
			name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
			config: {
				thresholdChars: 8192,
				headChars: 4096,
				tailChars: 1024
			}
		}
	]
};
const delegation = {
	id: "delegation",
	name: "cordis:group",
	group: true,
	isolate: { workflowEngine: true },
	config: [
		{
			id: "tool-subagent-control",
			name: "@deepseek-ai/dsh-tool-subagent-control"
		},
		{
			id: "tool-subagent",
			name: "@deepseek-ai/dsh-tool-subagent",
			config: {
				provider: "spawn",
				toolName: "subagent",
				modelSelection: true,
				modelDiscovery: true
			}
		},
		{
			id: "tool-subagent-fork",
			name: "@deepseek-ai/dsh-tool-subagent",
			config: {
				provider: "fork",
				toolName: "subagent_fork"
			}
		},
		{
			id: "workflow-ptc",
			name: "@deepseek-ai/dsh-workflow-ptc",
			disabled: true,
			config: { provider: "spawn" }
		},
		{
			id: "tool-workflow",
			name: "@deepseek-ai/dsh-tool-workflow",
			disabled: true
		}
	]
};
const toolTodo = {
	id: "tool-todo",
	name: "@deepseek-ai/dsh-tool-todo",
	config: { allowParallelInProgress: true }
};
const toolWeb = {
	id: "tool-web",
	name: "@deepseek-ai/dsh-tool-web",
	config: {
		fetch: true,
		searchTimeoutMs: 6e4
	}
};
const toolRegistryPtc = {
	id: "tool-registry-ptc",
	name: "@deepseek-ai/dsh-tool-registry-ptc"
};
const toolPresent = {
	id: "present",
	name: "@deepseek-ai/dsh-tool-present"
};
// src/ai/_shared/tools/channel.utils.ts
const observed = /* @__PURE__ */ new WeakMap();
function owner(exec) {
	return exec.agent?.session;
}
/** 同一条触发 + 同一正文只入队一次，与官方 `key('reply', triggerId, text)` 同义。 */
function replyKey(triggerId, body) {
	return `reply:${createHash("sha256").update(JSON.stringify([triggerId, body])).digest("hex").slice(0, 32)}`;
}
async function isThreadId(value) {
	if (!/^[\w-]+:[\w./-]+$/.test(value)) return false;
	return Boolean(await db.thread.findById(value));
}
function observe(exec, threadId, version) {
	const holder = owner(exec);
	if (!holder) return;
	let byTarget = observed.get(holder);
	if (!byTarget) {
		byTarget = /* @__PURE__ */ new Map();
		observed.set(holder, byTarget);
	}
	byTarget.set(threadId, { version });
}
/** 与官方 `requirePresent` 同义：没读过就抛出带错误码的拒绝。 */
function requireObserved(exec, threadId, verb) {
	const holder = owner(exec);
	const prior = holder ? observed.get(holder)?.get(threadId) : void 0;
	if (!prior) {
		const error = /* @__PURE__ */ new Error(`${verb} 需要先读过这个话题：调用 read_channel，resource 用 thread/<id> 或 trigger/<triggerId>`);
		error.name = "ChannelNotObserved";
		throw error;
	}
	return prior;
}
/** 话题的最新消息 id，用于判定「读的是哪一版」。 */
async function latestVersion(threadId) {
	return (await db.trigger.listRecent(1e3)).filter((item) => item.threadId === threadId).sort((a, b) => b.at.localeCompare(a.at))[0]?.id ?? "empty";
}
/** 记下「这个会话读过这个话题」，并把读到的那一版留下来。 */
async function markThread(exec, threadId) {
	observe(exec, threadId, await latestVersion(threadId));
}
// src/channel/_shared/error.ts
var ChannelError = class extends Error {
	code;
	retryAfterSeconds;
	hint;
	location;
	/** hint 是给人看的补充说明，不参与失败分类，只随原因码一起显示。 */
	constructor(code, retryAfterSeconds, location, hint) {
		super(code);
		this.code = code;
		this.retryAfterSeconds = retryAfterSeconds;
		this.hint = hint;
		this.location = location;
	}
};
// src/channel/_shared/primitives.ts
function record(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChannelError("invalid_response");
	return value;
}
function array(value) {
	if (!Array.isArray(value)) throw new ChannelError("invalid_response");
	return value;
}
function text(value) {
	if (typeof value !== "string" || !value) throw new ChannelError("invalid_response");
	return value;
}
function number(value) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ChannelError("invalid_response");
	return value;
}
function identity(value) {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	if (typeof value === "string" && value) return value;
	throw new ChannelError("invalid_response");
}
function timestamp(value) {
	const date = new Date(text(value));
	if (!Number.isFinite(date.getTime())) throw new ChannelError("invalid_response");
	return date.toISOString();
}
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function digest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 游标回退 5 秒，靠确定性 id 去重，避免远程迟到的事件被漏掉（官方 cursorAt）。 */
function cursorAt(started) {
	return (/* @__PURE__ */ new Date(Date.parse(started) - 5e3)).toISOString();
}
// src/channel/_shared/thread.ts
/**
* 记录话题。采集侧已经知道仓库属于哪个项目时一并写入归属，触发邮件就不必让主编排拿仓库名去猜；
* 分诊结论仍然是 pending，投递路由不变。
*/
async function recordThread(input) {
	const existing = await db.thread.findByRef(input.channel, input.refId);
	const row = await db.thread.record({
		id: existing?.id ?? `${input.channel}:${input.refId}`,
		channelId: input.channel,
		refId: input.refId,
		kind: input.kind,
		title: input.title,
		url: input.url,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		projectId: input.projectId ?? null,
		triage: "pending",
		triagedAt: null
	});
	if (row.projectId || !input.projectId) return row;
	await db.thread.bindProject(row.id, input.projectId);
	return await db.thread.findById(row.id);
}
/** 同一仓库下已经记录、但还没有归属的话题补上项目；只写 projectId，不动分诊结论。 */
async function bindThreads(input) {
	for (const thread of await db.thread.listUnbound(input.channel)) {
		if (!thread.refId.startsWith(input.refPrefix)) continue;
		await db.thread.bindProject(thread.id, input.projectId);
	}
}
/** 结单话题；合并时顺带关闭同一项目下已结单票关联的 issue。 */
async function closeThread(input) {
	const ended = await db.ticket.closeThread(input.thread.id, input.outcome, input.at);
	for (const ticketId of ended) await worker$1.archiveSessions(ticketId);
	if (input.outcome !== "merged" || !ended.length) return;
	for (const source of await db.thread.listByChannel(input.channel)) {
		if (source.kind !== "issue" || source.projectId !== input.projectId || !source.url) continue;
		if (!(await db.ticketThread.listTicketIds(source.id)).some((id) => ended.includes(id))) continue;
		await input.closeIssue(source.url).catch(() => void 0);
	}
}
// src/channel/github/runner.ts
var GhError = class extends ChannelError {};
var ExecFileGhRunner = class {
	async request(request) {
		if (request.signal?.aborted) throw new GhError("interrupted");
		const token = await channel.resolveCredential("github");
		if (request.signal?.aborted) throw new GhError("interrupted");
		if (!token?.trim()) throw new GhError("not_logged_in");
		const env = await channelProxyEnvironment(new URL(`https://${request.site}`), shell.commandEnvironment());
		for (const key of Object.keys(env)) if ([
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"GH_ENTERPRISE_TOKEN",
			"GITHUB_ENTERPRISE_TOKEN"
		].includes(key.toUpperCase())) delete env[key];
		env.GH_TOKEN = token;
		const args = [
			"api",
			"--hostname",
			request.site,
			"--method",
			request.method,
			"--include",
			request.path
		];
		for (const [key, value] of Object.entries(request.headers ?? {})) args.push("-H", `${key}: ${value}`);
		if (request.body) args.push("--input", "-");
		const location = `${request.method} ${request.path.split("?")[0]}`;
		return new Promise((resolve, reject) => {
			const child = execFile("gh", args, {
				signal: request.signal,
				timeout: 3e4,
				maxBuffer: 16777216,
				env
			}, (error, stdout, stderr) => {
				const response = stdout.replace(/\r\n/g, "\n");
				const status = Number(/^HTTP\/\S+ (\d+)/m.exec(response)?.[1]);
				const retryAfter = /^retry-after: (\d+)/im.exec(response)?.[1];
				if (status === 304) {
					resolve({ notModified: true });
					return;
				}
				if (error) {
					const code = error.code;
					reject(new GhError(code === "ENOENT" ? "gh_missing" : status === 401 || /gh auth login|not logged/i.test(stderr) ? "not_logged_in" : status === 429 || /rate limit/i.test(stderr) ? "rate_limited" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status >= 400 && status < 500 ? "remote_rejected" : code === "ABORT_ERR" ? "interrupted" : "transport_unknown", retryAfter ? Number(retryAfter) : void 0, location));
					return;
				}
				try {
					const separator = response.indexOf("\n\n");
					if (separator < 0) throw new GhError("invalid_response");
					const body = response.slice(separator + 2).trim();
					resolve(body ? JSON.parse(body) : null);
				} catch {
					reject(new GhError("invalid_response", void 0, location));
				}
			});
			if (request.body) child.stdin.end(JSON.stringify(request.body));
		});
	}
};
// src/channel/_shared/answers.ts
/** 逐行产出回答候选，跳过围栏代码块里的内容。 */
function* answerLines(body) {
	let fenced = false;
	for (const line of body.split(/\r?\n/)) {
		if (/^\s*~{3}|^\s*```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		yield line;
	}
}
// src/channel/_shared/mention.ts
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE_LINE = /^ {0,3}>/;
/**
* 平台不会把围栏代码块、行内代码和引用块里的 @ 解析成 mention，
* 判定点名之前先剥掉这些区域，避免「引用 bot 名字」被当成点名。
*/
function stripCodeAndQuotes(body) {
	const visible = [];
	let close = null;
	for (const line of body.split("\n")) {
		if (close) {
			if (close.test(line)) close = null;
			continue;
		}
		const open = FENCE_OPEN.exec(line);
		if (open) {
			const marker = open[1];
			close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
			continue;
		}
		if (QUOTE_LINE.test(line)) continue;
		visible.push(line);
	}
	return stripInlineCode(visible.join("\n"));
}
function stripInlineCode(text) {
	let visible = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] !== "`") {
			visible += text[index];
			index += 1;
			continue;
		}
		let size = 1;
		while (text[index + size] === "`") size += 1;
		const marker = "`".repeat(size);
		let cursor = index + size;
		let end = -1;
		while (cursor < text.length) {
			const found = text.indexOf(marker, cursor);
			if (found < 0) break;
			cursor = found + size;
			if (text[found - 1] !== "`" && text[cursor] !== "`") {
				end = cursor;
				break;
			}
		}
		if (end < 0) {
			visible += marker;
			index += size;
			continue;
		}
		visible += " ";
		index = end;
	}
	return visible;
}
/** GitHub 的 @ 只要求后面不是用户名字符。 */
function githubMentioned(body, bots) {
	const visible = stripCodeAndQuotes(body);
	return bots.some((bot) => new RegExp(`@${escapeRegex(bot.name)}(?![a-z0-9-])`, "i").test(visible));
}
/** GitLab 的 @ 还要求前面不是用户名字符，避免把邮箱当成点名。 */
function gitlabMentioned(body, bots) {
	const visible = stripCodeAndQuotes(body);
	return bots.some((bot) => new RegExp(`(?:^|[^a-z0-9_@])@${escapeRegex(bot.name)}(?![a-z0-9_.-])`, "i").test(visible));
}
// src/channel/_shared/ci.ts
/** 分支 CI 变更落成 ciWatch、ci 话题与触发；只有订阅了这条话题的票才收到通知。 */
async function notifyBranchCi(input) {
	const { row: watch } = await db.ciWatch.recordRevision({
		id: `${input.channel}:${input.ref}`,
		channelId: input.channel,
		kind: "branch",
		ref: input.ref,
		fingerprint: input.fingerprint,
		head: input.head,
		updatedAt: now()
	});
	if (input.silent && watch.revision === 0) return;
	const threadId = `${input.channel}:${input.ref}`;
	await db.thread.record({
		id: threadId,
		channelId: input.channel,
		refId: input.ref,
		kind: "ci",
		title: input.title,
		url: null,
		projectId: input.projectId,
		triage: "claimed",
		triagedAt: now(),
		createdAt: now(),
		updatedAt: now()
	});
	const triggerId = `${watch.id}:revision:${watch.revision}`;
	await db.trigger.ingest({
		id: triggerId,
		channelId: input.channel,
		threadId,
		kind: "ci",
		actorName: null,
		human: 0,
		mentioned: 0,
		text: input.message,
		url: input.url,
		at: now(),
		ref: input.head
	});
	for (const ticketId of await db.ticketThread.listTicketIds(threadId)) {
		const ticket = await db.ticket.findById(ticketId);
		if (!ticket || [
			"done",
			"completed",
			"cancelled"
		].includes(ticket.status)) continue;
		await db.inbox.enqueue({
			id: `${triggerId}:ticket:${ticketId}`,
			type: "project",
			origin: "system",
			kind: "notice",
			projectId: ticket.projectId,
			ticketId,
			triggerId,
			threadId,
			title: input.message,
			message: input.message
		});
	}
}
// src/channel/github/service/resource.ts
const resource$1 = defineService({
	of(remoteUrl) {
		if (!remoteUrl) return null;
		const ssh = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(remoteUrl);
		if (ssh) return ssh[1].toLowerCase();
		try {
			const url = new URL(remoteUrl);
			if (!["https:", "ssh:"].includes(url.protocol) || url.hostname !== "github.com" || url.password || url.search || url.hash || url.port) return null;
			return /^\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
		} catch {
			return null;
		}
	},
	/**
	* 仓库改名或转移后，GitHub 对旧全名仍返回 200，只是 full_name 变成新名。
	* 返回新全名，未改名时返回 null；调用方必须跟随，否则采集会在 probe 阶段永久失败。
	*/
	renamed(configured, fullName) {
		const canonical = resource$1.of(`https://github.com/${fullName}`);
		if (!canonical) throw new GhError("invalid_response");
		return canonical === configured ? null : canonical;
	},
	parse(value) {
		const short = /^github:([^/:]+\/[^/:]+):(issue|pull):([1-9]\d*)$/.exec(value);
		if (short) return {
			repository: short[1].toLowerCase(),
			kind: short[2],
			number: Number(short[3])
		};
		let url;
		try {
			url = new URL(value);
		} catch {
			throw new GhError("invalid_resource");
		}
		const match = /^\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/([1-9]\d*)\/?$/i.exec(url.pathname);
		if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || !match) throw new GhError("invalid_resource");
		return {
			repository: match[1].toLowerCase(),
			kind: match[2] === "pull" ? "pull" : "issue",
			number: Number(match[3])
		};
	},
	validate(row, target) {
		const url = resource$1.parse(text(row.html_url));
		if (number(row.number) !== target.number || url.repository !== target.repository || url.kind !== target.kind) throw new GhError("source_repository_mismatch");
	},
	item(row, kind) {
		return {
			id: identity(row.id),
			kind,
			actor: text(record(row.user).login),
			body: typeof row.body === "string" ? row.body : typeof row.state === "string" ? row.state : "",
			url: text(row.html_url),
			createdAt: timestamp(row.created_at ?? row.submitted_at),
			updatedAt: timestamp(row.updated_at ?? row.submitted_at ?? row.created_at)
		};
	}
});
// src/service/courier.ts
/** 没有活票的话题，最后一次活动超过这个时长就不再轮询（官方 POLL_HORIZON_MS）。 */
const POLL_HORIZON_MS = 12096e5;
/** 同话题投递串行化：同一时刻只允许一条在途，避免重复发言。 */
const publishing = /* @__PURE__ */ new Map();
const courier = defineService({
	async state(channel, scope, name) {
		const row = await db.sourceState.find(channel, `${scope}:${name}`);
		return row ? JSON.parse(row.value) : void 0;
	},
	async record(channel, scope, name, value) {
		await db.sourceState.set(channel, `${scope}:${name}`, JSON.stringify(value), now());
	},
	async pages(fetchPage) {
		const rows = [];
		let etag = null;
		for (let page = 1;; page++) {
			const value = await fetchPage(page);
			if (page === 1) {
				if (value.notModified) return {
					rows: [],
					notModified: true,
					etag: value.etag ?? null
				};
				etag = value.etag ?? null;
			}
			rows.push(...value.rows);
			if (value.rows.length < 100) return {
				rows,
				notModified: false,
				etag
			};
		}
	},
	page(items, offset, limit) {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ChannelError("invalid_pagination");
		return {
			items: items.slice(offset, offset + limit),
			next_offset: offset + limit < items.length ? offset + limit : null
		};
	},
	async stream(input) {
		const cursor = await courier.state(input.channel, input.scope, `cursor:${input.name}`) ?? input.initial;
		const startedAt = now();
		const value = await input.read(cursor);
		if (value.notModified) return;
		const revisions = [];
		let firstError;
		for (const row of value.rows) {
			input.signal?.throwIfAborted();
			try {
				await input.accept(row);
			} catch (error) {
				if (input.signal?.aborted) throw error;
				firstError ??= error;
			}
			revisions.push(digest(row));
		}
		if (firstError) throw firstError;
		const signature = digest(revisions.sort());
		const next = {
			...input.advance(cursor, value.rows, startedAt),
			signature,
			through: startedAt
		};
		if (value.etag !== void 0) next.etag = value.etag;
		await courier.record(input.channel, input.scope, `cursor:${input.name}`, next);
	},
	/**
	* 触发邮件的收件人：有票跟着就投给票所在项目；没有票时按话题分诊结论投给主编排或项目。
	* 无论投给谁，都把话题已匹配的项目一起带上 —— 主编排据此知道该翻哪个项目的上下文，不必拿仓库名猜。
	*/
	route(thread, ticket) {
		if (ticket) return {
			key: ticket.projectId,
			type: "project",
			projectId: ticket.projectId,
			ticketId: ticket.id
		};
		const claimed = thread.triage === "claimed" ? thread.projectId : null;
		return {
			key: claimed ?? "main",
			type: claimed ? "project" : "main",
			projectId: thread.projectId,
			ticketId: null
		};
	},
	async ingest(port, thread, row, kind, baseline, sourceKind) {
		const bots = await port.bots();
		const actorName = port.actor(row);
		const self = actorName !== "" && bots.some((bot) => bot.name.toLowerCase() === actorName.toLowerCase());
		const human = port.human(row, bots);
		const body = port.body(row);
		const mentioned = port.mentioned(body, bots);
		const at = port.at(row, kind);
		const id = `${thread.id}:${sourceKind}:${identity(row.id)}`;
		const previous = await db.trigger.findById(id);
		const fresh = !previous || previous.mentioned === 0 && mentioned;
		await db.trigger.ingest({
			id,
			channelId: port.channel,
			threadId: thread.id,
			kind,
			actorName,
			human: Number(human),
			mentioned: Number(mentioned),
			text: body,
			url: port.url(row, sourceKind, thread),
			at,
			ref: port.ref(row)
		});
		const subscriptions = await db.ticketThread.listTicketIds(thread.id);
		const historical = port.createdAt(row) < baseline;
		const { administrators, inferred } = await setting.load();
		const admin = administrators.some((name) => name.toLowerCase() === actorName.toLowerCase());
		const admission = {
			self,
			human,
			historical,
			subscribed: subscriptions.length > 0,
			admin,
			mentioned,
			kind,
			issue: thread.kind === "issue",
			ignored: thread.triage === "ignored",
			inferred
		};
		const strength = channelTriggerStrength(admission);
		if (!strength) {
			if (mentioned && channelTriggerRejection(admission) === "not_administrator") {
				await courier.record(port.channel, "admission", "last_drop", {
					reason: "not_administrator",
					actor: actorName,
					threadId: thread.id,
					at: now()
				});
				console.warn(`[${port.channel}:ingest] ${thread.url ?? thread.id} ${actorName} -> not_administrator`);
			}
			return;
		}
		const targets = /* @__PURE__ */ new Map();
		for (const ticketId of subscriptions) {
			const ticket = await db.ticket.findById(ticketId);
			if (!ticket) continue;
			if ([
				"done",
				"completed",
				"cancelled"
			].includes(ticket.status)) {
				if (!fresh || !mentioned || !await db.ticket.revive(ticketId, at)) continue;
				await db.worker.queue(ticketId, ticket.projectId);
				const target = courier.route(thread, ticket);
				targets.set(target.key, target);
				continue;
			}
			if (fresh && human && kind === "comment") await port.onSubscribedTicket?.(ticket);
			const target = courier.route(thread, ticket);
			targets.set(target.key, target);
		}
		if (!subscriptions.length) {
			const target = strength === "self" ? {
				key: "main",
				type: "main",
				projectId: thread.projectId,
				ticketId: null
			} : courier.route(thread, null);
			targets.set(target.key, target);
		}
		for (const target of targets.values()) await db.inbox.enqueue({
			id: `${id}:inbox:${target.key}`,
			type: target.type,
			origin: "channel",
			kind: "trigger",
			message: body,
			title: thread.title,
			projectId: target.projectId,
			ticketId: target.ticketId,
			triggerId: id,
			threadId: thread.id
		});
	},
	async answers(port, thread, row) {
		if (!await port.admin(row)) return;
		const body = typeof row.body === "string" ? row.body : "";
		const { answers: found, conflicts } = await port.parse(body, thread);
		const scope = await port.scope(thread);
		for (const [id, answer] of found) {
			if (conflicts.has(id)) continue;
			const ask = await db.inbox.findById(id);
			if (!ask || ask.kind !== "ask" || ask.type !== "user" || ask.status !== "pending" || timestamp(row.created_at ?? row.submitted_at) < ask.createdAt) continue;
			const trigger = ask.triggerId && await db.trigger.findById(ask.triggerId);
			if (!trigger || trigger.threadId !== thread.id || ask.threadId && ask.threadId !== thread.id) continue;
			if (!await courier.state(port.channel, scope, `comment:${id}`)) continue;
			if (ask.ticketId) {
				const ticket = await db.ticket.findById(ask.ticketId);
				if (!ticket || [
					"done",
					"completed",
					"cancelled"
				].includes(ticket.status)) continue;
			}
			await db.inbox.answerByUser(id, answer, now());
		}
	},
	async publish(port, inboxId, signal) {
		const destination = async (row) => {
			if (row.type !== "user" || !["notice", "ask"].includes(row.kind) || !row.triggerId) throw new ChannelError("invalid_delivery");
			const trigger = await db.trigger.findById(row.triggerId);
			const thread = trigger && await db.thread.findById(trigger.threadId);
			if (!thread?.url || thread.channelId !== port.channel || !["issue", "pull"].includes(thread.kind) || row.threadId && row.threadId !== thread.id) throw new ChannelError("no_reply_address");
			const target = await port.parse(thread.url);
			const project = await projectFor(port, thread, target);
			if (row.ticketId) {
				const ticket = await db.ticket.findById(row.ticketId);
				if (row.kind === "ask" && ticket && [
					"done",
					"completed",
					"cancelled"
				].includes(ticket.status)) throw new ChannelError("delivery_superseded");
				if (!ticket || ticket.projectId !== project.id) throw new ChannelError("scope_denied");
				if (ticket.paused) throw new ChannelError("human_paused");
				if (!(await db.ticketThread.listTicketIds(thread.id)).includes(ticket.id)) throw new ChannelError("unsubscribed_thread");
			}
			return {
				thread,
				target,
				project
			};
		};
		const deliver = async () => {
			let row = await db.inbox.findById(inboxId);
			if (!row) return {
				ok: false,
				reason: "unknown_delivery"
			};
			if (row.status === "done") return { ok: true };
			let posting = false;
			try {
				const { thread, target, project } = await destination(row);
				const environment = await port.probe(project.id, signal);
				const scope = port.scope(target);
				const marker = `<!-- supermesh:${row.id} -->`;
				const receipt = await courier.state(port.channel, scope, `comment:${row.id}`);
				if (receipt) {
					if (receipt.providerId !== environment.providerId || receipt.marker !== marker) throw new ChannelError("managed_comment_mismatch");
					if (row.kind === "notice") await db.inbox.markDone(row.id, now());
					return {
						ok: true,
						remoteId: receipt.remoteId
					};
				}
				if (row.nextRetryAt && row.nextRetryAt > now()) return {
					ok: false,
					reason: "retry_pending"
				};
				for (const previous of await db.inbox.listOutgoing()) {
					if (previous.id === row.id || previous.seq >= row.seq || previous.ticketId !== row.ticketId || previous.status === "done") continue;
					if ((previous.threadId ?? (previous.triggerId ? (await db.trigger.findById(previous.triggerId))?.threadId : void 0)) === thread.id && !await courier.state(port.channel, scope, `comment:${previous.id}`)) return {
						ok: false,
						reason: "earlier_delivery_pending"
					};
				}
				const existing = (await port.comments(target, signal)).filter((comment) => port.authorId(comment) === environment.providerId && port.body(comment).includes(marker));
				if (existing.length > 1) throw new ChannelError("ambiguous_delivery");
				let remote = existing[0];
				if (!remote) {
					if (row.status === "stalled" || row.deliveryError === "publishing") {
						await db.inbox.markStalled(row.id, "transport_unknown");
						return {
							ok: false,
							reason: "transport_unknown"
						};
					}
					const current = await db.inbox.findById(row.id);
					if (!current || current.status !== "pending" || current.type !== row.type || current.kind !== row.kind) return {
						ok: false,
						reason: "delivery_superseded"
					};
					await destination(current);
					await db.inbox.recordDeliveryFailure(row.id, "publishing", now());
					posting = true;
					const body = row.kind === "ask" ? port.askPrompt(row) : row.message;
					remote = await port.post(target, `${body}\n\n${marker}`, signal);
				}
				if (port.authorId(remote) !== environment.providerId || !port.body(remote).includes(marker)) throw new ChannelError("managed_comment_mismatch");
				const result = {
					remoteId: identity(remote.id),
					providerId: environment.providerId,
					marker,
					url: port.commentUrl(remote, target)
				};
				await courier.record(port.channel, scope, `comment:${row.id}`, result);
				await db.inbox.resetDelivery(row.id);
				if (row.kind === "notice") await db.inbox.markDone(row.id, now());
				return {
					ok: true,
					remoteId: result.remoteId
				};
			} catch (error) {
				const reason = courier.failure(error, port.detail);
				if (posting && ![
					"rate_limited",
					"forbidden",
					"not_found",
					"not_logged_in",
					"remote_rejected"
				].includes(reason)) await courier.stall(row, "transport_unknown");
				else if (![
					"human_paused",
					"project_disabled",
					"channel_disabled",
					"retry_pending",
					...port.skipReasons
				].includes(reason)) {
					row = await db.inbox.findById(row.id);
					const settings = await setting.load();
					const attempts = row.deliveryAttempts + (posting ? 0 : 1);
					if (attempts >= settings.deliveryMaxAttempts) await courier.stall(row, reason);
					else {
						const seconds = courier.retryDelay(error, attempts, settings.deliveryRetryCeilingSeconds);
						const nextRetryAt = new Date(Date.now() + seconds * 1e3).toISOString();
						if (posting) await db.inbox.update(row.id, {
							deliveryError: reason,
							nextRetryAt
						});
						else await db.inbox.recordDeliveryFailure(row.id, reason, nextRetryAt);
					}
				}
				if (signal?.aborted) throw error;
				return {
					ok: false,
					reason: posting && reason === "interrupted" ? "transport_unknown" : reason
				};
			}
		};
		return singlet.immediate(`${port.channel}:exclusive:publish:${inboxId}`, async () => {
			const row = await db.inbox.findById(inboxId);
			const trigger = row?.triggerId ? await db.trigger.findById(row.triggerId) : void 0;
			const key = `${port.channel}:${trigger ? trigger.threadId : inboxId}`;
			const task = (publishing.get(key) ?? Promise.resolve()).then(deliver);
			const barrier = task.then(() => void 0, () => void 0);
			publishing.set(key, barrier);
			try {
				return await task;
			} finally {
				if (publishing.get(key) === barrier) publishing.delete(key);
			}
		});
	},
	/**
	* 一条对外回复彻底送不出去：标成 stalled，并告诉它的编排。
	*
	* 失败信号只留在行上（deliveryError / status）时，编排看不到 —— 工具早就回过 queued，
	* 人却一直等一条永远不来的评论。改投一条邮件，让编排知道这条没送到。
	*/
	async stall(row, reason) {
		await db.inbox.markStalled(row.id, reason);
		if (row.type !== "user") return;
		await db.inbox.enqueue({
			id: `supermesh:reply-failed:${row.id}`,
			type: row.projectId ? "project" : "main",
			projectId: row.projectId,
			supervisorId: row.supervisorId,
			origin: "system",
			kind: "notice",
			ticketId: row.ticketId,
			threadId: row.threadId,
			triggerId: row.triggerId,
			title: "回复没有送达",
			message: `这条回复没能发到渠道（${reason}）：${row.message}`
		}).catch(() => void 0);
	},
	async flush(port, signal) {
		signal?.throwIfAborted();
		if (!(await db.channel.findById(port.channel))?.enabled) return [];
		const results = [];
		for (const row of await db.inbox.listOutgoing()) {
			signal?.throwIfAborted();
			if (row.status !== "pending") continue;
			const trigger = row.triggerId && await db.trigger.findById(row.triggerId);
			if (trigger && trigger.channelId === port.channel) results.push({
				id: row.id,
				...await courier.publish(port, row.id, signal)
			});
		}
		return results;
	},
	async harvest(port, signal) {
		signal?.throwIfAborted();
		if (!(await db.channel.findById(port.channel))?.enabled) return [];
		const results = [];
		for (const project of await db.project.listAll()) {
			signal?.throwIfAborted();
			if (!project.enabled || !await port.scope(project)) continue;
			const outcome = await courier.collect(port, project.id, void 0, signal);
			if (!outcome.ok) port.onFailure?.(project, outcome.reason ?? "channel_operation_failed");
			results.push(outcome);
		}
		return results;
	},
	async collect(port, projectId, branch, signal) {
		if (branch) {
			await port.collectBranch(projectId, branch, signal);
			return {
				projectId,
				ok: true
			};
		}
		return singlet.immediate(`${port.channel}:exclusive:collect:${projectId}`, async () => {
			const errors = [];
			let scope;
			let project;
			const context = {
				channel: port.channel,
				projectId,
				scope: "",
				baseline: "",
				environment: {
					providerId: "",
					login: "",
					repositoryId: ""
				},
				attempt: async (step, operation) => {
					try {
						await operation();
					} catch (error) {
						if (signal?.aborted) throw error;
						errors.push(courier.reason(error, port.detail, step));
					}
				},
				fail: (error, step) => {
					if (signal?.aborted) throw error;
					errors.push(courier.reason(error, port.detail, step));
				}
			};
			let ready = false;
			try {
				project = await port.project(projectId);
				const environment = await port.probe(projectId, signal);
				const resolved = await port.scope(await port.project(projectId));
				if (!resolved) throw new ChannelError("unknown_repository");
				scope = resolved;
				const baseline = await courier.state(port.channel, scope, "baseline") ?? now();
				await courier.record(port.channel, scope, "baseline", baseline);
				context.scope = scope;
				context.baseline = baseline;
				context.environment = environment;
				ready = true;
			} catch (error) {
				if (signal?.aborted) throw error;
				errors.push(courier.reason(error, port.detail, "probe"));
			}
			if (ready) try {
				await port.collect(context, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				errors.push(courier.reason(error, port.detail, "collect"));
			}
			if (port.status && project) await courier.record(port.channel, projectId, "collection_status", {
				ok: !errors.length,
				reasons: [...new Set(errors)],
				collectedAt: now()
			});
			return errors.length ? {
				projectId,
				ok: false,
				reason: [...new Set(errors)].join(",")
			} : {
				projectId,
				ok: true
			};
		});
	},
	async polled(ticketIds, updatedAt, at = Date.now()) {
		if (!ticketIds.length) return true;
		const tickets = await Promise.all(ticketIds.map((id) => db.ticket.findById(id)));
		if (tickets.some((ticket) => !!ticket && ![
			"done",
			"completed",
			"cancelled"
		].includes(ticket.status))) return true;
		const times = [updatedAt ?? "", ...tickets.map((ticket) => ticket?.endedAt ?? "")].map((value) => Date.parse(value)).filter(Number.isFinite);
		return times.length > 0 && at - Math.max(...times) < POLL_HORIZON_MS;
	},
	failure(error, detail) {
		if (error instanceof ChannelError) return error.hint ? `${error.code}(${error.hint})` : error.code;
		if (error instanceof Error) return error.name === "AbortError" ? "interrupted" : detail ? `transport_unknown(${error.message.slice(0, 120)})` : "transport_unknown";
		return "transport_unknown";
	},
	/** 采集失败要能定位到步骤或接口：错误自带位置优先，其次用调用方给的步骤名。 */
	reason(error, detail, step) {
		const code = courier.failure(error, detail);
		const located = (error instanceof ChannelError ? error.location : void 0) ?? step;
		return located ? `${code}:${located}` : code;
	},
	retryDelay(error, attempts, ceiling) {
		return Math.max(error instanceof ChannelError ? error.retryAfterSeconds ?? 0 : 0, Math.min(ceiling, 2 ** Math.max(1, attempts)));
	}
});
/** 话题仓库对不上任何项目时把两边地址写进失败原因，否则回复只会停在 unknown_repository，看不出差在哪。 */
async function projectFor(port, thread, target) {
	let project;
	try {
		project = await port.projectFor(target);
	} catch (error) {
		if (!(error instanceof ChannelError) || error.code !== "unknown_repository") throw error;
	}
	if (project) return project;
	const bound = thread.projectId ? await db.project.findById(thread.projectId) : void 0;
	const scope = port.scope(target);
	throw new ChannelError("unknown_repository", void 0, void 0, bound?.remoteUrl ? `话题仓库 ${scope} 与项目远端地址 ${bound.remoteUrl} 不一致` : `话题仓库 ${scope} 未登记为项目`);
}
// src/channel/github/service/ci.ts
const ci$1 = defineService({
	async snapshot(remote, root, head, signal) {
		const previous = await courier.state("github", root.slice(6), `ci_runs:${head}`);
		const checks = /* @__PURE__ */ new Map();
		const statuses = /* @__PURE__ */ new Map();
		const acceptCheck = (check) => {
			if (check.head_sha !== head) return;
			const key = `${identity(record(check.app).id)}:${text(check.name)}`;
			const prior = checks.get(key);
			if (!prior || number(check.id) > number(prior.id) || check.id === prior.id && !(prior.status === "completed" && check.status !== "completed") && timestamp(check.completed_at ?? check.started_at ?? check.created_at) >= timestamp(prior.completed_at ?? prior.started_at ?? prior.created_at)) checks.set(key, check);
		};
		const acceptStatus = (status) => {
			const key = text(status.context);
			const prior = statuses.get(key);
			if (!prior || timestamp(status.updated_at ?? status.created_at) > timestamp(prior.updated_at ?? prior.created_at) || timestamp(status.updated_at ?? status.created_at) === timestamp(prior.updated_at ?? prior.created_at) && number(status.id) > number(prior.id)) statuses.set(key, status);
		};
		for (const check of previous?.checks ?? []) acceptCheck(check);
		for (const status of previous?.statuses ?? []) acceptStatus(status);
		for (const kind of ["check-runs", "status"]) for (let page = 1;; page++) {
			const response = record(await remote.request(`${root}/commits/${encodeURIComponent(head)}/${kind}?per_page=100&page=${page}`, signal));
			if (kind === "status" && response.sha !== head) throw new GhError("ci_head_mismatch");
			const rows = array(response[kind === "check-runs" ? "check_runs" : "statuses"]).map(record);
			for (const row of rows) (kind === "check-runs" ? acceptCheck : acceptStatus)(row);
			if (rows.length < 100) break;
		}
		const states = [...checks.values()].map((check) => check.status === "in_progress" ? "running" : check.status !== "completed" ? "pending" : [
			"success",
			"neutral",
			"skipped"
		].includes(String(check.conclusion)) ? "passing" : "failing");
		states.push(...[...statuses.values()].map((status) => status.state === "success" ? "passing" : status.state === "pending" ? "pending" : "failing"));
		const result = {
			state: states.includes("failing") ? "failing" : states.includes("running") ? "running" : !states.length || states.includes("pending") ? "pending" : "passing",
			checks: [...checks.values()],
			statuses: [...statuses.values()]
		};
		await courier.record("github", root.slice(6), `ci_runs:${head}`, result);
		return result;
	},
	async branch(remote, projectId, branch, signal) {
		const project = await remote.project(projectId);
		await remote.probe(projectId, signal);
		const repository = resource$1.of(project.remoteUrl);
		const head = text(record(await remote.request(`repos/${repository}/commits/${encodeURIComponent(branch)}`, signal)).sha);
		const snapshot = await ci$1.snapshot(remote, `repos/${repository}`, head, signal);
		const failing = snapshot.checks.filter((check) => check.status === "completed" && ![
			"success",
			"neutral",
			"skipped"
		].includes(String(check.conclusion))).map((check) => text(check.name));
		failing.push(...snapshot.statuses.filter((status) => !["success", "pending"].includes(String(status.state))).map((status) => text(status.context)));
		await notifyBranchCi({
			channel: "github",
			projectId,
			ref: `${repository}:branch:${branch}`,
			fingerprint: digest({
				state: snapshot.state,
				failing: failing.sort()
			}),
			head,
			title: `CI ${branch}`,
			message: `${branch} CI ${snapshot.state}${failing.length ? `: ${failing.join(", ")}` : ""}`,
			url: `https://github.com/${repository}/commit/${head}`,
			silent: !failing.length
		});
	}
});
// src/channel/github/service/binding.ts
const binding$1 = defineService({ of(channel) {
	return {
		delivery: {
			channel: "github",
			detail: false,
			parse: async (value) => resource$1.parse(value),
			scope: (target) => target.repository,
			projectFor: (target) => channel.projectForRepository(target.repository),
			probe: (projectId, signal) => channel.probe(projectId, signal),
			comments: (target, signal) => channel.pages(`repos/${target.repository}/issues/${target.number}/comments`, signal),
			authorId: (row) => record(row.user).id != null ? identity(record(row.user).id) : null,
			body: (row) => typeof row.body === "string" ? row.body : "",
			post: async (target, body, signal) => record(await channel.request(`repos/${target.repository}/issues/${target.number}/comments`, signal, "POST", { body })),
			commentUrl: (row, target) => {
				const url = text(row.html_url);
				const remote = resource$1.parse(url);
				if (remote.repository !== target.repository || remote.number !== target.number) throw new GhError("managed_comment_mismatch");
				return url;
			},
			askPrompt: (row) => `${row.message}\n\n回复格式：\`answer: 你的回答\``,
			skipReasons: []
		},
		collector: {
			channel: "github",
			detail: false,
			status: true,
			scope: async (project) => resource$1.of(project.remoteUrl),
			project: (projectId) => channel.project(projectId),
			probe: (projectId, signal) => channel.probe(projectId, signal),
			collect: (context, signal) => channel.collectProject(context, signal),
			collectBranch: (projectId, branch, signal) => ci$1.branch(channel, projectId, branch, signal),
			onFailure: (project, reason) => console.error(`[github:collect] ${project.name} ${project.remoteUrl} -> ${reason}`)
		},
		ingestor: {
			channel: "github",
			bots: async () => (await db.channelAccount.findByChannel("github")).filter((account) => account.role === "bot"),
			actor: (row) => text(record(row.user).login),
			human: (row, bots) => {
				const author = record(row.user);
				const name = text(author.login);
				return author.type !== "Bot" && !name.endsWith("[bot]") && !bots.some((bot) => bot.name.toLowerCase() === name.toLowerCase());
			},
			body: (row) => typeof row.body === "string" ? row.body : typeof row.state === "string" ? row.state : "",
			url: (row) => text(row.html_url),
			ref: (row) => row.head ? text(record(row.head).ref) : null,
			at: (row, kind) => kind === "close" ? timestamp(row.closed_at ?? row.updated_at ?? row.created_at) : timestamp(row.created_at ?? row.submitted_at),
			createdAt: (row) => timestamp(row.created_at ?? row.submitted_at),
			mentioned: githubMentioned,
			onSubscribedTicket: async (ticket) => {
				if (ticket.status !== "review" || ticket.paused) return;
				await db.worker.queue(ticket.id, ticket.projectId).catch(() => void 0);
			}
		},
		answerer: {
			channel: "github",
			admin: async (row) => {
				const author = record(row.user);
				const login = text(author.login);
				const accounts = await db.channelAccount.findByChannel("github");
				if (author.type !== "User" || login.endsWith("[bot]") || accounts.some((account) => account.role === "bot" && account.name.toLowerCase() === login.toLowerCase())) return false;
				return (await setting.load()).administrators.some((name) => name.toLowerCase() === login.toLowerCase());
			},
			parse: async (body, thread) => {
				const answers = /* @__PURE__ */ new Map();
				const conflicts = /* @__PURE__ */ new Set();
				let anonymous;
				for (const line of answerLines(body)) {
					if (!/^answer(?:[ \t:：]|$)/i.test(line)) continue;
					const content = line.slice(6).trim().replace(/^[:：]\s*/, "").trim();
					if (!content) continue;
					const separator = content.indexOf(": ");
					const candidate = separator > 0 ? content.slice(0, separator).trim() : "";
					if (candidate && /^[0-9a-f][\w:-]{7,}$/i.test(candidate) && content.slice(separator + 2).trim()) {
						const answer = content.slice(separator + 2).trim();
						if (answers.has(candidate) && answers.get(candidate) !== answer) conflicts.add(candidate);
						answers.set(candidate, answer);
						continue;
					}
					anonymous ??= content;
				}
				if (anonymous !== void 0) {
					const pending = (await db.inbox.listPendingAsk()).filter((ask) => ask.type === "user");
					const scoped = pending.filter((ask) => ask.threadId === thread.id);
					const only = scoped.length === 1 ? scoped[0] : scoped.length === 0 && pending.length === 1 ? pending[0] : void 0;
					if (only) answers.set(only.id, anonymous);
				}
				return {
					answers,
					conflicts
				};
			},
			scope: async (thread) => resource$1.parse(thread.url).repository
		}
	};
} });
// src/channel/github/service/pull.ts
const pull = defineService({
	async collect(remote, projectId, threadId, signal) {
		return singlet.immediate(`github:exclusive:pull:${threadId}`, async () => {
			const project = await remote.project(projectId);
			await remote.probe(projectId, signal);
			const thread = await db.thread.findById(threadId);
			if (!thread?.url || thread.kind !== "pull") throw new GhError("invalid_pull_request");
			const target = resource$1.parse(thread.url);
			if (target.repository !== resource$1.of(project.remoteUrl)) throw new GhError("source_repository_mismatch");
			const root = `repos/${target.repository}`;
			const detail = record(await remote.request(`${root}/pulls/${target.number}`, signal));
			resource$1.validate(detail, target);
			const head = text(record(detail.head).sha);
			const base = record(detail.base);
			if (text(record(base.repo).full_name).toLowerCase() !== target.repository) throw new GhError("pull_request_mismatch");
			const state = detail.merged === true ? "merged" : detail.state === "open" ? "open" : detail.state === "closed" ? "closed" : null;
			if (!state) throw new GhError("invalid_response");
			const previous = await courier.state("github", target.repository, `pr_fact:${target.number}`);
			const updatedAt = timestamp(detail.updated_at);
			if (previous && (previous.updatedAt > updatedAt || previous.state === "merged" && state !== "merged")) return {
				ok: false,
				reason: "stale_pr_snapshot"
			};
			let ciState = previous?.head === head ? previous.ciState : "pending";
			let ciError;
			let ciLocation;
			let snapshot;
			try {
				snapshot = await ci$1.snapshot(remote, root, head, signal);
				ciState = snapshot.state;
			} catch (error) {
				if (signal?.aborted) throw error;
				ciError = courier.failure(error, false);
				ciLocation = `pull:${target.number}:ci`;
			}
			const fact = {
				head,
				base: text(base.ref),
				state,
				ciState,
				collectedAt: now(),
				updatedAt,
				ciError,
				url: text(detail.html_url)
			};
			await courier.record("github", target.repository, `pr_fact:${target.number}`, fact);
			if (typeof detail.title === "string" && detail.title && thread.title !== detail.title) await db.thread.setTitle(thread.id, detail.title);
			for (const ticket of await db.ticket.listByPullRequest(projectId, thread.url)) {
				await db.ticketThread.link(ticket.id, thread.id, now());
				await db.ticket.setPullRequest(ticket.id, thread.url, state, ciState);
			}
			const subscriptions = await db.ticketThread.listTicketIds(thread.id);
			for (const ticketId of subscriptions) {
				const ticket = await db.ticket.findById(ticketId);
				if (ticket?.projectId === projectId && ticket.prUrl === thread.url) await db.ticket.setPullRequest(ticketId, thread.url, state, ciState);
			}
			if (state === "merged" || state === "closed") await pull.closed(remote, projectId, thread, state, detail.merged === true ? timestamp(detail.merged_at ?? detail.closed_at ?? detail.updated_at) : timestamp(detail.closed_at ?? detail.updated_at));
			const fingerprint = digest({
				head,
				state,
				ciState,
				ciError,
				checks: snapshot?.checks,
				statuses: snapshot?.statuses
			});
			const ref = `${target.repository}:${target.number}`;
			const { row: watch } = await db.ciWatch.recordRevision({
				id: `github:pull:${ref}`,
				channelId: "github",
				kind: "pull",
				ref,
				fingerprint,
				head,
				updatedAt: now()
			});
			const triggerId = `${watch.id}:revision:${watch.revision}`;
			const message = `PR #${target.number}: ${state}, CI ${ciState}${ciError ? ` (${ciError})` : ""}`;
			if (!await db.trigger.exists(triggerId)) await db.trigger.ingest({
				id: triggerId,
				channelId: "github",
				threadId,
				kind: "ci",
				actorName: null,
				human: 0,
				mentioned: 0,
				text: message,
				url: thread.url,
				at: now(),
				ref: head
			});
			for (const ticketId of subscriptions) {
				const ticket = await db.ticket.findById(ticketId);
				if (ticket?.projectId === projectId && ![
					"done",
					"completed",
					"cancelled"
				].includes(ticket.status)) await db.inbox.enqueue({
					id: `${triggerId}:ticket:${ticketId}`,
					type: "project",
					origin: "system",
					kind: "notice",
					projectId,
					ticketId,
					triggerId,
					threadId,
					title: message,
					message
				});
			}
			return {
				ok: !ciError,
				...ciError ? {
					reason: ciError,
					location: ciLocation
				} : {}
			};
		});
	},
	async closed(remote, projectId, thread, outcome, at) {
		await closeThread({
			channel: "github",
			projectId,
			thread,
			outcome,
			at,
			closeIssue: async (url) => {
				const target = resource$1.parse(url);
				if (target.kind !== "issue") return;
				await remote.request(`repos/${target.repository}/issues/${target.number}`, void 0, "PATCH", { state: "closed" });
			}
		});
	}
});
// src/channel/github/channel.ts
var GitHubChannel = class {
	runner;
	delivery;
	collector;
	ingestor;
	answerer;
	constructor(runner = new ExecFileGhRunner()) {
		this.runner = runner;
		const ports = binding$1.of(this);
		this.delivery = ports.delivery;
		this.collector = ports.collector;
		this.ingestor = ports.ingestor;
		this.answerer = ports.answerer;
	}
	async request(path, signal, method = "GET", body, headers) {
		signal?.throwIfAborted();
		return this.runner.request({
			site: "github.com",
			path,
			method,
			body,
			headers,
			signal
		});
	}
	async project(projectId) {
		const project = await db.project.findById(projectId);
		if (!project || !resource$1.of(project.remoteUrl)) throw new GhError("unknown_repository");
		if (!project.enabled) throw new GhError("project_disabled");
		return project;
	}
	/** 仓库唯一对应一个启用项目时返回它；没有项目或不止一个都不猜。 */
	async bindingProject(repository) {
		const projects = (await db.project.listAll()).filter((project) => project.enabled && resource$1.of(project.remoteUrl) === repository);
		return projects.length === 1 ? projects[0].id : null;
	}
	async projectForRepository(repository) {
		const match = async (name) => (await db.project.listAll()).filter((project) => resource$1.of(project.remoteUrl) === name);
		let projects = await match(repository);
		if (!projects.length) {
			const canonical = await this.canonicalRepository(repository);
			if (canonical) projects = await match(canonical);
		}
		if (projects.length !== 1) throw new GhError(projects.length ? "ambiguous_repository" : "unknown_repository");
		return projects[0];
	}
	async canonicalRepository(repository) {
		try {
			const remote = record(await this.request(`repos/${repository}`));
			return resource$1.renamed(repository, text(remote.full_name));
		} catch {
			return null;
		}
	}
	async probe(projectId, signal) {
		const project = await this.project(projectId);
		if (!(await db.channel.findById("github"))?.enabled) throw new GhError("channel_disabled");
		const bots = (await db.channelAccount.findByRole("github", "bot")).filter((account) => account.status === "online");
		const account = record(await this.request("user", signal));
		const providerId = identity(account.id);
		const login = text(account.login);
		if (!bots.some((bot) => bot.name.toLowerCase() === login.toLowerCase())) throw new GhError("account_mismatch");
		const repository = resource$1.of(project.remoteUrl);
		const remote = record(await this.request(`repos/${repository}`, signal));
		const canonical = resource$1.renamed(repository, text(remote.full_name)) ?? repository;
		if (canonical !== repository) {
			await db.project.setRemoteUrl(project.id, `https://github.com/${canonical}`, now());
			await db.sourceState.renameScope("github", repository, canonical, now());
			await courier.record("github", canonical, "repository_renamed", {
				from: repository,
				to: canonical
			});
		}
		const result = {
			providerId,
			login,
			repositoryId: identity(remote.id),
			defaultBranch: typeof remote.default_branch === "string" ? remote.default_branch : null
		};
		const previous = await courier.state("github", canonical, "verified_environment");
		if (previous && (previous.providerId !== providerId || previous.repositoryId !== result.repositoryId)) throw new GhError("environment_identity_changed");
		await courier.record("github", canonical, "verified_environment", result);
		return result;
	}
	async pages(path, signal) {
		return (await courier.pages(async (page) => ({ rows: array(await this.request(`${path + (path.includes("?") ? "&" : "?")}per_page=100&page=${page}`, signal)).map(record) }))).rows;
	}
	async read(value, offset = 0, limit = 50, signal) {
		const target = resource$1.parse(value);
		const project = await this.projectForRepository(target.repository);
		await this.probe(project.id, signal);
		const root = `repos/${target.repository}`;
		const main = record(await this.request(root + (target.kind === "pull" ? "/pulls/" : "/issues/") + target.number, signal));
		resource$1.validate(main, target);
		const items = [resource$1.item(main, target.kind)];
		for (const row of await this.pages(`${root}/issues/${target.number}/comments`, signal)) items.push(resource$1.item(row, "comment"));
		if (target.kind === "pull") {
			for (const row of await this.pages(`${root}/pulls/${target.number}/reviews`, signal)) items.push(resource$1.item(row, "review"));
			for (const row of await this.pages(`${root}/pulls/${target.number}/comments`, signal)) items.push(resource$1.item(row, "review_comment"));
		}
		items.splice(1, items.length - 1, ...items.slice(1).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
		return {
			...courier.page(items, offset, limit),
			next_resource: null
		};
	}
	async normalize(value) {
		const target = resource$1.parse(value);
		return `https://github.com/${target.repository}/${target.kind === "pull" ? "pull" : "issues"}/${target.number}`;
	}
	async readable(value) {
		try {
			await this.normalize(value);
			return true;
		} catch {
			return false;
		}
	}
	async harvest(signal) {
		return courier.harvest(this.collector, signal);
	}
	async collect(projectId, branch, signal) {
		return courier.collect(this.collector, projectId, branch, signal);
	}
	async collectProject(context, signal) {
		const repo = context.scope;
		const { attempt, fail, baseline, environment } = context;
		const owner = await this.bindingProject(repo);
		if (owner) await bindThreads({
			channel: "github",
			refPrefix: `${repo}:`,
			projectId: owner
		});
		await attempt("topics", () => this.stream(repo, "topics", `repos/${repo}/issues?state=all&sort=updated&direction=asc`, baseline, async (row) => {
			const target = {
				repository: repo,
				number: number(row.number),
				kind: row.pull_request ? "pull" : "issue"
			};
			resource$1.validate(row, target);
			const thread = await this.ensureThread(target, row, owner);
			const kind = target.kind === "issue" && row.state === "closed" ? "close" : "open";
			await courier.ingest(this.ingestor, thread, row, kind, baseline, kind);
			if (target.kind === "pull") await this.collectPullRequest(context.projectId, thread.id, target.number, signal);
		}, signal));
		await attempt("comments", () => this.stream(repo, "comments", `repos/${repo}/issues/comments?sort=updated&direction=asc`, baseline, async (row) => {
			const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(text(row.issue_url));
			if (!match || match[1].toLowerCase() !== repo) throw new GhError("source_repository_mismatch");
			const thread = await db.thread.findByRef("github", `${repo}:${match[2]}`);
			if (thread) {
				await courier.answers(this.answerer, thread, row);
				await courier.ingest(this.ingestor, thread, row, "comment", baseline, "comment");
			}
		}, signal));
		for (const thread of await db.thread.listByChannel("github")) {
			if (thread.kind !== "pull" || !thread.url) continue;
			const ticketIds = await db.ticketThread.listTicketIds(thread.id);
			if (!ticketIds.length) continue;
			if (!await courier.polled(ticketIds, thread.updatedAt)) continue;
			if ((await Promise.all(ticketIds.map((id) => db.ticket.findById(id)))).every((ticket) => !!ticket && [
				"done",
				"completed",
				"cancelled"
			].includes(ticket.status) && !!ticket.prState && ["merged", "closed"].includes(ticket.prState))) continue;
			let target;
			try {
				target = resource$1.parse(thread.url);
			} catch (error) {
				fail(error, "pull");
				continue;
			}
			if (target.repository !== repo) continue;
			await attempt(`pull:${target.number}`, async () => {
				const root = `repos/${repo}/pulls/${target.number}`;
				for (const [path, kind] of [["reviews", "review"], ["comments", "review_comment"]]) await attempt(`pull:${target.number}:${path}`, async () => {
					await this.stream(repo, `pull:${target.number}:${path}`, `${root}/${path}?sort=updated&direction=asc`, baseline, async (row) => {
						await courier.answers(this.answerer, thread, row);
						await courier.ingest(this.ingestor, thread, row, "comment", baseline, kind);
					}, signal);
				});
				await this.collectPullRequest(context.projectId, thread.id, target.number, signal);
			});
		}
		if (environment.defaultBranch) await attempt("ci", () => ci$1.branch(this, context.projectId, environment.defaultBranch, signal));
	}
	async stream(repository, name, path, baseline, accept, signal) {
		await courier.stream({
			channel: "github",
			scope: repository,
			name,
			initial: { since: baseline },
			read: async (cursor) => {
				const conditional = cursor.etag && cursor.etagSince === cursor.since ? { "If-None-Match": cursor.etag } : void 0;
				const value = await this.request(`${path}&since=${encodeURIComponent(cursor.since)}&per_page=100`, signal, "GET", void 0, conditional);
				if (value && typeof value === "object" && value.notModified) return {
					rows: [],
					notModified: true
				};
				return {
					rows: array(value).map(record),
					notModified: false
				};
			},
			advance: (cursor, rows) => {
				const newest = Math.max(...rows.map((row) => Date.parse(timestamp(row.updated_at))).filter(Number.isFinite));
				const moved = Number.isFinite(newest) ? (/* @__PURE__ */ new Date(newest - 5e3)).toISOString() : cursor.since;
				return { since: moved > cursor.since ? moved : cursor.since };
			},
			accept,
			signal
		});
	}
	async ensureThread(target, row, projectId) {
		return recordThread({
			channel: "github",
			refId: `${target.repository}:${target.number}`,
			kind: target.kind,
			title: text(row.title),
			url: text(row.html_url),
			createdAt: timestamp(row.created_at),
			updatedAt: timestamp(row.updated_at),
			projectId
		});
	}
	async collectPullRequest(projectId, threadId, number, signal) {
		try {
			const result = await pull.collect(this, projectId, threadId, signal);
			if (!result.ok) throw new GhError(result.reason, void 0, result.location ?? `pull:${number}`);
		} catch (error) {
			if (error instanceof ChannelError && !error.location) error.location = `pull:${number}`;
			throw error;
		}
	}
	async publish(inboxId, signal) {
		return courier.publish(this.delivery, inboxId, signal);
	}
	async flush(signal) {
		return courier.flush(this.delivery, signal);
	}
};
const github = new GitHubChannel();
// src/channel/gitlab/runner.ts
var GitLabError = class extends ChannelError {};
var FetchGitLabRunner = class {
	async request(request) {
		if (request.signal?.aborted) throw new GitLabError("interrupted");
		const configured = await channel.connection("gitlab");
		if (!configured?.enabled) throw new GitLabError("channel_disabled");
		const site = gitlabSite(configured.host);
		if (request.site !== site || !/^(?:user$|projects(?:\/|$))/.test(request.path) || request.path.includes("\\") || request.path.includes("#") || /[\r\n]/.test(request.path)) throw new GitLabError("scope_denied");
		const url = new URL(`${site}/api/v4/${request.path}`);
		if (url.origin !== site || !url.pathname.startsWith("/api/v4/")) throw new GitLabError("scope_denied");
		const token = configured.token;
		if (!token?.trim()) throw new GitLabError("not_logged_in");
		if (request.signal?.aborted) throw new GitLabError("interrupted");
		const env = await channelProxyEnvironment(url, process.env);
		const dispatcher = await createRouteDispatcher({ get: (name) => env[name] === void 0 ? void 0 : { value: env[name] } }, { allowH2: false });
		try {
			let response;
			try {
				response = await fetch(url.href, {
					dispatcher,
					method: request.method,
					headers: {
						"private-token": token,
						"accept": "application/json",
						...request.body ? { "content-type": "application/json" } : {},
						...request.headers
					},
					...request.body ? { body: JSON.stringify(request.body) } : {},
					redirect: "follow",
					signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(3e4)]) : AbortSignal.timeout(3e4)
				});
			} catch (error) {
				const cause = error.cause;
				const detail = [
					error instanceof Error ? error.message : String(error),
					cause?.message,
					cause?.code
				].filter(Boolean).join(" / ");
				throw new GitLabError(request.signal?.aborted ? "interrupted" : `transport_unknown: ${detail.slice(0, 200)}`);
			}
			if (response.status === 304) {
				await response.body?.cancel();
				return {
					body: null,
					etag: response.headers.get("etag") ?? null,
					notModified: true
				};
			}
			if (!response.ok) {
				await response.body?.cancel();
				const retry = response.headers.get("retry-after");
				const retryAfter = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1e3)) : void 0;
				throw new GitLabError(response.status === 401 ? "not_logged_in" : response.status === 429 ? "rate_limited" : response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : response.status >= 400 && response.status < 500 ? "remote_rejected" : "transport_unknown", Number.isFinite(retryAfter) ? retryAfter : void 0);
			}
			let body;
			try {
				body = await response.json();
			} catch {
				throw new GitLabError("invalid_response");
			}
			return request.withEtag ? {
				body,
				etag: response.headers.get("etag") ?? null
			} : body;
		} finally {
			await dispatcher.close();
		}
	}
};
function gitlabSite(host) {
	let url;
	try {
		url = new URL(host ?? "https://gitlab.com");
	} catch {
		throw new GitLabError("invalid_channel_host");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new GitLabError("invalid_channel_host");
	return url.origin;
}
// src/channel/gitlab/service/hosts.ts
const STATE = "web_hosts";
let stored = null;
let loading;
/**
* 自建 GitLab 常把 API 放在 IP、`external_url` 用域名，API 返回的 `web_url` 因此与配置的站点不同源。
* 这里保存从已认证 API 学到的网页 host，让同一实例的两种形态都能解析。
*/
const hosts = defineService({
	ready() {
		loading ??= load();
		return loading;
	},
	allowed(site) {
		const configured = new URL(gitlabSite(site));
		const aliases = stored?.site === configured.origin ? stored.hosts : [];
		return [.../* @__PURE__ */ new Set([configured.host, ...aliases])];
	},
	async learn(site, webUrl) {
		const configured = new URL(gitlabSite(site));
		let host;
		try {
			host = new URL(webUrl).host;
		} catch {
			return;
		}
		const aliases = stored?.site === configured.origin ? stored.hosts : [];
		if (!host || host === configured.host || aliases.includes(host)) return;
		const next = {
			site: configured.origin,
			hosts: [...aliases, host]
		};
		stored = next;
		await db.sourceState.set("gitlab", STATE, JSON.stringify(next), (/* @__PURE__ */ new Date()).toISOString());
	}
});
async function load() {
	const row = await db.sourceState.find("gitlab", STATE);
	if (!row) return;
	try {
		const value = JSON.parse(row.value);
		if (value && typeof value === "object" && !Array.isArray(value) && "site" in value && "hosts" in value && typeof value.site === "string" && Array.isArray(value.hosts)) stored = {
			site: value.site,
			hosts: value.hosts.filter((host) => typeof host === "string")
		};
	} catch {}
}
// src/channel/gitlab/service/resource.ts
const resource = defineService({
	remote(remoteUrl, host) {
		if (!remoteUrl) return null;
		const site = gitlabSite(host);
		const allowed = hosts.allowed(site);
		const scp = /^git@([^/:]+):(.+)$/.exec(remoteUrl);
		if (scp) {
			if (!allowed.some((entry) => hostnameOf(entry) === scp[1].toLowerCase())) return null;
			const repository = resource.path(scp[2].replace(/\.git$/, ""));
			return repository ? {
				site,
				repository
			} : null;
		}
		try {
			const url = new URL(remoteUrl);
			if (![
				"http:",
				"https:",
				"ssh:"
			].includes(url.protocol) || !allowed.includes(url.host) || url.password || url.search || url.hash) return null;
			if (url.protocol === "ssh:" ? url.username !== "git" : Boolean(url.username)) return null;
			const repository = resource.path(url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, ""));
			return repository ? {
				site,
				repository
			} : null;
		} catch {
			return null;
		}
	},
	path(value) {
		const segments = value.split("/");
		return segments.length >= 2 && segments.every((segment) => /^\w[\w.-]*$/.test(segment) && segment !== "." && segment !== "..") ? value : null;
	},
	parse(value, site) {
		const short = /^gitlab:([^:]+):(issue|pull|mr):([1-9]\d*)$/.exec(value);
		if (short) {
			const repository = resource.path(short[1]);
			const number = Number(short[3]);
			if (repository && Number.isSafeInteger(number)) return {
				site,
				repository,
				kind: short[2] === "issue" ? "issue" : "pull",
				number
			};
			throw new GitLabError("invalid_resource");
		}
		let url;
		try {
			url = new URL(value.startsWith("gitlab/") ? `${site}/${value.slice(7)}` : value);
		} catch {
			throw new GitLabError("invalid_resource");
		}
		const match = /^\/(.+?)(?:\/-\/(issues|work_items|merge_requests)|\/(issues|merge_requests))\/([1-9]\d*)\/?$/.exec(url.pathname);
		const repository = match && resource.path(match[1]);
		const number = Number(match?.[4]);
		if (!["http:", "https:"].includes(url.protocol) || !hosts.allowed(site).includes(url.host) || url.username || url.password || url.search || url.hash && !/^#note_[1-9]\d*$/.test(url.hash) || !repository || !Number.isSafeInteger(number)) throw new GitLabError("invalid_resource");
		return {
			site,
			repository,
			kind: (match[2] ?? match[3]) === "merge_requests" ? "pull" : "issue",
			number
		};
	},
	source(target) {
		return `${target.site}/${target.repository}`;
	},
	url(target) {
		return `${resource.source(target)}/${target.kind === "issue" ? "issues" : "merge_requests"}/${target.number}`;
	},
	apiRoot(target) {
		return `projects/${encodeURIComponent(target.repository)}/${target.kind === "issue" ? "issues" : "merge_requests"}/${target.number}`;
	},
	validateTopic(row, target) {
		const remote = resource.parse(text(row.web_url), target.site);
		if (number(row.iid) !== target.number || resource.url(remote) !== resource.url(target)) throw new GitLabError("source_repository_mismatch");
	},
	validateNote(row, target) {
		identity(row.id);
		if (row.noteable_iid !== void 0 && number(row.noteable_iid) !== target.number) throw new GitLabError("source_repository_mismatch");
		if (row.noteable_type !== void 0 && row.noteable_type !== (target.kind === "issue" ? "Issue" : "MergeRequest")) throw new GitLabError("source_repository_mismatch");
		if (row.web_url !== void 0 && resource.url(resource.parse(text(row.web_url), target.site)) !== resource.url(target)) throw new GitLabError("source_repository_mismatch");
	},
	item(row, kind, target) {
		if (kind === "comment") resource.validateNote(row, target);
		return {
			id: identity(row.id),
			kind,
			actor: text(record(row.author).username),
			body: typeof row.body === "string" ? row.body : typeof row.description === "string" ? row.description : typeof row.state === "string" ? row.state : "",
			url: kind === "comment" ? `${resource.url(target)}#note_${identity(row.id)}` : text(row.web_url),
			createdAt: timestamp(row.created_at),
			updatedAt: timestamp(row.updated_at ?? row.created_at)
		};
	},
	answers(body) {
		const answers = /* @__PURE__ */ new Map();
		const conflicts = /* @__PURE__ */ new Set();
		for (const line of answerLines(body)) {
			if (!/^answer[ \t]/i.test(line)) continue;
			const content = line.slice(7).trim();
			const separator = content.indexOf(": ");
			if (separator < 1) continue;
			const id = content.slice(0, separator).trim();
			const answer = content.slice(separator + 2).trim();
			if (!answer || /\s/.test(id)) continue;
			if (answers.has(id) && answers.get(id) !== answer) conflicts.add(id);
			answers.set(id, answer);
		}
		return {
			answers,
			conflicts
		};
	}
});
function hostnameOf(host) {
	try {
		return new URL(`http://${host}`).hostname;
	} catch {
		return host;
	}
}
// src/channel/gitlab/service/ci.ts
const ci = defineService({
	async branch(remote, projectId, branch, signal) {
		const project = await remote.project(projectId);
		const site = await remote.site();
		const target = resource.remote(project.remoteUrl, site);
		if (!target) return;
		const path = `projects/${encodeURIComponent(target.repository)}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`;
		const latest = array(await remote.request(site, path, signal)).map(record)[0];
		if (!latest) return;
		const state = text(latest.status);
		const head = text(latest.sha);
		await notifyBranchCi({
			channel: "gitlab",
			projectId,
			ref: `${target.repository}:branch:${branch}`,
			fingerprint: digest({
				state,
				head
			}),
			head,
			title: `CI ${branch}`,
			message: `${branch} CI ${state}`,
			url: text(latest.web_url),
			silent: [
				"success",
				"skipped",
				"manual"
			].includes(state)
		});
	},
	async activeBranches(remote, site, repository, signal) {
		const path = `projects/${encodeURIComponent(repository)}/merge_requests?state=opened&per_page=100`;
		const rows = array(await remote.request(site, path, signal)).map(record);
		return [...new Set(rows.map((row) => text(row.source_branch)).filter(Boolean))];
	},
	async defaultBranch(remote, site, repository, signal) {
		const row = record(await remote.request(site, `projects/${encodeURIComponent(repository)}`, signal));
		return (typeof row.default_branch === "string" ? row.default_branch.trim() : "") || null;
	}
});
// src/channel/gitlab/service/binding.ts
const binding = defineService({ of(channel) {
	return {
		collect: collectPort(channel),
		delivery: deliveryPort(channel),
		ingest: ingestPort(),
		answer: answerPort(channel)
	};
} });
function collectPort(channel) {
	return {
		channel: "gitlab",
		detail: true,
		status: true,
		scope: (project) => channel.scopeOf(project),
		project: (projectId) => channel.project(projectId),
		probe: (projectId, signal) => channel.probe(projectId, signal),
		collect: (context, signal) => channel.collectProject(context, signal),
		collectBranch: (projectId, branch, signal) => ci.branch(channel, projectId, branch, signal),
		onFailure: (project, reason) => console.error(`[gitlab:collect] ${project.name} ${project.remoteUrl} -> ${reason}`)
	};
}
function deliveryPort(channel) {
	return {
		channel: "gitlab",
		detail: true,
		parse: async (value) => resource.parse(value, await channel.site()),
		scope: (target) => resource.source(target),
		projectFor: (target) => channel.projectForRepository(resource.source(target)),
		probe: (projectId, signal) => channel.probe(projectId, signal),
		comments: async (target, signal) => (await channel.pages(target.site, `${resource.apiRoot(target)}/notes`, signal)).rows,
		authorId: (row) => {
			const author = record(row.author);
			return author.id != null ? identity(author.id) : null;
		},
		body: (row) => typeof row.body === "string" ? row.body : "",
		post: async (target, body, signal) => record(await channel.request(target.site, `${resource.apiRoot(target)}/notes`, signal, "POST", { body })),
		commentUrl: (row, target) => {
			resource.validateNote(row, target);
			return `${resource.url(target)}#note_${identity(row.id)}`;
		},
		askPrompt: (row) => `${row.message}\n\n问题编号：${row.id}\n请回复：answer ${row.id}: 你的回答`,
		skipReasons: ["project_unavailable"]
	};
}
function ingestPort() {
	return {
		channel: "gitlab",
		bots: async () => (await db.channelAccount.findByChannel("gitlab")).filter((account) => account.role === "bot"),
		actor: (row) => text(record(row.author).username),
		human: (row, bots) => {
			const author = record(row.author);
			const login = text(author.username);
			return author.bot !== true && row.system !== true && !bots.some((bot) => bot.name.toLowerCase() === login.toLowerCase());
		},
		body: (row) => typeof row.body === "string" ? row.body : typeof row.description === "string" ? row.description : typeof row.state === "string" ? row.state : "",
		url: (row, sourceKind, thread) => sourceKind === "note" ? `${thread.url}#note_${identity(row.id)}` : text(row.web_url),
		ref: (row) => typeof row.source_branch === "string" ? row.source_branch : null,
		at: (row, kind) => kind === "close" ? timestamp(row.closed_at ?? row.updated_at ?? row.created_at) : timestamp(row.created_at),
		createdAt: (row) => timestamp(row.created_at),
		mentioned: gitlabMentioned
	};
}
function answerPort(channel) {
	return {
		channel: "gitlab",
		admin: async (row) => {
			const author = record(row.author);
			const login = text(author.username);
			const accounts = await db.channelAccount.findByChannel("gitlab");
			if (author.bot === true || row.system === true || accounts.some((account) => account.role === "bot" && account.name.toLowerCase() === login.toLowerCase())) return false;
			return (await setting.load()).administrators.some((name) => name.toLowerCase() === login.toLowerCase());
		},
		parse: async (body) => resource.answers(body),
		scope: async (thread) => resource.source(resource.parse(thread.url, await channel.site()))
	};
}
// src/channel/gitlab/service/merge-request.ts
const mergeRequest = defineService({ async observe(remote, projectId, thread, row) {
	const target = resource.parse(thread.url, await remote.site());
	if (target.kind !== "pull") return;
	resource.validateTopic(row, target);
	const state = row.state === "merged" ? "merged" : row.state === "closed" ? "closed" : row.state === "opened" ? "open" : null;
	if (!state) throw new GitLabError("invalid_response");
	if (typeof row.title === "string" && row.title && thread.title !== row.title) await db.thread.setTitle(thread.id, row.title);
	for (const ticket of await db.ticket.listByPullRequest(projectId, thread.url)) {
		await db.ticketThread.link(ticket.id, thread.id, now());
		await db.ticket.setPullRequest(ticket.id, thread.url, state, ticket.ciState);
	}
	for (const ticketId of await db.ticketThread.listTicketIds(thread.id)) {
		const ticket = await db.ticket.findById(ticketId);
		if (!ticket || ticket.projectId !== projectId || ticket.prUrl !== thread.url || [
			"done",
			"completed",
			"cancelled"
		].includes(ticket.status)) continue;
		await db.ticket.setPullRequest(ticketId, thread.url, state, ticket.ciState);
	}
	if (state === "open") return;
	await remote.threadClosed(projectId, thread, state, timestamp(row.merged_at ?? row.closed_at ?? row.updated_at));
} });
// src/channel/gitlab/channel.ts
const INITIAL_CURSOR = { since: "1970-01-01T00:00:00.000Z" };
var GitLabChannel = class {
	runner;
	ports;
	constructor(runner = new FetchGitLabRunner()) {
		this.runner = runner;
		this.ports = binding.of(this);
	}
	async site() {
		await hosts.ready();
		return gitlabSite((await db.channel.findById("gitlab"))?.host ?? null);
	}
	async normalize(value) {
		return resource.url(resource.parse(value, await this.site()));
	}
	async readable(value) {
		try {
			await this.normalize(value);
			return true;
		} catch {
			return false;
		}
	}
	async request(site, path, signal, method = "GET", body) {
		signal?.throwIfAborted();
		return this.runner.request({
			site,
			path,
			method,
			body,
			signal
		});
	}
	async project(projectId) {
		const project$1 = (await project.list()).find((project) => project.id === projectId);
		if (!project$1 || !resource.remote(project$1.remoteUrl, await this.site())) throw new GitLabError("unknown_repository");
		if (!project$1.enabled) throw new GitLabError("project_disabled");
		if (project$1.available === false) throw new GitLabError("project_unavailable");
		return project$1;
	}
	/** 仓库唯一对应一个启用项目时返回它；没有项目或不止一个都不猜。 */
	async bindingProject(site, repository) {
		const projects = (await db.project.listAll()).filter((project) => project.enabled && resource.remote(project.remoteUrl, site)?.repository === repository);
		return projects.length === 1 ? projects[0].id : null;
	}
	async projectForRepository(repository) {
		const site = await this.site();
		const matches = (await project.list()).filter((project) => {
			const remote = resource.remote(project.remoteUrl, site);
			return remote && resource.source(remote) === repository && project.available !== false;
		});
		if (matches.length !== 1) throw new GitLabError(matches.length ? "ambiguous_repository" : "unknown_repository");
		return matches[0];
	}
	async scopeOf(project$2) {
		const current = "available" in project$2 ? project$2 : (await project.list()).find((row) => row.id === project$2.id);
		if (!current || current.available === false) return null;
		const target = resource.remote(current.remoteUrl, await this.site());
		return target ? resource.source(target) : null;
	}
	async probe(projectId, signal) {
		const project = await this.project(projectId);
		const channel = await db.channel.findById("gitlab");
		if (!channel?.enabled) throw new GitLabError("channel_disabled");
		const site = gitlabSite(channel.host);
		await hosts.ready();
		const target = resource.remote(project.remoteUrl, site);
		const bots = (await db.channelAccount.findByRole("gitlab", "bot")).filter((account) => account.status === "online");
		const account = record(await this.request(site, "user", signal));
		const providerId = identity(account.id);
		const login = text(account.username);
		if (!bots.some((bot) => bot.name.toLowerCase() === login.toLowerCase()) || account.state !== void 0 && account.state !== "active") throw new GitLabError("account_mismatch");
		const remote = record(await this.request(site, `projects/${encodeURIComponent(target.repository)}`, signal));
		const webUrl = text(remote.web_url);
		await hosts.learn(site, webUrl);
		if (text(remote.path_with_namespace) !== target.repository || resource.source(resource.remote(webUrl, site) ?? {
			site: "",
			repository: ""
		}) !== resource.source(target)) throw new GitLabError("repository_mismatch");
		const result = {
			providerId,
			login,
			repositoryId: identity(remote.id)
		};
		const previous = await courier.state("gitlab", resource.source(target), "verified_environment");
		if (previous && (previous.providerId !== providerId || previous.repositoryId !== result.repositoryId)) throw new GitLabError("environment_identity_changed");
		await courier.record("gitlab", resource.source(target), "verified_environment", result);
		return result;
	}
	async requestValue(site, path, signal, headers) {
		const value = await this.runner.request({
			site,
			method: "GET",
			path,
			withEtag: true,
			...headers ? { headers } : {},
			...signal ? { signal } : {}
		});
		return {
			body: value?.body ?? null,
			etag: value?.etag ?? null,
			notModified: value?.notModified === true
		};
	}
	async pages(site, path, signal, since, etag) {
		const stamp = since && /(?:^|\/)projects\/[^/]+\/(?:issues|merge_requests)(?:\?|$)/.test(path) ? `&updated_after=${encodeURIComponent(since)}` : "";
		return courier.pages(async (page) => {
			const url = `${path + (path.includes("?") ? "&" : "?")}per_page=100&page=${page}${stamp}`;
			const headers = page === 1 && etag ? { "if-none-match": etag } : void 0;
			const value = await this.requestValue(site, url, signal, headers);
			if (value.notModified) return {
				rows: [],
				notModified: true,
				etag: value.etag
			};
			return {
				rows: array(value.body).map(record),
				notModified: false,
				etag: value.etag
			};
		});
	}
	async read(value, offset = 0, limit = 50, signal) {
		const target = resource.parse(value, await this.site());
		const project = await this.projectForRepository(resource.source(target));
		await this.probe(project.id, signal);
		const main = record(await this.request(target.site, resource.apiRoot(target), signal));
		resource.validateTopic(main, target);
		const notes = (await this.pages(target.site, `${resource.apiRoot(target)}/notes?sort=asc&order_by=updated_at`, signal)).rows;
		const items = [resource.item(main, target.kind, target), ...notes.map((row) => resource.item(row, "comment", target)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))];
		return {
			...courier.page(items, offset, limit),
			next_resource: null
		};
	}
	async harvest(signal) {
		return courier.harvest(this.ports.collect, signal);
	}
	async collect(projectId, branch, signal) {
		return courier.collect(this.ports.collect, projectId, branch, signal);
	}
	async publish(inboxId, signal) {
		return courier.publish(this.ports.delivery, inboxId, signal);
	}
	async flush(signal) {
		return courier.flush(this.ports.delivery, signal);
	}
	advance(_cursor, _rows, startedAt) {
		return { since: cursorAt(startedAt) };
	}
	async collectProject(context, signal) {
		const site = await this.site();
		const scope = context.scope;
		const project = await this.project(context.projectId);
		const target = resource.remote(project.remoteUrl, site);
		if (!target) throw new GitLabError("unknown_repository");
		const repository = target.repository;
		const owner = await this.bindingProject(site, repository);
		if (owner) await bindThreads({
			channel: "gitlab",
			refPrefix: `${resource.source(target)}:`,
			projectId: owner
		});
		for (const kind of ["issue", "pull"]) await context.attempt(kind, async () => {
			await courier.stream({
				channel: "gitlab",
				scope,
				name: kind,
				initial: INITIAL_CURSOR,
				read: (cursor) => this.pages(site, `projects/${encodeURIComponent(repository)}/${kind === "issue" ? "issues" : "merge_requests"}?state=all&scope=all&order_by=updated_at&sort=asc`, signal, cursor.since, cursor.etag ?? void 0),
				advance: (cursor, rows, startedAt) => this.advance(cursor, rows, startedAt),
				accept: async (row) => {
					const resourceTarget = {
						site,
						repository,
						kind,
						number: number(row.iid)
					};
					resource.validateTopic(row, resourceTarget);
					const thread = await this.ensureThread(resourceTarget, row, owner);
					await courier.ingest(this.ports.ingest, thread, row, row.state === "closed" || row.state === "merged" ? "close" : "open", context.baseline, kind);
					if (kind === "pull") await mergeRequest.observe(this, context.projectId, thread, row);
				},
				signal
			});
		});
		for (const thread of await db.thread.listByChannel("gitlab")) {
			const url = thread.url;
			if (!url || !["issue", "pull"].includes(thread.kind)) continue;
			const ticketIds = await db.ticketThread.listTicketIds(thread.id);
			if (!await courier.polled(ticketIds, thread.updatedAt)) continue;
			await context.attempt(thread.refId, async () => {
				const threadTarget = resource.parse(url, site);
				if (threadTarget.repository !== repository) return;
				if (threadTarget.kind === "pull" && ticketIds.length) {
					const current = record(await this.request(site, resource.apiRoot(threadTarget), signal));
					await mergeRequest.observe(this, context.projectId, thread, current);
				}
				await courier.stream({
					channel: "gitlab",
					scope,
					name: `notes:${threadTarget.kind}:${threadTarget.number}`,
					initial: INITIAL_CURSOR,
					read: (cursor) => this.pages(site, `${resource.apiRoot(threadTarget)}/notes?sort=asc&order_by=updated_at`, signal, cursor.since, cursor.etag ?? void 0),
					advance: (cursor, rows, startedAt) => this.advance(cursor, rows, startedAt),
					accept: async (row) => {
						resource.validateNote(row, threadTarget);
						await courier.answers(this.ports.answer, thread, row);
						await courier.ingest(this.ports.ingest, thread, row, "comment", context.baseline, "note");
					},
					signal
				});
			});
		}
		const branch = await ci.defaultBranch(this, site, repository, signal);
		if (branch) await this.ciBranch(context, branch, signal);
		for (const ref of await ci.activeBranches(this, site, repository, signal)) {
			if (ref === branch) continue;
			await this.ciBranch(context, ref, signal);
		}
	}
	async ciBranch(context, branch, signal) {
		try {
			await ci.branch(this, context.projectId, branch, signal);
		} catch (error) {
			if (signal?.aborted) return;
			context.fail(error, `ci:${branch}`);
		}
	}
	async ensureThread(target, row, projectId) {
		return recordThread({
			channel: "gitlab",
			refId: `${resource.source(target)}:${target.kind}:${target.number}`,
			kind: target.kind,
			title: text(row.title),
			url: text(row.web_url),
			createdAt: timestamp(row.created_at),
			updatedAt: timestamp(row.updated_at),
			projectId
		});
	}
	async threadClosed(projectId, thread, outcome, at) {
		await closeThread({
			channel: "gitlab",
			projectId,
			thread,
			outcome,
			at,
			closeIssue: async (url) => {
				const target = resource.parse(url, await this.site());
				if (target.kind !== "issue") return;
				await this.request(target.site, resource.apiRoot(target), void 0, "PUT", { state_event: "close" });
			}
		});
	}
};
const gitlab = new GitLabChannel();
// src/ai/_shared/tools/channel.ts
const read_channel = defineTool({
	name: "read_channel",
	description: "读渠道原文，靠 resource 路径前缀分发。返回 { items, next_offset, next_resource }，两条翻页轴都要跟完。",
	parameters: {
		resource: {
			type: "string",
			required: true,
			description: "资源路径，前缀决定分发：github/…、gitlab/…、gitlab:<项目>:issue|pull:<编号>、渠道原文 URL、trigger/<id>、thread/<id>、ticket/<id>。"
		},
		offset: {
			type: "integer",
			description: "从上一次的 next_offset 续读；0 表示重读同一份快照的开头。"
		},
		limit: {
			type: "integer",
			description: "本次最多返回多少条；省略则用渠道默认值。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "本条资源的正文分片，末尾附 next_offset / next_resource。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		const offset = args.offset ?? 0;
		const limit = args.limit ?? 50;
		if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("offset 必须非负，limit 必须在 1–100");
		const resource = args.resource.startsWith("github/") ? `https://github.com/${args.resource.slice(7)}` : args.resource;
		const links = identity.role === "worker" && identity.ticketId ? await db.ticketThread.listByTicket(identity.ticketId) : [];
		const allowedThreads = new Set(links.map((link) => link.threadId));
		let items;
		let nextResource = null;
		if (resource.startsWith("trigger/")) {
			const trigger = await db.trigger.findById(resource.slice(8));
			if (!trigger) throw new Error("触发不存在");
			if (identity.role === "worker" && !allowedThreads.has(trigger.threadId)) throw new Error("Worker 只能读取本任务来源");
			await markThread(exec, trigger.threadId);
			items = [trigger];
		} else if (resource.startsWith("thread/")) {
			const thread = await db.thread.findById(resource.slice(7));
			if (!thread) throw new Error("话题不存在");
			if (identity.role === "worker" && !allowedThreads.has(thread.id)) throw new Error("Worker 只能读取本任务来源");
			await markThread(exec, thread.id);
			items = [thread];
			nextResource = thread.kind !== "ci" ? thread.url : null;
		} else if (await isThreadId(resource)) {
			const thread = await db.thread.findById(resource);
			if (identity.role === "worker" && !allowedThreads.has(thread.id)) throw new Error("Worker 只能读取本任务来源");
			await markThread(exec, thread.id);
			items = [thread];
			nextResource = thread.kind !== "ci" ? thread.url : null;
		} else if (resource.startsWith("ticket/")) {
			const ticket = await db.ticket.findById(resource.slice(7));
			if (!ticket) throw new Error("工单不存在");
			if (identity.role === "worker" && ticket.id !== identity.ticketId) throw new Error("Worker 只能读取本任务来源");
			const threads = await db.ticketThread.listByTicket(ticket.id);
			for (const link of threads) await markThread(exec, link.threadId);
			items = [ticket, ...threads.map((link) => ({ resource: `thread/${link.threadId}` }))];
		} else {
			const isGitHub = resource.startsWith("github:") || (() => {
				try {
					const url = new URL(resource);
					return url.origin === "https://github.com" && !url.username && !url.password;
				} catch {
					return false;
				}
			})();
			const isGitLab = !isGitHub && await gitlab.readable(resource);
			if (!isGitHub && !isGitLab) throw new Error("不支持的渠道资源");
			const adapter = isGitLab ? gitlab : github;
			const target = await adapter.normalize(resource);
			if (identity.role === "worker") {
				const threads = await Promise.all(links.map((link) => db.thread.findById(link.threadId)));
				let allowed = false;
				for (const thread of threads) {
					if (!thread?.url || thread.channelId !== (isGitLab ? "gitlab" : "github") || identity.projectId && thread.projectId && thread.projectId !== identity.projectId) continue;
					if (await adapter.readable(thread.url) && await adapter.normalize(thread.url) === target) allowed = true;
				}
				if (!allowed) throw new Error("Worker 只能读取本任务来源");
			}
			try {
				const matched = await db.thread.findByRef(isGitLab ? "gitlab" : "github", resource.replace(/^https?:\/\/[^/]+\//, "").replace(/\/pull\//, ":").replace(/\/issues\//, ":"));
				if (matched) await markThread(exec, matched.id);
			} catch {}
			return JSON.stringify(await adapter.read(target, offset, limit));
		}
		const page = items.slice(offset, offset + limit);
		return JSON.stringify({
			items: page,
			next_offset: offset + page.length < items.length ? offset + page.length : null,
			next_resource: nextResource
		});
	}
});
const reply_channel = defineTool({
	name: "reply_channel",
	description: "按触发在对应渠道发言。锚点是 triggerId，不用猜发到哪。排队成功不等于送达。",
	parameters: {
		triggerId: {
			type: "string",
			required: true,
			description: "要回复的那条触发 id；回复发到这条触发所在的渠道地址。"
		},
		text: {
			type: "string",
			required: true,
			description: "发言正文，像人话。渠道的上限由对应 skill 说明。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "入队结果，例如 queued 或具体状态。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		const trigger = await db.trigger.findById(args.triggerId);
		if (!trigger) throw new Error("触发不存在");
		const thread = await db.thread.findById(trigger.threadId);
		if (!thread || thread.kind === "ci" || !thread.url) throw new Error("该触发没有可回复地址");
		requireObserved(exec, thread.id, "reply");
		if (identity.role === "worker") {
			if (!identity.ticketId || !(await db.ticketThread.listByTicket(identity.ticketId)).some((row) => row.threadId === thread.id)) throw new Error("Worker 只能回复本任务来源");
			await db.ticket.requireOpen(identity.ticketId);
		}
		if (identity.role === "project" && thread.projectId !== identity.projectId) {
			if (!(await Promise.all((await db.ticketThread.listByThread(thread.id)).map((link) => db.ticket.findById(link.ticketId)))).some((ticket) => ticket?.projectId === identity.projectId)) throw new Error("触发不属于当前项目");
		}
		if (await db.inbox.repliedByOther(thread.id, trigger.id, identity.role)) return JSON.stringify({
			status: "suppressed",
			reason: "another_role_already_replied"
		});
		const subscribed = (await db.ticketThread.listTicketIds(thread.id)).length > 0;
		if (!addressedToBot({
			mentioned: Boolean(trigger.mentioned),
			subscribed
		})) throw new Error("这条消息没有 @ bot，也不是已订阅话题上的跟进：只做分诊记录，不对外发言");
		const ticketId = identity.ticketId ?? null;
		const row = await db.inbox.enqueue({
			id: replyKey(trigger.id, args.text),
			type: "user",
			origin: identity.role,
			kind: "notice",
			projectId: identity.projectId ?? thread.projectId,
			supervisorId: identity.supervisorId ?? null,
			workerId: identity.workerId ?? null,
			triggerId: trigger.id,
			threadId: thread.id,
			ticketId,
			message: args.text
		});
		return JSON.stringify({
			id: row.id,
			status: "queued"
		});
	}
});
// src/ai/_shared/tools/inbox.ts
const inbox_list = defineTool({
	name: "inbox_list",
	description: "读取当前角色未处理邮件和原渠道任务，包含 pending 和 stalled。读取标为已读但不会完成。",
	parameters: { detail: {
		type: "boolean",
		description: "true 返回完整上下文；默认返回摘要。"
	} },
	output: {
		schema: {
			type: "string",
			description: "当前角色未处理邮件。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const mailbox = await inbox.read(exec.agent?.session.id ?? "");
		return JSON.stringify(args.detail ? mailbox.messages : mailbox.messages.map((row) => ({
			id: row.id,
			kind: row.kind,
			summary: row.title ?? row.message.split("\n")[0].slice(0, 120)
		})));
	}
});
const read_mailbox = defineTool({
	name: "read_mailbox",
	description: "读取当前角色未处理邮件，以及可用项目的 id、仓库地址、归一化仓库名和本地路径。可传 ids 一次读取指定多条邮件。投递失败的对外回复也会出现在这里，可用 inbox_kill 放弃。渠道邮件带 trigger 事实（actor / human / mentioned / strength）和 thread 事实（triage / project / repository）：thread.project 是服务端按仓库匹配好的归属，为空表示没有启用项目对应这个仓库。strength=inferred 只是候选，只能分诊记录，不能建票；strength=self 是你自己开的 issue，可以直接建票。读取标为已读，处理完用 inbox_kill，ask 必须用 answer。",
	parameters: { ids: {
		type: "array",
		items: { type: "string" },
		description: "只读取这些邮件 id；省略则读取全部未处理邮件。"
	} },
	output: {
		schema: {
			type: "string",
			description: "完整角色邮箱，或所选邮件。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => JSON.stringify(await inbox.read(exec.agent?.session.id ?? "", args.ids))
});
const inbox_kill = defineTool({
	name: "inbox_kill",
	description: "将自己角色的邮件显式标为 done；未回答的 ask 不能跳过。",
	parameters: { ids: {
		type: "array",
		items: { type: "string" },
		required: true,
		description: "已处理邮件的 id。"
	} },
	output: {
		schema: {
			type: "string",
			description: "完成数量。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => String(await inbox.complete(exec.agent?.session.id ?? "", args.ids))
});
// src/ai/manager/tools/communicate.ts
const report$2 = defineTool({
	name: "report",
	description: "向上级报事实：状态 + 一句话摘要。发完继续，不等答复。",
	parameters: {
		state: {
			type: "string",
			enum: [
				"progress",
				"ready",
				"failed",
				"dropped"
			],
			required: true,
			description: "progress 在跑 / ready 干完了 / failed 失败了 / dropped 不用做了。"
		},
		summary: {
			type: "string",
			required: true,
			description: "一句话摘要。给机器和面板看，短。"
		},
		supervisorId: {
			type: "string",
			description: "本票在某个 Supervisor 下且进入终态时必须带，否则那边一直等。不带则报给主编排。"
		},
		ticketId: {
			type: "string",
			description: "只做溯源，写进 Inbox.ticketId，不参与路由。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "是否已投递。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		if (args.ticketId) {
			const ticket = await db.ticket.findById(args.ticketId);
			if (!ticket || ticket.projectId !== identity.projectId) throw new Error("工单不属于当前项目");
		}
		if (args.supervisorId && !await db.supervisor.findById(args.supervisorId)) throw new Error("Supervisor 不存在");
		return JSON.stringify(await db.inbox.enqueue({
			type: args.supervisorId ? "supervisor" : "main",
			projectId: identity.projectId,
			supervisorId: args.supervisorId ?? null,
			origin: "project",
			kind: "ticket",
			ticketId: args.ticketId ?? null,
			title: args.state,
			message: args.summary
		}));
	}
});
const ask$2 = defineTool({
	name: "ask",
	description: "向上级提问。发完这条工作线停下，答案到了会被 prompt 回来；会话本身继续处理别的票。",
	parameters: {
		question: {
			type: "string",
			required: true,
			description: "要上级回答的问题，一句话说清。"
		},
		supervisorId: {
			type: "string",
			description: "本票在某个 Supervisor 下时，问题直接进它，不再绕主编排。"
		},
		ticketId: {
			type: "string",
			description: "只做溯源，写进 Inbox.ticketId，不参与路由。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "ask 的 id 与投递去向。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		if (args.ticketId) await db.ticket.requireOpen(args.ticketId, identity.projectId);
		if (args.supervisorId && (await db.supervisor.findById(args.supervisorId))?.status !== "active") throw new Error("Supervisor 不存在或已关闭");
		return JSON.stringify(await db.inbox.enqueueAsk({
			type: args.supervisorId ? "supervisor" : "main",
			projectId: identity.projectId,
			supervisorId: args.supervisorId ?? null,
			origin: "project",
			kind: "ask",
			ticketId: args.ticketId ?? null,
			message: args.question
		}));
	}
});
const escalate = defineTool({
	name: "escalate",
	description: "把一条已有的 ask 原样上交：问题文本不改，就地改 type 换处理者。",
	parameters: { askId: {
		type: "string",
		required: true,
		description: "要上交的那条 ask 的 Inbox id。"
	} },
	output: {
		schema: {
			type: "string",
			description: "上交后的处理者。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		return JSON.stringify(await db.inbox.escalateScoped(args.askId, {
			type: "project",
			projectId: identity.projectId
		}, (/* @__PURE__ */ new Date()).toISOString()));
	}
});
// src/ai/manager/tools/supervisor.ts
const supervisor_list$1 = defineTool({
	name: "supervisor_list",
	description: "看 Supervisor：本项目相关的给明细，其余只给数量。",
	parameters: { status: {
		type: "string",
		enum: ["active", "closed"],
		description: "只看在协调中的或已收工的；省略表示只看 active。"
	} },
	output: {
		schema: {
			type: "string",
			description: "本项目那一张展开全部字段；其他 Supervisor 只给条数。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const rows = await db.supervisor.listByStatus(args.status ?? "active");
		const result = [];
		let others = 0;
		for (const row of rows) {
			const tickets = await Promise.all((await db.supervisorTicket.listBySupervisor(row.id)).map((link) => db.ticket.findById(link.ticketId)));
			if (tickets.some((ticket) => ticket?.projectId === identity.projectId)) result.push({
				...row,
				tickets
			});
			else others++;
		}
		return JSON.stringify({
			supervisors: result,
			others
		});
	}
});
// src/ai/manager/tools/ticket.ts
const list_ticket$2 = defineTool({
	name: "list_ticket",
	description: "列本项目的任务。判重时必看。",
	parameters: {
		status: {
			type: "string",
			enum: [
				"queued",
				"running",
				"idle",
				"review",
				"done",
				"completed",
				"cancelled"
			],
			description: "只看某个状态；省略表示不含已终态的票。"
		},
		attentionOnly: {
			type: "boolean",
			description: "true 时只返回存在指向它的 pending ask 的票。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "本项目任务列表：id、标题、状态、PR 状态、有无 pending ask。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		return JSON.stringify(await db.ticket.listFiltered({
			...args,
			projectId: identity.projectId
		}));
	}
});
const link_ticket$1 = defineTool({
	name: "link_ticket",
	description: "建一张工单到另一张工单的关联。限本项目；跨项目依赖由 Supervisor 的 link_dependency 记。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "发起关联的票，必须是本项目的。"
		},
		relatedId: {
			type: "string",
			required: true,
			description: "被指向的那张票。"
		},
		kind: {
			type: "string",
			enum: ["depends", "relates"],
			required: true,
			description: "depends 前置依赖：relatedId 没做完，ticketId 停在 queued。relates 只是相关，谁都不等谁。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "关联结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (identity?.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const ticket = await db.ticket.requireOpen(args.ticketId, identity.projectId);
		const related = await db.ticket.findById(args.relatedId);
		if (!related || related.projectId !== identity.projectId) throw new Error("跨项目关联应由 Supervisor 处理");
		if (ticket.id === related.id) throw new Error("工单不能关联自己");
		await db.ticketLink.link(ticket.id, related.id, args.kind, (/* @__PURE__ */ new Date()).toISOString());
		if (args.kind === "depends" && ![
			"done",
			"completed",
			"cancelled"
		].includes(related.status)) await db.ticket.setOpenStatus(ticket.id, "queued", (/* @__PURE__ */ new Date()).toISOString());
		return JSON.stringify({ linked: true });
	}
});
const stop_ticket = defineTool({
	name: "stop_ticket",
	description: "按人的明确要求结单为 cancelled。必须绑一条 human=true 的触发 —— 停止是人的决定，不是编排的判断。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "要停的票。"
		},
		triggerId: {
			type: "string",
			required: true,
			description: "人说停的那条触发。必须是 human=true，否则拒绝。"
		},
		reason: {
			type: "string",
			description: "一句话说明为什么停，写进记录。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "结单结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (identity?.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const ticket = await db.ticket.requireOpen(args.ticketId, identity.projectId);
		const trigger = await db.trigger.findById(args.triggerId);
		if (!trigger || trigger.human !== 1) throw new Error("停止工单必须绑定 human=true 的触发");
		if (!(await db.ticketThread.listByTicket(ticket.id)).some((row) => row.threadId === trigger.threadId)) throw new Error("停止触发不属于当前工单来源");
		const now = (/* @__PURE__ */ new Date()).toISOString();
		await db.ticket.finish(ticket.id, "cancelled", now, now);
		for (const worker of await db.worker.listByTicket(ticket.id)) {
			if (worker.status === "ended") continue;
			if (worker.status === "running") await session.cancel(worker.id).catch(() => void 0);
			await db.worker.end(worker.id, "stopped", (/* @__PURE__ */ new Date()).toISOString());
		}
		await worker$1.archiveSessions(ticket.id);
		await db.inbox.returnPendingTicket(ticket.id, args.reason ?? "人类要求停止", now);
		for (const link of await db.supervisorTicket.listByTicket(ticket.id)) await db.inbox.enqueue({
			type: "supervisor",
			supervisorId: link.supervisorId,
			projectId: ticket.projectId,
			origin: "project",
			kind: "ticket",
			ticketId: ticket.id,
			title: "dropped",
			message: args.reason ?? "人类要求停止"
		});
		return JSON.stringify({
			id: ticket.id,
			status: "cancelled"
		});
	}
});
const retry_ticket = defineTool({
	name: "retry_ticket",
	description: "重开卡住的票：结束旧 Worker，开一个新的。只对还开着、卡在 failed 的票有效。",
	parameters: { ticketId: {
		type: "string",
		required: true,
		description: "要重开的票。已到终态的票不适用 —— 那张只能由插件在人类消息到达时复活。"
	} },
	output: {
		schema: {
			type: "string",
			description: "重开结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (identity?.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const ticket = await db.ticket.requireOpen(args.ticketId, identity.projectId);
		const old = (await db.worker.listByTicket(ticket.id)).at(-1);
		if (!old || old.reportState !== "failed") throw new Error("只允许重试 failed Worker");
		if (old.status === "running") await session.cancel(old.id);
		await db.worker.end(old.id, "restarted", (/* @__PURE__ */ new Date()).toISOString());
		const worker = await db.worker.queue(ticket.id, identity.projectId, old.branch ?? void 0);
		if (old.branch && old.worktree) await db.worker.update(worker.id, {
			branch: old.branch,
			worktree: old.worktree
		});
		await worker$1.reconcile();
		return JSON.stringify(await db.worker.findById(worker.id));
	}
});
// src/ai/manager/tools/worker.ts
const create_worker = defineTool({
	name: "create_worker",
	description: "给一张票开 Worker：建 worktree、切分支、起会话一次配好。并发满了就让它留在 queued。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "要开跑的票，必须是本项目的。"
		},
		branch: {
			type: "string",
			required: true,
			description: "分支名称（英文）将会自动拼接为 dsh/[分支名称]"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "新 Worker 的 id、分支与 worktree 路径。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (identity?.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const worker = await db.worker.queue(args.ticketId, identity.projectId, `dsh/${args.branch}`);
		await worker$1.reconcile();
		return JSON.stringify(await db.worker.findById(worker.id));
	}
});
const send = defineTool({
	name: "send",
	description: "直接将完整消息交给活跃 Worker，跳过业务排队；只有需要立刻止损才用 interrupt。Worker 没有收件箱。票已结束不拦，Worker 还活着就能收到。",
	parameters: {
		workerId: {
			type: "string",
			required: true,
			description: "目标 Worker。"
		},
		text: {
			type: "string",
			required: true,
			description: "要说的话。"
		},
		mode: {
			type: "string",
			enum: [
				"queue",
				"interrupt",
				"reply"
			],
			required: true,
			description: "queue 在 Worker 运行中 steer 到最近一步，空闲时开新回合；interrupt 中止当前回合再 steer；reply 回答它的 ask，投递规则同 queue。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "投递结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (identity?.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const worker = await db.worker.findById(args.workerId);
		if (!worker) throw new Error("Worker 不存在");
		const ticket = await db.ticket.findById(worker.ticketId);
		if (!ticket || ticket.projectId !== identity.projectId) throw new Error("Worker 不属于当前项目");
		if (args.mode === "reply") {
			const asks = (await db.inbox.listByTicket(ticket.id)).filter((row) => row.workerId === worker.id && row.kind === "ask" && row.status === "pending");
			if (asks.length !== 1 || !db.inbox.owns(asks[0], {
				type: "project",
				projectId: identity.projectId
			})) throw new Error("reply 必须唯一对应当前项目编排待答的 ask");
			await db.inbox.answerScoped(asks[0].id, args.text, {
				type: "project",
				projectId: identity.projectId
			}, (/* @__PURE__ */ new Date()).toISOString());
			return JSON.stringify({
				askId: asks[0].id,
				delivery: "queued"
			});
		}
		if (worker.status === "ended") throw new Error("Worker 已结束");
		if (!await session.lookup(worker.id)) throw new Error("Worker 未在运行时加载、已归档或不属于 Supermesh；不能直接发送");
		const messageId = await session.send(worker.id, args.text, args.mode === "interrupt" ? "interrupt" : "wake");
		return JSON.stringify({ messageId });
	}
});
const view = defineTool({
	name: "view",
	description: "读 Worker 会话正文，分片返回。这不是 report —— report 是结构化状态通道。",
	parameters: {
		workerId: {
			type: "string",
			required: true,
			description: "要读的 Worker。"
		},
		offset: {
			type: "integer",
			description: "从上次的 next_offset 续读；0 表示从头读。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "会话正文分片，末尾附 next_offset。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (identity?.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const worker = await db.worker.findById(args.workerId);
		if (!worker || (await db.ticket.findById(worker.ticketId))?.projectId !== identity.projectId) throw new Error("Worker 不属于当前项目");
		if (args.offset !== void 0 && (!Number.isInteger(args.offset) || args.offset < 0)) throw new Error("offset 必须是非负整数");
		return JSON.stringify(await session.view(worker.id, args.offset));
	}
});
const cancel = defineTool({
	name: "cancel",
	description: "中断 Worker 当前回合：那一次回合作废，会话不结束，之后还能用 send 继续。票已结束也能停，只看 Worker 是否还活着。",
	parameters: {
		workerId: {
			type: "string",
			required: true,
			description: "要中止的 Worker。"
		},
		keepInbox: {
			type: "boolean",
			description: "true 保留官方 Agent 尚未接收的输入；省略则清除。不涉及业务收件箱。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "是否已受理。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (identity?.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const worker = await db.worker.findById(args.workerId);
		if (!worker) throw new Error("Worker 不存在");
		const ticket = await db.ticket.findById(worker.ticketId);
		if (!ticket || ticket.projectId !== identity.projectId) throw new Error("Worker 不属于当前项目");
		if (worker.status === "ended") throw new Error("Worker 已结束");
		await session.cancel(worker.id, args.keepInbox);
		return JSON.stringify({ accepted: true });
	}
});
const list_worker = defineTool({
	name: "list_worker",
	description: "列出本项目还没结束的 Worker 和当前回合状态。running 表示正在跑；inactive 表示没有回合在跑，可以 send 继续。",
	parameters: {},
	output: {
		schema: {
			type: "string",
			description: "Worker 列表：id、票号、标题、状态。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (_args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (identity?.role !== "project" || !identity.projectId) throw new Error("仅项目编排可调用");
		const rows = [];
		for (const ticket of await db.ticket.listByProject(identity.projectId)) {
			if ([
				"done",
				"completed",
				"cancelled"
			].includes(ticket.status)) continue;
			for (const worker of await db.worker.listByTicket(ticket.id)) {
				if (worker.status === "ended") continue;
				const agent = await session.lookup(worker.id);
				rows.push({
					id: worker.id,
					ticketId: ticket.id,
					title: ticket.title,
					status: agent?.status === "running" ? "running" : "inactive"
				});
			}
		}
		return JSON.stringify(rows);
	}
});
// src/ai/preset.ts
function definePreset(definition) {
	const { tools, ...preset } = definition;
	return {
		tools: tools ?? [],
		preset: {
			...preset,
			plugins: [preset.instruction && {
				id: "persona",
				name: "@deepseek-ai/dsh-persona",
				config: { prefix: preset.instruction }
			}, ...preset.plugins ?? []].filter(Boolean)
		}
	};
}
// src/ai/manager/index.ts
const manager = definePreset({
	id: "manager",
	name: "项目编排",
	description: "一个仓库一个：派 Worker、看汇报、收尾，任务走到哪一步由它推。不写代码。",
	instruction: composePrompt("manager"),
	order: 5,
	tools: [
		read_channel,
		reply_channel,
		read_mailbox,
		inbox_list,
		inbox_kill,
		report$2,
		ask$2,
		escalate,
		supervisor_list$1,
		list_ticket$2,
		link_ticket$1,
		stop_ticket,
		retry_ticket,
		create_worker,
		send,
		view,
		cancel,
		list_worker
	],
	plugins: [
		agentInstructions,
		compaction,
		commandGoal,
		skillFilesystem,
		timeContext,
		toolBash,
		toolRegistryPtc,
		toolFs,
		toolFsSearch,
		toolJobs,
		toolPresent,
		toolPwsh,
		toolSkill,
		toolTodo,
		toolWeb
	]
});
// src/ai/_shared/tools/communicate.ts
const answer = defineTool({
	name: "answer",
	description: "回答下面升上来的 ask：填 answer，标 status=done，答案由投递队列送回发起方。Worker 这一轮已结束也会被重新拉起；会话已归档才改投项目编排。",
	parameters: {
		askId: {
			type: "string",
			required: true,
			description: "要回答的那条 ask 的 Inbox id。"
		},
		text: {
			type: "string",
			required: true,
			description: "答案正文。发起方会原样收到。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "答案 id、状态与投递去向。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role === "worker") throw new Error("Worker 没有收件箱");
		const scope = identity.role === "project" && identity.projectId ? {
			type: "project",
			projectId: identity.projectId
		} : identity.role === "supervisor" && identity.supervisorId ? {
			type: "supervisor",
			supervisorId: identity.supervisorId
		} : identity.role === "main" ? { type: "main" } : null;
		if (!scope) throw new Error("会话身份不完整");
		await db.inbox.answerScoped(args.askId, args.text, scope, (/* @__PURE__ */ new Date()).toISOString());
		return JSON.stringify({
			id: args.askId,
			status: "done",
			delivery: "queued"
		});
	}
});
// src/ai/_shared/tools/ticket.ts
const dispatch_ticket = defineTool({
	name: "dispatch_ticket",
	description: "把票派给它的项目编排：写一条 Inbox(type=project, kind=ticket)。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "要派下去的票。归属由票自己决定，不用另外传项目。"
		},
		message: {
			type: "string",
			description: "附带给该项目编排的话。派新票时可省；只是提醒或调整时，写清楚要它做什么 —— 只说场景和约束，不要附实现方案。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "派工结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main" && identity.role !== "supervisor") throw new Error("仅主编排或 Supervisor 可派票");
		const ticket = await db.ticket.requireOpen(args.ticketId);
		if (identity.role === "supervisor" && !(await db.supervisorTicket.listBySupervisor(identity.supervisorId)).some((row) => row.ticketId === ticket.id)) throw new Error("工单不属于当前 Supervisor");
		return JSON.stringify(await db.inbox.enqueue({
			type: "project",
			projectId: ticket.projectId,
			supervisorId: identity.supervisorId ?? null,
			origin: identity.role,
			kind: "ticket",
			ticketId: ticket.id,
			message: args.message ?? ticket.title
		}));
	}
});
const note_ticket = defineTool({
	name: "note_ticket",
	description: "把在别处得到的事实告诉这张票的项目编排：只传信息，不给授权，不改任何状态。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "要通知的票。消息进它所属项目编排的收件箱。"
		},
		text: {
			type: "string",
			required: true,
			description: "要说的事实，一句话，例如「A 把接口改成了 Y」。只说发生了什么，不要写成任务要求或实现建议。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "投递结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main" && identity.role !== "supervisor") throw new Error("仅主编排或 Supervisor 可通知项目");
		const ticket = await db.ticket.findById(args.ticketId);
		if (!ticket) throw new Error("工单不存在");
		if (identity.role === "supervisor" && !(await db.supervisorTicket.listBySupervisor(identity.supervisorId)).some((row) => row.ticketId === ticket.id)) throw new Error("工单不属于当前 Supervisor");
		return JSON.stringify(await db.inbox.enqueue({
			type: "project",
			projectId: ticket.projectId,
			supervisorId: identity.supervisorId ?? null,
			origin: identity.role,
			kind: "notice",
			ticketId: ticket.id,
			message: args.text
		}));
	}
});
// src/ai/orchestrator/tools/communicate.ts
const ask_user = defineTool({
	name: "ask_user",
	description: "问人。只有主编排能问 —— 它是唯一能触达人类的一层。",
	parameters: {
		question: {
			type: "string",
			required: true,
			description: "要人回答的问题。写成人类听得懂的一句话，不要带技术黑话。"
		},
		triggerId: {
			type: "string",
			description: "问题发到哪个渠道；给了就锚在这条触发上，省略则只留在面板里。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "ask 的 id 与投递去向。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const trigger = args.triggerId ? await db.trigger.findById(args.triggerId) : null;
		if (args.triggerId && !trigger) throw new Error("触发不存在");
		const thread = trigger ? await db.thread.findById(trigger.threadId) : null;
		if (trigger && (!thread || thread.kind === "ci" || !thread.url)) throw new Error("该触发没有可回复地址");
		const pending = (await db.inbox.listPendingAsk()).find((row) => row.origin === "main" && row.message === args.question && row.triggerId === (args.triggerId ?? null));
		if (pending) return JSON.stringify({
			id: pending.id,
			status: "pending",
			delivery: pending.triggerId ? "queued" : "panel"
		});
		const row = await db.inbox.enqueueAsk({
			type: "user",
			origin: "main",
			kind: "ask",
			triggerId: trigger?.id ?? null,
			threadId: thread?.id ?? null,
			projectId: thread?.projectId ?? null,
			message: args.question
		});
		return JSON.stringify({
			id: row.id,
			status: "pending",
			delivery: row.triggerId ? "queued" : "panel"
		});
	}
});
// src/ai/orchestrator/tools/supervisor.ts
const supervisor_list = defineTool({
	name: "supervisor_list",
	description: "列全部 Supervisor，字段完整：标题、原因、状态、关联工单、各自进度。",
	parameters: { status: {
		type: "string",
		enum: ["active", "closed"],
		description: "只看在协调中的或已收工的；省略表示只看 active。"
	} },
	output: {
		schema: {
			type: "string",
			description: "Supervisor 列表，含 title / reason / status / 关联工单。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const rows = await db.supervisor.listByStatus(args.status ?? "active");
		return JSON.stringify(await Promise.all(rows.map(async (row) => ({
			...row,
			tickets: await Promise.all((await db.supervisorTicket.listBySupervisor(row.id)).map((link) => db.ticket.findById(link.ticketId)))
		}))));
	}
});
const create_supervisor = defineTool({
	name: "create_supervisor",
	description: "跨项目时拉起一个临时协调者：建记录并起会话，把双方上下文写进开场。",
	parameters: {
		title: {
			type: "string",
			required: true,
			description: "一句话说明它在协调什么，例如「T-105 需要 B/x 配合」。"
		},
		reason: {
			type: "string",
			required: true,
			description: "为什么拉起来，写清卡在哪，方便事后回溯。"
		},
		ticketIds: {
			type: "array",
			items: { type: "string" },
			required: true,
			description: "它协调的那几张票，通常每个项目一张。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "新 Supervisor 的 id 与关联工单。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const ticketIds = [...new Set(args.ticketIds)];
		if (!ticketIds.length) throw new Error("至少需要一张工单");
		const tickets = await Promise.all(ticketIds.map((id) => db.ticket.requireOpen(id)));
		const id = randomUUID();
		const now = (/* @__PURE__ */ new Date()).toISOString();
		await db.supervisor.create({
			id,
			title: args.title,
			reason: args.reason,
			status: "active",
			sessionId: null,
			createdAt: now,
			closedAt: null
		});
		for (const ticketId of ticketIds) await db.supervisorTicket.link(id, ticketId, now);
		const sessionId = await session.create("supervisor", {
			supervisorId: id,
			title: args.title
		});
		await db.supervisor.attachSession(id, sessionId);
		await db.inbox.enqueue({
			type: "supervisor",
			supervisorId: id,
			origin: "main",
			kind: "notice",
			title: args.title,
			message: JSON.stringify({
				title: args.title,
				reason: args.reason,
				tickets
			})
		});
		await inbox.notify(await session.activate(sessionId));
		return JSON.stringify({
			id,
			sessionId,
			ticketIds
		});
	}
});
const close_supervisor = defineTool({
	name: "close_supervisor",
	description: "关掉 Supervisor：status=closed，关联工单退回各自项目编排。reason 会原样进每个持票项目编排的收件箱。",
	parameters: {
		supervisorId: {
			type: "string",
			required: true,
			description: "要关掉的 Supervisor。"
		},
		reason: {
			type: "string",
			required: true,
			description: "为什么关。会原样进每个关联工单所属项目编排的收件箱 —— 它们要凭这句话决定那几张票接下来怎么办。写清是「做完了」还是「不做了、各自收摊」。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "关闭结果，含通知到哪几个项目编排。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const row = await db.supervisor.findById(args.supervisorId);
		if (!row) throw new Error("Supervisor 不存在");
		if (row.status === "closed") return JSON.stringify({
			id: row.id,
			status: "closed",
			notified: []
		});
		const tickets = await Promise.all((await db.supervisorTicket.listBySupervisor(row.id)).map((link) => db.ticket.findById(link.ticketId)));
		const projects = [...new Set(tickets.flatMap((ticket) => ticket ? [ticket.projectId] : []))];
		for (const projectId of projects) await db.inbox.enqueue({
			id: `supervisor-close:${row.id}:${projectId}`,
			type: "project",
			projectId,
			supervisorId: row.id,
			origin: "main",
			kind: "notice",
			title: row.title,
			message: `${args.reason}\n${tickets.filter((ticket) => ticket?.projectId === projectId).map((ticket) => ticket.id).join(", ")}`
		});
		await db.supervisor.close(row.id, (/* @__PURE__ */ new Date()).toISOString());
		if (row.sessionId) await archive.session(row.sessionId);
		return JSON.stringify({
			id: row.id,
			status: "closed",
			notified: projects
		});
	}
});
const attach_tickets_to_supervisor = defineTool({
	name: "attach_tickets_to_supervisor",
	description: "扩大 Supervisor 的范围：加关联工单，并自动通知该项目编排。",
	parameters: {
		supervisorId: {
			type: "string",
			required: true,
			description: "要扩范围的 Supervisor。"
		},
		ticketIds: {
			type: "array",
			items: { type: "string" },
			required: true,
			description: "要加进去的票。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "扩范围结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const row = await db.supervisor.findById(args.supervisorId);
		if (!row || row.status !== "active") throw new Error("Supervisor 不存在或已关闭");
		const tickets = await Promise.all([...new Set(args.ticketIds)].map((id) => db.ticket.requireOpen(id)));
		const existing = await db.supervisorTicket.listBySupervisor(row.id);
		const added = tickets.filter((ticket) => !existing.some((link) => link.ticketId === ticket.id));
		for (const ticket of added) await db.supervisorTicket.link(row.id, ticket.id, (/* @__PURE__ */ new Date()).toISOString());
		for (const projectId of new Set(added.map((ticket) => ticket.projectId))) await db.inbox.enqueue({
			type: "project",
			projectId,
			supervisorId: row.id,
			origin: "main",
			kind: "notice",
			title: row.title,
			message: `加入 Supervisor ${row.id}: ${added.filter((ticket) => ticket.projectId === projectId).map((ticket) => ticket.id).join(", ")}`
		});
		return JSON.stringify({ attached: added.map((ticket) => ticket.id) });
	}
});
const detach_tickets_from_supervisor = defineTool({
	name: "detach_tickets_from_supervisor",
	description: "缩小 Supervisor 的范围：去掉关联工单，退回原项目，并自动通知该项目编排。**不取消** —— 取消是人的决定。",
	parameters: {
		supervisorId: {
			type: "string",
			required: true,
			description: "要缩范围的 Supervisor。"
		},
		ticketIds: {
			type: "array",
			items: { type: "string" },
			required: true,
			description: "要退回原项目的票。"
		},
		reason: {
			type: "string",
			required: true,
			description: "为什么摘出来。会进退回票所属项目编排的收件箱 —— 它要凭这句话知道那张票现在归谁管、还要不要继续等。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "缩范围结果，含通知到哪几个项目编排。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const row = await db.supervisor.findById(args.supervisorId);
		if (!row) throw new Error("Supervisor 不存在");
		const existing = await db.supervisorTicket.listBySupervisor(row.id);
		const ids = [...new Set(args.ticketIds)].filter((id) => existing.some((link) => link.ticketId === id));
		const tickets = await Promise.all(ids.map((id) => db.ticket.findById(id)));
		for (const ticketId of ids) await db.supervisorTicket.unlink(row.id, ticketId);
		for (const projectId of new Set(tickets.flatMap((ticket) => ticket ? [ticket.projectId] : []))) await db.inbox.enqueue({
			type: "project",
			projectId,
			supervisorId: row.id,
			origin: "main",
			kind: "notice",
			title: row.title,
			message: `${args.reason}\n${tickets.filter((ticket) => ticket?.projectId === projectId).map((ticket) => ticket.id).join(", ")}`
		});
		return JSON.stringify({ detached: ids });
	}
});
// src/ai/orchestrator/tools/thread.ts
const triage_thread = defineTool({
	name: "triage_thread",
	description: "给一条还没票跟着的话题定归属。判一次就固定，之后不再打扰主编排。",
	parameters: {
		threadId: {
			type: "string",
			required: true,
			description: "话题 id，形如 github:42 或 feishu:<chat>:<root>。"
		},
		action: {
			type: "string",
			enum: ["claim", "ignore"],
			required: true,
			description: "claim 归给某个项目；ignore 判为不用处理，之后不投递，除非有人又 @ 了我们。"
		},
		projectId: {
			type: "string",
			description: "action=claim 时必给：话题归哪个项目。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "写入后的 triage 结论。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const thread = await db.thread.findById(args.threadId);
		if (!thread) throw new Error("话题不存在");
		if ((await db.ticketThread.listByThread(thread.id)).length) throw new Error("已有工单订阅的话题不能分诊");
		if (thread.triage !== "pending") throw new Error("话题已分诊");
		if (args.action === "claim") {
			if (!args.projectId || !await db.project.findById(args.projectId)) throw new Error("claim 必须指定存在的 projectId");
			await db.thread.claim(thread.id, args.projectId, (/* @__PURE__ */ new Date()).toISOString());
		} else await db.thread.ignore(thread.id, (/* @__PURE__ */ new Date()).toISOString());
		return JSON.stringify(await db.thread.findById(thread.id));
	}
});
const attach_thread_to_ticket = defineTool({
	name: "attach_thread_to_ticket",
	description: "让一张已有的票接管一条新话题：建订阅并投递。跨项目也走它。只有消息明确指向那张票才挂。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "接管这条话题的票。已被人叫停（cancelled）的票挂不上。"
		},
		threadId: {
			type: "string",
			required: true,
			description: "要挂上去的话题 id。"
		},
		note: {
			type: "string",
			description: "一句话路由背景或人给的约束，不要写实现建议，也不要复述原文。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "挂载结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const ticket = await db.ticket.findById(args.ticketId);
		if (!ticket || ticket.status === "cancelled") throw new Error("工单不存在或已 cancelled");
		const thread = await db.thread.findById(args.threadId);
		if (!thread) throw new Error("话题不存在");
		if ((await db.ticketThread.listByTicket(ticket.id)).some((row) => row.threadId === thread.id)) return JSON.stringify({
			linked: true,
			existing: true
		});
		if (!await db.ticketThread.link(ticket.id, thread.id, (/* @__PURE__ */ new Date()).toISOString())) return JSON.stringify({
			linked: true,
			existing: true
		});
		if (thread.kind === "pull" && thread.url && !ticket.prUrl) await db.ticket.save(ticket.id, { prUrl: thread.url });
		await db.inbox.enqueue({
			type: "project",
			projectId: ticket.projectId,
			origin: "main",
			kind: "ticket",
			ticketId: ticket.id,
			threadId: thread.id,
			message: args.note ?? thread.title
		});
		return JSON.stringify({ linked: true });
	}
});
const unlink_thread = defineTool({
	name: "unlink_thread",
	description: "摘掉挂错的话题，和 attach 严格对称：只删订阅一行，不动话题归属。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "要摘掉订阅的票。"
		},
		threadId: {
			type: "string",
			required: true,
			description: "要摘掉的话题 id。这张票的触发来源那条不许摘。"
		},
		reason: {
			type: "string",
			required: true,
			description: "一句话说明为什么不相关，写进记录供回溯。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "摘除结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		if (!await db.ticket.findById(args.ticketId)) throw new Error("工单不存在");
		const links = await db.ticketThread.listByTicket(args.ticketId);
		if (links[0]?.threadId === args.threadId) throw new Error("不能摘掉触发来源话题");
		if (!links.some((row) => row.threadId === args.threadId)) throw new Error("订阅不存在");
		await db.ticketThread.unlink(args.ticketId, args.threadId);
		const ticket = await db.ticket.findById(args.ticketId);
		await db.inbox.enqueue({
			type: "project",
			projectId: ticket.projectId,
			origin: "main",
			kind: "notice",
			ticketId: ticket.id,
			threadId: args.threadId,
			message: args.reason
		});
		return JSON.stringify({ unlinked: true });
	}
});
// src/ai/orchestrator/tools/ticket.ts
const create_ticket$1 = defineTool({
	name: "create_ticket",
	description: "开一张票。任务一旦存在，projectId 就必须确定。没 @ bot 的触发只是 inferred 候选，inferred 模式不是 auto 时会被拒绝；strength 为 self（你自己开的 issue）不是 inferred，不受这条限制。",
	parameters: {
		title: {
			type: "string",
			required: true,
			description: "一句话说清要做什么，用发起方的语言。不要加需求、验收标准或实现建议。"
		},
		projectId: {
			type: "string",
			required: true,
			description: "这张票归哪个项目。"
		},
		threadIds: {
			type: "array",
			items: { type: "string" },
			required: true,
			description: "触发这张票的话题，至少一条。最早那条是「触发来源」。"
		},
		description: {
			type: "string",
			description: "需求正文，没有就省略。"
		},
		triggerId: {
			type: "string",
			description: "引起这张票的触发，取邮件里的 triggerId。省略时按 threadIds 里最新的一条触发判准入强度。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "新票的 id 和状态。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		const admission = await latestTriggerStrength(args.threadIds, args.triggerId);
		if (admission && !ticketAllowed(admission.strength, (await setting.load()).inferred)) throw new Error(`触发 ${admission.triggerId} 没有 @ bot，只是 inferred 候选，当前 inferred 模式不是 auto：只能做分诊记录，不能建票。要开工请让人 @ bot 一次，或在设置里把 inferred 改成 auto。你自己开的 issue 强度是 self，不走这条限制。`);
		return JSON.stringify(await db.ticket.createWithThreads(args.projectId, args.title, args.threadIds, args.description));
	}
});
const list_ticket$1 = defineTool({
	name: "list_ticket",
	description: "列全部任务，可跨项目筛选。判重、找某张票的现状都靠它。",
	parameters: {
		status: {
			type: "string",
			enum: [
				"queued",
				"running",
				"idle",
				"review",
				"done",
				"completed",
				"cancelled"
			],
			description: "只看某个状态；省略表示不含已终态的票。"
		},
		projectId: {
			type: "string",
			description: "只看某个项目的票。省略表示所有项目。"
		},
		attentionOnly: {
			type: "boolean",
			description: "true 时只返回存在指向它的 pending ask 的票 —— 也就是需要人介入的那些。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "任务列表，每张票一行：id、项目、标题、状态、PR 状态、有无 pending ask。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "main") throw new Error("仅主编排可调用");
		return JSON.stringify(await db.ticket.listFiltered(args));
	}
});
// src/ai/orchestrator/index.ts
const orchestrator = definePreset({
	id: "orchestrator",
	name: "主编排",
	instruction: composePrompt("orchestrator"),
	order: 4,
	tools: [
		read_channel,
		reply_channel,
		answer,
		read_mailbox,
		inbox_list,
		inbox_kill,
		ask_user,
		supervisor_list,
		create_supervisor,
		close_supervisor,
		attach_tickets_to_supervisor,
		detach_tickets_from_supervisor,
		list_ticket$1,
		create_ticket$1,
		dispatch_ticket,
		note_ticket,
		triage_thread,
		attach_thread_to_ticket,
		unlink_thread
	],
	plugins: [
		agentInstructions,
		compaction,
		commandGoal,
		skillFilesystem,
		timeContext,
		toolBash,
		toolRegistryPtc,
		toolFs,
		toolFsSearch,
		toolJobs,
		toolPresent,
		toolPwsh,
		toolSkill,
		toolTodo,
		toolWeb
	]
});
// src/ai/supervisor/tools/index.ts
const list_ticket = defineTool({
	name: "list_ticket",
	description: "列自己关联的工单及其进度。每次醒来先看它 —— 不要只信收件箱里那一条转述。",
	parameters: {},
	output: {
		schema: {
			type: "string",
			description: "关联工单：id、项目、状态、prState、有无 pending ask。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "supervisor" || !identity.supervisorId) throw new Error("仅 Supervisor 可调用");
		const links = await db.supervisorTicket.listBySupervisor(identity.supervisorId);
		return JSON.stringify(await Promise.all(links.map(async (link) => {
			const ticket = await db.ticket.findById(link.ticketId);
			if (!ticket) throw new Error("关联工单不存在");
			return {
				...ticket,
				attention: (await db.inbox.listByTicket(ticket.id)).some((row) => row.kind === "ask" && row.status === "pending")
			};
		})));
	}
});
const create_ticket = defineTool({
	name: "create_ticket",
	description: "在某个项目下开一张票。工单会自动挂到你这个 supervisor 下，受你协调。",
	parameters: {
		title: {
			type: "string",
			required: true,
			description: "一句话说清要做什么，用发起方的语言。不要加需求、验收标准或实现建议。"
		},
		projectId: {
			type: "string",
			required: true,
			description: "这张票归哪个项目。"
		},
		threadIds: {
			type: "array",
			items: { type: "string" },
			required: true,
			description: "触发这张票的话题，至少一条。最早那条是「触发来源」。"
		},
		description: {
			type: "string",
			description: "需求正文，没有就省略。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "新票的 id 和状态。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "supervisor" || !identity.supervisorId) throw new Error("仅 Supervisor 可调用");
		if (!args.threadIds.length) throw new Error("建票至少要有一条来源话题");
		for (const threadId of args.threadIds) if (!await db.thread.findById(threadId)) throw new Error("来源话题不存在");
		const project = await db.project.findById(args.projectId);
		if (!project) throw new Error("项目不存在");
		if (!project.enabled) throw new Error("项目未启用");
		const ticket = await db.ticket.createWithThreads(args.projectId, args.title, args.threadIds, args.description);
		await db.supervisorTicket.link(identity.supervisorId, ticket.id, (/* @__PURE__ */ new Date()).toISOString());
		return JSON.stringify({
			id: ticket.id,
			status: ticket.status
		});
	}
});
const link_dependency_ticket = defineTool({
	name: "link_dependency_ticket",
	description: "记一条跨项目前置依赖。方向是「后来的指向先要做的」。别只记在脑子里 —— 你随时可能被重启。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "要等的那张票。"
		},
		dependsOn: {
			type: "string",
			required: true,
			description: "必须先做完的那张票。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "依赖记录结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "supervisor" || !identity.supervisorId) throw new Error("仅 Supervisor 可调用");
		const tickets = await Promise.all([args.ticketId, args.dependsOn].map((id) => db.ticket.findById(id)));
		if (tickets.some((ticket) => !ticket)) throw new Error("工单不存在");
		await requireScope(identity.supervisorId, tickets.map((ticket) => ticket.projectId));
		await db.ticket.requireOpen(args.ticketId);
		if (args.ticketId === args.dependsOn) throw new Error("工单不能依赖自己");
		await db.ticketLink.link(args.ticketId, args.dependsOn, "depends", (/* @__PURE__ */ new Date()).toISOString());
		return JSON.stringify({ linked: true });
	}
});
const link_ticket = defineTool({
	name: "link_ticket",
	description: "记一条相关性关联：两张票有关，但谁都不等谁。限你协调范围内的项目之间。",
	parameters: {
		ticketId: {
			type: "string",
			required: true,
			description: "发起关联的票。"
		},
		relatedId: {
			type: "string",
			required: true,
			description: "被指向的那张票。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "关联结果。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "supervisor" || !identity.supervisorId) throw new Error("仅 Supervisor 可调用");
		if (args.ticketId === args.relatedId) throw new Error("工单不能关联自己");
		const tickets = await Promise.all([args.ticketId, args.relatedId].map((id) => db.ticket.findById(id)));
		if (tickets.some((ticket) => !ticket)) throw new Error("工单不存在");
		await requireScope(identity.supervisorId, tickets.map((ticket) => ticket.projectId));
		await db.ticketLink.link(args.ticketId, args.relatedId, "relates", (/* @__PURE__ */ new Date()).toISOString());
		return JSON.stringify({
			linked: true,
			kind: "relates"
		});
	}
});
/** 票所属项目必须落在这个 supervisor 的协调范围内（即它已关联票涉及的项目）。 */
async function requireScope(supervisorId, projectIds) {
	const links = await db.supervisorTicket.listBySupervisor(supervisorId);
	const tickets = await Promise.all(links.map((link) => db.ticket.findById(link.ticketId)));
	const scope = new Set(tickets.filter(Boolean).map((ticket) => ticket.projectId));
	for (const projectId of projectIds) if (!scope.has(projectId)) throw new Error("该项目还不在你的协调范围内：先用 create_ticket 在那个项目建票，票会自动挂到名下并带上它的项目");
}
const report$1 = defineTool({
	name: "report",
	description: "报给主编排，不等答复。",
	parameters: {
		state: {
			type: "string",
			enum: [
				"progress",
				"ready",
				"failed",
				"dropped"
			],
			required: true,
			description: "progress 在跑 / ready 做完了 / failed 失败了 / dropped 不用做了。"
		},
		summary: {
			type: "string",
			required: true,
			description: "一句话摘要。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "是否已投递。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "supervisor" || !identity.supervisorId) throw new Error("仅 Supervisor 可调用");
		return JSON.stringify(await db.inbox.enqueue({
			type: "main",
			supervisorId: identity.supervisorId,
			origin: "supervisor",
			kind: "notice",
			title: args.state,
			message: args.summary
		}));
	}
});
const ask$1 = defineTool({
	name: "ask",
	description: "问主编排，这条线停下等答复。要加人、加项目、或需要上级拍板时用它。",
	parameters: { question: {
		type: "string",
		required: true,
		description: "要主编排回答的问题，一句话说清。"
	} },
	output: {
		schema: {
			type: "string",
			description: "ask 的 id。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "supervisor" || !identity.supervisorId) throw new Error("仅 Supervisor 可调用");
		return JSON.stringify(await db.inbox.enqueueAsk({
			type: "main",
			supervisorId: identity.supervisorId,
			origin: "supervisor",
			kind: "ask",
			message: args.question
		}));
	}
});
// src/ai/supervisor/index.ts
const supervisor = definePreset({
	id: "supervisor",
	name: "临时协调者",
	instruction: composePrompt("supervisor"),
	order: 6,
	tools: [
		read_channel,
		answer,
		read_mailbox,
		inbox_list,
		inbox_kill,
		dispatch_ticket,
		note_ticket,
		list_ticket,
		report$1,
		ask$1,
		link_dependency_ticket,
		link_ticket,
		create_ticket
	],
	plugins: [
		agentInstructions,
		compaction,
		commandGoal,
		skillFilesystem,
		timeContext,
		toolBash,
		toolRegistryPtc,
		toolFs,
		toolFsSearch,
		toolJobs,
		toolPresent,
		toolPwsh,
		toolSkill,
		toolTodo,
		toolWeb
	]
});
// src/ai/worker/tools/index.ts
const report = defineTool({
	name: "report",
	description: "报告进度。发完继续干活，不等回复。要对方动脑子的走 ask。",
	parameters: {
		state: {
			type: "string",
			enum: [
				"progress",
				"ready",
				"failed",
				"dropped"
			],
			required: true,
			description: "progress 在跑 / ready 干完了（有 PR 就进 review，没有就正常完成）/ failed 失败了 / dropped 不用做了。「我在等答复」不占状态位。"
		},
		summary: {
			type: "string",
			required: true,
			description: "一句话摘要，短。给机器和面板看，详细解释写正文。"
		}
	},
	output: {
		schema: {
			type: "string",
			description: "是否已记录。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "worker" || !identity.workerId || !identity.ticketId) throw new Error("仅 Worker 可调用");
		const worker = await db.worker.findById(identity.workerId);
		if (!worker || worker.status === "ended") throw new Error("Worker 已结束");
		await db.worker.reportProgress(worker.id, args.state, args.summary);
		return JSON.stringify({
			recorded: true,
			state: args.state
		});
	}
});
const ask = defineTool({
	name: "ask",
	description: "问项目编排。发完这条工作线停下，等答案被 prompt 回来。不要一边问一边继续做。",
	parameters: { question: {
		type: "string",
		required: true,
		description: "要问的问题，一句话说清卡在哪。"
	} },
	output: {
		schema: {
			type: "string",
			description: "ask 的 id。"
		},
		render: (_args, value) => [{
			type: "text",
			text: value
		}]
	},
	execute: async (args, exec) => {
		const identity = await session.resolve(exec.agent?.session.id ?? "");
		if (!identity) throw new Error("当前会话没有 Supermesh 身份");
		if (identity.role !== "worker" || !identity.workerId || !identity.ticketId) throw new Error("仅 Worker 可调用");
		const ticket = await db.ticket.requireOpen(identity.ticketId);
		const worker = await db.worker.findById(identity.workerId);
		if (!worker || worker.status === "ended") throw new Error("Worker 已结束");
		return JSON.stringify(await db.inbox.enqueueAsk({
			type: "project",
			projectId: ticket.projectId,
			origin: "worker",
			kind: "ask",
			ticketId: ticket.id,
			workerId: worker.id,
			message: args.question
		}));
	}
});
// src/ai/index.ts
const agents = {
	manager,
	orchestrator,
	supervisor,
	worker: definePreset({
		id: "worker",
		name: "执行会话",
		instruction: composePrompt("worker"),
		order: 7,
		tools: [
			read_channel,
			report,
			ask
		],
		plugins: [
			agentInstructions,
			compaction,
			commandGoal,
			delegation,
			skillFilesystem,
			timeContext,
			toolBash,
			toolRegistryPtc,
			toolFs,
			toolFsSearch,
			toolJobs,
			toolPresent,
			toolPwsh,
			toolSkill,
			toolTodo,
			toolWeb
		]
	})
};
// src/events/agent-created.ts
async function handleAgentCreated(ctx, agent) {
	const id = ctx.agentPresets.composedPreset(agent.ctx);
	const definition = agents[id];
	if (definition?.tools.length) ctx.effect(() => agent.ctx.effect(() => {
		const disposers = definition.tools.map((tool) => agent.ctx.tools.register(tool));
		return () => disposers.forEach((dispose) => dispose());
	}, "supermesh:tools"), "supermesh:agent-tools");
	const role = await session.attach(agent);
	if (!role) return;
	if (role === "worker") return;
	ctx.effect(() => agent.ctx.on("agent/status", ({ status }) => {
		if (status === "idle") inbox.notify(agent).catch((error) => ctx.logger.error(error));
	}), "supermesh:mailbox-notice");
	await inbox.notify(agent);
}
// src/service/forge.evidence.ts
/** 只有这两个工具会把命令交给 shell，证据也只从它们的调用与结果里取。 */
const SHELL_TOOLS = /* @__PURE__ */ new Set(["bash", "pwsh"]);
const CREATE = /\b(?:glab(?:-\w+)?\s+mr\s+(?:create|new)|gh(?:-\w+)?\s+pr\s+(?:create|new))\b/;
const PUSH = /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b/;
const TARGET = /^To (\S+)$/;
const REF = /^ [ +*=] (\[[^\]]+\]|\S+) +\S+ -> (\S+)(?: \(.*\))?$/;
const CHANGE_REQUEST_URL = /\bhttps?:\/\/[^\s"'<>]+?\/(?:merge_requests|pull)\/\d+(?![\w-])/g;
/**
* 读 `git push` 输出里被推上去的分支。每条引用行归属最近一条 `To <remote>`，
* 被拒绝、被删除的引用和新标签不算 —— 它们不会开出变更请求。
*/
function pushedBranches(text) {
	const pushed = [];
	let remote;
	for (const line of text.split(/\r?\n/)) {
		const target = TARGET.exec(line);
		if (target) {
			remote = target[1];
			continue;
		}
		const ref = REF.exec(line);
		if (!remote || !ref) continue;
		const [, summary = "", destination = ""] = ref;
		if (summary === "[new tag]") continue;
		const branch = destination.startsWith("refs/heads/") ? destination.slice(11) : destination;
		if (branch.startsWith("refs/")) continue;
		if (!pushed.some((entry) => entry.remote === remote && entry.branch === branch)) pushed.push({
			remote,
			branch
		});
	}
	return pushed;
}
/** 取命令输出里的变更请求地址，保持首次出现的顺序。 */
function changeRequestUrls(text) {
	return [...new Set(text.match(CHANGE_REQUEST_URL) ?? [])];
}
/**
* 从会话日志里取属于这个仓库的 GitHub 证据：`gh pr create` 打印的 PR 地址，
* 以及推到这个仓库的分支。官方 forge-session 投影只认 `tool/call` 里的
* `bash` / `pwsh`，Worker 在程序模式下用 `run_code` 调 shell 时它一条都看不到，
* 所以 GitHub 与 GitLab 共用同一份 shell 证据。
*
* @param events - Worker 会话的完整事件。
* @param repository - 项目仓库全名，小写 `owner/name`。
*/
function githubEvidence(events, repository) {
	const evidence = shellEvidence(events);
	const pushed = evidence.branches.flatMap((entry) => {
		const remote = resource$1.of(entry.remote);
		return remote === null ? [] : [{
			entry,
			remote
		}];
	});
	return {
		urls: evidence.urls.filter((url) => pullRepositoryOf(url) === repository),
		branches: pushed.filter((item) => item.remote === repository).map((item) => item.entry),
		forks: pushed.filter((item) => item.remote !== repository).map((item) => item.entry)
	};
}
function pullRepositoryOf(url) {
	try {
		const target = resource$1.parse(url);
		return target.kind === "pull" ? target.repository : null;
	} catch {
		return null;
	}
}
/**
* 从会话日志里取 Worker 自己留下的开单证据：`glab mr create` / `gh pr create`
* 打印的地址，以及 `git push` 推上去的分支。只认工具调用本身成功的结果。
*
* 两种调用形态都要认，Worker 换模式时不能丢绑定：
* - 标准模式：模型直接调 `pwsh` / `bash`，命令在 `tool/call` 里；
* - 程序模式：模型在 `run_code` 里调 `tools.pwsh(...)`，命令在 `tool/ptc-dispatch` 里。
*/
function shellEvidence(events) {
	const pending = /* @__PURE__ */ new Map();
	const urls = [];
	const branches = [];
	for (const event of events) {
		if (event.type === "turn/end") {
			pending.clear();
			continue;
		}
		const call = shellCall(event);
		if (call) {
			if (!SHELL_TOOLS.has(call.name)) continue;
			const creates = CREATE.test(call.command);
			const pushes = PUSH.test(call.command);
			if (!creates && !pushes) continue;
			const previous = pending.get(call.key);
			pending.set(call.key, {
				urls: creates || Boolean(previous?.urls),
				pushes: pushes || Boolean(previous?.pushes)
			});
			continue;
		}
		if (event.type !== "tool/result") continue;
		const { message } = event.data;
		const evidence = pending.get(message.toolCallId);
		if (!evidence) continue;
		pending.delete(message.toolCallId);
		if (message.isError === true) continue;
		const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		if (evidence.urls) urls.push(...changeRequestUrls(text));
		if (evidence.pushes) branches.push(...pushedBranches(text));
	}
	return {
		urls: [...new Set(urls)],
		branches: branches.filter((entry, index) => branches.findIndex((other) => other.remote === entry.remote && other.branch === entry.branch) === index)
	};
}
/** 直接调用的 shell 工具（标准模式）与 run_code 里程序化调用的同一个工具（程序模式）都算一次 shell 调用。 */
function shellCall(event) {
	if (event.type === "tool/call") {
		const command = commandOf(event.data.arguments);
		return command === void 0 ? null : {
			key: event.data.callId,
			name: event.data.name,
			command
		};
	}
	if (event.type === "tool/ptc-dispatch") {
		const command = commandOf(event.data.arguments);
		return command === void 0 ? null : {
			key: event.data.rootCallId,
			name: event.data.name,
			command
		};
	}
	return null;
}
function commandOf(raw) {
	let parsed = raw;
	if (typeof raw === "string") try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return void 0;
	const command = parsed.command;
	return typeof command === "string" ? command : void 0;
}
// src/service/forge.ts
/** 已经补挂过的票：同一个运行时里不重复读会话日志。 */
const reconciled = /* @__PURE__ */ new Set();
/** 确认过不是 Worker 的会话：主编排、项目编排的每条工具结果都查一次库没有意义。 */
const outsiders = /* @__PURE__ */ new Set();
const forge = defineService({
	/**
	* Worker 会话里出现开单证据时把变更请求挂到票上。
	* 分支名是模型的自由发挥，不能当唯一依据；这里读的是会话自己的 shell 结果。
	*/
	async observe(source, event) {
		if (event.type !== "tool/result" && event.type !== "turn/end") return;
		if (outsiders.has(source.id)) return;
		try {
			const worker = await db.worker.findById(source.id);
			if (!worker) {
				outsiders.add(source.id);
				return;
			}
			const ticket = await db.ticket.findById(worker.ticketId);
			if (!ticket || ticket.prUrl || [
				"done",
				"completed",
				"cancelled"
			].includes(ticket.status)) return;
			const project = await db.project.findById(ticket.projectId);
			if (!project?.enabled) return;
			reconciled.add(ticket.id);
			await attach(ticket, await evidenceOf(source, project, ticket, event.type === "turn/end", true));
		} catch (error) {
			getServerContext(server).logger.warn("supermesh: forge binding failed for %s: %s", source.id, error instanceof Error ? error.message : String(error));
		}
	},
	/** 补挂历史票：Worker 早就开过 PR，但当时没挂上。每个运行时每张票只补一次。 */
	async reconcile() {
		for (const ticket of await db.ticket.listOpen()) {
			if (ticket.prUrl || reconciled.has(ticket.id)) continue;
			if (ticket.status !== "idle" && ticket.status !== "review") continue;
			reconciled.add(ticket.id);
			const worker = (await db.worker.listByTicket(ticket.id)).at(-1);
			const project = await db.project.findById(ticket.projectId);
			if (!worker || !project?.enabled) continue;
			const source = await session.instance(worker.id);
			if (!source) continue;
			try {
				await attach(ticket, await evidenceOf(source, project, ticket, true, false));
			} catch (error) {
				getServerContext(server).logger.warn("supermesh: forge backfill failed for %s: %s", ticket.id, error instanceof Error ? error.message : String(error));
			}
		}
	}
});
/** 回合结束才回读整份会话日志；只有活着的会话才值得让官方按分支反查。 */
async function evidenceOf(source, project, ticket, settled, live) {
	if (ticket.channelId === "github") return githubUrls(source, project, settled, live);
	if (ticket.channelId === "gitlab" && settled) return gitlabUrls(source, project);
	return [];
}
/**
* GitHub 走官方 forge-session：绑定来自会话自己的 `gh pr create`、`gh pr view` 等
* 命令结果，以及推送后按分支反查到的打开状态 PR。官方投影只认 `tool/call` 里的
* `bash` / `pwsh`，Worker 在程序模式下用 `run_code` 调 shell 时它看不到，
* 所以再叠一份会话自己的 shell 证据；官方绑定在前，仍是权威来源。
*/
async function githubUrls(source, project, settled, live) {
	const service = getServerContext(server).forgeSession;
	const repository = project.remoteUrl ? resource$1.of(project.remoteUrl) : null;
	const evidence = settled && repository ? githubEvidence((await session.history(source.id)).events, repository) : {
		urls: [],
		branches: [],
		forks: []
	};
	if (live && service) for (const entry of evidence.branches) await service.discoverBranch(source, entry.remote, entry.branch);
	const official = service ? service.changeRequests(source).map((entry) => entry.url).filter((url) => githubRepositoryOf(url) === repository) : [];
	const urls = [.../* @__PURE__ */ new Set([...official, ...evidence.urls])];
	if (urls.length || !repository) return urls;
	for (const entry of [...evidence.branches, ...evidence.forks]) {
		const head = resource$1.of(entry.remote);
		if (!head) continue;
		for (const url of await openPullRequests(repository, head.split("/")[0], entry.branch).catch(() => [])) if (!urls.includes(url)) urls.push(url);
	}
	return urls;
}
/** 按 head 分支查这个仓库里打开的 PR：push 之后没走 create 命令时，绑定只能靠这一步。 */
async function openPullRequests(repository, owner, branch) {
	const rows = await github.pages(`repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
	const urls = [];
	for (const row of rows) {
		if (text(row.state) !== "open" || text(record(row.head).ref) !== branch) continue;
		const url = text(row.html_url);
		if (githubRepositoryOf(url) === repository && !urls.includes(url)) urls.push(url);
	}
	return urls;
}
function githubRepositoryOf(url) {
	try {
		return resource$1.parse(url).repository;
	} catch {
		return null;
	}
}
/**
* GitLab 没有官方 provider，按同一套证据自己做：`glab mr create` 打印的地址，
* 以及 `git push` 之后按源分支反查到的打开状态 MR。
*/
async function gitlabUrls(source, project) {
	const site = await gitlab.site();
	const scope = await gitlab.scopeOf(project).catch(() => null);
	if (!scope) return [];
	const { events } = await session.history(source.id);
	const evidence = shellEvidence(events);
	const urls = evidence.urls.filter((url) => gitlabScopeOf(url, site) === scope);
	const branches = new Set(evidence.branches.map((entry) => entry.branch));
	for (const name of branches) for (const url of await openMergeRequests(site, scope, name)) if (!urls.includes(url)) urls.push(url);
	return urls;
}
function gitlabScopeOf(url, site) {
	try {
		return resource.source(resource.parse(url, site));
	} catch {
		return null;
	}
}
async function openMergeRequests(site, scope, branch) {
	const repository = scope.slice(site.length + 1);
	if (!repository) return [];
	const { rows } = await gitlab.pages(site, `projects/${encodeURIComponent(repository)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`);
	const urls = [];
	for (const row of rows) {
		if (row.state !== "opened" || row.source_branch !== branch || typeof row.web_url !== "string") continue;
		if (gitlabScopeOf(row.web_url, site) === scope) urls.push(row.web_url);
	}
	return urls;
}
/** 挂票并订阅 PR 话题：采集只轮询有票订阅的 PR，不建这条链接就永远等不到状态与结单。 */
async function attach(ticket, urls) {
	for (const url of urls) {
		const current = await db.ticket.findById(ticket.id);
		if (!current || current.prUrl) return;
		const threadId = await ensureThread(current, url);
		if (!threadId) continue;
		await db.ticketThread.link(current.id, threadId, now());
		await db.ticket.save(current.id, { prUrl: url });
	}
}
async function ensureThread(ticket, url) {
	if (ticket.channelId === "github") {
		const target = resource$1.parse(url);
		const refId = `${target.repository}:${target.number}`;
		const existing = await db.thread.findByRef("github", refId);
		if (existing) return existing.id;
		const at = now();
		return (await db.thread.record({
			id: `github:${refId}`,
			channelId: "github",
			refId,
			kind: "pull",
			title: `PR #${target.number}`,
			url: `https://github.com/${target.repository}/pull/${target.number}`,
			createdAt: at,
			updatedAt: at,
			projectId: ticket.projectId,
			triage: "claimed",
			triagedAt: at
		})).id;
	}
	if (ticket.channelId === "gitlab") {
		const target = resource.parse(url, await gitlab.site());
		const refId = `${resource.source(target)}:${target.kind}:${target.number}`;
		const existing = await db.thread.findByRef("gitlab", refId);
		if (existing) return existing.id;
		const at = now();
		return (await db.thread.record({
			id: `gitlab:${refId}`,
			channelId: "gitlab",
			refId,
			kind: "pull",
			title: `MR !${target.number}`,
			url: resource.url(target),
			createdAt: at,
			updatedAt: at,
			projectId: ticket.projectId,
			triage: "claimed",
			triagedAt: at
		})).id;
	}
	return null;
}
// src/events/session-event.ts
async function handleSessionEvent(source, event) {
	await forge.observe(source, event);
	await worker$1.observe(source, event);
}
// src/runtime/scheduler.ts
const RESERVED_KEYS = /* @__PURE__ */ new Set([
	"id",
	"cron",
	"status",
	"cronSource",
	"createdAt",
	"updatedAt",
	"lastRunAt",
	"lastError",
	"runCount",
	"hasHandler",
	"nextRunAt"
]);
const nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
const messageOf = (err) => err instanceof Error ? err.message : String(err);
function parseId(val) {
	if (typeof val === "string" && val.trim()) return val.trim();
	throw new TypeError("定时任务的 id 不能为空");
}
const refId = (ref) => parseId(typeof ref === "string" ? ref : ref.id);
function parseCron(val, id) {
	const cron = typeof val === "string" ? val.trim() : "";
	if (!cron) throw new TypeError(`定时任务 "${id}" 的 cron 不能为空`);
	try {
		new Cron(cron, { paused: true }).stop();
	} catch (e) {
		throw new Error(`定时任务 "${id}" 的 cron 表达式无效：${cron}`, { cause: e });
	}
	return cron;
}
function pickExtra(input) {
	const extra = {};
	for (const [k, v] of Object.entries(input)) if (v !== void 0 && !RESERVED_KEYS.has(k)) extra[k] = v;
	return extra;
}
var JsonSchedulerImpl = class {
	filePath;
	options;
	records = /* @__PURE__ */ new Map();
	hydration;
	pending = Promise.resolve();
	saveError;
	disposed = false;
	constructor(filePath, options = {}) {
		this.filePath = resolve(filePath);
		this.options = options;
		this.hydration = this.load();
	}
	ready = () => this.hydration;
	use(input, handler) {
		if (typeof handler !== "function") throw new TypeError("use() 的第二个参数必须是函数");
		const id = parseId(input.id);
		const cron = parseCron(input.cron, id);
		const extra = pickExtra(input);
		let record = this.records.get(id);
		if (record) {
			if (record.cronSource === "use") record.cron = cron;
			record.handler = handler;
			Object.assign(record.extra, extra);
			record.updatedAt = nowIso();
		} else {
			const time = nowIso();
			record = {
				id,
				cron,
				status: "running",
				cronSource: "use",
				createdAt: time,
				updatedAt: time,
				lastRunAt: null,
				lastError: null,
				runCount: 0,
				extra,
				handler
			};
			this.records.set(id, record);
		}
		this.arm(record);
		this.queueSave();
		return () => this.remove(id);
	}
	update(patch) {
		const record = this.records.get(parseId(patch.id));
		if (!record) return false;
		if (patch.cron !== void 0) {
			record.cron = parseCron(patch.cron, record.id);
			record.cronSource = "update";
		}
		Object.assign(record.extra, pickExtra(patch));
		record.updatedAt = nowIso();
		if (patch.cron !== void 0) this.arm(record);
		this.queueSave();
		return true;
	}
	remove(ref) {
		const record = this.records.get(refId(ref));
		if (!record) return false;
		this.disarm(record);
		this.records.delete(record.id);
		this.queueSave();
		return true;
	}
	async trigger(ref) {
		const record = this.records.get(refId(ref));
		if (!record) throw new Error(`定时任务 "${refId(ref)}" 不存在`);
		if (!record.handler) throw new Error(`定时任务 "${record.id}" 还没有绑定回调`);
		await this.run(record, "manual");
	}
	stop(ref) {
		return this.setStatus(refId(ref), "paused");
	}
	start(ref) {
		return this.setStatus(refId(ref), "running");
	}
	stopAll() {
		this.setAllStatus("paused");
	}
	startAll() {
		this.setAllStatus("running");
	}
	jobs() {
		return [...this.records.values()].map((r) => ({
			...r.extra,
			id: r.id,
			cron: r.cron,
			status: r.status,
			hasHandler: Boolean(r.handler),
			nextRunAt: r.status === "running" ? r.job?.nextRun()?.toISOString() ?? null : null,
			lastRunAt: r.lastRunAt,
			lastError: r.lastError,
			runCount: r.runCount,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt
		}));
	}
	async flush() {
		await this.pending;
		const err = this.saveError;
		if (err !== void 0) {
			this.saveError = void 0;
			throw err;
		}
	}
	async dispose() {
		this.disposed = true;
		for (const r of this.records.values()) this.disarm(r);
		await this.pending;
	}
	setStatus(id, status) {
		const record = this.records.get(id);
		if (!record || record.status === status) return Boolean(record);
		record.status = status;
		record.updatedAt = nowIso();
		status === "paused" ? this.disarm(record) : this.arm(record);
		this.queueSave();
		return true;
	}
	setAllStatus(status) {
		let changed = false;
		for (const record of this.records.values()) if (record.status !== status) {
			record.status = status;
			record.updatedAt = nowIso();
			status === "paused" ? this.disarm(record) : this.arm(record);
			changed = true;
		}
		if (changed) this.queueSave();
	}
	arm(record) {
		this.disarm(record);
		if (this.disposed || !record.handler || record.status === "paused") return;
		try {
			record.job = new Cron(record.cron, {
				protect: this.options.protect ?? true,
				unref: this.options.unref ?? false,
				timezone: this.options.timezone,
				catch: true
			}, () => this.run(record, "schedule"));
		} catch (e) {
			record.lastError = messageOf(e);
			this.report(e, {
				phase: "run",
				id: record.id
			});
		}
	}
	disarm(record) {
		record.job?.stop();
		record.job = void 0;
	}
	async run(record, reason) {
		const startedAt = /* @__PURE__ */ new Date();
		record.lastRunAt = startedAt.toISOString();
		try {
			await record.handler({
				id: record.id,
				cron: record.cron,
				reason,
				startedAt,
				job: this.jobs().find((j) => j.id === record.id)
			});
			record.lastError = null;
		} catch (e) {
			record.lastError = messageOf(e);
			if (reason === "manual") throw e;
			this.report(e, {
				phase: "run",
				id: record.id
			});
		} finally {
			record.runCount++;
		}
	}
	report(error, context) {
		if (this.options.onError) {
			try {
				this.options.onError(error, context);
			} catch {}
			return;
		}
		console.error(`[json-scheduler] ${context.phase} 失败${context.id ? `（${context.id}）` : ""}:`, error);
	}
	queueSave() {
		this.pending = this.pending.then(() => this.write()).then(() => {
			this.saveError = void 0;
		}).catch((e) => {
			this.saveError = e;
			this.report(e, { phase: "save" });
		});
	}
	async write() {
		const payload = {
			version: 1,
			updatedAt: nowIso(),
			jobs: [...this.records.values()].map((r) => ({
				...r.extra,
				id: r.id,
				cron: r.cron,
				status: r.status,
				cronSource: r.cronSource,
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
				lastRunAt: r.lastRunAt,
				lastError: r.lastError,
				runCount: r.runCount
			}))
		};
		await mkdir(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await rename(tmp, this.filePath);
	}
	async load() {
		let raw;
		try {
			raw = await readFile(this.filePath, "utf8");
		} catch (e) {
			if (e?.code === "ENOENT") return;
			throw e;
		}
		if (!raw.trim()) return;
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed) ? parsed : parsed?.jobs ?? [];
		for (const stored of list) {
			if (!stored || typeof stored !== "object") continue;
			const id = typeof stored.id === "string" ? stored.id.trim() : "";
			const cron = typeof stored.cron === "string" ? stored.cron.trim() : "";
			if (!id || !cron) continue;
			const status = stored.status === "paused" ? "paused" : "running";
			const cronSource = stored.cronSource === "update" ? "update" : "use";
			const extra = pickExtra(stored);
			let existing = this.records.get(id);
			if (!existing) {
				const time = typeof stored.createdAt === "string" ? stored.createdAt : nowIso();
				existing = {
					id,
					cron,
					status,
					cronSource,
					createdAt: time,
					updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : time,
					lastRunAt: stored.lastRunAt ?? null,
					lastError: stored.lastError ?? null,
					runCount: stored.runCount ?? 0,
					extra
				};
				this.records.set(id, existing);
			} else {
				existing.status = status;
				existing.cronSource = cronSource;
				if (cronSource === "update") existing.cron = cron;
				Object.assign(existing.extra, {
					...extra,
					...existing.extra
				});
			}
		}
		for (const r of this.records.values()) if (r.handler) this.arm(r);
	}
};
const scheduler = new JsonSchedulerImpl(join(DSH_PLUGIN_HOME, "jobs.json"));
await scheduler.ready();
// src/service/runtime.ts
let starting = null;
let dispose = null;
const runtime = defineService({ start() {
	if (dispose) return Promise.resolve(dispose);
	if (starting) return starting;
	starting = activate().finally(() => {
		starting = null;
	});
	return starting;
} });
async function closeFinishedSupervisors() {
	for (const supervisor of await db.supervisor.listActive()) {
		const tickets = await Promise.all((await db.supervisorTicket.listBySupervisor(supervisor.id)).map((link) => db.ticket.findById(link.ticketId)));
		if (!tickets.length || tickets.some((ticket) => !ticket || ![
			"done",
			"completed",
			"cancelled"
		].includes(ticket.status))) continue;
		if ((await db.inbox.listPending("supervisor", null)).some((message) => message.supervisorId === supervisor.id)) continue;
		await db.supervisor.close(supervisor.id, (/* @__PURE__ */ new Date()).toISOString());
		if (supervisor.sessionId) {
			await session.stop(supervisor.sessionId).catch(() => void 0);
			await archive.session(supervisor.sessionId);
		}
	}
}
async function activate() {
	const controller = new AbortController();
	const pending = /* @__PURE__ */ new Set();
	const unregister = [];
	const stops = [];
	let restoreShell;
	let closing = null;
	const close = () => {
		if (closing) return closing;
		closing = (async () => {
			controller.abort(/* @__PURE__ */ new Error("runtime_stopped"));
			for (const remove of unregister) remove();
			await Promise.allSettled(stops.map((stop) => stop()));
			await Promise.allSettled([...pending]);
			await restoreShell?.();
			dispose = null;
		})();
		return closing;
	};
	function track(action) {
		if (controller.signal.aborted) return Promise.resolve();
		const task = Promise.resolve().then(action).finally(() => pending.delete(task));
		pending.add(task);
		return task;
	}
	try {
		stops.push(() => devops.cleanup());
		stops.push(session.start(), worktree.start(), project.start(), inbox.start(), worker$1.start());
		await scheduler.ready();
		await session.workspace();
		if (await session.findMain()) await session.create("main", {});
		await project.sync();
		restoreShell = await shell.start();
		await worker$1.recover();
		unregister.push(scheduler.use({
			id: "supermesh:runtime",
			cron: "* * * * * *"
		}, () => track(async () => {
			await worker$1.rescue();
			await worker$1.reconcileBackground();
			await inbox.deliverAnswers();
			await inbox.deliver();
			await worker$1.reconcile();
			await forge.reconcile();
			await closeFinishedSupervisors();
		})));
		unregister.push(scheduler.use({
			id: "supermesh:projects",
			cron: "*/5 * * * * *"
		}, () => track(async () => {
			await project.sync();
			await shell.refresh();
		})));
		unregister.push(scheduler.use({
			id: "supermesh:github",
			cron: "*/30 * * * * *"
		}, () => track(async () => {
			await project.sync();
			const failures = (await github.harvest?.(controller.signal) ?? []).filter((result) => !result.ok);
			if (failures.length) throw new Error(failures.map((result) => result.reason ?? "channel_operation_failed").join(", "));
		})));
		unregister.push(scheduler.use({
			id: "supermesh:github:flush",
			cron: "*/10 * * * * *"
		}, () => track(async () => {
			const failures = (await github.flush(controller.signal)).filter((result) => !result.ok);
			if (failures.length) throw new Error(failures.map((result) => result.reason ?? "channel_operation_failed").join(", "));
		})));
		unregister.push(scheduler.use({
			id: "supermesh:gitlab",
			cron: "*/30 * * * * *"
		}, () => track(async () => {
			const failures = (await gitlab.harvest?.(controller.signal) ?? []).filter((result) => !result.ok);
			if (failures.length) throw new Error(failures.map((result) => result.reason ?? "channel_operation_failed").join(", "));
		})));
		unregister.push(scheduler.use({
			id: "supermesh:gitlab:flush",
			cron: "*/10 * * * * *"
		}, () => track(async () => {
			const failures = (await gitlab.flush(controller.signal)).filter((result) => !result.ok);
			if (failures.length) throw new Error(failures.map((result) => result.reason ?? "channel_operation_failed").join(", "));
		})));
		dispose = close;
		return close;
	} catch (error) {
		await close();
		throw error;
	}
}
// src/service/skill.ts
const skill = defineService({
	roots() {
		return [join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "skills")].filter((path) => existsSync(path));
	},
	async install(ctx) {
		const roots = skill.roots();
		if (!roots.length) return () => void 0;
		const fiber = ctx.plugin(await import("@deepseek-ai/dsh-skill-filesystem"), { customSkillDirs: roots });
		return () => void fiber.dispose();
	}
});
// src/index.ts
const inject = [
	"agents",
	"agentPresets",
	"sessionController",
	"workspaceRegistry",
	"sessionQuery",
	"credentials",
	"connection",
	"webServer",
	"worktrees",
	"forgeSession"
];
async function apply(ctx) {
	await ctx.effect(async function* () {
		for (const definition of Object.values(agents)) {
			yield await ctx.agentPresets.register(definition.preset);
			yield session.register(definition.preset.id);
		}
	}, "supermesh:presets");
	ctx.on("agent/created", ({ agent }) => handleAgentCreated(ctx, agent));
	ctx.on("session/event", handleSessionEvent);
	await ctx.effect(() => server(ctx, {
		origin: ctx.webServer.getOrigin(),
		owner: (event) => {
			const admission = ctx.connection.admit({ headers: event.req.headers });
			return !("rejection" in admission) && admission.peer.principal.kind === "owner";
		}
	}), "supermesh:routes");
	await ctx.effect(() => runtime.start(), "supermesh:runtime");
	await ctx.effect(() => skill.install(ctx), "supermesh:skills");
}
export { apply, inject };
