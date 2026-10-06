// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "LeanApp",
    platforms: [.iOS(.v13), .macOS(.v10_15), .tvOS(.v13)],
    products: [
        .library(name: "LeanApp", targets: ["LeanApp"]),
    ],
    targets: [
        .target(name: "LeanApp", path: "Sources/LeanApp"),
        .testTarget(name: "LeanAppTests", dependencies: ["LeanApp"], path: "Tests/LeanAppTests"),
    ]
)
