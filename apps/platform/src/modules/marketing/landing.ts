/**
 * Landing page content in English and Arabic: the product flow and what is
 * live, in beta or coming, how we work, pricing, who we are and the FAQ.
 * Every label must match the product (landing.test.ts guards the claims that
 * were wrong before, in both languages). Pure.
 */

export type Availability = "live" | "beta" | "coming";
export type LandingLang = "en" | "ar";

export const AVAILABILITY_LABELS: Record<Availability, string> = { live: "Live", beta: "Beta", coming: "Coming" };
const AVAILABILITY_LABELS_AR: Record<Availability, string> = { live: "متاح", beta: "تجريبي", coming: "قريبًا" };

export interface FlowStep {
  step: string;
  title: string;
  body: string;
  items: { name: string; state: Availability; note?: string }[];
}

export const FLOW: FlowStep[] = [
  {
    step: "Connect",
    title: "Connect your app",
    body: "Answer a few questions about your business and get a tracking plan: the events to send, their properties and why each exists. Then add an SDK or call the REST API.",
    items: [
      { name: "Tracking plan from your business model", state: "live" },
      { name: "REST API for servers", state: "live" },
      { name: "JavaScript / React Native, Android, iOS and Flutter SDKs", state: "beta", note: "Built and tested; added from our repository until they are on npm, Maven Central, pub.dev and Swift Package Manager." },
    ],
  },
  {
    step: "Collect",
    title: "Collect clean events",
    body: "Every event is checked against your plan as it arrives. Development, staging and production have their own keys and never mix.",
    items: [
      { name: "Live event debugger and validation", state: "live" },
      { name: "Implementation score", state: "live" },
      { name: "Consent and privacy requests (export, deletion)", state: "live" },
    ],
  },
  {
    step: "Understand",
    title: "Understand what users do",
    body: "Trends, users and revenue on the events you already send, with dashboards you can start from a template.",
    items: [
      { name: "Overview, events and trends, users and their attributes", state: "live" },
      { name: "Revenue and activation", state: "live" },
      { name: "Dashboards and saved reports", state: "live" },
    ],
  },
  {
    step: "Funnels",
    title: "Find where people drop",
    body: "Build a funnel from any events, see conversion and drop-off between steps, split by platform or limited to an audience.",
    items: [{ name: "Funnels", state: "live" }],
  },
  {
    step: "Retention",
    title: "See who comes back",
    body: "Of the people who started on a given day, see how many came back N days later, for everyone or one audience.",
    items: [{ name: "Retention", state: "live" }],
  },
  {
    step: "Audiences",
    title: "Save who matters as an audience",
    body: "Define people by what they did and who they are once, then reuse the audience in reports, users, campaigns and flows.",
    items: [{ name: "Audiences", state: "live" }],
  },
  {
    step: "Act",
    title: "Act on it",
    body: "Send a campaign to an audience, or build a flow that reacts to what people do, with a conversion goal to check it worked.",
    items: [
      { name: "Campaigns and flows with goals", state: "live" },
      { name: "Push, email and WhatsApp", state: "live", note: "Through your own Firebase / APNs, Resend and WhatsApp Business accounts." },
      { name: "In-app messages", state: "beta", note: "Delivered by API; the SDKs don't display them yet." },
      { name: "Acquisition: sources, attribution, tracking links and QR codes", state: "beta", note: "Last-touch attribution from your own event stream. Not a full mobile measurement partner." },
      { name: "Deep links that open your app", state: "beta", note: "After a fresh install (deferred) only through our API for now." },
    ],
  },
];

