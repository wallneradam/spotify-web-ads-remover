const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture() {
    const calls = [];
    const headers = deferred();
    const body = deferred();
    const track = uri => ({ metadata: { uri, name: uri } });
    const state = (id, index) => ({ state_id: id, track: index,
        transitions: { advance: null }, restrictions: {}, disallow_seeking: false });
    const current = { state_machine_id: 'current',
        tracks: [track('spotify:track:music'), track('spotify:ad:pending')],
        states: [state('music', 0), state('ad', 1)] };
    const future = { state_machine_id: 'future', tracks: [track('spotify:track:next')],
        states: [state('filler-0', 0), state('filler-1', 0), state('next', 0)] };
    const context = vm.createContext({
        console: { log() {}, error() {} }, structuredClone,
        MutationObserver: class { observe() {} }, CustomEvent: class {},
        document: { documentElement: {}, dispatchEvent() {} }, setTimeout() {},
        wsHook: {}, window: { fetch(url, init) {
            const request = JSON.parse(init.body);
            calls.push(request.state_ref);
            if (request.state_ref.state_id === 'ad') {
                return Promise.resolve({ status: 200, json: async () => ({
                    state_machine: future, updated_state_ref: { state_index: 2 }
                }) });
            }
            return headers.promise;
        } }
    });
    const injected = path.join(__dirname, '..', 'injected');
    vm.runInContext(fs.readFileSync(path.join(injected, 'utils.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(process.env.AD_REMOVAL_SOURCE ||
        path.join(injected, 'ads_removal.js'), 'utf8'), context);
    return { context, current, calls, headers, body };
}

test('playback queue waits for restoration headers and JSON', async () => {
    const { context, current, calls, headers, body } = fixture();
    let finished = false;
    let followingStarted = false;
    const manipulation = context.statesManipuationQueue.enqueue(async () => {
        const result = await context.manipulateStateMachine(current, 0, false);
        finished = true;
        return result;
    });
    const following = context.statesManipuationQueue.enqueue(async () => { followingStarted = true; });
    try {
        await nextTurn();
        assert.equal(calls.length, 2);
        assert.equal(calls[1].state_machine_id, 'current');
        assert.equal(calls[1].state_id, 'music');
        assert.equal(finished, false);
        assert.equal(followingStarted, false);
        headers.resolve({ status: 200, json: () => body.promise });
        await nextTurn();
        assert.equal(finished, false, 'Restoration includes reading its response body');
        assert.equal(followingStarted, false);
    } finally {
        headers.resolve({ status: 200, json: () => body.promise });
        body.resolve({ state_machine: current, updated_state_ref: { state_index: 0 } });
        await Promise.all([manipulation, following]);
    }
    assert.equal(finished, true);
    assert.equal(followingStarted, true);
});

test('restoration failure reaches the caller and releases the queued operation', async () => {
    const { context, current, headers, body } = fixture();
    const manipulation = context.statesManipuationQueue.enqueue(
        () => context.manipulateStateMachine(current, 0, false));
    const rejection = assert.rejects(manipulation, /restore response failed/);
    let followingStarted = false;
    const following = context.statesManipuationQueue.enqueue(async () => { followingStarted = true; });
    await nextTurn();
    headers.resolve({ status: 200, json: () => body.promise });
    body.reject(new Error('restore response failed'));
    await rejection;
    await following;
    assert.equal(followingStarted, true);
});
