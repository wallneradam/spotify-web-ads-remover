var spotifyAdRemoverCompatibility = "track-uri-v1+non-ad-fast-path-v1+no-state-restore-v1";

var currentTracks = [];
var removedAdsList = [];
var tamperedStatesMap = {};
var deviceId = "";
var clientStateRef = null;
var stateReplacementChannel = null;
var pendingPlaybackReplacement = null;

function installAdMediaGuard()
{
    if (typeof HTMLMediaElement == "undefined") return;
    var descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (descriptor == null || !descriptor.configurable || descriptor.set == null) return;
    var savedMute = new WeakMap();
    Object.defineProperty(HTMLMediaElement.prototype, "src", {...descriptor, set: function(source) {
        var ad = false;
        try { ad = new URL(source, document.baseURI).hostname == "adstudio-assets.scdn.co"; } catch {}
        if (ad && !savedMute.has(this)) savedMute.set(this, this.muted);
        descriptor.set.call(this, source);
        if (ad)
        {
            this.muted = true;
            console.log("SpotiAds: Silenced ad media while resolving the next music state");
        }
        else if (savedMute.has(this))
        {
            this.muted = savedMute.get(this);
            savedMute.delete(this);
        }
    }});
}

installAdMediaGuard();

function rememberStateReplacementChannel(messageEvent)
{
    if (typeof messageEvent.dispatchReplacement != "function") return;
    try
    {
        var data = JSON.parse(messageEvent.data);
        if ((data.payloads || []).some(function(payload) { return payload != null && payload.type == "replace_state"; }))
            stateReplacementChannel = {dispatch: messageEvent.dispatchReplacement, envelope: {...data, payloads: []}};
    }
    catch {}
}

async function replaceLoadedAd(data, requestedClientRef)
{
    if (stateReplacementChannel == null || !sameStateRef(clientStateRef, requestedClientRef)) return false;
    var replacement = {type: "replace_state", state_machine: data.state_machine,
        state_ref: data.updated_state_ref, prev_state_ref: requestedClientRef,
        context_metadata: data.context_metadata};
    var pending = {target: stateRefFromMachine(data.state_machine, data.updated_state_ref), predecessor: requestedClientRef};
    var completed = new Promise(function(resolve) { pending.resolve = resolve; });
    var timeout = setTimeout(function() { pending.resolve(false); }, 1500);
    pendingPlaybackReplacement = pending;
    try
    {
        if (!stateReplacementChannel.dispatch({...stateReplacementChannel.envelope, payloads: [replacement]})) return false;
        console.log("SpotiAds: Waiting for the SDK to load the replacement music state");
        var accepted = await completed;
        if (accepted) console.log("SpotiAds: SDK confirmed replacement music playback load");
        else console.warn("SpotiAds: Replacement music load was not confirmed; retaining the original state response");
        return accepted;
    }
    catch (error)
    {
        console.error("SpotiAds: Could not replace the loaded ad", error);
        return false;
    }
    finally
    {
        clearTimeout(timeout);
        if (pendingPlaybackReplacement === pending) pendingPlaybackReplacement = null;
    }
}

function acknowledgePlaybackReplacement(ref)
{
    var pending = pendingPlaybackReplacement;
    if (pending == null) return;
    if (sameStateRef(ref, pending.target)) pending.resolve(true);
    else if (!sameStateRef(ref, pending.predecessor)) pending.resolve(false);
}

function normalizeStateRef(ref)
{
    if (ref == null || typeof ref.state_id != "string") return ref;
    var normalized = {...ref};
    var match;
    while ((match = /^_future_\+([^+]+)\+(.+)$/.exec(normalized.state_id)) != null)
    {
        normalized.state_machine_id = match[1];
        normalized.state_id = match[2];
    }
    return normalized;
}

function sameStateRef(left, right)
{
    if (left == null || right == null) return left == right;
    return left.state_machine_id == right.state_machine_id && left.state_id == right.state_id
        && !!left.paused == !!right.paused;
}

function stateRefFromMachine(machine, ref)
{
    var state = machine == null || ref == null ? null : machine.states[ref.state_index];
    return state == null ? null : {state_machine_id: machine.state_machine_id,
        state_id: state.state_id, paused: !!ref.paused};
}

function reconcileReplacement(command)
{
    if (command == null || command.type != "replace_state") return false;
    if (!sameStateRef(normalizeStateRef(command.prev_state_ref), normalizeStateRef(clientStateRef))) return false;
    var changed = !sameStateRef(command.prev_state_ref, clientStateRef);
    if (changed) command.prev_state_ref = clientStateRef == null ? null : {...clientStateRef};
    clientStateRef = stateRefFromMachine(command.state_machine, command.state_ref);
    return changed;
}

var totalAdsRemoved = 0;

var originalFetch = window.fetch;
var isFetchInterceptionWorking = false;
var isWebScoketInterceptionWorking = false;
var isSimulatingStateChnage = false;
var didShowMultiDeviceWarning = false;
var didShowInterceptionWarning = false;
var didCheckForInterception = false;


