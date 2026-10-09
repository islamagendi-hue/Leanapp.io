/**
 * The public developer guide (/developers) in English and Arabic: which SDKs
 * exist, their honest release status, a quick start, code per platform,
 * event naming, identity, consent, testing, deep links, the server API and
 * our recommendations. Every call in SDK_SNIPPETS exists in the SDK sources
 * and the release status follows SDK_RELEASES (developers.test.ts checks
 * both, and that the Arabic copy has the same shape as the English). Pure.
 */
import { SDK_RELEASES, type SdkKey } from "@/modules/implementation/sdks";
import type { LandingLang } from "./landing";

export type SdkId = "javascript" | "android" | "ios" | "flutter";
export const SDK_IDS: SdkId[] = ["javascript", "android", "ios", "flutter"];

/** Language-independent facts: names, packages and where each would be published. */
export const SDK_FACTS: Record<SdkId, { name: string; pkg: string; registry: string; release: SdkKey; lang: string }> = {
  javascript: { name: "JavaScript / React Native", pkg: "@leanapp/analytics", registry: "npm", release: "react_native", lang: "TypeScript" },
  android: { name: "Android (Kotlin)", pkg: "io.leanapp:leanapp-android", registry: "Maven Central", release: "kotlin", lang: "Kotlin" },
  ios: { name: "iOS (Swift)", pkg: "LeanApp (Swift Package)", registry: "Swift Package Manager", release: "swift", lang: "Swift" },
  flutter: { name: "Flutter (Dart)", pkg: "leanapp_analytics", registry: "pub.dev", release: "flutter", lang: "Dart" },
};

/** True once the SDK is on its public registry (from the dashboard's release list). */
export function sdkPublished(id: SdkId): boolean {
  return SDK_RELEASES.find((r) => r.key === SDK_FACTS[id].release)?.published ?? false;
}

export type SnippetKey = "setup" | "usage" | "more";
export const SNIPPET_KEYS: SnippetKey[] = ["setup", "usage", "more"];

/** Code per SDK. Code and its comments stay in English and left to right in both languages. */
export const SDK_SNIPPETS: Record<SdkId, Record<SnippetKey, string>> = {
  javascript: {
    setup: `// Not on npm yet: we share the package with you during onboarding.
import { Analytics } from "@leanapp/analytics";

Analytics.initialize({
  apiKey: "la_pk_dev_…",   // development key while you build
  appVersion: "2.4.0",
  // React Native: keep the queue across restarts and send it in the background
  // storage: asyncStorageAdapter(AsyncStorage), appState: AppState,
});`,
    usage: `Analytics.screen("Home");
Analytics.track("product_viewed", { product_id: "123", price: 299, currency: "SAR" });

// After login
Analytics.identify("user_123", { plan: "plus", language: "ar" });

// Your own id as eventId, so a retry is never counted twice
Analytics.track("order_completed", { order_id: "o1", revenue: 45, currency: "SAR" }, { eventId: "order-o1" });

// On logout
Analytics.reset();`,
    more: `// Campaign data from the opening URL (utm_* and click ids)
Analytics.captureAttribution(window.location.href);

// Consent: hold events until the user answers, then record the answer
Analytics.initialize({ apiKey: "la_pk_dev_…", consentDefault: "pending" });
Analytics.setConsent({ analytics: true, marketing: false, push: true, attribution: true });

// Optional: send the queue now
await Analytics.flush();`,
  },
  android: {
    setup: `// Not on Maven Central yet: we share the module with you during onboarding.
import io.leanapp.analytics.Analytics
import io.leanapp.analytics.AnalyticsOptions

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Analytics.initialize(this, "la_pk_dev_…", AnalyticsOptions(debug = true))
    }
}`,
    usage: `Analytics.screen("Home")
Analytics.track("product_viewed", mapOf("product_id" to "123", "price" to 299, "currency" to "SAR"))

// After login
Analytics.identify("user_123", mapOf("plan" to "plus", "language" to "ar"))

// Your own id as eventId, so a retry is never counted twice
Analytics.track("order_completed", mapOf("order_id" to "o1", "revenue" to 45.0, "currency" to "SAR"), eventId = "order-o1")

// On logout
Analytics.reset()`,
    more: `// The link that launched the app is captured automatically.
// Links that arrive while the app is running:
override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    intent.dataString?.let { Analytics.captureAttribution(it) }
}

// The user turned analytics off (optIn() turns it back on)
Analytics.optOut()

// Optional: send the queue now
Analytics.flush()`,
  },
  ios: {
    setup: `// Not tagged as a public Swift package yet: we share it with you during onboarding.
import LeanApp

// application(_:didFinishLaunchingWithOptions:), on the main thread
var options = AnalyticsOptions()
options.debug = true
Analytics.initialize(apiKey: "la_pk_dev_…", options: options)`,
    usage: `Analytics.screen("Home")
Analytics.track("product_viewed", properties: ["product_id": "123", "price": 299, "currency": "SAR"])

// After login
Analytics.identify("user_123", traits: ["plan": "plus", "language": "ar"])

// Your own id as eventId, so a retry is never counted twice
Analytics.track("order_completed", properties: ["order_id": "o1", "revenue": 45.0, "currency": "SAR"], eventId: "order-o1")

// On logout
Analytics.reset()`,
    more: `// Deep links and universal links
func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    contexts.forEach { Analytics.captureAttribution($0.url) }
}

// The user turned analytics off (optIn() turns it back on)
Analytics.optOut()

// Optional: send the queue now
Analytics.flush()`,
  },
  flutter: {
    setup: `// Not on pub.dev yet: we share the package with you during onboarding.
import 'package:leanapp_analytics/leanapp_analytics.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Analytics.initialize(apiKey: 'la_pk_dev_…', appVersion: '2.4.0', appBuild: '240', debug: true);
  runApp(const MyApp());
}`,
    usage: `Analytics.screen('Home');
Analytics.track('product_viewed', {'product_id': '123', 'price': 299, 'currency': 'SAR'});

// After login
Analytics.identify('user_123', {'plan': 'plus', 'language': 'ar'});

// Your own id as eventId, so a retry is never counted twice
Analytics.track('order_completed', {'order_id': 'o1', 'revenue': 45, 'currency': 'SAR'}, 'order-o1');

// On logout
Analytics.reset();`,
    more: `// Links from app_links (or your own link handling)
Analytics.captureAttribution(uri.toString());

// The user turned analytics off (optIn() turns it back on)
Analytics.optOut();

// Optional: send the queue now
await Analytics.flush();`,
  },
};

