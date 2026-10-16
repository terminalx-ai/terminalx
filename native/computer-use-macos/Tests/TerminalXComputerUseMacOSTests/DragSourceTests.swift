import Foundation
import TerminalXComputerUseMacOSCore
import XCTest

final class DragSourceTests: XCTestCase {
    func testTheTileOffersOnlyABundleRunningExactlyThisCode() {
        let own = Data([1, 2, 3])
        XCTAssertTrue(DragSource.accepts(candidateCdhash: Data([1, 2, 3]), ownCdhash: own))
        XCTAssertFalse(DragSource.accepts(candidateCdhash: Data([9, 9, 9]), ownCdhash: own))
        XCTAssertFalse(DragSource.accepts(candidateCdhash: nil, ownCdhash: own))
        XCTAssertFalse(DragSource.accepts(candidateCdhash: own, ownCdhash: nil))
        XCTAssertFalse(DragSource.accepts(candidateCdhash: Data(), ownCdhash: Data()))
    }

    func testTheSourceIsTheValueAfterItsFlag() {
        XCTAssertEqual(DragSource.path(in: ["--permission", "screenshots", "--drag-source", "/A.app"]), "/A.app")
        XCTAssertNil(DragSource.path(in: ["--permission", "screenshots"]))
        XCTAssertNil(DragSource.path(in: ["--drag-source"]))
        XCTAssertNil(DragSource.path(in: ["--drag-source", ""]))
    }

    func testTheTileNeverOffersTheRunningBundle() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Sources/TerminalXComputerUseMacOS/main.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(source.contains("PermissionDragAssistantView(permission: permission, appURL: Bundle.main.bundleURL)"))
        XCTAssertFalse(source.contains("DraggableAppTile(appURL: Bundle.main.bundleURL)"))
        XCTAssertTrue(source.contains("PermissionDragAssistantView(permission: permission, appURL: verifiedDragSource)"))
    }
}
