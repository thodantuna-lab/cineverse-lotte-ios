#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(ReplayKitBridgePlugin, "ReplayKitBridge",
    CAP_PLUGIN_METHOD(startBroadcast, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopBroadcast, CAPPluginReturnPromise);
)