var accessToken = "";
var clientToken = "";
var authorizationHeader = "";

startObserving();

document.dispatchEvent(new CustomEvent('updateCounter', {detail: 0}));

var statesManipuationQueue = new PromiseQueue();

function stateMachineNeedsFiltering(stateMachine)
{
    if (stateMachine == null) return false;
    if (Array.isArray(stateMachine["tracks"]) && stateMachine["tracks"].some(isAdTrack)) return true;
    return Array.isArray(stateMachine["states"]) && stateMachine["states"].some(function(state) {
        return state != null && tamperedStatesMap[getFutureStateId(state["state_id"])] != null;
    });
}

function stateResponseNeedsFiltering(data)
{
    if (stateMachineNeedsFiltering(data == null ? null : data["state_machine"])) return true;
    var commands = data == null ? null : data["commands"];
    return commands != null && Object.keys(commands).some(function(key) {
        return stateMachineNeedsFiltering(commands[key] == null ? null : commands[key]["state_machine"]);
    });
}

function webSocketMessageNeedsFiltering(messageEvent)
{
    try
    {
        var data = JSON.parse(messageEvent.data);
        if (!Array.isArray(data.payloads)) return false;
        return data.payloads.some(function(payload) {
            if (payload == null) return false;
            if (payload.type == "replace_state")
            {
                var needsFiltering = stateMachineNeedsFiltering(payload["state_machine"]);
                if (!needsFiltering && payload["state_machine"] != null && payload["state_ref"] != null)
                {
                    console.log("SpotiAds: Passing through state machine: "
                        + getStateMachineDestripction(payload["state_machine"], payload["state_ref"]["state_index"])
                        + " (state machine id: " + payload["state_machine"]["state_machine_id"]
                        + ", source:web_socket_fast_path)");
                }
                return needsFiltering;
            }
            var track = payload.cluster == null || payload.cluster.player_state == null
                ? null
                : payload.cluster.player_state.track;
            return isAdTrack(track);
        });
    }
    catch
    {
        return false;
    }
}


//
// Hook the fetch() function.
//
window.fetch = function(url, init)
{
    var url = typeof(url) == 'string' ? url : url.toString();

    if (url != undefined && url.includes("/state"))
    {
        if (init.headers["authorization"])
            authorizationHeader = init.headers["authorization"];
        if (init.headers["client-token"])
            clientToken = init.headers["client-token"];

        var request = JSON.parse(init.body);
        var requestedClientRef = request.state_ref == null ? null : {...request.state_ref};
        if (request.debug_source != "track_data_finalized")
        {
            clientStateRef = requestedClientRef;
            acknowledgePlaybackReplacement(requestedClientRef);
        }
        var normalizedRef = normalizeStateRef(request.state_ref);
        var changed = !sameStateRef(request.state_ref, normalizedRef);
        request.state_ref = normalizedRef;
        if (Array.isArray(request.rejected_state_refs))
            request.rejected_state_refs = request.rejected_state_refs.map(function(ref) {
                var normalized = normalizeStateRef(ref);
                changed = !sameStateRef(ref, normalized) || changed;
                return normalized;
            });
        if (changed) init.body = JSON.stringify(request);

        var promise = async function(fetchArguments) {

        return originalFetch.call(window, fetchArguments.url, fetchArguments.init).then(function(response)
        {
            // TODO: what do we do  on 429 here?
            var modifiedResponse = onStatesFetchResponseReceived(url, init, response, requestedClientRef);
            return modifiedResponse;
        });

        };

        return promise({url: url, init: init});
    }
    else if (url != undefined && url.endsWith("/devices"))
    {
        var request = JSON.parse(init.body);
        deviceId = request.device.device_id;
    }
    else if (url.includes("get_access_token"))
    {
        return originalFetch.call(window, url, init).then(function(response)
        {
            onAccessTokenResponseIntercepted(response);
            return response;
        });
    }
    else if (url.includes("connect-state"))
    {
        var promise = async function(fetchArguments) {

        var request = JSON.parse(init.body);
        if (request["command"] != null)
        {
            console.log("SpotiAds: We see connect-state with endpoint: " + request["command"]["endpoint"]);
        }
        else if (request["member_type"] != null)
        {
            console.log("SpotiAds: We see connect-state with member_type: " + request["member_type"]);
        }
        return originalFetch.call(window, fetchArguments.url, fetchArguments.init);
        
        }
        return promise({url: url, init: init});

    }
    else if (url.includes("/license"))
    {
        // DRM license request. 
        return originalFetch.call(window, url, init).then(function(response)
        {
            if (response.status == 429)
            {
                onTooManyRequestsError();
            }
            return response;
        });
    }

    // Make the original request.
    var fetchResult = originalFetch.call(window, url, init);
    return fetchResult;
};

async function onAccessTokenResponseIntercepted(accessTokenResponse)
{
    var resultJson = await accessTokenResponse.json();

    console.log("SpotiAds: access token received.");

    if (accessTokenResponse.status != 200)
    {
        console.error("SpotiAds: Could not refresh access token. error:");
        console.error(resultJson);
        throw "Can't refresh access token";
    }
    accessToken = resultJson["accessToken"];
}

