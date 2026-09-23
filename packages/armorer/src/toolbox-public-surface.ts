import type { CompletableEventTarget } from '@lostgradient/lifecycle';

import { type LoopDetectionOptions, LoopDetector } from './core/loop-detection';
import type { ToolboxEventMap } from './event-types';
import type { ExecutionLifecycle, ExecutionSelector } from './execution-lifecycle';
import type {
  ToolboxEntries,
  ToolboxEventDispatcher,
  ToolboxEventType,
  ToolboxEvents,
} from './toolbox-contracts';
import type { Toolbox } from './toolbox-interface';
import type { ToolsFromEntries } from './toolbox-type-inference';

type ToolboxViews<TEntries extends ToolboxEntries> = Pick<
  Toolbox<ToolsFromEntries<TEntries>>,
  | 'tools'
  | 'getAvailable'
  | 'getMissingTools'
  | 'hasAllTools'
  | 'inspect'
  | 'toProvider'
  | 'toOpenAITools'
  | 'toAnthropicTools'
  | 'toGeminiTools'
  | 'asExecuteResolver'
  | 'toJSON'
>;

type ToolboxSurfaceInput<TEntries extends ToolboxEntries> = {
  views: ToolboxViews<TEntries>;
  execute: Toolbox<ToolsFromEntries<TEntries>>['execute'];
  resumeApproval: Toolbox<ToolsFromEntries<TEntries>>['resumeApproval'];
  resolveApproval: Toolbox<ToolsFromEntries<TEntries>>['resolveApproval'];
  restoreApproval: Toolbox<ToolsFromEntries<TEntries>>['restoreApproval'];
  revokeApproval: Toolbox<ToolsFromEntries<TEntries>>['revokeApproval'];
  issueGrant: Toolbox<ToolsFromEntries<TEntries>>['issueGrant'];
  revokeGrant: Toolbox<ToolsFromEntries<TEntries>>['revokeGrant'];
  listGrants: Toolbox<ToolsFromEntries<TEntries>>['listGrants'];
  extend: Toolbox<ToolsFromEntries<TEntries>>['extend'];
  getTool: Toolbox<ToolsFromEntries<TEntries>>['getTool'];
  addEventListener: Toolbox<ToolsFromEntries<TEntries>>['addEventListener'];
  dispatchEvent: ToolboxEventDispatcher;
  emit: {
    <K extends ToolboxEventType>(type: K, detail: ToolboxEvents[K]): boolean;
    (type: string, detail: unknown): boolean;
  };
  emitter: CompletableEventTarget<ToolboxEventMap>;
  complete: () => Promise<void>;
  executionLifecycle: ExecutionLifecycle;
  baseContext: Record<string, unknown>;
  loopDetectors: Map<string, LoopDetector>;
  nextLoopDetectorId: () => number;
};

export function createToolboxPublicSurface<const TEntries extends ToolboxEntries>(
  input: ToolboxSurfaceInput<TEntries>,
): Toolbox<ToolsFromEntries<TEntries>> {
  const { views } = input;
  return {
    execute: input.execute,
    resumeApproval: input.resumeApproval,
    resolveApproval: input.resolveApproval,
    restoreApproval: input.restoreApproval,
    revokeApproval: input.revokeApproval,
    issueGrant: input.issueGrant,
    revokeGrant: input.revokeGrant,
    listGrants: input.listGrants,
    extend: input.extend,
    tools: views.tools,
    getAvailable: views.getAvailable,
    getTool: input.getTool,
    getMissingTools: views.getMissingTools,
    hasAllTools: views.hasAllTools,
    inspect: views.inspect,
    toProvider: views.toProvider,
    toOpenAITools: views.toOpenAITools,
    toAnthropicTools: views.toAnthropicTools,
    toGeminiTools: views.toGeminiTools,
    asExecuteResolver: views.asExecuteResolver,
    toJSON: views.toJSON,
    addEventListener: input.addEventListener,
    dispatchEvent: input.dispatchEvent,
    emit: input.emit,
    on: input.emitter.on.bind(input.emitter),
    once: input.emitter.once.bind(input.emitter),
    subscribe: input.emitter.subscribe.bind(input.emitter),
    toObservable: input.emitter.toObservable.bind(input.emitter),
    events: input.emitter.events.bind(input.emitter),
    complete: input.complete,
    get completed() {
      return input.executionLifecycle.completed;
    },
    get activeExecutions() {
      return input.executionLifecycle.activeExecutions;
    },
    get executionSignal() {
      return input.executionLifecycle.signal;
    },
    executions: input.executionLifecycle,
    whenIdle: () => input.executionLifecycle.whenIdle(),
    closeAdmission: () => input.executionLifecycle.closeAdmission(),
    abort: (selector?: ExecutionSelector, reason?: unknown) =>
      input.executionLifecycle.abort(selector, reason, 'toolbox'),
    shutdown: (shutdownOptions?: { policy?: 'abort' | 'drain'; reason?: unknown }) => {
      input.loopDetectors.clear();
      input.emitter.complete();
      return input.executionLifecycle.shutdown(shutdownOptions);
    },
    getContext: () => input.baseContext,
    createLoopDetector: (options?: LoopDetectionOptions) => {
      const id = `detector-${input.nextLoopDetectorId()}`;
      const detector = new LoopDetector(options);
      input.loopDetectors.set(id, detector);
      return {
        detectLoop: () => detector.detectLoop(),
        getLoopStatistics: () => detector.getLoopStatistics(),
      };
    },
  };
}
