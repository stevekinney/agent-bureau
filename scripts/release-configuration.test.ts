import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { RELEASE_INVENTORY } from './release';

const repositoryRoot = resolve(import.meta.dir, '..');

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};

type ReleaseWorkflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

type ChangesetConfiguration = {
  ignore?: string[];
};

async function readWorkflow(): Promise<ReleaseWorkflow> {
  const text = await Bun.file(resolve(repositoryRoot, '.github/workflows/release.yml')).text();
  return Bun.YAML.parse(text) as ReleaseWorkflow;
}

async function readChangesetConfiguration(): Promise<ChangesetConfiguration> {
  return (await Bun.file(
    resolve(repositoryRoot, '.changeset/config.json'),
  ).json()) as ChangesetConfiguration;
}

function allSteps(workflow: ReleaseWorkflow): WorkflowStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function changesetsActionStep(workflow: ReleaseWorkflow): WorkflowStep {
  const step = allSteps(workflow).find((candidate) =>
    candidate.uses?.startsWith('changesets/action'),
  );
  if (!step) throw new Error('release.yml does not have a changesets/action step');
  return step;
}

describe('release workflow contract', () => {
  test('triggers exactly on pushes to main', async () => {
    const workflow = await readWorkflow();

    expect(Object.keys(workflow.on ?? {})).toEqual(['push']);
    expect((workflow.on as { push: { branches: string[] } }).push.branches).toEqual(['main']);
  });

  test('top-level permissions are exactly contents, pull-requests, and id-token write', async () => {
    const workflow = await readWorkflow();

    expect(workflow.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
      'id-token': 'write',
    });
  });

  test('continues to use changesets/action with the version and publish commands', async () => {
    const workflow = await readWorkflow();
    const step = changesetsActionStep(workflow);

    expect(step.uses).toMatch(/^changesets\/action@/);
    expect(step.with).toEqual({
      version: 'bun run version',
      publish: 'bun run release',
    });
  });

  test('the changesets/action step exposes only GITHUB_TOKEN and RELEASE_ENABLED', async () => {
    const workflow = await readWorkflow();
    const step = changesetsActionStep(workflow);

    expect(step.env).toEqual({
      GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      RELEASE_ENABLED: '${{ vars.RELEASE_ENABLED }}',
    });
  });

  test('no step sets an npm auth token or additional permissions', async () => {
    const workflow = await readWorkflow();

    expect(workflow.permissions).not.toHaveProperty('packages');

    for (const job of Object.values(workflow.jobs ?? {})) {
      expect(job).not.toHaveProperty('permissions');
    }

    for (const step of allSteps(workflow)) {
      const env = step.env ?? {};
      const stepWith = step.with ?? {};
      expect(Object.keys(env)).not.toContain('NPM_TOKEN');
      expect(Object.keys(env)).not.toContain('NODE_AUTH_TOKEN');
      expect(stepWith['always-auth']).toBeUndefined();
    }
  });

  test('builds every release-inventory package before publishing', async () => {
    const workflow = await readWorkflow();
    const buildStep = allSteps(workflow).find((step) => step.name === 'Build publishable packages');

    expect(buildStep).toBeDefined();
    for (const target of RELEASE_INVENTORY) {
      expect(buildStep?.run).toContain(`--filter=${target.packageName}`);
    }
  });
});

describe('release inventory and changesets configuration agreement', () => {
  test('includes the operative package as an explicit inventory entry', () => {
    expect(RELEASE_INVENTORY).toContainEqual({
      directory: 'operative',
      packageName: '@lostgradient/operative',
    });
  });

  test('every release-inventory package is absent from the changesets ignore list', async () => {
    const configuration = await readChangesetConfiguration();
    const ignored = new Set(configuration.ignore ?? []);

    for (const target of RELEASE_INVENTORY) {
      expect(ignored.has(target.packageName)).toBe(false);
    }
  });
});
