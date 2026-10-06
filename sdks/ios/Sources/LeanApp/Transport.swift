import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPResponse {
    public let status: Int
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    /// Case-insensitive header lookup.
    public func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }

    public var ok: Bool { (200..<300).contains(status) }
}

/// Sends one HTTP POST. Network failures complete with an error; any HTTP status completes with a response.
public protocol HTTPTransport {
    func post(url: URL, headers: [String: String], body: Data, completion: @escaping (Result<HTTPResponse, Error>) -> Void)
}

public final class URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session = session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 20
            config.timeoutIntervalForResource = 60
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: config)
        }
    }

    public func post(url: URL, headers: [String: String], body: Data, completion: @escaping (Result<HTTPResponse, Error>) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        let task = session.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(.failure(URLError(.badServerResponse)))
                return
            }
            var h: [String: String] = [:]
            for (k, v) in http.allHeaderFields {
                if let k = k as? String { h[k] = "\(v)" }
            }
            completion(.success(HTTPResponse(status: http.statusCode, headers: h, body: data ?? Data())))
        }
        task.resume()
    }
}
