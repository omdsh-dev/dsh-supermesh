import type { Kysely, Selectable } from 'kysely'
import type { DB, TicketStatus } from '@/database/types'

export class TicketThread {
  private readonly db: Kysely<DB>

  constructor(db: Kysely<DB>) {
    this.db = db
  }

  async listByTicket(ticketId: string): Promise<Selectable<DB['ticket_thread']>[]> {
    return this.db
      .selectFrom('ticket_thread')
      .selectAll()
      .where('ticketId', '=', ticketId)
      .orderBy('createdAt')
      .execute()
  }

  async listByThread(threadId: string): Promise<Selectable<DB['ticket_thread']>[]> {
    return this.db
      .selectFrom('ticket_thread')
      .selectAll()
      .where('threadId', '=', threadId)
      .orderBy('createdAt')
      .execute()
  }

  /**
   * 话题的订阅票及其状态。
   *
   * 人叫停的票订阅是死的：人收回了授权，那里既收不到消息也不会被唤醒。
   * 判断一条话题还有没有活票跟着只看这一列 —— 只剩已取消的票时，话题等于没有票跟着。
   */
  async listFollowers(threadId: string): Promise<{ ticketId: string, status: TicketStatus }[]> {
    return this.db
      .selectFrom('ticket_thread')
      .innerJoin('ticket', 'ticket.id', 'ticket_thread.ticketId')
      .select(['ticket_thread.ticketId', 'ticket.status'])
      .where('ticket_thread.threadId', '=', threadId)
      .orderBy('ticket_thread.createdAt')
      .execute()
  }

  async listTicketIds(threadId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('ticket_thread')
      .select('ticketId')
      .where('threadId', '=', threadId)
      .orderBy('createdAt')
      .execute()
    return rows.map(row => row.ticketId)
  }

  async link(ticketId: string, threadId: string, createdAt: string): Promise<boolean> {
    const result = await this.db
      .insertInto('ticket_thread')
      .values({ ticketId, threadId, createdAt })
      .onConflict(oc => oc.columns(['ticketId', 'threadId']).doNothing())
      .executeTakeFirst()
    return Number(result.numInsertedOrUpdatedRows) > 0
  }

  async unlink(ticketId: string, threadId: string): Promise<void> {
    await this.db
      .deleteFrom('ticket_thread')
      .where('ticketId', '=', ticketId)
      .where('threadId', '=', threadId)
      .execute()
  }

  async listAll(): Promise<Selectable<DB['ticket_thread']>[]> {
    return this.db.selectFrom('ticket_thread').selectAll().orderBy('createdAt').execute()
  }
}
