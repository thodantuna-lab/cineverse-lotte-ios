import Foundation
import Capacitor
import ReplayKit
import Network
import AVFoundation
import CoreVideo
import VideoToolbox
import UIKit
import WebRTC

private final class NativeScreenPeer: NSObject, RTCPeerConnectionDelegate {
    let viewerUid: String
    let pc: RTCPeerConnection
    var audioDataChannel: RTCDataChannel?
    var pendingIce: [RTCIceCandidate] = []
    weak var plugin: ReplayKitBridgePlugin?

    init(viewerUid: String, pc: RTCPeerConnection, plugin: ReplayKitBridgePlugin) {
        self.viewerUid = viewerUid
        self.pc = pc
        self.plugin = plugin
        super.init()
        pc.delegate = self
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let candDict: [String: Any] = [
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid ?? "",
            "sdpMLineIndex": candidate.sdpMLineIndex
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: candDict),
              let jsonStr = String(data: data, encoding: .utf8) else { return }
        let uidEscaped = viewerUid.replacingOccurrences(of: "'", with: "\\'")
        DispatchQueue.main.async { [weak self] in
            self?.plugin?.bridge?.webView?.evaluateJavaScript(
                "window.__onNativeWebRTCIce && window.__onNativeWebRTCIce('\(uidEscaped)', \(jsonStr));",
                completionHandler: nil
            )
        }
    }
}

