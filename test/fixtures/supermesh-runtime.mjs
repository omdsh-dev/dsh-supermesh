import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const installationManifest = pathToFileURL(join(process.env.DSH_INSTALL_DIR, 'package.json'))
const require = createRequire(installationManifest)
const installationModules = new URL('../../', installationManifest).href
let resolving = false
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && !context.parentURL?.startsWith(installationModules) && !resolving) {
      resolving = true
      try {
        return nextResolve(pathToFileURL(require.resolve(specifier)).href, context)
      }
      finally {
        resolving = false
      }
    }
    return nextResolve(specifier, context)
  },
})

const { register } = await import('tsx/esm/api')
register()
const { Context } = await import('@deepseek-ai/cordis')
const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const { WebServer } = await import('@deepseek-ai/dsh-host-webserver')
const { SessionId } = await import('@deepseek-ai/dsh-session')
const { server } = await import('@/server/index.ts')
const { session } = await import('@/service/session.ts')
const { inbox } = await import('@/service/inbox.ts')
const { db } = await import('@/database/index.ts')
const { storage } = await import('@/storage/index.ts')
const { handleAgentCreated } = await import('@/events/agent-created.ts')
const { handleSessionEvent } = await import('@/events/session-event.ts')
const { project: projects } = await import('@/service/project.ts')
const { worker: workers } = await import('@/service/worker.ts')
const { worktree } = await import('@/service/worktree.ts')
const git = promisify(execFile)
const roles = ['orchestrator', 'manager', 'supervisor', 'worker']
const pluginHome = join(process.env.DSH_HOME, '.supermesh')
const agentDirectory = join(pluginHome, 'workspace')
const now = new Date().toISOString()
const caseName = process.argv[2]
// 只有需要真实工作树的用例才挂官方 worktree 服务：其余用例保持最小装配，
// 免得沙箱策略等新服务改变它们正在验证的行为。
const worktreeCases = new Set(['workerDispatchWorktree', 'workerDispatchFailure', 'workerRedispatch'])
let runtime

async function start() {
  const ctx = new Context()
  const loader = new Loader(ctx, { baseUrl: pathToFileURL(`${process.env.DSH_INSTALL_DIR}/`).href })
  const webServer = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  const proposals = []
  let preStepGate = null
  ctx.on('agent/pre-step', async ({ agent, messages }) => {
    proposals.push({ id: agent.id, messages: structuredClone(messages) })
    const gate = preStepGate
    if (gate) {
      gate.entered.resolve()
      await gate.released.promise
    }
    return { kind: 'reject' }
  })
  const rows = [
    ['dsh-llm', {}],
    ['dsh-subprocess-local', {}],
    ['dsh-session', {}],
    ['dsh-session-projection', {}],
    ['dsh-agent', {}],
    ['dsh-tools', {}],
    ['dsh-tool-executor-native', {}],
    ['dsh-system-prompt', {}],
    ['dsh-agent-loop', {}],
    ['dsh-typert-registry', {}],
    ['dsh-api-remote-access', {}],
    ['dsh-api-gateway', {}],
    ['dsh-session-persistence-jsonl', { root: join(process.env.DSH_HOME, 'sessions') }],
    ['dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' }],
    ['dsh-shell-env', {}],
    ['dsh-storage', {}],
    ['dsh-storage-json', { root: join(process.env.DSH_HOME, 'storages') }],
    ['dsh-storage-domain', { backend: 'json' }],
    ['dsh-workspace', {}],
    ['dsh-session-title', { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }],
    ['dsh-agent-default-model', { provider: 'deepseek-official', model: 'deepseek-chat' }],
    ['dsh-fs-local', {}],
    ['dsh-attachment-local', { dshHome: process.env.DSH_HOME }],
    ['dsh-credentials-local', { dshHome: process.env.DSH_HOME, watch: false }],
    ['dsh-client-connection', {}],
    ['dsh-commands', {}],
    ['dsh-client-file-upload', {}],
    ['dsh-agent-preset-registry', { default: 'orchestrator' }],
    ['dsh-api-session-controller', {}],
    ...worktreeCases.has(caseName)
      ? [
          ['dsh-working-directory', {}],
          ['dsh-sandbox-local', {}],
          ['dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: process.cwd() }],
          ['dsh-experimental-worktree', {}],
        ]
      : [],
  ]
  try {
    const fibers = []
    for (const [name, config] of rows) {
      const module = await import(`@deepseek-ai/${name}`)
      fibers.push([name, ctx.plugin(module.default ?? module, config)])
    }
    for (const [name, fiber] of fibers) {
      await fiber.await()
      assert.equal(fiber.state, 2, `${name} must activate using real official services`)
    }
    const { default: AgentPreset } = await import('@deepseek-ai/dsh-agent-preset')
    for (const id of roles)
      await ctx.plugin(AgentPreset, { id, plugins: [] })
    await loader.await()
    const unregister = roles.map(id => session.register(id))
    const release = server(ctx, { origin: 'http://127.0.0.1', owner: () => true })
    const stopSession = session.start()
    const stopInbox = inbox.start()
    const stopWorktree = worktree.start()
    const stopProjects = projects.start()
    const stopWorker = workers.start()
    ctx.on('agent/created', ({ agent }) => handleAgentCreated(ctx, agent))
    ctx.on('session/event', handleSessionEvent)
    return {
      ctx,
      proposals,
      holdPreStep() {
        const entered = Promise.withResolvers()
        const released = Promise.withResolvers()
        preStepGate = { entered, released }
        return {
          entered: entered.promise,
          release() {
            preStepGate = null
            released.resolve()
          },
        }
      },
      async close() {
        await stopInbox()
        await stopSession()
        await stopProjects()
        await stopWorktree()
        await stopWorker()
        await ctx.sessionPersistence.flush()
        await release()
        for (const dispose of unregister) dispose()
        assert.equal(webServer.port, undefined, 'the real WebServer must never listen')
        await ctx.fiber.dispose()
      },
    }
  }
  catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function project(id, enabled = true) {
  const directory = join(process.cwd(), id)
  await mkdir(directory, { recursive: true })
  const workspace = await runtime.ctx.workspaceRegistry.create(directory, `Repository ${id}`)
  const row = await db.project.upsertWorkspace({ id, workspaceId: workspace.id, name: `Project ${id}`, directory, remoteUrl: `https://example.invalid/${id}.git` }, now)
  if (!enabled)
    await db.project.setEnabled(id, false, now)
  return row
}

async function initRepository(directory) {
  await git('git', ['init'], { cwd: directory })
  await git('git', ['-c', 'user.name=Initial author', '-c', 'user.email=initial@example.invalid', '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'Initialize isolated test repository'], { cwd: directory })
}

/** 会话里所有以「票号:」开头的派工正文，用来判断这一轮到底有没有把 prompt 投出去。 */
async function dispatchPrompts(id, ticketId) {
  const { events } = await session.history(id)
  return events.flatMap(event => event.type === 'user/message'
    ? [event.data]
    : event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []))
    .filter(text => text.startsWith(`${ticketId}:`))
}

async function supervisor(id) {
  await db.supervisor.create({ id, sessionId: null, title: `Coordination ${id}`, reason: 'Integration contract', status: 'active', createdAt: now, closedAt: null })
}

async function enqueue(id, type, refs = {}, extra = {}) {
  return db.inbox.enqueue({ id, type, origin: 'system', kind: 'notice', message: `Private payload ${id}`, ...refs, ...extra })
}

async function settle() {
  await Promise.all(runtime.ctx.agents.list().map(agent => agent.whenIdle()))
  await runtime.ctx.sessionPersistence.flush()
}

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value)
      return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('timed out waiting for the expected runtime state')
}

async function expectWake(id, count) {
  await settle()
  const notices = runtime.proposals.filter(item => item.id === id).flatMap(item => item.messages).filter(message => message.source.kind === 'supermesh-mailbox')
  assert.equal(notices.length, 1, `${id} must receive exactly one waking internal-mail notice`)
  assert.equal(notices[0].content[0].text, `你有${count}个未处理邮件。用 read_mailbox 读取邮件和项目上下文，处理完成后显式完成邮件。`)
  assert.equal(notices[0].content.some(part => part.type === 'text' && part.text.includes('Private payload')), false)
  const history = await session.history(id)
  assert.equal(history.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'blocked'), true, 'the real loop must enter and close a rejected turn')
  assert.equal(history.events.some(event => event.type === 'assistant/message' || event.type === 'assistant/attempt'), false, 'pre-step rejection must prevent every model request')
}

