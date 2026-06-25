/**
 * C3 completeness rule — every session verb (recover/cancel/fork/sleep/signal/update/query)
 * has a typed event class exported from operative.
 *
 * These tests verify the shape of each class at the constructor and type level.
 * Runtime dispatch tests live in session-handle tests when those are exercised
 * end-to-end. This file enforces the "every new state transition emits an event"
 * acceptance criterion from Phase C.
 */
import { describe, expect, it } from 'bun:test';

import {
  SessionCancelEvent,
  SessionForkEvent,
  SessionQueryEvent,
  SessionRecoverEvent,
  SessionSignalEvent,
  SessionSleepEvent,
  SessionUpdateEvent,
} from '../src/events';

describe('session verb events (C3 completeness rule)', () => {
  it('SessionRecoverEvent carries sessionId and runId', () => {
    const e = new SessionRecoverEvent('session-1', 'run-1');
    expect(e.type).toBe('session.recover');
    expect(e.sessionId).toBe('session-1');
    expect(e.runId).toBe('run-1');
  });

  it('SessionRecoverEvent runId may be null for pre-recovery state', () => {
    const e = new SessionRecoverEvent('session-1', null);
    expect(e.runId).toBeNull();
  });

  it('SessionCancelEvent carries sessionId and runId', () => {
    const e = new SessionCancelEvent('session-2', 'run-2');
    expect(e.type).toBe('session.cancel');
    expect(e.sessionId).toBe('session-2');
    expect(e.runId).toBe('run-2');
  });

  it('SessionForkEvent carries sourceSessionId, forkedSessionId, and optional throughRun', () => {
    const e = new SessionForkEvent('src', 'fork-1', 3);
    expect(e.type).toBe('session.fork');
    expect(e.sourceSessionId).toBe('src');
    expect(e.forkedSessionId).toBe('fork-1');
    expect(e.throughRun).toBe(3);
  });

  it('SessionForkEvent throughRun is optional', () => {
    const e = new SessionForkEvent('src', 'fork-2');
    expect(e.throughRun).toBeUndefined();
  });

  it('SessionSleepEvent carries sessionId and durationMs', () => {
    const e = new SessionSleepEvent('session-3', 5000);
    expect(e.type).toBe('session.sleep');
    expect(e.sessionId).toBe('session-3');
    expect(e.durationMs).toBe(5000);
  });

  it('SessionSignalEvent carries sessionId, runId, signalName, and payload', () => {
    const payload = { value: 42 };
    const e = new SessionSignalEvent('session-4', 'run-4', 'approve', payload);
    expect(e.type).toBe('session.signal');
    expect(e.signalName).toBe('approve');
    expect(e.payload).toBe(payload);
  });

  it('SessionUpdateEvent carries sessionId, runId, updateName, and payload', () => {
    const payload = { context: 'fresh' };
    const e = new SessionUpdateEvent('session-5', 'run-5', 'context-update', payload);
    expect(e.type).toBe('session.update');
    expect(e.updateName).toBe('context-update');
    expect(e.payload).toBe(payload);
  });

  it('SessionQueryEvent carries sessionId, queryName, and input', () => {
    const input = { key: 'status' };
    const e = new SessionQueryEvent('session-6', 'get-status', input);
    expect(e.type).toBe('session.query');
    expect(e.queryName).toBe('get-status');
    expect(e.input).toBe(input);
  });
});
