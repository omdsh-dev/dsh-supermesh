import type { ThreadRow, TicketRow } from '@/service/courier.types'
import { describe, expect, it } from 'vitest'
import { ChannelError } from '@/channel/_shared/error'
import { courier } from '@/service/courier'

const at = '2026-01-01T00:00:00.000Z'

function thread(projectId: string | null, triage: 'pending' | 'claimed' | 'ignored'): ThreadRow {
  return { id: 'github:owner/repo:1', channelId: 'github', projectId, refId: 'owner/repo:1', kind: 'issue', title: 'Issue', url: 'https://github.com/owner/repo/issues/1', createdAt: at, updatedAt: at, triage, triagedAt: null }
}

function ticket(id: string, projectId: string, status: TicketRow['status']): TicketRow {
  return { id, projectId, channelId: 'github', title: id, description: null, status, createdAt: at, updatedAt: at, startedAt: null, endedAt: null, prUrl: null, prState: null, ciState: null, paused: 0, prepareError: null }
}

describe('渠道分页切片', () => {
  it('按 offset 与 limit 切片并给出下一页偏移', () => {
    const items = ['a', 'b', 'c', 'd']
    expect(courier.page(items, 0, 2)).toEqual({ items: ['a', 'b'], next_offset: 2 })
    expect(courier.page(items, 2, 2)).toEqual({ items: ['c', 'd'], next_offset: null })
    expect(courier.page(items, 4, 2)).toEqual({ items: [], next_offset: null })
  })
  it('拒绝越界分页参数', () => {
    for (const [offset, limit] of [[-1, 10], [0, 0], [0, 101], [0.5, 10], [0, 1.5]])
      expect(() => courier.page([], offset as number, limit as number)).toThrow('invalid_pagination')
  })
})

describe('触发邮件的收件人', () => {
  it('没票跟随时仍投给主编排，但带上话题已匹配的项目', () => {
    expect(courier.route(thread('p1', 'pending'), null)).toEqual({ key: 'main', type: 'main', projectId: 'p1', ticketId: null })
  })
  it('已分诊的话题直接投给项目', () => {
    expect(courier.route(thread('p1', 'claimed'), null)).toEqual({ key: 'p1', type: 'project', projectId: 'p1', ticketId: null })
  })
  it('没有匹配项目时归属为空，主编排看到的是事实而不是猜测', () => {
    expect(courier.route(thread(null, 'pending'), null)).toEqual({ key: 'main', type: 'main', projectId: null, ticketId: null })
  })
  it('有票跟随时投给票所在项目', () => {
    expect(courier.route(thread('p1', 'pending'), { id: 'T-1', projectId: 'p2' })).toEqual({ key: 'p2', type: 'project', projectId: 'p2', ticketId: 'T-1' })
  })
})

