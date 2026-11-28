import { composePrompt } from '@/ai/_shared/compose-prompt'
import * as plugins from '@/ai/_shared/plugins'
import * as channel from '@/ai/_shared/tools/channel'
import * as inbox from '@/ai/_shared/tools/inbox'
import * as communicateTools from '@/ai/manager/tools/communicate'
import * as supervisorTools from '@/ai/manager/tools/supervisor'
import * as ticketTools from '@/ai/manager/tools/ticket'
import * as workerTools from '@/ai/manager/tools/worker'
import { definePreset } from '@/ai/preset'

export const manager = definePreset({
  id: 'manager',
  name: '项目编排',
  description: '一个仓库一个：派 Worker、看汇报、收尾，任务走到哪一步由它推。不写代码。',
  instruction: composePrompt('manager'),
  order: 5,
  tools: [
    channel.read_channel,
    channel.reply_channel,

    inbox.read_mailbox,
    inbox.inbox_list,
    inbox.inbox_kill,

    communicateTools.report,
    communicateTools.ask,
    communicateTools.escalate,

    supervisorTools.supervisor_list,

    ticketTools.list_ticket,
    ticketTools.link_ticket,
    ticketTools.stop_ticket,
    ticketTools.retry_ticket,

    workerTools.create_worker,
    workerTools.send,
    workerTools.view,
    workerTools.cancel,
    workerTools.list_worker,
  ],
  plugins: [
    plugins.agentInstructions,
    plugins.compaction,
    plugins.commandGoal,
    plugins.skillFilesystem,
    plugins.timeContext,
    plugins.toolBash,
    plugins.toolRegistryPtc,
    plugins.toolFs,
    plugins.toolFsSearch,
    plugins.toolJobs,
    plugins.toolPresent,
    plugins.toolPwsh,
    plugins.toolSkill,
    plugins.toolTodo,
    plugins.toolWeb,

  ],
})
