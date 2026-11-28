import Darwin
import Foundation

/// Buffered, bounded newline-delimited reader for the helper's Unix domain socket.
///
/// Replaces the 1-byte-at-a-time `read(fd, &byte, 1)` loop (P-80) with 8 KB chunked
/// reads + `EINTR` retry, and enforces strict line length and timeout bounds (S-51)
/// so a misbehaving or slow peer cannot OOM or stall a worker thread.
public final class BufferedSocketLineReader {
    public enum ReadResult: Equatable {
        case line(String)
        case eof
        case exceededMaxBytes
        case timedOut
        case invalidUTF8
        case ioError(Int32)
    }

    public enum WaitOutcome: Equatable {
        case ready
        case timedOut
        case interrupted
        case error(Int32)
    }

    public static let defaultChunkSize = 8_192
    public static let defaultMaxLineBytes = 24 * 1024 * 1024
    public static let defaultInitialIdleTimeoutMs: Int32 = 5_000
    public static let defaultPartialLineTimeoutMs: Int32 = 30_000

    private let chunkSize: Int
    private let maxLineBytes: Int
    private let waitReadable: (Int32) -> WaitOutcome
    private let readChunk: (UnsafeMutablePointer<UInt8>, Int) -> (count: Int, err: Int32)
    private let nowMs: () -> Int64

    private var buffer: [UInt8] = []
    private var cursor: Int = 0
    private var reachedEOF = false

    public convenience init(
        fileDescriptor fd: Int32,
        chunkSize: Int = BufferedSocketLineReader.defaultChunkSize,
        maxLineBytes: Int = BufferedSocketLineReader.defaultMaxLineBytes
    ) {
        self.init(
            chunkSize: chunkSize,
            maxLineBytes: maxLineBytes,
            waitReadable: { timeoutMs in
                var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                let rc = poll(&pfd, 1, timeoutMs)
                if rc > 0 {
                    return .ready
                }
                if rc == 0 {
                    return .timedOut
                }
                let err = errno
                if err == EINTR {
                    return .interrupted
                }
                return .error(err)
            },
            readChunk: { ptr, capacity in
                let count = Darwin.read(fd, ptr, capacity)
                return (count, count < 0 ? errno : 0)
            },
            nowMs: {
                var ts = timespec()
                clock_gettime(CLOCK_MONOTONIC, &ts)
                return Int64(ts.tv_sec) * 1_000 + Int64(ts.tv_nsec) / 1_000_000
            }
        )
    }

    public init(
        chunkSize: Int = BufferedSocketLineReader.defaultChunkSize,
        maxLineBytes: Int = BufferedSocketLineReader.defaultMaxLineBytes,
        waitReadable: @escaping (Int32) -> WaitOutcome,
        readChunk: @escaping (UnsafeMutablePointer<UInt8>, Int) -> (count: Int, err: Int32),
        nowMs: @escaping () -> Int64
    ) {
        self.chunkSize = max(64, chunkSize)
        self.maxLineBytes = max(1, maxLineBytes)
        self.waitReadable = waitReadable
        self.readChunk = readChunk
        self.nowMs = nowMs
    }

    /// Reads the next newline-delimited UTF-8 line.
    ///
    /// - Parameters:
    ///   - idleTimeoutMs: Optional timeout (ms) while 0 bytes have been received for this line.
    ///     `nil` waits indefinitely for the first byte of the next request on an authenticated idle stream.
    ///   - partialLineTimeoutMs: Timeout (ms) once at least 1 byte of a line has arrived without `\n`.
    public func readLine(
        idleTimeoutMs: Int32? = nil,
        partialLineTimeoutMs: Int32 = BufferedSocketLineReader.defaultPartialLineTimeoutMs
    ) -> ReadResult {
        var lineBytes: [UInt8] = []
        var partialDeadlineMs: Int64?
        let idleDeadlineMs: Int64? = idleTimeoutMs.map { nowMs() + Int64(max(0, $0)) }
        var scratch = [UInt8](repeating: 0, count: chunkSize)

        while true {
            // Drain buffered bytes first before issuing any new syscall.
            if cursor < buffer.count {
                if let newlineIndex = buffer[cursor...].firstIndex(of: 10) {
                    let segmentCount = newlineIndex - cursor
                    if lineBytes.count + segmentCount > maxLineBytes {
                        cursor = newlineIndex + 1
                        compactBufferIfNeeded()
                        return .exceededMaxBytes
                    }
                    lineBytes.append(contentsOf: buffer[cursor..<newlineIndex])
                    cursor = newlineIndex + 1
                    compactBufferIfNeeded()
                    guard let text = String(bytes: lineBytes, encoding: .utf8) else {
                        return .invalidUTF8
                    }
                    return .line(text)
                }

                let remainingCount = buffer.count - cursor
                if lineBytes.count + remainingCount > maxLineBytes {
                    buffer.removeAll(keepingCapacity: false)
                    cursor = 0
                    return .exceededMaxBytes
                }
                lineBytes.append(contentsOf: buffer[cursor..<buffer.count])
                buffer.removeAll(keepingCapacity: true)
                cursor = 0
                if partialDeadlineMs == nil && !lineBytes.isEmpty {
                    partialDeadlineMs = nowMs() + Int64(max(0, partialLineTimeoutMs))
                }
            }

            if reachedEOF {
                if lineBytes.isEmpty {
                    return .eof
                }
                guard let text = String(bytes: lineBytes, encoding: .utf8) else {
                    return .invalidUTF8
                }
                return .line(text)
            }

            let timeoutMs: Int32
            if let deadline = partialDeadlineMs ?? idleDeadlineMs {
                let remaining = deadline - nowMs()
                if remaining <= 0 {
                    return .timedOut
                }
                timeoutMs = Int32(min(Int64(Int32.max), remaining))
            } else {
                timeoutMs = -1
            }

            switch waitReadable(timeoutMs) {
            case .ready:
                break
            case .interrupted:
                continue
            case .timedOut:
                return .timedOut
            case let .error(err):
                return .ioError(err)
            }

            let readOutcome = scratch.withUnsafeMutableBufferPointer { ptr -> (count: Int, err: Int32) in
                guard let base = ptr.baseAddress else { return (0, 0) }
                return readChunk(base, ptr.count)
            }
            if readOutcome.count < 0 {
                if readOutcome.err == EINTR {
                    continue
                }
                if readOutcome.err == EAGAIN || readOutcome.err == EWOULDBLOCK {
                    continue
                }
                return .ioError(readOutcome.err)
            }
            if readOutcome.count == 0 {
                reachedEOF = true
                if lineBytes.isEmpty {
                    return .eof
                }
                guard let text = String(bytes: lineBytes, encoding: .utf8) else {
                    return .invalidUTF8
                }
                return .line(text)
            }

            if partialDeadlineMs == nil {
                partialDeadlineMs = nowMs() + Int64(max(0, partialLineTimeoutMs))
            }
            buffer.append(contentsOf: scratch[0..<readOutcome.count])
        }
    }

    private func compactBufferIfNeeded() {
        if cursor >= buffer.count {
            buffer.removeAll(keepingCapacity: true)
            cursor = 0
        } else if cursor >= chunkSize {
            buffer.removeFirst(cursor)
            cursor = 0
        }
    }
}
