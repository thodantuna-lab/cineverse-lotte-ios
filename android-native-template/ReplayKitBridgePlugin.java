package com.cineverse.lotte;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RTCStats;
import org.webrtc.RTCStatsReport;
import org.webrtc.RtpParameters;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.AudioDeviceModule;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
        name = "ReplayKitBridge",
        permissions = {
                @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "audio")
        }
)
public class ReplayKitBridgePlugin extends Plugin {
    private static final String TAG = "ReplayKitBridgeAndroid";
    private static ReplayKitBridgePlugin activeInstance;

    private EglBase eglBase;
    private PeerConnectionFactory pcFactory;
    private AudioDeviceModule audioDeviceModule;
    private AudioSource voiceAudioSource;
    private AudioTrack localVoiceAudioTrack;
    private VideoSource videoSource;
    private VideoTrack localVideoTrack;
    private ScreenCapturerAndroid screenCapturer;
    private SurfaceTextureHelper surfaceTextureHelper;

    private final Map<String, NativePeer> peers = new ConcurrentHashMap<>();
    private final Map<String, NativeVoicePeer> voicePeers = new ConcurrentHashMap<>();
    private final ExecutorService webrtcExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private volatile boolean isBroadcasting = false;
    private volatile boolean isAudioCapturing = false;
    private volatile boolean voiceServiceActive = false;
    private volatile boolean voiceMicEnabled = false;
    private Thread audioCaptureThread;
    private AudioRecord audioRecord;
    private PluginCall pendingStartCall;

    private static class NativeVoicePeer implements PeerConnection.Observer {
        final String remoteUid;
        final PeerConnection pc;
        final List<IceCandidate> pendingIce = Collections.synchronizedList(new ArrayList<>());
        final ReplayKitBridgePlugin plugin;
        volatile String iceState = "new";

        NativeVoicePeer(String remoteUid, PeerConnection pc, ReplayKitBridgePlugin plugin) {
            this.remoteUid = remoteUid;
            this.pc = pc;
            this.plugin = plugin;
        }

        @Override
        public void onIceCandidate(IceCandidate candidate) {
            if (candidate == null) return;
            try {
                JSONObject candJson = new JSONObject();
                candJson.put("candidate", candidate.sdp);
                candJson.put("sdpMid", candidate.sdpMid != null ? candidate.sdpMid : "");
                candJson.put("sdpMLineIndex", candidate.sdpMLineIndex);
                String uidEscaped = remoteUid.replace("'", "\\'");
                String js = "window.__onNativeVoiceIce && window.__onNativeVoiceIce('" + uidEscaped + "', " + candJson.toString() + ");";
                plugin.mainHandler.post(() -> {
                    if (plugin.getBridge() != null && plugin.getBridge().getWebView() != null) {
                        plugin.getBridge().getWebView().evaluateJavascript(js, null);
                    }
                });
            } catch (JSONException e) {
                Log.w(TAG, "Voice ICE JSON error", e);
            }
        }

        @Override
        public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
            if (state == null) return;
            String s = state.name().toLowerCase();
            this.iceState = s;
            String uidEscaped = remoteUid.replace("'", "\\'");
            String js = "window.__onNativeVoiceIceState && window.__onNativeVoiceIceState('" + uidEscaped + "', '" + s + "');";
            plugin.mainHandler.post(() -> {
                if (plugin.getBridge() != null && plugin.getBridge().getWebView() != null) {
                    plugin.getBridge().getWebView().evaluateJavascript(js, null);
                }
            });
        }

