import { CompletableEventTarget } from '@lostgradient/lifecycle';

import type { AnthropicConversation } from './adapters/anthropic/types';
import type { GeminiConversation } from './adapters/gemini/types';
import type { OpenAIMessage } from './adapters/openai/types';
import { createConversationHistory } from './conversation/index';
import { ensureConversationSafe } from './conversation/validation';
import type { ConversationEnvironment } from './environment';
import type {
  ConversationActionType,
  ConversationEventDetail,
  ConversationEventMap,
} from './events';
import { ConversationEvent, conversationEventConstructors } from './events';
import { composeConversationActions, type ConversationActions } from './history-composition';
import { type ConversationChangeContext } from './history-events';
import { HistoryLifecycle } from './history-lifecycle';
import { createConversationChangeContext } from './history-messages';
import { createPluginOwner } from './history-plugins';
import { createConversationFromProvider } from './history-provider-factories';
import { restoreWithController } from './history-restore';
import { type ConversationLifecycle, HistoryTransaction } from './history-transaction';
import type { HistoryNode } from './history-tree';
import type {
  ConversationHistory,
  ConversationProvider,
  ConversationSnapshot,
  MessagePlugin,
  MessagePluginIdentity,
} from './types';

export type {
  ConversationActionType,
  ConversationEvent,
  ConversationEventDetail,
  ConversationEventMap,
} from './events';

export type { ConversationLifecycle, ConversationStoreSnapshot } from './history-transaction';

export interface ConversationMutationOptions {
  expectedRevision: number;
  correlationId?: string;
  actor?: string;
  durability?: ConversationEventDetail['durability'];
}

export type ConversationMutationResult =
  | { readonly accepted: true; readonly revision: number }
  | {
      readonly accepted: false;
      readonly revision: number;
      readonly reason: 'revision-conflict' | 'stale-external-event' | 'invalid-external-snapshot';
    };

/**
 * The domain actions `composeConversationActions` installs on every `Conversation`.
 *
 * Declared here, beside the class, rather than as `declare module './history'` in
 * history-composition.ts. A relative module augmentation does not survive declaration bundling:
 * the bundler moves the class into a shared chunk under a local alias, and `./history` becomes a
 * file that only re-exports it, so the augmentation merges into nothing and the published
 * `Conversation` loses every action method. Same-module merging has no path to lose.
 */
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- the constructor installs every member of ConversationActions (see composeConversationActions), so the merged members are always present at runtime.
export interface Conversation extends ConversationActions<Conversation> {}

/**
 * Manages a stack of conversation versions to support undo, redo, and branching.
 */
export class Conversation {
  private readonly transaction: HistoryTransaction;
  // Domain actions are installed by history-composition.ts.
  private forkLineage?: {
    parentConversationId: string;
    forkPointMessageId?: string;
    sourceRevision: number;
  };
  private environment: ConversationEnvironment;
  private readonly emitter = new CompletableEventTarget<ConversationEventMap>();
  private readonly lifecycleController = new HistoryLifecycle();
  private readonly pluginIdentityList: readonly MessagePluginIdentity[];
  private readonly sourcePlugins: readonly MessagePlugin[];
  private readonly takePendingPluginActivations: () => readonly MessagePluginIdentity[];

  private get currentNode(): HistoryNode {
    return this.transaction.node;
  }
  private set currentNode(node: HistoryNode) {
    this.transaction.setCurrentNode(node);
  }
  private get controllerRevision(): number {
    return this.transaction.revision;
  }
  private get lifecycleState(): ConversationLifecycle {
    return this.lifecycleController.state;
  }
  private set controllerRevision(revision: number) {
    this.transaction.setRevision(revision);
  }

