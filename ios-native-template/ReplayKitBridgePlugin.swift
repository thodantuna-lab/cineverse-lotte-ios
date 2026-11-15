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
    private var activeConnection: NWConnection?
    private var isEvaluatingVideo = false
    private var audioEngine: AVAudioEngine?
    private var audioSourceNode: AVAudioSourceNode?
    private var pendingAudioPCM = Data()
    private var pendingAudioSampleRate: UInt32 = 44100
    private var pendingAudioChannels: UInt16 = 2
    private var lastAudioFlushTime: CFTimeInterval = 0

    public override func load() {
        startLocalReceiver()
    }

    private func startLocalReceiver() {
        guard listener == nil else { return }
        do {
            let params = NWParameters.tcp
            let newListener = try NWListener(using: params, on: 49321)
            newListener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .failed, .cancelled:
                    self?.listener = nil
                    self?.queue.asyncAfter(deadline: .now() + 0.5) {
                        self?.startLocalReceiver()
                    }
                default:
                    break
                }
            }
            newListener.newConnectionHandler = { [weak self] conn in
                self?.handleExtensionConnection(conn)
            }
            newListener.start(queue: queue)
            listener = newListener
        } catch {
            NSLog("[ReplayKitBridge] NWListener error: \(error)")
        }
    }

    private func startBackgroundKeepAlive() {
        if audioEngine != nil { return }
        let engine = AVAudioEngine()
        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
        let node = AVAudioSourceNode { _, _, frameCount, audioBufferList -> OSStatus in
            let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
            for buf in abl {
                if let ptr = buf.mData {
                    memset(ptr, 0, Int(buf.mDataByteSize))
                }
            }
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = 0.0
        do {
            try engine.start()
            self.audioSourceNode = node
            self.audioEngine = engine
        } catch {
            NSLog("[ReplayKitBridge] Background keepalive engine error: \(error)")
        }
    }

    private func stopBackgroundKeepAlive() {
        audioEngine?.stop()
        if let node = audioSourceNode {
            audioEngine?.detach(node)
        }
        audioSourceNode = nil
        audioEngine = nil
    }

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
                if !self.isEvaluatingVideo {
                    self.isEvaluatingVideo = true
                    let b64 = buffer.base64EncodedString()
                    DispatchQueue.main.async {
                        self.bridge?.webView?.evaluateJavaScript(
                            "window.__onNativeReplayKitFrame && window.__onNativeReplayKitFrame('data:image/jpeg;base64,\(b64)');",
                            completionHandler: { [weak self] _, _ in
                                self?.isEvaluatingVideo = false
                            }
                        )
                    }
                }
            } else if packetType == 0x02 && buffer.count > 6 {
                let sampleRate = buffer.subdata(in: 0..<4).withUnsafeBytes { $0.load(as: UInt32.self).littleEndian }
                let channels = buffer.subdata(in: 4..<6).withUnsafeBytes { $0.load(as: UInt16.self).littleEndian }
                let pcmChunk = buffer.subdata(in: 6..<buffer.count)

                if self.pendingAudioSampleRate != sampleRate || self.pendingAudioChannels != channels {
                    self.flushPendingAudio()
                    self.pendingAudioSampleRate = sampleRate
                    self.pendingAudioChannels = channels
                }
                self.pendingAudioPCM.append(pcmChunk)

                let now = CACurrentMediaTime()
                if self.pendingAudioPCM.count >= 12288 || (now - self.lastAudioFlushTime) >= 0.08 {
                    self.flushPendingAudio()
                }
            }

            self.readNextPacket(on: conn)
        }
    }

    private func flushPendingAudio() {
        guard !pendingAudioPCM.isEmpty else { return }
        let pcmB64 = pendingAudioPCM.base64EncodedString()
        let sr = pendingAudioSampleRate
        let ch = pendingAudioChannels
        pendingAudioPCM.removeAll(keepingCapacity: true)
        lastAudioFlushTime = CACurrentMediaTime()
        DispatchQueue.main.async {
            self.bridge?.webView?.evaluateJavaScript(
                "window.__onNativeReplayKitAudio && window.__onNativeReplayKitAudio('\(pcmB64)', \(sr), \(ch));",
                completionHandler: nil
            )
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
        startBackgroundKeepAlive()
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
        queue.async { [weak self] in
            self?.pendingAudioPCM.removeAll(keepingCapacity: false)
        }
        stopBackgroundKeepAlive()
        DispatchQueue.main.async { [weak self] in
            self?.pickerView?.removeFromSuperview()
            self?.pickerView = nil
            call.resolve(["stopped": true])
        }
    }
}
