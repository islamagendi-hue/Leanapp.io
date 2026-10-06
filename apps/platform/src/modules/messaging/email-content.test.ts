import { describe, expect, it } from "vitest";
import { buildEmail, DOMAIN, senderDomain, textToHtml } from "./email-content";

describe("email content", () => {
  it("escapes HTML and links https URLs", () => {
    expect(textToHtml('Hi <b>"you"</b>\nline 2\n\nSee https://shop.example/cart?a=1&b=2')).toBe(
      '<p>Hi &lt;b&gt;&quot;you&quot;&lt;/b&gt;<br>line 2</p>\n<p>See <a href="https://shop.example/cart?a=1&amp;b=2">https://shop.example/cart?a=1&amp;b=2</a></p>',
    );
    expect(textToHtml("javascript:alert(1) <script>")).not.toContain("<script>");
  });

  it("adds an unsubscribe link and RFC 8058 one-click headers", () => {
    const e = buildEmail("Come back!", "https://api.leanapp.io/unsubscribe/tok");
    expect(e.text).toBe("Come back!\n\n—\nUnsubscribe: https://api.leanapp.io/unsubscribe/tok");
    expect(e.html).toContain('<a href="https://api.leanapp.io/unsubscribe/tok">Unsubscribe</a>');
    expect(e.html).toContain('dir="ltr"');
    expect(e.headers).toEqual({ "List-Unsubscribe": "<https://api.leanapp.io/unsubscribe/tok>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(buildEmail("مرحبا", "https://x.test/u").html).toContain('dir="rtl"');
  });

  it("checks domains and sender addresses", () => {
    expect(DOMAIN.test("mail.shop.example")).toBe(true);
    for (const bad of ["https://shop.com", "shop", "shop.com/path", "-bad.com", "a..b.com"]) expect(DOMAIN.test(bad)).toBe(false);
    expect(senderDomain("Shop <Hi@Mail.Shop.com>")).toBe("mail.shop.com");
    expect(senderDomain("hi@shop.com")).toBe("shop.com");
  });
});