/** Sending one event from a server with a secret key. */
export const SERVER_SNIPPET = `curl -X POST https://api.leanapp.io/v1/events \\
  -H "Authorization: Bearer la_sk_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"track","event_name":"order_completed","event_id":"o-1029",
       "user_id":"u-42","properties":{"order_id":"o-1029","revenue":120,"currency":"SAR"}}'`;

export type SectionId = "sdks" | "quickstart" | "code" | "events" | "identity" | "consent" | "delivery" | "testing" | "deep-links" | "server" | "notes";
export const SECTION_IDS: SectionId[] = ["sdks", "quickstart", "code", "events", "identity", "consent", "delivery", "testing", "deep-links", "server", "notes"];

/** Example event names stay in English in both languages; only the description is translated. */
const EXAMPLE_EVENTS = ["product_viewed", "checkout_started", "order_completed", "subscription_renewed", "refund_completed"] as const;
/** Consent purposes, as the JavaScript SDK names them. */
const PURPOSES = ["analytics", "push", "attribution", "marketing"] as const;

const EN = {
  dir: "ltr" as "ltr" | "rtl",
  meta: {
    title: "LeanApp for developers: SDKs and setup guide",
    description: "LeanApp SDKs for JavaScript, React Native, Android, iOS and Flutter: setup, events, identity, consent, testing and the REST API.",
  },
  nav: { home: "Home", developers: "Developers", sections: "Sections", other: "العربية", signIn: "Sign in", start: "Start free", dashboard: "Open dashboard" },
  hero: {
    eyebrow: "For developers",
    title: "Add LeanApp to your app",
    lead: "Four SDKs and a REST API send your app's events to LeanApp. This guide covers which SDK to use, how to set it up, what to send and how to check it before you ship.",
    status: "The SDKs are built and tested in our CI, but not yet on public package registries. We give them to your team during onboarding, and this page will show the install command when each one is published.",
  },
  toc: "On this page",
  sections: {
    sdks: "SDKs",
    quickstart: "Quick start",
    code: "Code by platform",
    events: "Event names and the tracking plan",
    identity: "Users: identify and logout",
    consent: "Consent and privacy",
    delivery: "How events are sent",
    testing: "Test before production",
    "deep-links": "Deep links and attribution",
    server: "From your servers: REST API",
    notes: "Notes and recommendations",
  } as Record<SectionId, string>,
  sdks: {
    lead: "One SDK per platform, with the same method names and the same rules for queueing, retries and sessions. Pick the one your app is written in.",
    labels: { pkg: "Package", runsOn: "Runs on", status: "Status", does: "What it does", notYet: "Not built yet", code: "See the code", notPublished: "Not published yet" },
    unpublished: "Not on {registry} yet: available from us during onboarding.",
    published: "Published on {registry}.",
    cards: {
      javascript: {
        runsOn: "Web browsers, React Native and Node.js 18+ servers. No dependencies.",
        does: ["Events, screens, users and sessions", "Consent per purpose (analytics, marketing, push, attribution)", "Campaign data from URLs: utm_* and ad click ids", "Offline queue: localStorage in browsers, AsyncStorage on React Native"],
        notYet: ["Play install referrer on React Native", "deep_link_url on app opens", "Showing in-app messages", "Deferred deep link calls"],
      },
      android: {
        runsOn: "Android 5.0 (API 21) and later. Depends only on the Play Install Referrer library.",
        does: ["Events, screens, users and sessions", "app_installed, app_updated and app_opened sent for you", "Google Play install referrer, read once per install", "Campaign data from the link that opened the app"],
        notYet: ["Consent per purpose (optOut / optIn only)", "Showing in-app messages", "Deferred deep link calls"],
      },
      ios: {
        runsOn: "iOS 13 and later (also macOS 10.15+ and tvOS 13+). No dependencies.",
        does: ["Events, screens, users and sessions", "app_installed, app_updated and app_opened sent for you", "APNs push tokens", "Campaign data from deep links and universal links you pass in"],
        notYet: ["Consent per purpose (optOut / optIn only)", "SKAdNetwork / AdAttributionKit conversion values", "Showing in-app messages", "Deferred deep link calls"],
      },
      flutter: {
        runsOn: "Flutter 3.13+ (Dart 3.1+) on Android and iOS. Depends on http and shared_preferences.",
        does: ["Events, screens, users and sessions", "app_installed, app_updated and app_opened sent for you", "Install referrer passed in from a plugin such as play_install_referrer", "Campaign data from links you pass in"],
        notYet: ["Consent per purpose (optOut / optIn only)", "Install referrer without a plugin", "Showing in-app messages", "Deferred deep link calls"],
      },
    } as Record<SdkId, { runsOn: string; does: string[]; notYet: string[] }>,
  },
  quickstart: {
    lead: "From an empty project to your first event, in five steps.",
    steps: [
      { title: "Create your project", body: "Sign up and create your app. Every project gets three environments: development, staging and production." },
      { title: "Get your keys", body: "Open Settings → Dev Ops → SDK & API keys. Each environment has its own public SDK key (la_pk_dev_…, la_pk_stg_…, la_pk_live_…), so test data never mixes with real users." },
      { title: "Add the SDK and initialize it", body: "Initialize once, as early as possible (Application.onCreate, didFinishLaunching, main()), with the development key while you build." },
      { title: "Send the events in your tracking plan", body: "Settings → Dev Ops → Implementation lists every event to send, its properties and a code snippet for each." },
      { title: "Watch them arrive", body: "Settings → Dev Ops → Debugger shows each event as it arrives and whether it matches the plan. Switch to the production key only when it is clean." },
    ],
  },
  code: {
    lead: "The same calls on every platform. Open a platform to see its code.",
    snippets: { setup: "Add and initialize", usage: "Screens, events and users", more: "Links, privacy and sending" } as Record<SnippetKey, string>,
  },
  events: {
    lead: "Clean names make every report easier to read. The tracking plan we build with you already follows these rules.",
    rules: [
      "Use snake_case, object first, then the action in the past tense: product_viewed, order_completed.",
      "Names start with a letter and are at most 100 characters.",
      "One event per business fact. Put variations in properties (payment_method, source), not in new event names.",
      "Money: a number in revenue, value or price, plus an ISO 4217 currency such as SAR or AED. A refund is its own event, never a negative revenue.",
      "User properties describe the person (city, plan, language). Things that change with every action belong in event properties.",
      "Events your plan doesn't list are kept and shown as unplanned, with suggestions to map them to a planned event.",
    ],
    examplesTitle: "Examples",
    examples: {
      product_viewed: "A user opened a product page",
      checkout_started: "A user began checkout",
      order_completed: "An order was paid, with revenue and currency",
      subscription_renewed: "A subscription renewed (send it from your server)",
      refund_completed: "A refund was issued (send it from your server)",
    } as Record<(typeof EXAMPLE_EVENTS)[number], string>,
  },
  identity: {
    lead: "Before login, events carry an anonymous id the SDK creates. Identify the user and LeanApp links what they did before and after.",
    points: [
      "Call identify with your own stable user id right after login or sign-up, not an email or phone number.",
      "Pass traits that describe the person (plan, city, language). Use setUserProperties to update them without changing the user.",
      "Call reset on logout. The next user on the same device starts with a new anonymous id.",
      "Use alias to merge a guest id into a real account when your app has guest checkout.",
    ],
  },
  consent: {
    lead: "Ask for consent where your users' law requires it, and tell LeanApp the answer. The platform then enforces it too.",
    purposesTitle: "Purposes in the JavaScript / React Native SDK",
    purposes: {
      analytics: "track, screen, identify and alias. Denied: events are dropped on the device and not stored on the platform.",
      push: "registerPushToken. Denied: the user is suppressed from push.",
      attribution: "Campaign data on events. Denied: it is removed on the device and at ingestion.",
      marketing: "Nothing on the device. Denied: the user is suppressed from marketing messages.",
    } as Record<(typeof PURPOSES)[number], string>,
    points: [
      "JavaScript / React Native: initialize with consentDefault: \"pending\" to hold events in memory until the user answers, then call setConsent. The answer is stored on the device and follows the user after login.",
      "Android, iOS and Flutter: optOut() stops sending and optIn() resumes. Consent per purpose is not built in these SDKs yet.",
      "No SDK collects advertising ids (IDFA, GAID), Android ID or IDFV.",
      "Privacy exports and deletions are available from the dashboard and the API.",
    ],
  },
  delivery: {
    lead: "Calls return immediately and never throw after initialization: the SDK queues events and sends them in the background.",
    rows: [
      { topic: "Batching", value: "Sent every 10 seconds or when 20 events are queued, up to 100 events per request." },
      { topic: "Offline", value: "The queue is saved on the device (up to 1,000 events, oldest dropped first) and survives restarts. Events older than 7 days are dropped." },
      { topic: "Background", value: "The queue is sent when the app goes to the background: on page hide in browsers, with appState on React Native, when the last activity stops on Android, in a background task on iOS, and on pause in Flutter." },
      { topic: "Retries", value: "Network errors and server errors retry with backoff from 1 second to 5 minutes. Every event has an id, so a retry is never counted twice." },
      { topic: "Wrong or revoked key", value: "The SDK stops sending and keeps the events on the device, so nothing is lost while you fix the key." },
      { topic: "Sessions", value: "A new session starts after 30 minutes of inactivity." },
    ],
  },
  testing: {
    lead: "Check every event in development before you release to real users.",
    steps: [
      "Build with the development key (la_pk_dev_…) and turn on debug logging (debug: true) to see what the SDK does.",
      "Open Settings → Dev Ops → Debugger in the development environment and use the app: each event appears live, with any validation errors.",
      "Fix what the debugger reports until the events in your plan are valid. The Implementation score shows what is still missing.",
      "Repeat on staging if you have it, then ship with the production key (la_pk_live_…). Development data never appears in production reports.",
    ],
  },
  deepLinks: {
    lead: "LeanApp tracking links and deep links tell you which campaign brought each user. Here is what the SDKs do today.",
    points: [
      "Android reads the link that opened the app by itself. On iOS, Flutter and for links that arrive while an Android app is running, pass the URL to captureAttribution.",
      "captureAttribution keeps utm_* parameters and click ids (click_id, gclid, fbclid, ttclid, ScCid and others): the first touch is kept and the latest is sent with every event.",
      "Android reads the Google Play install referrer once per install, so installs from LeanApp links match exactly. Flutter needs a plugin for it; React Native doesn't read it yet.",
      "Deferred deep links (opening the right screen after a fresh install) are not called by the SDKs yet. The server API exists in beta; until the SDKs use it, routing after install is up to your app.",
      "Opening the right screen when the app is already installed is up to your app's link handling.",
    ],
  },
  server: {
    lead: "Send events your server knows best, and read data from your own tools, with the REST API.",
    points: [
      "Use a secret key (la_sk_…) on servers only. Never put a secret key in an app: the JavaScript SDK refuses one outside a server.",
      "POST /v1/events sends one event and POST /v1/events/batch up to 500.",
      "Send payments, renewals and refunds from your backend, with the transaction id as event_id so nothing is counted twice.",
      "Secret keys have scopes for privacy requests, the tracking plan and reports. Ask us for the OpenAPI specification.",
    ],
  },
  notes: {
    items: [
      { title: "Build with the development key", body: "Use la_pk_dev_… while you build and test, and the production key only in release builds." },
      { title: "Use snake_case event names", body: "Follow your tracking plan exactly; a typo creates a new, unplanned event." },
      { title: "No personal data in properties", body: "Don't send names, emails, phone numbers or national ids in event properties. Identify users with your own internal id." },
      { title: "Identify after login", body: "Call identify as soon as the user logs in or signs up, and reset on logout." },
      { title: "Let the queue work", body: "Events are batched and sent in the background. Call flush only when you must, for example before a forced exit." },
      { title: "Send revenue from the server", body: "Payment confirmations belong in your backend with a secret key and the transaction id as event_id." },
      { title: "Keep the SDK updated", body: "Take new SDK versions when we release them: they carry fixes and new capabilities such as deep links." },
      { title: "Never ship a secret key", body: "Apps get the public key (la_pk_…) only. Secret keys stay on your servers." },
    ],
  },
  cta: { title: "Ready to connect your app?", lead: "Create a free account to get your keys, or write to us and we'll help your developers.", start: "Start free", contact: "Email us" },
  footer: { rights: "LeanApp", contact: "Contact", home: "Home" },
};

