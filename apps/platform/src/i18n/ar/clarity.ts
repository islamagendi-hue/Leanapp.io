/**
 * Arabic strings for the Microsoft Clarity integration (settings/integrations/microsoft_clarity,
 * its registry entry, the Clarity link on user profiles). Product, API and field names stay in
 * Latin script.
 */
const ar: Record<string, string> = {
  // ── Registry and Integrations Center ───────────────────────────────────────
  "Clarity identity bridge (web SDK)": "ربط الهوية مع Clarity (SDK الويب)",
  "On your website, the LeanApp web SDK tells Clarity's tag the LeanApp user id (or anonymous id) and sets the custom tag leanapp_anonymous_id, only with analytics consent. It never loads Clarity itself.":
    "على موقعك، يُبلغ SDK الويب من LeanApp وسمَ Clarity بمعرّف المستخدم في LeanApp (أو المعرّف المجهول) ويضبط الوسم المخصّص leanapp_anonymous_id، وذلك فقط بموافقة التحليلات. ولا يحمّل Clarity بنفسه أبدًا.",
  "Clarity's tag installed on your website": "وسم Clarity مثبّت على موقعك",
  "clarity: { enabled: true } in the web SDK options": "الخيار clarity: { enabled: true } في إعدادات SDK الويب",
  "Clarity's own consent signal (Clarity Consent API) in the EEA, UK and Switzerland": "إشارة الموافقة الخاصة بـ Clarity (Clarity Consent API) في المنطقة الاقتصادية الأوروبية والمملكة المتحدة وسويسرا",
  "Clarity metrics import": "استيراد مقاييس Clarity",
  "Once a day, imports Clarity's aggregate metrics (sessions, scroll depth, engagement time, dead and rage clicks, quickbacks, excessive scrolling, script errors) by page URL, device and source, within Clarity's limit of 10 requests per project per day.":
    "يستورد مرة يوميًا مقاييس Clarity المجمّعة (الجلسات، وعمق التمرير، ووقت التفاعل، والنقرات الميتة والغاضبة، والرجوع السريع، والتمرير المفرط، وأخطاء السكربت) حسب رابط الصفحة والجهاز والمصدر، ضمن حدّ Clarity البالغ 10 طلبات لكل مشروع يوميًا.",
  "Clarity Data Export API token (Settings → Data Export in Clarity)": "رمز Data Export API من Clarity (الإعدادات ← Data Export في Clarity)",
  "Data Export API token": "رمز Data Export API",
  "Open Clarity from a user profile": "فتح Clarity من ملف المستخدم",
  "User profiles link to your Clarity project, where recordings can be filtered by the custom tag leanapp_anonymous_id.":
    "تتضمّن ملفات المستخدمين رابطًا إلى مشروعك في Clarity، حيث يمكن تصفية التسجيلات بالوسم المخصّص leanapp_anonymous_id.",
  "Clarity project ID": "معرّف مشروع Clarity",
  "Open session recordings and heatmaps for the same users you find in your reports, and import Clarity's daily behaviour metrics.":
    "افتح تسجيلات الجلسات والخرائط الحرارية للمستخدمين أنفسهم الذين تجدهم في تقاريرك، واستورد مقاييس السلوك اليومية من Clarity.",
  "Turned on in your website code. LeanApp's servers can't see whether Clarity received the ids: check a recording's custom tags in Clarity.":
    "يُفعَّل في شيفرة موقعك. لا تستطيع خوادم LeanApp معرفة ما إذا استلم Clarity المعرّفات: تحقّق من الوسوم المخصّصة لأحد التسجيلات في Clarity.",
  "Turned on in your website code, with clarity: { enabled: true } in the web SDK options.": "يُفعَّل في شيفرة موقعك، بالخيار clarity: { enabled: true } في إعدادات SDK الويب.",
  "Links to your Clarity project. LeanApp doesn't check the project ID with Clarity.": "رابط إلى مشروعك في Clarity. لا يتحقّق LeanApp من معرّف المشروع لدى Clarity.",

  // ── Metrics ────────────────────────────────────────────────────────────────
  "Scroll depth": "عمق التمرير",
  "Engagement time": "وقت التفاعل",
  "Dead clicks": "نقرات ميتة",
  "Rage clicks": "نقرات غاضبة",
  Quickbacks: "رجوع سريع",
  "Excessive scrolling": "تمرير مفرط",
  "Script errors": "أخطاء السكربت",
  "Error clicks": "نقرات بها أخطاء",
  "Page URL": "رابط الصفحة",
  Device: "الجهاز",

  // ── Service and actions ────────────────────────────────────────────────────
  "Choose 1, 2 or 3 days.": "اختر يومًا أو يومين أو ثلاثة أيام.",
  "Turn on the daily import first.": "فعّل الاستيراد اليومي أولًا.",
  "Saved. Turn on the daily import to fetch Clarity's metrics.": "تم الحفظ. فعّل الاستيراد اليومي لجلب مقاييس Clarity.",
  "Daily import turned on. The first import runs on the worker's next pass.": "تم تفعيل الاستيراد اليومي. يجري أول استيراد في الدورة التالية للعامل المجدول.",
  "Daily import turned off.": "تم إيقاف الاستيراد اليومي.",
  "Not imported: today's Clarity requests are used up (10 per project per day, UTC). Try again tomorrow.":
    "لم يتم الاستيراد: استُنفدت طلبات Clarity لهذا اليوم (10 لكل مشروع يوميًا، بتوقيت UTC). حاول مجددًا غدًا.",
  "Imported {rows} rows from Clarity using {requests} requests.": "تم استيراد {rows} صفًا من Clarity باستخدام {requests} طلبات.",

  // ── Clarity page ───────────────────────────────────────────────────────────
  "Session recordings and heatmaps stay in Clarity. For {env}, LeanApp links your users to Clarity, imports Clarity's daily aggregate metrics, and opens your Clarity project from a user profile. Built from Microsoft's published documentation and not yet verified with a live Clarity project.":
    "تبقى تسجيلات الجلسات والخرائط الحرارية في Clarity. في {env}، يربط LeanApp مستخدميك بـ Clarity، ويستورد مقاييس Clarity اليومية المجمّعة، ويفتح مشروعك في Clarity من ملف المستخدم. بُني وفق وثائق Microsoft المنشورة ولم يُتحقّق منه بعد مع مشروع Clarity حقيقي.",
  "Shown in Clarity under Settings → Overview, and in your Clarity tag's address (clarity.ms/tag/<project ID>). Used for the link from user profiles.":
    "يظهر في Clarity ضمن الإعدادات ← Overview، وفي عنوان وسم Clarity لديك (clarity.ms/tag/<project ID>). يُستخدم للرابط من ملفات المستخدمين.",
  "A project admin makes it in Clarity: Settings → Data Export → Generate new API token.": "ينشئه مسؤول المشروع في Clarity: الإعدادات ← Data Export ← Generate new API token.",
  "The token is encrypted at rest and never shown again. Saving doesn't start imports: turn the daily import on below.":
    "يُشفَّر الرمز عند التخزين ولا يُعرض مرة أخرى. الحفظ لا يبدأ الاستيراد: فعّل الاستيراد اليومي أدناه.",
  "Turn off daily import": "إيقاف الاستيراد اليومي",
  "Turn on daily import": "تفعيل الاستيراد اليومي",
  "Last 24 hours": "آخر 24 ساعة",
  "Last 48 hours": "آخر 48 ساعة",
  "Last 72 hours": "آخر 72 ساعة",
  "Remove the Clarity connection and its imported metrics?": "هل تريد إزالة الربط مع Clarity ومقاييسه المستوردة؟",
  "Requests to Clarity today (UTC): {used} of {limit}. Each import uses {n}.": "الطلبات إلى Clarity اليوم (UTC): {used} من {limit}. يستخدم كل استيراد {n}.",
  "No import fits in what is left today.": "لا يتّسع ما تبقّى اليوم لأي استيراد.",
  "Imported Clarity metrics": "مقاييس Clarity المستوردة",
  "Last {hours} hours before {time} (UTC data), imported {imported}": "آخر {hours} ساعة قبل {time} (بيانات UTC)، استُوردت في {imported}",
  Breakdown: "التقسيم",
  "Connect Clarity above to import its metrics.": "اربط Clarity أعلاه لاستيراد مقاييسه.",
  "(not set)": "(غير محدّد)",
  "Values as Clarity reports them, for the period above. Each column shows one Clarity field:": "القيم كما يُبلغ عنها Clarity للفترة أعلاه. يعرض كل عمود حقلًا واحدًا من Clarity:",
  "Sessions per import": "الجلسات في كل استيراد",
  "Imported on (UTC)": "تاريخ الاستيراد (UTC)",
  "Last {hours} hours": "آخر {hours} ساعة",
  "Sessions summed over devices from Clarity's Traffic metric. Periods can overlap, so don't add rows up.":
    "مجموع الجلسات عبر الأجهزة من مقياس Traffic في Clarity. قد تتداخل الفترات، فلا تجمع الصفوف.",
  "Open Clarity from user profiles": "فتح Clarity من ملفات المستخدمين",
  "User profiles link to your Clarity project. There, filter recordings by the custom tag {tag} with the anonymous ID shown on the profile.":
    "تتضمّن ملفات المستخدمين رابطًا إلى مشروعك في Clarity. هناك، صفِّ التسجيلات بالوسم المخصّص {tag} مع المعرّف المجهول الظاهر في الملف.",
  "Open Clarity project": "فتح مشروع Clarity",
  "Add your Clarity project ID above to show a Clarity link on user profiles.": "أضف معرّف مشروع Clarity أعلاه لإظهار رابط Clarity في ملفات المستخدمين.",
  "Link LeanApp users to Clarity recordings (web)": "ربط مستخدمي LeanApp بتسجيلات Clarity (الويب)",
  "Install Clarity's tag on your website: in Clarity, Settings → Setup → Get tracking code, and paste it in the page's head. LeanApp never loads Clarity for you.":
    "ثبّت وسم Clarity على موقعك: في Clarity، الإعدادات ← Setup ← Get tracking code، والصقه في قسم head من الصفحة. لا يحمّل LeanApp أداة Clarity نيابةً عنك أبدًا.",
  "Turn the bridge on in the LeanApp web SDK:": "فعّل الربط في SDK الويب من LeanApp:",
  "With analytics consent, the SDK then calls Clarity's identify with the LeanApp user ID (or the anonymous ID) and sets the custom tag {tag}.":
    "بموافقة التحليلات، يستدعي SDK بعدها identify في Clarity بمعرّف المستخدم في LeanApp (أو المعرّف المجهول) ويضبط الوسم المخصّص {tag}.",
  "In the EEA, the UK and Switzerland Clarity needs its own consent signal. Send it from your consent banner with Clarity's Consent API; LeanApp doesn't send it for you:":
    "في المنطقة الاقتصادية الأوروبية والمملكة المتحدة وسويسرا يحتاج Clarity إلى إشارة موافقة خاصة به. أرسلها من نافذة الموافقة لديك عبر Clarity Consent API؛ لا يرسلها LeanApp نيابةً عنك:",
  "Clarity setup guide": "دليل إعداد Clarity",
  "Clarity Consent API": "واجهة الموافقة في Clarity (Consent API)",
  "Data Export API": "واجهة Data Export API",
  Requests: "الطلبات",

  // ── User profile ───────────────────────────────────────────────────────────
  "Open Microsoft Clarity": "فتح Microsoft Clarity",
  "Opens your Clarity project. To find this person's recordings, use Clarity's filters: custom user ID with this user's LeanApp user ID (or anonymous ID), or the custom tag {tag} with one of the anonymous IDs above. Recordings exist only for website visits where Clarity's tag and the LeanApp Clarity bridge ran with consent.":
    "يفتح مشروعك في Clarity. للعثور على تسجيلات هذا الشخص، استخدم مرشّحات Clarity: معرّف المستخدم المخصّص (custom user ID) مع معرّف هذا المستخدم في LeanApp (أو المعرّف المجهول)، أو الوسم المخصّص {tag} مع أحد المعرّفات المجهولة أعلاه. لا توجد تسجيلات إلا لزيارات الموقع التي عمل فيها وسم Clarity وربط LeanApp مع Clarity بموافقة.",
};

export default ar;
