import React, { useEffect, useState } from 'react';
import {
  AppState,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';
import { io, Socket } from 'socket.io-client';

const SIGNALING_SERVER = 'https://jap-remote.onrender.com';
const ROOM_ID = 'remote-screen-room';

// Paste your Metered TURN credentials here:
const TURN_USERNAME = 'f8c9b3659bc5b39d5cde1808';
const TURN_PASSWORD = 'PASTE_YOUR_METERED_PASSWORD_HERE';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
    {
      urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
  ],
};

// Module-level singletons keep background service alive when UI is minimized/closed
let globalSocket: Socket | null = null;
let globalPc: RTCPeerConnection | null = null;
let globalStream: MediaStream | null = null;
let globalRetryTimer: ReturnType<typeof setInterval> | null = null;
let globalNetworkType: 'wifi' | 'cellular' | 'unknown' = 'unknown';
let globalViewerSocketId: string | null = null;
let isCellularApprovedByWeb = false;
let isManuallyDisconnected = false;
let isPromptOpen = false;
let isNegotiating = false;

const DEVICE_LABEL = `Android (${Platform.Version})`;

export default function App() {
  const [status, setStatus] = useState<string>('Initializing...');
  const [netLabel, setNetLabel] = useState<string>('Detecting network...');
  const [logs, setLogs] = useState<string[]>([]);
  const [isSharing, setIsSharing] = useState<boolean>(!!globalStream);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    console.log(`[RemoteBridge] ${msg}`);
    setLogs(prev => [`[${time}] ${msg}`, ...prev.slice(0, 60)]);
  };

  const emitDeviceStatus = () => {
    if (!globalSocket?.connected) return;
    const isLive =
      !!globalStream &&
      globalStream.getTracks().some(t => t.readyState === 'live');
    globalSocket.emit('device-status', {
      roomId: ROOM_ID,
      deviceName: `${DEVICE_LABEL} [${globalSocket.id?.slice(0, 4)}]`,
      networkType: globalNetworkType,
      isCapturing: isLive,
    });
  };

  // Closes only the active WebRTC peer connection while keeping MediaProjection ready in standby
  const pauseWebRTCStream = (reason: string) => {
    if (globalPc) {
      globalPc.close();
      globalPc = null;
      addLog(`Stream paused (${reason}). Waiting in standby (0 MB data)...`);
      setStatus(`Standby (${globalNetworkType.toUpperCase()})`);
    }
  };

  // Sends WebRTC Offer to the requesting Desktop Viewer
  const sendOfferWithStream = async (
    socket: Socket,
    stream: MediaStream,
    targetViewerId: string | null,
    useIceRestart = false,
  ) => {
    if (isNegotiating) return;

    // Gate check: If on Mobile Data and not yet approved by the Web Viewer button, stay in standby!
    if (globalNetworkType === 'cellular' && !isCellularApprovedByWeb) {
      addLog(
        'On Mobile Data — waiting for you to click "Connect (Mobile Data)" on Web Viewer...',
      );
      setStatus('Standby on Mobile Data (Click Connect on Web)');
      return;
    }

    isNegotiating = true;

    try {
      if (!socket.connected) {
        addLog('Socket offline — waiting for network...');
        return;
      }

      if (useIceRestart && globalPc && globalPc.connectionState !== 'closed') {
        try {
          addLog('Running WebRTC ICE Restart...');
          const restartOffer = await globalPc.createOffer({
            iceRestart: true,
            offerToReceiveAudio: false,
            offerToReceiveVideo: false,
          });
          await globalPc.setLocalDescription(restartOffer);
          socket.emit('offer', {
            roomId: ROOM_ID,
            targetSocketId: targetViewerId,
            offer: restartOffer,
          });
          isNegotiating = false;
          return;
        } catch {
          addLog('Rebuilding PeerConnection for new network...');
        }
      }

      if (globalPc) {
        globalPc.close();
      }
      const pc = new RTCPeerConnection(ICE_SERVERS);
      globalPc = pc;

      pc.addEventListener('icecandidate', (event: any) => {
        if (event.candidate && socket.connected) {
          socket.emit('ice-candidate', {
            roomId: ROOM_ID,
            targetSocketId: targetViewerId,
            candidate: event.candidate,
          });
        }
      });

      pc.addEventListener('connectionstatechange', () => {
        const state = pc.connectionState;
        addLog(`WebRTC state: ${state}`);
        setStatus(`WebRTC: ${state} (${globalNetworkType.toUpperCase()})`);

        if (
          (state === 'disconnected' || state === 'failed') &&
          !isManuallyDisconnected &&
          globalStream &&
          globalSocket?.connected
        ) {
          if (globalNetworkType === 'wifi' || isCellularApprovedByWeb) {
            addLog(`WebRTC ${state} — auto-healing stream...`);
            sendOfferWithStream(
              globalSocket,
              globalStream,
              globalViewerSocketId,
              true,
            );
          }
        }
      });

      const tracks = stream.getTracks();
      tracks.forEach(track => {
        pc.addTrack(track, stream);
      });

      addLog(`Sending SDP Offer (${globalNetworkType.toUpperCase()})...`);
      const offer = await pc.createOffer({
        iceRestart: useIceRestart,
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      socket.emit('offer', {
        roomId: ROOM_ID,
        targetSocketId: targetViewerId,
        offer,
      });
    } catch (err: any) {
      addLog(`Offer error: ${err?.message || err}`);
    } finally {
      isNegotiating = false;
    }
  };

  // Acquires Android screen capture permission (once) and streams if allowed by network rules
  const ensureCaptureAndStream = async (
    autoTriggered = false,
    useIceRestart = false,
  ) => {
    try {
      isManuallyDisconnected = false;

      if (!globalSocket || globalSocket.disconnected) {
        initBackgroundSocket();
      }

      const hasLiveStream =
        !!globalStream &&
        globalStream.getTracks().some(t => t.readyState === 'live');

      if (!hasLiveStream) {
        if (isPromptOpen) return;
        if (autoTriggered && AppState.currentState !== 'active') {
          return;
        }

        isPromptOpen = true;
        addLog('Requesting Android screen capture permission...');
        const stream = await mediaDevices.getDisplayMedia();
        isPromptOpen = false;

        globalStream = stream;
        setIsSharing(true);
        addLog('Screen capture ready in background!');
        emitDeviceStatus();
      }

      if (globalSocket?.connected && globalStream) {
        await sendOfferWithStream(
          globalSocket,
          globalStream,
          globalViewerSocketId,
          useIceRestart,
        );
      }
    } catch (err: any) {
      isPromptOpen = false;
      addLog(`Capture prompt waiting: ${err?.message || 'Will retry in 10s'}`);
      setStatus('Tap "Share Screen Now" to grant capture permission');
    }
  };

  const initBackgroundSocket = () => {
    if (!globalSocket) {
      addLog(`Connecting to ${SIGNALING_SERVER}...`);
      const socket = io(SIGNALING_SERVER, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1500,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });
      globalSocket = socket;

      socket.on('connect', () => {
        const isLive =
          !!globalStream &&
          globalStream.getTracks().some(t => t.readyState === 'live');

        addLog(`Socket connected! (${socket.id})`);
        setStatus(`Connected (${globalNetworkType.toUpperCase()})`);

        socket.emit('join-room', {
          roomId: ROOM_ID,
          role: 'phone',
          deviceName: `${DEVICE_LABEL} [${socket.id?.slice(0, 4)}]`,
          networkType: globalNetworkType,
          isCapturing: isLive,
        });

        if (!isManuallyDisconnected) {
          ensureCaptureAndStream(true, isLive);
        }
      });

      socket.on('connect_error', err => {
        addLog(`Socket retry: ${err.message}`);
        setStatus('Reconnecting to Render...');
      });

      // Desktop viewer clicked Connect or selected this phone
      socket.on('request-stream', async ({ viewerSocketId, allowCellular }) => {
        globalViewerSocketId = viewerSocketId;
        if (allowCellular) {
          isCellularApprovedByWeb = true;
          addLog('Web Viewer approved Mobile Data streaming!');
        } else {
          addLog('Web Viewer requested stream (Wi-Fi auto mode)...');
        }

        await ensureCaptureAndStream(false, false);
      });

      // Desktop viewer switched to another phone or paused stream
      socket.on('stop-stream', () => {
        isCellularApprovedByWeb = false;
        pauseWebRTCStream('Switched/Paused from Web Viewer');
      });

      socket.on('answer', async payload => {
        const answer = payload?.answer || payload;
        addLog('Received Answer from Desktop! Stream live.');
        if (globalPc && answer) {
          try {
            await globalPc.setRemoteDescription(
              new RTCSessionDescription(answer),
            );
          } catch (e: any) {
            addLog(`Answer error: ${e?.message || e}`);
          }
        }
      });

      socket.on('ice-candidate', async payload => {
        const candidate = payload?.candidate || payload;
        if (globalPc && candidate) {
          try {
            await globalPc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e: any) {
            addLog(`ICE note: ${e?.message || e}`);
          }
        }
      });
    } else if (globalSocket.disconnected && !isManuallyDisconnected) {
      globalSocket.connect();
    }

    // 10-second smart auto-retry loop (only auto-streams on Wi-Fi or when Mobile Data was approved)
    if (!globalRetryTimer) {
      globalRetryTimer = setInterval(() => {
        if (isManuallyDisconnected) return;

        const isWebRTCConnected =
          globalPc?.connectionState === 'connected' ||
          globalPc?.connectionState === 'connecting';

        if (!globalStream) {
          ensureCaptureAndStream(true, false);
        } else if (
          !isWebRTCConnected &&
          globalSocket?.connected &&
          (globalNetworkType === 'wifi' || isCellularApprovedByWeb)
        ) {
          addLog('10s Heartbeat: Reconnecting stream...');
          ensureCaptureAndStream(true, true);
        }
      }, 10000);
    }
  };

  const stopAndDisconnect = () => {
    isManuallyDisconnected = true;
    isCellularApprovedByWeb = false;
    addLog('Stopping screen share and disconnecting...');

    if (globalRetryTimer) {
      clearInterval(globalRetryTimer);
      globalRetryTimer = null;
    }

    if (globalStream) {
      globalStream.getTracks().forEach(track => track.stop());
      globalStream = null;
    }

    if (globalPc) {
      globalPc.close();
      globalPc = null;
    }

    if (globalSocket) {
      globalSocket.disconnect();
    }

    setIsSharing(false);
    setStatus('Disconnected (Stopped by user)');
    addLog('Disconnected completely. Background service stopped.');
  };

  useEffect(() => {
    // Listen for real-time Wi-Fi vs Mobile Data changes on Android
    const unsubscribeNet = NetInfo.addEventListener(state => {
      const prevType = globalNetworkType;
      const newType: 'wifi' | 'cellular' | 'unknown' =
        state.type === 'wifi'
          ? 'wifi'
          : state.type === 'cellular'
          ? 'cellular'
          : 'unknown';

      globalNetworkType = newType;
      setNetLabel(
        newType === 'wifi'
          ? '📶 Wi-Fi (Auto-Stream Active)'
          : newType === 'cellular'
          ? '📱 Mobile Data (Manual Web Trigger)'
          : `Network: ${state.type}`,
      );

      if (prevType !== newType) {
        addLog(`Network changed: ${prevType} -> ${newType.toUpperCase()}`);
        emitDeviceStatus();

        // If phone switched from Wi-Fi to Mobile Data, pause stream until user clicks Connect on Web!
        if (newType === 'cellular' && !isCellularApprovedByWeb) {
          pauseWebRTCStream('Switched to Mobile Data — awaiting Web approval');
        }

        // If phone switched from Mobile Data to Wi-Fi, automatically start/resume streaming!
        if (newType === 'wifi' && !isManuallyDisconnected && globalStream) {
          addLog('Switched to Wi-Fi — auto-starting stream!');
          if (globalSocket?.connected) {
            sendOfferWithStream(
              globalSocket,
              globalStream,
              globalViewerSocketId,
              true,
            );
          }
        }
      }
    });

    initBackgroundSocket();

    return () => {
      unsubscribeNet();
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Remote Screen Bridge</Text>
        <Text style={styles.netBadge}>{netLabel}</Text>
        <Text style={styles.statusText}>Status: {status}</Text>

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, styles.shareButton]}
            onPress={() => {
              // Tapping on the phone directly also approves streaming
              if (globalNetworkType === 'cellular') {
                isCellularApprovedByWeb = true;
              }
              ensureCaptureAndStream(false, false);
            }}
          >
            <Text style={styles.buttonText}>
              {isSharing ? 'Resend Stream Now' : 'Share Screen Now'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, styles.disconnectButton]}
            onPress={stopAndDisconnect}
          >
            <Text style={styles.buttonText}>Disconnect</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.logBox}>
        {logs.map((log, i) => (
          <Text key={i} style={styles.logText}>
            {log}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  header: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  title: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  netBadge: {
    color: '#fbbf24',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
  },
  statusText: { color: '#4ade80', fontSize: 13, marginBottom: 12 },
  buttonRow: { flexDirection: 'row', gap: 10 },
  button: { flex: 1, padding: 14, borderRadius: 6, alignItems: 'center' },
  shareButton: { backgroundColor: '#2563eb' },
  disconnectButton: { backgroundColor: '#dc2626' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  logBox: { flex: 1, padding: 12, backgroundColor: '#0a0a0a' },
  logText: {
    color: '#a3e635',
    fontFamily: 'monospace',
    fontSize: 12,
    marginBottom: 6,
  },
});
