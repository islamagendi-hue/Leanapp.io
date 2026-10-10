/**
 * The text of run log entries (stored in English on each run, shown on flow
 * and campaign pages). Templates are registered so the pages can translate a
 * stored entry with translateMessage. Pure.
 */
import { msg } from "@/i18n/translate";
import { registerTemplates } from "./messages";

export const RUN_LOG = {
  quietHours: msg("Quiet hours ({start}–{end} {timezone}); sending at {until}"),
  frequencyCap: msg("Frequency cap: {n} messages in the last {hours} h (limit {limit})."),
  until: msg("Until {until}"),
  conditionMet: msg("Condition met"),
  conditionNotMetEnd: msg("Condition not met: run ends"),
  conditionNotMetGoto: msg("Condition not met: going to step {n}"),
  webhookDisabled: msg("Webhook is disabled"),
  webhookGone: msg("Webhook no longer exists"),
  deliveryQueued: msg("Delivery {id} queued"),
  alreadyQueued: msg("Already queued"),
  notSent: msg("Not sent: {message}"),
  queuedForApp: msg("Queued for the app (expires in {hours} h)"),
  noProfile: msg("No profile for this person"),
  exitStep: msg("Exit step"),
  sentEvent: msg("Sent {event}"),
  alreadySent: msg("Already sent"),
  converted: msg("Converted: did {event}"),
  exitEvent: msg("Exit event: did {event}"),
  noPushToken: msg("No active push token"),
  sentToDevice: msg("Sent to {sent} of {devices} device"),
  sentToDevices: msg("Sent to {sent} of {devices} devices"),
  noEmail: msg("No email user property"),
  templateDeleted: msg("The email template was deleted"),
  alreadyAttempted: msg("Already attempted"),
  sent: msg("Sent"),
  failed: msg("Failed"),
  noPhone: msg("No valid E.164 phone number in the {property} user property"),
  templateNotApproved: msg("Template {template} is {status}, not approved"),
  templateNotSynced: msg("Template {template} ({language}) is no longer synced"),
  sentTemplate: msg("Sent (template)"),
  internalGaveUp: msg("Internal error; gave up after 3 attempts."),
  internalRetry: msg("Internal error; will retry."),
  archived: msg("Automation archived"),
  deletionPending: msg("A data deletion request is pending for this person."),
  outsideWindow: msg("Outside the 24-hour window: the person hasn't messaged you in the last 24 hours, so only a template may be sent"),
  mediaUnavailable: msg("Media not attached: {message}"),
  mmsNotAllowed: msg("MMS goes only to US and Canadian numbers"),
  outcomeReached: msg("Step {step} was {outcome}"),
  outcomeWaiting: msg("Waiting for step {step} to be {outcome} (until {until})"),
  outcomeMissedEnd: msg("Step {step} wasn't {outcome} in time: run ends"),
  outcomeMissedGoto: msg("Step {step} wasn't {outcome} in time: going to step {n}"),
  outcomeNoMessage: msg("Step {step} sent nothing to wait for"),
  sentMessage: msg("Sent (message)"),
} as const;

registerTemplates(Object.values(RUN_LOG));

/** Outcomes of run log entries, as shown. */
export const OUTCOME_TEXT: Record<string, string> = {
  started: msg("started"), done: msg("done"), waiting: msg("waiting"), skipped: msg("skipped"), failed: msg("failed"), exit: msg("exit"), cancelled: msg("cancelled"),
};
