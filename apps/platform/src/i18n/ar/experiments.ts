/**
 * Arabic strings for Engagement → Experiments (A/B tests). Glossary:
 * experiment = تجربة، variant = نسخة، control = النسخة الأصلية،
 * exposure = ظهور النسخة، goal = الهدف، uplift = التحسّن.
 */
const ar: Record<string, string> = {
  // Menu, list and status
  Experiments: "التجارب",
  "New experiment": "تجربة جديدة",
  stopped: "متوقفة",
  "Show different versions of a screen or a feature to different people, then see which one gets more of them to your goal.":
    "اعرض نسخًا مختلفة من شاشة أو ميزة على أشخاص مختلفين، ثم اعرف أيّ نسخة توصل عددًا أكبر منهم إلى هدفك.",
  "No experiments in the {env} environment yet.": "لا توجد تجارب في بيئة {env} بعد.",
  Variants: "النسخ",
  Variant: "النسخة",
  variant: "نسخة",
  Control: "النسخة الأصلية",
  control: "النسخة الأصلية",
  Weight: "الوزن",
  "weight {n}": "الوزن {n}",
  "Everyone who opens the app": "كل من يفتح التطبيق",
  "Members of {audience}": "أعضاء {audience}",
  "{n}% of them take part": "يشارك {n}% منهم",

  // What works today
  "Not built": "غير متوفر",
  "Variant assignment API": "واجهة توزيع النسخ (API)",
  "GET /v1/experiments/assignments with the public key returns each person's variant. The same person always gets the same one.":
    "يعيد GET /v1/experiments/assignments بالمفتاح العام نسخة كل شخص، ويحصل الشخص نفسه على النسخة نفسها دائمًا.",
  "getVariant in the JavaScript SDK": "الدالة getVariant في حزمة JavaScript",
  "Fetches the variant and sends the exposure event once. The SDK is not on npm yet, so it comes from the repository.":
    "تجلب النسخة وترسل حدث الظهور مرة واحدة. الحزمة غير منشورة على npm بعد، لذا تُضاف من المستودع.",
  "Android, iOS and Flutter SDKs": "حزم Android و iOS و Flutter",
  "getVariant for experiments (call the assignments API)": "الدالة getVariant للتجارب (استدعِ واجهة التوزيع)",
  "Call the API from your app, then send an experiment_exposure event with track() when the variant is shown.":
    "استدعِ الـ API من تطبيقك، ثم أرسل الحدث experiment_exposure عبر track() عند عرض النسخة.",
  "Results and significance": "النتائج والدلالة الإحصائية",
  "Conversion per variant, uplift with a 95% interval, a z-test, and a check that each variant got its share of traffic.":
    "التحويل لكل نسخة، والتحسّن مع مجال ثقة 95%، واختبار z، وفحص حصول كل نسخة على نصيبها من المشاركين.",
  "A/B tests of campaign messages": "اختبارات A/B لرسائل الحملات",
  "A campaign sends one message to its whole audience. Splitting it into variants with a holdout is not built yet.":
    "ترسل الحملة رسالة واحدة إلى جمهورها كله. تقسيمها إلى نسخ مع مجموعة مستبعدة غير متوفر بعد.",

  // Form
  "Experiment name": "اسم التجربة",
  "Key used in your app's code": "المفتاح المستخدم في كود تطبيقك",
  "Hypothesis (optional)": "الفرضية (اختياري)",
  "If we show the price on the button, more people will finish checkout.": "إذا عرضنا السعر على الزر، فسيُكمل عدد أكبر من الأشخاص الدفع.",
  "1. Variants": "1. النسخ",
  "The first row is the control. Weights set each variant's share of traffic.": "الصف الأول هو النسخة الأصلية، ويحدّد الوزن نصيب كل نسخة من المشاركين.",
  "Variant {n}": "النسخة {n}",
  "Variant {n} key": "مفتاح النسخة {n}",
  "Variant {n} name": "اسم النسخة {n}",
  "Variant {n} weight": "وزن النسخة {n}",
  "Add a variant": "أضف نسخة",
  "2. Who takes part": "2. من يشارك",
  "{name} (draft: activate it before starting)": "{name} (مسودة: فعّله قبل البدء)",
  "Traffic in the experiment (%)": "نسبة المشاركين في التجربة (%)",
  "People outside the traffic or the audience get no variant, so your app shows its default.":
    "من هم خارج النسبة أو الجمهور لا يحصلون على نسخة، فيعرض تطبيقك نسخته الافتراضية.",
  "3. Goal": "3. الهدف",
  "Within, after first exposure": "خلال، بعد أول ظهور",
  "Only when the property (optional)": "فقط عندما تكون الخاصية (اختياري)",
  "4. Secondary metric (optional)": "4. مقياس ثانوي (اختياري)",
  None: "لا شيء",
  "Another event": "حدث آخر",
  "Secondary event": "الحدث الثانوي",
  "Net revenue per exposed person, per currency, by the rules on the Revenue page.":
    "صافي الإيراد لكل شخص ظهرت له التجربة، لكل عملة، بحسب قواعد صفحة الإيرادات.",
  "The experiment is saved as a draft. Variants, traffic and the goal can't change after you start it.":
    "تُحفظ التجربة كمسودة. ولا يمكن تغيير النسخ والنسبة والهدف بعد أن تبدأها.",

  // Validation
  "Name the experiment (2 to 80 characters).": "اكتب اسمًا للتجربة (من 2 إلى 80 حرفًا).",
  "The key starts with a letter and uses lowercase letters, digits and _ (2 to 60).": "يبدأ المفتاح بحرف، ويتكوّن من حروف إنجليزية صغيرة وأرقام و _ (من 2 إلى 60).",
  "Keep the hypothesis under 1,000 characters.": "اجعل الفرضية أقل من 1,000 حرف.",
  "Each variant needs a key: a lowercase letter first, then letters, digits or _.": "تحتاج كل نسخة إلى مفتاح يبدأ بحرف إنجليزي صغير، ثم حروف أو أرقام أو _.",
  "Each variant's weight is a whole number from 1 to 1,000.": "وزن كل نسخة عدد صحيح من 1 إلى 1,000.",
  "Variant keys must be different.": "يجب أن تختلف مفاتيح النسخ.",
  "Add a control and at least one variant.": "أضف النسخة الأصلية ونسخة أخرى على الأقل.",
  "Traffic is a whole percentage from 1 to 100.": "النسبة عدد صحيح من 1 إلى 100.",
  "Choose an audience from the list.": "اختر جمهورًا من القائمة.",
  "Choose the goal event.": "اختر حدث الهدف.",
  "The goal can't be the exposure event itself.": "لا يمكن أن يكون الهدف هو حدث الظهور نفسه.",
  "The goal window is 1 to 90 days.": "مدة الهدف من يوم إلى 90 يومًا.",
  "Check the goal's property filter.": "راجع فلتر خاصية الهدف.",
  "Choose the secondary event.": "اختر الحدث الثانوي.",
  "Choose a secondary metric from the list.": "اختر مقياسًا ثانويًا من القائمة.",
  "Another experiment in this environment already uses this key.": "تستخدم تجربة أخرى في هذه البيئة هذا المفتاح بالفعل.",
  "Only a draft can be changed: people are already assigned to this experiment's variants.": "لا يمكن تعديل إلا المسودة، فقد وُزّع الأشخاص على نسخ هذه التجربة.",
  "This experiment is already running.": "هذه التجربة قيد التشغيل بالفعل.",
  "A stopped experiment can't be started again. Create a new one to test again.": "لا يمكن تشغيل تجربة متوقفة من جديد. أنشئ تجربة جديدة لتختبر مرة أخرى.",
  "Only a running experiment can be stopped.": "لا يمكن إيقاف إلا تجربة قيد التشغيل.",
  "Running. The assignment API now returns this experiment's variants.": "التجربة قيد التشغيل، وتعيد واجهة التوزيع الآن نسخ هذه التجربة.",
  "Stopped. The app gets no variant for it any more and shows its default.": "توقفت التجربة. لن يحصل التطبيق على نسخة منها بعد الآن، وسيعرض نسخته الافتراضية.",

  // Results page
  "started {date}": "بدأت {date}",
  "stopped {date}": "توقفت {date}",
  "Start experiment": "ابدأ التجربة",
  "Start assigning variants? Variants, traffic and the goal can't change after this.": "هل تبدأ توزيع النسخ؟ لن يمكن تغيير النسخ والنسبة والهدف بعد ذلك.",
  "Stop experiment": "أوقف التجربة",
  "Stop the experiment? Everyone gets your app's default from now on, and it can't be started again.":
    "هل توقف التجربة؟ سيرى الجميع النسخة الافتراضية من الآن، ولا يمكن تشغيلها مجددًا.",
  "The audience “{name}” is a draft. Activate it before starting.": "الجمهور «{name}» مسودة. فعّله قبل بدء التجربة.",
  "Experiment summary": "ملخص التجربة",
  "People exposed": "من ظهرت لهم التجربة",
  "Days running": "أيام التشغيل",
  "Can still convert": "ما زال بإمكانهم التحويل",
  "Sample ratio mismatch: the split of exposed people is far from the weights (chi-square p {p}). Check that every variant sends its exposure event before you trust these results.":
    "عدم تطابق نسبة العينة: توزيع من ظهرت لهم التجربة بعيد عن الأوزان (قيمة p لاختبار كاي تربيع {p}). تأكد أن كل نسخة ترسل حدث الظهور قبل أن تثق بهذه النتائج.",
  "No one has been exposed yet. Results start when your app sends the {event} event, which getVariant in the JavaScript SDK does for you.":
    "لم تظهر التجربة لأحد بعد. تبدأ النتائج عندما يرسل تطبيقك الحدث {event}، وتتولى getVariant في حزمة JavaScript ذلك عنك.",
  "Not enough data yet. Each variant needs {people} exposed people and {conversions} conversions before the test can tell them apart.":
    "البيانات غير كافية بعد. تحتاج كل نسخة إلى {people} شخص ظهرت لهم و{conversions} تحويلات قبل أن يميّز الاختبار بينها.",
  "{event} where {property} {op} {value}, within {n} days of first exposure": "{event} حيث {property} {op} {value}، خلال {n} يوم من أول ظهور",
  "{event} within {n} days of first exposure": "{event} خلال {n} يوم من أول ظهور",
  Exposed: "ظهرت لهم",
  "Uplift (95% CI)": "التحسّن (ثقة 95%)",
  "Points (95% CI)": "الفرق بالنقاط (ثقة 95%)",
  "p-value": "قيمة p",
  "Better than control": "أفضل من الأصلية",
  "Worse than control": "أسوأ من الأصلية",
  "No clear difference": "لا فرق واضح",
  "Not enough data yet": "البيانات غير كافية بعد",
  Baseline: "خط الأساس",
  "Secondary metric": "المقياس الثانوي",
  "Revenue per exposed person": "الإيراد لكل شخص ظهرت له التجربة",
  "Net revenue within {n} days of first exposure, per currency, with no conversion between currencies. Not tested for significance.":
    "صافي الإيراد خلال {n} يوم من أول ظهور، لكل عملة على حدة ودون تحويل بين العملات. لم تُختبر دلالته الإحصائية.",
  "No revenue from exposed people yet.": "لا إيرادات بعد ممن ظهرت لهم التجربة.",
  "Per exposed person": "لكل شخص ظهرت له",
  "People exposed so far": "من ظهرت لهم التجربة حتى الآن",
  "People exposed so far, per variant": "من ظهرت لهم التجربة حتى الآن، لكل نسخة",
  "Days in the project's timezone ({timezone}).": "الأيام بتوقيت المشروع ({timezone}).",
  "How to read this": "كيف تقرأ النتائج",
  "Pick an end date or sample size before you start, and judge the result then. Stopping at the first significant day makes a false winner much more likely.":
    "حدّد تاريخ انتهاء أو حجم عينة قبل البدء، واحكم على النتيجة عندها. فالتوقف عند أول يوم تظهر فيه دلالة يرفع كثيرًا احتمال فائز زائف.",
  "Each variant is compared with the control by a two-sided z-test. With {n} variants, a result counts as significant below p {alpha}, so testing several doesn't add false winners.":
    "تُقارن كل نسخة بالأصلية باختبار z ثنائي الطرف. ومع {n} نسخ، تُعدّ النتيجة دالة تحت p {alpha}، حتى لا يزيد اختبار عدة نسخ الفائزين الزائفين.",
  "The variant is compared with the control by a two-sided z-test, significant below p 0.05. Intervals are 95%.":
    "تُقارن النسخة بالأصلية باختبار z ثنائي الطرف، وتُعدّ النتيجة دالة تحت p 0.05. ومجالات الثقة 95%.",
  "Each person counts once, in the variant of their first exposure, and converts if they do the goal within the window after it.":
    "يُحسب كل شخص مرة واحدة في نسخة أول ظهور له، ويُعدّ متحوّلًا إذا حقق الهدف خلال المدة التي تليه.",
  "{n} people were exposed to more than one variant, usually after signing in on a new device.":
    "ظهرت أكثر من نسخة لـ {n} شخص، وغالبًا ما يحدث ذلك بعد تسجيل الدخول من جهاز جديد.",
  Setup: "الإعداد",
  'In your app: Analytics.getVariant("{key}") returns the variant\'s key, or null when the person isn\'t in the experiment.':
    'في تطبيقك: تعيد Analytics.getVariant("{key}") مفتاح النسخة، أو null إذا لم يكن الشخص ضمن التجربة.',
};

export default ar;
