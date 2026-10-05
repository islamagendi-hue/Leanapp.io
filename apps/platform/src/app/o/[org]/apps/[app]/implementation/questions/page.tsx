import Link from "next/link";
import { generatePlanAction, saveSectionAction } from "@/app/actions/implementation";
import { ActionForm } from "@/components/ActionForm";
import { QuestionField, type SerializedQuestion } from "@/components/QuestionField";
import { classifyBusiness } from "@/modules/implementation/classifier";
import { MODEL_LABELS } from "@/modules/implementation/catalog/models";
import { isVisible, nextQuestions, optionsFor, progress, QUESTIONS, SECTIONS, type SectionKey } from "@/modules/implementation/questions";
import { getProject, listVersions } from "@/modules/implementation/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp } from "@/server/session";

export const metadata = { title: "Implementation questions" };

export default async function QuestionsPage(props: PageProps<"/o/[org]/apps/[app]/implementation/questions">) {
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
  const base = `/o/${org}/apps/${app}/implementation/questions`;

  const questions: SerializedQuestion[] = section
    ? QUESTIONS.filter((q) => q.section === section.key && isVisible(q, answers)).map((q) => ({
        key: q.key,
        type: q.type,
        prompt: q.prompt,
        help: q.help,
        required: q.required,
        options: optionsFor(q, answers),
        allowOther: !!q.allowOther,
        placeholder: q.placeholder,
        value: q.key in answers ? answers[q.key] : (q.suggest?.(answers) ?? undefined),
      }))
    : [];
  const c = classifyBusiness(answers);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Let&apos;s understand your app</h1>
        <p className="mt-1 text-ink-2">Questions adapt to your answers. We turn them into your tracking plan: events, properties, attribution and activation.</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {SECTIONS.map((s) => {
          const qs = QUESTIONS.filter((q) => q.section === s.key && isVisible(q, answers));
          const complete = qs.length > 0 && qs.every((q) => q.key in answers);
          return (
            <Link key={s.key} href={`${base}?section=${s.key}`} className={`rounded-full border px-3 py-1 ${section?.key === s.key ? "border-ink bg-ink text-paper" : complete ? "border-accent text-accent-ink" : "border-line text-ink-3"}`}>
              {complete ? "✓ " : ""}{s.title}
            </Link>
          );
        })}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-paper-2"><div className="h-full bg-accent" style={{ width: `${Math.round((p.answered / Math.max(p.total, 1)) * 100)}%` }} /></div>

      {section ? (
        <div className="card">
          <h2 className="h2">{section.title}</h2>
          <p className="mb-5 text-sm text-ink-3">{section.intro}</p>
          {editable ? (
            <ActionForm action={saveSectionAction.bind(null, org, app, a.id, section.key as SectionKey)} submitLabel="Save and continue" className="space-y-6">
              {questions.map((q) => <QuestionField key={q.key} q={q} />)}
            </ActionForm>
          ) : (
            <p className="text-sm text-ink-3">Your role can view answers but not change them.</p>
          )}
        </div>
      ) : (
        <div className="card space-y-4">
          <h2 className="h2">All set</h2>
          <p className="text-ink-2">
            We read your business as <strong>{MODEL_LABELS[c.primary]}</strong>
            {c.secondary.length ? <> with {c.secondary.map((m) => MODEL_LABELS[m]).join(", ")} behaviour</> : null}. {c.signals.join(" ")}
          </p>
          {editable && (
            <ActionForm action={generatePlanAction.bind(null, org, app, a.id)} submitLabel={versions.length ? "Generate a new draft plan" : "Generate my tracking plan"} pendingLabel="Generating…" />
          )}
          {versions.length > 0 && <Link className="btn-secondary" href={`/o/${org}/apps/${app}/implementation/plan`}>View current plan</Link>}
        </div>
      )}
    </div>
  );
}