export type DevelopersCopy = typeof EN;

const AR: DevelopersCopy = {
  dir: "rtl",
  meta: {
    title: "LeanApp للمطوّرين: حزم SDK ودليل الإعداد",
    description: "حزم SDK من LeanApp لـ JavaScript و React Native و Android و iOS و Flutter: الإعداد، والأحداث، والمستخدمون، والموافقة، والاختبار، والـ REST API.",
  },
  nav: { home: "الرئيسية", developers: "للمطوّرين", sections: "الأقسام", other: "English", signIn: "تسجيل الدخول", start: "ابدأ مجانًا", dashboard: "افتح لوحة التحكم" },
  hero: {
    eyebrow: "للمطوّرين",
    title: "أضف LeanApp إلى تطبيقك",
    lead: "ترسل أربع حزم SDK وواجهة REST API أحداث تطبيقك إلى LeanApp. يشرح هذا الدليل أي حزمة تستخدم، وكيف تعدّها، وما الذي ترسله، وكيف تتحقق منه قبل الإطلاق.",
    status: "الحزم جاهزة ومختبرة في أنظمة الاختبار الآلي لدينا، لكنها غير منشورة بعد على مستودعات الحزم العامة. نسلّمها لفريقك أثناء الإعداد، وستعرض هذه الصفحة أمر التثبيت عند نشر كل حزمة.",
  },
  toc: "في هذه الصفحة",
  sections: {
    sdks: "حزم SDK",
    quickstart: "البدء السريع",
    code: "الشيفرة لكل منصة",
    events: "أسماء الأحداث وخطة التتبّع",
    identity: "المستخدمون: التعريف وتسجيل الخروج",
    consent: "الموافقة والخصوصية",
    delivery: "كيف تُرسل الأحداث",
    testing: "الاختبار قبل الإنتاج",
    "deep-links": "الروابط العميقة والإسناد",
    server: "من خوادمك: REST API",
    notes: "ملاحظات وتوصيات",
  },
  sdks: {
    lead: "حزمة لكل منصة، بأسماء الدوال نفسها والقواعد نفسها للطابور وإعادة المحاولة والجلسات. اختر الحزمة التي تناسب لغة تطبيقك.",
    labels: { pkg: "الحزمة", runsOn: "تعمل على", status: "الحالة", does: "ما تقوم به", notYet: "غير متوفر بعد", code: "اعرض الشيفرة", notPublished: "لم تُنشر بعد" },
    unpublished: "غير منشورة على {registry} بعد: نوفّرها لك أثناء الإعداد.",
    published: "منشورة على {registry}.",
    cards: {
      javascript: {
        runsOn: "متصفحات الويب و React Native وخوادم Node.js 18 فأحدث. بلا اعتماديات.",
        does: ["الأحداث والشاشات والمستخدمون والجلسات", "الموافقة لكل غرض (التحليلات، والتسويق، والإشعارات، والإسناد)", "بيانات الحملات من الروابط: معاملات utm_* ومعرّفات النقر الإعلانية", "طابور يعمل دون اتصال: localStorage في المتصفح و AsyncStorage في React Native"],
        notYet: ["مُحيل التثبيت من Google Play في React Native", "الحقل deep_link_url عند فتح التطبيق", "عرض الرسائل داخل التطبيق", "استدعاءات الروابط العميقة المؤجّلة"],
      },
      android: {
        runsOn: "Android 5.0 (المستوى 21) فأحدث. تعتمد فقط على مكتبة Play Install Referrer.",
        does: ["الأحداث والشاشات والمستخدمون والجلسات", "إرسال app_installed و app_updated و app_opened تلقائيًا", "مُحيل التثبيت من Google Play، يُقرأ مرة واحدة لكل تثبيت", "بيانات الحملة من الرابط الذي فتح التطبيق"],
        notYet: ["الموافقة لكل غرض (يتوفر optOut / optIn فقط)", "عرض الرسائل داخل التطبيق", "استدعاءات الروابط العميقة المؤجّلة"],
      },
      ios: {
        runsOn: "iOS 13 فأحدث (وكذلك macOS 10.15 و tvOS 13 فأحدث). بلا اعتماديات.",
        does: ["الأحداث والشاشات والمستخدمون والجلسات", "إرسال app_installed و app_updated و app_opened تلقائيًا", "رموز إشعارات APNs", "بيانات الحملة من الروابط العميقة والروابط العامة التي تمرّرها"],
        notYet: ["الموافقة لكل غرض (يتوفر optOut / optIn فقط)", "قيم التحويل في SKAdNetwork / AdAttributionKit", "عرض الرسائل داخل التطبيق", "استدعاءات الروابط العميقة المؤجّلة"],
      },
      flutter: {
        runsOn: "Flutter 3.13 فأحدث (Dart 3.1 فأحدث) على Android و iOS. تعتمد على http و shared_preferences.",
        does: ["الأحداث والشاشات والمستخدمون والجلسات", "إرسال app_installed و app_updated و app_opened تلقائيًا", "مُحيل التثبيت عبر إضافة مثل play_install_referrer", "بيانات الحملة من الروابط التي تمرّرها"],
        notYet: ["الموافقة لكل غرض (يتوفر optOut / optIn فقط)", "مُحيل التثبيت دون إضافة", "عرض الرسائل داخل التطبيق", "استدعاءات الروابط العميقة المؤجّلة"],
      },
    },
  },
  quickstart: {
    lead: "من مشروع فارغ إلى أول حدث، في خمس خطوات.",
    steps: [
      { title: "أنشئ مشروعك", body: "سجّل حسابًا وأنشئ تطبيقك. لكل مشروع ثلاث بيئات: التطوير، والاختبار، والإنتاج." },
      { title: "احصل على مفاتيحك", body: "افتح الإعدادات ← التطوير والتشغيل ← SDK ومفاتيح API. لكل بيئة مفتاح SDK عام خاص بها (la_pk_dev_… و la_pk_stg_… و la_pk_live_…)، فلا تختلط بيانات الاختبار ببيانات المستخدمين الحقيقيين." },
      { title: "أضف الحزمة وهيّئها", body: "هيّئ الحزمة مرة واحدة وفي أبكر وقت ممكن (Application.onCreate أو didFinishLaunching أو main())، بمفتاح التطوير أثناء البناء." },
      { title: "أرسل الأحداث الواردة في خطة التتبّع", body: "تعرض صفحة الإعدادات ← التطوير والتشغيل ← التنفيذ كل حدث يجب إرساله، وخصائصه، ومقتطف شيفرة لكل منها." },
      { title: "راقب وصولها", body: "تعرض صفحة الإعدادات ← التطوير والتشغيل ← مراقب الأحداث كل حدث لحظة وصوله، وتوضّح هل يطابق الخطة. لا تنتقل إلى مفتاح الإنتاج إلا بعد أن تصبح الأحداث سليمة." },
    ],
  },
  code: {
    lead: "الاستدعاءات نفسها على كل منصة. افتح المنصة لعرض الشيفرة الخاصة بها.",
    snippets: { setup: "الإضافة والتهيئة", usage: "الشاشات والأحداث والمستخدمون", more: "الروابط والخصوصية والإرسال" },
  },
  events: {
    lead: "الأسماء الواضحة تجعل كل تقرير أسهل قراءة. وخطة التتبّع التي نعدّها معك تتبع هذه القواعد أصلًا.",
    rules: [
      "استخدم صيغة snake_case: الكائن أولًا، ثم الفعل بصيغة الماضي، مثل product_viewed و order_completed.",
      "يبدأ الاسم بحرف، ولا يتجاوز 100 حرف.",
      "حدث واحد لكل واقعة تجارية. ضع الاختلافات في الخصائص (payment_method و source) لا في أسماء أحداث جديدة.",
      "المبالغ المالية: رقم في revenue أو value أو price، مع رمز عملة وفق ISO 4217 مثل SAR أو AED. الاسترداد حدث مستقل، وليس إيرادًا سالبًا.",
      "خصائص المستخدم تصف الشخص (المدينة، والباقة، واللغة). أما ما يتغير مع كل إجراء فمكانه خصائص الحدث.",
      "الأحداث غير الواردة في خطتك تُحفظ وتظهر على أنها غير مخطّط لها، مع اقتراحات لربطها بحدث مخطّط.",
    ],
    examplesTitle: "أمثلة",
    examples: {
      product_viewed: "فتح المستخدم صفحة منتج",
      checkout_started: "بدأ المستخدم إتمام الشراء",
      order_completed: "دُفع طلب، مع الإيراد والعملة",
      subscription_renewed: "جُدّد اشتراك (أرسله من خادمك)",
      refund_completed: "صُرف مبلغ مسترد (أرسله من خادمك)",
    },
  },
  identity: {
    lead: "قبل تسجيل الدخول تحمل الأحداث معرّفًا مجهولًا تنشئه الحزمة. عرّف المستخدم، فيربط LeanApp ما فعله قبل تسجيل الدخول وبعده.",
    points: [
      "استدعِ identify بمعرّف المستخدم الثابت الخاص بك فور تسجيل الدخول أو إنشاء الحساب، لا بالبريد الإلكتروني أو رقم الهاتف.",
      "مرّر سمات تصف الشخص (الباقة، والمدينة، واللغة). واستخدم setUserProperties لتحديثها دون تغيير المستخدم.",
      "استدعِ reset عند تسجيل الخروج، فيبدأ المستخدم التالي على الجهاز نفسه بمعرّف مجهول جديد.",
      "استخدم alias لدمج معرّف الزائر في حساب حقيقي إذا كان تطبيقك يتيح الشراء دون حساب.",
    ],
  },
  consent: {
    lead: "اطلب الموافقة حيث يفرضها القانون الذي يخضع له مستخدموك، وأبلغ LeanApp بالإجابة، فتطبّقها المنصة أيضًا.",
    purposesTitle: "الأغراض في حزمة JavaScript / React Native",
    purposes: {
      analytics: "track و screen و identify و alias. عند الرفض: تُحذف الأحداث على الجهاز ولا تُخزَّن على المنصة.",
      push: "registerPushToken. عند الرفض: يُستبعد المستخدم من الإشعارات.",
      attribution: "بيانات الحملة على الأحداث. عند الرفض: تُحذف على الجهاز وعند الاستقبال.",
      marketing: "لا شيء على الجهاز. عند الرفض: يُستبعد المستخدم من الرسائل التسويقية.",
    },
    points: [
      "في JavaScript / React Native: هيّئ الحزمة بالخيار consentDefault: \"pending\" لإبقاء الأحداث في الذاكرة حتى يجيب المستخدم، ثم استدعِ setConsent. تُحفظ الإجابة على الجهاز وتتبع المستخدم بعد تسجيل الدخول.",
      "في Android و iOS و Flutter: يوقف optOut() الإرسال ويستأنفه optIn(). أما الموافقة لكل غرض فلم تُبنَ في هذه الحزم بعد.",
      "لا تجمع أي حزمة معرّفات الإعلانات (IDFA و GAID) ولا Android ID ولا IDFV.",
      "طلبات تصدير البيانات وحذفها متاحة من لوحة التحكم ومن الـ API.",
    ],
  },
  delivery: {
    lead: "تعود الاستدعاءات فورًا ولا ترمي أخطاء بعد التهيئة: تضع الحزمة الأحداث في طابور وترسلها في الخلفية.",
    rows: [
      { topic: "الإرسال على دفعات", value: "كل 10 ثوانٍ أو عند تجمّع 20 حدثًا، وبحد أقصى 100 حدث في الطلب الواحد." },
      { topic: "دون اتصال", value: "يُحفظ الطابور على الجهاز (حتى 1,000 حدث، ويُحذف الأقدم أولًا) ويبقى بعد إعادة التشغيل. وتُحذف الأحداث التي مضى عليها أكثر من 7 أيام." },
      { topic: "في الخلفية", value: "يُرسل الطابور عند انتقال التطبيق إلى الخلفية: عند إخفاء الصفحة في المتصفح، وعبر appState في React Native، وعند توقف آخر نشاط في Android، وفي مهمة خلفية في iOS، وعند الإيقاف المؤقت في Flutter." },
      { topic: "إعادة المحاولة", value: "تُعاد المحاولة عند أخطاء الشبكة والخادم بفواصل متزايدة من ثانية واحدة إلى 5 دقائق. ولكل حدث معرّف، فلا يُحتسب مرتين عند إعادة المحاولة." },
      { topic: "مفتاح خاطئ أو ملغى", value: "تتوقف الحزمة عن الإرسال وتحتفظ بالأحداث على الجهاز، فلا يضيع شيء أثناء إصلاح المفتاح." },
      { topic: "الجلسات", value: "تبدأ جلسة جديدة بعد 30 دقيقة من عدم النشاط." },
    ],
  },
  testing: {
    lead: "تحقق من كل حدث في بيئة التطوير قبل الإطلاق للمستخدمين الحقيقيين.",
    steps: [
      "ابنِ التطبيق بمفتاح التطوير (la_pk_dev_…) وفعّل سجلّ التصحيح (debug: true) لترى ما تفعله الحزمة.",
      "افتح الإعدادات ← التطوير والتشغيل ← مراقب الأحداث في بيئة التطوير واستخدم التطبيق: يظهر كل حدث مباشرة مع أي أخطاء في التحقق.",
      "أصلح ما يظهره مراقب الأحداث حتى تصبح أحداث خطتك سليمة. ويوضّح مؤشر التنفيذ ما زال ناقصًا.",
      "كرّر ذلك في بيئة الاختبار إن وُجدت، ثم أطلق التطبيق بمفتاح الإنتاج (la_pk_live_…). بيانات التطوير لا تظهر أبدًا في تقارير الإنتاج.",
    ],
  },
  deepLinks: {
    lead: "تخبرك روابط التتبّع والروابط العميقة من LeanApp بالحملة التي جاءت بكل مستخدم. هذا ما تفعله الحزم اليوم.",
    points: [
      "تقرأ حزمة Android الرابط الذي فتح التطبيق تلقائيًا. أما في iOS و Flutter، وللروابط التي تصل أثناء تشغيل تطبيق Android، فمرّر الرابط إلى captureAttribution.",
      "تحتفظ captureAttribution بمعاملات utm_* ومعرّفات النقر (click_id و gclid و fbclid و ttclid و ScCid وغيرها): تُحفظ أول نقطة تواصل، وتُرسل آخر نقطة مع كل حدث.",
      "تقرأ حزمة Android مُحيل التثبيت من Google Play مرة واحدة لكل تثبيت، فتُطابَق التثبيتات القادمة من روابط LeanApp بدقة. وتحتاج Flutter إلى إضافة لذلك، ولا تقرؤه React Native بعد.",
      "الروابط العميقة المؤجّلة (فتح الشاشة الصحيحة بعد تثبيت جديد) لا تستدعيها الحزم بعد. واجهة الخادم متاحة بصورة تجريبية، وإلى أن تستخدمها الحزم يبقى التوجيه بعد التثبيت مسؤولية تطبيقك.",
      "فتح الشاشة الصحيحة عندما يكون التطبيق مثبّتًا مسبقًا يعود إلى طريقة معالجة تطبيقك للروابط.",
    ],
  },
  server: {
    lead: "أرسل الأحداث التي يعرفها خادمك أفضل من غيره، واقرأ البيانات من أدواتك، عبر الـ REST API.",
    points: [
      "استخدم المفتاح السري (la_sk_…) على الخوادم فقط. لا تضع مفتاحًا سريًا في تطبيق أبدًا: ترفض حزمة JavaScript استخدامه خارج الخادم.",
      "يرسل POST /v1/events حدثًا واحدًا، ويرسل POST /v1/events/batch حتى 500 حدث.",
      "أرسل المدفوعات والتجديدات والمبالغ المستردة من خادمك، مع معرّف المعاملة في event_id حتى لا يُحتسب شيء مرتين.",
      "للمفاتيح السرية صلاحيات لطلبات الخصوصية وخطة التتبّع والتقارير. اطلب منا مواصفات OpenAPI.",
    ],
  },
  notes: {
    items: [
      { title: "ابنِ بمفتاح التطوير", body: "استخدم la_pk_dev_… أثناء البناء والاختبار، ولا تستخدم مفتاح الإنتاج إلا في إصدارات النشر." },
      { title: "استخدم صيغة snake_case لأسماء الأحداث", body: "اتبع خطة التتبّع حرفيًا؛ فأي خطأ إملائي ينشئ حدثًا جديدًا غير مخطّط له." },
      { title: "لا بيانات شخصية في الخصائص", body: "لا ترسل الأسماء أو عناوين البريد الإلكتروني أو أرقام الهواتف أو أرقام الهوية في خصائص الأحداث. عرّف المستخدمين بمعرّفك الداخلي." },
      { title: "عرّف المستخدم بعد تسجيل الدخول", body: "استدعِ identify فور تسجيل الدخول أو إنشاء الحساب، و reset عند تسجيل الخروج." },
      { title: "دع الطابور يعمل", body: "تُجمَّع الأحداث وتُرسل في الخلفية. لا تستدعِ flush إلا عند الحاجة، مثلًا قبل إغلاق إجباري." },
      { title: "أرسل الإيرادات من الخادم", body: "تأكيدات الدفع مكانها خادمك، بمفتاح سري ومعرّف المعاملة في event_id." },
      { title: "حدّث الحزمة باستمرار", body: "اعتمد الإصدارات الجديدة عند صدورها، ففيها إصلاحات وقدرات جديدة مثل الروابط العميقة." },
      { title: "لا تضع مفتاحًا سريًا في تطبيق", body: "يحصل التطبيق على المفتاح العام (la_pk_…) فقط، وتبقى المفاتيح السرية على خوادمك." },
    ],
  },
  cta: { title: "هل أنت مستعد لربط تطبيقك؟", lead: "أنشئ حسابًا مجانيًا لتحصل على مفاتيحك، أو راسلنا لنساعد مطوّريك.", start: "ابدأ مجانًا", contact: "راسلنا" },
  footer: { rights: "LeanApp · لين آب", contact: "تواصل معنا", home: "الرئيسية" },
};

/** The developer guide copy for a language. */
export function developersCopy(lang: LandingLang): DevelopersCopy {
  return lang === "ar" ? AR : EN;
}

/** The status line of an SDK card: published, or available from us during onboarding. */
export function sdkStatus(lang: LandingLang, id: SdkId): string {
  const t = developersCopy(lang).sdks;
  return (sdkPublished(id) ? t.published : t.unpublished).replace("{registry}", SDK_FACTS[id].registry);
}

export { EXAMPLE_EVENTS, PURPOSES };
