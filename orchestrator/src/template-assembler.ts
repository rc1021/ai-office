import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { OfficeConfig, RoleTemplate } from "./types.js";
import { getProjectRootPath } from "./config-reader.js";

/**
 * Load a role template by roleId.
 */
export function loadRoleTemplate(roleId: string): RoleTemplate {
  const root = getProjectRootPath();
  const candidates = [
    path.join(root, "roles", "templates", `${roleId}.yaml`),
    path.join(root, "roles", "templates", `_${roleId}.yaml`),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return yaml.load(fs.readFileSync(p, "utf-8")) as RoleTemplate;
    }
  }

  throw new Error(`Role template not found: ${roleId}`);
}

/**
 * Assemble a Worker CLAUDE.md from the template + role YAML + office config.
 */
export function assembleWorkerClaude(
  roleId: string,
  instance: number,
  officeConfig: OfficeConfig,
  identityToken: string
): string {
  const root = getProjectRootPath();
  const templatePath = path.join(root, "agents", "worker-template", "CLAUDE.md");

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Worker template not found: ${templatePath}`);
  }

  const template = fs.readFileSync(templatePath, "utf-8");
  const role = loadRoleTemplate(roleId);
  const lang = officeConfig.office.language;

  // Resolve localized name
  const roleName = role.name[lang] || role.name["en"] || roleId;
  const agentId = `${roleId}-${instance}`;

  // Build replacement values
  const replacements: Record<string, string> = {
    "{{ROLE_NAME}}": roleName,
    "{{AGENT_ID}}": agentId,
    "{{DEPARTMENT}}": role.department,
    "{{CLEARANCE_LEVEL}}": String(role.security.clearance_level),
    "{{ROLE_PERSONA}}": role.persona.role_description.trim(),
    "{{ROLE_EXPERTISE_AREAS}}": formatList(role.persona.expertise_areas),
    "{{ROLE_PRIMARY_TASKS}}": formatList(role.capabilities.primary_tasks),
    "{{ROLE_OUTPUT_FORMATS}}": formatList(role.capabilities.output_formats),
    "{{ROLE_SCOPES}}": formatList(role.security.scopes),
    "{{ROLE_DENIED_SCOPES}}": formatList(role.security.denied_scopes),
    "{{ROLE_REQUIRES_APPROVAL}}": formatList(role.security.requires_approval),
    "{{ROLE_MAX_RISK}}": role.security.max_autonomous_risk,
  };

  // Format default_behaviors prompt rules
  let behaviorRulesText = "";
  if (role.default_behaviors?.rules) {
    const promptRules = role.default_behaviors.rules.filter(r => r.enforce === "prompt");
    if (promptRules.length > 0) {
      const lines = promptRules.map(r => {
        const override = r.overridable ? "" : " (NEVER overridable)";
        return `- **${r.id}**: ${r.description ?? r.id}${override}`;
      });
      behaviorRulesText = `### Behavior Rules (${role.default_behaviors.type} type)\n\n` +
        `These rules are part of your role identity. Follow them unless the Leader explicitly overrides (only for overridable rules).\n\n` +
        lines.join("\n");
    }
  }
  replacements["{{ROLE_BEHAVIOR_RULES}}"] = behaviorRulesText;

  // Perform substitution
  let assembled = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    assembled = assembled.replaceAll(placeholder, value);
  }

  // Compute department-based workspace paths
  const deptDir = path.join(root, ".ai-office", "departments", role.department);
  const sharedDir = path.join(root, ".ai-office", "shared");

  const workspaceSection = `
## Workspace Isolation

Your working directory: ${deptDir}
- All file operations MUST use absolute paths under this directory
- You may read: your department dir + ${sharedDir}/public/ + ${sharedDir}/inbox/${agentId}/ + ${sharedDir}/cross-dept/ (if manifest allows)
- You may write: your department dir + ${sharedDir}/inbox/ (for outbox to Leader)
- FORBIDDEN: accessing other department directories

Department paths:
- Your workspace: ${deptDir}/workspace/${agentId}/
- Department artifacts: ${deptDir}/artifacts/
- Department memory: ${deptDir}/memory/
- Your outbox: ${deptDir}/outbox/
- Your inbox: ${sharedDir}/inbox/${agentId}/
`;

  // Append office context and identity
  const officeSection = `
## Office Context

- **Office**: ${officeConfig.office.name}
- **Language**: ${officeConfig.office.language}
- **Timezone**: ${officeConfig.office.timezone}
- **Execution Mode**: ${officeConfig.execution.mode}
- **Auto-approve Risk**: ${officeConfig.execution.auto_approve_risk}

## Your Identity Token

\`\`\`
${identityToken}
\`\`\`

Include this token as \`identity_token\` in every Coordination MCP tool call for authentication.
`;

  assembled += workspaceSection;
  assembled += officeSection;

  return assembled;
}

function formatList(items?: string[]): string {
  if (!items || items.length === 0) return "(none)";
  return items.map((item) => `- ${item}`).join("\n");
}
