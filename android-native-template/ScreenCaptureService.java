package com.cineverse.lotte;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

public class ScreenCaptureService extends Service {
    public static final String CHANNEL_ID = "cineverse_screen_share";
    public static final int NOTIFICATION_ID = 9421;
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    public static final String EXTRA_VOICE_ONLY = "voiceOnly";
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean voiceOnly = intent != null && intent.getBooleanExtra(EXTRA_VOICE_ONLY, false);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("CineVerse Lotte")
                .setContentText(voiceOnly ? "Đang kết nối Voice Chat nền..." : "Đang chia sẻ màn hình & âm thanh trực tiếp...")
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int fgType = 0;
            if (!voiceOnly) {
                fgType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                fgType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
            if (fgType == 0) {
                fgType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            }
            startForeground(NOTIFICATION_ID, notification, fgType);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CineVerse::ScreenShareWakeLock");
                wakeLock.acquire();
            }
        }

        if (intent != null && intent.hasExtra(EXTRA_RESULT_CODE)) {
            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            ReplayKitBridgePlugin.onForegroundServiceReady(this, resultCode, resultData);
        }

        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
            wakeLock = null;
        }
        ReplayKitBridgePlugin.onForegroundServiceStopped();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Chia sẻ màn hình",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Giữ luồng chia sẻ màn hình chạy mượt ở chế độ nền");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