//
// Hook the WebSocket channel.
//
wsHook.after = function(messageEvent, url) 
{
    rememberStateReplacementChannel(messageEvent);
    if (!webSocketMessageNeedsFiltering(messageEvent))
    {
        try
        {
            var data = JSON.parse(messageEvent.data);
            var changed = false;
            for (var payload of data.payloads || []) changed = reconcileReplacement(payload) || changed;
            if (changed) messageEvent.data = JSON.stringify(data);
        }
        catch {}
        return Promise.resolve(messageEvent);
    }
    var promise = async function(messageEvent) {

    try
    {
        
        var data = JSON.parse(messageEvent.data);
        //console.log("SpotiAds: we see websocket payload: " + data.toString());
        if (data.payloads == undefined) {return messageEvent;}

        for (var i = 0; i < data.payloads.length; i++)
        {
            var payload = data.payloads[i];
            if (payload == null) continue;
            if (payload.type == "replace_state")
            {
                var stateMachine = payload["state_machine"];
                var stateRef = payload["state_ref"];
                //var prevStateRef = payload["prev_state_ref"];
                //if (prevStateMachineId)
                //   var prevStateMachineId = prevStateRef["state_machine_id"];

                if (stateRef != null) 
                {
                    var currentStateIndex = stateRef["state_index"];

                    //console.log("SpotiAds: Received state machine over WebSocket, manipulating it");

                    // TODO: it's possible that payload["prev_state_ref"] will be different that the current state machine, states will be rejected,
                    //       which will cause Spotify to request /state_conflict. see _rejectState(). Is it our fault?

                    payload["state_machine"] = await manipulateStateMachine(stateMachine, currentStateIndex, true, "web_socket_replace_state");
                    reconcileReplacement(payload);
                    data.payloads[i] = payload;

                    isWebScoketInterceptionWorking = true;
                }

                if (isSimulatingStateChnage) 
                {
                    // Block this notification from reaching the client, to prevent song change.
                    return new MessageEvent(messageEvent.type, {data: "{}"});
                }
            }
            else if (payload.cluster != undefined)
            {
                // _onClusterMessage ?
                if (payload.update_reason == "DEVICE_STATE_CHANGED")
                {
                    if (deviceId != payload.cluster.active_device_id)
                    {
                        // TODO: Find a way to really detect when another device is playing
                        // instead of having false positives

                        // showMultiDeviceWarning();
                    }

                    if (payload.cluster.player_state.track.provider == "ads/inject_tracks")
                    {
                        console.log("SpotiAds: Spotify tring to inject ads? advertiser: " + payload.cluster.player_state.track.metadata.advertiser);
                        //payload.cluster.player_state.restrictions = {};
                        payload.cluster.player_state.track = null;
                        data.payloads[i] = payload;
                        data.payloads[i] = null; // do we want to nullify the state?
                    }
                }
            }
        }

        messageEvent.data = JSON.stringify(data);

        return messageEvent;
    }
    catch(exception)
    {
        console.log(exception);
        return messageEvent;
    }

    };

    return statesManipuationQueue.enqueue(promise, messageEvent);
}

