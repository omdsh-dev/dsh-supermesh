import type { DB } from '@/database/types'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteDialect } from '@fileshed/kysely-node-sqlite'
import { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '@/database/migrations'
import { Ticket } from '@/database/models/ticket'
import { Worker } from '@/database/models/worker'

let native: DatabaseSync
let connection: Kysely<DB>
let ticket: Ticket
let worker: Worker
const at = '2026-01-01T00:00:00.000Z'
const later = '2026-01-01T00:00:01.000Z'

beforeEach(async () => {
  native = new DatabaseSync(':memory:')
  for (const sql of Object.values(migrations))
    native.exec(sql)
  connection = new Kysely<DB>({ dialect: new NodeSqliteDialect({ database: native }) })
  ticket = new Ticket(connection)
  worker = new Worker(connection)
  await connection.insertInto('channel').values({ id: 'github', name: 'GitHub', enabled: 1, host: null, createdAt: at }).execute()
  await connection.insertInto('project').values({ id: 'p1', name: 'p1', workspaceId: 'w-p1', directory: '/repo/p1', remoteUrl: 'https://github.com/owner/repo', enabled: 1, orchestratorSessionId: null, createdAt: at, updatedAt: at }).execute()
  await connection.insertInto('ticket').values([
    { id: 'T-001', projectId: 'p1', channelId: 'github', title: 'cancelled', description: null, status: 'cancelled', createdAt: at, updatedAt: at, startedAt: null, endedAt: at, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null },
    { id: 'T-002', projectId: 'p1', channelId: 'github', title: 'done', description: null, status: 'done', createdAt: at, updatedAt: at, startedAt: null, endedAt: at, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null },
    { id: 'T-003', projectId: 'p1', channelId: 'github', title: 'queued', description: null, status: 'queued', createdAt: at, updatedAt: at, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null },
  ]).execute()
  await connection.insertInto('thread').values([
    { id: 'github:1', channelId: 'github', projectId: 'p1', refId: 'owner/repo:1', kind: 'issue', title: 'cancelled source', url: 'https://github.com/owner/repo/issues/1', createdAt: at, updatedAt: at, triage: 'claimed', triagedAt: at },
    { id: 'github:2', channelId: 'github', projectId: 'p1', refId: 'owner/repo:2', kind: 'issue', title: 'live source', url: 'https://github.com/owner/repo/issues/2', createdAt: at, updatedAt: at, triage: 'claimed', triagedAt: at },
  ]).execute()
})
afterEach(async () => connection.destroy())

describe('内部调度推进票状态', () => {
  it('人叫停的票不会被后台路径写回非终态', async () => {
    expect(await ticket.setOpenStatus('T-001', 'queued', later)).toBe(false)
    expect(await ticket.findById('T-001')).toMatchObject({ status: 'cancelled', endedAt: at })
  })

  it('做完的票同样保持终态', async () => {
    expect(await ticket.setOpenStatus('T-002', 'queued', later)).toBe(false)
    expect((await ticket.findById('T-002'))?.status).toBe('done')
  })

  it('还开着的票照常推进', async () => {
    expect(await ticket.setOpenStatus('T-003', 'queued', later)).toBe(true)
    expect(await ticket.findById('T-003')).toMatchObject({ status: 'queued', updatedAt: later })
  })

  it('准备阶段的失败原因不写到已结束的票上', async () => {
    await ticket.setPrepareError('T-001', 'worktree_failed', later)
    expect((await ticket.findById('T-001'))?.prepareError).toBeNull()
  })
})

describe('人新的 @ 唤醒票', () => {
  it('只有做完的票会被唤醒', async () => {
    expect(await ticket.revive('T-002', later)).toBe(true)
    expect(await ticket.findById('T-002')).toMatchObject({ status: 'queued', endedAt: null })
  })

  it('人叫停的票保持结束', async () => {
    expect(await ticket.revive('T-001', later)).toBe(false)
    expect((await ticket.findById('T-001'))?.status).toBe('cancelled')
  })
})

describe('话题上的重复建票', () => {
  it('人叫停的票不占话题，同一话题可以另开一张', async () => {
    await connection.insertInto('ticket_thread').values({ ticketId: 'T-001', threadId: 'github:1', createdAt: at }).execute()
    const created = await ticket.createWithThreads('p1', '重新开工', ['github:1'])
    expect(created).toMatchObject({ status: 'queued', title: '重新开工' })
    expect(await connection.selectFrom('ticket_thread').select('ticketId').where('threadId', '=', 'github:1').orderBy('createdAt').execute()).toEqual([{ ticketId: 'T-001' }, { ticketId: created.id }])
  })

  it('还活着的票挡住重复建票，并说明是哪一张', async () => {
    await connection.insertInto('ticket_thread').values({ ticketId: 'T-003', threadId: 'github:2', createdAt: at }).execute()
    await expect(ticket.createWithThreads('p1', '重复', ['github:2'])).rejects.toThrow('来源话题已关联工单：T-003（queued）')
    expect(await connection.selectFrom('ticket').select('id').where('title', '=', '重复').execute()).toEqual([])
  })
})

describe('派工排队', () => {
  it('已结束的票排不进队列，也不会留下 worker 行', async () => {
    await expect(worker.queue('T-001', 'p1')).rejects.toThrow('工单不存在、已结束或不属于当前项目')
    expect(await worker.listByTicket('T-001')).toEqual([])
    expect((await ticket.findById('T-001'))?.status).toBe('cancelled')
  })

  it('还开着的票排队后进入 queued', async () => {
    const queued = await worker.queue('T-003', 'p1')
    expect(queued).toMatchObject({ ticketId: 'T-003', status: 'queued' })
    expect((await ticket.findById('T-003'))?.status).toBe('queued')
  })
})
