import type { ConversationEnvironment } from './environment';
import { getMessagePluginIdentity, resolveConversationEnvironment } from './environment';
import type { ConversationEventDetail } from './events';
import type { ConversationChangeContext } from './history-events';
import type { ConversationHistory, MessageInput, MessagePluginIdentity } from './types';

type PluginHooks = {
  readonly current: () => ConversationHistory;
  readonly detail: (
    action: 'plugin.activated' | 'plugin.failed',
    previous: ConversationHistory,
    context: ConversationChangeContext,
  ) => ConversationEventDetail;
  readonly emit: (
    type: 'plugin.activated' | 'plugin.failed',
    detail: ConversationEventDetail,
  ) => void;
};

export function createPluginOwner(
  input: Partial<ConversationEnvironment> | undefined,
  hooks: PluginHooks,
) {
  const environment = resolveConversationEnvironment(input);
  const sourcePlugins = Object.freeze([...environment.plugins]);
  const identities = Object.freeze(
    environment.plugins.map((plugin, index) => {
      if (
        !plugin.id ||
        plugin.id.trim().length === 0 ||
        !Number.isSafeInteger(plugin.revision) ||
        (plugin.revision ?? 0) < 1
      ) {
        throw new TypeError(
          `Message plugin at index ${index} requires an explicit id and revision; use defineMessagePlugin()`,
        );
      }
      return getMessagePluginIdentity(plugin, index);
    }),
  );
  const duplicate = identities.find(
    (identity, index, values) =>
      values.findIndex((candidate) => candidate.id === identity.id) !== index,
  );
  if (duplicate) throw new TypeError(`Duplicate message plugin identity: ${duplicate.id}`);
  const pending: MessagePluginIdentity[] = [];
  const wrappedPlugins = environment.plugins.map((plugin, index) => {
    const identity = identities[index];
    if (!identity) throw new Error(`Missing plugin identity at index ${index}`);
    let activated = false;
    const transform = (inputValue: MessageInput): MessageInput => {
      if (!activated) {
        activated = true;
        pending.push(identity);
      }
      try {
        return plugin(inputValue);
      } catch (error) {
        const pendingIndex = pending.indexOf(identity);
        if (pendingIndex !== -1) {
          pending.splice(pendingIndex, 1);
          hooks.emit(
            'plugin.activated',
            hooks.detail('plugin.activated', hooks.current(), {
              outcome: 'completed',
              plugin: identity,
            }),
          );
        }
        hooks.emit(
          'plugin.failed',
          hooks.detail('plugin.failed', hooks.current(), {
            outcome: 'failed',
            plugin: identity,
            reason: String(error),
          }),
        );
        throw error;
      }
    };
    return Object.assign(transform, { id: identity.id, revision: identity.revision });
  });
  return {
    environment: { ...environment, plugins: wrappedPlugins },
    sourcePlugins,
    identities,
    takePending: () => pending.splice(0),
  };
}
