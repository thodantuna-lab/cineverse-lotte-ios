#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(ReplayKitBridgePlugin, "ReplayKitBridge",
    CAP_PLUGIN_METHOD(startBroadcast, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopBroadcast, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(createPeerOffer, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(setRemoteAnswer, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addIceCandidate, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(closePeer, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(closeAllPeers, CAPPluginReturnPromise);
)
