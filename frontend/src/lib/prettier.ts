/** Formats HTML, CSS, JavaScript and Markdown with Prettier (loaded on first use). */
export async function formatWith(language: "html" | "css" | "javascript" | "markdown", code: string): Promise<string> {
  const [{ format }, html, postcss, babel, estree, markdown] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/html"),
    import("prettier/plugins/postcss"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
    import("prettier/plugins/markdown"),
  ])
  const parser = { html: "html", css: "css", javascript: "babel", markdown: "markdown" }[language]
  return format(code, { parser, plugins: [html, postcss, babel, estree, markdown] })
}
