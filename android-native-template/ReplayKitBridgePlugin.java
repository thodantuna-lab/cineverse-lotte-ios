package com.cineverse.lotte;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
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
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpParameters;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

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
    private VideoSource videoSource;
    private VideoTrack localVideoTrack;
    private ScreenCapturerAndroid screenCapturer;
    private SurfaceTextureHelper surfaceTextureHelper;

    private final Map<String, NativePeer> peers = new ConcurrentHashMap<>();
    private final ExecutorService webrtcExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private volatile boolean isBroadcasting = false;
    private volatile boolean isAudioCapturing = false;
    private Thread audioCaptureThread;
    private AudioRecord audioRecord;
    private PluginCall pendingStartCall;

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
        PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(getContext().getApplicationContext())
                        .setEnableInternalTracer(false)
                        .createInitializationOptions()
        );
        eglBase = EglBase.create();
        DefaultVideoEncoderFactory encoderFactory = new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true);
        DefaultVideoDecoderFactory decoderFactory = new DefaultVideoDecoderFactory(eglBase.getEglBaseContext());
        pcFactory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .createPeerConnectionFactory();
        videoSource = pcFactory.createVideoSource(true);
        localVideoTrack = pcFactory.createVideoTrack("screen0", videoSource);
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
            getContext().stopService(new Intent(getContext(), ScreenCaptureService.class));
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
                    enc.minBitrateBps = Math.max(1_500_000, maxBitrate / 3);
                    enc.maxBitrateBps = maxBitrate;
                    enc.maxFramerate = maxFramerate;
                }
                params.degradationPreference = RtpParameters.DegradationPreference.BALANCED;
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
}