/** The same flow in Arabic, step for step and item for item (landing.test.ts checks they line up). */
export const FLOW_AR: FlowStep[] = [
  {
    step: "اربط",
    title: "اربط تطبيقك",
    body: "جاوب على أسئلة قليلة عن نشاطك، وتحصل على خطة تتبّع جاهزة: الأحداث اللي ترسلها، وخصائصها، وسبب وجود كل واحد منها. بعدها أضف الـ SDK أو استخدم الـ REST API.",
    items: [
      { name: "خطة تتبّع مبنية على نموذج عملك", state: "live" },
      { name: "REST API للسيرفرات", state: "live" },
      { name: "SDKs لـ JavaScript / React Native و Android و iOS و Flutter", state: "beta", note: "جاهزة ومختبرة، وتُضاف من مستودعنا لحين نشرها على npm و Maven Central و pub.dev و Swift Package Manager." },
    ],
  },
  {
    step: "اجمع",
    title: "اجمع بيانات نظيفة",
    body: "كل حدث يتراجع على خطتك لحظة وصوله. بيئات التطوير والاختبار والإنتاج لكل منها مفاتيح خاصة ولا تختلط أبدًا.",
    items: [
      { name: "مراقبة الأحداث مباشرة والتحقق منها", state: "live" },
      { name: "تقييم جودة التنفيذ", state: "live" },
      { name: "الموافقة وطلبات الخصوصية (تصدير وحذف)", state: "live" },
    ],
  },
  {
    step: "افهم",
    title: "افهم سلوك المستخدمين",
    body: "الاتجاهات والمستخدمين والإيرادات من الأحداث اللي ترسلها أصلًا، مع لوحات تقارير تبدأها من قالب.",
    items: [
      { name: "نظرة عامة، الأحداث والاتجاهات، المستخدمين وخصائصهم", state: "live" },
      { name: "الإيرادات والتفعيل", state: "live" },
      { name: "لوحات التقارير والتقارير المحفوظة", state: "live" },
    ],
  },
  {
    step: "مسارات التحويل",
    title: "اعرف وين يتوقف الناس",
    body: "ابنِ مسار تحويل (Funnel) من أي أحداث، وشوف نسبة التحويل والتسرّب بين كل خطوة، مقسّمة حسب المنصة أو لجمهور معيّن.",
    items: [{ name: "مسارات التحويل (Funnels)", state: "live" }],
  },
  {
    step: "الاحتفاظ",
    title: "شوف مين يرجع",
    body: "من الناس اللي بدأوا في يوم معيّن، كم واحد رجع بعد N يوم، للكل أو لجمهور واحد.",
    items: [{ name: "الاحتفاظ (Retention)", state: "live" }],
  },
  {
    step: "الجماهير",
    title: "احفظ المهمّين كجمهور",
    body: "عرّف الناس مرة واحدة حسب اللي عملوه ومن هم، وبعدها استخدم الجمهور في التقارير والمستخدمين والحملات والتدفقات.",
    items: [{ name: "الجماهير (Audiences)", state: "live" }],
  },
  {
    step: "تحرّك",
    title: "تحرّك بناءً على البيانات",
    body: "أرسل حملة لجمهور، أو ابنِ تدفقًا يتفاعل مع تصرفات المستخدمين، مع هدف تحويل يقيس إذا نجح.",
    items: [
      { name: "حملات وتدفقات بأهداف", state: "live" },
      { name: "إشعارات Push وبريد إلكتروني وواتساب", state: "live", note: "من خلال حساباتك أنت على Firebase / APNs و Resend و WhatsApp Business." },
      { name: "رسائل داخل التطبيق", state: "beta", note: "تُرسل عبر الـ API، والـ SDKs لا تعرضها بعد." },
      { name: "الاستحواذ: المصادر والإسناد وروابط التتبّع و QR", state: "beta", note: "إسناد آخر نقرة من بيانات أحداثك. ليس شريك قياس كامل (MMP)." },
      { name: "روابط عميقة تفتح تطبيقك", state: "beta", note: "بعد التثبيت لأول مرة (المؤجّلة) عبر الـ API فقط حاليًا." },
    ],
  },
];

