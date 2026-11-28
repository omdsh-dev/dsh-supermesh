import type { Insertable, Kysely, Selectable, SelectQueryBuilder, Updateable } from 'kysely'
import type { CiState, DB, PullRequestState, TicketStatus } from '@/database/types'
import { Model } from 'kysely-model'
import { Inbox } from '@/database/models/inbox'

const CLOSED_STATUS: readonly TicketStatus[] = ['done', 'completed', 'cancelled']
const closedName = (threadId: string): string => `thread_closed:${threadId}`
let creation: Promise<unknown> = Promise.resolve()

export class Ticket extends Model<DB, 'ticket'> {
  constructor(db: Kysely<DB>) {
    super(db, 'ticket', 'id')
  }

  async listByProject(projectId: string, status?: TicketStatus): Promise<Selectable<DB['ticket']>[]> {
    const query = this.db
      .selectFrom('ticket')
      .selectAll()
      .where('projectId', '=', projectId)
    const scoped = status ? query.where('status', '=', status) : query
    return scoped.orderBy('updatedAt', 'desc').execute()
  }

  async listOpen(): Promise<Selectable<DB['ticket']>[]> {
    return this.db
      .selectFrom('ticket')
      .selectAll()
      .where('status', 'not in', [...CLOSED_STATUS])
      .orderBy('updatedAt', 'desc')
      .execute()
  }

  async countRunning(): Promise<number> {
    const row = await this.db
      .selectFrom('ticket')
      .select(this.db.fn.countAll<number>().as('count'))
      .where('status', '=', 'running')
      .executeTakeFirst()
    return Number(row?.count ?? 0)
  }

  async start(id: string, startedAt: string, updatedAt: string): Promise<void> {
    await this.db
      .updateTable('ticket')
      .set({ status: 'running', startedAt, updatedAt })
      .where('id', '=', id)
      .where('status', 'not in', [...CLOSED_STATUS])
      .where(eb => eb.or([eb('prState', 'is', null), eb('prState', 'not in', ['merged', 'closed'])]))
      .execute()
  }

