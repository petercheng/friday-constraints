/**
 * Friday Constraints Plugin
 *
 * Intercepts tool calls that violate Friday's behavioral rules:
 *  - No writing implementation code (*.py, *.ts, *.js, etc.)
 *  - No writing test files
 *  - No modifying source directories
 *  - No running dev commands (pytest, npm test, pip install)
 *
 * Triggers an approval request with a reminder to delegate to Jarvis.
 * Rules are defined in rules.yaml alongside this file.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { minimatch } from "minimatch";

// ── Types ─────────────────────────────────────────────────

interface Rule {
  name: string;
  description?: string;
  trigger: {
    tools?: string[];
    patterns?: string[];
    command_patterns?: string[];
  };
  action: {
    type: "require_approval" | "reminder" | "block";
    title?: string;
    message: string;
    severity?: string;
    timeout_ms?: number;
    timeout_behavior?: string;
  };
}

// ── Load rules from YAML ─────────────────────────────────

let _rules: Rule[] | null = null;

function loadRules(): Rule[] {
  if (_rules) return _rules;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const yamlPath = join(__dirname, "rules.yaml");
    const raw = readFileSync(yamlPath, "utf-8");
    // Simple YAML inline parser — avoids adding a dependency.
    // For production, replace with `yaml` package parse.
    _rules = parseSimpleYaml(raw);
    return _rules;
  } catch (e) {
    console.error("[friday-constraints] Failed to load rules:", e);
    return [];
  }
}

/** Minimal YAML rule parser. Handles the exact rules.yaml format above. */
function parseSimpleYaml(raw: string): Rule[] {
  const rules: Rule[] = [];
  const lines = raw.split("\n");
  let current: Partial<Rule> | null = null;
  let section: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // New rule
    if (trimmed === "- name:" || trimmed.startsWith("- name:")) {
      if (current) rules.push(current as Rule);
      current = { trigger: {}, action: {} as Rule["action"] } as Partial<Rule>;
      current.name = trimmed.split(":")[1]?.trim().replace(/"/g, "") ?? "";
      section = "root";
      continue;
    }

    if (current === null) continue;

    if (trimmed === "description:" || trimmed.startsWith("description:")) {
      const v = trimmed.split("description:")[1]?.trim().replace(/"/g, "") ?? "";
      if (v) current.description = v;
      continue;
    }

    if (trimmed === "trigger:") { section = "trigger"; continue; }
    if (trimmed === "action:") { section = "action"; continue; }

    if (section === "trigger") {
      if (trimmed.startsWith("tools:")) {
        current.trigger!.tools = extractArray(trimmed);
      } else if (trimmed.startsWith("patterns:")) {
        current.trigger!.patterns ??= [];
        current.trigger!.patterns.push(trimmed.split(":")[1]?.trim().replace(/[\\-\\"]/g, "") ?? "");
      } else if (trimmed.startsWith("command_patterns:")) {
        current.trigger!.command_patterns ??= [];
        current.trigger!.command_patterns.push(trimmed.split(":")[1]?.trim().replace(/[\\-\\"]/g, "") ?? "");
      } else if (trimmed.startsWith("- ")) {
        if (section === "trigger") {
          const val = trimmed.replace("- ", "").trim().replace(/"/g, "");
          if (current.trigger!.patterns?.length &&
              !current.trigger!.command_patterns?.length) {
            current.trigger!.patterns.push(val);
          }
        }
      }
    }

    if (section === "action") {
      if (trimmed.startsWith("type:")) {
        current.action = { ...current.action, type: trimmed.split(":")[1]?.trim() as Rule["action"]["type"] };
      } else if (trimmed.startsWith("title:")) {
        current.action = { ...current.action, title: trimmed.split(":")[1]?.trim().replace(/"/g, "") };
      } else if (trimmed.startsWith("message:")) {
        current.action = { ...current.action, message: trimmed.split("message:")[1]?.trim().replace(/"/g, "") ?? "" };
      } else if (trimmed.startsWith("severity:")) {
        current.action = { ...current.action, severity: trimmed.split(":")[1]?.trim() };
      } else if (trimmed.startsWith("timeout_ms:")) {
        current.action = { ...current.action, timeout_ms: parseInt(trimmed.split(":")[1]?.trim() ?? "30000") };
      } else if (trimmed.startsWith("timeout_behavior:")) {
        current.action = { ...current.action, timeout_behavior: trimmed.split(":")[1]?.trim() };
      }
    }
  }

  if (current) rules.push(current as Rule);
  return rules;
}

function extractArray(line: string): string[] {
  const bracket = line.indexOf("[");
  if (bracket === -1) return [];
  const inner = line.slice(bracket + 1, line.indexOf("]"));
  return inner.split(",").map(s => s.trim().replace(/"/g, ""));
}

/** Check if a rule's patterns match the given file path. */
function matchesPath(patterns: string[], filePath: string): boolean {
  if (!patterns.length) return true;
  return patterns.some(p => minimatch(filePath, p, { matchBase: patterns.every(x => !x.includes("/")) }));
}

/** Check if a rule's command_patterns match the given command string. */
function matchesCommand(patterns: string[], command: string): boolean {
  if (!patterns?.length) return true;
  const cmd = (command ?? "").toLowerCase();
  return patterns.some(p => cmd.includes(p.toLowerCase()));
}

/** Check if the agent ID is Friday (case-insensitive). */
function isFriday(agentId: string | undefined): boolean {
  const id = (agentId ?? "").toLowerCase();
  return id === "friday" || id === "main" || id.includes("friday");
}

// ── Plugin Entry ──────────────────────────────────────────

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "friday-constraints",
  name: "Friday Constraints",
  description: "Enforce Friday's behavioral constraints — delegate code tasks to Jarvis",

  register(api) {
    const rules = loadRules();
    if (rules.length === 0) {
      console.warn("[friday-constraints] No rules loaded — plugin inactive");
      return;
    }

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        // Only enforce on Friday
        if (!isFriday(ctx?.agentId)) return;

        for (const rule of rules) {
          const toolMatch =
            !rule.trigger.tools || rule.trigger.tools.includes(event.toolName);

          const filePath = event.params?.file_path ?? event.params?.path ?? "";
          const patternMatch =
            !rule.trigger.patterns || matchesPath(rule.trigger.patterns, filePath);

          const command = event.params?.command ?? event.params?.cmd ?? "";
          const cmdMatch =
            !rule.trigger.command_patterns ||
            matchesCommand(rule.trigger.command_patterns, command);

          if (!toolMatch || (!patternMatch && !cmdMatch && !rule.trigger.command_patterns && !rule.trigger.patterns)) {
            continue;
          }

          // Check if any trigger condition actually matched
          const hasTrigger = (rule.trigger.patterns?.length && patternMatch) ||
            (rule.trigger.command_patterns?.length && cmdMatch) ||
            (!rule.trigger.patterns?.length && !rule.trigger.command_patterns?.length);

          if (!hasTrigger) continue;

          const action = rule.action;

          if (action.type === "require_approval") {
            return {
              requireApproval: {
                title: action.title ?? "Constraint Check",
                description: action.message,
                severity: action.severity ?? "warning",
                timeoutMs: action.timeout_ms ?? 30000,
                timeoutBehavior: action.timeout_behavior ?? "allow",
              },
            };
          }

          if (action.type === "block") {
            return { block: true, reason: action.message };
          }
        }
      },
      { priority: 100 },
    );

    console.log(`[friday-constraints] Active with ${rules.length} rule(s)`);
  },
});