export const COMING: string[] = [
  "SDKs on public package registries",
  "In-app message display in the SDKs",
  "Deferred deep links in the SDKs",
  "Email delivery, open and click tracking",
  "The dashboard in Arabic",
];
const COMING_AR: string[] = [
  "نشر الـ SDKs على مستودعات الحزم العامة",
  "عرض الرسائل داخل التطبيق من الـ SDKs",
  "الروابط العميقة المؤجّلة في الـ SDKs",
  "تتبّع تسليم البريد وفتحه والنقر عليه",
  "لوحة التحكم باللغة العربية",
];

export const NOT_OFFERED =
  "Not offered: SMS, web push, A/B tests, predictive scores, ad cost import and ROAS, fraud prevention, data warehouse exports and SSO.";
const NOT_OFFERED_AR =
  "غير متوفر: الرسائل النصية SMS، إشعارات الويب، اختبارات A/B، التوقّعات الذكية، استيراد تكلفة الإعلانات و ROAS، منع الاحتيال، التصدير لمستودع بيانات، و SSO.";

/** A plan card. Limits mirror the seeded plans (db/migrations/0001_foundation.sql); prices are the introductory list prices. */
export interface Plan {
  id: "free" | "starter" | "growth" | "pro";
  price: number;
  events: string;
  apps: string;
  seats: string;
  history: string;
  featured?: boolean;
}

const PLANS_EN: Plan[] = [
  { id: "free", price: 0, events: "100K events / month", apps: "1 app", seats: "3 teammates", history: "30 days of history" },
  { id: "starter", price: 49, events: "2M events / month", apps: "3 apps", seats: "10 teammates", history: "6 months of history" },
  { id: "growth", price: 199, events: "20M events / month", apps: "10 apps", seats: "25 teammates", history: "1 year of history", featured: true },
  { id: "pro", price: 499, events: "100M events / month", apps: "Unlimited apps", seats: "Unlimited teammates", history: "2 years of history" },
];
const PLANS_AR: Plan[] = [
  { id: "free", price: 0, events: "100 ألف حدث شهريًا", apps: "تطبيق واحد", seats: "3 أعضاء فريق", history: "بيانات آخر 30 يوم" },
  { id: "starter", price: 49, events: "2 مليون حدث شهريًا", apps: "3 تطبيقات", seats: "10 أعضاء فريق", history: "بيانات آخر 6 شهور" },
  { id: "growth", price: 199, events: "20 مليون حدث شهريًا", apps: "10 تطبيقات", seats: "25 عضو فريق", history: "بيانات آخر سنة", featured: true },
  { id: "pro", price: 499, events: "100 مليون حدث شهريًا", apps: "تطبيقات بلا حدود", seats: "أعضاء بلا حدود", history: "بيانات آخر سنتين" },
];

/** How a product covers a need in the comparison table. */
export type Coverage = "yes" | "beta" | "partial" | "no";
export const COMPETITORS = ["LeanApp", "Mixpanel", "Adjust", "MoEngage"] as const;

export interface CompareRow {
  need: string;
  /** In COMPETITORS order. */
  cells: [Coverage, Coverage, Coverage, Coverage];
}

/**
 * The comparison with Mixpanel, Adjust and MoEngage, from each product's public
 * website. Kept conservative on purpose: what we lack (fraud prevention, ad
 * cost and ROAS, a full MMP) is in the table too. Same rows in both languages.
 */
