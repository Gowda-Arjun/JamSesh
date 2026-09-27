function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// Load timesync before running anything else
loadScript("https://unpkg.com/timesync/dist/timesync.min.js").then(() => {
    console.log("✅ timesync loaded");

    // === Time sync setup ===
    var ts = timesync.create({
        server: '/timesync',
        interval: 5000
    });

    // tells how far off device's clock is from server's clock
    let timeOffset = 0;
    ts.on('change', function (offset) {
        timeOffset = offset;
        console.log('Clock offset from server:', offset, 'ms');
    });


    const FIXED_DELAY_MS = 400;

    let ws;
    let clientId = null;
    const peerConnections = {};
    let isCallInProgress = false;
    let startCall = false;
    const iceServers = [];
    let allParticipants = [];

    const BITRATE_LEVELS = {
        HIGH: 192000,   // 192 kbps 
        MEDIUM: 96000,
        LOW: 48000,
    };
    const ADAPTATION_INTERVAL_MS = 5000; // check network every 5 seconds

    //html references
    const remoteAudio = document.getElementById('remoteAudio');

    startBtn.disabled = true;

    const init = () => {
        ws = new WebSocket("wss://jamsesh-8wui.onrender.com");
        ws.onopen = () => {
            console.log("Websocket connected");
        };

        ws.onmessage = handleSignalingMessage;

        ws.onclose = () => {
            // Closing the connection
            console.log('WebSocket disconnected.');
            endCall();
        };

        ws.onerror = (err) => {
            // Error occured
            console.error('WebSocket error:', err);
            endCall();
        };

        startBtn.addEventListener('click', async () => {
            // Only allow the button to be clicked once
            if (isCallInProgress) {
                console.log("Call is already in progress.");
                return;
            }

            // Disable the start button and enable the end button
            startBtn.disabled = true;
            endBtn.disabled = false;
            isCallInProgress = true;
        });

        endBtn.addEventListener('click', () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'end-call',
                    code: roomCode,
                    role: 'join'
                })); // end call mesg to signalling server
            }
            endCall();
        });
    }

    async function handleSignalingMessage(event) {

        const data = JSON.parse(event.data);
        switch (data.type) {
            case 'init': {
                clientId = data.clientId;
                window.currentClientId = clientId;
                const urlParams = new URLSearchParams(window.location.search);
                const roomCode = urlParams.get('code');
                const username = urlParams.get('username');
                ws.send(JSON.stringify({ type: 'joinroom', code: roomCode, from: clientId, username: username }));
                break;
            }
            case 'join_success': {
                console.log(`Joiner successfully joined room ${data.code}.`);
                allParticipants = data.participants;
                if (typeof window.updateParticipantList === 'function') {
                    window.updateParticipantList(allParticipants);
                }
                break;
            }

            case 'user-joined': {
                const newParticipant = data.newParticipant;
                if (!newParticipant) break;

                console.log(`New user ${newParticipant.username} joined.`);
                allParticipants.push(newParticipant);
                if (typeof window.updateParticipantList === 'function') {
                    window.updateParticipantList(allParticipants);
                }
                break;
            }

            case 'client-left': {
                const leavingParticipant = data.participant;
                if (!leavingParticipant) break;

                console.log(`Client ${leavingParticipant.username} left.`);
                allParticipants = allParticipants.filter(p => p.id !== leavingParticipant.id);
                if (typeof window.updateParticipantList === 'function') {
                    window.updateParticipantList(allParticipants);
                }
                if (peerConnections[leavingParticipant.id]) {
                    peerConnections[leavingParticipant.id].close();
                    delete peerConnections[leavingParticipant.id];
                }
                break;
            }

            case 'start-call': {
                startCall = true;
                startBtn.disabled = false;
                return;
            }

            case 'offer': {
                const offererId = data.from;
                // get the pc instance from our stored object
                let pc = peerConnections[offererId]?.pc;

                if (!pc) {
                    pc = await createPeerConnection(offererId);
                    peerConnections[offererId] = { pc: pc };
                }

                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                ws.send(JSON.stringify({
                    type: 'answer',
                    sdp: pc.localDescription,
                    to: data.from,
                    from: clientId
                }));

                isCallInProgress = true;
                endBtn.disabled = false;
                startBtn.disabled = true;
                console.log("Received and answered an offer from the master.");
                break;
            }

            case 'ice-candidate': {
                const peerId = data.from;
                const pc = peerConnections[peerId]?.pc;
                if (pc && data.candidate) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                    } catch (e) {
                        console.warn('ICE candidate error:', e);
                    }
                } else {
                    console.warn(`ICE candidate received for unknown peer ${peerId} or no candidate data.`);
                }
                break;
            }

            case 'end-call':
                endCall();
                startCall = false;
                break;
        }
    }

    async function createPeerConnection(peerId) {

        const sessionIceServers = [...iceServers];
        try {
            const response = await fetch("/api/get-turn-credentials");
            if (response.ok) {
                const turnServers = await response.json();
                if (Array.isArray(turnServers) && turnServers.length > 0) {
                    sessionIceServers.push(...turnServers); // Add fetched TURN to the session array
                    console.log("Fetched TURN credentials and added to iceServers.");
                } else {
                    console.warn("No TURN credentials fetched, proceeding with just STUN servers.");
                }
            } else {
                console.warn(`Failed to fetch TURN credentials: ${response.status} ${response.statusText}`);
            }
        } catch (e) {
            console.error("Error fetching TURN credentials:", e);
        }

        const pc = new RTCPeerConnection({ iceServers: sessionIceServers });
        console.log('PeerConnection initialized.');

        pc.ontrack = event => {
            // plays audio
            console.log('Remote track received', event.streams[0]);

            if (remoteAudio) {
                remoteAudio.srcObject = event.streams[0];
                remoteAudio.play()
                    .catch(e => {
                        console.warn("Autoplay was blocked. User must interact with the page first.", e.name);
                    });
            } else {
                console.warn("Remote audio element not found");
            }

            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaStreamSource(event.streams[0]);
            source.connect(audioCtx.destination);

            // appliedDelayMs = how much artificial delay is currently baked in
            // for this listener.... Every cycle we only move by the DELTA between
            // what's already applied and what's newly needed
            let appliedDelayMs = 0;

            async function syncPlayback() {
                const stats = await pc.getStats();
                let rtt = 0;
                stats.forEach(report => {
                    if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
                        rtt = report.roundTripTime || 0;
                    }
                });
                const measuredDelayMs = (rtt * 1000) / 2; // this listener's current network delay estimate

                const neededDelayMs = Math.max(0, FIXED_DELAY_MS - measuredDelayMs);
                const delta = neededDelayMs - appliedDelayMs;

                console.log(`[${peerId}] net=${measuredDelayMs.toFixed(0)}ms applied=${appliedDelayMs.toFixed(0)}ms needed=${neededDelayMs.toFixed(0)}ms delta=${delta.toFixed(0)}ms`);

                if (Math.abs(delta) < 20) return; // close enough, skip this cycle

                if (delta > 0) {
                    // network got faster -> need MORE artificial delay to still
                    // land on the target. Suspend only for the incremental gap.
                    audioCtx.suspend().then(() => {
                        setTimeout(() => {
                            audioCtx.resume();
                            appliedDelayMs = neededDelayMs;
                            console.log(`[${peerId}] added ${delta.toFixed(0)}ms -> applied ${appliedDelayMs.toFixed(0)}ms`);
                        }, delta);
                    });
                } else {
                    // network got slower= need LESS artificial delay. 
                    //incoming audio (skip forward) instead.
                    const skip = Math.abs(delta);
                    source.disconnect();
                    setTimeout(() => {
                        source.connect(audioCtx.destination);
                        appliedDelayMs = neededDelayMs;
                        console.log(`[${peerId}] skipped ${skip.toFixed(0)}ms -> applied ${appliedDelayMs.toFixed(0)}ms`);
                    }, skip);
                }
            }

            syncPlayback(); // initial alignment uses the same delta logic (appliedDelayMs starts at 0)
            const intervalId = setInterval(syncPlayback, 5000);
            peerConnections[peerId] = peerConnections[peerId] || {};
            peerConnections[peerId].syncInterval = intervalId; // lets endCall()'s clearInterval(peer.syncInterval) actually work
        };

        pc.onconnectionstatechange = () => {
            console.log(`Peer Connection State for ${peerId}:`, pc.connectionState);
        }; // simplified

        pc.onicecandidate = event => {
            if (event.candidate) {
                ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    to: peerId,
                    from: clientId,
                    candidate: event.candidate
                }));
            }
        };

        return pc;
    }

    // set a new bitrate for a specific peer
    async function setBitrateForPeer(peerId, newLevel) {
        const peer = peerConnections[peerId];
        if (!peer || !peer.audioSender || peer.currentBitrate === newLevel) {
            return; // no change needed/sender not ready
        }

        console.log(`adapting bitrate for ${peerId} from ${peer.currentBitrate} to ${newLevel}`);
        const params = peer.audioSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = BITRATE_LEVELS[newLevel];

        try {
            await peer.audioSender.setParameters(params);
            peer.currentBitrate = newLevel;
            console.log(`successfully set bitrate for ${peerId} to ${newLevel} (${BITRATE_LEVELS[newLevel]} bps)`);
        } catch (e) {
            console.error(`failed to set bitrate for ${peerId}:`, e);
        }
    }

    // monitoring and adapting the bitrate
    async function monitorAndAdaptBitrate(peerId) {
        const peer = peerConnections[peerId];
        if (!peer || !peer.pc || !peer.audioSender) {
            return;
        }

        const stats = await peer.pc.getStats();
        let packetLoss = 0;
        let rtt = 0;

        stats.forEach(report => {
            if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
                // fractionLost: value b/w 0 and 1 representing packet loss 
                packetLoss = report.fractionLost;
                rtt = report.roundTripTime;
                console.log(`[stats for ${peerId}] Packet Loss: ${(packetLoss * 100).toFixed(2)}%, RTT: ${(rtt * 1000).toFixed(0)}ms`);
            }
        });

        if (packetLoss > 0.15 || rtt > 0.4) { // 15% packet loss or 400ms RTT, vansh change it if u want to
            if (peer.currentBitrate === 'HIGH') {
                setBitrateForPeer(peerId, 'MEDIUM');
            } else if (peer.currentBitrate === 'MEDIUM') {
                setBitrateForPeer(peerId, 'LOW');
            }
            return;
        }

        // if network is excellent, try to go up a level
        if (packetLoss < 0.1 && rtt < 0.25) {
            if (peer.currentBitrate === 'LOW') {
                setBitrateForPeer(peerId, 'MEDIUM');
            } else if (peer.currentBitrate === 'MEDIUM') {
                setBitrateForPeer(peerId, 'HIGH');
            }
        }
    }

    function endCall() {
        if (!isCallInProgress) {
            return;
        }

        console.log("ending call");
        isCallInProgress = false;

        // loop and clear intervals before closing connections
        for (const id in peerConnections) {
            const peer = peerConnections[id];

            if (peer.monitorInterval) {
                clearInterval(peer.monitorInterval);
            }

            if (peer.syncInterval) {
                clearInterval(peer.syncInterval);
            }
            if (peer.pc) {
                peer.pc.close();
            }
            delete peerConnections[id];
        }

        if (remoteAudio) remoteAudio.srcObject = null;

        startBtn.disabled = false;
        endBtn.disabled = true;
        console.log("Call ended and resources cleaned up.");
    }

    window.onload = init;
});