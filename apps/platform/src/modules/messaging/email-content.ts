/**
 * Email content for automation messages: plain text plus a minimal HTML
 * version, an unsubscribe footer, and RFC 8058 one-click unsubscribe headers.
 * Pure; see docs/messaging.md.
 */

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Plain text → HTML paragraphs; bare https links become anchors. Everything else is escaped. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => {
      const escaped = escapeHtml(p).replace(/\n/g, "<br>");
      return `<p>${escaped.replace(/https:\/\/[^\s<>"']+/g, (u) => `<a href="${u}">${u}</a>`)}</p>`;
    })
    .join("\n");
}

export interface BuiltEmail {
  text: string;
  html: string;
  headers: Record<string, string>;
}

/**
 * Adds the unsubscribe link to both bodies and the List-Unsubscribe headers
 * (RFC 2369 + RFC 8058 one-click: mail providers POST
 * "List-Unsubscribe=One-Click" to the URL).
 */
export function buildEmail(body: string, unsubscribeUrl: string, opts: { dir?: "ltr" | "rtl" } = {}): BuiltEmail {
  const footerText = `\n\n—\nUnsubscribe: ${unsubscribeUrl}`;
  const dir = opts.dir ?? (/[؀-ۿ]/.test(body) ? "rtl" : "ltr");
  const html = `<!doctype html><html dir="${dir}"><body style="font-family:system-ui,sans-serif;line-height:1.5">
${textToHtml(body)}
<hr style="border:none;border-top:1px solid #ddd;margin-block:24px 12px">
<p style="font-size:12px;color:#666"><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a> from these emails.</p>
</body></html>`;
  return {
    text: `${body}${footerText}`,
    html,
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

/** Domain name check for sending domains (no scheme, no path, at least one dot). */
export const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** The domain part of a From value like "Shop <hi@mail.shop.com>". */
export function senderDomain(from: string): string | null {
  const m = from.match(/@([^\s<>@]+?)>?\s*$/);
  return m ? m[1].toLowerCase() : null;
}
