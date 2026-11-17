import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {until} from '../../scripts/native-harness.mjs';
import {newConfig, bindingKey} from '../../src/shared/config.js';
import {githubFixtures, positionWindow} from './github.mjs';

const execute = promisify(execFile);
const MOD = 'mission-control-github';
const UI = 'mission-control-github-prs-ui-v1';
const CA = path.resolve('.harness/github-large-payload-cas.pem');
export const fixtureEnvironment = {
  NODE_EXTRA_CA_CERTS: CA,
  QA_GITHUB_WORK: 'owned-github-work',
};

// Exercise the real copied mod and helper in Herdr's script runtime: Node
// alone does not reproduce the per-character byte counter's interrupted task.
export default async function githubLargePayload(runtime) {
  const home = runtime.env.HERDR_APP_HOME;
  const fixtures = await githubFixtures(runtime.directory, {
    largeCount: 200,
    pullBody: 'Description é漢🙂\n'.repeat(300),
  });
  try {
    fixtures.flags.large = true;
    await fs.writeFile(CA, await fs.readFile(fixtures.work.caFile));
    const config = newConfig();
    const connection = {id: 'work', kind: 'github', site: fixtures.work.origin,
      apiBase: fixtures.work.origin + '/api/v3', credentialEnv: 'QA_GITHUB_WORK'};
    const binding = {machine: null, repoRoot: runtime.repo,
      github: {connectionId: 'work', owner: 'acme', repo: 'web'}};
    config.connections.work = connection;
    config.bindings[bindingKey(null, runtime.repo)] = binding;
    await fs.mkdir(path.join(home, 'mission-control'), {recursive: true});
    await fs.writeFile(path.join(home, 'mission-control/config.json'), JSON.stringify(config));
    await runtime.installPackage(MOD);

    const result = await execute(process.execPath, [path.join(home, 'mods', MOD, 'backend.mjs'),
      JSON.stringify({v: 1, operation: 'pulls', connection, binding})],
    {env: runtime.env, timeout: 30000, maxBuffer: 8 * 1024 * 1024});
    const reply = JSON.parse(result.stdout);
    const size = Buffer.byteLength(result.stdout);
    runtime.expect(reply.ok && reply.snapshot.data.length === 200 && size > 1100000,
      'Production helper returns 200 PRs in a ' + size + '-byte response');

    await runtime.startWindow({name: 'github-large-payload', layout: {
      id: 'qa-root', type: 'block', titlebar: 'none', traffic_lights: [12, 16],
      theme: 'graphite', content: {mod: MOD, props: {view: 'pulls'}},
    }});
    await positionWindow(runtime);
    let serial = 0;
    const observe = async (query = '') => {
      const frame = await runtime.frame('large-pr-' + ++serial);
      return runtime.driver.ocr(path.resolve(frame.path), query);
    };
    const loaded = await until(async () => {
      const observation = await observe();
      return observation.lines.some(line => /All\s+200/.test(line.text)) ? observation : null;
    }, '200 pull requests rendered from the large helper response', 30000);
    runtime.expect(loaded.lines.some(line => /Open\s+200/.test(line.text)),
      'Native PR filters show All 200 and Open 200 after the async load');
    runtime.expect(!loaded.lines.some(line => /Loading pull requests|interrupted|render.*error/i.test(line.text)),
      'Large PR load completes without a loading or interrupted-task banner');

    const searchObservation = await observe('Search pull requests');
    runtime.expect(searchObservation.matches.length === 1, 'Native pull request search is visible and unique');
    await runtime.driver.clickObservedText(searchObservation, searchObservation.matches[0]);
    await runtime.driver.bridge('type', '1199');
    await until(async () => (await runtime.shared())[UI]?.query === '1199', 'native search input');
    const filtered = await until(async () => {
      const observation = await observe();
      return observation.lines.some(line => /Scale test PR 1199/.test(line.text)) ? observation : null;
    }, 'last pull request remains searchable after loading all 200 rows');
    runtime.expect(Boolean(filtered), 'Native search finds PR 1199, the last row in the 200-PR payload');
    runtime.expect(runtime.app(['status']).errors.length === 0, 'No app errors after large-response loading and search');
  } finally {
    await fixtures.close();
  }
}