  constructor(initial?: ConversationHistory, environment?: Partial<ConversationEnvironment>) {
    const pluginOwner = createPluginOwner(environment, {
      current: () => this.current,
      detail: (action, previous, context) => this.buildEventDetail(action, previous, context),
      emit: (type, detail) => this.emitConversationEvent(type, detail),
    });
    this.environment = pluginOwner.environment;
    this.sourcePlugins = pluginOwner.sourcePlugins;
    this.pluginIdentityList = pluginOwner.identities;
    this.takePendingPluginActivations = pluginOwner.takePending;
    // AB-321: minted through `this.environment`, never the bare
    // `createConversationHistory()` default — a default parameter value is
    // evaluated before `this.environment` exists, so it would always read
    // the real globals regardless of what `environment` the caller passed.
    const resolvedInitial = initial ?? createConversationHistory(undefined, this.environment);
    const safeInitial = ensureConversationSafe(structuredClone(resolvedInitial));
    this.transaction = new HistoryTransaction(safeInitial);
    Object.assign(
      this,
      composeConversationActions<Conversation>({
        transaction: this.transaction,
        lifecycle: this.lifecycleController,
        emitter: this.emitter,
        current: () => this.current,
        node: () => this.currentNode,
        lineage: () => this.forkLineage ?? {},
        removedNodeIds: () => this.transaction.getRemovedNodeIds(),
        revision: () => this.controllerRevision,
        environment: this.environment,
        sourcePlugins: this.sourcePlugins,
        assertOpen: () => this.assertOpen(),
        commit: (next, action, events, context) => this.commit(next, action, events, context),
        changeContext: (previous, next, action) => this.createChangeContext(previous, next, action),
        detail: (action, previous, context) => this.buildEventDetail(action, previous, context),
        emit: (type, detail) => this.emitConversationEvent(type, detail),
        create: (history, childEnvironment) => new Conversation(history, childEnvironment),
        setLineage: (conversation, lineage) => {
          conversation.forkLineage = lineage;
        },
      }),
    );
  }

  private buildEventDetail(
    action: ConversationActionType,
    previousConversation: ConversationHistory,
    context: ConversationChangeContext &
      Partial<
        Pick<
          ConversationEventDetail,
          | 'actor'
          | 'correlationId'
          | 'durability'
          | 'outcome'
          | 'streamSequence'
          | 'childConversationId'
          | 'plugin'
          | 'reason'
        >
      > = {},
  ): ConversationEventDetail {
    return this.transaction.buildEventDetail(action, previousConversation, context);
  }

  private emitConversationEvent(type: string, detail: ConversationEventDetail): void {
    const EventConstructor = conversationEventConstructors[type];
    this.emitter.dispatchEvent(
      EventConstructor ? new EventConstructor(detail) : new ConversationEvent(type, detail),
    );
  }

  private assertOpen(): void {
    this.transaction.assertOpen(this.lifecycleState);
  }

  private commit(
    next: ConversationHistory,
    changeAction: ConversationActionType,
    emittedEvents: readonly ConversationActionType[],
    context?: ConversationChangeContext,
  ): void {
    this.transaction.commit(next, changeAction, emittedEvents, context, this.lifecycleState, {
      environment: this.environment,
      takePendingPluginActivations: this.takePendingPluginActivations,
      emit: (type, detail) => this.emitConversationEvent(type, detail),
    });
  }

  get completed(): boolean {
    return this.lifecycleState !== 'open';
  }
  get lifecycle(): ConversationLifecycle {
    return this.lifecycleState;
  }
  get inFlightOperationCount(): number {
    return this.lifecycleController.inFlightOperationCount;
  }

  // External mutation actions are composed in history-external-mutations.ts.

  /** Monotonic revision for accepted controller state transitions. */
  get revision(): number {
    return this.controllerRevision;
  }

  /**
   * The current conversation state.
   */
  get current(): ConversationHistory {
    return this.currentNode.conversation;
  }

  /**
   * Returns the message IDs for the current conversation.
   */
  get ids(): string[] {
    return this.getMessageIds();
  }

  /**
   * Whether an undo operation is possible.
   */
  get canUndo(): boolean {
    return this.currentNode.parent !== null;
  }

  /**
   * Whether a redo operation is possible.
   */
  get canRedo(): boolean {
    return this.currentNode.children.length > 0;
  }

