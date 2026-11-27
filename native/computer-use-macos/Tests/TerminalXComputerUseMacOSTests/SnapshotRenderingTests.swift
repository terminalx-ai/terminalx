import XCTest
@testable import TerminalXComputerUseMacOSCore

final class SnapshotRenderingTests: XCTestCase {
    func testSkipsUnsupportedAdvertisedAttributes() {
        let advertised: Set<String> = ["AXRole", "AXChildren"]

        XCTAssertTrue(SnapshotRenderHeuristics.supportsAttribute("AXRole", advertisedAttributes: advertised))
        XCTAssertFalse(SnapshotRenderHeuristics.supportsAttribute("AXTitle", advertisedAttributes: advertised))
    }

    func testUnknownAttributeAdvertisementsStayPermissive() {
        XCTAssertTrue(SnapshotRenderHeuristics.supportsAttribute("AXTitle", advertisedAttributes: nil))
    }

    func testSecureTextMetadataOnlyProbesTextLikeRoles() {
        XCTAssertTrue(SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: "AXTextField"))
        XCTAssertTrue(SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: "AXSearchField"))
        XCTAssertFalse(SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: "AXGroup"))
        XCTAssertFalse(SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: "AXButton"))
    }

    func testElidesAnonymousWrappers() {
        let node = SnapshotRenderNode(role: "AXGroup", childCount: 1)

        XCTAssertTrue(SnapshotRenderHeuristics.shouldElide(node))
    }

    func testPreservesWebAreaContainersWithMultipleChildren() {
        let node = SnapshotRenderNode(role: "AXGroup", childCount: 3, webAreaDepth: 1)

        XCTAssertFalse(SnapshotRenderHeuristics.shouldElide(node))
    }

    func testRendersMarkdownLinksAndSuppressesTheirChildren() {
        let node = SnapshotRenderNode(role: "AXLink", linkText: "Skip [main]", url: "https://example.com/path")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 7, node: node), "7 link [Skip \\[main\\]](https://example.com/path)")
        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(node))
    }

    func testSuppressesChildrenForNamedCompactControls() {
        let button = SnapshotRenderNode(role: "AXButton", roleDescription: "button", label: "Install GitHub", childCount: 1)
        let heading = SnapshotRenderNode(role: "AXHeading", roleDescription: "heading", label: "Repository navigation", value: "2", childCount: 1)

        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(button))
        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(heading))
        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 5, node: heading), "5 heading Repository navigation")
    }

    func testKeepsChildrenForRowsWithNestedControls() {
        let row = SnapshotRenderNode(role: "AXRow", roleDescription: "row", childCount: 3, rowSummary: "Liked Songs")

        XCTAssertFalse(SnapshotRenderHeuristics.shouldSuppressChildren(row))
    }

    func testFiltersNoisyActionsAndFormatsSecondaryActions() {
        let node = SnapshotRenderNode(
            role: "AXWindow",
            title: "Document",
            rawActions: ["AXPress", "AXShowMenu", "AXScrollToVisible", "AXZoomWindow"]
        )

        XCTAssertEqual(SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role), ["AXZoomWindow"])
        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 1, node: node), "1 window Document, Secondary Actions: zoom the window")
    }

    func testSuppressesHorizontalScrollWhenVerticalScrollExists() {
        let node = SnapshotRenderNode(
            role: "AXScrollArea",
            rawActions: ["AXScrollUpByPage", "AXScrollDownByPage", "AXScrollLeftByPage", "AXScrollRightByPage"]
        )

        XCTAssertEqual(SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role), ["AXScrollUpByPage", "AXScrollDownByPage"])
    }

    func testTextFieldsKeepDistinctValueAndPlaceholder() {
        let node = SnapshotRenderNode(
            role: "AXTextField",
            roleDescription: "text field",
            label: "Address",
            value: "https://example.com",
            placeholder: "Search"
        )

        XCTAssertEqual(
            SnapshotRenderHeuristics.line(index: 3, node: node),
            "3 text field Address, Value: https://example.com, Placeholder: Search"
        )
    }

    func testStaticTextUsesCompactValueFormatting() {
        let node = SnapshotRenderNode(role: "AXStaticText", roleDescription: "text", value: "Home")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 4, node: node), "4 text Home")
    }

    func testRowSummaryBecomesName() {
        let node = SnapshotRenderNode(role: "AXRow", roleDescription: "row", rowSummary: "General Settings Enabled")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 9, node: node), "9 row General Settings Enabled")
    }

    func testCompactsLargeBrowserTabStripsToSelectedTab() {
        let parent = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "tab bar")
        let children = (0..<12).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Tab \(index)",
                traits: index == 7 ? ["selected"] : []
            )
        }

        let compaction = SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children)

        XCTAssertEqual(compaction, SnapshotTabStripCompaction(retainedIndexes: [7], omittedCount: 11))
    }

    func testInfersLargeBrowserTabStripFromScrollAreaChildren() {
        let parent = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "scroll area")
        let children = (0..<12).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Tab \(index)",
                traits: index == 11 ? ["selected"] : []
            )
        }

        let compaction = SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children)

        XCTAssertEqual(compaction, SnapshotTabStripCompaction(retainedIndexes: [11], omittedCount: 11))
    }

    func testUsesOneValueAsSelectedBrowserTabFallback() {
        let parent = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "scroll area")
        let children = (0..<12).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Tab \(index)",
                value: index == 4 ? "1" : "0"
            )
        }

        let compaction = SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children)

        XCTAssertEqual(compaction, SnapshotTabStripCompaction(retainedIndexes: [4], omittedCount: 11))
    }

    func testKeepsLargeTabCollectionsWithoutActiveTabExpanded() {
        let parent = SnapshotRenderNode(role: "AXGroup")
        let children = (0..<12).map { index in
            SnapshotRenderNode(role: "AXTab", title: "Tab \(index)", value: "0")
        }

        XCTAssertNil(SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children))
    }

    func testKeepsLargeNonBrowserTabCollectionsExpanded() {
        let parent = SnapshotRenderNode(role: "AXGroup")
        let children = (0..<12).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Pane \(index)",
                traits: index == 2 ? ["selected"] : []
            )
        }

        XCTAssertNil(SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children))
    }

    func testKeepsSmallTabGroupsExpanded() {
        let parent = SnapshotRenderNode(role: "AXTabGroup", roleDescription: "tab group")
        let children = (0..<3).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Pane \(index)",
                traits: index == 1 ? ["selected"] : []
            )
        }

        XCTAssertNil(SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children))
    }

    func testTabStripCompactionGatesBeforeFetchingChildAttributes() {
        var roleReads = 0
        var selectionReads = 0

        let nonTabStrip = SnapshotRenderNode(role: "AXGroup")
        let nonTabStripResult = SnapshotRenderHeuristics.tabStripCompaction(
            parent: nonTabStrip,
            childCount: 25,
            childRole: { _ in
                roleReads += 1
                return (role: "AXTab", roleDescription: "tab")
            },
            isChildSelected: { _ in
                selectionReads += 1
                return true
            }
        )
        XCTAssertNil(nonTabStripResult)
        XCTAssertEqual(roleReads, 0)
        XCTAssertEqual(selectionReads, 0)

        let smallScrollArea = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "scroll area")
        let smallResult = SnapshotRenderHeuristics.tabStripCompaction(
            parent: smallScrollArea,
            childCount: 9,
            childRole: { _ in
                roleReads += 1
                return (role: "AXTab", roleDescription: "tab")
            },
            isChildSelected: { _ in
                selectionReads += 1
                return true
            }
        )
        XCTAssertNil(smallResult)
        XCTAssertEqual(roleReads, 0)
        XCTAssertEqual(selectionReads, 0)
    }

    func testTabStripCompactionShortCircuitsNonTabScrollAreaAndLimitsSelectionReads() {
        let scrollArea = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "scroll area")
        var roleReads = 0
        var selectionReads = 0

        let nonTabResult = SnapshotRenderHeuristics.tabStripCompaction(
            parent: scrollArea,
            childCount: 20,
            childRole: { _ in
                roleReads += 1
                return (role: "AXGroup", roleDescription: "group")
            },
            isChildSelected: { _ in
                selectionReads += 1
                return false
            }
        )
        XCTAssertNil(nonTabResult)
        // Once 11 children are non-tabs out of 20, only 9 remain so 10 tabs is impossible.
        XCTAssertEqual(roleReads, 11)
        XCTAssertEqual(selectionReads, 0)

        var selectedCheckedIndexes: [Int] = []
        let mixedResult = SnapshotRenderHeuristics.tabStripCompaction(
            parent: scrollArea,
            childCount: 14,
            childRole: { index in
                if index == 0 || index == 13 {
                    return (role: "AXButton", roleDescription: "button")
                }
                return (role: "AXRadioButton", roleDescription: "tab")
            },
            isChildSelected: { index in
                selectedCheckedIndexes.append(index)
                return index == 5
            }
        )
        XCTAssertEqual(mixedResult, SnapshotTabStripCompaction(retainedIndexes: [0, 5, 13], omittedCount: 11))
        XCTAssertEqual(Set(selectedCheckedIndexes), Set(1...12))
    }

    func testSelectVisibleRowsPrefersDirectVisibleRowsWithoutFetchingAllRows() {
        var allRowsCalled = false
        var parentFrameChecked = false
        var rowFrameChecks = 0

        let direct = SnapshotRenderHeuristics.selectVisibleRows(
            directVisibleRows: { Array(0..<30) },
            allRows: {
                allRowsCalled = true
                return Array(0..<500)
            },
            hasParentFrame: {
                parentFrameChecked = true
                return true
            },
            isRowVisible: { _ in
                rowFrameChecks += 1
                return true
            }
        )

        XCTAssertEqual(direct, Array(0..<20))
        XCTAssertFalse(allRowsCalled)
        XCTAssertFalse(parentFrameChecked)
        XCTAssertEqual(rowFrameChecks, 0)

        let emptyDirect = SnapshotRenderHeuristics.selectVisibleRows(
            directVisibleRows: { [Int]() },
            allRows: {
                allRowsCalled = true
                return [1, 2, 3]
            },
            hasParentFrame: {
                parentFrameChecked = true
                return true
            },
            isRowVisible: { _ in true }
        )
        XCTAssertEqual(emptyDirect, [])
        XCTAssertFalse(allRowsCalled)
        XCTAssertFalse(parentFrameChecked)
    }

    func testSelectVisibleRowsFallbackStopsAfterCollectingTwentyVisibleRows() {
        var checkedRows = 0

        let fallback = SnapshotRenderHeuristics.selectVisibleRows(
            directVisibleRows: { nil as [Int]? },
            allRows: { Array(0..<1000) },
            hasParentFrame: { true },
            isRowVisible: { row in
                checkedRows += 1
                return row >= 5
            }
        )

        XCTAssertEqual(fallback, Array(5..<25))
        XCTAssertEqual(checkedRows, 25)
    }
}
