import { composePrompt } from '@/ai/_shared/compose-prompt'
import * as plugins from '@/ai/_shared/plugins'
import * as channel from '@/ai/_shared/tools/channel'
import * as sharedCommunicate from '@/ai/_shared/tools/communicate'
import * as inbox from '@/ai/_shared/tools/inbox'
import * as sharedTicket from '@/ai/_shared/tools/ticket'
import { definePreset } from '@/ai/preset'
import * as tools from '@/ai/supervisor/tools'

export const supervisor = definePreset({
  id: 'supervisor',
  name: '临时协调者',
  instruction: composePrompt('supervisor'),
  order: 6,
  tools: [
    channel.read_channel,

    sharedCommunicate.answer,

    inbox.read_mailbox,
    inbox.inbox_list,
    inbox.inbox_kill,

    sharedTicket.dispatch_ticket,
    sharedTicket.note_ticket,

    tools.list_ticket,

    tools.report,
    tools.ask,

    tools.link_dependency_ticket,
    tools.link_ticket,

    tools.create_ticket,
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
