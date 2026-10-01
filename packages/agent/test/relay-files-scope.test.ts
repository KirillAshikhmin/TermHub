import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FrameType, frameJson, jsonFrame, decodeFrame, type Frame } from '@termhub/protocol';
import { RelayLink } from '../src/relay-link.js';
import { FileService } from '../src/files.js';

let base: string;
let shared: string;
let sibling: string;
let dispatch: (req: Record<string, unknown>) => Promise<{ error?: string }>;
beforeEach(async () => {
  base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'th-relay-scope-')));
  shared = path.join(base, 'shared');
  sibling = path.join(base, 'sibling');
  await fsp.mkdir(shared);
  await fsp.mkdir(sibling);
  await fsp.writeFile(path.join(shared, 'source'), 'source');
  await fsp.symlink(sibling, path.join(shared, 'escape'));
  // Настоящий диспетчер FileOp без сокетов, tmux и конфигурации пользователя.
  const link = Object.create(RelayLink.prototype);
  link.sessions = { list: async () => [{ name: 'shared-session', path: shared }] };
  link.files = new FileService({ roots: [base] });
  let response: { error?: string };
  link.sendFrameBytes = (_session: unknown, bytes: Uint8Array) => {
    // jsonFrame возвращает закодированные байты кадра.
    response = frameJson<{ error?: string }>(decodeFrame(bytes));
  };
  const session = { scope: { session: 'shared-session', write: true, files: true } };
  dispatch = async (req) => {
    await link.doFileOp(session, decodeFrame(jsonFrame(FrameType.FileOp, 0, { root: base, ...req })) as Frame);
    return response;
  };
});
afterEach(async () => { await fsp.rm(base, { recursive: true, force: true }); });

for (const action of ['mkdir', 'upload-chunk', 'copy', 'move']) {
  it(`${action} rejects new targets through a symlink outside the shared directory`, async () => {
    const isDestination = action === 'copy' || action === 'move';
    const result = await dispatch({ action, path: isDestination ? 'shared/source' : 'shared/escape/new',
      ...(isDestination ? { dest: 'shared/escape/new' } : {}), data: 'eA==', offset: 0, last: true });
    expect(result.error).toBe('path outside shared session');
    expect(await fsp.readdir(sibling)).toEqual([]);
  });
}

it('allows a new target inside the shared directory', async () => {
  expect((await dispatch({ action: 'mkdir', path: 'shared/new' })).error).toBeUndefined();
  expect((await fsp.stat(path.join(shared, 'new'))).isDirectory()).toBe(true);
});

for (const action of ['write', 'remove', 'copy', 'move', 'stat-full']) {
  it(`${action} rejects an existing source outside the shared directory`, async () => {
    await fsp.writeFile(path.join(sibling, 'secret'), 'secret');
    const result = await dispatch({ action, path: 'shared/escape/secret', dest: 'shared/new', content: 'changed' });
    expect(result.error).toBe('path outside shared session');
    expect(await fsp.readFile(path.join(sibling, 'secret'), 'utf8')).toBe('secret');
  });
}

it('checks the default destination even when copy omits dest', async () => {
  const result = await dispatch({ action: 'copy', path: 'shared/source' });
  expect(result.error).toBe('path outside shared session');
});
