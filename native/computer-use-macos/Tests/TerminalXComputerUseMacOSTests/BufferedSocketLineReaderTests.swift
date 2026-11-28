import Darwin
import XCTest
@testable import TerminalXComputerUseMacOSCore

final class BufferedSocketLineReaderTests: XCTestCase {
    func testReadsMultipleLinesFromSingleBufferedChunkAndRetriesEINTR() {
        let payload = Array("{\"id\":1}\n{\"id\":2}\n{\"id\":3}\n".utf8)
        var readCalls = 0
        var waitCalls = 0
        var sentPayload = false
        var clock: Int64 = 1_000

        let reader = BufferedSocketLineReader(
            chunkSize: 8_192,
            maxLineBytes: 1_024,
            waitReadable: { _ in
                waitCalls += 1
                if waitCalls == 1 {
                    return .interrupted
                }
                return .ready
            },
            readChunk: { ptr, capacity in
                readCalls += 1
                if readCalls == 1 {
                    return (-1, EINTR)
                }
                if !sentPayload {
                    sentPayload = true
                    let count = min(capacity, payload.count)
                    payload.withUnsafeBytes { src in
                        ptr.update(from: src.bindMemory(to: UInt8.self).baseAddress!, count: count)
                    }
                    return (count, 0)
                }
                return (0, 0)
            },
            nowMs: {
                clock += 1
                return clock
            }
        )

        XCTAssertEqual(reader.readLine(idleTimeoutMs: 5_000), .line("{\"id\":1}"))
        XCTAssertEqual(reader.readLine(idleTimeoutMs: 5_000), .line("{\"id\":2}"))
        XCTAssertEqual(reader.readLine(idleTimeoutMs: 5_000), .line("{\"id\":3}"))
        XCTAssertEqual(reader.readLine(idleTimeoutMs: 5_000), .eof)
        // 1 EINTR retry + 1 bulk read delivering all 3 lines + 1 EOF read = 3 total syscalls (not 27 byte-reads).
        XCTAssertEqual(readCalls, 3)
    }

    func testRejectsLineExceedingMaxLineBytesWithoutUnboundedBuffering() {
        let oversized = Array(repeating: UInt8(ascii: "A"), count: 128)
        var readCalls = 0

        let reader = BufferedSocketLineReader(
            chunkSize: 64,
            maxLineBytes: 32,
            waitReadable: { _ in .ready },
            readChunk: { ptr, capacity in
                readCalls += 1
                let count = min(capacity, oversized.count)
                oversized.withUnsafeBytes { src in
                    ptr.update(from: src.bindMemory(to: UInt8.self).baseAddress!, count: count)
                }
                return (count, 0)
            },
            nowMs: { 0 }
        )

        XCTAssertEqual(reader.readLine(idleTimeoutMs: 5_000), .exceededMaxBytes)
        XCTAssertEqual(readCalls, 1)
    }

    func testEnforcesIdleAndPartialLineTimeouts() {
        var now: Int64 = 10_000
        let idleReader = BufferedSocketLineReader(
            chunkSize: 64,
            maxLineBytes: 256,
            waitReadable: { _ in .timedOut },
            readChunk: { _, _ in (0, 0) },
            nowMs: { now }
        )
        XCTAssertEqual(idleReader.readLine(idleTimeoutMs: 100), .timedOut)

        // Partial line starts arriving without newline, then stalls past partialLineTimeoutMs.
        var deliveredPartial = false
        let partialReader = BufferedSocketLineReader(
            chunkSize: 64,
            maxLineBytes: 256,
            waitReadable: { _ in
                if !deliveredPartial {
                    return .ready
                }
                now += 200
                return .timedOut
            },
            readChunk: { ptr, _ in
                deliveredPartial = true
                let bytes = Array("{\"partial\":".utf8)
                bytes.withUnsafeBytes { src in
                    ptr.update(from: src.bindMemory(to: UInt8.self).baseAddress!, count: bytes.count)
                }
                return (bytes.count, 0)
            },
            nowMs: { now }
        )
        XCTAssertEqual(partialReader.readLine(idleTimeoutMs: nil, partialLineTimeoutMs: 100), .timedOut)
    }

    func testWorksOverRealUnixSocketPair() throws {
        var fds: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        defer {
            if fds[0] >= 0 { close(fds[0]) }
            if fds[1] >= 0 { close(fds[1]) }
        }

        let reader = BufferedSocketLineReader(fileDescriptor: fds[0], chunkSize: 128, maxLineBytes: 4_096)
        let message = "{\"id\":\"a\",\"method\":\"handshake\"}\n{\"id\":\"b\",\"method\":\"listApps\"}\n"
        _ = message.withCString { cstr in
            Darwin.write(fds[1], cstr, strlen(cstr))
        }
        close(fds[1])
        fds[1] = -1

        XCTAssertEqual(reader.readLine(idleTimeoutMs: 1_000), .line("{\"id\":\"a\",\"method\":\"handshake\"}"))
        XCTAssertEqual(reader.readLine(idleTimeoutMs: 1_000), .line("{\"id\":\"b\",\"method\":\"listApps\"}"))
        XCTAssertEqual(reader.readLine(idleTimeoutMs: 1_000), .eof)
    }
}
