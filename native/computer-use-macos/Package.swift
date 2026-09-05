// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "TerminalXComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "TerminalXComputerUseMacOSCore",
            targets: ["TerminalXComputerUseMacOSCore"]
        ),
        .executable(
            name: "terminalx-computer-use-macos",
            targets: ["TerminalXComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "TerminalXComputerUseMacOSCore",
            path: "Sources/TerminalXComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "TerminalXComputerUseMacOS",
            dependencies: ["TerminalXComputerUseMacOSCore"],
            path: "Sources/TerminalXComputerUseMacOS"
        ),
        .testTarget(
            name: "TerminalXComputerUseMacOSTests",
            dependencies: ["TerminalXComputerUseMacOSCore"],
            path: "Tests/TerminalXComputerUseMacOSTests"
        )
    ]
)