function onStatesFetchResponseReceived(url, init, responseBody, requestedClientRef = clientStateRef)
{
    var requestBody = init.body;
    var request = JSON.parse(requestBody);

    var originalJsonPromise = responseBody.json();
    responseBody.json = function(request)
    {
        var promise = async function() {
        
        return originalJsonPromise.then(async function(data)
        {
            var stateMachine = data["state_machine"];           
            var updatedStateRef = data["updated_state_ref"];    

            var commands = data["commands"];
            if (request.debug_source == "track_data_finalized")
            {
                console.log("SpotiAds: Passing through ended-track finalization without changing playback");
                return data;
            }
            if (!stateResponseNeedsFiltering(data))
            {
                if (commands != null)
                {
                    console.log("SpotiAds: Passing through non-ad state conflict without manipulation. rejected_state_refs: "
                        + (request["rejected_state_refs"] || []).map(function(ref) { return ref == null ? "null" : ref["state_machine_id"]; }).join(" ")
                        + ", current state_machine_id: " + (request["state_ref"] == null ? "" : request["state_ref"]["state_machine_id"]));
                    Object.keys(commands).forEach(function(key) {
                        var command = commands[key];
                        if (command == null || command["type"] != "replace_state" || command["state_machine"] == null || command["state_ref"] == null) return;
                        console.log("SpotiAds: Passing through state machine: "
                            + getStateMachineDestripction(command["state_machine"], command["state_ref"]["state_index"])
                            + " (state machine id: " + command["state_machine"]["state_machine_id"]
                            + ", source:state_conflict_fast_path)");
                    });
                }
                else if (data["state_machine"] != null && data["updated_state_ref"] != null)
                {
                    console.log("SpotiAds: Passing through state machine: "
                        + getStateMachineDestripction(data["state_machine"], data["updated_state_ref"]["state_index"])
                        + " (state machine id: " + data["state_machine"]["state_machine_id"]
                        + ", source:" + (request["debug_source"] || "state_fast_path") + ")");
                }
                if (commands != null) Object.values(commands).forEach(reconcileReplacement);
                else if (data.state_machine != null && data.updated_state_ref != null
                    && sameStateRef(clientStateRef, requestedClientRef))
                    clientStateRef = stateRefFromMachine(data.state_machine, data.updated_state_ref);
                return data;
            }
            if (commands == null)
            {
                // for regular /state update request
                // _updateState, _handleStateUpdateResponse

                if (stateMachine == undefined || updatedStateRef == null) return data;

                var currentStateIndex = updatedStateRef["state_index"];
                var debug_source = request["debug_source"];
    
                var replacingLoadedAd = debug_source == "before_track_load"
                    && isAd(stateMachine.states[currentStateIndex], stateMachine);
                var originalAdResponse = replacingLoadedAd ? structuredClone(data) : null;
                data["state_machine"] = await manipulateStateMachine(stateMachine, currentStateIndex, replacingLoadedAd, debug_source);
                if (replacingLoadedAd && !isAd(data.state_machine.states[currentStateIndex], data.state_machine)
                    && !await replaceLoadedAd(data, requestedClientRef))
                    data = originalAdResponse;

                // if (debug_source == "modify_current_state")
                // {
                //     // HACKKKKKKKKKKKKK
                //     debugger;
                //     console.log("SpotiAds: Dropping modify_current_state states update response to prevent races between state machine updating.");
                //     //data["state_machine"]["state_machine_id"] = "hrepsh";
                //     return data;
                // }
    
                if (sameStateRef(clientStateRef, requestedClientRef))
                    clientStateRef = stateRefFromMachine(data.state_machine, data.updated_state_ref);
                isFetchInterceptionWorking = true;
            }
            else
            {
                 // for /state_conflict
                 // _rejectState

                var rejectedStates = request["rejected_state_refs"] || [];
                var rejectedStatesString = "";
                for (var i = 0; i < rejectedStates.length; i++)
                {
                    rejectedStatesString += (rejectedStates[i] == null ? "null" : rejectedStates[i]["state_machine_id"]) + " ";
                }
                var stateRef = request["state_ref"];

                console.log("SpotiAds: We see /state_conflict. rejected_state_refs: " + rejectedStatesString + ", current state_machine_id: " + (stateRef == null ? "" : stateRef["state_machine_id"]));
                for (var key of Object.keys(commands))
                {
                    var command = data.commands[key];
                    if (command == null || command.type != "replace_state" || command.state_machine == null || command.state_ref == null) continue;
                    var stateMachine = data["commands"][key]["state_machine"];           
                    var currentStateIndex = data["commands"][key]["state_ref"]["state_index"];
                    var commandType = data["commands"][key]["type"];

                    if (commandType == "replace_state")
                    {

                        // TODO: it's possible that data["commands"][key]["prev_state_ref"] will be different that the current state machine, states will be rejected,
                        //       which will cause Spotify to request /state_conflict. see _rejectState(). Is it our fault?

                        data["commands"][key]["state_machine"] = await manipulateStateMachine(stateMachine, currentStateIndex, true, "state_conflict_replace_state_command");
                        reconcileReplacement(data.commands[key]);
            
                    }                    
                }

                isFetchInterceptionWorking = true;
            }
            
            return data;

        }).catch(function(reason)
        {
            console.error(reason);
            return originalJsonPromise;
        });

        };

        return statesManipuationQueue.enqueue(promise, null);

    }.bind(this, request);
    
    return responseBody;
}

