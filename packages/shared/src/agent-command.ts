export const AGENT_TYPES = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"copilot",
	"cursor-agent",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_LABELS: Record<AgentType, string> = {
	claude: "Claude",
	codex: "Codex",
	gemini: "Gemini",
	opencode: "OpenCode",
	copilot: "Copilot",
	"cursor-agent": "Cursor Agent",
};

export const AGENT_PRESET_COMMANDS: Record<AgentType, string[]> = {
	claude: ["claude --dangerously-skip-permissions"],
	codex: [
		'codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true',
	],
	gemini: ["gemini --yolo"],
	opencode: ["opencode"],
	copilot: ["copilot --allow-all"],
	"cursor-agent": ["cursor-agent"],
};

export const AGENT_PRESET_DESCRIPTIONS: Record<AgentType, string> = {
	claude: "Danger mode: All permissions auto-approved",
	codex: "Danger mode: All permissions auto-approved",
	gemini: "Danger mode: All permissions auto-approved",
	opencode: "OpenCode: Open-source AI coding agent",
	copilot: "Danger mode: All permissions auto-approved",
	"cursor-agent": "Cursor AI agent for terminal-based coding assistance",
};

export interface TaskInput {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	priority: string;
	statusName: string | null;
	labels: string[] | null;
}

export function buildAgentTaskPrompt(task: TaskInput): string {
	const metadata = [
		`Priority: ${task.priority}`,
		task.statusName && `Status: ${task.statusName}`,
		task.labels?.length && `Labels: ${task.labels.join(", ")}`,
	]
		.filter(Boolean)
		.join("\n");

	return `You are working on task "${task.title}" (${task.slug}).

${metadata}

## Task Description

${task.description || "No description provided."}

## Instructions

You are running fully autonomously. Do not ask questions or wait for user feedback — make all decisions independently based on the codebase and task description.

1. Explore the codebase to understand the relevant code and architecture
2. Run \`/plan-ceo-review\` to validate you're building the right thing from a user-value perspective
3. Run \`/plan-eng-review\` to lock in architecture, data flow, edge cases, and tests
4. Implement the plan
5. Run \`/review\` to find bugs that pass CI but could blow up in production
6. Verify your changes work correctly (run relevant tests, typecheck, lint)
7. Run \`/qa\` to systematically test affected pages and flows
8. Run \`/ship\` to sync main, run tests, resolve reviews, push, and open a PR
9. When done, use the Superset MCP \`update_task\` tool to update task "${task.id}" with a summary of what was done

## Available gstack Skills

You have access to the following slash commands — use them as part of your workflow:

- \`/plan-ceo-review\` — Founder/CEO review: rethink the problem, find the 10-star product hiding inside the request
- \`/plan-eng-review\` — Engineering Manager review: lock in architecture, data flow, diagrams, edge cases, and tests
- \`/review\` — Staff Engineer review: find race conditions, trust boundaries, N+1 queries, and production risks
- \`/ship\` — Release Engineer: sync main, run tests, resolve Greptile reviews, push, open PR
- \`/browse\` — QA Engineer: browser automation, log in, click through your app, take screenshots
- \`/qa\` — QA Lead: systematic QA testing with diff-aware, full, quick, and regression modes
- \`/retro\` — Engineering Manager retro: analyze commit history, velocity metrics, and team contributions`;
}

function buildHeredoc(
	prompt: string,
	delimiter: string,
	command: string,
	suffix?: string,
): string {
	const closing = suffix ? `)" ${suffix}` : ')"';
	return [
		`${command} "$(cat <<'${delimiter}'`,
		prompt,
		delimiter,
		closing,
	].join("\n");
}

const AGENT_FILE_COMMANDS: Record<AgentType, (filePath: string) => string> = {
	claude: (filePath) =>
		`claude --dangerously-skip-permissions "$(cat '${filePath}')"`,
	codex: (filePath) =>
		`codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true -- "$(cat '${filePath}')"`,
	gemini: (filePath) => `gemini --yolo "$(cat '${filePath}')"`,
	opencode: (filePath) => `opencode --prompt "$(cat '${filePath}')"`,
	copilot: (filePath) => `copilot -i "$(cat '${filePath}')" --yolo`,
	"cursor-agent": (filePath) => `cursor-agent --yolo "$(cat '${filePath}')"`,
};

export function buildAgentFileCommand({
	filePath,
	agent = "claude",
}: {
	filePath: string;
	agent?: AgentType;
}): string {
	const builder = AGENT_FILE_COMMANDS[agent];
	const escaped = filePath.replaceAll("'", "'\\''");
	return builder(escaped);
}

const AGENT_COMMANDS: Record<
	AgentType,
	(prompt: string, delimiter: string) => string
> = {
	claude: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "claude --dangerously-skip-permissions"),
	codex: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			'codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox --',
		),
	gemini: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "gemini --yolo"),
	opencode: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "opencode --prompt"),
	copilot: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "copilot -i", "--yolo"),
	"cursor-agent": (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "cursor-agent --yolo"),
};

export function buildAgentPromptCommand({
	prompt,
	randomId,
	agent = "claude",
}: {
	prompt: string;
	randomId: string;
	agent?: AgentType;
}): string {
	let delimiter = `SUPERSET_PROMPT_${randomId.replaceAll("-", "")}`;
	while (prompt.includes(delimiter)) {
		delimiter = `${delimiter}_X`;
	}
	const builder = AGENT_COMMANDS[agent];
	return builder(prompt, delimiter);
}

export function buildAgentCommand({
	task,
	randomId,
	agent = "claude",
}: {
	task: TaskInput;
	randomId: string;
	agent?: AgentType;
}): string {
	const prompt = buildAgentTaskPrompt(task);
	return buildAgentPromptCommand({ prompt, randomId, agent });
}

/** @deprecated Use `buildAgentCommand` instead */
export function buildClaudeCommand({
	task,
	randomId,
}: {
	task: TaskInput;
	randomId: string;
}): string {
	return buildAgentCommand({ task, randomId, agent: "claude" });
}
