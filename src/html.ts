// A template tag that escapes every interpolated value unless it is already
// Html. Arrays are joined, null, undefined and false render as nothing.
export class Html {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

type Part = Html | string | number | null | undefined | false | Part[];

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new Html(out);
}

function render(value: Part): string {
  if (value === null || value === undefined || value === false) return "";
  if (Array.isArray(value)) return value.map(render).join("");
  if (value instanceof Html) return value.value;
  return escape(String(value));
}

export function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
