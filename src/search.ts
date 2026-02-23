/**
 * Semantic search engine for CUP accessibility trees.
 *
 * Searches the full (unpruned) tree with:
 * - Semantic role matching (natural-language role synonyms)
 * - Fuzzy name matching (token overlap, prefix matching)
 * - Relevance-ranked results (role + name + context scoring)
 *
 * Ported from python-sdk/cup/search.py
 */

import type { CupNode, SearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// All canonical CUP roles
// ---------------------------------------------------------------------------

export const ALL_ROLES: ReadonlySet<string> = new Set([
  "alert", "alertdialog", "application", "banner", "blockquote", "button",
  "caption", "cell", "checkbox", "code", "columnheader", "combobox",
  "complementary", "contentinfo", "deletion", "dialog", "document",
  "emphasis", "figure", "form", "generic", "grid", "group", "heading",
  "img", "insertion", "link", "list", "listitem", "log", "main", "marquee",
  "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio",
  "navigation", "none", "note", "option", "paragraph", "progressbar",
  "radio", "region", "row", "rowheader", "scrollbar", "search", "searchbox",
  "separator", "slider", "spinbutton", "status", "strong", "subscript",
  "superscript", "switch", "tab", "table", "tablist", "tabpanel", "text",
  "textbox", "timer", "titlebar", "toolbar", "tooltip", "tree", "treeitem",
  "window",
]);

// ---------------------------------------------------------------------------
// Semantic role synonyms
// ---------------------------------------------------------------------------

export const ROLE_SYNONYMS: Map<string, ReadonlySet<string>> = new Map([
  // text input
  ["input", new Set(["textbox", "combobox", "searchbox", "spinbutton", "slider"])],
  ["text input", new Set(["textbox", "searchbox", "combobox"])],
  ["text field", new Set(["textbox", "searchbox", "combobox"])],
  ["text box", new Set(["textbox", "searchbox"])],
  ["textarea", new Set(["textbox", "document"])],
  ["edit", new Set(["textbox", "searchbox", "combobox", "document"])],
  ["editor", new Set(["textbox", "document"])],
  // search
  ["search", new Set(["search", "searchbox", "textbox", "combobox"])],
  ["search bar", new Set(["search", "searchbox", "textbox", "combobox"])],
  ["search box", new Set(["search", "searchbox", "textbox", "combobox"])],
  ["search field", new Set(["search", "searchbox", "textbox", "combobox"])],
  ["search input", new Set(["search", "searchbox", "textbox", "combobox"])],
  // buttons
  ["btn", new Set(["button"])],
  ["clickable", new Set(["button", "link", "menuitem", "tab", "treeitem", "listitem"])],
  // links
  ["hyperlink", new Set(["link"])],
  ["anchor", new Set(["link"])],
  // dropdowns / selects
  ["dropdown", new Set(["combobox", "menu", "list"])],
  ["select", new Set(["combobox", "list", "listitem"])],
  ["combo", new Set(["combobox"])],
  ["combo box", new Set(["combobox"])],
  // toggles
  ["check", new Set(["checkbox", "switch", "menuitemcheckbox"])],
  ["toggle", new Set(["switch", "checkbox"])],
  ["radio button", new Set(["radio", "menuitemradio"])],
  ["option", new Set(["option", "radio", "listitem", "menuitemradio"])],
  // sliders / ranges
  ["range", new Set(["slider", "progressbar", "spinbutton"])],
  ["progress", new Set(["progressbar"])],
  ["progress bar", new Set(["progressbar"])],
  ["spinner", new Set(["spinbutton"])],
  // tabs
  ["tab bar", new Set(["tablist"])],
  ["tab list", new Set(["tablist"])],
  ["tabs", new Set(["tablist", "tab"])],
  ["tab panel", new Set(["tabpanel"])],
  // menus
  ["menu bar", new Set(["menubar"])],
  ["menu item", new Set(["menuitem", "menuitemcheckbox", "menuitemradio"])],
  // dialogs
  ["modal", new Set(["dialog", "alertdialog"])],
  ["popup", new Set(["dialog", "alertdialog", "tooltip", "menu"])],
  ["notification", new Set(["alert", "status", "log"])],
  ["message", new Set(["alert", "status", "log"])],
  // headings / titles
  ["title", new Set(["heading", "titlebar"])],
  ["header", new Set(["heading", "banner", "columnheader", "rowheader"])],
  // images
  ["image", new Set(["img"])],
  ["picture", new Set(["img"])],
  ["icon", new Set(["img", "button"])],
  // trees / lists
  ["tree item", new Set(["treeitem"])],
  ["list item", new Set(["listitem"])],
  // tables / grids
  ["table", new Set(["table", "grid"])],
  // navigation
  ["nav", new Set(["navigation"])],
  ["sidebar", new Set(["complementary", "navigation"])],
  // containers
  ["panel", new Set(["region", "group", "tabpanel"])],
  ["section", new Set(["region", "group", "main"])],
  ["container", new Set(["region", "group", "generic"])],
  // misc
  ["divider", new Set(["separator"])],
  ["scroll", new Set(["scrollbar"])],
  ["status bar", new Set(["status"])],
  ["tool bar", new Set(["toolbar"])],
]);

// Identity mappings: every CUP role maps to itself
for (const role of ALL_ROLES) {
  if (!ROLE_SYNONYMS.has(role)) {
    ROLE_SYNONYMS.set(role, new Set([role]));
  }
}

// ---------------------------------------------------------------------------
// Noise words
// ---------------------------------------------------------------------------

const NOISE_WORDS = new Set([
  "the", "a", "an", "this", "that", "for", "in", "on", "of",
  "with", "to", "and", "or", "is", "it", "its", "my", "your",
]);

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

const SPLIT_RE = /[^a-z0-9]+/;

export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return normalized.split(SPLIT_RE).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

export function resolveRoles(roleQuery: string): ReadonlySet<string> | null {
  const q = roleQuery.trim().toLowerCase();

  // Direct synonym lookup
  const direct = ROLE_SYNONYMS.get(q);
  if (direct) return direct;

  // Token-based fallback
  for (const token of tokenize(q)) {
    const match = ROLE_SYNONYMS.get(token);
    if (match) return match;
  }

  // Substring check (if query >= 3 chars)
  if (q.length >= 3) {
    const matches = new Set<string>();
    for (const r of ALL_ROLES) {
      if (r.includes(q)) matches.add(r);
    }
    if (matches.size > 0) return matches;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

function parseQuery(query: string): [string | null, string[]] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [null, []];

  let bestRole: string | null = null;
  let bestSpan: [number, number] = [0, 0];

  // Longest-first subsequences (max 3 words)
  for (let length = Math.min(tokens.length, 3); length > 0; length--) {
    for (let start = 0; start <= tokens.length - length; start++) {
      const candidate = tokens.slice(start, start + length).join(" ");
      if (ROLE_SYNONYMS.has(candidate)) {
        bestRole = candidate;
        bestSpan = [start, start + length];
        break;
      }
    }
    if (bestRole) break;
  }

  // Remaining tokens = name query (filter noise)
  const nameTokens = [
    ...tokens.slice(0, bestSpan[0]),
    ...tokens.slice(bestSpan[1]),
  ].filter((t) => !NOISE_WORDS.has(t));

  return [bestRole, nameTokens];
}

// ---------------------------------------------------------------------------
// Name scoring
// ---------------------------------------------------------------------------

function scoreSecondary(
  queryTokens: string[],
  description: string,
  value: string,
  placeholder: string,
): number {
  let best = 0.0;
  for (const field of [description, value, placeholder]) {
    if (!field) continue;
    const fieldTokens = new Set(tokenize(field));
    if (fieldTokens.size === 0) continue;
    const matched = queryTokens.filter((qt) => fieldTokens.has(qt)).length;
    best = Math.max(best, matched / queryTokens.length);
  }
  return best;
}

function scoreName(
  queryTokens: string[],
  nodeName: string,
  nodeDescription: string = "",
  nodeValue: string = "",
  placeholder: string = "",
): number {
  if (queryTokens.length === 0) return 1.0;

  const queryJoined = queryTokens.join(" ");
  const nameLower = nodeName.toLowerCase();

  // Signal 1: full substring match
  let fullSubstr = 0.0;
  if (nameLower.includes(queryJoined)) {
    fullSubstr = queryJoined === nameLower ? 1.0 : 0.85;
  }

  // Signal 2: token-level matching
  const nameTokens = new Set(tokenize(nodeName));
  let tokenScore = 0.0;

  if (nameTokens.size > 0) {
    let matched = 0.0;
    for (const qt of queryTokens) {
      if (nameTokens.has(qt)) {
        matched += 1.0;
      } else if ([...nameTokens].some((nt) => nt.startsWith(qt))) {
        matched += 0.7;
      } else if ([...nameTokens].some((nt) => qt.startsWith(nt))) {
        matched += 0.5;
      } else if ([...nameTokens].some((nt) => nt.includes(qt))) {
        matched += 0.6;
      }
    }
    tokenScore = matched / queryTokens.length;
  }

  let nameScore = Math.max(fullSubstr, tokenScore);

  // Exactness bonus
  if (nameTokens.size > 0 && nameScore > 0) {
    const overlap =
      queryTokens.filter((qt) => nameTokens.has(qt)).length / Math.max(nameTokens.size, 1);
    nameScore = nameScore * (0.85 + 0.15 * overlap);
  }

  // Secondary field boost
  const secondary = scoreSecondary(queryTokens, nodeDescription, nodeValue, placeholder);

  return Math.min(1.0, nameScore + secondary * 0.15);
}

// ---------------------------------------------------------------------------
// Context scoring
// ---------------------------------------------------------------------------

function scoreContext(
  node: CupNode,
  parentChain: CupNode[],
  queryTokens: string[],
  targetRoles: ReadonlySet<string> | null,
): number {
  let score = 0.0;

  // Ancestor name matches query tokens
  if (queryTokens.length > 0) {
    const qtSet = new Set(queryTokens);
    for (const ancestor of parentChain) {
      if (tokenize(ancestor.name || "").some((t) => qtSet.has(t))) {
        score += 0.1;
        break;
      }
    }
  }

  // Ancestor role matches target roles
  if (targetRoles) {
    for (const ancestor of parentChain) {
      if (targetRoles.has(ancestor.role)) {
        score += 0.1;
        break;
      }
    }
  }

  // Interactive bonus
  const actions = node.actions ?? [];
  if (actions.some((a) => a !== "focus")) score += 0.05;

  // Visibility bonus
  const states = node.states ?? [];
  if (!states.includes("offscreen")) score += 0.05;

  // Focused bonus
  if (states.includes("focused")) score += 0.02;

  return score;
}

// ---------------------------------------------------------------------------
// Per-node scoring
// ---------------------------------------------------------------------------

function scoreNode(
  node: CupNode,
  parentChain: CupNode[],
  targetRoles: ReadonlySet<string> | null,
  nameTokens: string[],
  state: string | null,
): number {
  // State: hard filter
  if (state != null && !(node.states ?? []).includes(state)) return 0.0;

  // Role: hard filter when specified
  const nodeRole = node.role;
  let roleScore = 0.0;
  if (targetRoles != null) {
    if (targetRoles.has(nodeRole)) {
      roleScore = 0.35;
    } else {
      return 0.0;
    }
  }

  // Name scoring
  let nameScore: number;
  if (nameTokens.length > 0) {
    const raw = scoreName(
      nameTokens,
      node.name || "",
      node.description || "",
      node.value || "",
      node.attributes?.placeholder || "",
    );
    if (raw === 0.0) return 0.0;
    nameScore = raw * 0.5;
  } else {
    nameScore = targetRoles ? 0.15 : 0.0;
  }

  // State bonus
  const stateScore = state != null ? 0.1 : 0.0;

  // Context
  const contextScore = scoreContext(node, parentChain, nameTokens, targetRoles);

  return roleScore + nameScore + stateScore + contextScore;
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

function walkAndScore(
  nodes: CupNode[],
  parentChain: CupNode[],
  targetRoles: ReadonlySet<string> | null,
  nameTokens: string[],
  state: string | null,
  results: SearchResult[],
  threshold: number,
): void {
  for (const node of nodes) {
    const score = scoreNode(node, parentChain, targetRoles, nameTokens, state);

    if (score >= threshold) {
      const resultNode: CupNode = { ...node };
      delete resultNode.children;
      results.push({ node: resultNode, score });
    }

    const children = node.children ?? [];
    if (children.length > 0) {
      walkAndScore(
        children,
        [...parentChain, node],
        targetRoles,
        nameTokens,
        state,
        results,
        threshold,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function searchTree(
  tree: CupNode[],
  options?: {
    query?: string | null;
    role?: string | null;
    name?: string | null;
    state?: string | null;
    limit?: number;
    threshold?: number;
  },
): SearchResult[] {
  const query = options?.query ?? null;
  const role = options?.role ?? null;
  const name = options?.name ?? null;
  const state = options?.state ?? null;
  const limit = options?.limit ?? 5;
  const threshold = options?.threshold ?? 0.15;

  // Parse inputs
  let effectiveRole = role;
  let effectiveNameTokens: string[] = [];

  if (query) {
    const [parsedRole, parsedName] = parseQuery(query);
    effectiveRole = role || parsedRole;
    effectiveNameTokens = name ? tokenize(name) : parsedName;
  } else if (name) {
    effectiveNameTokens = tokenize(name);
  }

  // Resolve roles
  let targetRoles: ReadonlySet<string> | null = null;
  if (effectiveRole) {
    targetRoles = resolveRoles(effectiveRole);
  }

  // Walk and score
  const results: SearchResult[] = [];
  walkAndScore(tree, [], targetRoles, effectiveNameTokens, state, results, threshold);

  // Sort by score descending (stable)
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}
