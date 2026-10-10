/**
 * Arabic strings for the flows library (src/modules/automation/library.ts and
 * components/engage/FlowLibrary.tsx): the page's labels and every template's
 * name, description and default messages, in Modern Standard Arabic.
 */
const ar: Record<string, string> = {
  // ── Page ──────────────────────────────────────────────────────────────────
  "Flows library": "مكتبة التدفقات",
  "Start from a template": "ابدأ من قالب",
  "Ready-made flows, created as drafts with events, messages and timing filled in.": "تدفقات جاهزة تُنشأ كمسودات بأحداثها ورسائلها وتوقيتها معبّأة مسبقًا.",
  "Search the library": "ابحث في المكتبة",
  Search: "بحث",
  "Cart, trial, WhatsApp…": "السلة، التجربة، WhatsApp…",
  Category: "الفئة",
  "All categories": "كل الفئات",
  Goal: "الهدف",
  "All goals": "كل الأهداف",
  "Message language": "لغة الرسائل",
  Apply: "تطبيق",
  Clear: "مسح",
  "Showing {n} of {total} flows": "عرض {n} من {total} تدفقًا",
  "No flow matches. Try another word or clear the filters.": "لا يوجد تدفق مطابق. جرّب كلمة أخرى أو امسح عوامل التصفية.",
  "Nothing is sent until you activate a flow.": "لا يُرسَل شيء حتى تفعّل التدفق.",
  "Flows keep the frequency cap and quiet hours.": "تلتزم التدفقات بحدّ التكرار وساعات الهدوء.",
  "In-app messages show once your app fetches them.": "تظهر الرسائل داخل التطبيق حين يجلبها تطبيقك.",
  "You can edit every step after creating a flow.": "يمكنك تعديل كل خطوة بعد إنشاء التدفق.",
  "Goal: {goal}": "الهدف: {goal}",
  Channels: "القنوات",
  "{channel}: not connected": "{channel}: غير مربوط",
  "Preview the steps": "معاينة الخطوات",
  "Goal event": "حدث الهدف",
  "{n} days": "{n} يوم",
  "Exit event": "حدث الخروج",
  "Ready: its events arrive and its channels are connected.": "جاهز: أحداثه تصل وقنواته مربوطة.",
  "Before it can run": "قبل أن يعمل",
  "Use this flow": "استخدم هذا التدفق",
  "Events it needs": "الأحداث التي يحتاجها",
  "WhatsApp template": "قالب WhatsApp",
  "Choose a template": "اختر قالبًا",
  "{name} ({language}), {n} variables": "{name} ({language})، {n} متغيرات",
  "Template variables, one per line": "متغيرات القالب، متغير في كل سطر",
  "Leave empty when the template has no variables.": "اتركه فارغًا إذا لم يكن للقالب متغيرات.",
  "Saved as a draft, in {language}.": "يُحفظ كمسودة، باللغة {language}.",
  "Fix the items above to use this flow.": "عالج البنود أعلاه لتتمكن من استخدام هذا التدفق.",
  "The approved WhatsApp template you choose below.": "قالب WhatsApp المعتمد الذي تختاره أدناه.",
  "sent by your app": "يرسله تطبيقك",
  "planned, not received": "مخطط، لم يصل",
  "not tracked yet": "غير متتبَّع بعد",
  "isn't tracked yet.": "غير متتبَّع بعد.",
  "Add it to the tracking plan": "أضفه إلى خطة التتبّع",
  "hasn't arrived in {env} yet.": "لم يصل إلى {env} بعد.",
  "Check the event debugger": "افحص أداة تصحيح الأحداث",
  "{channel} isn't connected in {env}.": "{channel} غير مربوط في {env}.",
  "Connect {channel}": "اربط {channel}",
  "No approved WhatsApp template is synced yet.": "لا يوجد قالب WhatsApp معتمد ومُزامَن بعد.",
  "Sync WhatsApp templates": "زامن قوالب WhatsApp",
  "Also creates this audience as a draft:": "يُنشئ أيضًا هذا الجمهور كمسودة:",
  "Activate it before the flow.": "فعّله قبل التدفق.",
  "This flow creates an audience, which your role can't do.": "يُنشئ هذا التدفق جمهورًا، ودورك لا يسمح بذلك.",
  "Choose a flow from the library.": "اختر تدفقًا من المكتبة.",
  "Choose an approved WhatsApp template for this flow.": "اختر قالب WhatsApp معتمدًا لهذا التدفق.",
  "The audience definition is not valid.": "تعريف الجمهور غير صالح.",

  // ── Categories, goals, channels ───────────────────────────────────────────
  Onboarding: "التهيئة",
  Conversion: "التحويل",
  Subscriptions: "الاشتراكات",
  "Post-purchase": "ما بعد الشراء",
  Retention: "الاحتفاظ",
  Activation: "التفعيل",
  "First purchase": "أول عملية شراء",
  "Recover lost sales": "استرداد المبيعات الضائعة",
  "Paid subscriptions": "الاشتراكات المدفوعة",
  "Repeat purchases": "تكرار الشراء",
  "Reviews and referrals": "التقييمات والإحالات",
  "Bring users back": "إعادة المستخدمين",
  Push: "إشعار Push",
  Email: "البريد الإلكتروني",
  "In-app": "داخل التطبيق",

  // ── Event slots ───────────────────────────────────────────────────────────
  "Sign-up event": "حدث التسجيل",
  "Key action (what a set-up user does)": "الإجراء الأساسي (ما يفعله المستخدم بعد إكمال الإعداد)",
  "Product viewed event": "حدث مشاهدة المنتج",
  "Added to wishlist event": "حدث الإضافة إلى المفضلة",
  "Added to cart event": "حدث الإضافة إلى السلة",
  "Checkout started event": "حدث بدء الدفع",
  "Purchase event": "حدث الشراء",
  "Order delivered event": "حدث توصيل الطلب",
  "Review event": "حدث التقييم",
  "Invite shared event": "حدث مشاركة الدعوة",
  "App opened event": "حدث فتح التطبيق",
  "Feature used event": "حدث استخدام الميزة",
  "Verification started event": "حدث بدء التحقق من الهوية",
  "Verification completed event": "حدث اكتمال التحقق من الهوية",
  "Trial started event": "حدث بدء الفترة التجريبية",
  "Paywall viewed event": "حدث عرض صفحة الاشتراك",
  "Subscription started event": "حدث بدء الاشتراك",
  "Subscription renewed event": "حدث تجديد الاشتراك",
  "Payment failed event": "حدث فشل الدفع",
  "Subscription ended event": "حدث انتهاء الاشتراك",

  // ── Welcome series ────────────────────────────────────────────────────────
  "Welcome series": "سلسلة الترحيب",
  "Greets new users right after sign-up, sends a getting-started email the next day and a tips message three days later.":
    "يرحّب بالمستخدمين الجدد فور التسجيل، ويرسل بريدًا للبدء في اليوم التالي، ثم رسالة نصائح بعد ثلاثة أيام.",
  "Welcome aboard!": "أهلًا بك معنا!",
  "Thanks for signing up. Take a quick look around, your first steps only take a minute.": "شكرًا لتسجيلك. ألقِ نظرة سريعة، فخطواتك الأولى لا تستغرق سوى دقيقة.",
  "Getting started": "لنبدأ",
  "Welcome! Here are a few things to do first: complete your profile, explore what's new and turn on notifications so you never miss an update.":
    "أهلًا بك! إليك بعض ما يمكنك فعله أولًا: أكمل ملفك الشخصي، واستكشف الجديد، وفعّل الإشعارات حتى لا يفوتك أي تحديث.",
  "Need a hand?": "هل تحتاج إلى مساعدة؟",
  "Here are a few tips to get the most out of the app.": "إليك بعض النصائح للاستفادة القصوى من التطبيق.",
  "Show me": "أرني",

  // ── Onboarding nudge ──────────────────────────────────────────────────────
  "Onboarding nudge": "تذكير بإكمال الإعداد",
  "Reminds people who signed up but haven't done the key action yet: a push after one day, an email two days later. Stops as soon as they do it.":
    "يذكّر من سجّلوا ولم يُنجزوا الإجراء الأساسي بعد: إشعار Push بعد يوم، ثم بريد إلكتروني بعد يومين. يتوقف فور إنجازهم له.",
  "You're almost there": "أوشكت على الانتهاء",
  "Finish setting up to unlock everything the app has to offer.": "أكمل الإعداد لتستفيد من كل ما يقدّمه التطبيق.",
  "Finish setting up your account": "أكمل إعداد حسابك",
  "You signed up a few days ago but haven't finished getting started. It only takes a minute, and we're here if you need help.":
    "سجّلت قبل بضعة أيام لكنك لم تُكمل خطوات البدء بعد. لن يستغرق ذلك سوى دقيقة، ونحن هنا إن احتجت إلى مساعدة.",

  // ── Finish identity verification ──────────────────────────────────────────
  "Finish identity verification": "إكمال التحقق من الهوية",
  "For finance apps: reminds people who started identity verification and didn't finish, with a push after two hours and an email the next day. Stops once they're verified.":
    "لتطبيقات الخدمات المالية: يذكّر من بدأ التحقق من هويته ولم يُكمله، بإشعار Push بعد ساعتين وبريد إلكتروني في اليوم التالي. يتوقف فور اكتمال التحقق.",
  "Your verification is almost done": "أوشكت على إكمال التحقق",
  "Pick up where you left off. It takes a few minutes and unlocks your full account.": "تابع من حيث توقفت. يستغرق الأمر دقائق، وبعدها تستخدم حسابك بالكامل.",
  "Finish verifying your identity": "أكمل التحقق من هويتك",
  "You started verifying your identity but didn't finish. Keep your ID card or passport at hand and complete the last steps in the app. It takes a few minutes.":
    "بدأت التحقق من هويتك ولم تُكمله بعد. جهّز بطاقة الهوية أو جواز السفر، وأكمل الخطوات الأخيرة في التطبيق. يستغرق الأمر دقائق.",

  // ── Feature discovery ─────────────────────────────────────────────────────
  "Feature discovery": "اكتشاف الميزات",
  "Shows set-up users a feature they haven't tried yet: an in-app message after three days and a push four days later. Stops once they use it.":
    "يعرّف من أكملوا الإعداد بميزة لم يجرّبوها بعد: رسالة داخل التطبيق بعد ثلاثة أيام، ثم إشعار Push بعد أربعة أيام. يتوقف فور استخدامها.",
  "Have you tried this yet?": "هل جرّبت هذه الميزة؟",
  "There's more you can do in the app. Take a quick tour of a feature people use every week.": "يمكنك فعل المزيد في التطبيق. تعرّف في جولة قصيرة على ميزة يستخدمها الناس كل أسبوع.",
  "Take the tour": "ابدأ الجولة",
  "One more thing to try": "ميزة أخرى تستحق التجربة",
  "Get more done with a feature you haven't used yet. Open the app to try it.": "أنجز أكثر بميزة لم تستخدمها بعد. افتح التطبيق وجرّبها.",

  // ── First purchase nudge ──────────────────────────────────────────────────
  "First purchase nudge": "تشجيع على أول عملية شراء",
  "Encourages new users who haven't bought yet: a push two days after sign-up and an email three days later. Add your welcome offer to the copy if you run one.":
    "يشجّع المستخدمين الجدد الذين لم يشتروا بعد: إشعار Push بعد يومين من التسجيل، ثم بريد إلكتروني بعد ثلاثة أيام. أضف عرض الترحيب إلى النص إن كان لديك عرض.",
  "Your first order is a few taps away": "طلبك الأول على بُعد نقرات",
  "Browse today's picks and order when you're ready. We're here if you need help.": "تصفّح مختارات اليوم واطلب متى شئت، ونحن هنا إن احتجت إلى مساعدة.",
  "Ready for your first order?": "هل أنت مستعد لطلبك الأول؟",
  "Thanks for joining. Everything is ready for your first order: browse, add what you like to your cart and check out in a few steps.":
    "شكرًا لانضمامك. كل شيء جاهز لطلبك الأول: تصفّح، وأضف ما يعجبك إلى السلة، وأكمل الدفع في خطوات قليلة.",

  // ── Browse abandonment ────────────────────────────────────────────────────
  "Browse abandonment": "تصفّح دون شراء",
  "Follows up when someone views a product but doesn't add it to the cart: a push after three hours and an in-app message the next day. At most every three days.":
    "يتابع من شاهد منتجًا دون أن يضيفه إلى السلة: إشعار Push بعد ثلاث ساعات، ثم رسالة داخل التطبيق في اليوم التالي. مرة كل ثلاثة أيام على الأكثر.",
  "Still thinking it over?": "ما زلت تفكّر في الأمر؟",
  "Take another look at what caught your eye and add it to your cart when you're ready.": "ألقِ نظرة أخرى على ما لفت انتباهك، وأضفه إلى سلتك متى شئت.",
  "Pick up where you left off": "تابع من حيث توقفت",
  "The products you viewed are one tap away.": "المنتجات التي شاهدتها على بُعد نقرة واحدة.",
  "View products": "اعرض المنتجات",

  // ── Wishlist reminder ─────────────────────────────────────────────────────
  "Wishlist reminder": "تذكير بقائمة المفضلة",
  "Reminds people about items they saved to their wishlist and haven't bought: a push after three days and an email four days later.":
    "يذكّر بالمنتجات التي حُفظت في قائمة المفضلة ولم تُشترَ بعد: إشعار Push بعد ثلاثة أيام، ثم بريد إلكتروني بعد أربعة أيام.",
  "Still on your wishlist": "ما زالت في قائمة مفضلتك",
  "The items you saved are waiting for you. Order them whenever you're ready.": "المنتجات التي حفظتها بانتظارك. اطلبها متى شئت.",
  "Your saved items are waiting": "منتجاتك المحفوظة بانتظارك",
  "You saved a few items to your wishlist. Open the app to take another look and order the ones you love.":
    "حفظت بعض المنتجات في قائمة المفضلة. افتح التطبيق لتلقي نظرة أخرى، واطلب ما أعجبك منها.",

  // ── Abandoned cart ────────────────────────────────────────────────────────
  "Abandoned cart": "السلة المتروكة",
  "Reminds people who added something to their cart but didn't start checkout: a push after one hour, an email the next day. Stops when they check out or buy.":
    "يذكّر من أضافوا منتجات إلى السلة ولم يبدؤوا الدفع: إشعار Push بعد ساعة، ثم بريد إلكتروني في اليوم التالي. يتوقف عند بدء الدفع أو الشراء.",
  "You left something in your cart": "تركت شيئًا في سلتك",
  "Your items are still waiting. Complete your order before they're gone.": "منتجاتك ما زالت بانتظارك. أكمل طلبك قبل نفادها.",
  "Your cart is waiting": "سلتك بانتظارك",
  "You added items to your cart but didn't check out. They're saved for you, so come back and complete your order whenever you're ready.":
    "أضفت منتجات إلى سلتك لكنك لم تُكمل الدفع. احتفظنا بها لك، فعُد وأكمل طلبك متى شئت.",

  // ── Cart reminder on push and WhatsApp ────────────────────────────────────
  "Cart reminder on push and WhatsApp": "تذكير بالسلة عبر Push وWhatsApp",
  "Reminds people who left items in their cart: a push after one hour, then your approved WhatsApp template the next day. Stops when they check out or buy.":
    "يذكّر من ترك منتجات في سلته: إشعار Push بعد ساعة، ثم قالب WhatsApp المعتمد لديك في اليوم التالي. يتوقف عند بدء الدفع أو الشراء.",

  // ── Checkout without an order ─────────────────────────────────────────────
  "Checkout without an order": "دفع لم يكتمل بطلب",
  "Follows up when someone starts checkout (or their payment fails) and no order comes through: a push after 30 minutes, an email the next day. Stops when they buy.":
    "يتابع من بدأ الدفع (أو فشلت عملية الدفع لديه) دون أن يكتمل الطلب: إشعار Push بعد 30 دقيقة، ثم بريد إلكتروني في اليوم التالي. يتوقف عند الشراء.",
  "Your order isn't complete yet": "طلبك لم يكتمل بعد",
  "Tap to finish your order, it only takes a moment.": "اضغط لإكمال طلبك، فالأمر لا يستغرق سوى لحظة.",
  "Complete your order": "أكمل طلبك",
  "It looks like your order wasn't completed. If your payment didn't go through, you can try again or choose another payment method.":
    "يبدو أن طلبك لم يكتمل. إن لم تنجح عملية الدفع، يمكنك المحاولة مجددًا أو اختيار وسيلة دفع أخرى.",

  // ── Trial to paid ─────────────────────────────────────────────────────────
  "Trial to paid": "من التجربة إلى الاشتراك",
  "Helps trial users subscribe before the trial ends, timed for a 7-day trial: tips on day 2, a push on day 5 and an email on day 6. Stops when they subscribe.":
    "يساعد مستخدمي الفترة التجريبية على الاشتراك قبل انتهائها، بتوقيت يناسب تجربة من 7 أيام: نصائح في اليوم 2، وإشعار Push في اليوم 5، وبريد إلكتروني في اليوم 6. يتوقف عند الاشتراك.",
  "Make the most of your trial": "استفد من فترتك التجريبية",
  "Try the features subscribers use most while your trial is active.": "جرّب الميزات الأكثر استخدامًا لدى المشتركين ما دامت فترتك التجريبية سارية.",
  "Explore features": "استكشف الميزات",
  "Your trial ends soon": "فترتك التجريبية تنتهي قريبًا",
  "Subscribe now to keep everything you've set up without interruption.": "اشترك الآن لتحتفظ بكل ما أعددته دون انقطاع.",
  "Your trial ends tomorrow": "فترتك التجريبية تنتهي غدًا",
  "Your trial ends tomorrow. Subscribe today to keep your progress and full access. You can cancel at any time.":
    "تنتهي فترتك التجريبية غدًا. اشترك اليوم لتحتفظ بتقدّمك وبوصولك الكامل، ويمكنك الإلغاء في أي وقت.",

  // ── Paywall follow-up ─────────────────────────────────────────────────────
  "Paywall follow-up": "متابعة بعد صفحة الاشتراك",
  "Follows up a day after someone views your plans without subscribing, with one push. At most once a week per person.":
    "يتابع بعد يوم من مشاهدة خطط الاشتراك دون الاشتراك، بإشعار Push واحد. مرة في الأسبوع على الأكثر لكل شخص.",
  "Still deciding?": "ما زلت تفكّر؟",
  "See everything a subscription unlocks and choose the plan that suits you.": "اكتشف كل ما يتيحه الاشتراك، واختر الخطة التي تناسبك.",

  // ── Failed payment recovery ───────────────────────────────────────────────
  "Failed payment recovery": "معالجة الدفعات المتعثرة",
  "Asks subscribers to update their payment method when a renewal fails: a push right away, an email the next day and an in-app message two days later. Stops once the renewal goes through.":
    "يطلب من المشتركين تحديث وسيلة الدفع عند تعثّر التجديد: إشعار Push فورًا، ثم بريد إلكتروني في اليوم التالي، ثم رسالة داخل التطبيق بعد يومين. يتوقف فور نجاح التجديد.",
  "Your payment didn't go through": "لم تنجح عملية الدفع",
  "Update your payment method to keep your subscription active.": "حدّث وسيلة الدفع ليبقى اشتراكك فعّالًا.",
  "Update your payment method": "حدّث وسيلة الدفع",
  "We couldn't process the payment for your subscription. Update your card or choose another payment method to keep your access without interruption.":
    "تعذّرت معالجة دفعة اشتراكك. حدّث بطاقتك أو اختر وسيلة دفع أخرى لتحتفظ بوصولك دون انقطاع.",
  "Your subscription needs attention": "اشتراكك يحتاج إلى انتباهك",
  "Your last payment failed. Update your payment method to keep your access.": "فشلت دفعتك الأخيرة. حدّث وسيلة الدفع لتحتفظ بوصولك.",
  "Update payment": "حدّث الدفع",

  // ── Expired subscription win-back ─────────────────────────────────────────
  "Expired subscription win-back": "استعادة الاشتراكات المنتهية",
  "Invites people whose subscription ended to come back: a push a day later and an email after a week. Stops when they subscribe again.":
    "يدعو من انتهى اشتراكهم إلى العودة: إشعار Push بعد يوم، ثم بريد إلكتروني بعد أسبوع. يتوقف عند اشتراكهم من جديد.",
  "Your subscription has ended": "انتهى اشتراكك",
  "Renew any time to pick up right where you left off.": "جدّد اشتراكك في أي وقت لتتابع من حيث توقفت.",
  "Come back to everything you had": "عُد إلى كل ما كان لديك",
  "Your subscription ended last week. Renew today to get your full access back and continue where you stopped.":
    "انتهى اشتراكك الأسبوع الماضي. جدّده اليوم لتستعيد وصولك الكامل وتتابع من حيث توقفت.",

  // ── Thank-you and review request ──────────────────────────────────────────
  "Thank-you and review request": "شكر وطلب تقييم",
  "Thanks people right after a purchase and asks for a review three days later, unless they have already left one. At most once a month per person.":
    "يشكر العملاء فور الشراء ويطلب تقييمًا بعد ثلاثة أيام ما لم يكونوا قد قيّموا بالفعل. مرة واحدة في الشهر على الأكثر لكل شخص.",
  "Thank you for your order!": "شكرًا على طلبك!",
  "We appreciate your purchase and hope you enjoy it.": "نقدّر شراءك ونتمنى أن ينال إعجابك.",
  "How was your order?": "كيف كان طلبك؟",
  "Tell us what you think. Your review helps other customers and helps us improve.": "أخبرنا برأيك. يساعد تقييمك العملاء الآخرين ويساعدنا على التحسّن.",

  // ── Rating after delivery ─────────────────────────────────────────────────
  "Rating after delivery": "طلب تقييم بعد التوصيل",
  "Asks for a rating the day after an order is delivered, while the experience is fresh. Skipped if they already left a review. At most once a month per person.":
    "يطلب تقييمًا في اليوم التالي لتوصيل الطلب، والتجربة ما زالت حاضرة. لا يُرسَل لمن قيّم بالفعل، ومرة في الشهر على الأكثر لكل شخص.",
  "Enjoying your order?": "هل أعجبك طلبك؟",
  "If you're happy with it, a quick rating helps us a lot.": "إن كنت راضيًا عنه، فتقييم سريع منك يساعدنا كثيرًا.",
  "Rate us": "قيّمنا",

  // ── Second order nudge ────────────────────────────────────────────────────
  "Second order nudge": "تشجيع على الطلب الثاني",
  "Reaches first-time buyers who haven't ordered again a week later: a push, then an in-app message three days later. Creates the audience it starts from.":
    "يصل إلى من اشتروا أول مرة ولم يطلبوا مجددًا بعد أسبوع: إشعار Push، ثم رسالة داخل التطبيق بعد ثلاثة أيام. يُنشئ الجمهور الذي يبدأ منه.",
  "One-time buyers, 7+ days": "مشترو المرة الواحدة، 7 أيام فأكثر",
  "Bought exactly once in the last 60 days, and not in the last 7. Created by the flows library.": "اشتروا مرة واحدة فقط خلال آخر 60 يومًا، وليس خلال آخر 7 أيام. أنشأته مكتبة التدفقات.",
  "Time for another order?": "هل حان وقت طلب جديد؟",
  "Your last order was a week ago. See what's new and order again in a few taps.": "مرّ أسبوع على طلبك الأخير. اكتشف الجديد واطلب مجددًا في بضع نقرات.",
  "Order again": "اطلب مجددًا",
  "Find what you ordered last time, and new picks we think you'll like.": "اعثر على ما طلبته في المرة السابقة، وعلى مختارات جديدة نظن أنها ستعجبك.",

  // ── Referral ask for loyal customers ──────────────────────────────────────
  "Referral ask for loyal customers": "دعوة العملاء الأوفياء إلى الإحالة",
  "Asks customers who reach three purchases in 90 days to invite a friend: an in-app message, then a push three days later. Creates the audience it starts from.":
    "يدعو العملاء الذين بلغوا ثلاث عمليات شراء خلال 90 يومًا إلى دعوة صديق: رسالة داخل التطبيق، ثم إشعار Push بعد ثلاثة أيام. يُنشئ الجمهور الذي يبدأ منه.",
  "Loyal customers, 3+ orders": "عملاء أوفياء، 3 طلبات فأكثر",
  "Bought at least 3 times in the last 90 days. Created by the flows library.": "اشتروا 3 مرات على الأقل خلال آخر 90 يومًا. أنشأته مكتبة التدفقات.",
  "Know someone who'd like this?": "هل تعرف من سيعجبه هذا؟",
  "Share the app with friends and family who'd enjoy it as much as you do.": "شارك التطبيق مع الأصدقاء والعائلة ممن سيستمتعون به مثلك.",
  "Invite a friend": "ادعُ صديقًا",
  "Share the app with a friend": "شارك التطبيق مع صديق",
  "Know someone who'd enjoy it? Send them an invite from the app.": "هل تعرف من سيستمتع به؟ أرسل إليه دعوة من التطبيق.",

  // ── Win back inactive users ───────────────────────────────────────────────
  "Win back inactive users": "استعادة المستخدمين غير النشطين",
  "Reaches people who haven't used the app for 7 days, again at 14 and at 30 days, by push and email. Stops as soon as they come back. Creates the audience it starts from.":
    "يصل إلى من لم يستخدموا التطبيق منذ 7 أيام، ثم عند 14 يومًا و30 يومًا، عبر إشعار Push والبريد الإلكتروني. يتوقف فور عودتهم، ويُنشئ الجمهور الذي يبدأ منه.",
  "Inactive for 7+ days": "غير نشطين منذ 7 أيام فأكثر",
  "Last seen more than 7 days ago. Created by the flows library.": "آخر ظهور قبل أكثر من 7 أيام. أنشأته مكتبة التدفقات.",
  "We miss you": "اشتقنا إليك",
  "It's been a while. Come back and see what's new.": "مرّ وقت طويل. عُد واكتشف الجديد.",
  "It's been a while": "مرّ وقت طويل",
  "We haven't seen you in a few weeks. A lot has changed since your last visit, so come back and take a look.":
    "لم نرك منذ بضعة أسابيع. تغيّر الكثير منذ زيارتك الأخيرة، فعُد وألقِ نظرة.",
  "There's something new for you": "لدينا جديد من أجلك",
  "A lot has changed since your last visit. Open the app to catch up.": "تغيّر الكثير منذ زيارتك الأخيرة. افتح التطبيق لتطّلع على الجديد.",

  // ── Re-engage lapsed buyers ───────────────────────────────────────────────
  "Re-engage lapsed buyers": "إعادة تنشيط المشترين المنقطعين",
  "Reaches customers who bought in the past year but not in the last 30 days: a push, then an email a week later. Stops when they buy. Creates the audience it starts from.":
    "يصل إلى العملاء الذين اشتروا خلال العام الماضي وليس خلال آخر 30 يومًا: إشعار Push، ثم بريد إلكتروني بعد أسبوع. يتوقف عند الشراء، ويُنشئ الجمهور الذي يبدأ منه.",
  "Lapsed buyers, 30+ days": "مشترون منقطعون، 30 يومًا فأكثر",
  "Bought in the last 365 days, but not in the last 30. Created by the flows library.": "اشتروا خلال آخر 365 يومًا، لكن ليس خلال آخر 30 يومًا. أنشأته مكتبة التدفقات.",
  "Ready for your next order?": "هل أنت مستعد لطلبك التالي؟",
  "It's been a month since your last order. See what's new since then.": "مرّ شهر على طلبك الأخير. اكتشف ما الجديد منذ ذلك الحين.",
  "We picked a few things for you": "اخترنا لك بعض الأشياء",
  "It's been a while since your last order. Come back and discover what's new, we think you'll find something you like.":
    "مرّ وقت على طلبك الأخير. عُد واكتشف الجديد، فنحن نظن أنك ستجد ما يعجبك.",
};
export default ar;
