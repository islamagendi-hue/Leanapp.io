/** Arabic strings for the Acquisition dashboard: provenance labels and coverage warnings (see ./common.ts for the glossary). */
const ar: Record<string, string> = {
  // Overview page
  "Users, installs, sign-ups, activation, purchases, revenue, spend, CAC and ROAS by source and campaign, for the selected environment. Every number says whether LeanApp observed it, imported it, modeled it, or has no data for it.":
    "المستخدمون وعمليات التثبيت والتسجيلات والتفعيل والمشتريات والإيرادات والإنفاق وتكلفة الاكتساب والعائد على الإنفاق الإعلاني حسب المصدر والحملة، للبيئة المحددة. يوضّح كل رقم هل رصدته LeanApp أم استوردته أم قدّرته بنموذج أم لا تتوفر له بيانات.",
  "By source": "حسب المصدر",
  "Each column says what its numbers rest on; a cell is tagged where it differs. Amounts stay in their own currency.":
    "يوضّح كل عمود مصدر أرقامه، وتُوسَم الخلية حين تختلف عنه. تبقى المبالغ بعملتها الأصلية.",
  "Campaigns as named on your tracking links and UTM parameters; spend is matched to them by name. Spend entered for a whole source stays on its own row.":
    "الحملات بالأسماء الواردة في روابط التتبع ومعاملات UTM، ويُطابَق الإنفاق معها بالاسم. يبقى الإنفاق المُدخَل لمصدر كامل في صف مستقل.",
  "Showing the top {n}; {more} more are left out.": "تُعرض أعلى {n}، واستُبعد {more} غيرها.",
  "No campaign in this range.": "لا توجد حملات في هذه الفترة.",

  // Metrics and labels
  CAC: "تكلفة الاكتساب",
  ROAS: "العائد على الإنفاق الإعلاني",
  Unavailable: "غير متاح",
  Incomplete: "غير مكتمل",
  "from an ad account": "من حساب إعلاني",
  "entered by hand": "مُدخَل يدويًا",
  "Growth settings": "إعدادات النمو",
  "Paid channels with spend": "القنوات المدفوعة التي لها إنفاق",
  "Data coverage": "تغطية البيانات",
  "Nothing missing: spend covers every paid channel and every install and conversion has a source.":
    "لا شيء ناقص: يغطي الإنفاق كل قناة مدفوعة، ولكل عملية تثبيت وتحويل مصدر.",
  "What observed, imported, modeled and unavailable mean": "معنى مرصود ومستورد ومُقدَّر بنموذج وغير متاح",
  "CAC is spend ÷ new users and ROAS is revenue ÷ spend, per currency, never converted. They take the weakest label of what they rest on, and say Incomplete when spend or conversions are partial.":
    "تكلفة الاكتساب هي الإنفاق ÷ المستخدمين الجدد، والعائد على الإنفاق الإعلاني هو الإيرادات ÷ الإنفاق، لكل عملة دون تحويل. يأخذ كلٌّ منهما أضعف وسم بين ما يستند إليه، ويظهر «غير مكتمل» حين يكون الإنفاق أو التحويلات جزئية.",
  "Totals are blended across every channel, organic included.": "الإجماليات مجمّعة من كل القنوات، بما فيها العضوية.",
  "All campaigns (spend not split)": "كل الحملات (إنفاق غير مقسَّم)",
  "(no campaign)": "(بلا حملة)",
  "{users} new users · {installs} installs · revenue {revenue}": "{users} مستخدمون جدد · {installs} عمليات تثبيت · الإيرادات {revenue}",

  // Provenance
  "Observed: counted by LeanApp from your app's own events.": "مرصود: احتسبته LeanApp من أحداث تطبيقك نفسه.",
  "Imported: from outside LeanApp's event stream, from an ad account's cost import or entered by hand on Ad spend.":
    "مستورد: من خارج تدفق أحداث LeanApp، من استيراد تكاليف حساب إعلاني أو مُدخَل يدويًا في صفحة إنفاق الإعلانات.",
  "Modeled: inferred, not observed, such as installs matched on device signals.": "مُقدَّر بنموذج: مستنتج وليس مرصودًا، مثل عمليات التثبيت المطابقة بإشارات الجهاز.",
  "Unavailable: LeanApp has no data for it. The reason is shown with the number.": "غير متاح: لا تملك LeanApp بيانات له. يظهر السبب مع الرقم.",

  // Why a metric is unavailable or incomplete
  "Growth model is off": "نموذج النمو متوقف",
  "Spend needs the analytics permission": "يتطلب الإنفاق صلاحية التحليلات",
  "No spend for this paid channel": "لا يوجد إنفاق لهذه القناة المدفوعة",
  "No spend expected": "لا يُتوقع إنفاق",
  "No new users": "لا يوجد مستخدمون جدد",
  "No revenue events received": "لم تصل أحداث إيرادات",
  "Spend and revenue in different currencies": "الإنفاق والإيرادات بعملتين مختلفتين",
  "Cost import is failing": "استيراد التكاليف يفشل",
  "Cost import is behind": "استيراد التكاليف متأخر",
  "Some paid channels have no spend": "بعض القنوات المدفوعة بلا إنفاق",
  "Some installs are unattributed": "بعض عمليات التثبيت غير منسوبة",
  "Some conversions have no install on record": "بعض التحويلات بلا عملية تثبيت مسجلة",

  // Coverage warnings
  "Spend, CAC and ROAS are hidden: they need the permission to view analytics.":
    "الإنفاق وتكلفة الاكتساب والعائد على الإنفاق الإعلاني مخفية: تتطلب صلاحية عرض التحليلات.",
  "No ad spend in this range and no ad account imports its costs. CAC and ROAS are unavailable until spend is imported or entered on Ad spend.":
    "لا يوجد إنفاق إعلاني في هذه الفترة ولا يستورد أي حساب إعلاني تكاليفه. تكلفة الاكتساب والعائد على الإنفاق الإعلاني غير متاحين حتى يُستورد الإنفاق أو يُدخَل في صفحة إنفاق الإعلانات.",
  "No ad spend in this range. CAC and ROAS are unavailable until spend is imported or entered on Ad spend.":
    "لا يوجد إنفاق إعلاني في هذه الفترة. تكلفة الاكتساب والعائد على الإنفاق الإعلاني غير متاحين حتى يُستورد الإنفاق أو يُدخَل في صفحة إنفاق الإعلانات.",
  "Paid channels with activity but no spend: {channels}. Their CAC and ROAS are unavailable, and the totals are incomplete.":
    "قنوات مدفوعة لها نشاط بلا إنفاق: {channels}. تكلفة الاكتساب والعائد على الإنفاق الإعلاني لها غير متاحين، والإجماليات غير مكتملة.",
  "{provider}: cost import is failing or missing credentials. Its spend may be partial; CAC and ROAS on that channel are marked incomplete.":
    "{provider}: استيراد التكاليف يفشل أو تنقصه بيانات الاعتماد. قد يكون إنفاقه جزئيًا، وتُوسَم تكلفة الاكتساب والعائد على الإنفاق الإعلاني لتلك القناة بأنها غير مكتملة.",
  "{provider}: costs are imported only up to {day}, before the end of this range. CAC and ROAS on that channel are marked incomplete.":
    "{provider}: التكاليف مستوردة حتى {day} فقط، قبل نهاية هذه الفترة. تُوسَم تكلفة الاكتساب والعائد على الإنفاق الإعلاني لتلك القناة بأنها غير مكتملة.",
  "{provider}: cost import is set up but has not completed a call to the provider yet.":
    "{provider}: استيراد التكاليف مُعدّ لكنه لم يُكمل أي اتصال بالمزوّد بعد.",
  "{provider}: ad reporting is imported, but cost import into Ad spend is off, so its costs are not used for CAC and ROAS.":
    "{provider}: تقارير الإعلانات مستوردة، لكن استيراد التكاليف إلى إنفاق الإعلانات متوقف، فلا تُستخدم تكاليفه في تكلفة الاكتساب والعائد على الإنفاق الإعلاني.",
  "{n} campaigns have spend but no installs or conversions under the same name. Campaign names in Ad spend must match the campaign on your links or UTM parameters.":
    "{n} حملات لها إنفاق بلا عمليات تثبيت أو تحويلات بالاسم نفسه. يجب أن تطابق أسماء الحملات في إنفاق الإعلانات الحملة في روابطك أو معاملات UTM.",
  "{n} of {total} installs are unattributed ({ios} on iOS, where paid installs can't be matched without a click id, SKAdNetwork or Apple Search Ads). Per-channel users and CAC are marked incomplete.":
    "{n} من {total} عمليات تثبيت غير منسوبة ({ios} على iOS، حيث لا يمكن مطابقة التثبيتات المدفوعة دون معرّف نقرة أو SKAdNetwork أو Apple Search Ads). يُوسَم المستخدمون وتكلفة الاكتساب لكل قناة بأنها غير مكتملة.",
  "{n} of {total} installs are unattributed. Per-channel users and CAC are marked incomplete.":
    "{n} من {total} عمليات تثبيت غير منسوبة. يُوسَم المستخدمون وتكلفة الاكتساب لكل قناة بأنها غير مكتملة.",
  "{n} of {total} conversions have no install on record, so their revenue is on no channel. Per-channel ROAS is marked incomplete.":
    "{n} من {total} تحويلات بلا عملية تثبيت مسجلة، فإيراداتها ليست على أي قناة. يُوسَم العائد على الإنفاق الإعلاني لكل قناة بأنه غير مكتمل.",
  "No conversion or revenue events have been received yet. Revenue and ROAS are unavailable.":
    "لم تصل أي أحداث تحويل أو إيرادات بعد. الإيرادات والعائد على الإنفاق الإعلاني غير متاحين.",
  "Activation is unavailable: turn on the growth model to measure it.": "التفعيل غير متاح: فعّل نموذج النمو لقياسه.",
  "{n} SKAdNetwork / AdAttributionKit postbacks are provider-reported and aggregate: shown on Attribution, never added here.":
    "{n} إشعارات SKAdNetwork / AdAttributionKit يُبلغ عنها المزوّد وهي مجمّعة: تظهر في صفحة الإسناد ولا تُضاف هنا أبدًا.",
};

export default ar;
