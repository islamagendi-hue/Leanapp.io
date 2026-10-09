import Link from "next/link";
import { generatePlanAction, saveSectionAction } from "@/app/actions/implementation";
import { ActionForm } from "@/components/ActionForm";
import { QuestionField, type SerializedQuestion } from "@/components/QuestionField";
import { classifyBusiness } from "@/modules/implementation/classifier";
import { MODEL_LABELS } from "@/modules/implementation/catalog/models";
import { isVisible, nextQuestions, optionsFor, progress, QUESTIONS, SECTIONS, type SectionKey } from "@/modules/implementation/questions";
import { localizeText } from "@/modules/implementation/localize";
import { getProject, listVersions } from "@/modules/implementation/service";
import { getLang, getT } from "@/i18n/server";
import { can } from "@/modules/rbac/authorize";
import { loadApp } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Implementation questions") };
}

export default async function QuestionsPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/implementation/questions">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a } = await loadApp(org, app);
  const project = await getProject(ctx, a.id);
  const answers = project.answers;
  const p = progress(answers);
  const next = nextQuestions(answers);
  const requested = SECTIONS.find((s) => s.key === sp.section);
  const section = requested ?? next?.section ?? null;
  const editable = can(ctx.role, "implementation.edit");
  const versions = await listVersions(ctx, a.id);
  const base = `/o/${org}/apps/${app}/settings/dev-ops/implementation/questions`;
  const t = await getT();
  const lang = await getLang();

  const questions: SerializedQuestion[] = section
    ? QUESTIONS.filter((q) => q.section === section.key && isVisible(q, answers)).map((q) => ({
        key: q.key,
        type: q.type,
        prompt: t(q.prompt),
        help: q.help && t(q.help),
        required: q.required,
        options: optionsFor(q, answers).map((o) => ({ value: o.value, label: t(o.label) })),
        allowOther: !!q.allowOther,
        placeholder: q.placeholder && t(q.placeholder),
        value: q.key in answers ? answers[q.key] : (q.suggest?.(answers) ?? undefined),
      }))
    : [];
  const c = classifyBusiness(answers);
  const readAs = (c.secondary.length
    ? t("We read your business as {model} with {secondary} behaviour.", { secondary: c.secondary.map((m) => t(MODEL_LABELS[m])).join(lang === "ar" ? "، " : ", ") })
    : t("We read your business as {model}.")
  ).split("{model}");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Let's understand your app")}</h1>
        <p className="mt-1 text-ink-2">{t("Questions adapt to your answers. We turn them into your tracking plan: events, properties, attribution and activation.")}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {SECTIONS.map((s) => {
          const qs = QUESTIONS.filter((q) => q.section === s.key && isVisible(q, answers));
          const complete = qs.length > 0 && qs.every((q) => q.key in answers);
          return (
            <Link key={s.key} href={`${base}?section=${s.key}`} className={`rounded-full border px-3 py-1 ${section?.key === s.key ? "border-ink bg-ink text-paper" : complete ? "border-accent text-accent-ink" : "border-line text-ink-3"}`}>
              {complete ? "✓ " : ""}{t(s.title)}
            </Link>
          );
        })}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-paper-2"><div className="h-full bg-accent" style={{ width: `${Math.round((p.answered / Math.max(p.total, 1)) * 100)}%` }} /></div>

      {section ? (
        <div className="card">
          <h2 className="h2">{t(section.title)}</h2>
          <p className="mb-5 text-sm text-ink-3">{t(section.intro)}</p>
          {editable ? (
            <ActionForm action={saveSectionAction.bind(null, org, app, a.id, section.key as SectionKey)} submitLabel={t("Save and continue")} className="space-y-6">
              {questions.map((q) => <QuestionField key={q.key} q={q} />)}
            </ActionForm>
          ) : (
            <p className="text-sm text-ink-3">{t("Your role can view answers but not change them.")}</p>
          )}
        </div>
      ) : (
        <div className="card space-y-4">
          <h2 className="h2">{t("All set")}</h2>
          <p className="text-ink-2">
            {readAs[0]}<strong>{t(MODEL_LABELS[c.primary])}</strong>{readAs[1]}{" "}
            {c.signals.map((x) => localizeText(x, t, lang)).join(" ")}
          </p>
          {editable && (
            <ActionForm action={generatePlanAction.bind(null, org, app, a.id)} submitLabel={versions.length ? t("Generate a new draft plan") : t("Generate my tracking plan")} pendingLabel={t("Generating…")} />
          )}
          {versions.length > 0 && <Link className="btn-secondary" href={`/o/${org}/apps/${app}/settings/dev-ops/implementation/plan`}>{t("View current plan")}</Link>}
        </div>
      )}
    </div>
  );
}