  /**
   * Returns the environment associated with this history.
   */
  get env(): ConversationEnvironment {
    return this.environment;
  }

  get plugins(): readonly MessagePluginIdentity[] {
    return this.pluginIdentityList;
  }

  /**
   * Returns the number of branches available at the current level.
   */
  get branchCount(): number {
    return this.currentNode.parent ? this.currentNode.parent.children.length : 1;
  }

  /**
   * Returns the index of the current branch at this level.
   */
  get branchIndex(): number {
    return this.currentNode.parent ? this.currentNode.parent.children.indexOf(this.currentNode) : 0;
  }

  /**
   * Returns the number of alternate paths available from the current state.
   */
  get redoCount(): number {
    return this.currentNode.children.length;
  }

  private createChangeContext(
    previousConversation: ConversationHistory,
    nextConversation: ConversationHistory,
    action: Extract<
      ConversationActionType,
      'messages.appended' | 'messages.updated' | 'messages.removed'
    >,
  ): ConversationChangeContext {
    return createConversationChangeContext(previousConversation, nextConversation, action);
  }

  // --- QUERY METHODS ---

  // Message mutation actions are composed in history-mutation-actions.ts.

  // Compaction actions are composed during construction.

  // Provider actions are composed in history-provider-actions.ts.

  /**
   * Reconstructs a Conversation instance from JSON.
   */
  static from(
    json: ConversationSnapshot,
    environment?: Partial<ConversationEnvironment>,
  ): Conversation {
    return restoreWithController(
      json,
      environment,
      (history, childEnvironment) => new Conversation(history, childEnvironment),
      (getConversation) => ({
        currentNode: () => getConversation().currentNode,
        setState: (revision, node) =>
          getConversation().transaction.setRestoredState(revision, node),
        setRemovedNodeIds: (ids) => getConversation().transaction.setRemovedNodeIds(ids),
        setCurrentNode: (node) => getConversation().transaction.setCurrentNode(node),
        setLineage: (lineage) => {
          getConversation().forkLineage = {
            parentConversationId: lineage.parentConversationId,
            ...(lineage.forkPointMessageId
              ? { forkPointMessageId: lineage.forkPointMessageId }
              : {}),
            sourceRevision: lineage.sourceRevision,
          };
        },
        lifecycle: () => getConversation().lifecycleState,
        emitRestored: () => {
          const conversation = getConversation();
          conversation.emitConversationEvent(
            'snapshot.restored',
            conversation.buildEventDetail('snapshot.restored', conversation.current, {
              durability: 'snapshot',
              outcome: 'completed',
            }),
          );
        },
      }),
    );
  }

  // Provider conversion aliases are composed in history-provider-actions.ts.

  static async fromProvider(
    provider: ConversationProvider,
    payload: OpenAIMessage[] | AnthropicConversation | GeminiConversation,
    environment?: Partial<ConversationEnvironment>,
  ): Promise<Conversation> {
    return createConversationFromProvider(
      provider,
      payload,
      environment,
      (history, childEnvironment) => new Conversation(history, childEnvironment),
    );
  }

  static async fromOpenAIMessages(
    messages: ReadonlyArray<OpenAIMessage>,
    environment?: Partial<ConversationEnvironment>,
  ): Promise<Conversation> {
    return Conversation.fromProvider('openai', [...messages], environment);
  }

  static async fromAnthropicMessages(
    payload: AnthropicConversation,
    environment?: Partial<ConversationEnvironment>,
  ): Promise<Conversation> {
    return Conversation.fromProvider('anthropic', payload, environment);
  }

  static async fromGeminiMessages(
    payload: GeminiConversation,
    environment?: Partial<ConversationEnvironment>,
  ): Promise<Conversation> {
    return Conversation.fromProvider('gemini', payload, environment);
  }

  /**
   * Aborts owned work, awaits quiescence, and releases subscriptions.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  [Symbol.dispose](): void {
    void this.dispose();
  }
}
