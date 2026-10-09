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
    body: "Answer a few questions and get a tracking plan: which events to send, with what properties, and why. Then add an SDK or the REST API.",
    items: [
      { name: "Tracking plan for your business", state: "live" },
      { name: "REST API for servers", state: "live" },
      { name: "JavaScript / React Native, Android, iOS and Flutter SDKs", state: "beta", note: "Built and tested; provided at onboarding until they are on npm, Maven Central, pub.dev and Swift Package Manager." },
    ],
  },
  {
    step: "Collect",
    title: "Collect clean events",
    body: "Every event is checked against your plan on arrival. Development, staging and production each have their own keys, so they never mix.",
    items: [
      { name: "Live event debugger and validation", state: "live" },
      { name: "Implementation score", state: "live" },
      { name: "Consent, data export and deletion", state: "live" },
    ],
  },
  {
    step: "Understand",
    title: "Understand what users do",
    body: "Trends, users and revenue from the events you already send, with dashboards that you can start from a ready-made template.",
    items: [
      { name: "Overview, trends and users", state: "live" },
      { name: "Revenue and activation", state: "live" },
      { name: "Dashboards and saved reports", state: "live" },
    ],
  },
  {
    step: "Funnels",
    title: "Find where people drop",
    body: "Build a funnel from any events and see the conversion and drop-off between steps, split by platform or limited to one audience.",
    items: [{ name: "Funnels", state: "live" }],
  },
  {
    step: "Retention",
    title: "See who comes back",
    body: "Of the people who started on a given day, see how many came back N days later, either for all your users or for one chosen audience.",
    items: [{ name: "Retention", state: "live" }],
  },
  {
    step: "Audiences",
    title: "Save the people who matter",
    body: "Define people once by what they did and who they are, then reuse that audience across your reports, users, campaigns and flows.",
    items: [{ name: "Audiences", state: "live" }],
  },
  {
    step: "Act",
    title: "Act on it",
    body: "Send a campaign to an audience or build a flow that reacts to what people do, then let a conversion goal show you whether it worked.",
    items: [
      { name: "Campaigns and flows with goals", state: "live" },
      { name: "Push, email and WhatsApp", state: "live", note: "Sent through your own Firebase / APNs, Resend and WhatsApp Business accounts, so your users see your name." },
      { name: "In-app messages", state: "beta", note: "Delivered through the API for now; the SDKs don't display them yet." },
      { name: "Acquisition: sources, attribution, tracking links and QR codes", state: "beta", note: "Last-touch attribution built from your own event stream. Not a full mobile measurement partner (MMP)." },
      { name: "Deep links that open your app", state: "beta", note: "Deferred links after a fresh install work only through our API for now." },
    ],
  },
];

