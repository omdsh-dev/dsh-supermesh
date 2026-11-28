import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import process from 'node:process'

type PresetPlugin = PresetDefinition['plugins'][number]

const IS_WINDOWS = process.platform === 'win32'

export const agentInstructions: PresetPlugin = {
  id: 'agent-instructions',
  name: '@deepseek-ai/dsh-agent-instructions',
  config: { maxBytes: 65536 },
}

export const timeContext: PresetPlugin = {
  id: 'time-context',
  name: '@deepseek-ai/dsh-time-context',
}

export const toolBash: PresetPlugin = {
  id: 'tool-bash',
  name: '@deepseek-ai/dsh-tool-bash',
  disabled: IS_WINDOWS,
}

export const toolPwsh: PresetPlugin = {
  id: 'tool-pwsh',
  name: '@deepseek-ai/dsh-tool-pwsh',
  disabled: !IS_WINDOWS,
}

export const toolFs: PresetPlugin = {
  id: 'tool-fs',
  name: '@deepseek-ai/dsh-tool-fs',
  config: {
    applyPatch: false,
  },
}

export const toolFsSearch: PresetPlugin = {
  id: 'tool-fs-search',
  name: '@deepseek-ai/dsh-tool-fs-search',
  config: { sampleOverCapGlobResults: false },
}

export const toolJobs: PresetPlugin = {
  id: 'tool-jobs',
  name: '@deepseek-ai/dsh-tool-jobs',
}

export const skillFilesystem: PresetPlugin = {
  id: 'skill-filesystem',
  name: '@deepseek-ai/dsh-skill-filesystem',
}

export const toolSkill: PresetPlugin = {
  id: 'tool-skill',
  name: '@deepseek-ai/dsh-tool-skill',
}

export const commandGoal: PresetPlugin = {
  id: 'command-goal',
  name: '@deepseek-ai/dsh-command-goal',
}

export const compaction: PresetPlugin = {
  id: 'compaction',
  name: 'cordis:group',
  group: true,
  isolate: { compaction: true, toolResultPruner: true },
  config: [
    {
      id: 'compaction-basic',
      name: '@deepseek-ai/dsh-compaction-basic',
    },
    {
      id: 'command-compact',
      name: '@deepseek-ai/dsh-command-compact',
    },
    {
      id: 'tool-result-pruner',
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
      config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    },
  ],
}

export const delegation: PresetPlugin = {
  id: 'delegation',
  name: 'cordis:group',
  group: true,
  isolate: { workflowEngine: true },
  config: [
    {
      id: 'tool-subagent-control',
      name: '@deepseek-ai/dsh-tool-subagent-control',
    },
    {
      id: 'tool-subagent',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: {
        provider: 'spawn',
        toolName: 'subagent',
        modelSelection: true,
        modelDiscovery: true,
      },
    },
    {
      id: 'tool-subagent-fork',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { provider: 'fork', toolName: 'subagent_fork' },
    },
    {
      id: 'workflow-ptc',
      name: '@deepseek-ai/dsh-workflow-ptc',
      disabled: true,
      config: { provider: 'spawn' },
    },
    {
      id: 'tool-workflow',
      name: '@deepseek-ai/dsh-tool-workflow',
      disabled: true,
    },
  ],
}

export const toolTodo: PresetPlugin = {
  id: 'tool-todo',
  name: '@deepseek-ai/dsh-tool-todo',
  config: { allowParallelInProgress: true },
}

export const toolWeb: PresetPlugin = {
  id: 'tool-web',
  name: '@deepseek-ai/dsh-tool-web',
  config: { fetch: true, searchTimeoutMs: 60000 },
}

export const toolRegistryPtc: PresetPlugin = {
  id: 'tool-registry-ptc',
  name: '@deepseek-ai/dsh-tool-registry-ptc',
}

export const toolPresent: PresetPlugin = {
  id: 'present',
  name: '@deepseek-ai/dsh-tool-present',
}
