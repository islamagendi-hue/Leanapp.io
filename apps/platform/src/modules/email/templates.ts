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