/** The same flow in Arabic, step for step and item for item (landing.test.ts checks they line up). */
export const FLOW_AR: FlowStep[] = [
  {
    step: "اربط",
    title: "اربط تطبيقك",
    body: "أجب عن أسئلة قليلة حول نشاطك، واحصل على خطة تتبّع: الأحداث التي ترسلها، وخصائصها، وسبب وجود كل منها. ثم أضف الـ SDK أو الـ REST API.",
    items: [
      { name: "خطة تتبّع مبنية على نموذج عملك", state: "live" },
      { name: "REST API للخوادم", state: "live" },
      { name: "حزم SDK لـ JavaScript / React Native و Android و iOS و Flutter", state: "beta", note: "جاهزة ومختبرة، ونوفّرها لك أثناء الإعداد إلى أن تُنشر على npm و Maven Central و pub.dev و Swift Package Manager." },
    ],
  },
  {
    step: "اجمع",
    title: "اجمع بيانات نظيفة",
    body: "يُراجَع كل حدث على خطتك لحظة وصوله. ولكل من بيئات التطوير والاختبار والإنتاج مفاتيح منفصلة خاصة بها، فلا تختلط بيانات إحداها بالأخرى.",
    items: [
      { name: "مراقبة الأحداث مباشرة والتحقق منها", state: "live" },
      { name: "تقييم جودة التنفيذ", state: "live" },
      { name: "الموافقة وتصدير البيانات وحذفها", state: "live" },
    ],
  },
  {
    step: "افهم",
    title: "افهم سلوك المستخدمين",
    body: "اطّلع على الاتجاهات والمستخدمين والإيرادات من الأحداث التي ترسلها بالفعل، مع لوحات متابعة جاهزة يمكنك أن تبدأها من قالب وتعدّلها كما تشاء.",
    items: [
      { name: "النظرة العامة والاتجاهات والمستخدمون", state: "live" },
      { name: "الإيرادات والتفعيل", state: "live" },
      { name: "لوحات المتابعة والتقارير المحفوظة", state: "live" },
    ],
  },
  {
    step: "مسارات التحويل",
    title: "اعرف أين يتوقف المستخدمون",
    body: "ابنِ مسار تحويل من أي أحداث تختارها، واطّلع على نسبة التحويل والتسرّب بين كل خطوة وأخرى، مقسّمة حسب المنصة أو محصورة في جمهور محدد.",
    items: [{ name: "مسارات التحويل (Funnels)", state: "live" }],
  },
  {
    step: "الاحتفاظ",
    title: "اعرف من يعود",
    body: "من بين من بدأوا في يوم معيّن، كم منهم عاد بعد N يومًا، سواء للجميع أو لجمهور واحد.",
    items: [{ name: "الاحتفاظ (Retention)", state: "live" }],
  },
  {
    step: "الجماهير",
    title: "احفظ الفئات المهمة كجمهور",
    body: "عرّف المستخدمين مرة واحدة بحسب ما فعلوه ومن هم، ثم استخدم هذا الجمهور كما هو في التقارير وصفحة المستخدمين والحملات والتدفقات.",
    items: [{ name: "الجماهير (Audiences)", state: "live" }],
  },
  {
    step: "تحرّك",
    title: "تحرّك بناءً على البيانات",
    body: "أرسل حملة إلى جمهور محدد، أو ابنِ تدفقًا يستجيب لما يفعله المستخدمون، مع هدف تحويل يقيس النتيجة ويوضّح لك ما إذا كانت الحملة قد نجحت.",
    items: [
      { name: "حملات وتدفقات بأهداف", state: "live" },
      { name: "إشعارات Push والبريد الإلكتروني وواتساب", state: "live", note: "تُرسل عبر حساباتك الخاصة على Firebase / APNs و Resend و WhatsApp Business، فتصل الرسائل إلى مستخدميك باسمك أنت." },
      { name: "رسائل داخل التطبيق", state: "beta", note: "تُرسل عبر الـ API، ولا تعرضها حزم الـ SDK بعد." },
      { name: "الاستحواذ: المصادر والإسناد وروابط التتبّع ورموز QR", state: "beta", note: "إسناد آخر نقرة من بيانات أحداثك. وهو ليس شريك قياس كاملًا (MMP)." },
      { name: "روابط عميقة تفتح تطبيقك", state: "beta", note: "الروابط المؤجّلة بعد التثبيت لأول مرة متاحة حاليًا عبر الـ API الخاص بنا فقط." },
    ],
  },
];

export const COMING: string[] = [
  "SDKs on public package registries",
  "In-app message display in the SDKs",
  "Deferred deep links in the SDKs",
  "Email opens, clicks and delivery",
];
const COMING_AR: string[] = [
  "نشر الـ SDKs على مستودعات الحزم العامة",
  "عرض الرسائل داخل التطبيق من الـ SDKs",
  "الروابط العميقة المؤجّلة في الـ SDKs",
  "تتبّع تسليم البريد وفتحه والنقر عليه",
];

export const NOT_OFFERED =
  "Not offered: SMS, web push, A/B tests, predictive scores, importing ad cost and ROAS, fraud prevention, exports to a data warehouse, and single sign-on (SSO). If your team needs one of these, please tell us before you start.";
const NOT_OFFERED_AR =
  "غير متوفر: الرسائل النصية SMS، إشعارات الويب، اختبارات A/B، التوقّعات الذكية، استيراد تكلفة الإعلانات و ROAS، منع الاحتيال، التصدير لمستودع بيانات، والدخول الموحّد SSO. إذا كان فريقك يحتاج إلى إحداها، فأخبرنا قبل أن تبدأ.";

/** A plan card. Starter and Growth are self-serve with a monthly price; Enterprise is priced on a call. */
export interface Plan {
  id: "starter" | "growth" | "enterprise";
  /** US dollars a month; Growth's is a starting price that grows with usage. null = priced with sales. */
  price: number | null;
  from?: boolean;
  tagline: string;
  features: string[];
  limits: string;
  featured?: boolean;
}

