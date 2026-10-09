/**
 * Arabic strings for messaging providers (src/modules/messaging, src/modules/twilio),
 * the WhatsApp templates page, the campaign composer, SMS / WhatsApp flow steps and
 * the Twilio card in Settings → Dev Ops → Channels.
 */
const ar: Record<string, string> = {
  // ── Provider registry and capabilities ────────────────────────────────────
  "Mobile push": "إشعارات الجوال",
  "Web push": "إشعارات الويب",
  "Connection check": "فحص الاتصال",
  "Send approved templates": "إرسال القوالب المعتمدة",
  "Send free-form messages": "إرسال رسائل حرة",
  "Template discovery and sync": "اكتشاف القوالب ومزامنتها",
  "Create and submit templates": "إنشاء القوالب وإرسالها للمراجعة",
  "Delete templates": "حذف القوالب",
  "Delivery status callbacks": "إشعارات حالة التسليم",
  "Inbound messages and replies": "الرسائل الواردة والردود",
  "Opt-out handling": "معالجة إلغاء الاشتراك",
  "Media attachments": "مرفقات الوسائط",
  "Free-form messages only within 24 hours of the person's last message to you; otherwise an approved template is required.":
    "الرسائل الحرة مسموحة فقط خلال 24 ساعة من آخر رسالة أرسلها إليك الشخص؛ وإلا فيلزم قالب معتمد.",
  "Template edits are made in WhatsApp Manager; LeanApp creates, submits and deletes templates.":
    "تُعدَّل القوالب في WhatsApp Manager؛ أما LeanApp فينشئ القوالب ويرسلها للمراجعة ويحذفها.",
  "MMS: US and Canadian numbers only.": "رسائل MMS: لأرقام الولايات المتحدة وكندا فقط.",
  "WhatsApp templates are Twilio Content templates (Content API) with WhatsApp approval; create them in the Twilio Console.":
    "قوالب WhatsApp هي قوالب محتوى Twilio ‏(Content API) المعتمدة من WhatsApp؛ أنشئها في Twilio Console.",
  "SMS is text only; MMS images only to US and Canadian numbers.": "الرسائل القصيرة نص فقط؛ وصور MMS لأرقام الولايات المتحدة وكندا فقط.",
  "Email templates are LeanApp templates; delivery and open events need a Resend webhook, which isn't connected yet.":
    "قوالب البريد هي قوالب LeanApp؛ وأحداث التسليم والفتح تحتاج إلى Webhook من Resend غير مربوط بعد.",
  "Documented: POST /messages and GET/POST/DELETE /v1/configs/templates on waba-v2.360dialog.io with a D360-API-KEY header. Not connected in LeanApp.":
    "موثّق: POST /messages وGET/POST/DELETE /v1/configs/templates على waba-v2.360dialog.io مع ترويسة D360-API-KEY. غير مربوط في LeanApp.",
  "Documented: template creation and sending, delivery and seen reports, inbound messages. Other operations weren't confirmed. Not connected in LeanApp.":
    "موثّق: إنشاء القوالب وإرسالها، وتقارير التسليم والمشاهدة، والرسائل الواردة. لم تُؤكَّد العمليات الأخرى. غير مربوط في LeanApp.",
  "Documented: POST /wa/api/v1/template/msg, a template listing API and message event callbacks. Other operations weren't confirmed. Not connected in LeanApp.":
    "موثّق: POST /wa/api/v1/template/msg، وواجهة لسرد القوالب، وإشعارات أحداث الرسائل. لم تُؤكَّد العمليات الأخرى. غير مربوط في LeanApp.",
  "Documented in WATI's API reference: get, create and delete templates, send template and session messages, webhooks. Not connected in LeanApp.":
    "موثّق في مرجع واجهة WATI: جلب القوالب وإنشاؤها وحذفها، وإرسال رسائل القوالب والجلسات، وWebhooks. غير مربوط في LeanApp.",
  "Unifonic documents WhatsApp and SMS products, but we couldn't confirm specific API operations from its public docs, so every capability is marked unverified.":
    "توثّق Unifonic منتجات WhatsApp والرسائل القصيرة، لكننا لم نتمكن من تأكيد عمليات محددة في واجهتها من وثائقها العامة، لذا وُسمت كل القدرات بأنها غير مؤكدة.",
  "We couldn't confirm respond.io's API operations from its public docs, so every capability is marked unverified.":
    "لم نتمكن من تأكيد عمليات واجهة respond.io من وثائقها العامة، لذا وُسمت كل القدرات بأنها غير مؤكدة.",
  Implemented: "مُنفَّذ",
  "Provider supports": "يدعمه المزوّد",
  "Unknown provider.": "مزوّد غير معروف.",

  // ── Media checks ──────────────────────────────────────────────────────────
  "{provider} media sending isn't available in LeanApp.": "إرسال الوسائط عبر {provider} غير متاح في LeanApp.",
  "{provider} doesn't accept media on this channel.": "لا يقبل {provider} الوسائط على هذه القناة.",
  "{provider} doesn't accept {mime} here. Allowed: {allowed}.": "لا يقبل {provider} النوع {mime} هنا. المسموح: {allowed}.",
  "The file is {size} MB; {provider} accepts at most {max} MB for {kind}.": "حجم الملف {size} ميغابايت؛ ويقبل {provider} بحدٍّ أقصى {max} ميغابايت لـ{kind}.",
  "The media library isn't available on this server, so media can't be attached yet.": "مكتبة الوسائط غير متاحة على هذا الخادم، لذا لا يمكن إرفاق الوسائط بعد.",
  "Choose a media file.": "اختر ملف وسائط.",

  // ── Step and campaign checks ──────────────────────────────────────────────
  "{provider} isn't connected in this environment.": "{provider} غير مربوط في هذه البيئة.",
  "The Twilio integration has no WhatsApp sender.": "لا يوجد مُرسِل WhatsApp في تكامل Twilio.",
  "The Twilio integration has no SMS sender.": "لا يوجد مُرسِل رسائل قصيرة في تكامل Twilio.",
  "The WhatsApp template \"{template}\" has a media header ({kind}): choose a media file.": "لقالب WhatsApp ‏\"{template}\" ترويسة وسائط ({kind}): اختر ملف وسائط.",
  "The WhatsApp template \"{template}\" has no media header, so it can't carry a file.": "ليس لقالب WhatsApp ‏\"{template}\" ترويسة وسائط، لذا لا يمكنه حمل ملف.",
  "{provider} doesn't send media by SMS.": "لا يرسل {provider} الوسائط عبر الرسائل القصيرة.",
  "MMS goes only to US and Canadian numbers; other recipients are skipped with a reason.": "تُرسَل رسائل MMS لأرقام الولايات المتحدة وكندا فقط؛ ويُتخطّى باقي المستلمين مع ذكر السبب.",
  "Everyone in this audience is opted out or suppressed for this channel.": "كل من في هذا الجمهور ألغى الاشتراك أو محظور على هذه القناة.",
  "Test this channel from Engage → Channels & delivery.": "اختبر هذه القناة من التفاعل ← القنوات والتسليم.",
  "No person with the user ID \"{id}\" in this environment. The app must have identified them first.": "لا يوجد شخص بمعرّف المستخدم \"{id}\" في هذه البيئة. يجب أن يكون التطبيق قد عرّفه أولًا.",
  "Sent. Twilio accepted the SMS; delivery receipts arrive through the status callback.": "أُرسلت. قبلت Twilio الرسالة القصيرة؛ وتصل إيصالات التسليم عبر إشعار الحالة.",
  "The template {name} has a media header, which test sends don't attach. Test it from a campaign.": "للقالب {name} ترويسة وسائط لا تُرفَق في رسائل الاختبار. اختبره من حملة.",
  "SMS has no read receipts.": "لا توجد إيصالات قراءة للرسائل القصيرة.",
  "SMS link clicks aren't tracked.": "لا تُتتبَّع النقرات على روابط الرسائل القصيرة.",

  // ── Template drafts ───────────────────────────────────────────────────────
  "Template names use lowercase letters, digits and underscores (e.g. order_update).": "تستخدم أسماء القوالب أحرفًا لاتينية صغيرة وأرقامًا وشرطات سفلية (مثل order_update).",
  "Use a WhatsApp language code like en_US or ar.": "استخدم رمز لغة WhatsApp مثل en_US أو ar.",
  "Choose a category.": "اختر فئة.",
  "The header is at most 60 characters.": "الترويسة 60 حرفًا كحد أقصى.",
  "Enter the message text.": "أدخل نص الرسالة.",
  "The body is at most 1024 characters.": "النص 1024 حرفًا كحد أقصى.",
  "The footer is at most 60 characters.": "التذييل 60 حرفًا كحد أقصى.",
  "Variables must be numbered in order: {{{n}}} is missing.": "يجب ترقيم المتغيرات بالترتيب: المتغير {{{n}}} مفقود.",
  "Give an example value for each of the {n} variables; Meta reviews them.": "أدخل قيمة مثال لكل متغير من المتغيرات الـ{n}؛ تراجعها Meta.",
  "Header variables aren't supported in drafts yet; keep the header fixed.": "متغيرات الترويسة غير مدعومة في المسودات بعد؛ اجعل الترويسة ثابتة.",
  "A draft with this name and language already exists.": "توجد مسودة بهذا الاسم واللغة مسبقًا.",
  "A submitted draft can't be edited; change the template in WhatsApp Manager.": "لا يمكن تعديل مسودة أُرسلت للمراجعة؛ غيّر القالب في WhatsApp Manager.",
  "Template creation isn't available for this provider.": "إنشاء القوالب غير متاح لهذا المزوّد.",
  "This draft was already submitted.": "أُرسلت هذه المسودة للمراجعة مسبقًا.",
  "Connect WhatsApp (Meta) or Twilio first.": "اربط WhatsApp ‏(Meta) أو Twilio أولًا.",
  "\"{name}\" uses this template.": "يستخدم \"{name}\" هذا القالب.",
  "{provider} templates can't be deleted from LeanApp.": "لا يمكن حذف قوالب {provider} من LeanApp.",
  "{provider}: {error}": "خطأ لدى {provider}: {error}",
  "{provider}: {n} templates ({approved} approved)": "{provider}: {n} قالب ({approved} معتمد)",
  "No connected provider offers WhatsApp templates (a Twilio integration needs a WhatsApp sender).": "لا يوفّر أي مزوّد مربوط قوالب WhatsApp (يحتاج تكامل Twilio إلى مُرسِل WhatsApp).",
  "Draft saved.": "حُفظت المسودة.",
  "Draft created. It isn't on WhatsApp until you submit it.": "أُنشئت المسودة. لن تكون على WhatsApp حتى ترسلها للمراجعة.",
  "Deleted on the provider.": "حُذف لدى المزوّد.",

  // ── WhatsApp templates page ───────────────────────────────────────────────
  "WhatsApp templates": "قوالب WhatsApp",
  "WhatsApp templates as your providers report them: real approval status, language and category. Synced templates live on the provider; drafts live only in LeanApp until you submit them.":
    "قوالب WhatsApp كما يبلّغ عنها مزوّدوك: حالة الاعتماد الفعلية واللغة والفئة. القوالب المتزامنة موجودة لدى المزوّد؛ أما المسودات فموجودة في LeanApp فقط حتى ترسلها للمراجعة.",
  "Sync from providers": "مزامنة من المزوّدين",
  Providers: "المزوّدون",
  "No WhatsApp provider is connected in this environment.": "لا يوجد مزوّد WhatsApp مربوط في هذه البيئة.",
  "Connect one in Settings → Dev Ops → Channels": "اربط واحدًا من الإعدادات ← عمليات التطوير ← القنوات",
  Provider: "المزوّد",
  Connection: "الاتصال",
  "Implemented: LeanApp does it. Provider supports: documented by the provider, not built in LeanApp yet. Not available: the provider doesn't offer it, or it couldn't be confirmed.":
    "مُنفَّذ: يقوم به LeanApp. يدعمه المزوّد: موثّق لدى المزوّد ولم يُبنَ في LeanApp بعد. غير متاح: لا يوفّره المزوّد أو تعذّر تأكيده.",
  "Synced templates": "القوالب المتزامنة",
  "Name or text": "الاسم أو النص",
  Filter: "تصفية",
  "No template matches these filters.": "لا يوجد قالب يطابق عوامل التصفية هذه.",
  "No templates synced yet. Create templates in WhatsApp Manager or the Twilio Console (or submit a draft below), then sync.":
    "لم تُزامَن أي قوالب بعد. أنشئ قوالب في WhatsApp Manager أو Twilio Console (أو أرسل مسودة أدناه)، ثم زامِن.",
  "reason: {reason}": "السبب: {reason}",
  "quality: {score}": "الجودة: {score}",
  "Synced {date}": "زُومن في {date}",
  "Delete on provider": "حذف لدى المزوّد",
  "Delete \"{name}\" ({language}) in your provider account? This can't be undone.": "حذف \"{name}\" ‏({language}) من حسابك لدى المزوّد؟ لا يمكن التراجع عن ذلك.",
  "Header: {kind} (choose a media file when sending)": "الترويسة: {kind} (اختر ملف وسائط عند الإرسال)",
  "Variables: {list}": "المتغيرات: {list}",
  Drafts: "المسودات",
  "Drafts are only in LeanApp. Submitting one creates the template in your WhatsApp Business account (Meta) for review; it then appears above with Meta's status.":
    "المسودات موجودة في LeanApp فقط. إرسال مسودة ينشئ القالب في حساب WhatsApp Business ‏(Meta) للمراجعة؛ ثم يظهر أعلاه بحالته لدى Meta.",
  "No drafts.": "لا توجد مسودات.",
  "New draft": "مسودة جديدة",
  All: "الكل",
  "Language code": "رمز اللغة",
  Marketing: "تسويق",
  Utility: "خدمي",
  Authentication: "مصادقة",
  "Header (optional, fixed text)": "الترويسة (اختيارية، نص ثابت)",
  "Body: use {a}, {b} … for variables": "النص: استخدم {a} و{b} … للمتغيرات",
  "Footer (optional)": "التذييل (اختياري)",
  "Example value for each variable, one per line (Meta reviews them)": "قيمة مثال لكل متغير، واحدة في كل سطر (تراجعها Meta)",
  "Local draft": "مسودة محلية",
  "Submitted to WhatsApp (id {id}); its status is on the synced template.": "أُرسل إلى WhatsApp (المعرّف {id})؛ وحالته على القالب المتزامن.",
  "Submission refused: {error}": "رُفض الإرسال: {error}",
  "Not submitted": "لم يُرسَل",
  "Submit to WhatsApp": "إرسال إلى WhatsApp",
  "Submit this template to Meta for review?": "إرسال هذا القالب إلى Meta للمراجعة؟",
  "Delete draft": "حذف المسودة",
  "Delete the draft \"{name}\"?": "حذف المسودة \"{name}\"؟",

  // ── Settings → Channels: WhatsApp and Twilio ──────────────────────────────
  "Built to Twilio's Messages and Content APIs and tested against a local mock. Not verified with live Twilio: this changes once a real send succeeds.":
    "مبني على واجهتَي Messages وContent من Twilio ومختبَر مقابل محاكاة محلية. لم يُتحقَّق منه مع Twilio الفعلي: يتغير ذلك بعد نجاح إرسال حقيقي.",
  "Check connection": "فحص الاتصال",
  "Free-form WhatsApp messages (flows) go only to people who messaged you in the last 24 hours; replies, delivery and read receipts arrive through this webhook.":
    "رسائل WhatsApp الحرة (في التدفقات) تُرسَل فقط لمن راسلك خلال آخر 24 ساعة؛ وتصل الردود وإيصالات التسليم والقراءة عبر هذا الـWebhook.",
  "Manage templates": "إدارة القوالب",
  "Twilio (SMS, MMS and WhatsApp through Twilio)": "Twilio (الرسائل القصيرة وMMS وWhatsApp عبر Twilio)",
  "SMS goes to the phone number in a user property (E.164). SMS is text only; images (MMS) only to US and Canadian numbers. WhatsApp through Twilio uses Content templates approved for WhatsApp. People who reply STOP, denied marketing consent or are on the SMS / WhatsApp suppression list are skipped.":
    "تُرسَل الرسائل القصيرة إلى رقم الهاتف في خاصية مستخدم (E.164). الرسائل القصيرة نص فقط؛ والصور (MMS) لأرقام الولايات المتحدة وكندا فقط. يستخدم WhatsApp عبر Twilio قوالب محتوى معتمدة لـWhatsApp. يُتخطّى من يرد بـSTOP أو رفض الموافقة التسويقية أو مدرج في قائمة حظر الرسائل القصيرة / WhatsApp.",
  "Callback URL:": "رابط الإشعارات:",
  "LeanApp sets it as the status callback on every message. Also set it as \"A message comes in\" on your Twilio number or Messaging Service (HTTP POST) to receive replies and STOP. Twilio signs each request with your auth token.":
    "يضبطه LeanApp كرابط إشعار الحالة في كل رسالة. اضبطه أيضًا في \"A message comes in\" على رقمك في Twilio أو Messaging Service ‏(HTTP POST) لاستقبال الردود وSTOP. توقّع Twilio كل طلب برمز المصادقة الخاص بك.",
  "Connect Twilio": "ربط Twilio",
  "Account SID": "معرّف الحساب (Account SID)",
  "Auth token": "رمز المصادقة",
  "Messaging Service SID (optional)": "Messaging Service SID (اختياري)",
  "SMS sender number (if no Messaging Service)": "رقم مُرسِل الرسائل القصيرة (إن لم توجد Messaging Service)",
  "WhatsApp sender (optional)": "مُرسِل WhatsApp (اختياري)",
  "From the Twilio Console → Account info. The auth token also verifies Twilio's callback signatures.": "من Twilio Console ← Account info. يتحقق رمز المصادقة أيضًا من توقيعات إشعارات Twilio.",
  "No SMS at all": "بلا رسائل قصيرة إطلاقًا",

  // ── Flow builder ──────────────────────────────────────────────────────────
  "WhatsApp message (24-hour window)": "رسالة WhatsApp (نافذة 24 ساعة)",
  "Wait for delivery outcome": "انتظار نتيجة التسليم",
  "When someone replies on WhatsApp or SMS": "عندما يرد شخص على WhatsApp أو برسالة قصيرة",
  "keyword (optional)": "كلمة مفتاحية (اختيارية)",
  Keyword: "الكلمة المفتاحية",
  "Counts push, email, WhatsApp, SMS and in-app messages to the person from all automations here; over the cap, the message is skipped.":
    "يحتسب رسائل الإشعارات والبريد وWhatsApp والرسائل القصيرة والرسائل داخل التطبيق المرسلة للشخص من كل الأتمتات هنا؛ وعند تجاوز الحد تُتخطّى الرسالة.",
  "Push, email, WhatsApp and SMS wait until quiet hours end ({timezone}, the organization's timezone).":
    "تنتظر الإشعارات والبريد وWhatsApp والرسائل القصيرة حتى تنتهي ساعات الهدوء ({timezone}، المنطقة الزمنية للمؤسسة).",
  "Header media asset ID": "معرّف وسائط الترويسة",
  "Sent through Twilio.": "تُرسَل عبر Twilio.",
  "{n} SMS segment(s)": "{n} جزء رسالة قصيرة",
  "Image asset ID (MMS, US and Canada numbers only)": "معرّف الصورة (MMS، لأرقام الولايات المتحدة وكندا فقط)",
  "Media asset ID (optional)": "معرّف الوسائط (اختياري)",
  "Skipped for people without a valid number, who denied marketing consent, or who replied STOP.": "تُتخطّى لمن ليس لديه رقم صالح أو رفض الموافقة التسويقية أو رد بـSTOP.",
  "Free-form WhatsApp messages are only allowed within 24 hours of the person's last message to you; outside that window the step is skipped. Use a template to start a conversation.":
    "رسائل WhatsApp الحرة مسموحة فقط خلال 24 ساعة من آخر رسالة أرسلها إليك الشخص؛ وخارج هذه النافذة تُتخطّى الخطوة. استخدم قالبًا لبدء محادثة.",
  "Wait until the message in": "انتظر حتى تكون الرسالة في",
  "Message step": "خطوة الرسالة",
  "no earlier step": "لا توجد خطوة سابقة",
  Outcome: "النتيجة",
  "Delivered and read come from the provider's status callbacks; replied means an inbound message from the person's number. Read is reported for WhatsApp only.":
    "التسليم والقراءة يأتيان من إشعارات الحالة لدى المزوّد؛ والرد يعني رسالة واردة من رقم الشخص. تُبلَّغ القراءة لـWhatsApp فقط.",
  delivered: "سُلّمت",
  read: "قُرئت",
  "replied to": "رُدّ عليها",
  "Step {n}: wait for the outcome of an earlier step.": "الخطوة {n}: انتظر نتيجة خطوة سابقة.",
  "Step {n}: step {target} doesn't report \"{outcome}\".": "الخطوة {n}: الخطوة {target} لا تبلّغ عن \"{outcome}\".",
  "WhatsApp message (within 24 hours of their last message): {text}": "رسالة WhatsApp (خلال 24 ساعة من آخر رسالة منه): {text}",
  "SMS: {text}": "رسالة قصيرة: {text}",
  "Wait up to {hours} h for step {step} to be {outcome}, otherwise exit": "انتظر حتى {hours} ساعة حتى تكون الخطوة {step} {outcome}، وإلا فاخرج",
  "Wait up to {hours} h for step {step} to be {outcome}, otherwise go to step {n}": "انتظر حتى {hours} ساعة حتى تكون الخطوة {step} {outcome}، وإلا فانتقل إلى الخطوة {n}",
  "When someone replies {keyword} on {channel}": "عندما يرد شخص بـ{keyword} على {channel}",
  "When someone replies on {channel}": "عندما يرد شخص على {channel}",

  // ── Run log ───────────────────────────────────────────────────────────────
  "Outside the 24-hour window: the person hasn't messaged you in the last 24 hours, so only a template may be sent":
    "خارج نافذة 24 ساعة: لم يراسلك الشخص خلال آخر 24 ساعة، لذا يُسمح بإرسال قالب فقط",
  "Media not attached: {message}": "لم تُرفَق الوسائط: {message}",
  "MMS goes only to US and Canadian numbers": "تُرسَل رسائل MMS لأرقام الولايات المتحدة وكندا فقط",
  "Step {step} was {outcome}": "الخطوة {step} {outcome}",
  "Waiting for step {step} to be {outcome} (until {until})": "بانتظار أن تكون الخطوة {step} {outcome} (حتى {until})",
  "Step {step} wasn't {outcome} in time: run ends": "الخطوة {step} لم تكن {outcome} في الوقت المحدد: ينتهي التشغيل",
  "Step {step} wasn't {outcome} in time: going to step {n}": "الخطوة {step} لم تكن {outcome} في الوقت المحدد: الانتقال إلى الخطوة {n}",
  "Step {step} sent nothing to wait for": "الخطوة {step} لم ترسل شيئًا يُنتظر",
  "Sent (message)": "أُرسلت (رسالة)",

  // ── Campaign composer ─────────────────────────────────────────────────────
  "Wait out quiet hours (22:00 to 08:00, {timezone}) for push, email, WhatsApp and SMS": "انتظار انتهاء ساعات الهدوء (22:00 إلى 08:00، {timezone}) للإشعارات والبريد وWhatsApp والرسائل القصيرة",
  "User attribute": "خاصية المستخدم",
  "Fixed text": "نص ثابت",
  "Media file ({kind})": "ملف وسائط ({kind})",
  "Media library asset ID": "معرّف الملف في مكتبة الوسائط",
  "Accepted: {types}, up to {mb} MB.": "المقبول: {types}، حتى {mb} ميغابايت.",
  "This provider doesn't accept media here.": "لا يقبل هذا المزوّد الوسائط هنا.",
  "Choose an attribute": "اختر خاصية",
  "No WhatsApp provider is connected in this environment. Connect Meta's WhatsApp Cloud API or Twilio in Settings → Dev Ops → Channels.":
    "لا يوجد مزوّد WhatsApp مربوط في هذه البيئة. اربط WhatsApp Cloud API من Meta أو Twilio من الإعدادات ← عمليات التطوير ← القنوات.",
  "Search templates": "ابحث في القوالب",
  "Approved only": "المعتمدة فقط",
  "No templates are synced from {provider}. Sync them on Engage → WhatsApp templates.": "لم تُزامَن أي قوالب من {provider}. زامِنها من التفاعل ← قوالب WhatsApp.",
  "Approved by WhatsApp.": "معتمد من WhatsApp.",
  "Status: {status}. Only approved templates can be sent.": "الحالة: {status}. لا يمكن إرسال إلا القوالب المعتمدة.",
  "Variables (all required)": "المتغيرات (كلها مطلوبة)",
  "header {v}": "الترويسة {v}",
  "Fill in variable {list}.": "املأ المتغير {list}.",
  Preview: "معاينة",
  "Preview (attributes shown as references; each person gets their own values)": "معاينة (تظهر الخصائص كمراجع؛ ويتلقى كل شخص قيمه الخاصة)",
  "SMS needs Twilio, which isn't connected in this environment (Settings → Dev Ops → Channels).": "تحتاج الرسائل القصيرة إلى Twilio، وهو غير مربوط في هذه البيئة (الإعدادات ← عمليات التطوير ← القنوات).",
  "{n} characters · {segments} SMS part(s) · {encoding}": "{n} حرف · {segments} جزء رسالة قصيرة · {encoding}",
  "Add an image (MMS: US and Canadian numbers only)": "إضافة صورة (MMS: لأرقام الولايات المتحدة وكندا فقط)",
  "Goes to the person's phone number property through Twilio. Text only.": "تُرسَل إلى خاصية رقم هاتف الشخص عبر Twilio. نص فقط.",
  "Check and test": "الفحص والاختبار",
  "Checking…": "جارٍ الفحص…",
  "Check campaign": "فحص الحملة",
  "Test recipient (user ID)": "مستلم الاختبار (معرّف المستخدم)",
  "Send test": "إرسال اختبار",
  "No problems found: the provider is connected and the message can be sent.": "لم تُعثر على مشكلات: المزوّد مربوط ويمكن إرسال الرسالة.",
  "Blocks sending:": "يمنع الإرسال:",
  "Note:": "ملاحظة:",
  "{members} people in the audience; {excluded} are excluded by consent or suppression on this channel.": "{members} شخص في الجمهور؛ منهم {excluded} مستبعدون بسبب الموافقة أو الحظر على هذه القناة.",
  "The test goes to one person through the same path as the campaign (consent, approval, provider). Quiet hours and the frequency cap don't apply. At most 20 tests an hour.":
    "يُرسَل الاختبار إلى شخص واحد عبر مسار الحملة نفسه (الموافقة والاعتماد والمزوّد). لا تنطبق ساعات الهدوء ولا حد التكرار. 20 اختبارًا في الساعة كحد أقصى.",
};

export default ar;
