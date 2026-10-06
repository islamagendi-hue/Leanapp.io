import Foundation

/// Where the SDK keeps its identity and queue. Called only on the SDK's own queue.
public protocol KeyValueStore: AnyObject {
    func get(_ key: String) -> String?
    func set(_ key: String, _ value: String) throws
    func remove(_ key: String)
}

/// Keeps nothing across restarts. For tests and short-lived processes.
public final class InMemoryStore: KeyValueStore {
    private var values: [String: String] = [:]
    private let lock = NSLock()

    public init() {}

    public func get(_ key: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return values[key]
    }

    public func set(_ key: String, _ value: String) throws {
        lock.lock(); defer { lock.unlock() }
        values[key] = value
    }

    public func remove(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        values[key] = nil
    }
}

/// One file per key. Writes are atomic (temporary file + rename), so a crash keeps the previous version.
public final class FileStore: KeyValueStore {
    private let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// Application Support/leanapp, excluded from iCloud backup.
    public static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("leanapp", isDirectory: true)
    }

    private func url(for key: String) -> URL {
        let safe = String(key.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" || $0 == "." ? $0 : "_" })
        return directory.appendingPathComponent(safe + ".json")
    }

    public func get(_ key: String) -> String? {
        guard let data = try? Data(contentsOf: url(for: key)) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func set(_ key: String, _ value: String) throws {
        if !FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var dir = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? dir.setResourceValues(values)
        }
        try Data(value.utf8).write(to: url(for: key), options: .atomic)
    }

    public func remove(_ key: String) {
        try? FileManager.default.removeItem(at: url(for: key))
    }
}
