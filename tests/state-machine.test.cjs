const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');

function load() {
    const calls = [];
    const errors = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error(...values) { errors.push(values); } },
        structuredClone,
        MutationObserver: class { observe() {} },
        CustomEvent: class {},
        MessageEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        document: { documentElement: {}, dispatchEvent() {} },
        setTimeout(callback, delay = 0) { if (delay === 0) return setTimeout(callback, 0); },
        clearTimeout,
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
    return { context, calls, errors };
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

test('ordinary playback replacements wait for a pending ad operation unchanged', async () => {
    const { context } = load();
    let release;
    const pending = context.statesManipuationQueue.enqueue(() => new Promise(resolve => { release = resolve; }));
    const event = replacementEvent(machine());
    let delivered;
    const result = context.wsHook.after(event).then(value => { delivered = value; });
    try {
        await nextTurn();
        assert.equal(delivered, undefined);
    } finally {
        release();
        await pending;
        await result;
    }
    assert.equal(delivered, event);
});

test('non-playback socket traffic remains available during a pending state operation', async () => {
    const { context } = load();
    let release;
    const pending = context.statesManipuationQueue.enqueue(() => new Promise(resolve => { release = resolve; }));
    const event = { data: '{"type":"pong"}' };
    try {
        assert.equal(await context.wsHook.after(event), event);
        assert.equal(event.data, '{"type":"pong"}');
    } finally {
        release();
        await pending;
    }
});

test('a clean replacement cannot overtake an earlier delayed ad replacement', async () => {
    const { context } = load();
    let release;
    const delivery = [];
    context.manipulateStateMachine = async value => {
        await new Promise(resolve => { release = resolve; });
        return value;
    };
    const ad = context.wsHook.after(replacementEvent(machine('spotify:ad:pending'))).then(() => delivery.push('ad'));
    await nextTurn();
    const clean = context.wsHook.after(replacementEvent(machine())).then(() => delivery.push('clean'));
    try {
        await nextTurn();
        assert.deepEqual(delivery, []);
    } finally {
        release();
        await Promise.all([ad, clean]);
    }
    assert.deepEqual(delivery, ['ad', 'clean']);
});

test('a second state request and socket replacement wait for first response processing', async () => {
    const { context } = load();
    const requests = [];
    let release;
    let transforms = 0;
    const data = { state_machine: machine('spotify:ad:pending'), updated_state_ref: { state_index: 0 } };
    context.originalFetch = async (url, init) => {
        requests.push(JSON.parse(init.body).debug_source);
        return { status: 200, json: async () => structuredClone(data) };
    };
    context.manipulateStateMachine = async value => {
        if (++transforms === 1) await new Promise(resolve => { release = resolve; });
        return value;
    };
    const init = source => ({ headers: {}, body: JSON.stringify({ state_ref: null, debug_source: source }) });
    const first = context.window.fetch('https://example.test/state', init('first')).then(response => response.json());
    await nextTurn();
    const second = context.window.fetch('https://example.test/state', init('second')).then(response => response.json());
    let delivered = false;
    const socket = context.wsHook.after(replacementEvent(machine())).then(() => { delivered = true; });
    try {
        await nextTurn();
        assert.deepEqual(requests, ['first']);
        assert.equal(delivered, false);
    } finally {
        release();
        await Promise.all([first, second, socket]);
    }
    assert.deepEqual(requests, ['first', 'second']);
    assert.equal(delivered, true);
});

