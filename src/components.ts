// Turns Discord message components and embeds into short text.
// Input is the raw API shape (discord.js `toJSON()`), typed loosely: only the fields read here.

export interface RawComponent {
  type: number;
  content?: string;
  label?: string;
  url?: string;
  style?: number;
  placeholder?: string;
  description?: string | null;
  emoji?: { name?: string | null } | null;
  components?: RawComponent[];
  accessory?: RawComponent;
  items?: { description?: string | null }[];
}

export interface RawEmbed {
  title?: string;
  description?: string;
  fields?: { name: string; value: string }[];
  footer?: { text: string };
}

export interface EmbedField {
  name: string;
  value: string;
}

export interface EmbedView {
  title: string | null;
  description: string | null;
  fields: EmbedField[];
  footer: string | null;
}

const ACTION_ROW = 1;
const BUTTON = 2;
const SELECT_MENUS = new Set([3, 5, 6, 7, 8]);
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const MEDIA_GALLERY = 12;
const FILE = 13;
const CONTAINER = 17;
const LINK_STYLE = 5;

function buttonLabel(c: RawComponent): string {
  return c.label || c.emoji?.name || "";
}

function collect(c: RawComponent, out: string[]): void {
  if (c.type === TEXT_DISPLAY) {
    const text = c.content?.trim();
    if (text) out.push(text);
  } else if (c.type === ACTION_ROW || c.type === CONTAINER || c.type === SECTION) {
    for (const child of c.components ?? []) collect(child, out);
    if (c.accessory) collect(c.accessory, out);
  } else if (c.type === BUTTON) {
    const label = buttonLabel(c);
    if (c.style === LINK_STYLE && c.url) {
      out.push(label ? `[link: ${label} → ${c.url}]` : `[link: ${c.url}]`);
    } else {
      out.push(label ? `[button: ${label}]` : "[button]");
    }
  } else if (SELECT_MENUS.has(c.type)) {
    out.push(`[select: ${c.placeholder || "menu"}]`);
  } else if (c.type === THUMBNAIL) {
    out.push(c.description ? `[image: ${c.description}]` : "[image]");
  } else if (c.type === MEDIA_GALLERY) {
    for (const item of c.items ?? []) {
      out.push(item.description ? `[image: ${item.description}]` : "[image]");
    }
  } else if (c.type === FILE) {
    out.push("[file]");
  }
  // Separators add nothing.
}

// Flattens components in order, nested containers and sections included.
export function flattenComponents(list: readonly RawComponent[]): string[] {
  const out: string[] = [];
  for (const c of list) collect(c, out);
  return out;
}

export function mapEmbeds(list: readonly RawEmbed[]): EmbedView[] {
  return list.map((e) => ({
    title: e.title || null,
    description: e.description || null,
    fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value })),
    footer: e.footer?.text || null,
  }));
}

// Embed text: title, description, `name: value` per field, footer. Joined with " | ".
export function embedText(list: readonly EmbedView[]): string {
  return list
    .map((e) =>
      [
        e.title,
        e.description,
        ...e.fields.map((f) => `${f.name}: ${f.value}`),
        e.footer,
      ]
        .filter((part): part is string => !!part && part.length > 0)
        .join(" | "),
    )
    .filter((text) => text.length > 0)
    .join(" | ");
}