const PLANS_EN: Plan[] = [
  {
    id: "starter",
    price: 49,
    tagline: "For new apps",
    features: ["Core analytics and event tracking", "Basic funnels and retention", "Limited integrations and usage"],
    limits: "2M events / month and up to 3 apps. Free up to 100K events.",
  },
  {
    id: "growth",
    price: 199,
    from: true,
    tagline: "For growing apps",
    features: ["Advanced analytics and cohorts", "Growth playbooks (experiments coming soon)", "More integrations and automation"],
    limits: "From 20M events / month. The price follows your usage.",
    featured: true,
  },
  {
    id: "enterprise",
    price: null,
    tagline: "For larger organizations",
    features: ["Custom usage and data requirements", "Advanced access controls and governance", "Dedicated support and commercial terms"],
    limits: "A call with our team and a price made for your app's usage.",
  },
];
const PLANS_AR: Plan[] = [
  {
    id: "starter",
    price: 49,
    tagline: "للتطبيقات الجديدة",
    features: ["التحليلات الأساسية وتتبّع الأحداث", "مسارات التحويل والاحتفاظ الأساسية", "تكاملات واستخدام محدودان"],
    limits: "2 مليون حدث شهريًا، وحتى 3 تطبيقات. مجانًا حتى 100 ألف حدث.",
  },
  {
    id: "growth",
    price: 199,
    from: true,
    tagline: "للتطبيقات التي تنمو",
    features: ["تحليلات متقدمة وشرائح المستخدمين", "خطط نمو جاهزة (التجارب قريبًا)", "تكاملات وأتمتة أكثر"],
    limits: "من 20 مليون حدث شهريًا، ويتغيّر السعر حسب حجم استخدامك.",
    featured: true,
  },
  {
    id: "enterprise",
    price: null,
    tagline: "للمؤسسات الكبيرة",
    features: ["استخدام ومتطلبات بيانات مخصصة", "صلاحيات وحوكمة متقدمة", "دعم مخصص وشروط تجارية"],
    limits: "مكالمة مع فريقنا، ثم نقدّم لك سعرًا مخصصًا لحجم استخدامك.",
  },
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
  nav: { demo: "Demo", how: "How we work", compare: "Compare", pricing: "Pricing", about: "About us", developers: "Developers", signIn: "Sign in", start: "Start free", dashboard: "Open dashboard", other: "العربية" },
  hero: {
    eyebrow: "Mobile app analytics for the Arab world",
    title: "Know your users. Grow your app.",
    lead: "See who installs, where they drop off and who comes back, then reach them with push, email and WhatsApp. One SDK, support in Arabic and English, priced for growing teams.",
    demo: "Try the live demo",
    start: "Start free",
    note: "No card needed. The demo opens a sample food delivery app that you can explore but not change.",
  },
  flowLabel: "Product flow",
  demo: {
    title: "See it with real-looking data",
    lead: "The demo is a food delivery app with 30 days of sample users. Click around as much as you like: it is read-only, so nothing you do there changes its data.",
    shots: [
      { src: "/landing/overview.png", caption: "Overview: active and new users and events versus last week." },
      { src: "/landing/funnel.png", caption: "Funnels: where people drop off before ordering, and who." },
      { src: "/landing/retention.png", caption: "Retention: how many return on day 1, 3 and 7 after install." },
      { src: "/landing/revenue.png", caption: "Revenue: daily orders, paying people and revenue per user." },
    ],
    cta: "Open the live demo",
  },
  how: {
    title: "How we work",
    lead: "From the first call to your first decision, in four steps. We set it up with you, in Arabic or English.",
    steps: [
      { title: "We learn your business", body: "Tell us what you sell and how users pay. We turn it into a tracking plan: which events matter and why." },
      { title: "You connect your app", body: "Add the SDK or call the API, with separate keys per environment. We help your developers on the way." },
      { title: "We check the data", body: "Every event is checked against the plan as it arrives. The implementation score shows what is missing." },
      { title: "You act on it", body: "Funnels, retention and revenue show what to fix. Audiences and campaigns reach the right people." },
    ],
  },
  features: { title: "What's in it", lead: "Each item is marked as live, in beta or coming.", coming: "Coming next" },
  compare: {
    title: "How LeanApp compares",
    lead: "Most app teams in the region pay for three tools: analytics, attribution and messaging. LeanApp gives you analytics and messaging in one place, priced for growing apps, with a team that speaks Arabic.",
    need: "What you need",
    labels: { yes: "Yes", beta: "Beta", partial: "Partly", no: "No" } as Record<Coverage, string>,
    value: [
      { title: "One tool instead of three", body: "Understand and reach users from the same data, without syncing audiences between products." },
      { title: "Priced for the region", body: "Start free and grow from $49 a month, instead of enterprise contracts sized for global apps." },
      { title: "Set up with you", body: "We build your tracking plan with you and help your developers, in Arabic or English." },
    ],
    honest: "Need fraud prevention, or ad spend and ROAS? For those, use a full attribution partner like Adjust alongside LeanApp.",
    source: "Based on each product's public website, October 2026. Mixpanel, Adjust and MoEngage are trademarks of their owners.",
  },
  pricing: {
    title: "Pricing",
    lead: "Clear monthly prices you can start on yourself, or a custom plan for larger teams. Prices in US dollars.",
    month: "/ month",
    free: "Free",
    start: "Start free",
    contact: "Contact sales",
    custom: "Custom",
    from: "from",
    popular: "Most popular",
    all: "Every plan has support in Arabic and English, and separate development, staging and production.",
    names: { starter: "Starter", growth: "Growth", enterprise: "Enterprise" } as Record<Plan["id"], string>,
    plans: PLANS_EN,
  },
  about: {
    title: "Who we are",
    body: [
      "LeanApp is a small team building the analytics and growth tools we wanted for apps in our region: made for Arabic from day one, with clear prices, and with no need for five tools to see what your users do.",
      "We are starting with app teams across the Arab world, and we work directly with our first customers to shape what comes next.",
    ],
    values: [
      { title: "Arabic first", body: "A dashboard in Arabic and English, and onboarding, support and messages in Arabic." },
      { title: "Your data stays yours", body: "Each customer's data is separated at the database level. Export or delete it any time." },
      { title: "Honest about what's ready", body: "We label what is live, in beta and coming, and we never sell what doesn't exist." },
    ],
  },
  faq: {
    title: "Questions",
    items: [
      { q: "Do I need a developer?", a: "Yes, once, to add the SDK. We give them a plan of each event, and the live debugger shows if it's right." },
      { q: "Which platforms do you support?", a: "Android, iOS, Flutter, React Native and JavaScript, plus a REST API for your servers." },
      { q: "Where is my data stored?", a: "In a dedicated database for LeanApp, separated per customer. Ask us for its region if you need it." },
      { q: "Is the demo real?", a: "No. It's generated sample data for a made-up food delivery app, so you can try every report safely." },
    ],
  },
  developers: {
    title: "For developers",
    lead: "SDKs for JavaScript and React Native, Android (Kotlin), iOS (Swift) and Flutter, plus a REST API for your servers. Separate keys for development, staging and production, and a live debugger to check every event before you ship a release.",
    points: [
      "Built and tested; not on public package registries yet, so we provide them during onboarding.",
      "Offline queue, batching and retries on every platform, with no advertising ids collected.",
      "Deferred deep links and in-app message display are not in the SDKs yet.",
    ],
    cta: "Read the developer guide",
  },
  cta: { title: "Ready to see your own app?", lead: "Create a free account and send your first event to LeanApp today.", start: "Start free", demo: "Try the demo first" },
  footer: { rights: "LeanApp", contact: "Contact", developers: "Developers" },
};