test('the SDK consumes a state response before the following socket replacement is delivered', async () => {
    const { context } = load();
    const requested = { state_machine_id: 'old', state_id: 'old', paused: false };
    const firstMachine = machine();
    firstMachine.state_machine_id = 'first';
    let sdkRef = requested;
    const delivery = [];
    context.originalFetch = async () => ({ status: 200, json: async () => ({
        state_machine: firstMachine, updated_state_ref: { state_index: 0, paused: false }
    }) });
    const first = context.window.fetch('https://example.test/state', { headers: {},
        body: JSON.stringify({ state_ref: requested }) })
        .then(response => response.json())
        .then(body => Promise.resolve({ body, status: 200 }))
        .then(response => Promise.resolve(response))
        .then(response => {
            sdkRef = context.stateRefFromMachine(response.body.state_machine, response.body.updated_state_ref);
            delivery.push('response');
        });
    const nextMachine = machine('spotify:track:next');
    nextMachine.state_machine_id = 'next';
    const previous = { state_machine_id: 'first', state_id: 'current', paused: false };
    const socket = context.wsHook.after({ data: JSON.stringify({ payloads: [{
        type: 'replace_state', prev_state_ref: previous,
        state_machine: nextMachine, state_ref: { state_index: 0, paused: false }
    }] }) }).then(event => {
        const command = JSON.parse(event.data).payloads[0];
        assert.equal(context.sameStateRef(sdkRef, command.prev_state_ref), true,
            'The SDK would reject a replacement delivered before its predecessor response is consumed');
        delivery.push('socket');
    });
    await Promise.all([first, socket]);
    assert.deepEqual(delivery, ['response', 'socket']);
});

test('an obsolete ad response does not issue a playback-changing future request', async () => {
    const { context, errors } = load();
    let respond;
    let transforms = 0;
    const original = { state_machine: machine('spotify:ad:departed'), updated_state_ref: { state_index: 0 } };
    context.originalFetch = () => new Promise(resolve => { respond = resolve; });
    context.manipulateStateMachine = async value => { transforms += 1; return value; };
    const old = { state_machine_id: 'old', state_id: 'ad' };
    const response = context.window.fetch('https://example.test/state', { headers: {}, body: JSON.stringify({ state_ref: old }) });
    await nextTurn();
    context.clientStateRef = { state_machine_id: 'new', state_id: 'selected' };
    respond({ status: 200, json: async () => original });
    assert.equal(await (await response).json(), original);
    assert.equal(transforms, 0);
    assert.deepEqual(errors, []);
    assert.equal(context.clientStateRef.state_id, 'selected');
});

test('a failed state request releases the next queued request', async () => {
    const { context } = load();
    let requests = 0;
    context.originalFetch = async () => {
        if (++requests === 1) throw Error('network failure');
        return { status: 200, json: async () => ({}) };
    };
    const init = () => ({ headers: {}, body: JSON.stringify({ state_ref: null }) });
    const first = context.window.fetch('https://example.test/state', init());
    const second = context.window.fetch('https://example.test/state', init());
    await assert.rejects(first, /network failure/);
    assert.deepEqual(await (await second).json(), {});
    assert.equal(requests, 2);
});

test('empty error responses retain their HTTP status and do not block playback requests', async () => {
    const { context } = load();
    for (const status of [204, 429, 502]) {
        const response = { status, json() { assert.fail('An empty error body must not be parsed by the filter'); } };
        context.originalFetch = async () => response;
        assert.equal(await context.window.fetch('https://example.test/state',
            { headers: {}, body: JSON.stringify({ state_ref: null }) }), response);
    }
});

test('a state response is filtered once even when its JSON is requested again', async () => {
    const { context } = load();
    let transforms = 0;
    context.manipulateStateMachine = async value => { transforms += 1; return value; };
    const body = { state_machine: machine('spotify:ad:pending'), updated_state_ref: { state_index: 0 } };
    const response = context.onStatesFetchResponseReceived('/state',
        { body: JSON.stringify({ state_ref: null }) }, { json: async () => body });
    assert.equal(await response.json(), await response.json());
    assert.equal(transforms, 1);
});

test('an ad replacement with an unrelated predecessor is passed through without server mutation', async () => {
    const { context } = load();
    context.clientStateRef = { state_machine_id: 'new', state_id: 'selected' };
    let transforms = 0;
    context.manipulateStateMachine = async value => { transforms += 1; return value; };
    const data = { payloads: [{ type: 'replace_state', prev_state_ref: { state_machine_id: 'old', state_id: 'ad' },
        state_machine: machine('spotify:ad:departed'), state_ref: { state_index: 0 } }] };
    const event = { data: JSON.stringify(data) };
    const before = event.data;
    await context.wsHook.after(event);
    assert.equal(transforms, 0);
    assert.equal(event.data, before);
    const body = { commands: data.payloads };
    const result = await context.onStatesFetchResponseReceived('/state_conflict',
        { body: JSON.stringify({ state_ref: context.clientStateRef }) }, { json: async () => body }).json();
    assert.equal(result, body);
    assert.equal(transforms, 0);
});

