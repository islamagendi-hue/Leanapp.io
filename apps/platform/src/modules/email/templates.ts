import "server-only";
import type { EmailMessage } from "./service";

export function verifyEmailMessage(to: string, name: string, link: string): EmailMessage {
  return {
    kind: "verify_email",
    to,
    subject: "Confirm your email for LeanApp",
    text: `Hi ${name},\n\nConfirm your email address to finish setting up your LeanApp account:\n\n${link}\n\nThe link expires in 24 hours. If you didn't create an account, you can ignore this email.`,
  };
}

export function passwordResetMessage(to: string, name: string, link: string): EmailMessage {
  return {
    kind: "password_reset",
    to,
    subject: "Reset your LeanApp password",
    text: `Hi ${name},\n\nSomeone asked to reset the password for your LeanApp account. If it was you, choose a new password here:\n\n${link}\n\nThe link expires in 1 hour and works once. If you didn't ask for this, ignore this email: your password stays the same.`,
  };
}

export function passwordChangedMessage(to: string, name: string): EmailMessage {
  return {
    kind: "password_changed",
    to,
    subject: "Your LeanApp password was changed",
    text: `Hi ${name},\n\nThe password for your LeanApp account was just changed and all other sessions were signed out.\n\nIf this wasn't you, reset your password immediately and contact security@leanapp.io.`,
  };
}

export function invitationMessage(to: string, inviter: string, organization: string, role: string, link: string): EmailMessage {
  return {
    kind: "invitation",
    to,
    subject: `${inviter} invited you to ${organization} on LeanApp`,
    text: `${inviter} invited you to join ${organization} on LeanApp as ${role}.\n\nAccept the invitation:\n\n${link}\n\nThe invitation expires in 7 days.`,
  };
}

export function usageNoticeMessage(
  to: string,
  organization: string,
  threshold: 80 | 100 | 110,
  used: number,
  limit: number,
  resetsOn: string,
  link: string,
): EmailMessage {
  const n = (x: number) => x.toLocaleString("en-US");
  const hardCap = Math.floor(limit * 1.1);
  const subject =
    threshold === 80 ? `${organization} has used 80% of its monthly events on LeanApp`
    : threshold === 100 ? `${organization} has reached its monthly event allowance on LeanApp`
    : `LeanApp is refusing new events for ${organization}`;
  const body =
    threshold === 80
      ? `${organization} has sent ${n(used)} of the ${n(limit)} events its plan includes this month.`
      : threshold === 100
        ? `${organization} has sent ${n(used)} events this month, which is its plan's allowance of ${n(limit)}. Events are still accepted for a 10% grace, up to ${n(hardCap)}. After that LeanApp refuses new events (error plan_limit_exceeded) until the allowance resets.`
        : `${organization} has sent ${n(used)} events this month, past its allowance of ${n(limit)} plus the 10% grace. LeanApp now refuses new events with the error plan_limit_exceeded. The LeanApp SDKs keep unsent events on the device (up to their queue size) and retry later; server-side senders get the same error and should retry too.`;
  return {
    kind: `usage_notice_${threshold}`,
    to,
    subject,
    text: `${body}\n\nThe allowance resets on ${resetsOn} (UTC). To raise it, upgrade the plan:\n\n${link}\n\nYou're getting this because you're an owner of ${organization}. We send this notice once per month.`,
  };
}
