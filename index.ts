/**
 * Friday Constraints Plugin
 *
 * Intercepts `before_tool_call` events and enforces Friday's behavioral rules.
 * When Friday attempts to write code, edit source files, or run dev commands,
 * an approval dialog appears with a reminder to delegate to Jarvis.
 *
 * Rules are defined in the adjacent rules.yaml file.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";

// ── Types ─────────────────────────────────────────────────

interface RuleTrigger {
  tools?: string[];
  patterns?: string[];
  command_patterns?: string[];
}

interface RuleAction {
  type: "require_approval" | "reminder" | "block";
  title?: string;
  message: string;
  severity?: "warning" | "info" | "critical";
  timeout_ms?: number;
  timeout_behavior?: "allow" | "deny";
}

interface Rule {
  name: string;
  description?: string;
  trigger: RuleTrigger;
  action: RuleAction;
}

interface RulesFile {
  rules: Rule[];
}

// ── Load rules ───────────────────────────────────────────

function loadRules(): Rule[] {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const yamlPath = resolve(__dirname, "rules.yaml");
    const raw = readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw) as RulesFile;
    return parsed?.rules ?? [];
  } catch (e) {
    console.error("[friday-constraints] Failed to load rules:", e);
    return [];
  }
}

// ── Matchers ──────────────────────────────────────────────

function matchesTool(ruleTools: string[] | undefined, toolName: string): boolean {
  return !ruleTools || ruleTools.includes(toolName);
}

function matchesPath(patterns: string[] | undefined, filePath: string): boolean {
  if (!patterns?.length) return false;
  return patterns.some((p) =>
    minimatch(filePath, p, { matchBase: !p.includes("/") }),
  );
}

function matchesCommand(patterns: string[] | undefined, command: string): boolean {
  if (!patterns?.length) return false;
  const cmd = (command ?? "").toLowerCase().replace(/^["']|["']$/g, "");
  return patterns.some((prefix) => cmd.includes(prefix.toLowerCase()));
}

function isFriday(agentId: string | undefined): boolean {
  const id = (agentId ?? "").toLowerCase();
  return id === "friday" || id === "main" || id.includes("friday");
}

// ── Plugin Entry ──────────────────────────────────────────

export default definePluginEntry({
  id: "friday-constraints",
  name: "Friday Constraints",
  description:
    "Enforce Friday's behavioral constraints — delegate code tasks to Jarvis",

  register(api) {
    const rules = loadRules();
    if (rules.length === 0) {
      console.warn("[friday-constraints] No rules loaded — plugin inactive");
      return;
    }

    let blockedCount = 0;

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        // Only enforce on Friday
        if (!isFriday(ctx?.agentId)) return;

        const toolName = event.toolName ?? "";
        const filePath: string = String(event.params?.file_path ?? event.params?.path ?? "");
        const command = String(event.params?.command ?? event.params?.cmd ?? "");

        for (const rule of rules) {
          const toolMatch = matchesTool(rule.trigger.tools, toolName);
          if (!toolMatch) continue;

          const patternMatch = matchesPath(rule.trigger.patterns, filePath);
          const cmdMatch = matchesCommand(rule.trigger.command_patterns, command);

          if (!patternMatch && !cmdMatch) continue;

          blockedCount++;
          const action = rule.action;

          if (action.type === "require_approval") {
            return {
              requireApproval: {
                title: action.title ?? "Friday Constraint",
                description: action.message,
                severity: action.severity ?? "warning",
                timeoutMs: action.timeout_ms ?? 30_000,
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

    console.log(
      `[friday-constraints] Active with ${rules.length} rule(s) for Friday`,
    );

    // Periodic stats
    setInterval(() => {
      if (blockedCount > 0) {
        console.log(
          `[friday-constraints] ${blockedCount} tool call(s) intercepted`,
        );
      }
    }, 3600_000); // hourly
  },
});
