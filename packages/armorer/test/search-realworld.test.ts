import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createToolbox } from '../src/create-toolbox';
import type { ToolConfiguration } from '../src/is-tool';
import { searchTools } from '../src/registry';

const makeRegistry = (embed?: (texts: string[]) => number[][]) =>
  createToolbox(realWorldTools(), embed ? { embed } : undefined);

describe('search real-world scenarios', () => {
  it('ranks refund workflows highest for refund searches', () => {
    const toolbox = makeRegistry();
    const results = searchTools(toolbox, {
      rank: { text: 'refund order' },
      limit: 3,
    });

    expect(results[0]?.tool.name).toBe('issue-refund');
  });

  it('highlights schema key matches in explain output', () => {
    const toolbox = makeRegistry();
    const results = searchTools(toolbox, {
      rank: { text: 'trackingId' },
      explain: true,
      limit: 2,
    });

    const top = results[0];
    expect(top?.tool.name).toBe('track-shipment');
    expect(top?.reasons).toContain('text:schema-keys(trackingId)');
    expect(top?.matches?.schemaKeys).toEqual(['trackingId']);
  });

  it('matches metadata keys for localization tools', () => {
    const toolbox = makeRegistry();
    const results = searchTools(toolbox, {
      rank: { text: 'locale' },
      explain: true,
      limit: 2,
    });

    const top = results[0];
    expect(top?.tool.name).toBe('translate-message');
    expect(top?.reasons).toContain('text:metadata-keys(locale)');
    expect(top?.matches?.metadataKeys).toEqual(['locale']);
  });

  it('honors tag boosts for risk investigations', () => {
    const toolbox = makeRegistry();
    const results = searchTools(toolbox, {
      rank: { tags: ['fraud', 'risk'], tagWeights: { fraud: 3 } },
      limit: 3,
    });

    expect(results[0]?.tool.name).toBe('flag-fraud');
    expect(results[0]?.reasons).toContain('tag:fraud');
  });

  it('uses embeddings to surface shipping tools for parcel searches', () => {
    const embed = (texts: string[]) =>
      texts.map((text) => {
        const normalized = text.toLowerCase();
        if (
          normalized.includes('shipment') ||
          normalized.includes('tracking') ||
          normalized.includes('parcel') ||
          normalized.includes('location')
        ) {
          return [1, 0];
        }
        if (normalized.includes('delivery')) {
          return [0.8, 0.2];
        }
        if (
          normalized.includes('refund') ||
          normalized.includes('payment') ||
          normalized.includes('invoice')
        ) {
          return [0, 1];
        }
        return [0, 0];
      });

    const toolbox = makeRegistry(embed);
    const results = searchTools(toolbox, {
      rank: { text: { query: 'parcel location', mode: 'fuzzy', threshold: 0.4 } },
      explain: true,
      limit: 3,
    });

    expect(results[0]?.tool.name).toBe('track-shipment');
    expect(results[0]?.reasons.some((reason) => reason.startsWith('embedding:'))).toBe(true);
    expect(results.map((entry) => entry.tool.name)).toEqual(
      expect.arrayContaining(['schedule-delivery']),
    );
  });
});

function realWorldTools(): ToolConfiguration[] {
  return [
    {
      name: 'issue-refund',
      description: 'issue refund for an order with item-level adjustments',
      tags: ['billing', 'refund', 'orders'],
      metadata: { domain: 'billing', tier: 'pro' },
      input: z.object({
        orderId: z.string(),
        amount: z.number().optional(),
        reason: z.string().optional(),
      }),
      execute: async () => null,
    },
    {
      name: 'capture-payment',
      description: 'capture an authorized card payment for an order',
      tags: ['billing', 'payments'],
      metadata: { domain: 'billing', tier: 'pro' },
      input: z.object({
        paymentId: z.string(),
        amount: z.number(),
      }),
      execute: async () => null,
    },
    {
      name: 'track-shipment',
      description: 'track shipment status and carrier updates',
      tags: ['shipping', 'tracking', 'orders'],
      metadata: { domain: 'logistics', tier: 'free' },
      input: z.object({
        trackingId: z.string(),
        carrier: z.string().optional(),
      }),
      execute: async () => null,
    },
    {
      name: 'schedule-delivery',
      description: 'schedule a delivery window for an order',
      tags: ['shipping', 'delivery'],
      metadata: { domain: 'logistics', locale: 'en-US' },
      input: z.object({
        orderId: z.string(),
        date: z.string(),
      }),
      execute: async () => null,
    },
    {
      name: 'update-inventory',
      description: 'update inventory counts for a SKU',
      tags: ['inventory', 'catalog'],
      metadata: { domain: 'catalog', pii: false },
      input: z.object({
        sku: z.string(),
        quantity: z.number(),
      }),
      execute: async () => null,
    },
    {
      name: 'summarize-support-tickets',
      description: 'summarize open support tickets by category',
      tags: ['support', 'analysis'],
      metadata: { domain: 'support', owner: 'team-support' },
      input: z.object({
        since: z.string(),
        limit: z.number().optional(),
      }),
      execute: async () => null,
    },
    {
      name: 'translate-message',
      description: 'translate a customer message to the requested locale',
      tags: ['localization', 'text'],
      metadata: { domain: 'support', locale: 'es-ES' },
      input: z.object({
        text: z.string(),
        locale: z.string(),
      }),
      execute: async () => null,
    },
    {
      name: 'flag-fraud',
      description: 'flag suspicious orders for manual review',
      tags: ['risk', 'fraud', 'orders'],
      metadata: { domain: 'risk', tier: 'enterprise' },
      input: z.object({
        orderId: z.string(),
        score: z.number(),
      }),
      execute: async () => null,
    },
    {
      name: 'get-order-status',
      description: 'fetch the current order status and last update',
      tags: ['orders', 'status'],
      metadata: { domain: 'orders', cache: 'short' },
      input: z.object({
        orderId: z.string(),
      }),
      execute: async () => null,
    },
    {
      name: 'create-customer-profile',
      description: 'create a customer profile with marketing preferences',
      tags: ['customers', 'crm'],
      metadata: { domain: 'crm', pii: true },
      input: z.object({
        email: z.string(),
        name: z.string(),
      }),
      execute: async () => null,
    },
    {
      name: 'list-invoices',
      description: 'list invoices for a billing account',
      tags: ['billing', 'invoices'],
      metadata: { domain: 'billing', tier: 'pro' },
      input: z.object({
        accountId: z.string(),
      }),
      execute: async () => null,
    },
    {
      name: 'log-audit-event',
      description: 'write audit log entries for compliance',
      tags: ['audit', 'logs'],
      metadata: { domain: 'compliance' },
      input: z.object({
        event: z.string(),
        actorId: z.string(),
      }),
      execute: async () => null,
    },
  ];
}