describe('订阅里谁收到触发', () => {
  it('活票跟着时投给它所在项目', () => {
    const plan = courier.recipients({ thread: thread('p1', 'claimed'), tickets: [ticket('T-1', 'p2', 'running')], human: true, mentioned: false, fresh: true })
    expect(plan.follow.map(item => item.target)).toEqual([{ key: 'p2', type: 'project', projectId: 'p2', ticketId: 'T-1' }])
    expect(plan.revive).toEqual([])
    expect(plan.fallback).toBeNull()
  })
  it('人叫停的票收不到东西，也不占话题：人的话回主编排重新分诊', () => {
    const plan = courier.recipients({ thread: thread('p1', 'claimed'), tickets: [ticket('T-1', 'p1', 'cancelled')], human: true, mentioned: false, fresh: true })
    expect(plan.follow).toEqual([])
    expect(plan.revive).toEqual([])
    expect(plan.fallback).toEqual({ key: 'main', type: 'main', projectId: 'p1', ticketId: null })
  })
  it('只剩已取消的票时机器人不叫醒任何人', () => {
    const plan = courier.recipients({ thread: thread('p1', 'claimed'), tickets: [ticket('T-1', 'p1', 'cancelled')], human: false, mentioned: true, fresh: true })
    expect(plan.follow).toEqual([])
    expect(plan.revive).toEqual([])
    expect(plan.fallback).toBeNull()
  })
  it('重读的同一条消息不再叫醒主编排', () => {
    const plan = courier.recipients({ thread: thread('p1', 'claimed'), tickets: [ticket('T-1', 'p1', 'cancelled')], human: true, mentioned: false, fresh: false })
    expect(plan.fallback).toBeNull()
  })
  it('做完的票要人 @ 才唤醒，取消的票不挡它', () => {
    const plan = courier.recipients({ thread: thread('p1', 'claimed'), tickets: [ticket('T-1', 'p1', 'done'), ticket('T-2', 'p1', 'cancelled')], human: true, mentioned: true, fresh: true })
    expect(plan.revive.map(item => item.ticket.id)).toEqual(['T-1'])
    expect(plan.follow).toEqual([])
    expect(plan.fallback).toBeNull()
  })
  it('重读的旧 @ 不再唤醒做完的票', () => {
    const plan = courier.recipients({ thread: thread('p1', 'claimed'), tickets: [ticket('T-1', 'p1', 'done')], human: true, mentioned: true, fresh: false })
    expect(plan.revive).toEqual([])
    expect(plan.fallback).toBeNull()
  })
  it('判过 ignore 的话题不再打扰主编排，除非有人又 @ 了我们', () => {
    const tickets = [ticket('T-1', 'p1', 'cancelled')]
    const ignored = courier.recipients({ thread: thread('p1', 'ignored'), tickets, human: true, mentioned: false, fresh: true })
    expect(ignored.fallback).toBeNull()
    const mentioned = courier.recipients({ thread: thread('p1', 'ignored'), tickets, human: true, mentioned: true, fresh: true })
    expect(mentioned.fallback).toEqual({ key: 'main', type: 'main', projectId: 'p1', ticketId: null })
  })
  it('做完的票没被点名时保持结束，也不改投主编排', () => {
    const plan = courier.recipients({ thread: thread('p1', 'claimed'), tickets: [ticket('T-1', 'p1', 'done')], human: true, mentioned: false, fresh: true })
    expect(plan.revive).toEqual([])
    expect(plan.follow).toEqual([])
    expect(plan.fallback).toBeNull()
  })
})

describe('渠道错误归一', () => {
  it('渠道错误取错误码，未知错误归为传输失败，中断单独标记', () => {
    expect(courier.failure(new ChannelError('rate_limited'), false)).toBe('rate_limited')
    expect(courier.failure(new Error('boom'), false)).toBe('transport_unknown')
    expect(courier.failure(new Error('boom'), true)).toBe('transport_unknown(boom)')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(courier.failure(abort, false)).toBe('interrupted')
  })
  it('退避取 retryAfter 与指数退避的较大值并受上限约束', () => {
    expect(courier.retryDelay(new ChannelError('rate_limited', 30), 1, 60)).toBe(30)
    expect(courier.retryDelay(new Error('boom'), 3, 60)).toBe(8)
    expect(courier.retryDelay(new Error('boom'), 10, 60)).toBe(60)
  })
})

describe('采集失败定位', () => {
  it('把失败步骤拼到原因码后面，接口位置优先于步骤名', () => {
    expect(courier.reason(new ChannelError('invalid_response'), false, 'topics')).toBe('invalid_response:topics')
    expect(courier.reason(new ChannelError('invalid_response', undefined, 'GET repos/a/b/pulls/7'), false, 'pull:7')).toBe('invalid_response:GET repos/a/b/pulls/7')
    expect(courier.reason(new ChannelError('invalid_response'), false)).toBe('invalid_response')
    expect(courier.reason(new Error('boom'), true, 'comments')).toBe('transport_unknown(boom):comments')
  })
  it('定位信息不改变投递失败码', () => {
    expect(courier.failure(new ChannelError('not_found', undefined, 'GET repos/a/b'), false)).toBe('not_found')
  })
  it('可读原因随失败码一起给出，分类码仍在前缀', () => {
    const error = new ChannelError('unknown_repository', undefined, undefined, '话题仓库 owner/renamed 与项目远端地址 https://github.com/owner/old 不一致')
    expect(courier.failure(error, false)).toBe('unknown_repository(话题仓库 owner/renamed 与项目远端地址 https://github.com/owner/old 不一致)')
  })
})