async function manipulateStateMachine(stateMachine, startingStateIndex, isReplacingState, debug_source="")
{
    var didRequestFutureStates = false;

    do
    {
        var removedAds = false;

        
        console.log("SpotiAds: We see state machine: " + getStateMachineDestripction(stateMachine) + " (state machine id: " + stateMachine["state_machine_id"] + ", source:" + debug_source + ")");

        for (var i = 0; i < stateMachine["states"].length; i++)
        {
            var state = stateMachine["states"][i];
            var stateId = stateMachine["states"][i]["state_id"];
            var currentStateIdNormalized = getFutureStateId(stateId);
            
            var trackID = state["track"];
            var track = stateMachine["tracks"][trackID];

            if (track == null) continue; // might happen for filler states

            var trackURI = track["metadata"]["uri"];
            var trackName = track["metadata"]["name"];


            var newState = structuredClone(state);

            if (isAd(state, stateMachine))
            {   
                console.log("SpotifyAdRemover: Encountered ad in " + trackURI);

                newState = getNextAdFreeState(stateMachine, stateId, i);
                if (i != startingStateIndex && (isAd(newState, stateMachine)
                    || (newState.transitions.advance == null && newState.disallow_seeking == true)))
                {
                    continue;
                }
                if (isAd(newState, stateMachine))
                {
                    // We can't really skip over this state because we don't know where to skip to.
                    // We will request even more states, or, if this fails, at least shorten the ad.
                    console.log("SpotiAds: Requesting future state machine.");
                    
                    try
                    {
                        var [nextNextState, futureStateMachine] = await getNextAdFreeStateFromFutureStateMachine(stateMachine, newState);
                        if (nextNextState != null)
                        {
                            newState = nextNextState;

                            var nextTrackName = futureStateMachine["tracks"][newState["track"]]["metadata"]["name"];
                            console.log("SpotiAds: after the ad we have track '" + nextTrackName + "'.");

                            
                            // Fix the new state to be suitable for replacing in the currenet state machine.
                            console.log("Spotiads: Inserting new state from future state machine");
                            var wantedStateId = state["state_id"];
                            var [fixedState, fixedStateMachine] = fixStateForOldStateMachine(newState, futureStateMachine, wantedStateId, stateMachine);
                            newState = fixedState;
                            stateMachine = fixedStateMachine;
                        }
                        else
                        {
                            state = shortenedState(state, track);
                            console.log("SpotifyAdRemover: Shortned ad");
                            debugger;
                        }
                        
                    }
                    catch (exception)
                    {
                        state = shortenedState(state, track);
                        console.log("SpotifyAdRemover: Shortned ad at " + trackURI + " due to exception:");
                        console.error(exception);
                        console.error(exception.stack);
                    }

                    didRequestFutureStates = true;
                }
                else
                {
                    console.log("SpotiAds: after the ad we have track '" + nextTrackName + "'. (easy flow)");
                }

                // We don't want tracks with no transitions
                // We'll request more states to discover the better state with the transitions
                if (!didRequestFutureStates && (newState["transitions"]["advance"] == null && newState["disallow_seeking"] == true) && !isAd(newState, stateMachine))
                {
                    var track = stateMachine["tracks"][newState["track"]];
                    var trackName = track["metadata"]["name"];

                    console.log("SpotiAds: Encountered a track '" + trackName + "' that disallows seeking. Requesting more states");
                    
                    [futureStateMachine, stateRef] = await getStates(stateMachine["state_machine_id"], newState["state_id"]);
                    if (futureStateMachine != null)
                    {
                        var referencedState = futureStateMachine["states"][stateRef["state_index"]];
                        if (referencedState != null && !isAd(referencedState, futureStateMachine))
                        {
                            console.log("SpotiAds: Inserting Spotify's current track after resume");
                            var wantedStateId = state.state_id;
                            var [fixedState, fixedStateMachine] = fixStateForOldStateMachine(referencedState, futureStateMachine, wantedStateId, stateMachine);
                            newState = fixedState;
                            stateMachine = fixedStateMachine;
                        }
                    }
                    else
                    {
                        console.log("SpotiAds: Can't get more states, hacking the next state");
                        debugger;

                        newState["disallow_seeking"] = false;
                        newState["restrictions"] = {};
                    }

                    didRequestFutureStates = true;
                    
                }

                currentStateIdNormalized = getFutureStateId(newState["state_id"]);

                if (newState != null && state["state_id"] != newState["state_id"]) 
                {
                    // We succesfully found the next state after the ad.
                    // Remove ads in the casual flow
                    // Make this state equal to the next one.
                    state = newState;

                    tamperedStatesMap[currentStateIdNormalized] = trackURI;

                    removedAds = true;
                }

                // Replace the current state.
                stateMachine["states"][i] = state;
            }

            if (i == startingStateIndex && !isReplacingState && tamperedStatesMap[currentStateIdNormalized] != null) 
            {
                // Our new ad-free state is going to be played now.
                var removedAdUri = tamperedStatesMap[currentStateIdNormalized];
                console.log("SpotifyAdRemover: Removed ad at " + removedAdUri);
                onAdRemoved(removedAdUri);
            }

        }

    }
    while (removedAds);

    stateMachine = tryToRemoveAdTracks(stateMachine);

    currentTracks = stateMachine["tracks"];

    if (didRequestFutureStates)
    {
        console.log("SpotiAds: Keeping the ad-free future state machine active");
    }

    return stateMachine;
}

async function getNextAdFreeStateFromFutureStateMachine(stateMachine, nextState)
{
    try
    {
        var maxAttempts = 5;
        var j = 0;
        var futureStateMachine = stateMachine;
        do
        {
            var stateMachineId = futureStateMachine["state_machine_id"];
            var stateId = nextState["state_id"];

            if (nextState["state_id"].includes("future_"))
            {
                stateMachineId = nextState["state_id"].split("+")[1];
                stateId = nextState["state_id"].split("+")[2];
            }

            var stateRef;
            [futureStateMachine, stateRef] = await getStates(stateMachineId, stateId);
            if (futureStateMachine == null || stateRef == null) return [null, futureStateMachine];
            nextState = futureStateMachine.states[stateRef.state_index];
            if (nextState == null) return [null, futureStateMachine];
            if (isAd(nextState, futureStateMachine))
                nextState = getNextAdFreeState(futureStateMachine, nextState.state_id, stateRef.state_index);

            j++;
        }
        while (isAd(nextState, futureStateMachine) && j < maxAttempts)
        
        if (isAd(nextState, futureStateMachine))
        {
            // print out debugging information
            console.error("could not find the next ad-free state. state machine was:");
            console.error(futureStateMachine);
            debugger;
            return [null, futureStateMachine];
        }

    }
    catch (exception)
    {
        console.error(exception);
        console.error(exception.stack);

        return [null, futureStateMachine];
    }

    return [nextState, futureStateMachine];
}