const COMPARE_CELLS: CompareRow["cells"][] = [
  ["yes", "yes", "partial", "yes"], // events, funnels, retention
  ["yes", "no", "no", "yes"], // push, email, WhatsApp
  ["beta", "no", "yes", "partial"], // install attribution
  ["yes", "no", "no", "no"], // tracking plan from your business
  ["no", "no", "yes", "no"], // fraud prevention, ad cost & ROAS
];
const COMPARE_NEEDS_EN = [
  "Events, funnels and retention",
  "Push, email and WhatsApp campaigns",
  "Install attribution (sources and campaigns)",
  "Tracking plan built from your business model",
  "Ad fraud prevention, ad cost and ROAS",
];
const COMPARE_NEEDS_AR = [
  "الأحداث ومسارات التحويل والاحتفاظ",
  "حملات إشعارات وبريد وواتساب",
  "إسناد التثبيتات (المصادر والحملات)",
  "خطة تتبّع مبنية على نموذج عملك",
  "منع احتيال الإعلانات وتكلفة الإعلانات و ROAS",
];
export const COMPARE_EN: CompareRow[] = COMPARE_CELLS.map((cells, i) => ({ need: COMPARE_NEEDS_EN[i], cells }));
export const COMPARE_AR: CompareRow[] = COMPARE_CELLS.map((cells, i) => ({ need: COMPARE_NEEDS_AR[i], cells }));

export const CONTACT_EMAIL = "hello@leanapp.io";

const EN = {
  dir: "ltr" as "ltr" | "rtl",
  nav: { demo: "Demo", how: "How we work", compare: "Compare", pricing: "Pricing", about: "About us", signIn: "Sign in", start: "Start free", dashboard: "Open dashboard", other: "العربية" },
  hero: {
    eyebrow: "Product analytics for mobile apps in the Arab world",
    title: "Know your users. Grow your app.",
    lead: "See who installs, where they drop off and who comes back, then reach them with push, email and WhatsApp. One SDK, support in Arabic and English, priced for growing teams.",
    demo: "Try the live demo",
    start: "Start free",
    note: "No card needed. The demo opens a sample food delivery app, read-only.",
  },
  flowLabel: "Product flow",
  demo: {
    title: "See it with real-looking data",
    lead: "The demo is a food delivery app in Saudi Arabia with 30 days of sample users. Click around: it is read-only, so nothing you do changes it.",
    shots: [
      { src: "/landing/overview.png", caption: "Overview: active and new users and events, compared with the previous week." },
      { src: "/landing/funnel.png", caption: "Funnels: where people drop between viewing a restaurant and ordering, and who they are." },
      { src: "/landing/retention.png", caption: "Retention: how many come back on day 1, 3 and 7 after installing." },
      { src: "/landing/revenue.png", caption: "Revenue: orders in SAR, paying people and revenue per user, day by day." },
    ],
    cta: "Open the live demo",
  },
  how: {
    title: "How we work",
    lead: "From the first call to your first decision, in four steps. We set it up with you, in Arabic or English.",
    steps: [
      { title: "We learn your business", body: "Tell us what you sell and how users pay. We turn it into a tracking plan: which events matter and why." },
      { title: "You connect your app", body: "Add the SDK or call the API, with separate keys for development, staging and production. We help your developers on the way." },
      { title: "We check the data", body: "Every event is validated against the plan as it arrives, and the implementation score tells you what is missing." },
      { title: "You act on it", body: "Funnels, retention and revenue show what to fix. Audiences and campaigns let you reach the right people." },
    ],
  },
  features: { title: "What's in it", lead: "Each item says plainly whether it is live, in beta or still coming.", coming: "Coming next" },
  compare: {
    title: "LeanApp vs Mixpanel, Adjust and MoEngage",
    lead: "Most app teams in the region pay for an analytics tool, an attribution tool and a messaging tool. LeanApp gives you analytics and messaging in one place, priced for growing apps, with a team that speaks Arabic.",
    need: "What you need",
    labels: { yes: "Yes", beta: "Beta", partial: "Partly", no: "No" } as Record<Coverage, string>,
    value: [
      { title: "One tool instead of three", body: "Understand users and reach them from the same data, without syncing audiences between products." },
      { title: "Priced for the region", body: "Start free and grow from $49 a month, instead of enterprise contracts sized for global apps." },
      { title: "Set up with you", body: "We build your tracking plan with you and help your developers, in Arabic or English." },
    ],
    honest: "Need fraud prevention or ad spend and ROAS? Those need a full attribution partner like Adjust, which works alongside LeanApp.",
    source: "Based on each product's public website, October 2026. Mixpanel, Adjust and MoEngage are trademarks of their owners.",
  },
  pricing: {
    title: "Pricing",
    lead: "Start free. Upgrade when your app grows. Prices in US dollars, billed monthly.",
    month: "/ month",
    free: "Free",
    start: "Start free",
    contact: "Talk to us",
    popular: "Most popular",
    all: "Every plan has all the features above, support in Arabic and English, and separate development, staging and production.",
    enterprise: "More than 100M events, or need a contract and invoices in your currency?",
    enterpriseCta: "Contact us for Enterprise",
    names: { free: "Free", starter: "Starter", growth: "Growth", pro: "Pro" } as Record<Plan["id"], string>,
    plans: PLANS_EN,
  },
  about: {
    title: "Who we are",
    body: [
      "LeanApp is a small team building the analytics and growth tools we wanted for apps in our region: built for Arabic from day one, with clear prices, and without needing five tools to learn what your users do.",
      "We are starting with app teams in Saudi Arabia, the Gulf and Egypt, and we work directly with our first customers to shape what comes next.",
    ],
    values: [
      { title: "Arabic first", body: "Onboarding and support in Arabic, and Arabic messages to your users. The dashboard in Arabic is coming." },
      { title: "Your data stays yours", body: "Each customer's data is separated at the database level. Export or delete it any time." },
      { title: "Honest about what's ready", body: "We label what is live, in beta and coming, and never sell what doesn't exist." },
    ],
  },
  faq: {
    title: "Questions",
    items: [
      { q: "Do I need a developer?", a: "Yes, to add the SDK to your app once. We give them a plan with each event, and the live debugger shows if it's right." },
      { q: "Which platforms do you support?", a: "Android, iOS, Flutter, React Native and JavaScript, plus a REST API for your servers." },
      { q: "Where is my data stored?", a: "In a dedicated database for LeanApp, separated per customer. Ask us for the region if your company needs it." },
      { q: "Is the demo real?", a: "No. It's generated sample data for a made-up food delivery app, so you can try every report safely." },
    ],
  },
  cta: { title: "Ready to see your own app?", lead: "Create a free account and send your first event today.", start: "Start free", demo: "Try the demo first" },
  footer: { rights: "LeanApp", contact: "Contact" },
};

