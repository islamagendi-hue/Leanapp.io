/** Arabic for the attribution engine: credit models, windows per channel and their validation messages. */
const attribution: Record<string, string> = {
  "Choose last touch, first touch or last non-direct touch.": "اختر آخر نقطة تواصل أو أول نقطة تواصل أو آخر نقطة تواصل غير مباشرة.",
  "Unknown channel for an attribution window.": "قناة غير معروفة لنافذة الإسناد.",
  "Channels with their own window below use that one instead.": "القنوات التي لها نافذة خاصة أدناه تستخدم نافذتها بدلًا من ذلك.",
  "Conversions this long after the install, re-engagement or web touch are credited to its source. Default 90.":
    "تُنسب التحويلات التي تقع خلال هذه المدة بعد التثبيت أو إعادة التفاعل أو زيارة الويب إلى مصدرها. الافتراضي 90.",
  "Last non-direct touch": "آخر نقطة تواصل غير مباشرة",
  "last non-direct touch": "آخر نقطة تواصل غير مباشرة",
  "Every model is always available on Sources & campaigns; this is the one it shows first. First touch is the person's earliest install, re-engagement or web touch within the conversion window. Last non-direct touch is the latest one with a known source: a later direct, organic or unattributed visit or install never takes the credit away from it.":
    "كل النماذج متاحة دائمًا في المصادر والحملات؛ وهذا هو النموذج الذي يظهر أولًا. أول نقطة تواصل هي أقدم تثبيت أو إعادة تفاعل أو زيارة ويب للشخص ضمن نافذة التحويل. آخر نقطة تواصل غير مباشرة هي أحدثها من مصدر معروف: الزيارة أو التثبيت اللاحق المباشر أو العضوي أو غير المنسوب لا يسلبها الإسناد أبدًا.",
  "Windows per channel": "النوافذ حسب القناة",
  "Leave a field blank to use the windows above. Ad networks count conversions in their own reports with their own windows, which LeanApp doesn't change or read; these windows only decide LeanApp's own credit.":
    "اترك الحقل فارغًا لاستخدام النوافذ أعلاه. تحتسب شبكات الإعلانات التحويلات في تقاريرها بنوافذها الخاصة، ولا يغيّرها LeanApp ولا يقرأها؛ هذه النوافذ تحدد إسناد LeanApp فقط.",
  "Channel": "القناة",
  "Click lookback for {channel} (days)": "مدة الرجوع للنقرات لـ {channel} (بالأيام)",
  "Conversion window for {channel} (days)": "نافذة التحويل لـ {channel} (بالأيام)",
  "Last non-direct touch: each conversion counts for the person's latest install, re-engagement or web touch with a known source within the conversion window; a later direct, organic or unattributed touch never takes it away.":
    "آخر نقطة تواصل غير مباشرة: يُحتسب كل تحويل لأحدث تثبيت أو إعادة تفاعل أو زيارة ويب للشخص من مصدر معروف ضمن نافذة التحويل؛ ولا تسلبه نقطة تواصل لاحقة مباشرة أو عضوية أو غير منسوبة.",
};

export default attribution;
