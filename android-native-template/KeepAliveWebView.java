package com.cineverse.lotte;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;

import com.getcapacitor.CapacitorWebView;

public class KeepAliveWebView extends CapacitorWebView {
    public KeepAliveWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        if (ReplayKitBridgePlugin.isScreenSharingActive() && visibility != View.VISIBLE) {
            super.onWindowVisibilityChanged(View.VISIBLE);
            return;
        }
        super.onWindowVisibilityChanged(visibility);
    }

    @Override
    public void onWindowFocusChanged(boolean hasWindowFocus) {
        if (ReplayKitBridgePlugin.isScreenSharingActive() && !hasWindowFocus) {
            super.onWindowFocusChanged(true);
            return;
        }
        super.onWindowFocusChanged(hasWindowFocus);
    }
}
