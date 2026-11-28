import { composePrompt } from '@/ai/_shared/compose-prompt'
import * as plugins from '@/ai/_shared/plugins'
import * as channel from '@/ai/_shared/tools/channel'
import { definePreset } from '@/ai/preset'
import * as tools from '@/ai/worker/tools'

export const worker = definePreset({
  id: 'worker',
  name: '执行会话',
  instruction: composePrompt('worker'),
  order: 7,
  tools: [
    channel.read_channel,

    tools.report,
    tools.ask,
  ],
  plugins: [
    plugins.agentInstructions,
    plugins.compaction,
    plugins.commandGoal,
    plugins.delegation,
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
