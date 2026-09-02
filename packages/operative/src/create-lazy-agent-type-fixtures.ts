import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { AgentRun } from './agent-run';
import { createAgentRun } from './agent-run';
import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import type { RunnableAgent } from './runnable-agent';
import type { GenerateFunction, GenerateResponse } from './types';

const response = { content: 'fixture', toolCalls: [] } satisfies GenerateResponse;
const generate: GenerateFunction = () => Promise.resolve(response);

function buildRun(): AgentRun<never, false> {
  const conversation = new Conversation();
  conversation.appendUserMessage('fixture');
  const activeRun = createActiveRun({
    generate,
    toolbox: createToolbox([]),
    conversation,
    stopWhen: noToolCalls(),
  });
  return createAgentRun<never, false>(activeRun);
}

export const namedAgent: RunnableAgent<never, false> = {
  name: 'named-fixture',
  run: () => buildRun(),
};

const defaultAgent: RunnableAgent<never, false> = {
  name: 'default-fixture',
  run: () => buildRun(),
};

export default defaultAgent;
