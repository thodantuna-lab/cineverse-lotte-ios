import ReplayKit
import Network
import CoreImage
import CoreMedia
import AudioToolbox
import UIKit

class SampleHandler: RPBroadcastSampleHandler {
    private var connection: NWConnection?
    private let sendQueue = DispatchQueue(label: "com.cineverse.lotte.replaykit.sender", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "com.cineverse.lotte.replaykit.audio", qos: .userInteractive)
    private let ciContext = CIContext(options: [
        .useSoftwareRenderer: false,
        .cacheIntermediates: false
    ])
    private var lastSentTime: CFTimeInterval = 0
    private var isSendingVideo = false

    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 49321)
        let conn = NWConnection(to: endpoint, using: .tcp)
        conn.start(queue: sendQueue)
        self.connection = conn
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        connection?.cancel()
        connection = nil
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard let conn = connection, conn.state == .ready else { return }

        switch sampleBufferType {
        case .video:
            let now = CACurrentMediaTime()
            if isSendingVideo || (now - lastSentTime) < (1.0 / 30.0) { return }
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

            lastSentTime = now
            isSendingVideo = true

            sendQueue.async { [weak self] in
                guard let self = self else { return }
                var didDispatchSend = false
                autoreleasepool {
                    let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
                    let extent = ciImage.extent
                    let maxDim: CGFloat = 1600.0
                    let longest = max(extent.width, extent.height)
                    let scale = longest > maxDim ? (maxDim / longest) : 1.0
                    let scaled = scale < 1.0
                        ? ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                        : ciImage

                    guard let cgImage = self.ciContext.createCGImage(scaled, from: scaled.extent) else { return }
                    let uiImage = UIImage(cgImage: cgImage)
                    guard let jpegData = uiImage.jpegData(compressionQuality: 0.78) else { return }

                    var packet = Data(capacity: 5 + jpegData.count)
                    packet.append(0x01) // 0x01 = Video JPEG frame
                    var len = UInt32(jpegData.count).bigEndian
                    packet.append(Data(bytes: &len, count: 4))
                    packet.append(jpegData)

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
            audioQueue.async { [weak self] in
                guard let self = self else { return }
                autoreleasepool {
                    self.sendAudioSampleBuffer(sampleBuffer, on: conn)
                }
            }

        default:
            break
        }
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

        // Payload: [4-byte sampleRate LE][2-byte channels LE][Int16 LE PCM]
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