        @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
        @Override public void onIceConnectionReceivingChange(boolean b) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
        @Override public void onAddStream(MediaStream stream) {}
        @Override public void onRemoveStream(MediaStream stream) {}
        @Override public void onDataChannel(DataChannel dc) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(org.webrtc.RtpReceiver receiver, MediaStream[] streams) {}
        @Override public void onTrack(RtpTransceiver transceiver) {}
    }

    private static class NativePeer implements PeerConnection.Observer {
        final String viewerUid;
        final PeerConnection pc;
        DataChannel audioDataChannel;
        final List<IceCandidate> pendingIce = Collections.synchronizedList(new ArrayList<>());
        final ReplayKitBridgePlugin plugin;

        NativePeer(String viewerUid, PeerConnection pc, ReplayKitBridgePlugin plugin) {
            this.viewerUid = viewerUid;
            this.pc = pc;
            this.plugin = plugin;
        }

        @Override
        public void onIceCandidate(IceCandidate candidate) {
            if (candidate == null) return;
            try {
                JSONObject candJson = new JSONObject();
                candJson.put("candidate", candidate.sdp);
                candJson.put("sdpMid", candidate.sdpMid != null ? candidate.sdpMid : "");
                candJson.put("sdpMLineIndex", candidate.sdpMLineIndex);
                String uidEscaped = viewerUid.replace("'", "\\'");
                String js = "window.__onNativeWebRTCIce && window.__onNativeWebRTCIce('" + uidEscaped + "', " + candJson.toString() + ");";
                plugin.mainHandler.post(() -> {
                    if (plugin.getBridge() != null && plugin.getBridge().getWebView() != null) {
                        plugin.getBridge().getWebView().evaluateJavascript(js, null);
                    }
                });
            } catch (JSONException e) {
                Log.w(TAG, "ICE JSON error", e);
            }
        }

        @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {}
        @Override public void onIceConnectionReceivingChange(boolean b) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
        @Override public void onAddStream(MediaStream stream) {}
        @Override public void onRemoveStream(MediaStream stream) {}
        @Override public void onDataChannel(DataChannel dc) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(org.webrtc.RtpReceiver receiver, MediaStream[] streams) {}
        @Override public void onTrack(RtpTransceiver transceiver) {}
    }

    @Override
    public void load() {
        activeInstance = this;
    }

    private synchronized void initWebRTCIfNeeded() {
        if (pcFactory != null) return;
        Context appCtx = getContext().getApplicationContext();
        PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appCtx)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions()
        );
        eglBase = EglBase.create();
        audioDeviceModule = JavaAudioDeviceModule.builder(appCtx)
                .setUseHardwareAcousticEchoCanceler(true)
                .setUseHardwareNoiseSuppressor(true)
                .createAudioDeviceModule();
        DefaultVideoEncoderFactory encoderFactory = new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true);
        DefaultVideoDecoderFactory decoderFactory = new DefaultVideoDecoderFactory(eglBase.getEglBaseContext());
        pcFactory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(audioDeviceModule)
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .createPeerConnectionFactory();
        videoSource = pcFactory.createVideoSource(true);
        localVideoTrack = pcFactory.createVideoTrack("screen0", videoSource);

        MediaConstraints audioConstraints = new MediaConstraints();
        audioConstraints.optional.add(new MediaConstraints.KeyValuePair("googEchoCancellation", "true"));
        audioConstraints.optional.add(new MediaConstraints.KeyValuePair("googAutoGainControl", "true"));
        audioConstraints.optional.add(new MediaConstraints.KeyValuePair("googNoiseSuppression", "true"));
        voiceAudioSource = pcFactory.createAudioSource(audioConstraints);
        localVoiceAudioTrack = pcFactory.createAudioTrack("voice0", voiceAudioSource);
        localVoiceAudioTrack.setEnabled(voiceMicEnabled);
    }

    @PluginMethod
    public void startBroadcast(PluginCall call) {
        initWebRTCIfNeeded();
        pendingStartCall = call;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && getPermissionState("audio") != PermissionState.GRANTED) {
            requestPermissionForAlias("audio", call, "onAudioPermResult");
            return;
        }
        launchScreenCapturePrompt(call);
    }

    @PermissionCallback
    private void onAudioPermResult(PluginCall call) {
        launchScreenCapturePrompt(call);
    }

    private void launchScreenCapturePrompt(PluginCall call) {
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("MediaProjectionManager unavailable");
            return;
        }
        Intent captureIntent = mpm.createScreenCaptureIntent();
        startActivityForResult(call, captureIntent, "onMediaProjectionResult");
    }

    @ActivityCallback
    private void onMediaProjectionResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            pendingStartCall = null;
            call.reject("User cancelled screen capture");
            return;
        }
        call.setKeepAlive(true);
        pendingStartCall = call;
        Intent serviceIntent = new Intent(getContext(), ScreenCaptureService.class);
        serviceIntent.putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.getResultCode());
        serviceIntent.putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.getData());
        ContextCompat.startForegroundService(getContext(), serviceIntent);
    }

    public static boolean isScreenSharingActive() {
        return activeInstance != null && activeInstance.isBroadcasting;
    }

    public static void onForegroundServiceReady(Context ctx, int resultCode, Intent resultData) {
        ReplayKitBridgePlugin inst = activeInstance;
        if (inst == null || resultData == null) return;
        inst.startMediaProjectionCapture(resultData);
    }

    public static void onForegroundServiceStopped() {
        ReplayKitBridgePlugin inst = activeInstance;
        if (inst != null) {
            inst.stopCaptureInternal();
        }
    }

    private void startMediaProjectionCapture(Intent resultData) {
        webrtcExecutor.execute(() -> {
            try {
                stopCaptureOnly();
                initWebRTCIfNeeded();

                DisplayMetrics metrics = new DisplayMetrics();
                WindowManager wm = (WindowManager) getContext().getSystemService(Context.WINDOW_SERVICE);
                if (wm != null && wm.getDefaultDisplay() != null) {
                    wm.getDefaultDisplay().getRealMetrics(metrics);
                } else {
                    metrics = getContext().getResources().getDisplayMetrics();
                }

                int srcW = Math.max(2, metrics.widthPixels);
                int srcH = Math.max(2, metrics.heightPixels);
                int maxDim = 1280;
                int longest = Math.max(srcW, srcH);
                int dstW = (longest > maxDim ? (srcW * maxDim / longest) : srcW) & ~1;
                int dstH = (longest > maxDim ? (srcH * maxDim / longest) : srcH) & ~1;
                dstW = Math.max(2, dstW);
                dstH = Math.max(2, dstH);

                surfaceTextureHelper = SurfaceTextureHelper.create("CineVerseScreenCap", eglBase.getEglBaseContext());
                screenCapturer = new ScreenCapturerAndroid(resultData, new MediaProjection.Callback() {
                    @Override
                    public void onStop() {
                        stopCaptureInternal();
                    }
                });
                screenCapturer.initialize(surfaceTextureHelper, getContext().getApplicationContext(), videoSource.getCapturerObserver());
                screenCapturer.startCapture(dstW, dstH, 60);
                isBroadcasting = true;

                startInternalAudioCaptureIfSupported();

                PluginCall call = pendingStartCall;
                pendingStartCall = null;
                if (call != null) {
                    JSObject res = new JSObject();
                    res.put("started", true);
                    call.resolve(res);
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to start screen capture", e);
                PluginCall call = pendingStartCall;
                pendingStartCall = null;
                if (call != null) {
                    call.reject("Screen capture failed: " + e.getMessage());
                }
            }
        });
    }

    private void startInternalAudioCaptureIfSupported() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        MediaProjection mp = screenCapturer != null ? screenCapturer.getMediaProjection() : null;
        if (mp == null) return;

        final int sampleRate = 44100;
        final int channels = 2;
        final int channelMask = AudioFormat.CHANNEL_IN_STEREO;
        final int encoding = AudioFormat.ENCODING_PCM_16BIT;
        int minBuf = AudioRecord.getMinBufferSize(sampleRate, channelMask, encoding);
        int bufSize = Math.max(minBuf * 2, 8192);

        try {
            AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(mp)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build();

            audioRecord = new AudioRecord.Builder()
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(encoding)
                            .setSampleRate(sampleRate)
                            .setChannelMask(channelMask)
                            .build())
                    .setBufferSizeInBytes(bufSize)
                    .setAudioPlaybackCaptureConfig(config)
                    .build();

            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                audioRecord.release();
                audioRecord = null;
                return;
            }

            audioRecord.startRecording();
            isAudioCapturing = true;
            audioCaptureThread = new Thread(() -> {
                byte[] pcmBuf = new byte[8192];
                while (isAudioCapturing && audioRecord != null) {
                    int read = audioRecord.read(pcmBuf, 0, pcmBuf.length);
                    if (read < 0) {
                        Log.w(TAG, "AudioRecord read error: " + read);
                        break;
                    }
                    if (read > 0 && !peers.isEmpty()) {
                        for (NativePeer peer : peers.values()) {
                            DataChannel dc = peer.audioDataChannel;
                            if (dc != null && dc.state() == DataChannel.State.OPEN && dc.bufferedAmount() < 262_144) {
                                ByteBuffer copy = ByteBuffer.allocateDirect(6 + read).order(ByteOrder.LITTLE_ENDIAN);
                                copy.putInt(sampleRate);
                                copy.putShort((short) channels);
                                copy.put(pcmBuf, 0, read);
                                copy.flip();
                                dc.send(new DataChannel.Buffer(copy, true));
                            }
                        }
                    }
                }
            }, "CineVerseAudioCapture");
            audioCaptureThread.start();
        } catch (Exception e) {
            Log.w(TAG, "AudioPlaybackCapture unavailable: " + e.getMessage());
        }
    }

    private void stopCaptureOnly() {
        isBroadcasting = false;
        isAudioCapturing = false;
        if (audioCaptureThread != null) {
            try { audioCaptureThread.join(300); } catch (InterruptedException ignored) {}
            audioCaptureThread = null;
        }
        if (audioRecord != null) {
            try { audioRecord.stop(); } catch (Exception ignored) {}
            try { audioRecord.release(); } catch (Exception ignored) {}
            audioRecord = null;
        }
        if (screenCapturer != null) {
            try { screenCapturer.stopCapture(); } catch (Exception ignored) {}
            try { screenCapturer.dispose(); } catch (Exception ignored) {}
            screenCapturer = null;
        }
        if (surfaceTextureHelper != null) {
            try { surfaceTextureHelper.dispose(); } catch (Exception ignored) {}
            surfaceTextureHelper = null;
        }
    }

    private void stopCaptureInternal() {
        webrtcExecutor.execute(() -> {
            stopCaptureOnly();
            for (NativePeer peer : peers.values()) {
                peer.pc.close();
            }
            peers.clear();
        });
    }

    @PluginMethod
    public void stopBroadcast(PluginCall call) {
        stopCaptureInternal();
        try {
            if (voiceServiceActive) {
                Intent voiceIntent = new Intent(getContext(), ScreenCaptureService.class);
                voiceIntent.putExtra(ScreenCaptureService.EXTRA_VOICE_ONLY, true);
                ContextCompat.startForegroundService(getContext(), voiceIntent);
            } else {
                getContext().stopService(new Intent(getContext(), ScreenCaptureService.class));
            }
        } catch (Exception ignored) {}
        JSObject res = new JSObject();
        res.put("stopped", true);
        call.resolve(res);
    }

    @PluginMethod
    public void createPeerOffer(PluginCall call) {
        String viewerUid = call.getString("viewerUid");
        if (viewerUid == null || viewerUid.isEmpty()) {
            call.reject("Missing viewerUid");
            return;
        }
        initWebRTCIfNeeded();

        JSArray iceArray = call.getArray("iceServers");
        int maxBitrate = call.getInt("maxBitrate", 5_000_000);
        int maxFramerate = call.getInt("maxFramerate", 60);

        webrtcExecutor.execute(() -> {
            NativePeer old = peers.remove(viewerUid);
            if (old != null) old.pc.close();

            List<PeerConnection.IceServer> rtcServers = new ArrayList<>();
            if (iceArray != null) {
                for (int i = 0; i < iceArray.length(); i++) {
                    try {
                        JSONObject item = iceArray.getJSONObject(i);
                        List<String> urls = new ArrayList<>();
                        Object uObj = item.opt("urls");
                        if (uObj instanceof String) {
                            urls.add((String) uObj);
                        } else if (uObj instanceof org.json.JSONArray) {
                            org.json.JSONArray arr = (org.json.JSONArray) uObj;
                            for (int j = 0; j < arr.length(); j++) {
                                urls.add(arr.optString(j));
                            }
                        }
                        if (urls.isEmpty()) continue;
                        PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urls);
                        String user = item.optString("username", "");
                        String cred = item.optString("credential", "");
                        if (!user.isEmpty() && !cred.isEmpty()) {
                            b.setUsername(user).setPassword(cred);
                        }
                        rtcServers.add(b.createIceServer());
                    } catch (JSONException ignored) {}
                }
            }
            if (rtcServers.isEmpty()) {
                rtcServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
            }

            PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(rtcServers);
            config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;

            final NativePeer[] holder = new NativePeer[1];
            PeerConnection pc = pcFactory.createPeerConnection(config, new PeerConnection.Observer() {
                @Override public void onIceCandidate(IceCandidate c) { if (holder[0] != null) holder[0].onIceCandidate(c); }
                @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
                @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) {}
                @Override public void onIceConnectionReceivingChange(boolean b) {}
                @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
                @Override public void onIceCandidatesRemoved(IceCandidate[] c) {}
                @Override public void onAddStream(MediaStream s) {}
                @Override public void onRemoveStream(MediaStream s) {}
                @Override public void onDataChannel(DataChannel dc) {}
                @Override public void onRenegotiationNeeded() {}
                @Override public void onAddTrack(org.webrtc.RtpReceiver r, MediaStream[] s) {}
                @Override public void onTrack(RtpTransceiver t) {}
            });
            if (pc == null) {
                call.reject("Failed to create PeerConnection");
                return;
            }

            NativePeer peer = new NativePeer(viewerUid, pc, this);
            holder[0] = peer;
            peers.put(viewerUid, peer);

            DataChannel.Init dcInit = new DataChannel.Init();
            dcInit.ordered = false;
            dcInit.maxRetransmits = 0;
            peer.audioDataChannel = pc.createDataChannel("screen_audio", dcInit);

            RtpSender sender = pc.addTrack(localVideoTrack, Collections.singletonList("cineverse_screen"));
            if (sender != null) {
                RtpParameters params = sender.getParameters();
                if (!params.encodings.isEmpty()) {
                    RtpParameters.Encoding enc = params.encodings.get(0);
                    enc.minBitrateBps = Math.min(maxBitrate / 2, Math.max(800_000, maxBitrate / 3));
                    enc.maxBitrateBps = maxBitrate;
                    enc.maxFramerate = Math.max(45, maxFramerate);
                }
                params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE;
                sender.setParameters(params);
            }

            MediaConstraints offerConstraints = new MediaConstraints();
            offerConstraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"));
            offerConstraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));

            pc.createOffer(new SdpObserver() {
                @Override
                public void onCreateSuccess(SessionDescription sdp) {
                    String boosted = sdp.description.replaceAll(
                            "a=fmtp:(\\d+) (.*)",
                            "a=fmtp:$1 $2;x-google-start-bitrate=3500;x-google-min-bitrate=1500;x-google-max-bitrate=6000"
                    );
                    SessionDescription boostedSdp = new SessionDescription(sdp.type, boosted);
                    pc.setLocalDescription(new SdpObserver() {
                        @Override
                        public void onSetSuccess() {
                            JSObject sdpObj = new JSObject();
                            sdpObj.put("type", boostedSdp.type.canonicalForm());
                            sdpObj.put("sdp", boostedSdp.description);
                            JSObject res = new JSObject();
                            res.put("sdp", sdpObj);
                            call.resolve(res);
                        }
                        @Override
                        public void onSetFailure(String err) {
                            pc.setLocalDescription(new SdpObserver() {
                                @Override
                                public void onSetSuccess() {
                                    JSObject sdpObj = new JSObject();
                                    sdpObj.put("type", sdp.type.canonicalForm());
                                    sdpObj.put("sdp", sdp.description);
                                    JSObject res = new JSObject();
                                    res.put("sdp", sdpObj);
                                    call.resolve(res);
                                }
                                @Override public void onSetFailure(String e2) { call.reject(e2); }
                                @Override public void onCreateSuccess(SessionDescription s) {}
                                @Override public void onCreateFailure(String s) {}
                            }, sdp);
                        }
                        @Override public void onCreateSuccess(SessionDescription s) {}
                        @Override public void onCreateFailure(String s) {}
                    }, boostedSdp);
                }

                @Override public void onCreateFailure(String err) { call.reject(err); }
                @Override public void onSetSuccess() {}
                @Override public void onSetFailure(String s) {}
            }, offerConstraints);
        });
    }

    @PluginMethod
    public void setRemoteAnswer(PluginCall call) {
        String viewerUid = call.getString("viewerUid");
        JSObject sdpObj = call.getObject("sdp");
        if (viewerUid == null || sdpObj == null) {
            call.reject("Missing answer payload");
            return;
        }
        String sdpStr = sdpObj.getString("sdp");
        if (sdpStr == null) {
            call.reject("Missing sdp string");
            return;
        }

        webrtcExecutor.execute(() -> {
            NativePeer peer = peers.get(viewerUid);
            if (peer == null) {
                JSObject res = new JSObject();
                res.put("ok", false);
                call.resolve(res);
                return;
            }
            SessionDescription answer = new SessionDescription(SessionDescription.Type.ANSWER, sdpStr);
            peer.pc.setRemoteDescription(new SdpObserver() {
                @Override
                public void onSetSuccess() {
                    synchronized (peer.pendingIce) {
                        for (IceCandidate cand : peer.pendingIce) {
                            peer.pc.addIceCandidate(cand);
                        }
                        peer.pendingIce.clear();
                    }
                    JSObject res = new JSObject();
                    res.put("ok", true);
                    call.resolve(res);
                }
                @Override
                public void onSetFailure(String err) {
                    JSObject res = new JSObject();
                    res.put("ok", false);
                    call.resolve(res);
                }
                @Override public void onCreateSuccess(SessionDescription s) {}
                @Override public void onCreateFailure(String s) {}
            }, answer);
        });
    }

    @PluginMethod
    public void addIceCandidate(PluginCall call) {
        String viewerUid = call.getString("viewerUid");
        JSObject candObj = call.getObject("candidate");
        if (viewerUid == null || candObj == null) {
            JSObject res = new JSObject();
            res.put("ok", false);
            call.resolve(res);
            return;
        }
        String sdp = candObj.getString("candidate");
        String sdpMid = candObj.getString("sdpMid", "");
        int mLine = candObj.getInteger("sdpMLineIndex", 0);
        if (sdp == null) {
            JSObject res = new JSObject();
            res.put("ok", false);
            call.resolve(res);
            return;
        }
        IceCandidate cand = new IceCandidate(sdpMid, mLine, sdp);
        webrtcExecutor.execute(() -> {
            NativePeer peer = peers.get(viewerUid);
            if (peer == null) {
                JSObject res = new JSObject();
                res.put("ok", false);
                call.resolve(res);
                return;
            }
            if (peer.pc.getRemoteDescription() != null) {
                peer.pc.addIceCandidate(cand);
            } else {
                peer.pendingIce.add(cand);
            }
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void closePeer(PluginCall call) {
        String viewerUid = call.getString("viewerUid");
        webrtcExecutor.execute(() -> {
            if (viewerUid != null) {
                NativePeer peer = peers.remove(viewerUid);
                if (peer != null) peer.pc.close();
            }
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void closeAllPeers(PluginCall call) {
        webrtcExecutor.execute(() -> {
            for (NativePeer peer : peers.values()) {
                peer.pc.close();
            }
            peers.clear();
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        });
    }

    private List<PeerConnection.IceServer> parseIceServers(JSArray iceArray) {
        List<PeerConnection.IceServer> rtcServers = new ArrayList<>();
        if (iceArray != null) {
            for (int i = 0; i < iceArray.length(); i++) {
                try {
                    JSONObject item = iceArray.getJSONObject(i);
                    List<String> urls = new ArrayList<>();
                    Object uObj = item.opt("urls");
                    if (uObj instanceof String) {
                        urls.add((String) uObj);
                    } else if (uObj instanceof org.json.JSONArray) {
                        org.json.JSONArray arr = (org.json.JSONArray) uObj;
                        for (int j = 0; j < arr.length(); j++) {
                            urls.add(arr.optString(j));
                        }
                    }
                    if (urls.isEmpty()) continue;
                    PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urls);
                    String user = item.optString("username", "");
                    String cred = item.optString("credential", "");
                    if (!user.isEmpty() && !cred.isEmpty()) {
                        b.setUsername(user).setPassword(cred);
                    }
                    rtcServers.add(b.createIceServer());
                } catch (JSONException ignored) {}
            }
        }
        if (rtcServers.isEmpty()) {
            rtcServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        }
        return rtcServers;
    }

    @PluginMethod
    public void voiceStartService(PluginCall call) {
        voiceServiceActive = true;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("audio", call, "onVoiceAudioPermResult");
            return;
        }
        startVoiceForegroundInternal(call);
    }

    @PermissionCallback
    private void onVoiceAudioPermResult(PluginCall call) {
        startVoiceForegroundInternal(call);
    }

    private void startVoiceForegroundInternal(PluginCall call) {
        initWebRTCIfNeeded();
        if (!isBroadcasting && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            try {
                Intent serviceIntent = new Intent(getContext(), ScreenCaptureService.class);
                serviceIntent.putExtra(ScreenCaptureService.EXTRA_VOICE_ONLY, true);
                ContextCompat.startForegroundService(getContext(), serviceIntent);
            } catch (Exception ignored) {}
        }
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                am.setSpeakerphoneOn(true);
            }
        } catch (Exception ignored) {}
        JSObject res = new JSObject();
        res.put("ok", true);
        call.resolve(res);
    }

    @PluginMethod
    public void voiceStopService(PluginCall call) {
        voiceServiceActive = false;
        voiceMicEnabled = false;
        webrtcExecutor.execute(() -> {
            if (localVoiceAudioTrack != null) {
                localVoiceAudioTrack.setEnabled(false);
            }
            for (NativeVoicePeer peer : voicePeers.values()) {
                peer.pc.close();
            }
            voicePeers.clear();
            if (!isBroadcasting) {
                try {
                    getContext().stopService(new Intent(getContext(), ScreenCaptureService.class));
                } catch (Exception ignored) {}
            }
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void voiceSetMicEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        voiceMicEnabled = enabled;
        initWebRTCIfNeeded();
        if (enabled) {
            try {
                AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    am.setSpeakerphoneOn(true);
                }
            } catch (Exception ignored) {}
        }
        webrtcExecutor.execute(() -> {
            if (localVoiceAudioTrack != null) {
                localVoiceAudioTrack.setEnabled(enabled);
            }
            JSObject res = new JSObject();
            res.put("ok", true);
            res.put("enabled", enabled);
            call.resolve(res);
        });
    }

    private NativeVoicePeer createNativeVoicePeerLocked(String remoteUid, JSArray iceArray) {
        List<PeerConnection.IceServer> rtcServers = parseIceServers(iceArray);
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(rtcServers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;

        final NativeVoicePeer[] holder = new NativeVoicePeer[1];
        PeerConnection pc = pcFactory.createPeerConnection(config, new PeerConnection.Observer() {
            @Override public void onIceCandidate(IceCandidate c) { if (holder[0] != null) holder[0].onIceCandidate(c); }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) { if (holder[0] != null) holder[0].onIceConnectionChange(s); }
            @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
            @Override public void onIceConnectionReceivingChange(boolean b) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
            @Override public void onIceCandidatesRemoved(IceCandidate[] c) {}
            @Override public void onAddStream(MediaStream s) {}
            @Override public void onRemoveStream(MediaStream s) {}
            @Override public void onDataChannel(DataChannel dc) {}
            @Override public void onRenegotiationNeeded() {}
            @Override public void onAddTrack(org.webrtc.RtpReceiver r, MediaStream[] s) {}
            @Override public void onTrack(RtpTransceiver t) {}
        });
        if (pc == null) return null;
        NativeVoicePeer peer = new NativeVoicePeer(remoteUid, pc, this);
        holder[0] = peer;
        voicePeers.put(remoteUid, peer);
        if (localVoiceAudioTrack != null) {
            pc.addTrack(localVoiceAudioTrack, Collections.singletonList("cineverse_voice"));
        }
        return peer;
    }

    @PluginMethod
    public void voiceCreateOffer(PluginCall call) {
        String remoteUid = call.getString("remoteUid");
        if (remoteUid == null || remoteUid.isEmpty()) {
            call.reject("Missing remoteUid");
            return;
        }
        JSArray iceArray = call.getArray("iceServers");
        boolean iceRestart = call.getBoolean("iceRestart", false);
        initWebRTCIfNeeded();

        webrtcExecutor.execute(() -> {
            NativeVoicePeer peer = iceRestart ? voicePeers.get(remoteUid) : null;
            if (peer == null) {
                NativeVoicePeer old = voicePeers.remove(remoteUid);
                if (old != null) old.pc.close();
                peer = createNativeVoicePeerLocked(remoteUid, iceArray);
            }
            if (peer == null) {
                call.reject("Failed to create voice PeerConnection");
                return;
            }
            final NativeVoicePeer targetPeer = peer;
            MediaConstraints offerConstraints = new MediaConstraints();
            offerConstraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"));
            offerConstraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));
            if (iceRestart) {
                offerConstraints.mandatory.add(new MediaConstraints.KeyValuePair("IceRestart", "true"));
            }

            targetPeer.pc.createOffer(new SdpObserver() {
                @Override
                public void onCreateSuccess(SessionDescription sdp) {
                    targetPeer.pc.setLocalDescription(new SdpObserver() {
                        @Override
                        public void onSetSuccess() {
                            JSObject sdpObj = new JSObject();
                            sdpObj.put("type", sdp.type.canonicalForm());
                            sdpObj.put("sdp", sdp.description);
                            JSObject res = new JSObject();
                            res.put("sdp", sdpObj);
                            call.resolve(res);
                        }
                        @Override public void onSetFailure(String err) { call.reject(err); }
                        @Override public void onCreateSuccess(SessionDescription s) {}
                        @Override public void onCreateFailure(String s) {}
                    }, sdp);
                }
                @Override public void onCreateFailure(String err) { call.reject(err); }
                @Override public void onSetSuccess() {}
                @Override public void onSetFailure(String s) {}
            }, offerConstraints);
        });
    }

    @PluginMethod
    public void voiceHandleOffer(PluginCall call) {
        String remoteUid = call.getString("remoteUid");
        String sdpStr = call.getString("sdp");
        if (remoteUid == null || sdpStr == null) {
            call.reject("Missing remoteUid or sdp");
            return;
        }
        JSArray iceArray = call.getArray("iceServers");
        boolean fresh = call.getBoolean("fresh", false);
        initWebRTCIfNeeded();

        webrtcExecutor.execute(() -> {
            if (fresh) {
                NativeVoicePeer old = voicePeers.remove(remoteUid);
                if (old != null) old.pc.close();
            }
            NativeVoicePeer peer = voicePeers.get(remoteUid);
            if (peer == null) {
                peer = createNativeVoicePeerLocked(remoteUid, iceArray);
            }
            if (peer == null) {
                call.reject("Failed to create voice PeerConnection");
                return;
            }
            final NativeVoicePeer targetPeer = peer;
            SessionDescription offer = new SessionDescription(SessionDescription.Type.OFFER, sdpStr);
            targetPeer.pc.setRemoteDescription(new SdpObserver() {
                @Override
                public void onSetSuccess() {
                    synchronized (targetPeer.pendingIce) {
                        for (IceCandidate c : targetPeer.pendingIce) {
                            targetPeer.pc.addIceCandidate(c);
                        }
                        targetPeer.pendingIce.clear();
                    }
                    MediaConstraints ansConstraints = new MediaConstraints();
                    ansConstraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"));
                    ansConstraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));
                    targetPeer.pc.createAnswer(new SdpObserver() {
                        @Override
                        public void onCreateSuccess(SessionDescription ans) {
                            targetPeer.pc.setLocalDescription(new SdpObserver() {
                                @Override
                                public void onSetSuccess() {
                                    JSObject sdpObj = new JSObject();
                                    sdpObj.put("type", ans.type.canonicalForm());
                                    sdpObj.put("sdp", ans.description);
                                    JSObject res = new JSObject();
                                    res.put("sdp", sdpObj);
                                    call.resolve(res);
                                }
                                @Override public void onSetFailure(String err) { call.reject(err); }
                                @Override public void onCreateSuccess(SessionDescription s) {}
                                @Override public void onCreateFailure(String s) {}
                            }, ans);
                        }
                        @Override public void onCreateFailure(String err) { call.reject(err); }
                        @Override public void onSetSuccess() {}
                        @Override public void onSetFailure(String s) {}
                    }, ansConstraints);
                }
                @Override public void onSetFailure(String err) { call.reject(err); }
                @Override public void onCreateSuccess(SessionDescription s) {}
                @Override public void onCreateFailure(String s) {}
            }, offer);
        });
    }

    @PluginMethod
    public void voiceSetRemoteAnswer(PluginCall call) {
        String remoteUid = call.getString("remoteUid");
        String sdpStr = call.getString("sdp");
        if (remoteUid == null || sdpStr == null) {
            JSObject res = new JSObject();
            res.put("ok", false);
            call.resolve(res);
            return;
        }
        webrtcExecutor.execute(() -> {
            NativeVoicePeer peer = voicePeers.get(remoteUid);
            if (peer == null) {
                JSObject res = new JSObject();
                res.put("ok", false);
                call.resolve(res);
                return;
            }
            SessionDescription ans = new SessionDescription(SessionDescription.Type.ANSWER, sdpStr);
            peer.pc.setRemoteDescription(new SdpObserver() {
                @Override
                public void onSetSuccess() {
                    synchronized (peer.pendingIce) {
                        for (IceCandidate c : peer.pendingIce) {
                            peer.pc.addIceCandidate(c);
                        }
                        peer.pendingIce.clear();
                    }
                    JSObject res = new JSObject();
                    res.put("ok", true);
                    call.resolve(res);
                }
                @Override
                public void onSetFailure(String err) {
                    JSObject res = new JSObject();
                    res.put("ok", false);
                    call.resolve(res);
                }
                @Override public void onCreateSuccess(SessionDescription s) {}
                @Override public void onCreateFailure(String s) {}
            }, ans);
        });
    }

    @PluginMethod
    public void voiceAddIceCandidate(PluginCall call) {
        String remoteUid = call.getString("remoteUid");
        JSObject candObj = call.getObject("candidate");
        if (remoteUid == null || candObj == null) {
            JSObject res = new JSObject();
            res.put("ok", false);
            call.resolve(res);
            return;
        }
        String sdp = candObj.getString("candidate");
        String sdpMid = candObj.getString("sdpMid", "");
        int mLine = candObj.getInteger("sdpMLineIndex", 0);
        if (sdp == null) {
            JSObject res = new JSObject();
            res.put("ok", false);
            call.resolve(res);
            return;
        }
        IceCandidate cand = new IceCandidate(sdpMid, mLine, sdp);
        webrtcExecutor.execute(() -> {
            NativeVoicePeer peer = voicePeers.get(remoteUid);
            if (peer == null) {
                JSObject res = new JSObject();
                res.put("ok", false);
                call.resolve(res);
                return;
            }
            if (peer.pc.getRemoteDescription() != null) {
                peer.pc.addIceCandidate(cand);
            } else {
                peer.pendingIce.add(cand);
            }
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void voiceClosePeer(PluginCall call) {
        String remoteUid = call.getString("remoteUid");
        webrtcExecutor.execute(() -> {
            if (remoteUid != null) {
                NativeVoicePeer peer = voicePeers.remove(remoteUid);
                if (peer != null) peer.pc.close();
            }
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void voiceGetStats(PluginCall call) {
        webrtcExecutor.execute(() -> {
            JSObject peersObj = new JSObject();
            List<Map.Entry<String, NativeVoicePeer>> entries = new ArrayList<>(voicePeers.entrySet());
            if (entries.isEmpty()) {
                JSObject res = new JSObject();
                res.put("peers", peersObj);
                call.resolve(res);
                return;
            }
            final int[] remaining = { entries.size() };
            for (Map.Entry<String, NativeVoicePeer> e : entries) {
                String uid = e.getKey();
                NativeVoicePeer p = e.getValue();
                p.pc.getStats((RTCStatsReport report) -> {
                    long sent = 0;
                    long recv = 0;
                    for (RTCStats stat : report.getStatsMap().values()) {
                        String type = stat.getType();
                        if ("outbound-rtp".equals(type)) {
                            Object b = stat.getMembers().get("bytesSent");
                            if (b instanceof Number) sent += ((Number) b).longValue();
                        } else if ("inbound-rtp".equals(type)) {
                            Object b = stat.getMembers().get("bytesReceived");
                            if (b instanceof Number) recv += ((Number) b).longValue();
                        }
                    }
                    JSObject pStat = new JSObject();
                    pStat.put("iceState", p.iceState);
                    pStat.put("bytesSent", sent);
                    pStat.put("bytesReceived", recv);
                    synchronized (peersObj) {
                        peersObj.put(uid, pStat);
                        remaining[0]--;
                        if (remaining[0] == 0) {
                            JSObject res = new JSObject();
                            res.put("peers", peersObj);
                            call.resolve(res);
                        }
                    }
                });
            }
        });
    }
}