function fixStateForOldStateMachine(stateFromNewStateMachineToFix, futureStateMachine, expectedStateId, stateMachine)
{
    var rootIndex = futureStateMachine.states.indexOf(stateFromNewStateMachineToFix);
    var destinationIndex = stateMachine.states.findIndex(function(state) { return state.state_id == expectedStateId; });
    if (rootIndex < 0 || destinationIndex < 0) throw Error("SpotiAds: Missing state while copying future transitions");
    var stateIndices = new Map([[rootIndex, destinationIndex]]);
    var trackIndices = new Map();
    var pending = [rootIndex];
    var fixedState;
    for (var cursor = 0; cursor < pending.length; cursor++)
    {
        var sourceIndex = pending[cursor];
        var copied = structuredClone(futureStateMachine.states[sourceIndex]);
        var identity = normalizeStateRef({state_machine_id: futureStateMachine.state_machine_id, state_id: copied.state_id});
        copied.state_id = "_future_+" + identity.state_machine_id + "+" + identity.state_id;
        if (!trackIndices.has(copied.track))
        {
            trackIndices.set(copied.track, stateMachine.tracks.length);
            stateMachine.tracks.push(structuredClone(futureStateMachine.tracks[copied.track]));
        }
        copied.track = trackIndices.get(copied.track);
        for (var transition of Object.values(copied.transitions))
        {
            if (transition == null) continue;
            var nextIndex = transition.state_index;
            if (futureStateMachine.states[nextIndex] == null) continue;
            if (!stateIndices.has(nextIndex))
            {
                stateIndices.set(nextIndex, stateMachine.states.length);
                stateMachine.states.push(null);
                pending.push(nextIndex);
            }
            transition.state_index = stateIndices.get(nextIndex);
        }
        if (sourceIndex == rootIndex) fixedState = copied;
        else stateMachine.states[stateIndices.get(sourceIndex)] = copied;
    }
    return [fixedState, stateMachine];
}

function shortenedState(state, track)
{
    var trackDuration = track["metadata"]["duration"];

    state["disallow_seeking"] = false;
    state["restrictions"] = {};
    state["initial_playback_position"] = trackDuration;
    state["position_offset"] = trackDuration;

    return state;
}

async function getStates(stateMachineId, startingStateId, maxRetries = 3)
{
    if (startingStateId.includes("future_"))
    {
        console.log("SpotiAds: getStates: changing request to reflect future state machine");

        stateMachineId = startingStateId.split("+")[1];
        startingStateId = startingStateId.split("+")[2];
    }

    var statesUrl = "https://spclient.wg.spotify.com/track-playback/v1/devices/" + deviceId + "/state";
    var body = {"seq_num":0,"state_ref":{"state_machine_id":stateMachineId, "state_id": startingStateId,"paused":false},
            "sub_state":{"playback_speed":1,"position":0,"duration":0,"stream_time":0,"media_type":"AUDIO","bitrate":160000},"previous_position":0
            ,"debug_source":"resume"};

    var authorizationHeaderToPut = authorizationHeader ? authorizationHeader : "Bearer " + accessToken;
    var clientTokenToPut = clientToken ? clientToken : "";

    var result = await originalFetch.call(window, statesUrl,{method: 'PUT', headers: {
        'Authorization': authorizationHeaderToPut, 'client-token': clientTokenToPut,  'Content-Type': 'application/json'}, 
         body: JSON.stringify(body)});
    if (result.status != 200) 
    {

        if (result.status == 204)
        {
            // TODO: what does 204 No Content mean? no future state machine known?
        }
        // Assume the access token has expired without checking it too much.
        // var resultJson = await result.json();
        // var looksExpired = (resultJson["error"] && resultJson["error"]["message"] == "The access token expired")

        onStateMachineError(result.status);
        throw Error("SpotiAds: Failed to get states, http status code " + result.status);

        // // Refresh the access token and try again.
        // await refreshAccessToken();
        // result = await originalFetch.call(window, statesUrl,{method: 'PUT', headers: {'Authorization': "Bearer " + accessToken, 'Content-Type': 'application/json'}, 
        //                                                     body: JSON.stringify(body)});
    }

    // TODO: There is a case where the request will return a 502 Error code.
    // This will return a null stateMachine, and just shorten the ad instead of removing it.
    // Retry for now
    
    var resultJson = await result.json();
    var stateMachine = resultJson["state_machine"];
    var stateRef = resultJson["updated_state_ref"];
    if (!stateMachine)
    {
        debugger;
        if (maxRetries > 0)
            return getStates(stateMachineId, startingStateId, --maxRetries)
    }

    if (stateMachine != null && stateRef != null)
        console.log("SpotiAds: Resume returned " + getStateMachineDestripction(stateMachine, stateRef.state_index)
            + " (state machine id: " + stateMachine.state_machine_id + ", state index: " + stateRef.state_index + ")");
    return [stateMachine, stateRef];
}

