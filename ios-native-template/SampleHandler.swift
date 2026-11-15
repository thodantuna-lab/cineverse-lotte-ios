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
        case .left, .leftMirrored:   return 1 // 90 deg CW
        case .down, .downMirrored:   return 2 // 180 deg
        case .right, .rightMirrored: return 3 // 270 deg CW
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
            if isSendingVideo || (now - lastSentTime) < (1.0 / 30.0) { return }
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

        // Scale proportionally so longest side <= 1280px (smooth TikTok/Game + crisp 720p H.264)
        let maxDim = 1280
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
                    vImageScale_Planar8(&srcYBuf, &dstYBuf, nil, vImage_Flags(kvImageNoFlags))

                    var srcUVBuf = vImage_Buffer(data: uvBase, height: vImagePixelCount(srcH / 2), width: vImagePixelCount(srcW / 2), rowBytes: uvStride)
                    var dstUVBuf = vImage_Buffer(data: uvDst, height: vImagePixelCount(dstH / 2), width: vImagePixelCount(dstW / 2), rowBytes: dstW)
                    vImageScale_CbCr8(&srcUVBuf, &dstUVBuf, nil, vImage_Flags(kvImageNoFlags))
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

        var sizeNeeded: Int = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &sizeNeeded,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: nil
        )
        guard sizeNeeded > 0 else { return }

        let ablRaw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { ablRaw.deallocate() }
        let ablPtr = ablRaw.assumingMemoryBound(to: AudioBufferList.self)

        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: ablPtr,
            bufferListSize: sizeNeeded,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let buffers = UnsafeMutableAudioBufferListPointer(ablPtr)
        guard !buffers.isEmpty else { return }

        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isBigEndian = (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
        let isNonInterleaved = buffers.count >= 2
        let channels = isNonInterleaved ? 2 : max(1, min(2, Int(asbd.mChannelsPerFrame)))
        let sampleRate = UInt32(asbd.mSampleRate > 0 ? asbd.mSampleRate : 44100)

        var pcm16Data: Data?

        if isNonInterleaved, let lRaw = buffers[0].mData, let rRaw = buffers[1].mData,
           buffers[0].mDataByteSize > 0, buffers[1].mDataByteSize > 0 {
            if isFloat && asbd.mBitsPerChannel == 32 {
                let frameCount = min(Int(buffers[0].mDataByteSize), Int(buffers[1].mDataByteSize)) / 4
                let lPtr = lRaw.bindMemory(to: Float32.self, capacity: frameCount)
                let rPtr = rRaw.bindMemory(to: Float32.self, capacity: frameCount)
                var out = Data(count: frameCount * 4)
                out.withUnsafeMutableBytes { dstBytes in
                    let dst = dstBytes.bindMemory(to: Int16.self)
                    for i in 0..<frameCount {
                        let lVal = max(-1.0, min(1.0, lPtr[i]))
                        let rVal = max(-1.0, min(1.0, rPtr[i]))
                        dst[i * 2] = Int16(lVal * 32767.0).littleEndian
                        dst[i * 2 + 1] = Int16(rVal * 32767.0).littleEndian
                    }
                }
                pcm16Data = out
            } else if !isFloat && asbd.mBitsPerChannel == 16 {
                let frameCount = min(Int(buffers[0].mDataByteSize), Int(buffers[1].mDataByteSize)) / 2
                let lPtr = lRaw.bindMemory(to: UInt16.self, capacity: frameCount)
                let rPtr = rRaw.bindMemory(to: UInt16.self, capacity: frameCount)
                var out = Data(count: frameCount * 4)
                out.withUnsafeMutableBytes { dstBytes in
                    let dst = dstBytes.bindMemory(to: UInt16.self)
                    for i in 0..<frameCount {
                        dst[i * 2] = isBigEndian ? lPtr[i].byteSwapped : lPtr[i]
                        dst[i * 2 + 1] = isBigEndian ? rPtr[i].byteSwapped : rPtr[i]
                    }
                }
                pcm16Data = out
            }
        } else if let rawPtr = buffers[0].mData, buffers[0].mDataByteSize > 0 {
            let byteSize = Int(buffers[0].mDataByteSize)
            if isFloat && asbd.mBitsPerChannel == 32 {
                let count = byteSize / 4
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
                let count = byteSize / 2
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
                    pcm16Data = Data(bytes: rawPtr, count: byteSize)
                }
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