  async finish(id: string, status: TicketStatus, endedAt: string, updatedAt: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('ticket')
        .set({ status, endedAt, updatedAt, prepareError: null })
        .where('id', '=', id)
        .execute()
      await trx
        .updateTable('inbox')
        .set({ status: 'done', doneAt: endedAt })
        .where('ticketId', '=', id)
        .where('kind', '=', 'ask')
        .where('status', 'in', ['pending', 'stalled'])
        .execute()
    })
  }

  /** 按已挂上的变更请求反查票：采集侧靠它把 PR 话题接回票，不再依赖分支名。 */
  async listByPullRequest(projectId: string, prUrl: string): Promise<Selectable<DB['ticket']>[]> {
    return this.db
      .selectFrom('ticket')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('prUrl', '=', prUrl)
      .execute()
  }

  /** 票是否已经归属某个变更请求：prUrl 或任一 PR 话题都算。ready 时据此决定 review 还是 completed。 */
  async hasPullRequest(id: string): Promise<boolean> {
    const ticket = await this.findById(id)
    if (!ticket)
      return false
    return Boolean(ticket.prUrl) || (await this.pullThreads(id)).length > 0
  }

  async setPullRequest(id: string, prUrl: string | null, prState: PullRequestState | null, ciState: CiState | null): Promise<void> {
    await this.db
      .updateTable('ticket')
      .set({ prUrl, prState, ciState })
      .where('id', '=', id)
      .execute()
  }

  async setPaused(id: string, paused: boolean, updatedAt: string): Promise<void> {
    await this.db
      .updateTable('ticket')
      .set({ paused: paused ? 1 : 0, updatedAt })
      .where('id', '=', id)
      .execute()
  }

  async setPrepareError(id: string, prepareError: string | null, updatedAt: string): Promise<void> {
    await this.db
      .updateTable('ticket')
      .set({ prepareError, updatedAt })
      .where('id', '=', id)
      .where('status', 'not in', [...CLOSED_STATUS])
      .execute()
  }

  /**
   * 内部调度推进票的状态。票进了终态就不能再被后台路径写回非终态：
   * 停止是人的决定，派工、回收、结算都不能把它重新拉起。
   *
   * @returns 是否真的写入了（票已结束时为 false）。
   */
  async setOpenStatus(id: string, status: TicketStatus, updatedAt: string): Promise<boolean> {
    const result = await this.db
      .updateTable('ticket')
      .set({ status, updatedAt })
      .where('id', '=', id)
      .where('status', 'not in', [...CLOSED_STATUS])
      .executeTakeFirst()
    return Number(result.numUpdatedRows ?? 0) > 0
  }

  async save(id: string, patch: Updateable<DB['ticket']>): Promise<void> {
    await this.db
      .updateTable('ticket')
      .set(patch)
      .where('id', '=', id)
      .execute()
  }

  async findById(id: string): Promise<Selectable<DB['ticket']> | undefined> {
    return this.db.selectFrom('ticket').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async listRecent(limit = 100): Promise<Selectable<DB['ticket']>[]> {
    return this.db.selectFrom('ticket').selectAll().orderBy('createdAt', 'desc').orderBy('id').limit(Math.max(1, Math.min(1000, limit))).execute()
  }

  findManyQuery(): SelectQueryBuilder<DB, 'ticket', Selectable<DB['ticket']>> {
    return this.db.selectFrom('ticket').selectAll().orderBy('createdAt', 'desc').orderBy('id')
  }

  async findManyPage(page = 1, pageSize = 8): Promise<{ data: Selectable<DB['ticket']>[], total: number }> {
    const size = Math.max(1, Math.min(100, pageSize))
    const offset = (Math.max(1, page) - 1) * size
    const base = this.findManyQuery()
    const [counted, data] = await Promise.all([
      base.clearSelect().select(this.db.fn.count('ticket.id').as('count')).executeTakeFirst(),
      base.limit(size).offset(offset).execute(),
    ])
    return { data, total: Number(counted?.count ?? 0) }
  }

  /** 全量票，供统计类接口使用；不受分页上限影响。 */
  async listAll(): Promise<Selectable<DB['ticket']>[]> {
    return this.findManyQuery().execute()
  }

  async listFiltered(filters: { projectId?: string, status?: TicketStatus, attentionOnly?: boolean, supervisorId?: string } = {}): Promise<(Selectable<DB['ticket']> & { attention: boolean | number })[]> {
    let query = this.db.selectFrom('ticket').selectAll('ticket').select(eb => eb.exists(eb.selectFrom('inbox').select('id').whereRef('inbox.ticketId', '=', 'ticket.id').where('kind', '=', 'ask').where('inbox.status', '=', 'pending')).as('attention'))
    if (filters.projectId)
      query = query.where('ticket.projectId', '=', filters.projectId)
    if (filters.status)
      query = query.where('ticket.status', '=', filters.status)
    else query = query.where('ticket.status', 'not in', [...CLOSED_STATUS])
    if (filters.attentionOnly)
      query = query.where(eb => eb.exists(eb.selectFrom('inbox').select('id').whereRef('inbox.ticketId', '=', 'ticket.id').where('kind', '=', 'ask').where('inbox.status', '=', 'pending')))
    if (filters.supervisorId)
      query = query.where(eb => eb.exists(eb.selectFrom('supervisor_ticket').select('ticketId').whereRef('supervisor_ticket.ticketId', '=', 'ticket.id').where('supervisorId', '=', filters.supervisorId!)))
    return query.orderBy('ticket.createdAt').orderBy('ticket.id').execute()
  }

  async createWithThreads(projectId: string, title: string, threadIds: string[], description?: string): Promise<Selectable<DB['ticket']>> {
    if (!threadIds.length)
      throw new Error('至少需要一条来源话题')
    const operation = creation.then(() => this.db.transaction().execute(async (trx) => {
      const project = await trx.selectFrom('project').selectAll().where('id', '=', projectId).executeTakeFirst()
      if (!project)
        throw new Error('项目不存在')
      const ids = [...new Set(threadIds)]
      const threads = await trx.selectFrom('thread').selectAll().where('id', 'in', ids).execute()
      if (threads.length !== ids.length)
        throw new Error('来源话题不存在')
      // 去重限同一项目内：同一话题在同一项目里重复建票是噪音，
      // 但跨项目共用同一话题是正常协调（flow.md：一条话题可以同时被两个项目的票跟着）。
      // 人叫停的票不占话题：那里的新活本来就该另开一张票。
      const duplicate = await trx
        .selectFrom('ticket_thread')
        .innerJoin('ticket', 'ticket.id', 'ticket_thread.ticketId')
        .select(['ticket_thread.ticketId', 'ticket.status'])
        .where('ticket_thread.threadId', 'in', ids)
        .where('ticket.projectId', '=', projectId)
        .where('ticket.status', '!=', 'cancelled')
        .executeTakeFirst()
      if (duplicate)
        throw new Error(`来源话题已关联工单：${duplicate.ticketId}（${duplicate.status}）`)
      const now = new Date().toISOString()
      const previous = await trx.selectFrom('ticket').select('id').execute()
      const highest = previous.reduce((max, row) => {
        const match = /^T-(\d+)$/.exec(row.id)
        return match ? Math.max(max, Number(match[1])) : max
      }, 0)
      let sequence = highest
      let id = `T-${String(sequence + 1).padStart(3, '0')}`
      while (await trx.selectFrom('ticket').select('id').where('id', '=', id).executeTakeFirst()) {
        sequence++
        id = `T-${String(sequence + 1).padStart(3, '0')}`
      }
      const row: Insertable<DB['ticket']> = { id, projectId, channelId: threads.find(row => row.id === ids[0])!.channelId, title, description: description ?? null, status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, prepareError: null }
      await trx.insertInto('ticket').values(row).execute()
      // 建票即确定归属：话题若还停在 pending，投递给项目编排时就绕过了主编排的 claim，
      // 界面会一直显示"未分诊"。这里补上归属，与 flow.md 的 triage=claimed 对齐。
      await trx.updateTable('thread').set({ projectId, triage: 'claimed', triagedAt: now }).where('id', 'in', ids).where('triage', '=', 'pending').execute()
      for (const [index, threadId] of ids.entries()) await trx.insertInto('ticket_thread').values({ ticketId: id, threadId, createdAt: new Date(Date.parse(now) + index).toISOString() }).execute()
      return (await new Ticket(trx).findById(id))!
    }))
    creation = operation.catch(() => undefined)
    return operation
  }

  async requireOpen(id: string, projectId?: string): Promise<Selectable<DB['ticket']>> {
    const row = await this.findById(id)
    if (!row || (projectId !== undefined && row.projectId !== projectId))
      throw new Error('工单不存在或不属于当前项目')
    if (CLOSED_STATUS.includes(row.status))
      throw new Error('工单已结束')
    return row
  }

  /**
   * 人在这条话题上又说话了，把做完的票唤醒。
   * 人叫停的票不在此列 —— 停止是人的决定，那里的新活要重新分诊，不能被一句 @ 唤醒。
   *
   * @returns 是否真的唤醒（票不是 done / completed 时为 false）。
   */
  async revive(id: string, updatedAt: string): Promise<boolean> {
    const result = await this.db
      .updateTable('ticket')
      .set({ status: 'queued', endedAt: null, updatedAt })
      .where('id', '=', id)
      .where('status', 'in', ['done', 'completed'])
      .executeTakeFirst()
    return Number(result.numUpdatedRows ?? 0) > 0
  }

  async closeThread(threadId: string, outcome: 'merged' | 'closed', at: string): Promise<string[]> {
    const thread = await this.db.selectFrom('thread').selectAll().where('id', '=', threadId).executeTakeFirst()
    if (!thread?.url || thread.kind !== 'pull')
      return []
    await this.threadClosed(thread, outcome, at)
    const ended: string[] = []
    for (const { ticketId } of await this.db.selectFrom('ticket_thread').select('ticketId').where('threadId', '=', threadId).orderBy('createdAt').execute()) {
      const row = await this.findById(ticketId)
      if (!row || CLOSED_STATUS.includes(row.status))
        continue
      // 归属只认票上记下的 prUrl：分支名不参与匹配，挂着别的 PR 的票不受这条话题影响。
      if (row.prUrl && row.prUrl !== thread.url)
        continue
      if (row.prUrl === thread.url)
        await this.setPullRequest(ticketId, thread.url, outcome, row.ciState)
      const ticket = (await this.findById(ticketId))!
      const closed = await this.followsDone(ticket)
      if (!closed || await this.unfinished(ticketId, at))
        continue
      await this.end(ticket, closed.outcome, closed.at)
      ended.push(ticketId)
    }
    return ended
  }

  async endOnReport(ticketId: string, at: string): Promise<boolean> {
    const ticket = await this.findById(ticketId)
    if (!ticket || CLOSED_STATUS.includes(ticket.status))
      return false
    const closed = await this.followsDone(ticket)
    if (!closed)
      return false
    await this.end(ticket, closed.outcome, at)
    return true
  }

  private async end(ticket: Selectable<DB['ticket']>, outcome: 'merged' | 'closed', at: string): Promise<void> {
    await this.finish(ticket.id, 'done', at, new Date().toISOString())
    const message = `${ticket.id} 的变更请求已${outcome === 'merged' ? '合并' : '关闭'}：${ticket.prUrl ?? ticket.id}`
    for (const type of ['project', 'main'] as const)
      await new Inbox(this.db).enqueue({ id: `supermesh:${outcome}:${ticket.id}:${type}`, type, origin: 'system', kind: 'notice', projectId: ticket.projectId, ticketId: ticket.id, title: outcome === 'merged' ? 'PR merged' : 'PR closed', message })
  }

  private async threadClosed(thread: Selectable<DB['thread']>, outcome: 'merged' | 'closed', at: string): Promise<void> {
    const updatedAt = new Date().toISOString()
    const value = JSON.stringify({ at, outcome })
    await this.db
      .insertInto('source_state')
      .values({ channelId: thread.channelId, name: closedName(thread.id), value, updatedAt })
      .onConflict(oc => oc.columns(['channelId', 'name']).doUpdateSet({ value, updatedAt }))
      .execute()
  }

  private async followsDone(ticket: Selectable<DB['ticket']>): Promise<{ at: string, outcome: 'merged' | 'closed' } | undefined> {
    const threads = await this.pullThreads(ticket.id)
    const own = threads.filter(thread => thread.url === ticket.prUrl)
    const counted = own.length ? own : threads
    if (!counted.length)
      return undefined
    const closes: { at: string, outcome: 'merged' | 'closed' }[] = []
    for (const thread of counted) {
      const closed = await this.threadClosedAt(thread)
      if (!closed)
        return undefined
      closes.push(closed)
    }
    return closes.sort((left, right) => left.at.localeCompare(right.at)).at(-1)
  }

  private async threadClosedAt(thread: Selectable<DB['thread']>): Promise<{ at: string, outcome: 'merged' | 'closed' } | undefined> {
    const row = await this.db.selectFrom('source_state').select('value').where('channelId', '=', thread.channelId).where('name', '=', closedName(thread.id)).executeTakeFirst()
    return row ? JSON.parse(row.value) as { at: string, outcome: 'merged' | 'closed' } : undefined
  }

  private async pullThreads(ticketId: string): Promise<Selectable<DB['thread']>[]> {
    return this.db
      .selectFrom('ticket_thread')
      .innerJoin('thread', 'thread.id', 'ticket_thread.threadId')
      .selectAll('thread')
      .where('ticket_thread.ticketId', '=', ticketId)
      .where('thread.kind', '=', 'pull')
      .orderBy('ticket_thread.createdAt')
      .execute()
  }

  private async unfinished(ticketId: string, at: string): Promise<boolean> {
    const worker = await this.latestWorker(ticketId)
    if (!worker || !((worker.startedAt ?? worker.createdAt) > at))
      return false
    return !['ready', 'dropped'].includes(worker.reportState ?? '')
  }

  private async latestWorker(ticketId: string): Promise<Selectable<DB['worker']> | undefined> {
    return this.db.selectFrom('worker').selectAll().where('ticketId', '=', ticketId).orderBy('createdAt', 'desc').orderBy('id', 'desc').executeTakeFirst()
  }

  async setPausedIfOpen(id: string, paused: boolean, updatedAt: string): Promise<Selectable<DB['ticket']> | undefined> {
    return this.db.updateTable('ticket').set({ paused: paused ? 1 : 0, updatedAt }).where('id', '=', id).where('status', 'not in', [...CLOSED_STATUS]).returningAll().executeTakeFirst()
  }
}
