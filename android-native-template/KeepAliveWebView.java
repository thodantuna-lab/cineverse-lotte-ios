package com.cineverse.lotte;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;

import com.getcapacitor.BridgeWebView;

public class KeepAliveWebView extends BridgeWebView {
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
}
