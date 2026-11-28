import { defineTool } from '@deepseek-ai/dsh-tools'
import { db } from '@/database'
import { session } from '@/service/session'

export const triage_thread = defineTool({
  name: 'triage_thread',
  description: '给一条还没活票跟着的话题定归属。判一次就固定，之后不再打扰主编排；人叫停的票不占话题，可以重新判。',
  parameters: {
    threadId: {
      type: 'string',
      required: true,
      description: '话题 id，形如 github:42 或 feishu:<chat>:<root>。',
    },
    action: {
      type: 'string',
      enum: ['claim', 'ignore'],
      required: true,
      description: 'claim 归给某个项目；ignore 判为不用处理，之后不投递，除非有人又 @ 了我们。',
    },
    projectId: {
      type: 'string',
      description: 'action=claim 时必给：话题归哪个项目。',
    },
  },
  output: {
    schema: { type: 'string', description: '写入后的 triage 结论。' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  execute: async (args, exec) => {
    const identity = await session.resolve(exec.agent?.session.id ?? '')
    if (!identity)
      throw new Error('当前会话没有 Supermesh 身份')
    if (identity.role !== 'main')
      throw new Error('仅主编排可调用')
    const thread = await db.thread.findById(args.threadId)
    if (!thread)
      throw new Error('话题不存在')
    const followers = await db.ticketThread.listFollowers(thread.id)
    const live = followers.filter(row => row.status !== 'cancelled')
    if (live.length)
      throw new Error(`已有工单订阅的话题不能分诊：${live.map(row => `${row.ticketId}（${row.status}）`).join('、')} 还跟着它。`)
    // 只剩人叫停的票时，话题等于没有票跟着：人叫停的是那张票，不是这条话题，新活可以重新接受。
    if (!followers.length && thread.triage !== 'pending')
      throw new Error('话题已分诊')
    if (args.action === 'claim') {
      if (!args.projectId || !(await db.project.findById(args.projectId)))
        throw new Error('claim 必须指定存在的 projectId')
      await db.thread.claim(thread.id, args.projectId, new Date().toISOString())
    }
    else {
      await db.thread.ignore(thread.id, new Date().toISOString())
    }
    return JSON.stringify(await db.thread.findById(thread.id))
  },
})

export const attach_thread_to_ticket = defineTool({
  name: 'attach_thread_to_ticket',
  description: '让一张已有的票接管一条新话题：建订阅并投递。跨项目也走它。只有消息明确指向那张票才挂。',
  parameters: {
    ticketId: {
      type: 'string',
      required: true,
      description: '接管这条话题的票。已被人叫停（cancelled）的票挂不上。',
    },
    threadId: {
      type: 'string',
      required: true,
      description: '要挂上去的话题 id。',
    },
    note: {
      type: 'string',
      description: '一句话路由背景或人给的约束，不要写实现建议，也不要复述原文。',
    },
  },
  output: {
    schema: { type: 'string', description: '挂载结果。' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  execute: async (args, exec) => {
    const identity = await session.resolve(exec.agent?.session.id ?? '')
    if (!identity)
      throw new Error('当前会话没有 Supermesh 身份')
    if (identity.role !== 'main')
      throw new Error('仅主编排可调用')
    const ticket = await db.ticket.findById(args.ticketId)
    if (!ticket || ticket.status === 'cancelled')
      throw new Error('工单不存在或已 cancelled')
    const thread = await db.thread.findById(args.threadId)
    if (!thread)
      throw new Error('话题不存在')
    const links = await db.ticketThread.listByTicket(ticket.id)
    if (links.some(row => row.threadId === thread.id))
      return JSON.stringify({ linked: true, existing: true })
    if (!await db.ticketThread.link(ticket.id, thread.id, new Date().toISOString()))
      return JSON.stringify({ linked: true, existing: true })
    // 采集侧只按票上记下的 prUrl 认领 PR：手工挂上的 PR 话题不写这一列，prState 永远采不到。
    if (thread.kind === 'pull' && thread.url && !ticket.prUrl)
      await db.ticket.save(ticket.id, { prUrl: thread.url })
    await db.inbox.enqueue({ type: 'project', projectId: ticket.projectId, origin: 'main', kind: 'ticket', ticketId: ticket.id, threadId: thread.id, message: args.note ?? thread.title })
    return JSON.stringify({ linked: true })
  },
})

export const unlink_thread = defineTool({
  name: 'unlink_thread',
  description: '摘掉挂错的话题，和 attach 严格对称：只删订阅一行，不动话题归属。',
  parameters: {
    ticketId: {
      type: 'string',
      required: true,
      description: '要摘掉订阅的票。',
    },
    threadId: {
      type: 'string',
      required: true,
      description: '要摘掉的话题 id。这张票的触发来源那条不许摘。',
    },
    reason: {
      type: 'string',
      required: true,
      description: '一句话说明为什么不相关，写进记录供回溯。',
    },
  },
  output: {
    schema: { type: 'string', description: '摘除结果。' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  execute: async (args, exec) => {
    const identity = await session.resolve(exec.agent?.session.id ?? '')
    if (!identity)
      throw new Error('当前会话没有 Supermesh 身份')
    if (identity.role !== 'main')
      throw new Error('仅主编排可调用')
    if (!(await db.ticket.findById(args.ticketId)))
      throw new Error('工单不存在')
    const links = await db.ticketThread.listByTicket(args.ticketId)
    if (links[0]?.threadId === args.threadId)
      throw new Error('不能摘掉触发来源话题：那是这张票从哪来的唯一记录。要在同一话题上重新开工，另开一张票即可。')
    if (!links.some(row => row.threadId === args.threadId))
      throw new Error('订阅不存在')
    await db.ticketThread.unlink(args.ticketId, args.threadId)
    const ticket = (await db.ticket.findById(args.ticketId))!
    await db.inbox.enqueue({ type: 'project', projectId: ticket.projectId, origin: 'main', kind: 'notice', ticketId: ticket.id, threadId: args.threadId, message: args.reason })
    return JSON.stringify({ unlinked: true })
  },
})
