import ReplayKit
import Network
import CoreMedia
import CoreVideo
import AudioToolbox
import ImageIO
import Accelerate

class SampleHandler: RPBroadcastSampleHandler {
    private var connection: NWConnection?
    private let sendQueue = DispatchQueue(label: "com.cineverse.lotte.replaykit.sender", qos: .userInteractive)
    private var lastSentTime: CFTimeInterval = 0
    private var isSendingVideo = false
    private var videoSendStartedAt: CFTimeInterval = 0
    private var isBroadcastActive = false

    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        isBroadcastActive = true
        connectToApp()
    }

    private func connectToApp() {
        guard isBroadcastActive else { return }
        connection?.cancel()
        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 49321)
        let conn = NWConnection(to: endpoint, using: .tcp)
        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self, self.isBroadcastActive else { return }
            if case .failed = state {
                self.isSendingVideo = false
                self.sendQueue.asyncAfter(deadline: .now() + 0.5) {
                    self.connectToApp()
                }
            } else if case .waiting = state {
                self.isSendingVideo = false
            }
        }
        conn.start(queue: sendQueue)
        self.connection = conn
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        isBroadcastActive = false
        connection?.cancel()
        connection = nil
    }

    private func mapOrientation(_ cg: CGImagePropertyOrientation) -> UInt8 {
        switch cg {
        case .right, .rightMirrored: return 1 // 90 deg
        case .down, .downMirrored:   return 2 // 180 deg
        case .left, .leftMirrored:   return 3 // 270 deg
        default:                     return 0 // 0 deg
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard let conn = connection, conn.state == .ready else { return }

        switch sampleBufferType {
        case .video:
            let now = CACurrentMediaTime()
            if isSendingVideo && (now - videoSendStartedAt) > 0.5 {
                isSendingVideo = false
            }
            if isSendingVideo || (now - lastSentTime) < (1.0 / 60.0) { return }
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

            var rotByte: UInt8 = 0
            if let orientationAttachment = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
               let parsed = CGImagePropertyOrientation(rawValue: orientationAttachment.uint32Value) {
                rotByte = mapOrientation(parsed)
            }

            lastSentTime = now
            videoSendStartedAt = now
            isSendingVideo = true

            // Retain pixelBuffer safely across async dispatch
            sendQueue.async { [weak self] in
                guard let self = self else { return }
                var didDispatchSend = false
                autoreleasepool {
                    guard let packet = self.buildRawVideoPacket(pixelBuffer: pixelBuffer, rotation: rotByte) else { return }
                    didDispatchSend = true
                    conn.send(content: packet, completion: .contentProcessed { [weak self] _ in
                        self?.isSendingVideo = false
                    })
                }
                if !didDispatchSend {
                    self.isSendingVideo = false
                }
            }

        case .audioApp:
            sendQueue.async { [weak self] in
                guard let self = self else { return }
                autoreleasepool {
                    self.sendAudioSampleBuffer(sampleBuffer, on: conn)
                }
            }

        default:
            break
        }
    }

    private func buildRawVideoPacket(pixelBuffer: CVPixelBuffer, rotation: UInt8) -> Data? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let srcW = CVPixelBufferGetWidth(pixelBuffer)
        let srcH = CVPixelBufferGetHeight(pixelBuffer)
        guard srcW > 0, srcH > 0 else { return nil }

        let fmt = CVPixelBufferGetPixelFormatType(pixelBuffer)
        let isNV12 = (fmt == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange || fmt == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)

        // Scale proportionally so longest side <= 1920px (e.g. 1290x2796 -> 886x1920 Full HD crispness)
        let maxDim = 1920
        let longest = max(srcW, srcH)
        let needsScale = longest > maxDim
        let dstW = (needsScale ? (srcW * maxDim / longest) : srcW) & ~1
        let dstH = (needsScale ? (srcH * maxDim / longest) : srcH) & ~1
        guard dstW > 0, dstH > 0 else { return nil }

        if isNV12 && CVPixelBufferGetPlaneCount(pixelBuffer) >= 2 {
            guard let yBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
                  let uvBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) else { return nil }
            let yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
            let uvStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)

            let ySize = dstW * dstH
            let uvSize = dstW * (dstH / 2)
            let payloadLen = 10 + ySize + uvSize

            var packet = Data(count: 5 + payloadLen)
            packet.withUnsafeMutableBytes { rawBuf in
                guard let dst = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                dst[0] = 0x03 // 0x03 = Raw Video frame
                var lenBE = UInt32(payloadLen).bigEndian
                memcpy(dst + 1, &lenBE, 4)

                var wLE = UInt32(dstW).littleEndian
                var hLE = UInt32(dstH).littleEndian
                memcpy(dst + 5, &wLE, 4)
                memcpy(dst + 9, &hLE, 4)
                dst[13] = rotation
                dst[14] = 1 // 1 = NV12

                let yDst = dst + 15
                let uvDst = dst + 15 + ySize

                if !needsScale {
                    let ySrc = yBase.assumingMemoryBound(to: UInt8.self)
                    let uvSrc = uvBase.assumingMemoryBound(to: UInt8.self)
                    for row in 0..<dstH {
                        memcpy(yDst + row * dstW, ySrc + row * yStride, dstW)
                    }
                    for row in 0..<(dstH / 2) {
                        memcpy(uvDst + row * dstW, uvSrc + row * uvStride, dstW)
                    }
                } else {
                    var srcYBuf = vImage_Buffer(data: yBase, height: vImagePixelCount(srcH), width: vImagePixelCount(srcW), rowBytes: yStride)
                    var dstYBuf = vImage_Buffer(data: yDst, height: vImagePixelCount(dstH), width: vImagePixelCount(dstW), rowBytes: dstW)
                    vImageScale_Planar8(&srcYBuf, &dstYBuf, nil, vImage_Flags(kvImageHighQualityResampling))

                    var srcUVBuf = vImage_Buffer(data: uvBase, height: vImagePixelCount(srcH / 2), width: vImagePixelCount(srcW / 2), rowBytes: uvStride)
                    var dstUVBuf = vImage_Buffer(data: uvDst, height: vImagePixelCount(dstH / 2), width: vImagePixelCount(dstW / 2), rowBytes: dstW)
                    vImageScale_CbCr8(&srcUVBuf, &dstUVBuf, nil, vImage_Flags(kvImageHighQualityResampling))
                }
            }
            return packet
        } else if fmt == kCVPixelFormatType_32BGRA, let base = CVPixelBufferGetBaseAddress(pixelBuffer) {
            let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
            let rowBytes = dstW * 4
            let pixelBytes = rowBytes * dstH
            let payloadLen = 10 + pixelBytes

            var packet = Data(count: 5 + payloadLen)
            packet.withUnsafeMutableBytes { rawBuf in
                guard let dst = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                dst[0] = 0x03
                var lenBE = UInt32(payloadLen).bigEndian
                memcpy(dst + 1, &lenBE, 4)

                var wLE = UInt32(dstW).littleEndian
                var hLE = UInt32(dstH).littleEndian
                memcpy(dst + 5, &wLE, 4)
                memcpy(dst + 9, &hLE, 4)
                dst[13] = rotation
                dst[14] = 2 // 2 = BGRA

                let pDst = dst + 15
                if !needsScale {
                    let src = base.assumingMemoryBound(to: UInt8.self)
                    for row in 0..<dstH {
                        memcpy(pDst + row * rowBytes, src + row * stride, rowBytes)
                    }
                } else {
                    var srcBuf = vImage_Buffer(data: base, height: vImagePixelCount(srcH), width: vImagePixelCount(srcW), rowBytes: stride)
                    var dstBuf = vImage_Buffer(data: pDst, height: vImagePixelCount(dstH), width: vImagePixelCount(dstW), rowBytes: rowBytes)
                    vImageScale_ARGB8888(&srcBuf, &dstBuf, nil, vImage_Flags(kvImageHighQualityResampling))
                }
            }
            return packet
        }

        return nil
    }

    private func sendAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer, on conn: NWConnection) {
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }
        let asbd = asbdPtr.pointee
        guard asbd.mFormatID == kAudioFormatLinearPCM else { return }

        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 0, mDataByteSize: 0, mData: nil)
        )
        let listSize = MemoryLayout<AudioBufferList>.size
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: listSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let buf = audioBufferList.mBuffers
        guard let rawPtr = buf.mData, buf.mDataByteSize > 0 else { return }

        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isBigEndian = (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
        let channels = max(1, min(2, Int(asbd.mChannelsPerFrame)))
        let sampleRate = UInt32(asbd.mSampleRate > 0 ? asbd.mSampleRate : 44100)

        var pcm16Data: Data?
        if isFloat && asbd.mBitsPerChannel == 32 {
            let count = Int(buf.mDataByteSize) / 4
            let floatPtr = rawPtr.bindMemory(to: Float32.self, capacity: count)
            var out = Data(count: count * 2)
            out.withUnsafeMutableBytes { dstBytes in
                let dst = dstBytes.bindMemory(to: Int16.self)
                for i in 0..<count {
                    let clamped = max(-1.0, min(1.0, floatPtr[i]))
                    dst[i] = Int16(clamped * 32767.0).littleEndian
                }
            }
            pcm16Data = out
        } else if !isFloat && asbd.mBitsPerChannel == 16 {
            let count = Int(buf.mDataByteSize) / 2
            let srcPtr = rawPtr.bindMemory(to: UInt16.self, capacity: count)
            if isBigEndian {
                var out = Data(count: count * 2)
                out.withUnsafeMutableBytes { dstBytes in
                    let dst = dstBytes.bindMemory(to: UInt16.self)
                    for i in 0..<count {
                        dst[i] = srcPtr[i].byteSwapped
                    }
                }
                pcm16Data = out
            } else {
                pcm16Data = Data(bytes: rawPtr, count: Int(buf.mDataByteSize))
            }
        }

        guard let pcm = pcm16Data, !pcm.isEmpty else { return }

        let payloadLen = 6 + pcm.count
        var packet = Data(capacity: 5 + payloadLen)
        packet.append(0x02) // 0x02 = Audio PCM frame
        var lenBE = UInt32(payloadLen).bigEndian
        packet.append(Data(bytes: &lenBE, count: 4))
        var srLE = sampleRate.littleEndian
        packet.append(Data(bytes: &srLE, count: 4))
        var chLE = UInt16(channels).littleEndian
        packet.append(Data(bytes: &chLE, count: 2))
        packet.append(pcm)

        conn.send(content: packet, completion: .contentProcessed { _ in })
    }
}