function* statesGenerator(states, startingStateIndex = 2, nextStateName = "skip_next")
{
    var visited = new Set();
    var index = startingStateIndex;
    while (states[index] != null && !visited.has(index))
    {
        visited.add(index);
        var state = states[index];
        yield state;
        var transition = state.transitions[nextStateName];
        if (transition == null) break;
        index = transition.state_index;
    }
}

function getNextAdFreeState(stateMachine, stateId, startingStateIndex = 2, excludeAds = true)
{
    var states = stateMachine["states"];
    var tracks = stateMachine["tracks"];
    var previousState = null;

    var foundTrack = false;
    var foundState = false;
    for (var state of statesGenerator(states, startingStateIndex, "advance"))
    {
        var trackID = state["track"];
        var track = tracks[trackID];
        
        // if (foundTrack) 
        // {
        //     if (excludeAds && track["content_type"] == "AD") continue;
        //     return state;
        // }
        if (foundState) 
        {
            if (excludeAds && track["content_type"] == "AD") continue;
            return state;
        }

        if (previousState == state)
        {
            console.error("Cyclic state machine detected.");
            debugger;
            return state;
        }

        //foundTrack = (track["metadata"]["uri"] == sourceTrack["metadata"]["uri"]);
        foundState = state["state_id"] == stateId;
        previousState = state;

    }

    return state;
}

function getStateMachineDestripction(stateMachine, startingStateIndex = 2)
{
    var stateMachineString = "";
    for (var state of statesGenerator(stateMachine["states"], startingStateIndex, "advance"))
    {
        var trackID = state["track"];
        var track = stateMachine["tracks"][trackID];
        var trackName = track["metadata"]["name"];

        if (isAd(state, stateMachine))
        {
            trackName = "[AD] " + trackName;
        }

        stateMachineString += trackName + " > ";
    }

    return stateMachineString;
}

function getFutureStateId(stateId)
{
    return normalizeStateRef({state_id: stateId}).state_id;
}

function getPreviousState(stateMachine, sourceTrack, startingStateIndex = 2)
{
    var states = stateMachine["states"];
    var tracks = stateMachine["tracks"];
    
    var foundTrack = false;
    for (var state of statesGenerator(states, startingStateIndex, "advance"))
    {
        if (state["transitions"]["advance"] == null) return null;
        
        var nextState = states[state["transitions"]["advance"]["state_index"]];
        var nextStateTrack = tracks[nextState["track"]];

        if (nextStateTrack["metadata"]["uri"] == sourceTrack["metadata"]["uri"])
        {
            return state;
        }

    }

    return null;
}

// TODO: this function does not actually help in removing ads, it's useless
function tryToRemoveAdTracks(stateMachine)
{
    var tracks = stateMachine["tracks"];

    for (var i = 0; i < tracks.length; i++)
    {
        if (isAdTrack(tracks[i]) && !stateMachine.states.some(function(state) { return state.track == i; }))
        {
            //console.log("SpotiAds: trying to remove ad track " + tracks[i]["metadata"]["uri"]);
            //debugger;
            tracks[i] = null;
        }
    }

    stateMachine["tracks"] = tracks;
    return stateMachine;
}

function isAd(state, stateMachine)
{
    var states = stateMachine["states"];
    var tracks = stateMachine["tracks"];

    var trackID = state["track"];
    var track = tracks[trackID];

    if (state["state_id"].includes("filler"))
    {
        //console.log("SpotiAds: Encountered filler state, assuming not an ad");
        return false;
    }

    return isAdTrack(track);
}

function isAdTrack(track)
{
    if (track == null) return false;

    var trackURI = track["metadata"]["uri"];

    return trackURI.includes(":ad:");
}

//
// Graphics
//

function onMainUIReady(addedNode)
{
    if (document.getElementById("snackbar")) return;
    if (addedNode == null) addedNode = document.getElementById("main");

    var snackbar = document.createElement('div');
    snackbar.setAttribute("id", "snackbar");
    addedNode.appendChild(snackbar);
}

function onAdRemoved(trackURI, skipped = false)
{
    if (!removedAdsList.includes(trackURI))
    {
        removedAdsList.push(trackURI);
        if (skipped)
            showToast("Skipped ad");
        else
            showToast("Removed ad");

        totalAdsRemoved++;

        document.dispatchEvent(new CustomEvent('updateCounter', {detail: totalAdsRemoved}));
    }
}

var lastMissedAdTime = 0;

function onAdCouldntBeRemoved(trackURI)
{
    console.log("SpotifyAdRemover: Could not remove ad at " + trackURI + " because it is currently playing");

    var now = new Date();

    if (now - lastMissedAdTime > 60000)
    {
        Swal.fire({
            title: "Can't remove ad",
            html: "It appears that an ad was missed and couldn't be removed. Please report that back to the developer.",
            icon: "warning",
            width: 600,
            confirmButtonColor: "#DD6B55",
            confirmButtonText: "Got it",
            heightAuto: false
        });
    }

    lastMissedAdTime = now;
}

