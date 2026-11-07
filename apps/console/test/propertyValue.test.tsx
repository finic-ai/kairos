import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PropertyValue } from "../src/components/entities/PropertyValue";

const render = (value: unknown) =>
  renderToStaticMarkup(<PropertyValue entity={{ type: "user", id: "u1" }} name="site" value={value} format="link" />);

describe("a link property", () => {
  it("links to a URL, by its host", () => {
    expect(render("https://example.com/a")).toContain('href="https://example.com/a"');
    expect(render("https://example.com/a")).toContain(">example.com<");
  });

  it("shows a value that is not a URL as text, and does not throw", () => {
    for (const value of ["http://", "https://a b"]) {
      const html = render(value);
      expect(html, value).not.toContain("href");
      expect(html, value).toContain(value);
    }
  });
});
