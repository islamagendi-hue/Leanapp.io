import Foundation
#if canImport(AdServices) && os(iOS)
import AdServices
#endif
#if canImport(StoreKit) && os(iOS)
import StoreKit
#endif
#if canImport(AdAttributionKit) && os(iOS)
import AdAttributionKit
#endif

/// Apple's privacy-preserving attribution, used as Apple provides it. LeanApp never gets a
/// person-level answer from these APIs beyond what Apple returns:
/// - AdServices: an attribution token for Apple Search Ads. LeanApp's server exchanges it with Apple
///   (api-adservices.apple.com) for the campaign of a Search Ads install, when there is one.
/// - SKAdNetwork / AdAttributionKit: the app sets conversion values; Apple sends aggregated,
///   delayed postbacks to the ad network (and to LeanApp's well-known endpoints), never per user.
public enum AppleAttribution {
    /// AAAttribution.attributionToken() on iOS 14.3+, or nil (older iOS, other platforms, simulator
    /// errors). The token is valid for 24 hours; the SDK sends it once, with app_installed.
    public static func adServicesToken() -> String? {
        #if canImport(AdServices) && os(iOS)
        if #available(iOS 14.3, *) {
            do {
                let token = try AAAttribution.attributionToken()
                return token.isEmpty ? nil : token
            } catch {
                return nil
            }
        }
        #endif
        return nil
    }

    /// Coarse conversion value for SKAdNetwork 4 / AdAttributionKit.
    public enum CoarseValue: String {
        case low
        case medium
        case high
    }

    public enum ConversionValueError: Error, CustomStringConvertible {
        case unsupported
        case outOfRange

        public var description: String {
            switch self {
            case .unsupported: return "LeanApp: conversion values need iOS 14 or later (SKAdNetwork) or iOS 17.4 (AdAttributionKit)."
            case .outOfRange: return "LeanApp: the fine conversion value must be between 0 and 63."
            }
        }
    }

    /// The API a conversion value update used.
    public enum Framework: String {
        case adAttributionKit
        case skAdNetwork
    }

    /// Updates the conversion value for Apple's install postbacks. `fine` is 0–63; `coarse` and `lock`
    /// are used where the OS supports them. On iOS 17.4+ AdAttributionKit's Postback.updateConversionValue
    /// is used when `preferAdAttributionKit` is true; otherwise SKAdNetwork's
    /// updatePostbackConversionValue (iOS 16.1+ with coarse and lock, 15.4+ fine only) or
    /// updateConversionValue (iOS 14.0+). LeanApp does not call this for you: what each value means is
    /// your choice, set to match the conversion schema you configure with your ad networks.
    /// `completion` gets the framework used, or the error.
    public static func updateConversionValue(
        _ fine: Int,
        coarse: CoarseValue? = nil,
        lock: Bool = false,
        preferAdAttributionKit: Bool = true,
        completion: ((Result<Framework, Error>) -> Void)? = nil
    ) {
        guard (0...63).contains(fine) else {
            completion?(.failure(ConversionValueError.outOfRange))
            return
        }
        #if canImport(AdAttributionKit) && os(iOS)
        if preferAdAttributionKit, #available(iOS 17.4, *) {
            let value: AdAttributionKit.CoarseConversionValue
            switch coarse ?? .low {
            case .low: value = .low
            case .medium: value = .medium
            case .high: value = .high
            }
            Task {
                do {
                    try await Postback.updateConversionValue(fine, coarseConversionValue: value, lockPostback: lock)
                    completion?(.success(.adAttributionKit))
                } catch {
                    completion?(.failure(error))
                }
            }
            return
        }
        #endif
        #if canImport(StoreKit) && os(iOS)
        if #available(iOS 16.1, *) {
            let value: SKAdNetwork.CoarseConversionValue
            switch coarse ?? .low {
            case .low: value = .low
            case .medium: value = .medium
            case .high: value = .high
            }
            SKAdNetwork.updatePostbackConversionValue(fine, coarseValue: value, lockWindow: lock) { error in
                if let error = error { completion?(.failure(error)) } else { completion?(.success(.skAdNetwork)) }
            }
            return
        }
        if #available(iOS 15.4, *) {
            SKAdNetwork.updatePostbackConversionValue(fine) { error in
                if let error = error { completion?(.failure(error)) } else { completion?(.success(.skAdNetwork)) }
            }
            return
        }
        if #available(iOS 14.0, *) {
            SKAdNetwork.updateConversionValue(fine)
            completion?(.success(.skAdNetwork))
            return
        }
        #endif
        completion?(.failure(ConversionValueError.unsupported))
    }
}
