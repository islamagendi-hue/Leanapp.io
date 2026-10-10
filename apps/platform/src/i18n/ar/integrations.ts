/**
 * Arabic strings for the Integrations Center (settings/integrations), ad-provider
 * connections, ad reporting and cost import, and outbound conversion delivery
 * logs (see ./common.ts for the glossary). Provider names, API names, scopes and
 * environment variable names stay in Latin script.
 */
const ar: Record<string, string> = {
  // ── Categories ─────────────────────────────────────────────────────────────
  "Advertising Platforms": "منصات الإعلانات",
  "Analytics and Event Sources": "التحليلات ومصادر الأحداث",
  "Attribution and Deep Links": "الإسناد والروابط العميقة",
  "Messaging Providers": "مزوّدو المراسلة",
  "CRM and Customer Data": "إدارة العملاء وبياناتهم",
  "Commerce and Revenue Sources": "التجارة ومصادر الإيرادات",
  "Webhooks and Custom Integrations": "Webhooks والتكاملات المخصّصة",
  "Billing and Payments": "الفوترة والمدفوعات",
  "Import ad accounts, campaigns, costs and results, and send conversions back to the networks.": "استورد الحسابات الإعلانية والحملات والتكاليف والنتائج، وأرسل التحويلات إلى الشبكات.",
  "Where your events come from, and where they can be sent.": "من أين تأتي أحداثك، وإلى أين يمكن إرسالها.",
  "Tracking links, deep links, SKAdNetwork and postbacks.": "روابط التتبّع والروابط العميقة وSKAdNetwork والإشعارات الراجعة (Postbacks).",
  "Push, email and WhatsApp delivery through your own provider accounts.": "إرسال الإشعارات والبريد وواتساب عبر حساباتك لدى المزوّدين.",
  "Sync users and audiences with your customer systems.": "زامِن المستخدمين والجماهير مع أنظمة عملائك.",
  "Purchases and subscription revenue from stores and payment systems.": "المشتريات وإيرادات الاشتراكات من المتاجر وأنظمة الدفع.",
  "Signed HTTP calls and the REST API, for anything not listed here.": "طلبات HTTP موقّعة وواجهة REST، لكل ما ليس مدرجًا هنا.",
  "How this LeanApp workspace pays for its plan.": "كيف تدفع مساحة عمل LeanApp هذه ثمن خطتها.",
  "Nothing in this category is built yet.": "لم يُبنَ شيء في هذه الفئة بعد.",

  // ── Center page ────────────────────────────────────────────────────────────
  "Every provider this project can connect to, in {env}. Each capability has its own status: connecting a network's conversions API doesn't import its costs, and the other way round. \"Verified\" means a real call to the provider succeeded.":
    "كل مزوّد يمكن لهذا المشروع الاتصال به، في بيئة {env}. لكل قدرة حالتها الخاصة: ربط واجهة التحويلات لشبكة ما لا يستورد تكاليفها، والعكس صحيح. وتعني «تم التحقق» أن طلبًا حقيقيًا إلى المزوّد نجح.",
  "Data source": "مصدر بيانات",
  "Service provider": "مزوّد خدمة",
  Inbound: "وارد",
  Outbound: "صادر",
  "Last success": "آخر نجاح",
  "Data through": "البيانات حتى",
  "{n} days behind": "متأخرة {n} أيام",
  Needs: "يتطلّب",
  "Provider permissions": "صلاحيات المزوّد",
  "Recent errors": "آخر الأخطاء",
  "Official API docs": "التوثيق الرسمي للواجهة",
  "No access": "لا صلاحية",
  "Credentials missing": "بيانات الاعتماد ناقصة",

  // ── Registry: capabilities and providers ───────────────────────────────────
  "Ad reporting import": "استيراد تقارير الإعلانات",
  "Daily ad accounts, campaigns, ad sets, ads, impressions, clicks, spend and conversions, with their external ids.":
    "الحسابات الإعلانية والحملات والمجموعات الإعلانية والإعلانات يوميًا، مع مرات الظهور والنقرات والإنفاق والتحويلات ومعرّفاتها لدى المزوّد.",
  "Credentials with read access to the ad accounts": "بيانات اعتماد تتيح قراءة الحسابات الإعلانية",
  "At least one ad account chosen": "اختيار حساب إعلاني واحد على الأقل",
  "Cost import into Ad spend": "استيراد التكلفة إلى إنفاق الإعلانات",
  "Writes the imported daily cost per campaign into Ad spend, so ROAS and cost per install use it. Amounts you entered by hand are never overwritten.":
    "يكتب التكلفة اليومية المستوردة لكل حملة في صفحة إنفاق الإعلانات، ليستخدمها ROAS وتكلفة التثبيت. ولا يستبدل أبدًا المبالغ التي أدخلتها يدويًا.",
  "Ad reporting import working": "استيراد تقارير الإعلانات يعمل",
  "Sends attributed installs and conversions to the network, with event ids for deduplication, consent checks and a delivery log.":
    "يرسل التثبيتات والتحويلات المسندة إلى الشبكة، مع معرّفات الأحداث لمنع التكرار، والتحقق من الموافقة، وسجلّ للإرسال.",
  "Meta Conversions API": "واجهة التحويلات من Meta",
  "Dataset access token": "رمز الوصول لمجموعة البيانات (Dataset)",
  "Conversions API access token": "رمز الوصول لواجهة التحويلات",
  "Customer ID and conversion action": "معرّف العميل وإجراء التحويل",
  "Developer token and OAuth refresh token": "رمز المطوّر ورمز التحديث من OAuth",
  "Ads management: read reports": "إدارة الإعلانات: قراءة التقارير",
  "TikTok Events API": "واجهة الأحداث من TikTok",
  "TikTok App ID": "معرّف تطبيق TikTok",
  "Snap Conversions API": "واجهة التحويلات من Snap",
  "Snap App ID": "معرّف تطبيق Snap",
  "Developer copies of Apple's install postbacks, decoded with your conversion value schema.": "نُسخ المطوّر من إشعارات التثبيت من Apple، مفكوكة بمخطط قيم التحويل لديك.",
  "NSAdvertisingAttributionReportEndpoint set in the iOS app": "ضبط NSAdvertisingAttributionReportEndpoint في تطبيق iOS",
  "Reporting API documented by the provider; not built in LeanApp.": "واجهة التقارير موثّقة لدى المزوّد، لكنها غير مبنية في LeanApp.",
  "Not built in LeanApp.": "غير مبني في LeanApp.",
  "Not built in LeanApp. Send purchases as events from your server in the meantime.": "غير مبني في LeanApp. وإلى ذلك الحين، أرسل المشتريات كأحداث من خادمك.",
  "LeanApp SDKs and REST API": "حِزم LeanApp البرمجية وواجهة REST",
  "Event ingestion": "استقبال الأحداث",
  "Events from your apps (SDK key) and servers (secret key).": "الأحداث من تطبيقاتك (مفتاح SDK) وخوادمك (المفتاح السري).",
  "An SDK key in the app or a secret key on the server": "مفتاح SDK في التطبيق أو مفتاح سري على الخادم",
  "Tracking links and deep links": "روابط التتبّع والروابط العميقة",
  "Tracking links and QR": "روابط التتبّع ورموز QR",
  "Clicks and installs per campaign link.": "النقرات والتثبيتات لكل رابط حملة.",
  "App Links and Universal Links that open a screen in your app.": "روابط App Links وUniversal Links التي تفتح شاشة في تطبيقك.",
  "Domain verification files served": "ملفات التحقق من النطاق منشورة",
  "Attributed installs and events sent to a URL you choose.": "إرسال التثبيتات والأحداث المسندة إلى عنوان URL تختاره.",
  "Android push": "إشعارات Android",
  "Push messages to Android devices.": "رسائل الإشعارات إلى أجهزة Android.",
  "Service account JSON": "ملف JSON لحساب الخدمة",
  "iOS push": "إشعارات iOS",
  "Push messages to iOS devices.": "رسائل الإشعارات إلى أجهزة iOS.",
  ".p8 auth key, Key ID, Team ID and bundle ID": "مفتاح ‎.p8 ومعرّف المفتاح ومعرّف الفريق ومعرّف الحزمة",
  "Campaign and flow emails from your own domain.": "رسائل بريد الحملات والمسارات من نطاقك.",
  "Resend API key and verified sender": "مفتاح Resend ومُرسِل موثَّق",
  "WhatsApp templates": "قوالب واتساب",
  "Template messages from campaigns and flows.": "رسائل القوالب من الحملات والمسارات.",
  "Phone number ID, WABA ID, access token and app secret": "معرّف رقم الهاتف ومعرّف WABA ورمز الوصول وسرّ التطبيق",
  "Signed webhooks": "Webhooks موقّعة",
  "A signed HTTP call whenever an event, audience change or conversion happens.": "طلب HTTP موقّع كلما وقع حدث أو تغيّر جمهور أو تحويل.",
  "An https endpoint that checks the signature": "عنوان https يتحقق من التوقيع",
  "Plan payments": "مدفوعات الخطة",
  "Pays for this workspace's LeanApp plan. Configured by the LeanApp operator, not per project.": "تدفع ثمن خطة LeanApp لمساحة العمل هذه. يضبطها مشغّل LeanApp، لا كل مشروع على حدة.",
  "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on the server": "ضبط STRIPE_SECRET_KEY و STRIPE_WEBHOOK_SECRET على الخادم",
  "Keys are set on the server; checked when a payment runs.": "المفاتيح مضبوطة على الخادم، ويُتحقَّق منها عند تنفيذ دفعة.",

  // ── Adapter fields ─────────────────────────────────────────────────────────
  "Access token with ads_read (system user recommended)": "رمز وصول بصلاحية ads_read (يُنصح بمستخدم النظام)",
  "Ad account IDs (comma-separated, digits)": "معرّفات الحسابات الإعلانية (أرقام، تفصل بينها فواصل)",
  "Ad account IDs (comma-separated)": "معرّفات الحسابات الإعلانية (تفصل بينها فواصل)",
  "Graph API version (default v23.0)": "إصدار Graph API (الافتراضي v23.0)",
  "Action types counted as conversions (optional, e.g. mobile_app_install)": "أنواع الإجراءات المحسوبة تحويلات (اختياري، مثل mobile_app_install)",
  "Customer IDs (comma-separated, digits)": "معرّفات العملاء (أرقام، تفصل بينها فواصل)",
  "Google Ads API version (e.g. v21)": "إصدار Google Ads API (مثل v21)",
  "Marketing API access token": "رمز الوصول لواجهة التسويق",
  "Advertiser IDs (comma-separated, digits)": "معرّفات المعلنين (أرقام، تفصل بينها فواصل)",
  "check the format.": "تحقّق من الصيغة.",

  // ── Provider page ──────────────────────────────────────────────────────────
  "Ad reporting and cost import for {env}. Built from the provider's published API and not yet verified with a live account: the status below turns Verified only after a real call succeeds.":
    "استيراد تقارير الإعلانات والتكلفة في بيئة {env}. مبني على الواجهة المنشورة للمزوّد ولم يُتحقَّق منه بعد مع حساب حقيقي: تصبح الحالة أدناه «تم التحقق» فقط بعد نجاح طلب حقيقي.",
  "Connected. Use Test connection to check access, then choose the ad accounts.": "تم الربط. استخدم «اختبار الاتصال» للتحقق من الوصول، ثم اختر الحسابات الإعلانية.",
  "The connection was cancelled at the provider.": "أُلغي الربط لدى المزوّد.",
  "The provider didn't complete the connection. Try again, or enter credentials below.": "لم يُكمل المزوّد الربط. حاول مجددًا، أو أدخل بيانات الاعتماد أدناه.",
  "Missing: {fields}": "ناقص: {fields}",
  "Next import": "الاستيراد التالي",
  "History import down to {day} in progress": "جارٍ استيراد السجل حتى {day}",
  "Sending conversions is set up separately, as a postback, and doesn't use this connection.": "يُضبط إرسال التحويلات على حدة، كإشعار راجع (Postback)، ولا يستخدم هذا الربط.",
  "Open postbacks": "افتح الإشعارات الراجعة",
  "Credentials and settings": "بيانات الاعتماد والإعدادات",
  "Connected with OAuth through LeanApp's app.": "مربوط عبر OAuth من خلال تطبيق LeanApp.",
  "Credentials entered by hand.": "بيانات اعتماد أُدخلت يدويًا.",
  "Last changed": "آخر تغيير",
  "Permissions granted": "الصلاحيات الممنوحة",
  "Connect with {provider}": "اربط عبر {provider}",
  "Connecting with OAuth needs LeanApp's own {provider} app, which this server doesn't have yet. Enter your own credentials instead.":
    "يتطلب الربط عبر OAuth تطبيق {provider} خاصًا بـ LeanApp، ولا يملكه هذا الخادم بعد. أدخل بيانات اعتمادك بدلًا من ذلك.",
  "Stored. Leave blank to keep.": "محفوظ. اتركه فارغًا للإبقاء عليه.",
  "Secrets are encrypted at rest and never shown again. Saving credentials doesn't start imports: turn them on below.": "تُشفَّر الأسرار عند التخزين ولا تُعرض مجددًا. حفظ بيانات الاعتماد لا يبدأ الاستيراد: فعّله أدناه.",
  "Test connection": "اختبار الاتصال",
  "Import now": "استورد الآن",
  "Importing…": "جارٍ الاستيراد…",
  "Remove connection": "إزالة الربط",
  "Remove this connection, its imported reporting and its imported Ad spend? Spend you entered by hand stays.": "إزالة هذا الربط وتقاريره المستوردة وإنفاقه المستورد؟ يبقى الإنفاق الذي أدخلته يدويًا.",
  Capabilities: "القدرات",
  "Turn on": "تفعيل",
  "Turn on cost import": "فعّل استيراد التكلفة",
  "Turn off cost import": "أوقف استيراد التكلفة",
  "Source name in Ad spend": "اسم المصدر في إنفاق الإعلانات",
  "Use the same source name your tracking links use, so cost lines up with installs.": "استخدم اسم المصدر نفسه الذي تستخدمه روابط التتبّع، لتتطابق التكلفة مع التثبيتات.",
  "Import history": "استورد السجل",
  "From day": "من يوم",
  "Import runs": "عمليات الاستيراد",
  "Nothing imported yet.": "لم يُستورد شيء بعد.",
  Kind: "النوع",
  Rows: "الصفوف",
  "Spend rows": "صفوف الإنفاق",
  "Kept (entered by hand)": "أُبقي عليها (مُدخلة يدويًا)",
  Manual: "يدوي",
  Scheduled: "مجدول",
  Succeeded: "نجح",
  Running: "قيد التشغيل",
  "Imported campaigns, last 30 days": "الحملات المستوردة، آخر 30 يومًا",
  Impressions: "مرات الظهور",
  Imported: "مستورد",

  // ── Actions and service messages ───────────────────────────────────────────
  "Saved. Still missing: {fields}.": "تم الحفظ. ما زال ناقصًا: {fields}.",
  "Saved. Use Test connection to check the credentials against the provider.": "تم الحفظ. استخدم «اختبار الاتصال» للتحقق من بيانات الاعتماد لدى المزوّد.",
  "History import queued. The worker imports 30 days per run, newest first.": "أُضيف استيراد السجل إلى الطابور. يستورد العامل 30 يومًا في كل تشغيل، الأحدث أولًا.",
  "Import failed: {error}": "فشل الاستيراد: {error}",
  "Imported {rows} rows for {from} to {to}.": "استُورد {rows} صفًا من {from} إلى {to}.",
  "The provider refused the credentials: {error}": "رفض المزوّد بيانات الاعتماد: {error}",
  "Connected to the live provider. Ad accounts these credentials can read: {list}": "تم الاتصال بالمزوّد الحقيقي. الحسابات الإعلانية التي يمكن لهذه البيانات قراءتها: {list}",
  "Connection removed.": "أُزيل الربط.",
  "Unknown provider.": "مزوّد غير معروف.",
  "Unknown capability.": "قدرة غير معروفة.",
  "Use letters, digits, dots, dashes or underscores.": "استخدم حروفًا أو أرقامًا أو نقاطًا أو شرطات.",
  "Turn on ad reporting import first: cost import uses its data.": "فعّل استيراد تقارير الإعلانات أولًا: استيراد التكلفة يستخدم بياناته.",
  "Turn on ad reporting import first.": "فعّل استيراد تقارير الإعلانات أولًا.",
  "Choose a day in the past.": "اختر يومًا في الماضي.",
  "History can be imported for up to 395 days.": "يمكن استيراد السجل لمدة أقصاها 395 يومًا.",
  "No credentials stored.": "لا توجد بيانات اعتماد محفوظة.",
  "Stored credentials can't be read (encryption key missing or changed). Enter them again.": "تعذّرت قراءة بيانات الاعتماد المحفوظة (مفتاح التشفير مفقود أو تغيّر). أدخلها مجددًا.",
  "Connecting with OAuth isn't set up on this server. Enter credentials instead.": "الربط عبر OAuth غير مُعدّ على هذا الخادم. أدخل بيانات الاعتماد بدلًا من ذلك.",
  "Invalid return path.": "مسار العودة غير صالح.",

  // ── Postback delivery log ──────────────────────────────────────────────────
  "Not sent: the user denied attribution consent.": "لم يُرسَل: رفض المستخدم الموافقة على الإسناد.",
  "Not sent: nothing the network can match on (no click id or install id).": "لم يُرسَل: لا شيء يمكن للشبكة المطابقة عليه (لا معرّف نقرة ولا معرّف تثبيت).",
  "Not sent: the event breaks the network's rules:": "لم يُرسَل: الحدث يخالف قواعد الشبكة:",
  "Provider code": "رمز المزوّد",
  trace: "التتبّع",

  // ── Meta website events, Google Enhanced Conversions, Apple AdServices ─────
  "Off: send no email, phone or user id": "إيقاف: لا يُرسَل بريد ولا هاتف ولا معرّف مستخدم",
  "Only when the user granted attribution consent": "فقط عندما يوافق المستخدم على الإسناد",
  "Unless the user denied attribution consent": "ما لم يرفض المستخدم الموافقة على الإسناد",
  "For website events this is the dataset of your Meta Pixel (the Pixel ID).": "لأحداث الموقع، هذه هي مجموعة بيانات Meta Pixel الخاصة بك (معرّف Pixel).",
  "Event source": "مصدر الحدث",
  "App events (Conversions API for apps)": "أحداث التطبيق (Conversions API للتطبيقات)",
  "Website events (Pixel + Conversions API)": "أحداث الموقع (Pixel مع Conversions API)",
  "By platform: web SDK events as website, others as app": "حسب المنصة: أحداث SDK الويب كموقع، والباقي كتطبيق",
  "Hashed user data (advanced matching)": "بيانات المستخدم المجزّأة (المطابقة المتقدّمة)",
  "SHA-256 hashes of the email and phone user properties and the user id.": "تجزئات SHA-256 لخاصيتَي البريد والهاتف للمستخدم ولمعرّف المستخدم.",
  "Test event code (optional)": "رمز حدث الاختبار (اختياري)",
  "From Events Manager → Test events. Events sent with it appear there and are not used for ads; remove it when done.":
    "من Events Manager ← Test events. الأحداث المرسلة به تظهر هناك ولا تُستخدم للإعلانات؛ احذفه عند الانتهاء.",
  "Enhanced conversions (hashed email and phone)": "التحويلات المحسّنة (بريد وهاتف مجزّآن)",
  "Turn on enhanced conversions for this conversion action in Google Ads first.": "فعّل التحويلات المحسّنة لإجراء التحويل هذا في Google Ads أولًا.",
  "Meta Conversions API: app events": "Meta Conversions API: أحداث التطبيق",
  "Meta Pixel and Conversions API: website events": "Meta Pixel وConversions API: أحداث الموقع",
  "Sends attributed website conversions with the page URL, browser user agent, _fbp / _fbc browser ids and, if you allow it, hashed email and phone. Uses the event's own id, so a browser Pixel sending the same id as eventID is counted once.":
    "يرسل تحويلات الموقع المُسنَدة مع رابط الصفحة ووكيل المستخدم للمتصفح ومعرّفَي المتصفح _fbp / _fbc، ومع البريد والهاتف مجزّأين إن سمحت بذلك. يستخدم معرّف الحدث نفسه، فإذا أرسل Pixel في المتصفح المعرّف نفسه كـ eventID يُحتسَب الحدث مرة واحدة.",
  "A Meta postback with Event source set to website or by platform": "Postback لـ Meta مع ضبط مصدر الحدث على الموقع أو حسب المنصة",
  "Pixel (dataset) ID and Conversions API access token": "معرّف Pixel (مجموعة البيانات) ورمز وصول Conversions API",
  "The web SDK sending the page URL and user agent": "SDK الويب يرسل رابط الصفحة ووكيل المستخدم",
  "Google Ads Enhanced Conversions": "التحويلات المحسّنة في Google Ads",
  "Adds SHA-256 hashed email and phone to uploaded conversions, and uploads conversions without a click id when they have them. Only for users your setting and their consent allow.":
    "يضيف البريد والهاتف مجزّأين بـ SHA-256 إلى التحويلات المرفوعة، ويرفع التحويلات التي بلا معرّف نقرة إن توفّرا. فقط للمستخدمين الذين يسمح بهم إعدادك وموافقتهم.",
  "A Google Ads postback with enhanced conversions turned on": "Postback لـ Google Ads مع تفعيل التحويلات المحسّنة",
  "Enhanced conversions turned on for the conversion action in Google Ads": "تفعيل التحويلات المحسّنة لإجراء التحويل في Google Ads",
  "email or phone user properties": "خاصية البريد أو الهاتف للمستخدم",
  "AdServices attribution lookup": "استعلام إسناد AdServices",
  "Asks Apple whether an iOS install came from an Apple Search Ads campaign, using the token the iOS SDK collects once. Apple's answer is stored as provider-reported data; it doesn't change other attribution.":
    "يسأل Apple إن كان تثبيت iOS قد جاء من حملة Apple Search Ads، باستخدام الرمز الذي يجمعه SDK الخاص بـ iOS مرة واحدة. يُخزَّن ردّ Apple كبيانات يبلّغ عنها المزوّد، ولا يغيّر الإسناد الآخر.",
  "LeanApp iOS SDK sending the AdServices token (iOS 14.3 or later)": "SDK الخاص بـ LeanApp على iOS يرسل رمز AdServices (iOS 14.3 أو أحدث)",
  "No AdServices token received in the last 30 days.": "لم يُستلَم أي رمز AdServices خلال آخر 30 يومًا.",
  "Test event code set: Meta shows these events under Test events only.": "رمز حدث الاختبار مضبوط: تعرض Meta هذه الأحداث في Test events فقط.",
  "choose one of the listed values.": "اختر إحدى القيم المدرجة.",
  "Apple Search Ads installs are reported by Apple's AdServices API: LeanApp looks up the token the iOS SDK sends and stores Apple's answer (Settings → Integrations). A link only covers web traffic.":
    "تُبلِغ واجهة AdServices من Apple عن تثبيتات Apple Search Ads: يستعلم LeanApp عن الرمز الذي يرسله SDK الخاص بـ iOS ويخزّن ردّ Apple (الإعدادات ← التكاملات). الرابط يغطي حركة الويب فقط.",

  // ── TikTok and Snap website events ─────────────────────────────────────────
  "For app events. Required unless Event source is website.":
    "لأحداث التطبيق. مطلوب ما لم يكن مصدر الحدث هو الموقع.",
  "TikTok Pixel code":
    "رمز TikTok Pixel",
  "For website events: the pixel code from TikTok Events Manager. Required unless Event source is app.":
    "لأحداث الموقع: رمز الـ Pixel من TikTok Events Manager. مطلوب ما لم يكن مصدر الحدث هو التطبيق.",
  "App events":
    "أحداث التطبيق",
  "Website events (Pixel + Events API)":
    "أحداث الموقع (Pixel مع Events API)",
  "Hashed user data (website events)":
    "بيانات المستخدم المجزّأة (أحداث الموقع)",
  "SHA-256 hashes of the email and phone user properties and the user id, on website events only.":
    "تجزئات SHA-256 لخاصيتَي البريد والهاتف للمستخدم ولمعرّف المستخدم، في أحداث الموقع فقط.",
  "From TikTok Events Manager → your pixel → Test events. Remove it when done.":
    "من TikTok Events Manager ← الـ Pixel الخاص بك ← Test events. احذفه عند الانتهاء.",
  "Snap Pixel ID":
    "معرّف Snap Pixel",
  "For website events: the Pixel ID from Snap Events Manager. Required unless Event source is app.":
    "لأحداث الموقع: معرّف الـ Pixel من Snap Events Manager. مطلوب ما لم يكن مصدر الحدث هو التطبيق.",
  "TikTok App ID is required for app events.":
    "معرّف تطبيق TikTok مطلوب لأحداث التطبيق.",
  "TikTok Pixel code is required for website events.":
    "رمز TikTok Pixel مطلوب لأحداث الموقع.",
  "Snap App ID is required for app events.":
    "معرّف تطبيق Snap مطلوب لأحداث التطبيق.",
  "Snap Pixel ID is required for website events.":
    "معرّف Snap Pixel مطلوب لأحداث الموقع.",
  "TikTok Pixel code and access token are required for website events.":
    "رمز TikTok Pixel ورمز الوصول مطلوبان لأحداث الموقع.",
  "Snap Pixel ID and token are required for website events.":
    "معرّف Snap Pixel والرمز مطلوبان لأحداث الموقع.",
  "TikTok Pixel and Events API: website events":
    "TikTok Pixel وEvents API: أحداث الموقع",
  "Sends attributed website conversions with the page URL, browser user agent, the ttclid click id, the _ttp cookie and, if you allow it, hashed email, phone and user id. Uses the event's own id, so a browser TikTok Pixel sending the same event_id is counted once.":
    "يرسل تحويلات الموقع المُسنَدة مع رابط الصفحة ووكيل المستخدم للمتصفح ومعرّف النقرة ttclid وملف تعريف الارتباط _ttp، ومع البريد والهاتف ومعرّف المستخدم مجزّأة إن سمحت بذلك. يستخدم معرّف الحدث نفسه، فإذا أرسل TikTok Pixel في المتصفح الـ event_id نفسه يُحتسَب الحدث مرة واحدة.",
  "A TikTok postback with Event source set to website or by platform":
    "Postback لـ TikTok مع ضبط مصدر الحدث على الموقع أو حسب المنصة",
  "TikTok Pixel code and Events API access token":
    "رمز TikTok Pixel ورمز وصول Events API",
  "Snap Pixel and Conversions API: website events":
    "Snap Pixel وConversions API: أحداث الموقع",
  "Sends attributed website conversions with the page URL, browser user agent, the ScCid click id, the _scid cookie and, if you allow it, hashed email, phone and user id. Uses the event's own id, so a browser Snap Pixel sending the same id for deduplication is counted once.":
    "يرسل تحويلات الموقع المُسنَدة مع رابط الصفحة ووكيل المستخدم للمتصفح ومعرّف النقرة ScCid وملف تعريف الارتباط _scid، ومع البريد والهاتف ومعرّف المستخدم مجزّأة إن سمحت بذلك. يستخدم معرّف الحدث نفسه، فإذا أرسل Snap Pixel في المتصفح المعرّف نفسه لإزالة التكرار يُحتسَب الحدث مرة واحدة.",
  "A Snap postback with Event source set to website or by platform":
    "Postback لـ Snap مع ضبط مصدر الحدث على الموقع أو حسب المنصة",
  "Snap Pixel ID and Conversions API token":
    "معرّف Snap Pixel ورمز Conversions API",
  "Test event code set: TikTok shows these events under Test events in Events Manager.":
    "رمز حدث الاختبار مضبوط: تعرض TikTok هذه الأحداث في Test events داخل Events Manager.",
};

export default ar;