export type LandingCopy = typeof EN & { compareRows: CompareRow[]; flow: FlowStep[]; coming: string[]; notOffered: string; states: Record<Availability, string> };

const AR: typeof EN = {
  dir: "rtl",
  nav: { demo: "الديمو", how: "طريقة عملنا", compare: "المقارنة", pricing: "الأسعار", about: "من نحن", signIn: "تسجيل الدخول", start: "ابدأ مجانًا", dashboard: "افتح لوحة التحكم", other: "English" },
  hero: {
    eyebrow: "تحليلات تطبيقات الجوال للعالم العربي",
    title: "اعرف مستخدمينك، وكبّر تطبيقك.",
    lead: "شوف مين ثبّت التطبيق، ووين يتوقف، ومين يرجع، وبعدها تواصل معاهم بالإشعارات والبريد وواتساب. SDK واحد، ودعم بالعربي والإنجليزي، وبأسعار مناسبة للفرق الناشئة.",
    demo: "جرّب الديمو المباشر",
    start: "ابدأ مجانًا",
    note: "بدون بطاقة. الديمو يفتح تطبيق توصيل طعام تجريبي، للعرض فقط.",
  },
  flowLabel: "رحلة المنتج",
  demo: {
    title: "شوفه ببيانات قريبة من الحقيقة",
    lead: "الديمو تطبيق توصيل طعام في السعودية فيه مستخدمين تجريبيين لآخر 30 يوم. تنقّل براحتك، ولا شيء تعمله يغيّر البيانات.",
    shots: [
      { src: "/landing/overview.png", caption: "النظرة العامة: المستخدمين النشطين والجدد والأحداث، مقارنة بالأسبوع السابق." },
      { src: "/landing/funnel.png", caption: "مسارات التحويل: وين يتوقف الناس بين فتح المطعم وإتمام الطلب، ومين هم." },
      { src: "/landing/retention.png", caption: "الاحتفاظ: كم واحد يرجع بعد يوم و3 أيام و7 أيام من التثبيت." },
      { src: "/landing/revenue.png", caption: "الإيرادات: الطلبات بالريال، وعدد الدافعين، والإيراد لكل مستخدم يومًا بيوم." },
    ],
    cta: "افتح الديمو المباشر",
  },
  how: {
    title: "طريقة عملنا",
    lead: "من أول مكالمة لأول قرار، في أربع خطوات. نجهّزها معك بالعربي أو الإنجليزي.",
    steps: [
      { title: "نفهم نشاطك", body: "قول لنا وش تبيع وكيف يدفع المستخدم. نحوّلها لخطة تتبّع: أي أحداث مهمة وليش." },
      { title: "تربط تطبيقك", body: "أضف الـ SDK أو استخدم الـ API، بمفاتيح منفصلة للتطوير والاختبار والإنتاج. ونساعد المطوّرين عندك خطوة بخطوة." },
      { title: "نتأكد من البيانات", body: "كل حدث يتراجع على الخطة لحظة وصوله، وتقييم التنفيذ يقولك وش الناقص." },
      { title: "تتحرّك بناءً عليها", body: "مسارات التحويل والاحتفاظ والإيرادات توضّح وش تصلّح. والجماهير والحملات توصلك للناس الصح." },
    ],
  },
  features: { title: "وش فيه", lead: "كل ميزة مكتوب جنبها بوضوح إذا كانت متاحة أو تجريبية أو قريبًا.", coming: "قريبًا" },
  compare: {
    title: "LeanApp مقارنة بـ Mixpanel و Adjust و MoEngage",
    lead: "أغلب فرق التطبيقات في المنطقة تدفع لأداة تحليلات، وأداة إسناد، وأداة رسائل. LeanApp يجمع التحليلات والرسائل في مكان واحد، بأسعار مناسبة للتطبيقات النامية، ومع فريق يتكلم عربي.",
    need: "اللي تحتاجه",
    labels: { yes: "نعم", beta: "تجريبي", partial: "جزئيًا", no: "لا" },
    value: [
      { title: "أداة واحدة بدل ثلاث", body: "افهم المستخدمين وتواصل معهم من نفس البيانات، بدون مزامنة الجماهير بين أكثر من منتج." },
      { title: "أسعار مناسبة للمنطقة", body: "ابدأ مجانًا وكبّر من 49$ شهريًا، بدل عقود الشركات المصممة للتطبيقات العالمية." },
      { title: "نجهّزه معك", body: "نبني خطة التتبّع معك ونساعد المطوّرين عندك، بالعربي أو الإنجليزي." },
    ],
    honest: "تحتاج منع الاحتيال أو تكلفة الإعلانات و ROAS؟ هذي تحتاج شريك إسناد كامل مثل Adjust، ويشتغل جنب LeanApp عادي.",
    source: "حسب المواقع الرسمية لكل منتج، أكتوبر 2026. Mixpanel و Adjust و MoEngage علامات تجارية لأصحابها.",
  },
  pricing: {
    title: "الأسعار",
    lead: "ابدأ مجانًا، وطوّر باقتك لما يكبر تطبيقك. الأسعار بالدولار الأمريكي، شهريًا.",
    month: "/ شهريًا",
    free: "مجانًا",
    start: "ابدأ مجانًا",
    contact: "تواصل معنا",
    popular: "الأكثر طلبًا",
    all: "كل الباقات فيها كل الميزات أعلاه، ودعم بالعربي والإنجليزي، وبيئات منفصلة للتطوير والاختبار والإنتاج.",
    enterprise: "أكثر من 100 مليون حدث، أو تحتاج عقد وفواتير بعملتك؟",
    enterpriseCta: "تواصل معنا لباقة الشركات",
    names: { free: "مجاني", starter: "البداية", growth: "النمو", pro: "الاحترافي" },
    plans: PLANS_AR,
  },
  about: {
    title: "من نحن",
    body: [
      "LeanApp فريق صغير يبني أدوات التحليلات والنمو اللي كنا نتمناها لتطبيقات منطقتنا: مصممة للعربي من أول يوم، بأسعار واضحة، وبدون ما تحتاج خمس أدوات عشان تعرف وش يسوي مستخدمينك.",
      "نبدأ مع فرق التطبيقات في السعودية والخليج ومصر، ونشتغل مباشرة مع أول عملائنا عشان نحدد مع بعض الخطوة الجاية.",
    ],
    values: [
      { title: "العربي أولًا", body: "تجهيز ودعم بالعربي، ورسائل عربية لمستخدمينك. ولوحة التحكم بالعربي قريبًا." },
      { title: "بياناتك ملكك", body: "بيانات كل عميل منفصلة على مستوى قاعدة البيانات. صدّرها أو احذفها وقت ما تبي." },
      { title: "صريحين في الجاهز", body: "نوضّح وش المتاح والتجريبي والقادم، وما نبيع شي غير موجود." },
    ],
  },
  faq: {
    title: "أسئلة شائعة",
    items: [
      { q: "هل أحتاج مطوّر؟", a: "نعم، مرة واحدة لإضافة الـ SDK للتطبيق. نعطيه خطة فيها كل حدث، ومراقب الأحداث المباشر يوضّح إذا التنفيذ صحيح." },
      { q: "وش المنصات المدعومة؟", a: "Android و iOS و Flutter و React Native و JavaScript، بالإضافة لـ REST API للسيرفرات." },
      { q: "وين تتخزّن بياناتي؟", a: "في قاعدة بيانات مخصصة لـ LeanApp، ومنفصلة لكل عميل. اسألنا عن المنطقة إذا شركتك تحتاجها." },
      { q: "هل الديمو حقيقي؟", a: "لا. بيانات تجريبية لتطبيق توصيل طعام وهمي، عشان تجرب كل التقارير بأمان." },
    ],
  },
  cta: { title: "جاهز تشوف تطبيقك؟", lead: "سجّل حساب مجاني وأرسل أول حدث اليوم.", start: "ابدأ مجانًا", demo: "جرّب الديمو أولًا" },
  footer: { rights: "LeanApp · لين آب", contact: "تواصل" },
};

/** The landing copy for a language. */
export function landingCopy(lang: LandingLang): LandingCopy {
  return lang === "ar"
    ? { ...AR, compareRows: COMPARE_AR, flow: FLOW_AR, coming: COMING_AR, notOffered: NOT_OFFERED_AR, states: AVAILABILITY_LABELS_AR }
    : { ...EN, compareRows: COMPARE_EN, flow: FLOW, coming: COMING, notOffered: NOT_OFFERED, states: AVAILABILITY_LABELS };
}

/**
 * The landing page language: `?lang=` first, then the browser's preferred
 * language. Arabic is the default because the Arab market comes first; an
 * English-first browser gets English.
 */
export function landingLang(param: string | string[] | undefined, acceptLanguage: string | null): LandingLang {
  const p = Array.isArray(param) ? param[0] : param;
  if (p === "ar" || p === "en") return p;
  const first = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("en") ? "en" : "ar";
}
