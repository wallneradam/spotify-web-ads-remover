const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');

function load() {
    const calls = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        structuredClone,
        MutationObserver: class { observe() {} },
        CustomEvent: class {},
        MessageEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        document: { documentElement: {}, dispatchEvent() {} },
        setTimeout() {},
        window: { fetch(url, init) {
            calls.push({ url, init });
            return Promise.resolve({ status: 200, json: async () => ({}) });
        } },
        wsHook: {}
    });
    const root = path.join(__dirname, '..', 'injected');
    vm.runInContext(fs.readFileSync(path.join(root, 'utils.js'), 'utf8'), context);
    const source = process.env.AD_REMOVAL_SOURCE || path.join(root, 'ads_removal.js');
    vm.runInContext(fs.readFileSync(source, 'utf8'), context);
    context.getStateMachineDestripction = () => 'fixture';
    return { context, calls };
}

const track = uri => ({ metadata: { uri, name: uri } });
const state = (id, trackIndex, disallow = false) => ({
    state_id: id, track: trackIndex, disallow_seeking: disallow,
    transitions: { advance: null }, restrictions: {}
});
const machine = (uri = 'spotify:track:current') => ({
    state_machine_id: 'machine', tracks: [track(uri)], states: [state('current', 0)]
});
const replacementEvent = value => ({ data: JSON.stringify({ payloads: [{
    type: 'replace_state', state_machine: value, state_ref: { state_index: 0 }
}] }) });

test('ordinary WebSocket updates bypass a pending ad operation unchanged', async () => {
    const { context } = load();
    let release;
    const pending = context.statesManipuationQueue.enqueue(() => new Promise(resolve => { release = resolve; }));
    const event = replacementEvent(machine());
    let delivered;
    const result = context.wsHook.after(event).then(value => { delivered = value; });
    try {
        await nextTurn();
        assert.equal(delivered, event);
    } finally {
        release();
        await pending;
        await result;
    }
});

test('ad-bearing and previously rewritten states remain serialized', async () => {
    const { context } = load();
    let release;
    const pending = context.statesManipuationQueue.enqueue(() => new Promise(resolve => { release = resolve; }));
    const rewritten = machine();
    rewritten.states[0].state_id = '_future_+future+rewritten';
    context.tamperedStatesMap.rewritten = 'spotify:ad:removed';
    let processed = 0;
    context.manipulateStateMachine = async value => { processed += 1; return value; };
    const results = [machine('spotify:ad:pending'), rewritten].map(value => context.wsHook.after(replacementEvent(value)));
    await nextTurn();
    assert.equal(processed, 0);
    release();
    await pending;
    await Promise.all(results);
    assert.equal(processed, 2);
});

test('state and Connect network requests do not wait for the ad queue', async () => {
    const { context, calls } = load();
    let release;
    const pending = context.statesManipuationQueue.enqueue(() => new Promise(resolve => { release = resolve; }));
    const stateInit = { headers: {}, body: JSON.stringify({ state_ref: { state_id: 'current' } }) };
    const connectInit = { body: JSON.stringify({ command: { endpoint: 'skip_prev' } }) };
    const results = [
        context.window.fetch('https://example.test/state', stateInit),
        context.window.fetch('https://example.test/connect-state/command', connectInit)
    ];
    try {
        assert.equal(calls.length, 2);
        assert.equal(calls[0].init, stateInit);
        assert.equal(calls[1].init, connectInit);
    } finally {
        release();
        await pending;
        await Promise.all(results);
    }
});

test('ordinary state and conflict responses preserve the original data', async () => {
    const { context } = load();
    let processed = 0;
    context.manipulateStateMachine = async value => { processed += 1; return value; };
    const reference = { state_index: 0, state_machine_id: 'machine' };
    const init = { body: JSON.stringify({ state_ref: reference, rejected_state_refs: [] }) };
    for (const data of [
        { state_machine: machine(), updated_state_ref: reference },
        { commands: { replacement: { type: 'replace_state', state_machine: machine(), state_ref: reference } } }
    ]) {
        const response = { json: async () => data };
        assert.equal(await context.onStatesFetchResponseReceived('/state', init, response).json(), data);
    }
    assert.equal(processed, 0);
});

test('ad state responses still invoke the removal path', async () => {
    const { context } = load();
    let processed = 0;
    context.manipulateStateMachine = async value => { processed += 1; return value; };
    const data = { state_machine: machine('spotify:ad:pending'), updated_state_ref: { state_index: 0 } };
    const init = { body: JSON.stringify({ state_ref: { state_id: 'current' } }) };
    await context.onStatesFetchResponseReceived('/state', init, { json: async () => data }).json();
    assert.equal(processed, 1);
});

test('transition lookup retains the expected track despite a drifting state index', async () => {
    const { context } = load();
    const current = machine();
    current.tracks.push(track('spotify:ad:pending'));
    current.states.push(state('ad', 1));
    const firstFuture = { state_machine_id: 'first-future', tracks: [track('spotify:track:wanted')], states: [state('wanted', 0, true)] };
    const resolved = {
        state_machine_id: 'resolved-future',
        tracks: [track('spotify:track:wrong'), track('spotify:track:wanted')],
        states: [state('wrong', 0), state('wanted-ready', 1)]
    };
    context.getNextAdFreeState = () => current.states[1];
    context.getNextAdFreeStateFromFutureStateMachine = async () => [firstFuture.states[0], firstFuture];
    const requests = [];
    context.getStates = async (...args) => { requests.push(args); return [resolved, { state_index: 0 }]; };
    const result = await context.manipulateStateMachine(current, 0, true);
    assert.equal(result.tracks[result.states[1].track].metadata.uri, 'spotify:track:wanted');
    assert.equal(requests.length, 1, 'must not request restoration of the original ad-bearing machine');
    assert.equal(requests[0][1], '_future_+first-future+wanted');
});

test('future-state discovery does not restore the original ad-bearing machine', async () => {
    const { context } = load();
    const current = machine();
    current.tracks.push(track('spotify:ad:pending'));
    current.states.push(state('ad', 1));
    const future = { state_machine_id: 'future', tracks: [track('spotify:track:wanted')], states: [state('wanted', 0)] };
    context.getNextAdFreeState = () => current.states[1];
    context.getNextAdFreeStateFromFutureStateMachine = async () => [future.states[0], future];
    let restorationRequests = 0;
    context.getStates = async () => { restorationRequests += 1; return [current, { state_index: 0 }]; };
    const result = await context.manipulateStateMachine(current, 0, true);
    assert.equal(result.tracks[result.states[1].track].metadata.uri, 'spotify:track:wanted');
    assert.equal(restorationRequests, 0);
});
