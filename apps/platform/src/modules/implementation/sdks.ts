/**
 * Release status and quickstarts of the LeanApp SDKs, as shown in Settings → Dev Ops
 * → SDK & API keys. Every snippet uses the SDKs' real public API (sdks.test.ts checks
 * each call against the SDK sources). No SDK is on a package registry yet: they are
 * added from the repository until the owner publishes them (docs/sdk-release.md).
 * Pure and client-safe.
 */
import { msg } from "@/i18n/translate";

export type SdkKey = "react_native" | "kotlin" | "swift" | "flutter";

export interface SdkRelease {
  key: SdkKey;
  label: string;
  /** Where the code lives in the repository. */
  path: string;
  /** The package name it will be published under. */
  pkg: string;
  /** Registry it will be published to. */
  registry: string;
  /** What CI runs on every commit. */
  verified: string;
  /** False until the package is on its registry; snippets then install from the repository. */
  published: boolean;
  /** Not built in this SDK yet (said on the page, not hidden). */
  gaps: string[];
}

export const SDK_RELEASES: SdkRelease[] = [
  {
    key: "react_native", label: "JavaScript / React Native", path: "sdks/javascript", pkg: "@leanapp/analytics", registry: "npm", published: false,
    verified: msg("37 unit tests, typecheck and build in CI"),
    gaps: [msg("Play install referrer on React Native (needs a native module)"), msg("deep_link_url on opens"), msg("in-app message display"), msg("deferred and resolve deep link calls")],
  },
  {
    key: "kotlin", label: "Android (Kotlin)", path: "sdks/android", pkg: "io.leanapp:leanapp-android", registry: "Maven Central", published: false,
    verified: msg("29 JVM unit tests and the Android library build in CI"),
    gaps: [msg("consent per purpose (optOut / optIn only)"), msg("in-app message display"), msg("deferred and resolve deep link calls"), msg("getVariant for experiments (call the assignments API)")],
  },
  {
    key: "swift", label: "iOS (Swift)", path: "sdks/ios", pkg: "LeanApp (Swift Package)", registry: "Swift Package Manager (Git tag)", published: false,
    verified: msg("24 XCTest tests and device and simulator builds on macOS in CI"),
    gaps: [msg("consent per purpose (optOut / optIn only)"), msg("SKAdNetwork / AdAttributionKit conversion values"), msg("in-app message display"), msg("deferred and resolve deep link calls"), msg("getVariant for experiments (call the assignments API)")],
  },
  {
    key: "flutter", label: "Flutter (Dart)", path: "sdks/flutter", pkg: "leanapp_analytics", registry: "pub.dev", published: false,
    verified: msg("25 tests and flutter analyze in CI"),
    gaps: [msg("consent per purpose (optOut / optIn only)"), msg("install referrer without a plugin"), msg("in-app message display"), msg("deferred and resolve deep link calls"), msg("getVariant for experiments (call the assignments API)")],
  },
];

const repoNote = (r: SdkRelease) => `Not published to ${r.registry} yet. Add it from the LeanApp repository (${r.path}); see its README.`;

export function sdkNote(key: SdkKey): string {
  const r = SDK_RELEASES.find((x) => x.key === key)!;
  return r.published ? "" : repoNote(r);
}

/** Install and first calls for each SDK with this environment's key and endpoint. */
export function sdkQuickstarts(o: { key: string; endpoint: string; currency: string }): { key: SdkKey; code: string }[] {
  const { key, endpoint, currency } = o;
  return [
    {
      key: "react_native",
      code: `// package.json (not on npm yet): "@leanapp/analytics": "file:../leanapp/sdks/javascript"
import { Analytics } from "@leanapp/analytics";

Analytics.initialize({
  apiKey: "${key}",
  endpoint: "${endpoint}",
  // React Native: keep the queue across restarts
  // storage: asyncStorageAdapter(AsyncStorage),
});

Analytics.screen("Home");
Analytics.track("product_viewed", { product_id: "123", price: 299, currency: "${currency}" });
Analytics.identify("user_123", { plan: "premium" });`,
    },
    {
      key: "kotlin",
      code: `// settings.gradle.kts (not on Maven Central yet): includeBuild("../leanapp/sdks/android")
// app/build.gradle.kts: implementation("io.leanapp:leanapp-android:0.1.0")
import io.leanapp.analytics.Analytics
import io.leanapp.analytics.AnalyticsOptions

// Application.onCreate()
Analytics.initialize(this, "${key}", AnalyticsOptions(endpoint = "${endpoint}"))

Analytics.screen("Home")
Analytics.track("product_viewed", mapOf("product_id" to "123", "price" to 299, "currency" to "${currency}"))
Analytics.identify("user_123", mapOf("plan" to "premium"))`,
    },
    {
      key: "swift",
      code: `// Xcode: File → Add Package Dependencies → Add Local… → leanapp/sdks/ios (no tagged release yet)
import LeanApp

// application(_:didFinishLaunchingWithOptions:)
var options = AnalyticsOptions()
options.endpoint = "${endpoint}"
Analytics.initialize(apiKey: "${key}", options: options)

Analytics.screen("Home")
Analytics.track("product_viewed", properties: ["product_id": "123", "price": 299, "currency": "${currency}"])
Analytics.identify("user_123", traits: ["plan": "premium"])`,
    },
    {
      key: "flutter",
      code: `# pubspec.yaml (not on pub.dev yet)
# leanapp_analytics:
#   path: ../leanapp/sdks/flutter
import 'package:leanapp_analytics/leanapp_analytics.dart';

// main(), after WidgetsFlutterBinding.ensureInitialized()
await Analytics.initialize(apiKey: '${key}', endpoint: '${endpoint}');

Analytics.screen('Home');
Analytics.track('product_viewed', {'product_id': '123', 'price': 299, 'currency': '${currency}'});
Analytics.identify('user_123', {'plan': 'premium'});`,
    },
  ];
}