export type LandingCopy = typeof EN & { compareRows: CompareRow[]; flow: FlowStep[]; coming: string[]; notOffered: string; states: Record<Availability, string> };

const AR: typeof EN = {
  dir: "rtl",
  nav: { demo: "العرض التجريبي", how: "طريقة عملنا", compare: "المقارنة", pricing: "الأسعار", about: "من نحن", developers: "للمطوّرين", signIn: "تسجيل الدخول", start: "ابدأ مجانًا", dashboard: "افتح لوحة التحكم", other: "English" },
  hero: {
    eyebrow: "تحليلات تطبيقات الجوال للعالم العربي",
    title: "اعرف مستخدميك، وطوّر تطبيقك.",
    lead: "اعرف من يثبّت تطبيقك، وأين يتوقف، ومن يعود إليه، ثم تواصل معه عبر الإشعارات والبريد الإلكتروني وواتساب. SDK واحد، ودعم بالعربية والإنجليزية، وأسعار تناسب الفرق النامية.",
    demo: "جرّب العرض المباشر",
    start: "ابدأ مجانًا",
    note: "لا حاجة إلى بطاقة. يفتح العرض تطبيقًا تجريبيًا لتوصيل الطعام، تستكشفه كما تشاء دون أن تغيّر شيئًا.",
  },
  flowLabel: "رحلة المنتج",
  demo: {
    title: "شاهده ببيانات قريبة من الواقع",
    lead: "العرض التجريبي تطبيق لتوصيل الطعام فيه مستخدمون تجريبيون لآخر 30 يومًا. تنقّل فيه كما تشاء بين التقارير، فهو للاطلاع فقط، ولن يغيّر أي شيء تفعله فيه بياناته أو تقاريره.",
    shots: [
      { src: "/landing/overview.png", caption: "النظرة العامة: النشطون والجدد والأحداث مقارنة بالأسبوع الماضي." },
      { src: "/landing/funnel.png", caption: "مسارات التحويل: أين يتوقف المستخدمون قبل الطلب، ومن هم." },
      { src: "/landing/retention.png", caption: "الاحتفاظ: كم مستخدمًا يعود بعد يوم و3 أيام و7 أيام من التثبيت." },
      { src: "/landing/revenue.png", caption: "الإيرادات: الطلبات اليومية والدافعون والإيراد لكل مستخدم." },
    ],
    cta: "افتح العرض المباشر",
  },
  how: {
    title: "طريقة عملنا",
    lead: "من أول اجتماع إلى أول قرار، في أربع خطوات نُعدّها معك خطوة بخطوة بالعربية أو الإنجليزية.",
    steps: [
      { title: "نفهم نشاطك", body: "أخبرنا بما تبيعه وكيف يدفع المستخدمون. نحوّل ذلك إلى خطة تتبّع توضّح الأحداث المهمة وسبب أهميتها." },
      { title: "تربط تطبيقك", body: "أضف الـ SDK أو استخدم الـ API، بمفاتيح منفصلة للتطوير والاختبار والإنتاج. ونساعد مطوّريك خطوة بخطوة." },
      { title: "نتحقق من البيانات", body: "يُراجَع كل حدث على خطة التتبّع لحظة وصوله، ويوضّح لك تقييم جودة التنفيذ ما ينقص تطبيقك بالتحديد." },
      { title: "تتخذ القرار", body: "مسارات التحويل والاحتفاظ والإيرادات توضّح ما يجب إصلاحه، والجماهير والحملات توصلك إلى المستخدمين المناسبين." },
    ],
  },
  compare: {
    title: "مقارنة LeanApp بالبدائل",
    lead: "تدفع معظم فرق التطبيقات في المنطقة لثلاث أدوات: أداة تحليلات، وأداة إسناد، وأداة رسائل. يجمع LeanApp التحليلات والرسائل في مكان واحد، بأسعار تناسب التطبيقات النامية، ومع فريق يتحدث العربية.",
    need: "ما تحتاجه",
    labels: { yes: "نعم", beta: "تجريبي", partial: "جزئيًا", no: "لا" },
    value: [
      { title: "أداة واحدة بدل ثلاث", body: "افهم المستخدمين وتواصل معهم من البيانات نفسها، دون مزامنة الجماهير بين منتجات مختلفة." },
      { title: "أسعار تناسب المنطقة", body: "ابدأ مجانًا وتوسّع بدءًا من 49$ شهريًا، بدل عقود الشركات المصممة للتطبيقات العالمية." },
      { title: "نُعدّه معك", body: "نبني معك خطة التتبّع، ونساعد مطوّريك في تنفيذها خطوة بخطوة، بالعربية أو بالإنجليزية." },
    ],
    honest: "هل تحتاج إلى منع الاحتيال، أو تكلفة الإعلانات و ROAS؟ استخدم لذلك شريك إسناد كاملًا مثل Adjust إلى جانب LeanApp.",
    source: "استنادًا إلى المواقع الرسمية لكل منتج، أكتوبر 2026. Mixpanel و Adjust و MoEngage علامات تجارية مملوكة لأصحابها.",
  },
  features: { title: "ماذا يتضمن", lead: "بجانب كل ميزة توضيح لحالتها: متاحة، أو تجريبية، أو قريبًا.", coming: "قريبًا" },
  pricing: {
    title: "الأسعار",
    lead: "أسعار شهرية واضحة تبدأ بها بنفسك، أو باقة مخصصة للفرق الكبيرة. الأسعار بالدولار الأمريكي.",
    month: "/ شهريًا",
    free: "مجانًا",
    start: "ابدأ مجانًا",
    contact: "تواصل مع المبيعات",
    custom: "سعر مخصص",
    from: "يبدأ من",
    popular: "الأكثر طلبًا",
    all: "تتضمن كل الباقات دعمًا باللغتين العربية والإنجليزية، وبيئات منفصلة للتطوير والاختبار والإنتاج.",
    names: { starter: "Starter", growth: "Growth", enterprise: "Enterprise" },
    plans: PLANS_AR,
  },
  about: {
    title: "من نحن",
    body: [
      "LeanApp فريق صغير يبني أدوات التحليلات والنمو التي تمنّيناها لتطبيقات منطقتنا: أدوات مصممة للعربية من اليوم الأول، وبأسعار واضحة، ودون أن تحتاج إلى خمس أدوات مختلفة لتعرف ما يفعله مستخدموك داخل تطبيقك كل يوم.",
      "نبدأ مع فرق التطبيقات في العالم العربي، ونعمل مباشرة مع عملائنا الأوائل لنحدّد ما يأتي بعد.",
    ],
    values: [
      { title: "العربية أولًا", body: "لوحة تحكم بالعربية والإنجليزية، وإعداد ودعم بالعربية، ورسائل عربية لمستخدميك." },
      { title: "بياناتك ملكك", body: "بيانات كل عميل منفصلة على مستوى قاعدة البيانات. ويمكنك تصديرها أو حذفها في أي وقت." },
      { title: "وضوح فيما هو جاهز", body: "نوضّح ما هو متاح وما هو تجريبي وما هو قادم، ولا نبيع لعملائنا أبدًا ما ليس موجودًا." },
    ],
  },
  faq: {
    title: "أسئلة شائعة",
    items: [
      { q: "هل أحتاج إلى مطوّر؟", a: "نعم، مرة واحدة لإضافة الـ SDK. نعطيه خطة بكل حدث، ويوضّح مراقب الأحداث المباشر ما إذا كان التنفيذ صحيحًا." },
      { q: "ما المنصات المدعومة؟", a: "Android و iOS و Flutter و React Native و JavaScript، إضافةً إلى REST API للخوادم." },
      { q: "أين تُخزَّن بياناتي؟", a: "في قاعدة بيانات مخصّصة لـ LeanApp، ومنفصلة لكل عميل. اسألنا عن المنطقة إذا كانت شركتك تحتاج إلى ذلك." },
      { q: "هل العرض التجريبي حقيقي؟", a: "لا. هو بيانات تجريبية مولّدة لتطبيق توصيل طعام وهمي، حتى تجرّب كل التقارير بأمان." },
    ],
  },
  developers: {
    title: "للمطوّرين",
    lead: "حزم SDK لـ JavaScript و React Native و Android (Kotlin) و iOS (Swift) و Flutter، إضافة إلى REST API لخوادمك. مفاتيح منفصلة للتطوير والاختبار والإنتاج، ومراقب أحداث مباشر للتحقق من كل حدث قبل إطلاق تطبيقك للمستخدمين أو نشر أي تحديث له.",
    points: [
      "جاهزة ومختبرة، لكنها غير منشورة بعد على مستودعات الحزم العامة، لذا نوفّرها لك أثناء الإعداد.",
      "طابور يعمل دون اتصال، وإرسال على دفعات، وإعادة محاولة على كل منصة، دون جمع أي معرّفات إعلانية.",
      "الروابط العميقة المؤجّلة وعرض الرسائل داخل التطبيق غير متوفرة في الحزم بعد.",
    ],
    cta: "اقرأ دليل المطوّرين",
  },
  cta: { title: "هل أنت مستعد لرؤية تطبيقك؟", lead: "أنشئ حسابًا مجانيًا وأرسل أول حدث اليوم.", start: "ابدأ مجانًا", demo: "جرّب العرض أولًا" },
  footer: { rights: "LeanApp · لين آب", contact: "تواصل معنا", developers: "للمطوّرين" },
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