var lastStateMachineErrorTime = 0;

function onStateMachineError(errorCode)
{
    var now = new Date();

    if (now - lastStateMachineErrorTime > 60000)
    {
        Swal.fire({
            title: "Queue Error",
            html: "It appears that for some reason SpotiAds could not retrieve the next state. Please refresh, and perhaps report that back to the developer with error code: " + errorCode,
            icon: "warning",
            width: 600,
            confirmButtonColor: "#DD6B55",
            confirmButtonText: "Got it",
            heightAuto: false
        });
    }

    lastStateMachineErrorTime = now;
}


var lastTooMayyReqeustsErrorTime = 0;

function onTooManyRequestsError()
{
    var now = new Date();

    if (now - lastTooMayyReqeustsErrorTime > 9000)
    {
        Swal.fire({
            title: "You're skipping too fast",
            html: "Spotify doesn't allow users to play too many songs in such a high rate, so your queue will now break. You need to cooldown for a minute or so, then try playing again.",
            icon: "warning",
            width: 600,
            confirmButtonColor: "#DD6B55",
            confirmButtonText: "Got it",
            heightAuto: false
        });
    }

    lastTooMayyReqeustsErrorTime = now;
}

function showToast(text)
{
    var snackbar = document.getElementById("snackbar");
    snackbar.innerText = text;
    snackbar.className = "show";

    setTimeout(function(){ snackbar.className = snackbar.className.replace("show", ""); }, 3000);
}

function onSongResumed()
{
    setTimeout(checkInterception, 5000);
}

function checkInterception()
{
    var isInterceptionWorking = isFetchInterceptionWorking && isWebScoketInterceptionWorking;
    if (isInterceptionWorking)
    {
        if (!didCheckForInterception) 
            console.log("SpotifyAdRemover: Interception is working.");
        didCheckForInterception = true;
    }
    else if (!didShowInterceptionWarning && !didShowMultiDeviceWarning)
    {
        Swal.fire({
            title: "Oops...",
            html: "Spotify Ads Remover has detected that interception is not fully working. Please try refreshing this page, or, if the problem presists, writing back to the developer.",
            icon: "error",
            width: 600,
            confirmButtonColor: "#DD6B55",
            confirmButtonText: "OK",
            heightAuto: false
        });

        didShowInterceptionWarning = true;
    }
}

function showMultiDeviceWarning()
{
    if (!didShowMultiDeviceWarning)
    {
        Swal.fire({
            title: "Another device is playing",
            html: "Please note that Spotify Ads Remover can't control over other playing devices, so ads will not be removed unless audio will play from this tab.",
            icon: "warning",
            width: 500,
            confirmButtonColor: "#DD6B55",
            confirmButtonText: "OK",
            heightAuto: false
        });

        didShowMultiDeviceWarning = true;
    }
}

function startObserving()
{
    var mutationObserver = new MutationObserver(function (mutationList)
    {
        mutationList.forEach( (mutation) => {
            switch(mutation.type) {
              case 'childList':
                /* One or more children have been added to and/or removed
                   from the tree. */
                   var addedNodes = mutation.addedNodes;
       
                   for (var j = 0; j < addedNodes.length; j++)
                   {
                       var addedNode = addedNodes[j];
                       if (addedNode.getAttribute == undefined) continue;
           
                       if (addedNode.getAttribute("role") == "row")
                       {
                           // Song row added.
                       }
       
                       if (addedNode.id && addedNode.id.includes("main"))
                       {
                           onMainUIReady(addedNode);
                           setTimeout(onMainUIReady, 2000); // seems like "main" gets deleted after a while
                       }
                   }
                   
                break;
              case 'attributes':
                /* An attribute value changed on the element in
                   mutation.target. */
                   var changedNode = mutation.target;
                   if (changedNode.getAttribute("aria-label") == "Pause")
                   {
                        onSongResumed();
                   }
                   
                break;
            }
          });
    });
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributeFilter: ["aria-label"] });

    setTimeout(function()
    {
        if (document.getElementById("main"))
        {
            var mainElement = document.getElementById("main");
            onMainUIReady(mainElement);
        }

    }, 9000);
}

// _parseProvidedToken
//_refreshToken
// _lastToken
// async function refreshAccessToken()
// {
//     console.log("SpotiAds: Refreshing access token.");

//     var getTokenUrl = "https://open.spotify.com/get_access_token?reason=transport&productType=web_player&totp=824945&totpVer=5";

//     // get access token
//     var result = await fetch(getTokenUrl, {credentials: "same-origin"});
//     var resultJson = await result.json();

//     if (result.status != 200)
//     {
//         console.error("SpotiAds: Could not refresh access token. error:");
//         console.error(resultJson);
//         throw "Can't refresh access token";
//     }
//     accessToken = resultJson["accessToken"];
// }
