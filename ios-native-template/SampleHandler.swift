import ReplayKit
import Network
import CoreMedia
import CoreVideo
import VideoToolbox
import AudioToolbox
import ImageIO

private let vtCompressionCallback: VTCompressionOutputCallback = { (
    outputCallbackRefCon,
    sourceFrameRefCon,
    status,
    _,
    sampleBuffer
) in
    guard status == noErr,
          let refCon = outputCallbackRefCon,
          let sb = sampleBuffer else { return }
    let handler = Unmanaged<SampleHandler>.fromOpaque(refCon).takeUnretainedValue()
    let rotByte = UInt8(max(0, (sourceFrameRefCon.map { Int(bitPattern: $0) } ?? 1) - 1))
    handler.handleEncodedSampleBuffer(sb, rotation: rotByte)
}

class SampleHandler: RPBroadcastSampleHandler {
    private var connection: NWConnection?
    private let sendQueue = DispatchQueue(label: "com.cineverse.lotte.replaykit.sender", qos: .userInteractive)
    private var lastSentTime: CFTimeInterval = 0
    private var isBroadcastActive = false

    private var compressionSession: VTCompressionSession?
    private var transferSessionObj: AnyObject?
    private var scaledPool: CVPixelBufferPool?
    private var encWidth: Int = 0
    private var encHeight: Int = 0
    private var frameIndex: Int64 = 0

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
                self.sendQueue.asyncAfter(deadline: .now() + 0.5) {
                    self.connectToApp()
                }
            }
        }
        conn.start(queue: sendQueue)
        self.connection = conn
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        isBroadcastActive = false
        sendQueue.async { [weak self] in
            self?.teardownEncoder()
        }
        connection?.cancel()
        connection = nil
    }

    private func teardownEncoder() {
        if let session = compressionSession {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
            compressionSession = nil
        }
        if #available(iOS 16.0, *), let obj = transferSessionObj {
            VTPixelTransferSessionInvalidate(obj as! VTPixelTransferSession)
        }
        transferSessionObj = nil
        scaledPool = nil
        encWidth = 0
        encHeight = 0
    }

    private func mapOrientation(_ cg: CGImagePropertyOrientation) -> UInt8 {
        switch cg {
        case .left, .leftMirrored:   return 1 // 90 deg CW
        case .down, .downMirrored:   return 2 // 180 deg
        case .right, .rightMirrored: return 3 // 270 deg CW
        default:                     return 0 // 0 deg
        }
    }

    private func targetFrameInterval() -> CFTimeInterval {
        switch ProcessInfo.processInfo.thermalState {
        case .critical: return 1.0 / 20.0
        case .serious:  return 1.0 / 30.0
        default:        return 1.0 / 60.0
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard let conn = connection, conn.state == .ready else { return }

        switch sampleBufferType {
        case .video:
            let now = CACurrentMediaTime()
            if (now - lastSentTime) < targetFrameInterval() { return }
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

            var rotByte: UInt8 = 0
            if let orientationAttachment = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
               let parsed = CGImagePropertyOrientation(rawValue: orientationAttachment.uint32Value) {
                rotByte = mapOrientation(parsed)
            }
            lastSentTime = now

            sendQueue.async { [weak self] in
                guard let self = self, self.isBroadcastActive else { return }
                autoreleasepool {
                    self.encodeFrameHardware(pixelBuffer: pixelBuffer, rotation: rotByte)
                }
            }

        case .audioApp:
            sendQueue.async { [weak self] in
                guard let self = self, self.isBroadcastActive else { return }
                autoreleasepool {
                    self.sendAudioSampleBuffer(sampleBuffer, on: conn)
                }
            }

        default:
            break
        }
    }

    private func setupEncoder(width: Int, height: Int) -> Bool {
        teardownEncoder()

        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: vtCompressionCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &session
        )
        guard status == noErr, let comp = session else { return false }

        VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 60 as CFNumber)
        VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 60 as CFNumber)
        VTSessionSetProperty(comp, key: kVTCompressionPropertyKey_AverageBitRate, value: 6_000_000 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(comp)

        if #available(iOS 16.0, *) {
            var transfer: VTPixelTransferSession?
            VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &transfer)
            if let t = transfer {
                VTSessionSetProperty(t, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Trim)
                self.transferSessionObj = t as AnyObject
            }
        }

        let poolAttrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:]
        ]
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, poolAttrs as CFDictionary, &pool)

        self.compressionSession = comp
        self.scaledPool = pool
        self.encWidth = width
        self.encHeight = height
        return true
    }

    private func encodeFrameHardware(pixelBuffer: CVPixelBuffer, rotation: UInt8) {
        let srcW = CVPixelBufferGetWidth(pixelBuffer)
        let srcH = CVPixelBufferGetHeight(pixelBuffer)
        guard srcW > 0, srcH > 0 else { return }

        let maxDim = 1600
        let longest = max(srcW, srcH)
        let needsScale = longest > maxDim
        let dstW = (needsScale ? (srcW * maxDim / longest) : srcW) & ~1
        let dstH = (needsScale ? (srcH * maxDim / longest) : srcH) & ~1
        guard dstW > 0, dstH > 0 else { return }

        if compressionSession == nil || encWidth != dstW || encHeight != dstH {
            guard setupEncoder(width: dstW, height: dstH) else { return }
        }
        guard let session = compressionSession else { return }

        var inputBuffer: CVPixelBuffer = pixelBuffer
        if #available(iOS 16.0, *), needsScale,
           let obj = transferSessionObj,
           let pool = scaledPool {
            let transfer = obj as! VTPixelTransferSession
            var outBuf: CVPixelBuffer?
            if CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &outBuf) == kCVReturnSuccess,
               let dst = outBuf,
               VTPixelTransferSessionTransferImage(transfer, from: pixelBuffer, to: dst) == noErr {
                inputBuffer = dst
            }
        }

        frameIndex += 1
        let pts = CMTime(value: frameIndex, timescale: 60)
        let refCon = UnsafeMutableRawPointer(bitPattern: Int(rotation) + 1)
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: inputBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: nil,
            sourceFrameRefcon: refCon,
            infoFlagsOut: nil
        )
    }

    fileprivate func handleEncodedSampleBuffer(_ sampleBuffer: CMSampleBuffer, rotation: UInt8) {
        guard let conn = connection, conn.state == .ready,
              let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var isKeyFrame = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as NSArray?,
           let first = attachments.firstObject as? NSDictionary,
           let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            isKeyFrame = !notSync
        }

        var spsData = Data()
        var ppsData = Data()
        if isKeyFrame, let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var spsPtr: UnsafePointer<UInt8>?
            var spsSize: Int = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmtDesc, parameterSetIndex: 0, parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
               let sp = spsPtr, spsSize > 0 {
                spsData = Data(bytes: sp, count: spsSize)
            }
            var ppsPtr: UnsafePointer<UInt8>?
            var ppsSize: Int = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmtDesc, parameterSetIndex: 1, parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
               let pp = ppsPtr, ppsSize > 0 {
                ppsData = Data(bytes: pp, count: ppsSize)
            }
        }

        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLength, dataPointerOut: &dataPointer) == noErr,
              let ptr = dataPointer, totalLength > 0 else { return }

        // Packet 0x04: [0x04][4B len BE][4B w LE][4B h LE][1B rot][1B key][2B spsLen LE][sps][2B ppsLen LE][pps][AVCC bytes]
        let payloadLen = 14 + spsData.count + ppsData.count + totalLength
        var packet = Data(count: 5 + payloadLen)
        packet.withUnsafeMutableBytes { rawBuf in
            guard let dst = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            dst[0] = 0x04
            var lenBE = UInt32(payloadLen).bigEndian
            memcpy(dst + 1, &lenBE, 4)

            var wLE = UInt32(encWidth).littleEndian
            var hLE = UInt32(encHeight).littleEndian
            memcpy(dst + 5, &wLE, 4)
            memcpy(dst + 9, &hLE, 4)
            dst[13] = rotation
            dst[14] = isKeyFrame ? 1 : 0

            var spsLenLE = UInt16(spsData.count).littleEndian
            memcpy(dst + 15, &spsLenLE, 2)
            var offset = 17
            if !spsData.isEmpty {
                spsData.withUnsafeBytes { s in
                    if let sb = s.baseAddress { memcpy(dst + offset, sb, spsData.count) }
                }
                offset += spsData.count
            }

            var ppsLenLE = UInt16(ppsData.count).littleEndian
            memcpy(dst + offset, &ppsLenLE, 2)
            offset += 2
            if !ppsData.isEmpty {
                ppsData.withUnsafeBytes { p in
                    if let pb = p.baseAddress { memcpy(dst + offset, pb, ppsData.count) }
                }
                offset += ppsData.count
            }

            memcpy(dst + offset, ptr, totalLength)
        }

        conn.send(content: packet, completion: .contentProcessed { _ in })
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
