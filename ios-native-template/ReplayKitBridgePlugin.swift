import Foundation
import Capacitor
import ReplayKit
import Network
import AVFoundation
import UIKit

@objc(ReplayKitBridgePlugin)
public class ReplayKitBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReplayKitBridgePlugin"
    public let jsName = "ReplayKitBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startBroadcast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBroadcast", returnType: CAPPluginReturnPromise)
    ]

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.cineverse.lotte.replaykit.server")
    private var pickerView: RPSystemBroadcastPickerView?

    public override func load() {
        startLocalReceiver()
    }

    private func startLocalReceiver() {
        guard listener == nil else { return }
        do {
            let params = NWParameters.tcp
            listener = try NWListener(using: params, on: 49321)
            listener?.newConnectionHandler = { [weak self] conn in
                self?.handleExtensionConnection(conn)
            }
            listener?.start(queue: queue)
        } catch {
            NSLog("[ReplayKitBridge] NWListener error: \(error)")
        }
    }

    private var activeConnection: NWConnection?

    private func handleExtensionConnection(_ conn: NWConnection) {
        activeConnection?.cancel()
        activeConnection = conn
        conn.start(queue: queue)
        readNextPacket(on: conn)
    }

    private func readNextPacket(on conn: NWConnection) {
        // Header: [1-byte type][4-byte big-endian length]
        conn.receive(minimumIncompleteLength: 5, maximumLength: 5) { [weak self] headerData, _, isComplete, error in
            guard let self = self, error == nil, let header = headerData, header.count == 5 else {
                if isComplete || error != nil { conn.cancel() }
                return
            }
            let packetType = header[0]
            let length = Int(header.subdata(in: 1..<5).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian })
            guard length > 0 && length < 8_000_000 else {
                conn.cancel()
                return
            }
            self.readExactPayload(packetType: packetType, length: length, accumulated: Data(), on: conn)
        }
    }

    private func readExactPayload(packetType: UInt8, length: Int, accumulated: Data, on conn: NWConnection) {
        let remaining = length - accumulated.count
        conn.receive(minimumIncompleteLength: 1, maximumLength: remaining) { [weak self] chunk, _, isComplete, error in
            guard let self = self, error == nil, let chunk = chunk else {
                if isComplete || error != nil { conn.cancel() }
                return
            }
            var buffer = accumulated
            buffer.append(chunk)
            if buffer.count < length {
                self.readExactPayload(packetType: packetType, length: length, accumulated: buffer, on: conn)
                return
            }

            if packetType == 0x01 {
                let b64 = buffer.base64EncodedString()
                DispatchQueue.main.async {
                    self.bridge?.webView?.evaluateJavaScript(
                        "window.__onNativeReplayKitFrame && window.__onNativeReplayKitFrame('data:image/jpeg;base64,\(b64)');",
                        completionHandler: nil
                    )
                }
            } else if packetType == 0x02 && buffer.count > 6 {
                let sampleRate = buffer.subdata(in: 0..<4).withUnsafeBytes { $0.load(as: UInt32.self).littleEndian }
                let channels = buffer.subdata(in: 4..<6).withUnsafeBytes { $0.load(as: UInt16.self).littleEndian }
                let pcmB64 = buffer.subdata(in: 6..<buffer.count).base64EncodedString()
                DispatchQueue.main.async {
                    self.bridge?.webView?.evaluateJavaScript(
                        "window.__onNativeReplayKitAudio && window.__onNativeReplayKitAudio('\(pcmB64)', \(sampleRate), \(channels));",
                        completionHandler: nil
                    )
                }
            }

            self.readNextPacket(on: conn)
        }
    }

    private func findReplayKitExtensionBundleID() -> String {
        if let plugInsURL = Bundle.main.builtInPlugInsURL,
           let urls = try? FileManager.default.contentsOfDirectory(at: plugInsURL, includingPropertiesForKeys: nil) {
            for url in urls where url.pathExtension == "appex" {
                if let bundle = Bundle(url: url), let bid = bundle.bundleIdentifier {
                    return bid
                }
            }
        }
        if let mainId = Bundle.main.bundleIdentifier {
            return "\(mainId).ReplayKitExtension"
        }
        return "com.cineverse.lotte.ReplayKitExtension"
    }

    @objc func startBroadcast(_ call: CAPPluginCall) {
        startLocalReceiver()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .videoChat, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            NSLog("[ReplayKitBridge] AVAudioSession error: \(error)")
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let rootView = self.bridge?.viewController?.view else {
                call.reject("Missing root view")
                return
            }
            let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
            picker.alpha = 0.01
            picker.preferredExtension = self.findReplayKitExtensionBundleID()
            picker.showsMicrophoneButton = false
            rootView.addSubview(picker)
            self.pickerView = picker

            for subview in picker.subviews {
                if let btn = subview as? UIButton {
                    btn.sendActions(for: .touchUpInside)
                    break
                }
            }
            call.resolve(["started": true])
        }
    }

    @objc func stopBroadcast(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.pickerView?.removeFromSuperview()
            self?.pickerView = nil
            call.resolve(["stopped": true])
        }
    }
}
