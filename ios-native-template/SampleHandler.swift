import ReplayKit
import Network
import CoreImage
import UIKit

class SampleHandler: RPBroadcastSampleHandler {
    private var connection: NWConnection?
    private let sendQueue = DispatchQueue(label: "com.cineverse.lotte.replaykit.sender")
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private var lastSentTime: CFTimeInterval = 0
    private var isSending = false

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
        guard sampleBufferType == .video else { return }
        let now = CACurrentMediaTime()
        if isSending || (now - lastSentTime) < (1.0 / 24.0) { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let conn = connection, conn.state == .ready else { return }

        lastSentTime = now
        isSending = true

        sendQueue.async { [weak self] in
            guard let self = self else { return }
            defer { self.isSending = false }

            let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            let extent = ciImage.extent
            let maxWidth: CGFloat = 1280.0
            let scale = extent.width > maxWidth ? (maxWidth / extent.width) : 1.0
            let scaled = scale < 1.0 ? ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) : ciImage

            guard let cgImage = self.ciContext.createCGImage(scaled, from: scaled.extent) else { return }
            let uiImage = UIImage(cgImage: cgImage)
            guard let jpegData = uiImage.jpegData(compressionQuality: 0.62) else { return }

            var len = UInt32(jpegData.count).bigEndian
            var packet = Data(bytes: &len, count: 4)
            packet.append(jpegData)
            conn.send(content: packet, completion: .contentProcessed({ _ in }))
        }
    }
}
