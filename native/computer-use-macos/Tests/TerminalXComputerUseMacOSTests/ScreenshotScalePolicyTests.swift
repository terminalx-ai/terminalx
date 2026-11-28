import XCTest
@testable import TerminalXComputerUseMacOSCore

final class ScreenshotScalePolicyTests: XCTestCase {
    func testPreDownscalesHighDpiAnd4KImagesBeforeFirstEncode() {
        // 4K image (3840x2160) -> initial scale 1280/3840 = 1/3 -> 1280x720
        let scale4K = ScreenshotScalePolicy.initialScale(width: 3840, height: 2160)
        let dims4K = ScreenshotScalePolicy.scaledDimensions(originalWidth: 3840, originalHeight: 2160, scale: scale4K)
        XCTAssertEqual(dims4K.width, 1280)
        XCTAssertEqual(dims4K.height, 720)

        // 2x Retina (2560x1600) -> 1280x800
        let scaleRetina = ScreenshotScalePolicy.initialScale(width: 2560, height: 1600)
        let dimsRetina = ScreenshotScalePolicy.scaledDimensions(originalWidth: 2560, originalHeight: 1600, scale: scaleRetina)
        XCTAssertEqual(dimsRetina.width, 1280)
        XCTAssertEqual(dimsRetina.height, 800)

        // Small window (1000x800) -> stays at 1.0 (no unnecessary resize)
        let scaleSmall = ScreenshotScalePolicy.initialScale(width: 1000, height: 800)
        XCTAssertEqual(scaleSmall, 1.0, accuracy: 1e-9)
    }

    func testAnalyticalScalingConvergesInTwoEncodesForOversizedPng() {
        let origW = 2560
        let origH = 1600
        let maxBytes = ScreenshotScalePolicy.maxPngBytes
        let initial = ScreenshotScalePolicy.initialScale(width: origW, height: origH)
        let floor = ScreenshotScalePolicy.floorScale(initialScale: initial, width: origW, height: origH)

        // Model PNG size proportional to pixel count: 2.0 bytes/pixel -> 1280x800 = 2,048,000 bytes (> 900k).
        var scale = initial
        var encodes = 0
        var finalBytes = Int.max
        for _ in 0..<ScreenshotScalePolicy.maxEncodeAttempts {
            let dims = ScreenshotScalePolicy.scaledDimensions(originalWidth: origW, originalHeight: origH, scale: scale)
            encodes += 1
            finalBytes = dims.width * dims.height * 2
            if finalBytes <= maxBytes {
                break
            }
            guard let next = ScreenshotScalePolicy.nextScale(
                currentScale: scale,
                currentBytes: finalBytes,
                maxBytes: maxBytes,
                floorScale: floor
            ) else {
                break
            }
            scale = next
        }

        XCTAssertLessThanOrEqual(finalBytes, maxBytes)
        // Converges in 2 encodes instead of 5-9 with linear 0.85x stepping.
        XCTAssertEqual(encodes, 2)
    }

    func testStopsCleanlyAtMinScaleFloor() {
        let next = ScreenshotScalePolicy.nextScale(
            currentScale: 0.30,
            currentBytes: 5_000_000,
            maxBytes: 900_000,
            floorScale: 0.25
        )
        XCTAssertEqual(next, 0.25)
        XCTAssertNil(
            ScreenshotScalePolicy.nextScale(
                currentScale: 0.25,
                currentBytes: 5_000_000,
                maxBytes: 900_000,
                floorScale: 0.25
            )
        )
    }
}