const cases = {
  async shell() {
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
    const { shell } = await import('@/service/shell.ts')
    const botToken = 'supermesh-synthetic-bot-for-local-cli-only'
    const personalToken = 'supermesh-synthetic-personal-must-not-be-used'
    const metadata = { commitName: 'Supermesh isolated bot', commitEmail: 'supermesh-bot@example.invalid' }
    await runtime.ctx.credentials.set(credentialRef('SUPERMESH_GITHUB_TOKEN'), botToken)
    await db.channel.saveConfiguration('github', 'GitHub', 'https://github.com', true, metadata, { name: 'supermesh-isolated-bot', avatar: null })
    await mkdir(process.env.GH_CONFIG_DIR, { recursive: true })
    await writeFile(join(process.env.GH_CONFIG_DIR, 'hosts.yml'), JSON.stringify({ 'github.com': { oauth_token: personalToken, user: 'ambient-account', git_protocol: 'https' } }), { mode: 0o600 })
    const directory = join(process.cwd(), 'shell-repository')
    const linked = join(process.cwd(), 'shell-linked-worktree')
    await mkdir(directory)
    await git('git', ['init'], { cwd: directory })
    await git('git', ['remote', 'add', 'origin', 'https://github.com/example/supermesh-shell.git'], { cwd: directory })
    await git('git', ['-c', 'user.name=Initial author', '-c', 'user.email=initial@example.invalid', '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'Initialize isolated test repository'], { cwd: directory })
    await git('git', ['worktree', 'add', '-b', 'dsh/shell-test', linked], { cwd: directory })
    const workspace = await runtime.ctx.workspaceRegistry.create(directory, 'Shell repository')
    await projects.sync()
    assert.equal((await db.project.findByWorkspace(workspace.id)).enabled, 1)
    const gitlabHost = 'gitlab.example.invalid'
    const gitlabToken = 'supermesh-synthetic-gitlab-bot-local-only'
    const gitlabMetadata = { commitName: 'Supermesh GitLab bot', commitEmail: 'supermesh-gitlab@example.invalid' }
    const gitlabDirectory = join(process.cwd(), 'shell-gitlab-subgroup')
    if (process.env.SUPERMESH_TEST_GLAB_DIR) {
      await runtime.ctx.credentials.set(credentialRef('SUPERMESH_GITLAB_TOKEN'), gitlabToken)
      await db.channel.saveConfiguration('gitlab', 'GitLab', `https://${gitlabHost}`, true, gitlabMetadata, { name: 'supermesh-gitlab-bot', avatar: null })
      await mkdir(process.env.GLAB_CONFIG_DIR, { recursive: true })
      await writeFile(join(process.env.GLAB_CONFIG_DIR, 'config.yml'), JSON.stringify({ hosts: { [gitlabHost]: { token: personalToken, user: 'ambient-gitlab-account', api_protocol: 'https' } } }), { mode: 0o600 })
      await mkdir(gitlabDirectory)
      await git('git', ['init'], { cwd: gitlabDirectory })
      await git('git', ['remote', 'add', 'origin', `https://${gitlabHost}/group/subgroup/supermesh-shell.git`], { cwd: gitlabDirectory })
      await runtime.ctx.workspaceRegistry.create(gitlabDirectory, 'GitLab subgroup repository')
      await projects.sync()
    }
    const original = { ...process.env }
    process.env.GH_TOKEN = personalToken
    const before = { ...process.env }
    let stop
    const run = async (argv, cwd = directory, input, env, timeout = 15000) => {
      const handle = runtime.ctx.subprocess.spawn({ argv, cwd, env, signal: AbortSignal.timeout(timeout), graceMs: 2000, stdio: { stdin: input === undefined ? 'ignore' : { data: input }, stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
      const outcome = await handle.done
      return { code: outcome.exitCode, output: handle.collected.stdout.readFrom(0).text, error: handle.collected.stderr.readFrom(0).text }
    }
    const nativeShell = command => process.platform === 'win32' ? ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`] : ['bash', '-c', command]
    // 原生 shell 每次要串起 pwsh/bash → cmd → gh，冷启动在 CI 上能到十几秒，10 秒预算会把冷启动当成失败。
    const native = (command, cwd = directory, env) => run(nativeShell(command), cwd, undefined, env, 30000)
    const describeRun = result => `exit=${result.code} stdout=${JSON.stringify(result.output)} stderr=${JSON.stringify(result.error)}`
    const shellPath = process.env.PATH
    const ambientGitConfig = process.env.GIT_CONFIG_GLOBAL
    try {
      assert.equal((await runtime.ctx.credentials.resolve(credentialRef('SUPERMESH_GITHUB_TOKEN'))).value === botToken, true, 'GitHub credential must survive GitLab credential registration')
      stop = await shell.start()
      // 宿主进程环境不再被改写：其它会话的 token、git 配置必须原样保留。
      assert.equal(process.env.GH_TOKEN, personalToken, 'start must not touch ambient tokens')
      assert.equal(process.env.GIT_CONFIG_GLOBAL, ambientGitConfig, 'start must not hijack the global git config')
      assert.equal(process.env.GIT_AUTHOR_NAME, original.GIT_AUTHOR_NAME, 'start must not delete ambient git identity variables')
      assert.equal(process.env.PATH.split(delimiter)[0].endsWith(join('.supermesh', 'cli', 'bin')), true, 'shim directory must lead PATH')
      const role = { GH_TOKEN: personalToken, GITHUB_TOKEN: personalToken, DSH_SUPERMESH_ROLE: 'worker' }
      const auth = await native('gh auth token', directory, role)
      assert.equal(auth.code, 0, `real native shell must resolve the gh shim (${describeRun(auth)})`)
      assert.equal(auth.output.trim() === botToken, true, `role sessions must use the private bot config (personal=${auth.output.trim() === personalToken}, botIncluded=${auth.output.includes(botToken)}, gitlab=${auth.output.trim() === gitlabToken}, chars=${auth.output.trim().length})`)
      const ambient = await native('gh auth token', directory, { GH_TOKEN: personalToken, GITHUB_TOKEN: personalToken })
      assert.equal(ambient.output.trim(), personalToken, 'sessions outside the four roles must keep their own credential')
      assert.equal(ambient.output.includes(botToken), false)
      const credential = await run(['git', 'credential', 'fill'], directory, 'protocol=https\nhost=github.com\n\n', { GIT_CONFIG_GLOBAL: join(process.env.DSH_HOME, '.supermesh', 'cli', 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', DSH_SUPERMESH_ROLE: 'worker' })
      assert.equal(credential.code, 0, 'git must use the configured native gh credential helper')
      assert.equal(credential.output.includes(`password=${botToken}`), true, 'git helper must return only the isolated bot credential')
      assert.equal(credential.output.includes(personalToken), false)
      const other = await run(['git', 'credential', 'fill'], directory, 'protocol=https\nhost=other.example.invalid\n\n', { GIT_CONFIG_GLOBAL: join(process.env.DSH_HOME, '.supermesh', 'cli', 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', DSH_SUPERMESH_ROLE: 'worker' })
      assert.notEqual(other.code, 0, 'unconfigured credential hosts must fail without prompting')
      assert.equal(`${other.output}${other.error}`.includes(botToken), false)
      assert.equal(`${other.output}${other.error}`.includes(personalToken), false)
      // Windows 上不再有 git shim（.cmd 会吃掉 ^，无扩展名的 sh 版又会挡住 PowerShell 的真 git），
      // 角色会话的 git 身份回落到环境里的全局配置；POSIX 上 sh shim 仍然切到 bot 的 gitconfig。
      const botIdentity = process.platform !== 'win32'
      for (const cwd of [directory, linked]) {
        const name = await native('git config user.name', cwd, { DSH_SUPERMESH_ROLE: 'worker' })
        const email = await native('git config user.email', cwd, { DSH_SUPERMESH_ROLE: 'worker' })
        if (botIdentity) {
          assert.equal(name.code, 0, `${cwd === directory ? 'main repository' : 'linked worktree'} must resolve commit name (${describeRun(name)})`)
          assert.equal(name.output.trim(), metadata.commitName)
          assert.equal(email.code, 0, `${cwd === directory ? 'main repository' : 'linked worktree'} must resolve commit email`)
          assert.equal(email.output.trim(), metadata.commitEmail)
        }
        else {
          assert.equal(name.output.trim(), '', `Windows role sessions must keep the ambient git identity (${describeRun(name)})`)
          assert.equal(email.output.trim(), '', `Windows role sessions must keep the ambient git identity (${describeRun(email)})`)
        }
        const outside = await native('git config user.name', cwd)
        assert.notEqual(outside.output.trim(), metadata.commitName, 'sessions outside the four roles must keep their own git identity')
      }
      const merging = await native('gh-default auth token', directory, role)
      assert.equal(`${merging.output}${merging.error}`.includes(botToken), false, 'the default-login merge entry must never answer with the bot credential')
      assert.notEqual(merging.output.trim(), botToken)
      if (process.env.SUPERMESH_TEST_GLAB_DIR) {
        const glabRole = { GITLAB_TOKEN: personalToken, GLAB_TOKEN: personalToken, OAUTH_TOKEN: personalToken, CI_JOB_TOKEN: personalToken, DSH_SUPERMESH_ROLE: 'worker' }
        const auth = await native(`glab config get token --host ${gitlabHost}`, gitlabDirectory, glabRole)
        assert.equal(auth.code, 0, `real portable glab must run through the native shell shim (${describeRun(auth)})`)
        assert.equal(auth.output.trim() === gitlabToken, true, 'glab shim must select the private bot config rather than ambient tokens/config')
        const credential = await run(['git', 'credential', 'fill'], gitlabDirectory, `protocol=https\nhost=${gitlabHost}\n\n`, { GIT_CONFIG_GLOBAL: join(process.env.DSH_HOME, '.supermesh', 'cli', 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', DSH_SUPERMESH_ROLE: 'worker' })
        assert.equal(credential.code, 0, 'GitLab credential helper must execute the real glab')
        assert.equal(credential.output.includes(`password=${gitlabToken}`), true)
        assert.equal(credential.output.includes(personalToken), false)
        const name = await native('git config user.name', gitlabDirectory, { DSH_SUPERMESH_ROLE: 'worker' })
        const email = await native('git config user.email', gitlabDirectory, { DSH_SUPERMESH_ROLE: 'worker' })
        assert.equal(name.output.trim(), gitlabMetadata.commitName)
        assert.equal(email.output.trim(), gitlabMetadata.commitEmail)
        await db.channel.setEnabled('gitlab', false)
        await shell.refresh()
        const disabled = await native(`glab config get token --host ${gitlabHost}`, gitlabDirectory, glabRole)
        assert.equal(disabled.output.trim().length === 0, true, 'disabled GitLab config must not expose any ambient or keyring credential')
        assert.equal(`${disabled.output}${disabled.error}`.includes(gitlabToken), false)
        assert.equal(`${disabled.output}${disabled.error}`.includes(personalToken), false)
        const disabledCredential = await run(['git', 'credential', 'fill'], gitlabDirectory, `protocol=https\nhost=${gitlabHost}\n\n`, { GIT_CONFIG_GLOBAL: join(process.env.DSH_HOME, '.supermesh', 'cli', 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', DSH_SUPERMESH_ROLE: 'worker' })
        assert.notEqual(disabledCredential.code, 0, 'disabled GitLab must not answer git credential requests')
        assert.equal(`${disabledCredential.output}${disabledCredential.error}`.includes(gitlabToken), false)
        assert.equal(`${disabledCredential.output}${disabledCredential.error}`.includes(personalToken), false)
        process.stdout.write('SUPERMESH_GLAB_REAL_PASS\n')
      }
      await db.channel.setEnabled('github', false)
      await shell.refresh()
      const disabled = await native('gh auth token', directory, role)
      assert.notEqual(disabled.code, 0, 'disabled channel must not fall back to ambient CLI login or token')
      assert.equal(`${disabled.output}${disabled.error}`.includes(botToken), false)
      assert.equal(`${disabled.output}${disabled.error}`.includes(personalToken), false)
      await stop()
      stop = undefined
      const keys = new Set([...Object.keys(before), ...Object.keys(process.env)])
      assert.equal([...keys].every(key => process.env[key] === before[key]), true, 'stop must restore every changed process environment entry')
      assert.equal(process.env.PATH, shellPath, 'stop must restore the original PATH')
    }
    finally {
      if (stop)
        await stop()
      if (original.GH_TOKEN === undefined)
        delete process.env.GH_TOKEN
      else
        process.env.GH_TOKEN = original.GH_TOKEN
    }
  },
  /**
   * 建树失败的真凶：shim 目录里的 git 包装器被官方解析器按 PATHEXT 命中，cmd.exe 又把 `^`
   * 当转义吃掉，`HEAD^{commit}` 变成 `HEAD{commit}`，官方 worktree 服务直接 128。
   * 这里用真实官方运行时验证解析结果，并在真实原生 shell 里验证 rev 语法没被改写。
   */
  async shellGitRevision() {
    const { shell } = await import('@/service/shell.ts')
    const stop = await shell.start()
    try {
      const shim = join(process.env.DSH_HOME, '.supermesh', 'cli', 'bin')
      for (const name of ['git.com', 'git.exe', 'git.bat', 'git.cmd'])
        assert.equal(existsSync(join(shim, name)), false, `shim 目录不得留下会被官方解析器命中的 ${name}`)
      if (process.platform === 'win32')
        assert.equal(existsSync(join(shim, 'git')), false, 'Windows 上无扩展名的 sh 版会挡住 PowerShell 的真 git.exe')
      else
        assert.equal(existsSync(join(shim, 'git')), true, 'POSIX 上角色会话仍靠 sh shim 拿 bot 的 gitconfig')
      const resolved = await runtime.ctx.subprocess.resolveExecutable('git')
      assert.equal(/\.(?:cmd|bat)$/i.test(resolved), false, `官方解析器必须落到真 git，实际解析到 ${resolved}`)
      const directory = join(process.cwd(), 'revision-repository')
      await mkdir(directory)
      await initRepository(directory)
      await git('git', ['-c', 'user.name=Second author', '-c', 'user.email=second@example.invalid', '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'Second commit'], { cwd: directory })
      const head = (await git('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim()
      const parent = (await git('git', ['rev-parse', 'HEAD^'], { cwd: directory })).stdout.trim()
      const run = async (argv) => {
        const handle = runtime.ctx.subprocess.spawn({ argv, cwd: directory, env: { DSH_SUPERMESH_ROLE: 'worker' }, signal: AbortSignal.timeout(30000), graceMs: 2000, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
        const outcome = await handle.done
        return { code: outcome.exitCode, output: handle.collected.stdout.readFrom(0).text.trim(), error: handle.collected.stderr.readFrom(0).text.trim() }
      }
      // 官方 worktree 服务先解析出绝对路径再 spawn，argv 里带着 HEAD^{commit}。
      const commit = await run([resolved, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
      assert.equal(commit.code, 0, `官方解析器解析出的 git 必须接受 HEAD^{commit}（stdout=${commit.output} stderr=${commit.error}）`)
      assert.equal(commit.output, head, 'HEAD^{commit} 必须解析成真实 HEAD')
      // pwsh 会把裸 `HEAD^{commit}` 拆成两个参数，裸 `HEAD^` 才能证明 ^ 原样到达 git。
      const command = 'git rev-parse --verify HEAD^'
      const revision = await run(process.platform === 'win32' ? ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`] : ['bash', '-c', command])
      assert.equal(revision.code, 0, `原生 shell 里的 HEAD^ 必须被 git 接受（stdout=${revision.output} stderr=${revision.error}）`)
      assert.equal(revision.output, parent, 'HEAD^ 必须解析成上一提交，而不是被当成 HEAD')
    }
    finally {
      await stop()
    }
  },
  async projectSync() {
    const directory = join(process.cwd(), 'real-repository')
    await mkdir(directory)
    await git('git', ['init'], { cwd: directory })
    await git('git', ['remote', 'add', 'origin', 'https://github.com/example/supermesh-project.git'], { cwd: directory })
    const workspace = await runtime.ctx.workspaceRegistry.create(directory, 'Real repository')
    await projects.sync()
    const initial = await db.project.findByWorkspace(workspace.id)
    assert.equal(initial.enabled, 1)
    assert.equal(initial.remoteUrl, 'https://github.com/example/supermesh-project')
    assert.equal((await projects.list()).find(row => row.id === initial.id).available, true)
    // 探测到的改名写回后，每 5 秒的工作区同步不得用本地还没改的 origin 把它盖回去。
    const renamed = 'https://github.com/example/supermesh-renamed'
    await db.project.setRemoteUrl(initial.id, renamed, now)
    await projects.sync()
    assert.equal((await db.project.findById(initial.id)).remoteUrl, renamed)
    assert.equal((await projects.list()).find(row => row.id === initial.id).available, true)
    await db.project.setEnabled(initial.id, false, now)
    await projects.sync()
    assert.equal((await db.project.findById(initial.id)).enabled, 0)
    await db.project.setEnabled(initial.id, true, now)
    await git('git', ['remote', 'remove', 'origin'], { cwd: directory })
    await projects.sync()
    assert.equal((await db.project.findById(initial.id)).enabled, 0)
    assert.equal((await projects.list()).find(row => row.id === initial.id).available, false)
    await git('git', ['remote', 'add', 'origin', 'git@github.com:example/supermesh-project.git'], { cwd: directory })
    await projects.sync()
    assert.equal((await db.project.findById(initial.id)).enabled, 0)
    await db.project.setEnabled(initial.id, true, now)
    assert.equal(await runtime.ctx.workspaceRegistry.delete(workspace.id), true)
    await projects.sync()
    assert.equal((await db.project.findById(initial.id)).enabled, 0)
    assert.equal((await projects.list()).find(row => row.id === initial.id).available, false)
    assert.equal((await stat(directory)).isDirectory(), true)
    const replacement = await runtime.ctx.workspaceRegistry.create(directory, 'Re-added repository')
    await projects.sync()
    assert.notEqual(replacement.id, workspace.id)
    assert.equal((await db.project.findByWorkspace(replacement.id)).enabled, 1)
    assert.equal((await db.project.findById(initial.id)).enabled, 0)
  },
  async workspace() {
    const p = await project('workspace-project')
    await supervisor('workspace-supervisor')
    // 旧版本把「代理工作区」注册在 `.supermesh` 根，与插件状态共树：升级后这条注册必须被移除，
    // 否则侧栏会同时出现根目录与 workspace 两条同类条目。
    await mkdir(pluginHome, { recursive: true })
    const legacyWorkspace = await runtime.ctx.workspaceRegistry.create(pluginHome, '代理工作区')
    const workspace = await session.workspace()
    assert.equal(runtime.ctx.workspaceRegistry.list().some(item => item.path === pluginHome), false, 'the workspace registered on the plugin root must be retired')
    assert.notEqual(workspace.id, legacyWorkspace.id)
    assert.equal(workspace.title, '代理工作区')
    assert.equal(workspace.path, agentDirectory)
    assert.notEqual(workspace.path, pluginHome, 'the agent workspace must not be the plugin home itself')
    const { setting } = await import('@/service/setting.ts')
    await setting.save({ maxWorkers: 4 })
    assert.equal(existsSync(join(pluginHome, 'setting.json')), true, 'plugin settings must stay in the plugin home')
    assert.equal(existsSync(join(agentDirectory, 'setting.json')), false, 'plugin settings must never land inside the agent workspace')
    assert.equal(existsSync(join(agentDirectory, 'jobs.json')), false, 'the scheduler journal must never land inside the agent workspace')
    const manual = await runtime.ctx.sessionController.create({ cwd: agentDirectory, agentPreset: 'orchestrator' })
    assert.equal(await session.findMain(), manual.sessionId, 'manual main attach must retain its identity as the canonical main')
    assert.deepEqual(workspace.sessionIds, [manual.sessionId], 'manual main attach must bind its existing official workspace')
    await runtime.ctx.sessionController.rename({ sessionId: manual.sessionId, title: '[路由] 主编排' })
    const ids = await Promise.all([
      session.create('main', { directory: p.directory, title: 'Ignored main title' }),
      session.create('project', { projectId: p.id, directory: p.directory, title: 'Ignored project title' }),
      session.create('supervisor', { supervisorId: 'workspace-supervisor', directory: p.directory }),
    ])
    assert.equal(ids[0], manual.sessionId, 'create must reuse the manually attached main instead of duplicating it')
    assert.deepEqual(new Set(workspace.sessionIds), new Set(ids))
    assert.deepEqual(runtime.ctx.workspaceRegistry.get(p.workspaceId).sessionIds, [])
    for (const [index, id] of ids.entries()) {
      assert.equal((await session.history(id)).session.cwd, agentDirectory)
      assert.equal((await runtime.ctx.sessionQuery.readTitle(SessionId(id))).title, ['[路由] 主编排', '[路由] Project workspace-project', '[协调] Coordination workspace-supervisor'][index])
    }
    await settle()
    for (const id of ids)
      await workspace.detachSession(SessionId(id))
    assert.deepEqual(workspace.sessionIds, [], 'official detach leaves existing role sessions ungrouped')
    await runtime.close()
    runtime = await start()
    const restored = await session.workspace()
    assert.equal(restored.id, workspace.id)
    assert.deepEqual(restored.sessionIds, [], 'unassignment must persist before the role binding is reused')
    const histories = await Promise.all(ids.map(id => session.history(id)))
    assert.equal(await session.create('main', {}), ids[0])
    assert.equal(await session.create('project', { projectId: p.id }), ids[1])
    assert.equal(await session.create('supervisor', { supervisorId: 'workspace-supervisor' }), ids[2])
    assert.deepEqual(new Set(restored.sessionIds), new Set(ids), 'reusing every non-worker binding restores official workspace membership')
    for (const [index, id] of ids.entries())
      assert.deepEqual(await session.history(id), histories[index], 'workspace recovery must preserve the complete header and event history')
    assert.deepEqual(new Set((await runtime.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)), new Set(ids), 'recovery must not create duplicate sessions')
    assert.equal(runtime.ctx.agents.list().length, 0, 'binding reuse and workspace lookup must not activate cold Agents')
    assert.equal((await session.activate(ids[2])).id, ids[2])
    assert.equal(runtime.ctx.agents.list().length, 1)
    await restored.detachSession(SessionId(ids[0]))
    const main = await runtime.ctx.sessionController.resolveAgent(SessionId(ids[0]))
    assert.equal('agent' in main, true)
    assert.equal(main.agent.id, ids[0])
    assert.equal(restored.sessionIds.includes(SessionId(ids[0])), true, 'resuming an ungrouped main must restore membership through attach')
    assert.equal(await session.attach(main.agent), 'main')
    assert.equal(restored.sessionIds.filter(id => id === ids[0]).length, 1, 'repeated attach must remain idempotent')
    await runtime.close()
    runtime = await start()
    assert.deepEqual(new Set((await session.workspace()).sessionIds), new Set(ids), 'repaired membership must survive another restart')
    await storage.removeItem('orchestrator.id')
    const legacy = await runtime.ctx.sessionController.create({ cwd: p.directory, agentPreset: 'orchestrator' })
    assert.equal(await session.findMain(), legacy.sessionId, 'an existing main in a different immutable cwd must retain its identity')
    const legacyHistory = await session.history(legacy.sessionId)
    assert.equal(await session.create('main', {}), legacy.sessionId, 'unsupported cross-directory migration must not create a duplicate main')
    assert.deepEqual(await session.history(legacy.sessionId), legacyHistory, 'legacy headers and history must remain untouched')
    assert.equal((await session.workspace()).sessionIds.includes(legacy.sessionId), false, 'official attach cannot move a Session with a different immutable cwd')
  },
  async createMail() {
    const p = await project('mail-project')
    await supervisor('mail-supervisor')
    await enqueue('main-mail-1', 'main')
    await enqueue('main-mail-2', 'main')
    await enqueue('project-mail', 'project', { projectId: p.id })
    await enqueue('supervisor-mail', 'supervisor', { supervisorId: 'mail-supervisor' })
    await inbox.deliver()
    const main = await session.findMain()
    const manager = (await db.project.findById(p.id)).orchestratorSessionId
    const coordinator = (await db.supervisor.findById('mail-supervisor')).sessionId
    assert.equal(typeof main, 'string')
    assert.equal(typeof manager, 'string')
    assert.equal(typeof coordinator, 'string')
    await expectWake(main, 2)
    await expectWake(manager, 1)
    await expectWake(coordinator, 1)
    assert.equal((await inbox.peek(main)).pendingCount, 2)
    assert.equal((await db.inbox.findById('main-mail-1')).readAt, null)
    assert.equal((await db.inbox.findById('main-mail-1')).status, 'pending')
  },
  async resumeMail() {
    const p = await project('resume-project')
    await supervisor('resume-supervisor')
    const ids = [
      await session.create('main', {}),
      await session.create('project', { projectId: p.id }),
      await session.create('supervisor', { supervisorId: 'resume-supervisor' }),
    ]
    await runtime.close()
    runtime = await start()
    assert.equal(runtime.ctx.agents.list().length, 0)
    assert.equal(await session.lookup(ids[0]), null)
    await enqueue('resume-main', 'main')
    await enqueue('resume-project', 'project', { projectId: p.id })
    await enqueue('resume-supervisor', 'supervisor', { supervisorId: 'resume-supervisor' })
    await inbox.deliver()
    assert.deepEqual(new Set(runtime.ctx.agents.list().map(agent => agent.id)), new Set(ids))
    for (const id of ids) await expectWake(id, 1)
    assert.equal((await db.project.findById(p.id)).orchestratorSessionId, ids[1])
    assert.equal((await db.supervisor.findById('resume-supervisor')).sessionId, ids[2])
  },
  async invalidMail() {
    const disabled = await project('disabled-project', false)
    const valid = await project('valid-project')
    await enqueue('invalid-recipient', 'project')
    await enqueue('disabled-recipient', 'project', { projectId: disabled.id })
    await enqueue('valid-recipient', 'project', { projectId: valid.id })
    await inbox.deliver()
    const bad = await db.inbox.findById('invalid-recipient')
    assert.equal(bad.deliveryAttempts, 1)
    assert.equal(bad.deliveryError, 'invalid_inbox_recipient')
    assert.equal((await db.project.findById(disabled.id)).orchestratorSessionId, null)
    assert.equal((await db.inbox.findById('disabled-recipient')).deliveryAttempts, 0)
    const id = (await db.project.findById(valid.id)).orchestratorSessionId
    assert.equal(typeof id, 'string')
    await expectWake(id, 1)
  },
  async channelIsolation() {
    const p = await project('channel-project')
    await enqueue('stalled-channel', 'project', { projectId: p.id }, { origin: 'channel', status: 'stalled' })
    await enqueue('internal-after-channel', 'project', { projectId: p.id })
    await inbox.deliver()
    const id = (await db.project.findById(p.id)).orchestratorSessionId
    assert.equal(typeof id, 'string')
    // 渠道邮件和内部邮件走同一条通知：一条紧凑提示覆盖两条待处理邮件。
    await expectWake(id, 2)
    assert.equal((await db.inbox.findById('stalled-channel')).status, 'stalled')
    assert.equal((await db.inbox.findById('internal-after-channel')).deliveryAttempts, 0)
  },
  async roleMarker() {
    const { shell } = await import('@/service/shell.ts')
    const { default: AgentPreset } = await import('@deepseek-ai/dsh-agent-preset')
    await runtime.ctx.plugin(AgentPreset, { id: 'plain', plugins: [] })
    const stopShell = await shell.start()
    try {
      const p = await project('marker-project')
      const roleId = await session.create('project', { projectId: p.id })
      const role = await session.activate(roleId)
      const plain = await runtime.ctx.sessionController.create({ cwd: agentDirectory, agentPreset: 'plain' })
      const plainAgent = runtime.ctx.agents.get(SessionId(plain.sessionId)) ?? null
      assert.equal(plainAgent !== null, true, 'plain session must be live before collecting its environment')
      assert.equal(runtime.ctx.shellEnv.list().some(item => item.key === 'DSH_SUPERMESH_ROLE' && item.contributor === 'supermesh-role'), true, 'the role marker must be declared by the plugin')
      assert.equal(runtime.ctx.shellEnv.collect({ agent: role }).DSH_SUPERMESH_ROLE, 'project', 'role sessions must receive the bot marker')
      assert.equal(runtime.ctx.shellEnv.collect({ agent: plainAgent }).DSH_SUPERMESH_ROLE, undefined, 'sessions outside the four roles must not receive the bot marker')
      assert.equal(runtime.ctx.shellEnv.collect({}).DSH_SUPERMESH_ROLE, undefined, 'executions without an agent must not receive the bot marker')
    }
    finally {
      await stopShell()
    }
  },
  async sendDelivery() {
    const p = await project('send-delivery-project')
    const id = await session.create('project', { projectId: p.id })
    const agent = await session.activate(id)
    const textOf = message => message.content.flatMap(part => part.type === 'text' ? [part.text] : [])
    assert.equal(agent.status, 'idle')

    const idle = runtime.holdPreStep()
    await session.send(id, 'idle wake', 'wake')
    await idle.entered
    assert.equal(runtime.proposals.some(item => item.id === id && item.messages.some(message => textOf(message).includes('idle wake'))), true, 'an idle wake must open a new turn with the message')
    assert.equal(agent.inbox.nextStep.length, 0, 'an idle wake must not park steering for a turn that already started')
    idle.release()
    await settle()

    const running = runtime.holdPreStep()
    await session.send(id, 'running wake', 'wake')
    await running.entered
    assert.equal(agent.status, 'running', 'the held pre-step must keep the agent running')
    await session.send(id, 'steer now', 'wake')
    assert.equal(agent.inbox.nextStep.some(message => textOf(message).includes('steer now')), true, 'a running wake must steer to the next step')
    assert.equal(agent.inbox.nextTurn.some(message => textOf(message).includes('steer now')), false, 'a running wake must not wait for the next turn')
    await session.send(id, 'reply now', 'reply')
    assert.equal(agent.inbox.nextStep.some(message => textOf(message).includes('reply now')), true, 'a running reply must steer to the next step')
    await session.send(id, 'queued now', 'queue')
    assert.equal(agent.inbox.nextTurn.some(message => textOf(message).includes('queued now')), true, 'an explicit queue must wait for the next turn')
    assert.equal(agent.inbox.nextStep.some(message => textOf(message).includes('queued now')), false, 'an explicit queue must not steer')
    running.release()
    await settle()
  },
  async workerEnd() {
    const p = await project('worker-end-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const { worker: workers } = await import('@/service/worker.ts')
    const ticketId = 'worker-end-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '票已结束的 Worker', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const queued = await db.worker.queue(ticketId, p.id)
    await db.worker.start(queued.id, now)
    await db.ticket.update(ticketId, { status: 'done', endedAt: now, updatedAt: now })
    await workers.reconcile()
    assert.equal((await db.worker.findById(queued.id)).status, 'ended', '票进终态后它还在 running 的 Worker 必须被结束')
    assert.equal((await db.worker.findById(queued.id)).endedReason, 'stopped')
    assert.equal((await db.worker.listRunning()).length, 0)
  },
  async ticketArchive() {
    const p = await project('archive-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const { setting } = await import('@/service/setting.ts')
    const { closeThread } = await import('@/channel/_shared/thread.ts')
    const archived = () => runtime.ctx.workspaceRegistry.archivedSessionIds
    const ticketWithWorker = async (id) => {
      await db.ticket.create({ id, projectId: p.id, channelId: 'github', title: id, description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
      const worker = await db.worker.queue(id, p.id)
      await session.create('worker', { sessionId: worker.id, ticketId: id, projectId: p.id, directory: p.directory })
      await db.worker.start(worker.id, now)
      return worker
    }

    const offWorker = await ticketWithWorker('archive-off-ticket')
    await db.worker.end(offWorker.id, 'completed', now)
    await workers.archiveSessions('archive-off-ticket')
    assert.equal(archived().includes(offWorker.id), false, 'autoArchiveWorkers 关闭时票结单不得归档 Worker 会话')

    await setting.save({ autoArchiveWorkers: true })

    // Worker 先结束、票后结单：结单那一刻归档票名下已结束的 Worker 会话。
    const mergedWorker = await ticketWithWorker('archive-merged-ticket')
    await db.ticket.update('archive-merged-ticket', { prState: 'merged', updatedAt: now })
    await workers.reconcile()
    assert.equal((await db.ticket.findById('archive-merged-ticket')).status, 'done')
    assert.equal(archived().includes(mergedWorker.id), true, '票进终态后它名下已结束的 Worker 会话必须被归档')
    assert.equal(await session.resolve(mergedWorker.id), null, '归档后的 Worker 会话不再可解析')
    await workers.archiveSessions('archive-merged-ticket')
    assert.equal(archived().filter(id => id === mergedWorker.id).length, 1, '重复结单不得重复归档')

    // 票先结单、Worker 后结束：收尾时同样要归档。
    const lateWorker = await ticketWithWorker('archive-late-ticket')
    await db.ticket.update('archive-late-ticket', { status: 'done', endedAt: now, updatedAt: now })
    await workers.reconcile()
    assert.equal((await db.worker.findById(lateWorker.id)).status, 'ended')
    assert.equal(archived().includes(lateWorker.id), true, '票已终态时结束的 Worker 会话同样要归档')

    // PR 合并结单走 closeThread：同样要归档。
    const pullWorker = await ticketWithWorker('archive-pull-ticket')
    await db.worker.end(pullWorker.id, 'completed', now)
    const url = 'https://github.com/example/archive-project/pull/7'
    const threadId = 'github:archive-project:7'
    await db.thread.record({ id: threadId, channelId: 'github', refId: 'archive-project:7', kind: 'pull', title: 'Archive pull request', url, createdAt: now, updatedAt: now, projectId: p.id, triage: 'claimed', triagedAt: now })
    await db.ticketThread.link('archive-pull-ticket', threadId, now)
    await db.ticket.setPullRequest('archive-pull-ticket', url, 'merged', null)
    await closeThread({ channel: 'github', projectId: p.id, thread: (await db.thread.findById(threadId)), outcome: 'merged', at: now, closeIssue: async () => {} })
    assert.equal((await db.ticket.findById('archive-pull-ticket')).status, 'done')
    assert.equal(archived().includes(pullWorker.id), true, 'PR 合并结单同样要归档票名下的 Worker 会话')
  },
  async workerRedispatch() {
    const p = await project('redispatch-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    await initRepository(p.directory)
    const ticketId = 'redispatch-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '重派工必须真的送达', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const queued = await db.worker.queue(ticketId, p.id)
    // 预先建好会话且不填 worktree：派工复用这个会话，并补建它缺的工作树。
    await session.create('worker', { sessionId: queued.id, ticketId, projectId: p.id, directory: p.directory })
    const dispatches = () => dispatchPrompts(queued.id, ticketId)
    await workers.reconcile()
    await settle()
    assert.equal((await dispatches()).length, 1, 'the first dispatch must reach the worker session')
    // worker 结束、票回 idle 之后不能自动重开：拿同一份 prompt 反复重派就是线上那个死循环。
    assert.equal((await db.worker.findById(queued.id)).status, 'ended')
    assert.equal((await db.ticket.findById(ticketId)).status, 'idle')
    await workers.rescue()
    await workers.reconcile()
    await settle()
    assert.equal((await dispatches()).length, 1, 'an idle ticket whose worker already ran must not be re-dispatched automatically')
    // 编排显式重派（retry_ticket / create_worker 走同一条 queue）必须真的送达，不能被 requestId 去重吞掉。
    await db.worker.queue(ticketId, p.id)
    await workers.reconcile()
    await waitFor(async () => (await dispatches()).length === 2)
    assert.equal((await dispatches()).length, 2, 'an explicit re-queue must land a second prompt instead of being deduplicated by its request id')
  },
  async workerRestart(withWorktree = true) {
    const p = await project('restart-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const ticketId = 'restart-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '重启复用执行会话', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const queued = await db.worker.queue(ticketId, p.id)
    if (withWorktree) {
      // recover 会核对真实 worktree 注册，这里按派工之后的真实形态准备仓库与分支。
      const branch = 'dsh/restart-ticket'
      const linked = join(p.directory, 'worktree')
      await git('git', ['init'], { cwd: p.directory })
      await git('git', ['-c', 'user.name=Initial author', '-c', 'user.email=initial@example.invalid', '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'Initialize isolated test repository'], { cwd: p.directory })
      await git('git', ['worktree', 'add', '-b', branch, linked], { cwd: p.directory })
      await db.worker.update(queued.id, { branch, worktree: linked })
    }
    await session.create('worker', { sessionId: queued.id, ticketId, projectId: p.id, directory: p.directory })
    await db.worker.start(queued.id, now)
    await db.ticket.start(ticketId, now, now)
    await session.send(queued.id, `${ticketId}: 执行这张票`, 'queue', 'restart:prompt')
    await settle()
    const dispatched = await session.history(queued.id)
    assert.equal(dispatched.events.some(event => event.type === 'turn/start'), true, 'the worker session must have run a turn before the restart')

    // 应用退出：会话日志与 worker 记录留在盘上，Agent 随进程消失。
    await runtime.close()
    runtime = await start()
    assert.equal(runtime.ctx.agents.list().length, 0, 'a restart must leave every Agent cold')
    await db.worker.start(queued.id, now)
    await db.ticket.start(ticketId, now, now)
    assert.notEqual(await session.resolve(queued.id), null, 'a persisted worker session must resolve before its Agent is resumed')

    await workers.recover()
    const recovered = await db.worker.findById(queued.id)
    assert.equal(recovered.status, 'running', '恢复时仍在运行的 Worker 不能被 requeue')
    assert.equal(recovered.startedAt, now, '恢复不得清空派工时间')
    assert.equal((await db.worker.listByTicket(ticketId)).length, 1, '重启不得为同一张票新建 worker 记录')

    // 重启后的派工循环同样要复用这个会话，不能另起一条 worker 记录把整张票重跑一遍。
    await workers.reconcile()
    assert.equal((await db.worker.listByTicket(ticketId)).length, 1, '派工循环不得为同一张票新建 worker 记录')

    await settle()
    const resumed = await session.history(queued.id)
    const delivered = resumed.events.flatMap(event => event.type === 'user/message'
      ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      .flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []))
    assert.equal(delivered.filter(text => text.startsWith(`${ticketId}:`)).length, 1, '重启不得重复投递原派工指令')
    assert.equal(delivered.filter(text => text.startsWith('运行已恢复。')).length, 1, '恢复提示必须只投递一次并进入原会话')
    assert.equal((await db.worker.listByTicket(ticketId)).length, 1, '整轮恢复之后仍然只有一个 worker 记录')
    assert.equal(resumed.session.id, dispatched.session.id, '恢复必须续在同一个会话 id 上')
  },
  workerRestartWithoutWorktree: () => cases.workerRestart(false),
  /**
   * 首轮派工在 session.create 之后、worktree 建好之前失败：会话已经落盘，worker 还没有分支和工作树。
   * 下一轮派工必须补建工作树，不能降级到项目主 clone。
   */
  async workerDispatchWorktree() {
    const p = await project('dispatch-worktree-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    await initRepository(p.directory)
    const ticketId = 'dispatch-worktree-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '缺工作树必须补建', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const queued = await db.worker.queue(ticketId, p.id)
    await session.create('worker', { sessionId: queued.id, ticketId, projectId: p.id, directory: p.directory })
    await workers.reconcile()
    await settle()
    const dispatched = await db.worker.findById(queued.id)
    assert.equal(typeof dispatched.branch, 'string', '派工必须给 Worker 建出分支')
    assert.equal(typeof dispatched.worktree, 'string', '派工必须给 Worker 建出工作树')
    assert.notEqual(dispatched.worktree.replace(/\\/g, '/'), p.directory.replace(/\\/g, '/'), 'Worker 绝不能跑在项目主 clone 上')
    const agent = runtime.ctx.agents.get(SessionId(queued.id))
    assert.equal(runtime.ctx.workingDirectory.get(agent.session), dispatched.worktree, 'Worker 会话必须落在自己的工作树里')
    const listed = await git('git', ['worktree', 'list', '--porcelain'], { cwd: p.directory })
    assert.equal(listed.stdout.replace(/\\/g, '/').includes(dispatched.worktree.replace(/\\/g, '/')), true, '工作树必须是这个仓库注册过的 git worktree')
    const branch = await git('git', ['branch', '--show-current'], { cwd: dispatched.worktree })
    assert.equal(branch.stdout.trim(), dispatched.branch, '工作树必须切在记录的分支上')
    assert.equal((await dispatchPrompts(queued.id, ticketId)).length, 1, '补建工作树之后派工 prompt 必须送达')
    assert.notEqual((await db.worker.findById(queued.id)).startedAt, null, '补建工作树之后 Worker 必须真的起过')
    assert.equal((await db.ticket.findById(ticketId)).prepareError, null, '真正派工成功之后票面上不该留准备阶段的错误')
  },
  /** 内部调度只通知编排，不自己建会话：可派工的票投一条通知，被依赖卡住的票不发。 */
  async workerDispatchNotice() {
    const p = await project('dispatch-notice-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const ticketId = 'dispatch-notice-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '可派工只通知编排', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    await workers.reconcile()
    await workers.reconcile()
    const mails = (await db.inbox.listByTicket(ticketId)).filter(row => row.id === `supermesh:dispatch:${ticketId}`)
    assert.equal(mails.length, 1, '可派工的票只能通知编排一次')
    assert.equal(mails[0].type, 'project')
    assert.equal(mails[0].projectId, p.id)
    assert.equal(mails[0].kind, 'ticket')
    assert.equal((await db.worker.listByTicket(ticketId)).length, 0, '内部调度不得自己排队建 Worker')
    assert.equal((await db.ticket.findById(ticketId)).status, 'queued', '通知不等于派工，票还留在 queued')

    const blockedId = 'dispatch-notice-blocked'
    const dependencyId = 'dispatch-notice-dependency'
    for (const id of [blockedId, dependencyId])
      await db.ticket.create({ id, projectId: p.id, channelId: 'github', title: id, description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    await db.ticketLink.link(blockedId, dependencyId, 'depends', now)
    await workers.reconcile()
    assert.equal(await db.inbox.findById(`supermesh:dispatch:${blockedId}`), undefined, '依赖没做完的票不得被通知派工')
    await db.ticket.finish(dependencyId, 'done', now, now)
    await workers.reconcile()
    assert.notEqual(await db.inbox.findById(`supermesh:dispatch:${blockedId}`), undefined, '依赖完成后必须通知一次派工')
  },
  /** 建不出工作树就明确失败：不降级到项目目录，票退回 queued 并让编排看见原因。 */
  async workerDispatchFailure() {
    const p = await project('dispatch-failure-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    // 有仓库但还没有任何提交：git 建不出工作树，派工必须明确失败。
    await git('git', ['init'], { cwd: p.directory })
    const ticketId = 'dispatch-failure-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '建不出工作树就失败', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const queued = await db.worker.queue(ticketId, p.id)
    await workers.reconcile()
    await settle()
    const failed = await db.worker.findById(queued.id)
    assert.equal(failed.status, 'ended', '派工失败必须结束这条 worker 记录')
    assert.equal(failed.endedReason, 'failed')
    assert.equal(failed.branch, null, '失败时不得凭空记下一个分支')
    assert.equal(failed.worktree, null, '失败时不得把项目目录记成工作树')
    const ticket = await db.ticket.findById(ticketId)
    assert.equal(ticket.status, 'queued', '失败后票退回 queued 等编排重派')
    assert.equal(typeof ticket.prepareError === 'string' && ticket.prepareError.length > 0, true, '失败原因必须留在票面上')
    assert.equal((await dispatchPrompts(queued.id, ticketId)).length, 0, '没有工作树就绝不能把派工 prompt 投出去')
    const notice = (await db.inbox.listByTicket(ticketId)).find(row => row.id.startsWith(`supermesh:dispatch-failed:${ticketId}:`))
    assert.equal(notice?.type, 'project', '派工失败必须通知项目编排')
    assert.equal(notice.message.includes(ticket.prepareError), true, '通知里必须带上失败原因')
  },
  /** 会话已经归档、答案再也送不回去：改投项目编排，并说明退回原因。 */
  async answerRelay() {
    const p = await project('relay-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const ticketId = 'relay-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '答案改投编排', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const worker = await db.worker.queue(ticketId, p.id)
    await db.worker.end(worker.id, 'stopped', now)
    const ask = await db.inbox.enqueueAsk({ type: 'main', origin: 'worker', projectId: p.id, ticketId, workerId: worker.id, message: '需要你确认方案' })
    await db.inbox.answerScoped(ask.id, '按 A 方案做', { type: 'main' }, now)
    await inbox.deliverAnswers()
    const relay = await db.inbox.findById(`supermesh:answer-relay:${ask.id}`)
    assert.equal(relay?.type, 'project', 'an answer that cannot reach the archived worker must be relayed to the project orchestrator')
    assert.equal(relay?.projectId, p.id)
    assert.equal(relay?.ticketId, ticketId)
    assert.match(relay.message, /按 A 方案做/)
    assert.match(relay.message, /归档/, 'the relay must say why the answer could not be delivered')
    assert.equal((await db.inbox.findById(ask.id)).deliveryError, null, 'the answered ask must not keep retrying toward the archived worker')
    assert.notEqual((await db.inbox.findById(ask.id)).answerRelayedAt, null, 'a relayed answer must be marked so it is never replayed')
    await inbox.deliverAnswers()
    assert.equal((await db.inbox.listAnswered()).length, 0, 'an already relayed answer must not be queued again on the next pass')
  },
  /**
   * Worker 等答案时这一轮已经结束，但会话还在：答案必须把它重新拉起来送回去，
   * 而不是当成「已结束」丢掉或改投编排。
   */
  async answerResume() {
    const p = await project('answer-resume-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const ticketId = 'answer-resume-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '答案叫醒 Worker', description: null, status: 'idle', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const worker = await db.worker.queue(ticketId, p.id)
    await session.create('worker', { sessionId: worker.id, ticketId, projectId: p.id, directory: p.directory })
    await db.worker.start(worker.id, now)
    await db.ticket.start(ticketId, now, now)
    await session.send(worker.id, `${ticketId}: 执行这张票`, 'queue', 'answer-resume:prompt')
    await settle()
    // Worker 提问后这一轮结束：记录 ended，票退回 idle，会话仍在。
    const ask = await db.inbox.enqueueAsk({ type: 'project', origin: 'worker', projectId: p.id, ticketId, workerId: worker.id, message: '按哪个方案做？' })
    await db.worker.end(worker.id, 'completed', now)
    await db.ticket.update(ticketId, { status: 'idle', updatedAt: now })
    await db.inbox.answerScoped(ask.id, '按 A 方案', { type: 'project', projectId: p.id }, now)
    await inbox.deliverAnswers()
    await settle()
    const history = await session.history(worker.id)
    const texts = history.events.flatMap(event => event.type === 'user/message'
      ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      .flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []))
    assert.equal(texts.some(text => text.includes(`[Answer ${ask.id}] 按 A 方案`)), true, 'the answer must reach the ended but live worker session')
    assert.equal(await db.inbox.findById(`supermesh:answer-relay:${ask.id}`), undefined, 'a live worker session must not fall back to relaying')
    assert.notEqual((await db.inbox.findById(ask.id)).answerRelayedAt, null, 'a delivered answer must be marked so it is never replayed')
    await inbox.deliverAnswers()
    assert.equal((await db.inbox.listAnswered()).length, 0, 'a delivered answer must not be queued again on the next pass')
  },
  /** 对外回复彻底送不出去时，必须让编排知道「这条没送到」，而不是只在行上留个错误码。 */
  async replyFailure() {
    const { setting } = await import('@/service/setting.ts')
    const { courier } = await import('@/service/courier.ts')
    const { ChannelError } = await import('@/channel/_shared/error.ts')
    await setting.save({ deliveryMaxAttempts: 1 })
    const p = await project('reply-failure-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 1, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const threadId = 'github:reply-failure:1'
    await db.thread.record({ id: threadId, channelId: 'github', refId: 'reply-failure:1', kind: 'issue', title: 'Reply failure', url: 'https://github.com/example/reply-failure/issues/1', createdAt: now, updatedAt: now, projectId: p.id, triage: 'claimed', triagedAt: now })
    const triggerId = `${threadId}:comment:1`
    await db.trigger.ingest({ id: triggerId, channelId: 'github', threadId, kind: 'comment', actorName: 'hairyf', human: 1, mentioned: 1, text: '改一下设置页', url: 'https://github.com/example/reply-failure/issues/1#issuecomment-1', at: now, ref: null })
    const row = await db.inbox.enqueue({ id: 'reply:1', type: 'user', origin: 'project', kind: 'notice', projectId: p.id, threadId, triggerId, message: '收到，正在把设置页的保存按钮改名' })
    const port = {
      channel: 'github',
      detail: false,
      skipReasons: [],
      parse: async url => ({ url }),
      projectFor: async () => p,
      probe: async () => {
        throw new ChannelError('forbidden')
      },
      scope: () => 'example/reply-failure',
      comments: async () => [],
      post: async () => {
        throw new Error('a forbidden probe must not post')
      },
      authorId: () => '1',
      body: () => '',
      commentUrl: () => '',
    }
    const result = await courier.publish(port, row.id)
    assert.equal(result.ok, false)
    assert.equal((await db.inbox.findById(row.id)).status, 'stalled', 'a reply that cannot be delivered must end up stalled')
    const notice = await db.inbox.findById(`supermesh:reply-failed:${row.id}`)
    assert.equal(notice?.type, 'project', 'a reply that never reaches the channel must tell the orchestrator')
    assert.equal(notice?.projectId, p.id)
    assert.equal(notice?.kind, 'notice')
    assert.match(notice.message, /收到，正在把设置页的保存按钮改名/, 'the notice must carry the reply that was lost')
    assert.match(notice.message, /forbidden/, 'the notice must carry the failure reason')
  },
  async workerSettlement() {
    const p = await project('settlement-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const ticketId = 'settlement-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '结算通知', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const managerId = await session.create('project', { projectId: p.id })
    const queued = await db.worker.queue(ticketId, p.id)
    await session.create('worker', { sessionId: queued.id, ticketId, projectId: p.id, directory: p.directory })
    await db.worker.start(queued.id, now)
    await db.ticket.start(ticketId, now, now)
    await session.send(queued.id, '执行这张票', 'queue', 'settlement:prompt')
    const notice = await waitFor(() => runtime.proposals
      .filter(item => item.id === managerId)
      .flatMap(item => item.messages)
      .find(message => message.source.kind === 'supermesh-mailbox'))
    await settle()
    const history = await session.history(managerId)
    const durable = history.events.some(event => (event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : []).some(message => message.source.kind === 'supermesh-mailbox'))
    assert.equal(durable, true, 'the settlement notice must be durable')
    assert.equal(notice.content[0].text, '你有1个未处理邮件。用 read_mailbox 读取邮件和项目上下文，处理完成后显式完成邮件。')
    assert.equal(history.events.some(event => (event.type === 'user/message' ? [event.data] : []).some(message => message.content.some(part => part.type === 'text' && part.text.includes('Worker settlement-ticket finished')))), false, 'the closing text must not be pasted into the orchestrator conversation')
    const mail = (await db.inbox.listByTicket(ticketId)).find(row => row.id.startsWith(`supermesh:settlement:${queued.id}:`))
    assert.equal(mail?.type, 'project')
    assert.equal(mail?.projectId, p.id)
    assert.equal(mail?.ticketId, ticketId)
    assert.equal(mail?.workerId, queued.id)
    assert.equal(mail?.kind, 'notice')
    assert.match(mail.message, /Worker settlement-ticket finished/)
    assert.match(mail.message, /It left no closing message/)
    assert.equal((await db.worker.findById(queued.id)).status, 'ended')
    assert.equal((await db.worker.findById(queued.id)).endedReason, 'completed')
    assert.equal((await db.ticket.findById(ticketId)).status, 'idle')
  },
  /**
   * 报 ready 的落点看票有没有变更请求：没有 PR 的票直接 completed，
   * 有 PR 的票进 review 等人审 —— 两种都不该停在 review / idle。
   */
  async workerReadySettlement() {
    const p = await project('ready-settlement-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const run = async (ticketId, prUrl) => {
      await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: ticketId, description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl, prState: null, ciState: null, paused: 0, prepareError: null })
      const worker = await db.worker.queue(ticketId, p.id)
      await session.create('worker', { sessionId: worker.id, ticketId, projectId: p.id, directory: p.directory })
      await db.worker.start(worker.id, now)
      await db.ticket.start(ticketId, now, now)
      const held = runtime.holdPreStep()
      await session.send(worker.id, `${ticketId}: 执行这张票`, 'queue', `ready:${ticketId}`)
      await held.entered
      const outcome = await runtime.ctx.tools.execute({
        calls: [{ type: 'tool-call', id: `call-report-${ticketId}`, name: 'report', arguments: JSON.stringify({ state: 'ready', summary: '做完了' }) }],
        signal: AbortSignal.timeout(15000),
        agent: runtime.ctx.agents.get(SessionId(worker.id)),
      })
      assert.equal(outcome.results[0].result.isError, false, 'the worker report must be recorded')
      held.release()
      await settle()
      return worker
    }

    const completedWorker = await run('ready-without-pr', null)
    const completed = await db.ticket.findById('ready-without-pr')
    assert.equal(completed.status, 'completed', 'ready without a pull request must complete the ticket')
    assert.notEqual(completed.endedAt, null, 'completed is terminal and records its end time')
    assert.equal((await db.worker.findById(completedWorker.id)).status, 'ended')

    const reviewWorker = await run('ready-with-pr', 'https://github.com/example/ready-settlement/pull/7')
    assert.equal((await db.ticket.findById('ready-with-pr')).status, 'review', 'ready with a pull request must wait for review')
    assert.equal((await db.worker.findById(reviewWorker.id)).status, 'ended')
  },
  async answerNotice() {
    const p = await project('answer-notice-project')
    const managerId = await session.create('project', { projectId: p.id })
    const ask = await db.inbox.enqueueAsk({ type: 'main', origin: 'project', projectId: p.id, message: '可以合并吗？' })
    await db.inbox.answerScoped(ask.id, '可以', { type: 'main' }, now)
    await inbox.deliverAnswers()
    await inbox.deliver()
    const notice = await waitFor(() => runtime.proposals
      .filter(item => item.id === managerId)
      .flatMap(item => item.messages)
      .find(message => message.source.kind === 'supermesh-mailbox'))
    await settle()
    assert.equal(notice.content[0].text, '你有1个未处理邮件。用 read_mailbox 读取邮件和项目上下文，处理完成后显式完成邮件。')
    const mail = await db.inbox.findById(`supermesh:answer:${ask.id}`)
    assert.equal(mail?.type, 'project')
    assert.equal(mail?.kind, 'notice')
    assert.equal(mail?.message, '可以')
    assert.equal((await db.inbox.findById(ask.id)).status, 'done')
    const history = await session.history(managerId)
    assert.equal(history.events.some(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text.includes('[Answer'))), false, 'the answer must not be pasted into the orchestrator conversation')
  },
  async channelNotice() {
    const { setting } = await import('@/service/setting.ts')
    await setting.save({ administrators: ['hairyf'] })
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const p = await project('channel-notice-project')
    const threadId = 'github:channel-notice:1'
    const triggerId = `${threadId}:comment:1`
    await db.thread.record({ id: threadId, channelId: 'github', refId: 'channel-notice:1', kind: 'issue', title: 'Channel notice', url: 'https://github.com/example/channel-notice/issues/1', createdAt: now, updatedAt: now, projectId: p.id, triage: 'claimed', triagedAt: now })
    await db.trigger.ingest({ id: triggerId, channelId: 'github', threadId, kind: 'comment', actorName: 'hairyf', human: 1, mentioned: 1, text: 'Private channel body', url: 'https://github.com/example/channel-notice/issues/1#issuecomment-1', at: now, ref: null })
    await db.inbox.enqueue({ id: 'channel-notice-mail', type: 'project', projectId: p.id, origin: 'channel', kind: 'trigger', triggerId, threadId, title: 'Channel notice', message: 'Private channel body' })
    await inbox.deliver()
    const id = (await db.project.findById(p.id)).orchestratorSessionId
    assert.equal(typeof id, 'string')
    await expectWake(id, 1)
    const history = await session.history(id)
    assert.equal(history.events.some(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text.includes('Private channel body'))), false, 'the channel body must not be pasted into the orchestrator conversation')
    const mailbox = await inbox.read(id)
    const mail = mailbox.messages.find(message => message.id === 'channel-notice-mail')
    assert.equal(mail?.message, 'Private channel body')
    assert.equal(mail?.trigger?.actorName, 'hairyf')
    assert.equal(mail?.trigger?.strength, 'explicit')
  },
  async triggerAttribution() {
    const { setting } = await import('@/service/setting.ts')
    const { courier } = await import('@/service/courier.ts')
    const { github } = await import('@/channel/github/channel.ts')
    const { binding } = await import('@/channel/github/service/binding.ts')
    const { recordThread } = await import('@/channel/_shared/thread.ts')
    await setting.save({ administrators: ['hairyf'] })
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const p = await project('attribution-project')
    await db.project.setRemoteUrl(p.id, 'https://github.com/example/attribution', now)
    const issue = (number, repository) => ({ id: number, number, title: `Issue ${number}`, html_url: `https://github.com/${repository}/issues/${number}`, body: '修复一下', user: { login: 'hairyf', type: 'User' }, created_at: now, updated_at: now })
    const baseline = '1970-01-01T00:00:00.000Z'
    const thread = await recordThread({ channel: 'github', refId: 'example/attribution:5', kind: 'issue', title: 'Attribution', url: 'https://github.com/example/attribution/issues/5', createdAt: now, updatedAt: now, projectId: p.id })
    await courier.ingest(binding.of(github).ingestor, thread, issue(5, 'example/attribution'), 'open', baseline, 'open')
    const main = await session.create('main', {})
    const mailbox = await inbox.read(main)
    const mail = mailbox.messages.find(message => message.threadId === thread.id)
    assert.equal(mail?.type, 'main', 'an unclaimed thread still goes to main for triage')
    assert.equal(mail?.projectId, p.id, 'the trigger mail must carry the project its repository maps to')
    assert.equal(mail?.thread?.projectId, p.id)
    assert.equal(mail?.thread?.project?.name, p.name)
    assert.equal(mail?.thread?.repository, 'example/attribution')
    assert.equal(mailbox.projects.find(item => item.id === p.id)?.repository, 'example/attribution', 'projects expose the same normalized repository key as threads')
    // 仓库没有对应项目时邮件里就是空归属：主编排看到的是服务端事实，不需要凭记忆判断。
    const orphan = await recordThread({ channel: 'github', refId: 'example/orphan:6', kind: 'issue', title: 'Orphan', url: 'https://github.com/example/orphan/issues/6', createdAt: now, updatedAt: now })
    await courier.ingest(binding.of(github).ingestor, orphan, issue(6, 'example/orphan'), 'open', baseline, 'open')
    const orphanMail = (await inbox.read(main)).messages.find(message => message.threadId === orphan.id)
    assert.equal(orphanMail?.projectId, null)
    assert.equal(orphanMail?.thread?.project, null)
    assert.equal(orphanMail?.thread?.repository, 'example/orphan')
  },
  async selfTrigger() {
    const { courier } = await import('@/service/courier.ts')
    const { triggerStrength } = await import('@/service/admission.ts')
    const { github } = await import('@/channel/github/channel.ts')
    const { binding } = await import('@/channel/github/service/binding.ts')
    const { recordThread } = await import('@/channel/_shared/thread.ts')
    await db.channel.saveConfiguration('github', 'GitHub', 'https://github.com', false, { commitName: 'Supermesh bot', commitEmail: 'bot@example.invalid' }, { name: 'hairyfbot', avatar: null })
    const p = await project('self-trigger-project')
    await db.project.setRemoteUrl(p.id, 'https://github.com/example/self-trigger', now)
    const baseline = '1970-01-01T00:00:00.000Z'
    const issue = number => ({ id: 9000 + number, number, title: `Issue ${number}`, html_url: `https://github.com/example/self-trigger/issues/${number}`, body: '主编排在别的仓库自己开的 issue', user: { login: 'hairyfbot', type: 'User' }, created_at: now, updated_at: now })
    const thread = await recordThread({ channel: 'github', refId: 'example/self-trigger:1', kind: 'issue', title: 'Self opened', url: 'https://github.com/example/self-trigger/issues/1', createdAt: now, updatedAt: now, projectId: p.id })
    await db.thread.claim(thread.id, p.id, now)
    const claimed = await db.thread.findById(thread.id)
    await courier.ingest(binding.of(github).ingestor, claimed, issue(1), 'open', baseline, 'open')
    const triggerId = `${thread.id}:open:9001`
    const trigger = await db.trigger.findById(triggerId)
    assert.equal(trigger?.actorName, 'hairyfbot')
    assert.equal(trigger?.human, 0)
    assert.equal(await triggerStrength(trigger), 'self')
    const mail = await db.inbox.findById(`${triggerId}:inbox:main`)
    assert.equal(mail?.type, 'main', 'a self opened issue must reach main even when the thread is already claimed')
    assert.equal(mail?.projectId, p.id, 'the mail still carries the project matched by its repository')
    await inbox.deliver()
    const mainId = await session.findMain()
    await expectWake(mainId, 1)
    const mailbox = await inbox.read(mainId)
    assert.equal(mailbox.messages.find(message => message.id === `${triggerId}:inbox:main`)?.trigger?.strength, 'self')
    const main = await session.activate(mainId)
    const outcome = await runtime.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'call-self-ticket', name: 'create_ticket', arguments: JSON.stringify({ title: '自己开的 issue 直接建票', projectId: p.id, threadIds: [thread.id] }) }],
      signal: AbortSignal.timeout(15000),
      agent: main,
    })
    assert.equal(outcome.results[0].result.isError, false, 'self strength must pass the create_ticket gate')
    const ticket = (await db.ticket.listAll()).find(row => row.projectId === p.id)
    assert.equal(typeof ticket?.id, 'string')
    assert.equal((await db.ticketThread.listTicketIds(thread.id)).includes(ticket.id), true)
    const comment = await recordThread({ channel: 'github', refId: 'example/self-trigger:2', kind: 'issue', title: 'Self comment', url: 'https://github.com/example/self-trigger/issues/2', createdAt: now, updatedAt: now, projectId: p.id })
    const commentRow = { id: 9102, body: '自己补一条评论', html_url: `${comment.url}#issuecomment-9102`, user: { login: 'hairyfbot', type: 'User' }, created_at: now, updated_at: now }
    await courier.ingest(binding.of(github).ingestor, comment, commentRow, 'comment', baseline, 'comment')
    const commentTriggerId = `${comment.id}:comment:9102`
    assert.equal(await db.trigger.exists(commentTriggerId), true)
    assert.equal(await triggerStrength(await db.trigger.findById(commentTriggerId)), 'inferred')
    assert.equal(await db.inbox.findById(`${commentTriggerId}:inbox:main`), undefined, 'a bot comment must not wake main')
    assert.equal(await db.inbox.findById(`${commentTriggerId}:inbox:project`), undefined)
    await courier.ingest(binding.of(github).ingestor, thread, { ...issue(1), id: 9201, body: '票建好之后再评论' }, 'comment', baseline, 'comment')
    assert.equal(await db.inbox.findById(`${thread.id}:comment:9201:inbox:main`), undefined, 'an already subscribed thread must not let a self comment through')
  },
  async cancelledThread() {
    const { setting } = await import('@/service/setting.ts')
    const { courier } = await import('@/service/courier.ts')
    const { github } = await import('@/channel/github/channel.ts')
    const { binding } = await import('@/channel/github/service/binding.ts')
    const { recordThread } = await import('@/channel/_shared/thread.ts')
    await setting.save({ administrators: ['hairyf'] })
    await db.channel.saveConfiguration('github', 'GitHub', 'https://github.com', false, { commitName: 'Supermesh bot', commitEmail: 'bot@example.invalid' }, { name: 'hairyfbot', avatar: null })
    const p = await project('cancelled-thread-project')
    await db.project.setRemoteUrl(p.id, 'https://github.com/example/cancelled-thread', now)
    const baseline = '1970-01-01T00:00:00.000Z'
    const thread = await recordThread({ channel: 'github', refId: 'example/cancelled-thread:1', kind: 'issue', title: 'Cancelled thread', url: 'https://github.com/example/cancelled-thread/issues/1', createdAt: now, updatedAt: now, projectId: p.id })
    await db.thread.claim(thread.id, p.id, now)
    const cancelledId = 'cancelled-thread-ticket'
    await db.ticket.create({ id: cancelledId, projectId: p.id, channelId: 'github', title: '被人叫停的活', description: null, status: 'cancelled', createdAt: now, updatedAt: now, startedAt: now, endedAt: now, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    await db.ticketThread.link(cancelledId, thread.id, now)
    const comment = (id, login, body, type = 'User') => ({ id, body, html_url: `${thread.url}#issuecomment-${id}`, user: { login, type }, created_at: now, updated_at: now })
    const ingestor = binding.of(github).ingestor
    // 人叫停的票保留订阅，但那条线已经停了：票收不到东西，人的话要回到主编排重新分诊。
    await courier.ingest(ingestor, thread, comment(7001, 'hairyf', '这个再开一下'), 'comment', baseline, 'comment')
    const humanTrigger = `${thread.id}:comment:7001`
    assert.notEqual(await db.inbox.findById(`${humanTrigger}:inbox:main`), undefined, 'a human comment on a cancelled thread must reach main for triage')
    assert.equal(await db.inbox.findById(`${humanTrigger}:inbox:${p.id}`), undefined, 'a cancelled ticket must not receive the trigger')
    assert.deepEqual(await db.inbox.listByTicket(cancelledId), [], 'a cancelled ticket must stay silent')
    assert.equal((await db.ticketThread.listFollowers(thread.id)).some(row => row.ticketId === cancelledId), true, 'a cancelled ticket keeps its subscription')
    // 机器人说话只作上下文：已取消的票收不到，也不叫醒主编排。
    await courier.ingest(ingestor, thread, comment(7002, 'ci-bot', '构建完成', 'Bot'), 'comment', baseline, 'comment')
    assert.equal(await db.inbox.findById(`${thread.id}:comment:7002:inbox:main`), undefined, 'a bot comment must not wake main')
    assert.equal(await db.inbox.findById(`${thread.id}:comment:7002:inbox:${p.id}`), undefined)
    // 主编排重新接受这条话题：分诊和建票都不再被已取消的票挡住。
    const main = await session.activate(await session.create('main', {}))
    const triage = await runtime.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'call-cancelled-triage', name: 'triage_thread', arguments: JSON.stringify({ threadId: thread.id, action: 'claim', projectId: p.id }) }],
      signal: AbortSignal.timeout(15000),
      agent: main,
    })
    assert.equal(triage.results[0].result.isError, false, `triage_thread must accept a thread whose only ticket was cancelled: ${JSON.stringify(triage.results[0].result)}`)
    // 触发来源那条仍然摘不掉，但要说清原因和出路，而不是一个互不相干的错。
    const unlink = await runtime.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'call-cancelled-unlink', name: 'unlink_thread', arguments: JSON.stringify({ ticketId: cancelledId, threadId: thread.id, reason: '想挂到新票上' }) }],
      signal: AbortSignal.timeout(15000),
      agent: main,
    })
    assert.equal(unlink.results[0].result.isError, true, 'the trigger source stays attached to the ticket it came from')
    assert.match(JSON.stringify(unlink.results[0].result), /另开一张票/)
    const created = await runtime.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'call-cancelled-ticket', name: 'create_ticket', arguments: JSON.stringify({ title: '重新开工', projectId: p.id, threadIds: [thread.id] }) }],
      signal: AbortSignal.timeout(15000),
      agent: main,
    })
    assert.equal(created.results[0].result.isError, false, `create_ticket must accept a thread whose only ticket was cancelled: ${JSON.stringify(created.results[0].result)}`)
    const reopened = (await db.ticketThread.listFollowers(thread.id)).filter(row => row.status !== 'cancelled')
    assert.equal(reopened.length, 1, 'the new ticket must be the only live subscription')
    const reopenedId = reopened[0].ticketId
    assert.notEqual(reopenedId, cancelledId)
    // 新票跟着之后，同一条话题上的话回到项目编排；重复建票和重新分诊都被这张活票挡住。
    await courier.ingest(ingestor, thread, comment(7003, 'hairyf', '按刚才说的改'), 'comment', baseline, 'comment')
    const followMail = await db.inbox.findById(`${thread.id}:comment:7003:inbox:${p.id}`)
    assert.equal(followMail?.ticketId, reopenedId, 'a live ticket must take the thread back')
    const duplicate = await runtime.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'call-cancelled-duplicate', name: 'create_ticket', arguments: JSON.stringify({ title: '再来一张', projectId: p.id, threadIds: [thread.id] }) }],
      signal: AbortSignal.timeout(15000),
      agent: main,
    })
    assert.equal(duplicate.results[0].result.isError, true, 'a live ticket must still block a duplicate ticket')
    assert.match(JSON.stringify(duplicate.results[0].result), new RegExp(reopenedId))
    const retriage = await runtime.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'call-cancelled-retriage', name: 'triage_thread', arguments: JSON.stringify({ threadId: thread.id, action: 'claim', projectId: p.id }) }],
      signal: AbortSignal.timeout(15000),
      agent: main,
    })
    assert.equal(retriage.results[0].result.isError, true, 'a live ticket must still block re-triage')
    assert.match(JSON.stringify(retriage.results[0].result), new RegExp(reopenedId))
  },
  async supervisorOpen() {
    const p = await project('supervisor-open-project')
    await db.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 0, host: null, createdAt: now }).onConflict(oc => oc.column('id').doNothing()).execute()
    const ticketId = 'supervisor-open-ticket'
    await db.ticket.create({ id: ticketId, projectId: p.id, channelId: 'github', title: '跨项目协调', description: null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null })
    const mainId = await session.create('main', {})
    const main = await session.activate(mainId)
    await runtime.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'call-supervisor', name: 'create_supervisor', arguments: JSON.stringify({ title: '跨项目协调', reason: '两个仓库互相等', ticketIds: [ticketId] }) }],
      signal: AbortSignal.timeout(15000),
      agent: main,
    })
    const supervisor = (await db.supervisor.listActive()).find(row => row.title === '跨项目协调')
    assert.equal(typeof supervisor?.sessionId, 'string')
    const notice = await waitFor(() => runtime.proposals
      .filter(item => item.id === supervisor.sessionId)
      .flatMap(item => item.messages)
      .find(message => message.source.kind === 'supermesh-mailbox'))
    await settle()
    assert.equal(notice.content[0].text, '你有1个未处理邮件。用 read_mailbox 读取邮件和项目上下文，处理完成后显式完成邮件。')
    const mail = (await db.inbox.listScoped({ type: 'supervisor', supervisorId: supervisor.id }))[0]
    assert.equal(mail?.kind, 'notice')
    assert.match(mail.message, /两个仓库互相等/)
    assert.match(mail.message, new RegExp(ticketId))
    const history = await session.history(supervisor.sessionId)
    assert.equal(history.events.some(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text.includes('两个仓库互相等'))), false, 'the opening payload must not be pasted into the supervisor conversation')
  },
}

try {
  const manifest = require('@deepseek-ai/dsh/package.json')
  assert.equal(manifest.name, '@deepseek-ai/dsh')
  assert.equal(process.cwd(), process.env.SUPERMESH_TEST_CWD)
  assert.equal(process.env.DSH_HOME, join(process.cwd(), 'home'))
  assert.equal(Object.hasOwn(cases, process.argv[2]), true, 'unknown integration case')
  runtime = await start()
  await cases[process.argv[2]]()
  process.stdout.write(`SUPERMESH_RUNTIME_PASS ${process.argv[2]} DSH=${manifest.version}\n`)
}
finally {
  if (runtime)
    await runtime.close()
  await storage.dispose()
  await db.destroy()
}
