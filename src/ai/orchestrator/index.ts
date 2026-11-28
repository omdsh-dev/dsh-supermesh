import { composePrompt } from '@/ai/_shared/compose-prompt'
import * as plugins from '@/ai/_shared/plugins'
import * as channel from '@/ai/_shared/tools/channel'
import * as sharedCommunicate from '@/ai/_shared/tools/communicate'
import * as inbox from '@/ai/_shared/tools/inbox'
import * as sharedTicket from '@/ai/_shared/tools/ticket'
import * as communicateTools from '@/ai/orchestrator/tools/communicate'
import * as supervisorTools from '@/ai/orchestrator/tools/supervisor'
import * as threadTools from '@/ai/orchestrator/tools/thread'
import * as ticketTools from '@/ai/orchestrator/tools/ticket'
import { definePreset } from '@/ai/preset'

export const orchestrator = definePreset({
  id: 'orchestrator',
  name: '主编排',
  instruction: composePrompt('orchestrator'),
  order: 4,
  tools: [
    channel.read_channel,
    channel.reply_channel,

    sharedCommunicate.answer,

    inbox.read_mailbox,
    inbox.inbox_list,
    inbox.inbox_kill,

    communicateTools.ask_user,

    supervisorTools.supervisor_list,
    supervisorTools.create_supervisor,
    supervisorTools.close_supervisor,
    supervisorTools.attach_tickets_to_supervisor,
    supervisorTools.detach_tickets_from_supervisor,

    ticketTools.list_ticket,
    ticketTools.create_ticket,
    sharedTicket.dispatch_ticket,
    sharedTicket.note_ticket,

    threadTools.triage_thread,
    threadTools.attach_thread_to_ticket,
    threadTools.unlink_thread,
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
