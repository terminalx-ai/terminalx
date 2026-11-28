import Foundation

/// Analytical downscaling policy for bounded screenshot PNG encoding (P-77).
///
/// Pre-downscales high-DPI / 4K images to `maxEdge <= 1280` before the first PNG encode,
/// and computes subsequent scale factors analytically via `sqrt(maxBytes / currentBytes) * 0.95`
/// instead of a linear `0.85x` retry loop.
public enum ScreenshotScalePolicy {
    public static let maxPngBytes = 900_000
    public static let maxInitialEdge: Double = 1_280
    public static let minScale: Double = 0.25
    public static let minFallbackEdge: Double = 320
    public static let maxEncodeAttempts = 8

    public static func initialScale(
        width: Int,
        height: Int,
        maxEdge: Double = maxInitialEdge
    ) -> Double {
        let longest = Double(max(1, max(width, height)))
        return min(1.0, maxEdge / longest)
    }

    public static func floorScale(
        initialScale: Double,
        width: Int,
        height: Int,
        minScale: Double = minScale
    ) -> Double {
        if initialScale >= minScale {
            return minScale
        }
        let longest = Double(max(1, max(width, height)))
        return min(initialScale, minFallbackEdge / longest)
    }

    public static func nextScale(
        currentScale: Double,
        currentBytes: Int,
        maxBytes: Int = maxPngBytes,
        floorScale: Double = minScale
    ) -> Double? {
        guard currentBytes > maxBytes, currentScale > floorScale else {
            return nil
        }
        let analytical = sqrt(Double(maxBytes) / Double(max(1, currentBytes))) * 0.95
        let factor = min(0.95, max(0.1, analytical))
        let candidate = currentScale * factor
        return candidate < floorScale ? floorScale : candidate
    }

    public static func scaledDimensions(originalWidth: Int, originalHeight: Int, scale: Double) -> (width: Int, height: Int) {
        let width = max(1, Int((Double(max(1, originalWidth)) * scale).rounded()))
        let height = max(1, Int((Double(max(1, originalHeight)) * scale).rounded()))
        return (width, height)
    }
}