@objc(ReplayKitBridgePlugin)
public class ReplayKitBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReplayKitBridgePlugin"
    public let jsName = "ReplayKitBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startBroadcast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBroadcast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createPeerOffer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRemoteAnswer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addIceCandidate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closePeer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeAllPeers", returnType: CAPPluginReturnPromise)
    ]

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.cineverse.lotte.replaykit.server", qos: .userInteractive)
    private var pickerView: RPSystemBroadcastPickerView?
    private var activeConnection: NWConnection?

    private var audioEngine: AVAudioEngine?
    private var audioSourceNode: AVAudioSourceNode?
    private var pendingAudioPCM = Data()
    private var pendingAudioSampleRate: UInt32 = 44100
    private var pendingAudioChannels: UInt16 = 2
    private var lastAudioFlushTime: CFTimeInterval = 0

    // Native WebRTC (Hardware H.264 VideoToolbox 60fps)
    private static var sslInitialized = false
    private var pcFactory: RTCPeerConnectionFactory?
    private var videoSource: RTCVideoSource?
    private var videoCapturer: RTCVideoCapturer?
    private var localVideoTrack: RTCVideoTrack?
    private var peers: [String: NativeScreenPeer] = [:]
    private let webrtcQueue = DispatchQueue(label: "com.cineverse.lotte.webrtc", qos: .userInteractive)

    // Reusable CVPixelBufferPool & Hardware H.264 VTDecompressionSession
    private var pixelBufferPool: CVPixelBufferPool?
    private var poolWidth: Int = 0
    private var poolHeight: Int = 0
    private var poolFormat: OSType = 0
    private var decompressionSession: VTDecompressionSession?
    private var videoFormatDesc: CMVideoFormatDescription?
    private var currentSPS = Data()
    private var currentPPS = Data()

    public override func load() {
        initWebRTCIfNeeded()
        startLocalReceiver()
    }

    private func initWebRTCIfNeeded() {
        if !ReplayKitBridgePlugin.sslInitialized {
            RTCInitializeSSL()
            ReplayKitBridgePlugin.sslInitialized = true
        }
        if pcFactory == nil {
            let encoderFactory = RTCDefaultVideoEncoderFactory()
            let decoderFactory = RTCDefaultVideoDecoderFactory()
            let factory = RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)
            let source = factory.videoSource(forScreenCast: true)
            let capturer = RTCVideoCapturer(delegate: source)
            let track = factory.videoTrack(with: source, trackId: "screen0")
            self.pcFactory = factory
            self.videoSource = source
            self.videoCapturer = capturer
            self.localVideoTrack = track
        }
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
        let node = AVAudioSourceNode { _, _, _, audioBufferList -> OSStatus in
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
        conn.receive(minimumIncompleteLength: 5, maximumLength: 5) { [weak self] headerData, _, isComplete, error in
            guard let self = self, error == nil, let header = headerData, header.count == 5 else {
                if isComplete || error != nil { conn.cancel() }
                return
            }
            let packetType = header[0]
            let length = Int(header.subdata(in: 1..<5).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian })
            guard length > 0 && length < 20_000_000 else {
                conn.cancel()
                return
            }
            var payload = Data()
            payload.reserveCapacity(length)
            self.readExactPayload(packetType: packetType, length: length, accumulated: payload, on: conn)
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

            if packetType == 0x04 && buffer.count > 14 {
                self.decodeH264PacketToWebRTC(buffer)
            } else if packetType == 0x03 && buffer.count > 10 {
                self.feedRawVideoPacketToWebRTC(buffer)
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
                if self.pendingAudioPCM.count >= 8192 || (now - self.lastAudioFlushTime) >= 0.04 {
                    self.flushPendingAudio()
                }
            }

            self.readNextPacket(on: conn)
        }
    }

    private func decodeH264PacketToWebRTC(_ buffer: Data) {
        guard !peers.isEmpty, videoSource != nil, videoCapturer != nil else { return }
        guard buffer.count >= 14 else { return }

        let rotByte = buffer[8]
        let isKeyFrame = buffer[9] == 1
        let spsLen = Int(buffer.subdata(in: 10..<12).withUnsafeBytes { $0.load(as: UInt16.self).littleEndian })
        var offset = 12
        guard buffer.count >= offset + spsLen + 2 else { return }
        let sps = spsLen > 0 ? buffer.subdata(in: offset..<(offset + spsLen)) : Data()
        offset += spsLen

        let ppsLen = Int(buffer.subdata(in: offset..<(offset + 2)).withUnsafeBytes { $0.load(as: UInt16.self).littleEndian })
        offset += 2
        guard buffer.count > offset + ppsLen else { return }
        let pps = ppsLen > 0 ? buffer.subdata(in: offset..<(offset + ppsLen)) : Data()
        offset += ppsLen

        let avccData = buffer.subdata(in: offset..<buffer.count)
        guard !avccData.isEmpty else { return }

        if isKeyFrame && !sps.isEmpty && !pps.isEmpty && (decompressionSession == nil || sps != currentSPS || pps != currentPPS) {
            setupDecompressionSession(sps: sps, pps: pps)
        }
        guard let session = decompressionSession, let fmtDesc = videoFormatDesc else { return }

        var blockBuffer: CMBlockBuffer?
        let avccCount = avccData.count
        let status = avccData.withUnsafeBytes { rawPtr -> OSStatus in
            guard let base = rawPtr.baseAddress else { return -1 }
            var bb: CMBlockBuffer?
            let s1 = CMBlockBufferCreateWithMemoryBlock(
                structureAllocator: kCFAllocatorDefault,
                memoryBlock: nil,
                blockLength: avccCount,
                blockAllocator: kCFAllocatorDefault,
                customBlockSource: nil,
                offsetToData: 0,
                dataLength: avccCount,
                flags: 0,
                blockBufferOut: &bb
            )
            guard s1 == kCMBlockBufferNoErr, let created = bb else { return s1 }
            let s2 = CMBlockBufferReplaceDataBytes(with: base, blockBuffer: created, offsetIntoDestination: 0, dataLength: avccCount)
            blockBuffer = created
            return s2
        }
        guard status == noErr, let bb = blockBuffer else { return }

        var sampleBuffer: CMSampleBuffer?
        var sampleSize = avccCount
        let sbStatus = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: bb,
            formatDescription: fmtDesc,
            sampleCount: 1,
            sampleTimingEntryCount: 0,
            sampleTimingArray: nil,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        )
        guard sbStatus == noErr, let sb = sampleBuffer else { return }

        let refCon = UnsafeMutableRawPointer(bitPattern: Int(rotByte) + 1)
        VTDecompressionSessionDecodeFrame(
            session,
            sampleBuffer: sb,
            flags: [],
            frameRefcon: refCon,
            infoFlagsOut: nil
        )
    }

    private func setupDecompressionSession(sps: Data, pps: Data) {
        if let old = decompressionSession {
            VTDecompressionSessionWaitForAsynchronousFrames(old)
            VTDecompressionSessionInvalidate(old)
            decompressionSession = nil
        }
        videoFormatDesc = nil

        var newFmt: CMVideoFormatDescription?
        let status = sps.withUnsafeBytes { spsRaw in
            pps.withUnsafeBytes { ppsRaw -> OSStatus in
                guard let spsPtr = spsRaw.bindMemory(to: UInt8.self).baseAddress,
                      let ppsPtr = ppsRaw.bindMemory(to: UInt8.self).baseAddress else { return -1 }
                let pointers: [UnsafePointer<UInt8>] = [spsPtr, ppsPtr]
                let sizes: [Int] = [sps.count, pps.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault,
                    parameterSetCount: 2,
                    parameterSetPointers: pointers,
                    parameterSetSizes: sizes,
                    nalUnitHeaderLength: 4,
                    formatDescriptionOut: &newFmt
                )
            }
        }
        guard status == noErr, let fmtDesc = newFmt else { return }

        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:]
        ]
        var callback = VTDecompressionOutputCallbackRecord(
            decompressionOutputCallback: { (decompressionOutputRefCon, sourceFrameRefCon, status, _, imageBuffer, _, _) in
                guard status == noErr,
                      let refCon = decompressionOutputRefCon,
                      let imgBuf = imageBuffer else { return }
                let plugin = Unmanaged<ReplayKitBridgePlugin>.fromOpaque(refCon).takeUnretainedValue()
                let rotByte = UInt8(max(0, (sourceFrameRefCon.map { Int(bitPattern: $0) } ?? 1) - 1))
                plugin.pushDecodedPixelBuffer(imgBuf, rotByte: rotByte)
            },
            decompressionOutputRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        var session: VTDecompressionSession?
        let decStatus = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: fmtDesc,
            decoderSpecification: nil,
            imageBufferAttributes: attrs as CFDictionary,
            outputCallback: &callback,
            decompressionSessionOut: &session
        )
        if decStatus == noErr, let s = session {
            self.videoFormatDesc = fmtDesc
            self.decompressionSession = s
            self.currentSPS = sps
            self.currentPPS = pps
        }
    }

    fileprivate func pushDecodedPixelBuffer(_ pixelBuffer: CVPixelBuffer, rotByte: UInt8) {
        guard let source = videoSource, let capturer = videoCapturer else { return }
        let rotation: RTCVideoRotation
        switch rotByte {
        case 1: rotation = ._90
        case 2: rotation = ._180
        case 3: rotation = ._270
        default: rotation = ._0
        }
        let rtcBuf = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let tsNs = Int64(CACurrentMediaTime() * 1_000_000_000)
        let frame = RTCVideoFrame(buffer: rtcBuf, rotation: rotation, timeStampNs: tsNs)
        source.capturer(capturer, didCapture: frame)
    }

    private func feedRawVideoPacketToWebRTC(_ buffer: Data) {
        guard !peers.isEmpty, let source = videoSource, let capturer = videoCapturer else { return }

        let width = Int(buffer.subdata(in: 0..<4).withUnsafeBytes { $0.load(as: UInt32.self).littleEndian })
        let height = Int(buffer.subdata(in: 4..<8).withUnsafeBytes { $0.load(as: UInt32.self).littleEndian })
        let rotByte = buffer[8]
        let fmtByte = buffer[9]
        guard width > 0, height > 0 else { return }

        let osFmt: OSType = (fmtByte == 1)
            ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            : kCVPixelFormatType_32BGRA

        if pixelBufferPool == nil || poolWidth != width || poolHeight != height || poolFormat != osFmt {
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: osFmt,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:]
            ]
            var newPool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool)
            pixelBufferPool = newPool
            poolWidth = width
            poolHeight = height
            poolFormat = osFmt
        }

        guard let pool = pixelBufferPool else { return }
        var outPixelBuffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &outPixelBuffer) == kCVReturnSuccess,
              let pixelBuffer = outPixelBuffer else { return }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        buffer.withUnsafeBytes { rawBuf in
            guard let src = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            let payloadPtr = src + 10
            let payloadCount = buffer.count - 10

            if fmtByte == 1 {
                let ySize = width * height
                let uvSize = width * (height / 2)
                guard payloadCount >= ySize + uvSize,
                      let yDstBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
                      let uvDstBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) else { return }
                let yDstStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
                let uvDstStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
                let yDst = yDstBase.assumingMemoryBound(to: UInt8.self)
                let uvDst = uvDstBase.assumingMemoryBound(to: UInt8.self)

                for row in 0..<height {
                    memcpy(yDst + row * yDstStride, payloadPtr + row * width, width)
                }
                let uvSrc = payloadPtr + ySize
                for row in 0..<(height / 2) {
                    memcpy(uvDst + row * uvDstStride, uvSrc + row * width, width)
                }
            } else if fmtByte == 2 {
                let rowBytes = width * 4
                guard payloadCount >= rowBytes * height,
                      let dstBase = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
                let dstStride = CVPixelBufferGetBytesPerRow(pixelBuffer)
                let dst = dstBase.assumingMemoryBound(to: UInt8.self)
                for row in 0..<height {
                    memcpy(dst + row * dstStride, payloadPtr + row * rowBytes, rowBytes)
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

        let rotation: RTCVideoRotation
        switch rotByte {
        case 1: rotation = ._90
        case 2: rotation = ._180
        case 3: rotation = ._270
        default: rotation = ._0
        }

        let rtcBuf = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let tsNs = Int64(CACurrentMediaTime() * 1_000_000_000)
        let frame = RTCVideoFrame(buffer: rtcBuf, rotation: rotation, timeStampNs: tsNs)
        source.capturer(capturer, didCapture: frame)
    }

    private func flushPendingAudio() {
        guard !pendingAudioPCM.isEmpty else { return }
        var packet = Data(capacity: 6 + pendingAudioPCM.count)
        var srLE = pendingAudioSampleRate.littleEndian
        var chLE = pendingAudioChannels.littleEndian
        packet.append(Data(bytes: &srLE, count: 4))
        packet.append(Data(bytes: &chLE, count: 2))
        packet.append(pendingAudioPCM)
        pendingAudioPCM.removeAll(keepingCapacity: true)
        lastAudioFlushTime = CACurrentMediaTime()

        webrtcQueue.async { [weak self] in
            guard let self = self else { return }
            let rtcBuf = RTCDataBuffer(data: packet, isBinary: true)
            for peer in self.peers.values {
                if let dc = peer.audioDataChannel, dc.readyState == .open {
                    dc.sendData(rtcBuf)
                }
            }
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
        initWebRTCIfNeeded()
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
        webrtcQueue.async { [weak self] in
            self?.peers.values.forEach { $0.pc.close() }
            self?.peers.removeAll()
        }
        stopBackgroundKeepAlive()
        DispatchQueue.main.async { [weak self] in
            self?.pickerView?.removeFromSuperview()
            self?.pickerView = nil
            call.resolve(["stopped": true])
        }
    }

    @objc func createPeerOffer(_ call: CAPPluginCall) {
        guard let viewerUid = call.getString("viewerUid"), !viewerUid.isEmpty else {
            call.reject("Missing viewerUid")
            return
        }
        initWebRTCIfNeeded()
        let iceList = call.getArray("iceServers", [String: Any].self) ?? []
        let maxBitrate = call.getInt("maxBitrate") ?? 6_000_000
        let maxFramerate = call.getInt("maxFramerate") ?? 60

        webrtcQueue.async { [weak self] in
            guard let self = self, let factory = self.pcFactory, let videoTrack = self.localVideoTrack else {
                call.reject("WebRTC not initialized")
                return
            }

            if let existing = self.peers.removeValue(forKey: viewerUid) {
                existing.pc.close()
            }

            var rtcServers: [RTCIceServer] = []
            for item in iceList {
                var urls: [String] = []
                if let u = item["urls"] as? String {
                    urls = [u]
                } else if let arr = item["urls"] as? [String] {
                    urls = arr
                }
                guard !urls.isEmpty else { continue }
                let username = item["username"] as? String
                let credential = item["credential"] as? String
                if let u = username, let c = credential {
                    rtcServers.append(RTCIceServer(urlStrings: urls, username: u, credential: c))
                } else {
                    rtcServers.append(RTCIceServer(urlStrings: urls))
                }
            }
            if rtcServers.isEmpty {
                rtcServers.append(RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]))
            }

            let config = RTCConfiguration()
            config.iceServers = rtcServers
            config.sdpSemantics = .unifiedPlan
            config.continualGatheringPolicy = .gatherContinually

            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: nil) else {
                call.reject("Failed to create RTCPeerConnection")
                return
            }

            let peer = NativeScreenPeer(viewerUid: viewerUid, pc: pc, plugin: self)
            self.peers[viewerUid] = peer

            let dcConfig = RTCDataChannelConfiguration()
            dcConfig.isOrdered = false
            dcConfig.maxRetransmits = 0
            peer.audioDataChannel = pc.dataChannel(forLabel: "screen_audio", configuration: dcConfig)

            if let sender = pc.add(videoTrack, streamIds: ["cineverse_screen"]) {
                let params = sender.parameters
                if let enc = params.encodings.first {
                    enc.minBitrateBps = NSNumber(value: max(2_000_000, maxBitrate / 3))
                    enc.maxBitrateBps = NSNumber(value: maxBitrate)
                    enc.maxFramerate = NSNumber(value: maxFramerate)
                }
                params.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
                sender.parameters = params
            }

            let offerConstraints = RTCMediaConstraints(
                mandatoryConstraints: [
                    "OfferToReceiveAudio": "false",
                    "OfferToReceiveVideo": "false"
                ],
                optionalConstraints: nil
            )
            pc.offer(for: offerConstraints) { sdp, error in
                guard let sdp = sdp, error == nil else {
                    call.reject("Failed to create offer: \(error?.localizedDescription ?? "unknown")")
                    return
                }
                // Boost initial WebRTC bitrate so stream is razor sharp from frame #1
                let boostedSdpStr = sdp.sdp.replacingOccurrences(
                    of: "a=fmtp:(\\d+) (.*)",
                    with: "a=fmtp:$1 $2;x-google-start-bitrate=5000;x-google-min-bitrate=2000;x-google-max-bitrate=8000",
                    options: .regularExpression
                )
                let boostedSdp = RTCSessionDescription(type: sdp.type, sdp: boostedSdpStr)
                pc.setLocalDescription(boostedSdp) { err in
                    if let err = err {
                        // Fallback to unmodified SDP if fmtp rewrite fails
                        pc.setLocalDescription(sdp) { err2 in
                            if let err2 = err2 {
                                call.reject("Failed to set local description: \(err2.localizedDescription)")
                                return
                            }
                            call.resolve([
                                "sdp": [
                                    "type": RTCSessionDescription.string(for: sdp.type),
                                    "sdp": sdp.sdp
                                ]
                            ])
                        }
                        return
                    }
                    call.resolve([
                        "sdp": [
                            "type": RTCSessionDescription.string(for: boostedSdp.type),
                            "sdp": boostedSdp.sdp
                        ]
                    ])
                }
            }
        }
    }

    @objc func setRemoteAnswer(_ call: CAPPluginCall) {
        guard let viewerUid = call.getString("viewerUid"),
              let sdpDict = call.getObject("sdp"),
              let sdpStr = sdpDict["sdp"] as? String else {
            call.reject("Missing answer payload")
            return
        }
        webrtcQueue.async { [weak self] in
            guard let peer = self?.peers[viewerUid] else {
                call.resolve(["ok": false])
                return
            }
            let desc = RTCSessionDescription(type: .answer, sdp: sdpStr)
            peer.pc.setRemoteDescription(desc) { err in
                if err == nil {
                    self?.webrtcQueue.async {
                        let pending = peer.pendingIce
                        peer.pendingIce.removeAll()
                        for cand in pending {
                            peer.pc.add(cand) { _ in }
                        }
                    }
                }
                call.resolve(["ok": err == nil])
            }
        }
    }

    @objc func addIceCandidate(_ call: CAPPluginCall) {
        guard let viewerUid = call.getString("viewerUid"),
              let candDict = call.getObject("candidate"),
              let sdp = candDict["candidate"] as? String else {
            call.resolve(["ok": false])
            return
        }
        let sdpMid = candDict["sdpMid"] as? String
        let mLine = (candDict["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
        let cand = RTCIceCandidate(sdp: sdp, sdpMLineIndex: mLine, sdpMid: sdpMid)

        webrtcQueue.async { [weak self] in
            guard let peer = self?.peers[viewerUid] else {
                call.resolve(["ok": false])
                return
            }
            if peer.pc.remoteDescription != nil {
                peer.pc.add(cand) { _ in }
            } else {
                peer.pendingIce.append(cand)
            }
            call.resolve(["ok": true])
        }
    }

    @objc func closePeer(_ call: CAPPluginCall) {
        guard let viewerUid = call.getString("viewerUid") else {
            call.resolve(["ok": true])
            return
        }
        webrtcQueue.async { [weak self] in
            if let peer = self?.peers.removeValue(forKey: viewerUid) {
                peer.pc.close()
            }
            call.resolve(["ok": true])
        }
    }

    @objc func closeAllPeers(_ call: CAPPluginCall) {
        webrtcQueue.async { [weak self] in
            self?.peers.values.forEach { $0.pc.close() }
            self?.peers.removeAll()
            call.resolve(["ok": true])
        }
    }
}