test('ordinary music graphs are preserved by the actual removal implementation', async () => {
    const { context } = load();
    const value = machine();
    value.tracks.push(track('spotify:track:next'));
    value.states.push(state('next', 1));
    value.states[0].transitions.advance = { state_index: 1 };
    const before = JSON.stringify(value);
    assert.equal(JSON.stringify(await context.manipulateStateMachine(value, 0, false)), before);
    const event = replacementEvent(value);
    const bytes = event.data;
    assert.equal(await context.wsHook.after(event), event);
    assert.equal(event.data, bytes);
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

test('state and Connect network requests wait for the preceding playback operation', async () => {
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
        await nextTurn();
        assert.equal(calls.length, 0);
    } finally {
        release();
        await pending;
        await Promise.all(results);
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init, stateInit);
    assert.equal(calls[1].init, connectInit);
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

test('a resumed music placeholder is delivered without another server advance', async () => {
    const { context } = load();
    const current = machine('spotify:ad:pending');
    const future = { state_machine_id: 'future', tracks: [track('spotify:track:wanted')], states: [state('wanted', 0, true)] };
    let resumes = 0;
    context.getStates = async () => { resumes += 1; return [future, { state_index: 0 }]; };
    const result = await context.manipulateStateMachine(current, 0, true);
    assert.equal(result.tracks[result.states[0].track].metadata.uri, 'spotify:track:wanted');
    assert.equal(result.states[0].disallow_seeking, true);
    assert.equal(resumes, 1, 'before_track_load must resolve the placeholder; another resume advances the server');
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
    const result = await context.manipulateStateMachine(current, 1, true);
    assert.equal(result.tracks[result.states[1].track].metadata.uri, 'spotify:track:wanted');
    assert.equal(restorationRequests, 0);
});

test('future discovery uses the returned current track rather than the last track', async () => {
    const { context } = load();
    const current = machine('spotify:ad:pending');
    const future = {
        state_machine_id: 'future',
        tracks: [track('spotify:track:wanted'), track('spotify:track:later')],
        states: [state('wanted', 0), state('later', 1)]
    };
    future.states[0].transitions.advance = { state_index: 1 };
    context.getStates = async () => [future, { state_index: 0 }];
    const [next] = await context.getNextAdFreeStateFromFutureStateMachine(current, current.states[0]);
    assert.equal(next.state_id, 'wanted');
});

test('grafting preserves the future graph and remaps every reachable transition', () => {
    const { context } = load();
    const current = machine('spotify:ad:pending');
    const future = {
        state_machine_id: 'future',
        tracks: [track('spotify:track:first'), track('spotify:track:second'), track('spotify:track:third')],
        states: [state('first', 0), state('second', 1), state('third', 2)]
    };
    future.states[0].transitions.advance = { state_index: 1 };
    future.states[0].transitions.skip_next = { state_index: 1 };
    future.states[1].transitions.advance = { state_index: 2 };
    future.states[2].transitions.skip_prev = { state_index: 1 };
    const before = JSON.stringify(future);
    const [first, result] = context.fixStateForOldStateMachine(future.states[0], future, 'current', current);
    result.states[0] = first;
    assert.equal(JSON.stringify(future), before);
    const secondIndex = first.transitions.advance.state_index;
    assert.equal(first.transitions.skip_next.state_index, secondIndex);
    const second = result.states[secondIndex];
    const third = result.states[second.transitions.advance.state_index];
    assert.equal(result.tracks[second.track].metadata.uri, 'spotify:track:second');
    assert.equal(result.tracks[third.track].metadata.uri, 'spotify:track:third');
    assert.equal(third.transitions.skip_prev.state_index, secondIndex);
});

test('canonical conflict predecessors match the client synthetic state reference', async () => {
    const { context, calls } = load();
    const local = { state_machine_id: 'old', state_id: '_future_+future+current', paused: false };
    await context.window.fetch('https://example.test/state', { headers: {}, body: JSON.stringify({ state_ref: local }) });
    const incoming = { payloads: [{
        type: 'replace_state', state_machine: machine(), state_ref: { state_index: 0, paused: false },
        prev_state_ref: { state_machine_id: 'future', state_id: 'current', paused: false }
    }] };
    const delivered = await context.wsHook.after({ data: JSON.stringify(incoming) });
    assert.deepEqual(JSON.parse(delivered.data).payloads[0].prev_state_ref, local);
    assert.equal(JSON.parse(calls[0].init.body).state_ref.state_id, 'current');
    assert.equal(JSON.parse(calls[0].init.body).state_ref.state_machine_id, 'future');
});

test('conflict requests normalize synthetic rejected references and accept null entries', async () => {
    const { context, calls, errors } = load();
    const init = { headers: {}, body: JSON.stringify({
        state_ref: { state_machine_id: 'old', state_id: '_future_+future+current', paused: false },
        rejected_state_refs: [null, { state_machine_id: 'old', state_id: '_future_+future+rejected', paused: false }]
    }) };
    await context.window.fetch('https://example.test/state_conflict', init);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.rejected_state_refs[0], null);
    assert.equal(sent.rejected_state_refs[1].state_machine_id, 'future');
    assert.equal(sent.rejected_state_refs[1].state_id, 'rejected');
    const data = { commands: [{ type: 'replace_state', state_machine: machine(), state_ref: { state_index: 0 } }] };
    assert.equal(await context.onStatesFetchResponseReceived('/state_conflict', init, { json: async () => data }).json(), data);
    assert.equal(errors.length, 0);
});

test('cyclic advance paths terminate without hanging the filter', () => {
    const { context } = load();
    const value = machine('spotify:ad:first');
    value.tracks.push(track('spotify:ad:second'));
    value.states.push(state('second', 1));
    value.states[0].transitions.advance = { state_index: 1 };
    value.states[1].transitions.advance = { state_index: 0 };
    context.cyclicFixture = value;
    assert.equal(vm.runInContext("Array.from(statesGenerator(cyclicFixture.states, 0, 'advance')).length", context, { timeout: 100 }), 2);
});

test('resolving a local successor adopts the server current state', async () => {
    const { context } = load();
    const current = machine('spotify:ad:pending');
    current.tracks.push(track('spotify:track:placeholder'));
    current.states.push(state('placeholder', 1, true));
    current.states[0].transitions.advance = { state_index: 1 };
    const resolved = machine('spotify:track:server-current');
    resolved.state_machine_id = 'resolved';
    context.getStates = async () => [resolved, { state_index: 0 }];
    const result = await context.manipulateStateMachine(current, 0, true);
    assert.equal(result.tracks[result.states[0].track].metadata.uri, 'spotify:track:server-current');
    assert.equal(result.states[0].state_id, '_future_+resolved+current');
});

test('unrelated predecessor states are not changed or accepted as the current state', async () => {
    const { context } = load();
    const local = { state_machine_id: 'old', state_id: '_future_+future+current', paused: false };
    await context.window.fetch('https://example.test/state', { headers: {}, body: JSON.stringify({ state_ref: local }) });
    const event = { data: JSON.stringify({ payloads: [{
        type: 'replace_state', state_machine: machine(), state_ref: { state_index: 0 },
        prev_state_ref: { state_machine_id: 'unrelated', state_id: 'current', paused: false }
    }] }) };
    const before = event.data;
    assert.equal(await context.wsHook.after(event), event);
    assert.equal(event.data, before);
    assert.deepEqual(JSON.parse(JSON.stringify(context.clientStateRef)), local);
});

test('a clean state response ends synthetic predecessor translation', async () => {
    const { context } = load();
    const local = { state_machine_id: 'old', state_id: '_future_+future+current', paused: false };
    context.clientStateRef = local;
    const clean = machine();
    clean.state_machine_id = 'future';
    const data = { state_machine: clean, updated_state_ref: { state_index: 0, paused: false } };
    await context.onStatesFetchResponseReceived('/state', { body: JSON.stringify({ state_ref: local }) }, { json: async () => data }, local).json();
    const event = { data: JSON.stringify({ payloads: [{
        type: 'replace_state', state_machine: machine('spotify:track:next'), state_ref: { state_index: 0, paused: false },
        prev_state_ref: { state_machine_id: 'future', state_id: 'current', paused: false }
    }] }) };
    const before = event.data;
    await context.wsHook.after(event);
    assert.equal(event.data, before);
});

test('ordinary state request bytes are retained', async () => {
    const { context, calls } = load();
    const body = '{ "state_ref": {"state_machine_id":"machine", "state_id":"current"} }';
    await context.window.fetch('https://example.test/state', { headers: {}, body });
    assert.equal(calls[0].init.body, body);
});

test('the live Spotify SDK accepts a replacement after a copied future state', { skip: !process.env.SPOTIFY_SDK_PATH }, async () => {
    const { context } = load();
    const sdk = fs.readFileSync(process.env.SPOTIFY_SDK_PATH, 'utf8');
    const start = sdk.indexOf('_isCurrentStateRef(t){');
    const end = sdk.indexOf('_logUnsentStateUpdate(', start);
    assert.ok(start >= 0 && end > start, 'Live SDK state comparison shape changed');
    vm.runInContext('globalThis.sdkStateComparison={' + sdk.slice(start, end) + '};', context);
    const local = { state_machine_id: 'old', state_id: '_future_+future+current', paused: false };
    context.sdkStateComparison._currentContext = { getStateRef: () => local };
    await context.window.fetch('https://example.test/state', { headers: {}, body: JSON.stringify({ state_ref: local }) });
    const incoming = { payloads: [{
        type: 'replace_state', state_machine: machine(), state_ref: { state_index: 0, paused: false },
        prev_state_ref: { state_machine_id: 'future', state_id: 'current', paused: false }
    }] };
    assert.equal(context.sdkStateComparison._isCurrentStateRef(incoming.payloads[0].prev_state_ref), false);
    const result = await context.wsHook.after({ data: JSON.stringify(incoming) });
    assert.equal(context.sdkStateComparison._isCurrentStateRef(JSON.parse(result.data).payloads[0].prev_state_ref), true);
});

test('a future ad does not advance the server while the current music still plays', async () => {
    const { context } = load();
    const current = machine();
    current.tracks.push(track('spotify:ad:pending'));
    current.states.push(state('ad', 1));
    current.states[0].transitions.advance = { state_index: 1 };
    let serverUpdates = 0;
    context.getNextAdFreeStateFromFutureStateMachine = async () => { serverUpdates += 1; throw Error('unexpected server update'); };
    const before = JSON.stringify(current);
    const result = await context.manipulateStateMachine(current, 0, false);
    assert.equal(serverUpdates, 0);
    assert.equal(JSON.stringify(result), before);
});

test('future ad removal stays local when the following music has complete transitions', async () => {
    const { context } = load();
    const current = machine();
    current.tracks.push(track('spotify:ad:pending'), track('spotify:track:next'));
    current.states.push(state('ad', 1), state('next', 2));
    current.states[0].transitions.advance = { state_index: 1 };
    current.states[1].transitions.advance = { state_index: 2 };
    context.getStates = async () => { throw Error('unexpected server update'); };
    const result = await context.manipulateStateMachine(current, 0, false);
    assert.equal(result.tracks[result.states[0].track].metadata.uri, 'spotify:track:current');
    assert.equal(result.tracks[result.states[1].track].metadata.uri, 'spotify:track:next');
});

function liveSDKMethod(name, nextName, globals = {}) {
    const sdk = fs.readFileSync(process.env.SPOTIFY_SDK_PATH, 'utf8');
    const start = sdk.search(new RegExp(name + '\\([^)]*\\)\\{'));
    const next = sdk.slice(start + 1).search(new RegExp(nextName + '\\([^)]*\\)\\{'));
    const end = next < 0 ? -1 : start + 1 + next;
    assert.ok(start >= 0 && end > start);
    const source = sdk.slice(start, end);
    return Function(...Object.keys(globals), 'return ({' + source + '}).' + name)(...Object.values(globals));
}

test('natural ad transitions wait for asynchronously delivered SDK playback before returning state',
    { skip: !process.env.SPOTIFY_SDK_PATH }, async () => {
    const { context } = load();
    context.showToast = () => {};
    const adMachine = machine('spotify:ad:natural');
    const adRef = { state_machine_id: 'machine', state_id: 'current', paused: false };
    const music = machine('spotify:track:music');
    music.state_machine_id = 'music-machine';
    music.states[0].state_id = 'music-state';
    context.setTimeout = setTimeout;
    let playbackLoads = 0;
    let rejected = 0;
    let loadedURI = 'spotify:ad:natural';
    const createContext = (value, reference) => ({
        machine: value, reference,
        getStateRef() { return this.reference; },
        setStateMachine(next) { this.machine = next; },
        setCurrentState(next) { this.reference = context.stateRefFromMachine(this.machine, next); },
        setContextMetadata() {},
        startAtState(next) { this.setCurrentState(next); },
        setSupportsExternalUrlPlaybackSpeed() {}
    });
    const client = {
        _currentContext: createContext(adMachine, adRef),
        _ListClass: { create: () => createContext(null, null) },
        _listPlayer: { play(value) {
            playbackLoads += 1;
            loadedURI = value.machine.tracks[value.machine.states[0].track].metadata.uri;
            context.window.fetch('https://example.test/state', { headers: {},
                body: JSON.stringify({ state_ref: value.getStateRef(), debug_source: 'before_track_load' }) });
        } },
        _createStateRef: (value, ref) => context.stateRefFromMachine(value, ref),
        _onBeforeTrackChange() {}, _emitStateChanged() {},
        _rejectState() { rejected += 1; }
    };
    client._isCurrentStateRef = liveSDKMethod('_isCurrentStateRef', '_logUnsentStateUpdate');
    client._replaceState = liveSDKMethod('_replaceState', '_clearContextAndState', { tl: { By: { REMOTE: 'remote' } } });
    client._handleStateUpdateResponse = liveSDKMethod('_handleStateUpdateResponse', '_isCurrentStateRef');
    // A state response alone updates SDK metadata while the already loaded ad keeps playing.
    await client._handleStateUpdateResponse(adRef, { status: 200, body: { state_machine: music, updated_state_ref: { state_index: 0 } } });
    assert.equal(playbackLoads, 0);
    assert.equal(loadedURI, 'spotify:ad:natural');
    client._currentContext = createContext(adMachine, adRef);
    const incoming = replacementEvent(adMachine);
    incoming.dispatchReplacement = message => {
        nextTurn().then(() => client._replaceState(message.payloads[0]));
        return true;
    };
    context.rememberStateReplacementChannel(incoming);
    context.clientStateRef = adRef;
    context.getNextAdFreeStateFromFutureStateMachine = async () => [music.states[0], music];
    const init = { body: JSON.stringify({ state_ref: adRef, debug_source: 'before_track_load' }) };
    const data = await context.onStatesFetchResponseReceived('/state', init, {
        json: async () => ({ state_machine: structuredClone(adMachine), updated_state_ref: { state_index: 0 } })
    }, adRef).json();
    await client._handleStateUpdateResponse(adRef, { status: 200, body: data });
    await nextTurn();
    assert.equal(rejected, 0, 'The state response must not advance the predecessor before the dealer command');
    assert.equal(playbackLoads, 1);
    assert.equal(loadedURI, 'spotify:track:music');
    assert.equal(context.totalAdsRemoved, 0, 'late ad metadata replacement must not count a removal');
    // Only the following genuine music load can confirm the removal.
    const currentRef = client._currentContext.getStateRef();
    context.clientStateRef = currentRef;
    const nextInit = { body: JSON.stringify({ state_ref: currentRef, debug_source: 'before_track_load' }) };
    await context.onStatesFetchResponseReceived('/state', nextInit, {
        json: async () => ({ state_machine: structuredClone(music), updated_state_ref: { state_index: 0 } })
    }, currentRef).json();
    assert.equal(context.totalAdsRemoved, 1);
});

test('a late ad response cannot replace a newer user selection', async () => {
    const { context } = load();
    context.clientStateRef = { state_machine_id: 'new', state_id: 'selection', paused: false };
    context.stateReplacementChannel = { dispatch() { assert.fail('Must not overwrite a newer selection'); }, envelope: {} };
    assert.equal(await context.replaceLoadedAd({ state_machine: machine(), updated_state_ref: { state_index: 0 } },
        { state_machine_id: 'old', state_id: 'ad', paused: false }), false);
});

test('ad media is muted during resolution and the original music mute setting is restored', () => {
    const { context } = load();
    const events = [];
    const sources = new WeakMap();
    class Media { constructor(muted) { this.muted = muted; } }
    Object.defineProperty(Media.prototype, 'src', { configurable: true,
        get() { return sources.get(this); }, set(value) { sources.set(this, value); events.push('load'); } });
    context.HTMLMediaElement = Media;
    context.URL = URL;
    context.document.baseURI = 'https://open.spotify.com/';
    context.installAdMediaGuard();
    for (const initiallyMuted of [false, true]) {
        const element = new Media(initiallyMuted);
        element.src = 'https://audio-fa.scdn.co/music';
        assert.equal(element.muted, initiallyMuted);
        element.src = 'https://adstudio-assets.scdn.co/ad.mp3';
        assert.equal(element.muted, true);
        element.src = 'https://adstudio-assets.scdn.co/second-ad.mp3';
        assert.equal(element.muted, true);
        element.src = 'https://audio-fa.scdn.co/next-music';
        assert.equal(element.muted, initiallyMuted);
    }
    assert.equal(events.length, 8, 'sources must still reach the underlying media engine');
});


test('an unaccepted dealer replacement preserves the original ad response instead of publishing false music metadata', async () => {
    const { context } = load();
    context.setTimeout = callback => setTimeout(callback, 5);
    const adRef = { state_machine_id: 'machine', state_id: 'current', paused: false };
    context.clientStateRef = adRef;
    context.stateReplacementChannel = { dispatch: () => true, envelope: {} };
    const ad = machine('spotify:ad:pending');
    const original = { state_machine: structuredClone(ad), updated_state_ref: { state_index: 0, paused: false } };
    const music = machine('spotify:track:next');
    music.state_machine_id = 'future';
    context.getNextAdFreeStateFromFutureStateMachine = async () => [music.states[0], music];
    const result = await context.onStatesFetchResponseReceived('/state', {
        body: JSON.stringify({ state_ref: adRef, debug_source: 'before_track_load' })
    }, { json: async () => structuredClone(original) }, adRef).json();
    assert.equal(JSON.stringify(result), JSON.stringify(original));
    assert.equal(context.pendingPlaybackReplacement, null);
});

test('a newer SDK selection cancels the pending replacement acknowledgement', async () => {
    const { context } = load();
    context.setTimeout = setTimeout;
    const previous = { state_machine_id: 'old', state_id: 'ad', paused: false };
    const next = machine();
    const requested = { state_machine_id: 'user', state_id: 'selected', paused: false };
    context.clientStateRef = previous;
    context.stateReplacementChannel = { dispatch() {
        context.window.fetch('https://example.test/state', { headers: {}, body: JSON.stringify({ state_ref: requested }) });
        return true;
    }, envelope: {} };
    assert.equal(await context.replaceLoadedAd({ state_machine: next, updated_state_ref: { state_index: 0 } }, previous), false);
    assert.equal(JSON.stringify(context.clientStateRef), JSON.stringify(requested));
    assert.equal(context.pendingPlaybackReplacement, null);
});


test('a departed ad finalization cannot advance the server or replace the active music reference', async () => {
    const { context } = load();
    const active = { state_machine_id: 'music-machine', state_id: 'music', paused: false };
    const departed = { state_machine_id: 'ad-machine', state_id: 'ad', paused: false };
    context.clientStateRef = active;
    const ad = machine('spotify:ad:departed');
    ad.state_machine_id = departed.state_machine_id;
    ad.states[0].state_id = departed.state_id;
    const data = { state_machine: ad, updated_state_ref: { state_index: 0 }, endsong: { fixture: true } };
    context.getStates = async () => { assert.fail('Ended-track telemetry must not alter the server playback state'); };
    context.manipulateStateMachine = async () => { assert.fail('A departed state must not be rewritten as current playback'); };
    const response = await context.window.fetch('https://example.test/state', { headers: {},
        body: JSON.stringify({ state_ref: departed, debug_source: 'track_data_finalized' }) });
    assert.equal(JSON.stringify(context.clientStateRef), JSON.stringify(active));
    const result = await context.onStatesFetchResponseReceived('/state', {
        body: JSON.stringify({ state_ref: departed, debug_source: 'track_data_finalized' })
    }, { json: async () => data }, departed).json();
    assert.equal(result, data);
    assert.equal(JSON.stringify(context.clientStateRef), JSON.stringify(active));
    await response.json();
});
