/** Counter name rendering from templates like Subs: [subs]. */

const PLACEHOLDER = /\[([a-z]+)\]/g;

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (match, key: string) => values[key] ?? match);
}
