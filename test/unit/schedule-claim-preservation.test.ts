import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { createScheduledRunManager, scheduledRunStorePath } from '../../src/runs/background/scheduled-runs.ts';
const t0 = Date.parse('2030-01-01T00:00:00Z');
async function setup(kind, action) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claim-boundary-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const storeRoot = path.join(root, 'stores');
    const clock = { now: t0 };
    const ctx = { cwd: project, sessionManager: { getSessionId: () => 'probe', getSessionFile: () => path.join(project, 'probe.jsonl') } };
    const timers = new Map();
    let timerId = 0;
    let launches = 0;
    let id = 0;
    const manager = createScheduledRunManager({ config: { scheduledRuns: { enabled: true } }, storeRoot, now: () => clock.now, randomId: () => `probe-${++id}`,
        timers: { setTimeout: (callback, delay) => { const key = ++timerId; timers.set(key, { callback, delay }); return key; }, clearTimeout: key => timers.delete(key) },
        launch: async () => { launches++; return { content: [], details: { asyncId: 'probe-async' } }; }
    });
    const originalOpen = fs.openSync;
    try {
        manager.bindSession(ctx);
        const trigger = kind === 'calendar' ? { every: 'day', at: '09:00', timezone: 'Asia/Taipei' } : kind === 'once' ? { at: '+1h' } : { every: '1h' };
        const create = await manager.handleToolCall({ action: 'schedule.create', id: 'check', workflowScript: 'return 1', ...trigger }, ctx);
        assert.equal(create.isError, undefined);
        const dir = path.join(scheduledRunStorePath(project, undefined, storeRoot), 'check');
        const file = path.join(dir, 'schedule.json');
        const lock = path.join(dir, 'active.lock');
        clock.now = t0 + 3600000;
        fs.writeFileSync(lock, 'owner-proof');
        const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
        await action({ manager, ctx, dir, file, lock, read, clock, timers, launches: () => launches, originalOpen });
    }
    finally {
        fs.openSync = originalOpen;
        syncBuiltinESMExports();
        manager.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
}
for (const kind of ['interval', 'calendar', 'once'])
    it(`EEXIST preserves current owner edits: ${kind}`, async () => setup(kind, async (h) => {
        let current;
        fs.openSync = function (file, flags, ...args) {
            if (file === h.lock && flags === 'wx') {
                current = h.read();
                current.activeRunId = 'winner';
                current.lastRunId = 'winner';
                current.name = 'Edited by owner';
                current.paused = true;
                fs.writeFileSync(h.file, JSON.stringify(current));
            }
            return h.originalOpen.call(fs, file, flags, ...args);
        };
        syncBuiltinESMExports();
        const result = await h.manager.handleToolCall({ action: 'schedule.run-due' }, h.ctx);
        assert.equal(result.isError, undefined);
        assert.deepEqual(h.read(), current);
        assert.equal(h.launches(), 0);
        assert.equal(h.timers.size, 0);
        assert.equal(fs.readFileSync(h.lock, 'utf8'), 'owner-proof');
    }));
for (const kind of ['interval', 'calendar', 'once'])
    it(`EEXIST before owner persistence avoids immediate polling: ${kind}`, async () => setup(kind, async (h) => {
        const before = h.read();
        const result = await h.manager.handleToolCall({ action: 'schedule.run-due' }, h.ctx);
        assert.equal(result.isError, undefined);
        assert.deepEqual(h.read(), before);
        const delays = [...h.timers.values()].map(timer => timer.delay);
        if (kind === 'once')
            assert.deepEqual(delays, []);
        else
            assert.equal(delays.length === 1 && delays[0] > 0, true);
        assert.equal(h.launches(), 0);
        assert.equal(fs.readFileSync(h.lock, 'utf8'), 'owner-proof');
    }));
it('EEXIST does not recreate a concurrently removed schedule', async () => setup('interval', async (h) => {
    fs.openSync = function (file, flags, ...args) {
        try {
            return h.originalOpen.call(fs, file, flags, ...args);
        }
        catch (error) {
            if (file === h.lock && flags === 'wx' && error.code === 'EEXIST')
                fs.rmSync(h.dir, { recursive: true, force: true });
            throw error;
        }
    };
    syncBuiltinESMExports();
    const result = await h.manager.handleToolCall({ action: 'schedule.run-due' }, h.ctx);
    assert.equal(result.isError, undefined);
    assert.equal(fs.existsSync(h.dir), false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.launches(), 0);
}));
