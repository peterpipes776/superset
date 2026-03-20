import { type ChildProcess, exec, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type FSWatcher, openSync, watch } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { observable } from "@trpc/server/observable";
import simpleGit from "simple-git";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const execAsync = promisify(exec);
const MAX_FIX_ITERATIONS = 10;

// ---------- Log streaming infrastructure ----------

type FixLogEvent = { type: "data"; data: string } | { type: "reset" };

const greptileLogEmitter = new EventEmitter();
greptileLogEmitter.setMaxListeners(50);

/**
 * Tail a log file: watches via fs.watch + 500ms polling fallback.
 * Emits new bytes through greptileLogEmitter as `log:<worktreePath>`.
 * Returns a cleanup function.
 */
function startLogTail(logFile: string, worktreePath: string): () => void {
	let offset = 0;
	let disposed = false;
	let watcher: FSWatcher | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	const readNewBytes = async () => {
		if (disposed) return;
		try {
			const s = await stat(logFile);
			if (s.size <= offset) return;
			const fh = await open(logFile, "r");
			try {
				const buf = Buffer.alloc(s.size - offset);
				await fh.read(buf, 0, buf.length, offset);
				offset = s.size;
				const chunk = buf.toString("utf-8");
				if (chunk) {
					greptileLogEmitter.emit(`log:${worktreePath}`, chunk);
				}
			} finally {
				await fh.close();
			}
		} catch {
			// file may not exist yet or be locked — retry on next tick
		}
	};

	try {
		watcher = watch(logFile, () => {
			readNewBytes();
		});
		watcher.on("error", () => {
			// ignore — polling fallback covers this
		});
	} catch {
		// file might not exist yet at watch time
	}

	// Polling fallback (fs.watch is unreliable on some platforms/filesystems)
	pollTimer = setInterval(readNewBytes, 500);

	return () => {
		disposed = true;
		if (watcher) {
			watcher.close();
			watcher = null;
		}
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	};
}

interface GreptileScore {
	score: number | null;
	maxScore: number;
	summary: string | null;
	issues: string[];
	reviewContent: string | null;
	prNumber: number | null;
	prTitle: string | null;
	prUrl: string | null;
	reviewing: boolean;
	latestReviewId: number | null;
	latestReviewSubmittedAt: string | null;
	owner: string | null;
	repo: string | null;
	error: string | null;
}

type FixPhase =
	| "idle"
	| "fixing"
	| "waiting-for-review"
	| "done"
	| "max-reached"
	| "stopped";

interface FixLoopEntry {
	process: ChildProcess | null;
	phase: FixPhase;
	iteration: number;
	lastTriggeredScore: number | null;
	reviewIdAtFixStart: number | null;
	reviewSubmittedAtFixStart: string | null;
	exitCode: number | null;
	startedAt: number | null;
	logFile: string | null;
	pollTimer: ReturnType<typeof setInterval> | null;
	logTailCleanup: (() => void) | null;
	worktreePath: string;
}

// Track fix loop state per worktree — persists across workspace switches
const fixLoopState = new Map<string, FixLoopEntry>();

function getFixLoopStatus(worktreePath: string) {
	const entry = fixLoopState.get(worktreePath);
	if (!entry) {
		return {
			phase: "idle" as FixPhase,
			iteration: 0,
			lastTriggeredScore: null as number | null,
			startedAt: null as number | null,
			logFile: null as string | null,
			maxIterations: MAX_FIX_ITERATIONS,
		};
	}
	return {
		phase: entry.phase,
		iteration: entry.iteration,
		lastTriggeredScore: entry.lastTriggeredScore,
		startedAt: entry.startedAt,
		logFile: entry.logFile,
		maxIterations: MAX_FIX_ITERATIONS,
	};
}

function stopPollTimer(entry: FixLoopEntry) {
	if (entry.pollTimer) {
		clearInterval(entry.pollTimer);
		entry.pollTimer = null;
	}
}

function startReviewPolling(entry: FixLoopEntry) {
	stopPollTimer(entry);

	const poll = async () => {
		if (entry.phase !== "waiting-for-review") {
			stopPollTimer(entry);
			return;
		}

		try {
			const data = await getGreptileScore(entry.worktreePath);

			// Still reviewing — skip
			if (data.reviewing) return;

			// No review exists at all
			if (data.latestReviewId === null) return;

			// Detect new review: compare both ID and submitted_at timestamp
			// (handles in-place updates where ID stays the same but content changes)
			const sameReview =
				data.latestReviewId === entry.reviewIdAtFixStart &&
				data.latestReviewSubmittedAt === entry.reviewSubmittedAtFixStart;
			if (sameReview) return;

			// New review — check the score
			if (data.score === null || data.score === undefined) return;

			// Score is good — done!
			if (data.score >= 4) {
				entry.phase = "done";
				stopPollTimer(entry);
				return;
			}

			// Score still < 4 — trigger next iteration
			const nextIteration = entry.iteration + 1;
			if (nextIteration > MAX_FIX_ITERATIONS) {
				entry.phase = "max-reached";
				stopPollTimer(entry);
				return;
			}

			spawnFixProcess(
				entry,
				nextIteration,
				data.score,
				data.reviewContent,
				data.prNumber,
				data.owner,
				data.repo,
				data.latestReviewId,
				data.latestReviewSubmittedAt,
			);
		} catch {
			// will retry on next poll
		}
	};

	entry.pollTimer = setInterval(poll, 15_000);
	// Also poll once shortly after starting (give Greptile a moment)
	setTimeout(poll, 3_000);
}

function spawnFixProcess(
	entry: FixLoopEntry,
	iteration: number,
	score: number,
	reviewContent: string | null,
	prNumber: number | null,
	owner: string | null,
	repo: string | null,
	latestReviewId: number | null,
	latestReviewSubmittedAt: string | null,
) {
	// Kill any existing process
	if (entry.process) {
		try {
			entry.process.kill();
		} catch {
			// ignore
		}
	}
	stopPollTimer(entry);

	const ownerRepo = owner && repo ? `${owner}/${repo}` : "{owner}/{repo}";

	const gstackSection = `
## Required gstack Skills

You MUST run these slash commands as part of your workflow:

- \`/review\` — Staff Engineer review: find race conditions, trust boundaries, N+1 queries, and production risks. YOU MUST ALWAYS RUN THIS.
- \`/ship\` — Release Engineer: sync main, run tests, resolve Greptile reviews, push, open PR
- \`/qa\` — QA Lead: systematic QA testing with diff-aware, full, quick, and regression modes`;

	let prompt: string;
	if (reviewContent && prNumber) {
		prompt = `Fix Greptile code review issues on PR #${prNumber}. Iteration ${iteration}/${MAX_FIX_ITERATIONS}, current score: ${score}/5.

## Review Comments
${reviewContent}

## Steps
1. Read each file mentioned above at the specified line
2. For each issue, determine if it's a real bug or a false positive:
   - **Real bug**: Fix the code
   - **False positive**: Add a brief code comment at the flagged location explaining why the concern doesn't apply (e.g. \`// CAS-based refresh handles race condition — see line 95\`). This helps Greptile learn and prevents it from re-flagging the same non-issue.
3. Run \`/review\` to verify your changes don't introduce new problems. THIS IS MANDATORY — always run it even if all issues were false positives.
4. Stage changed files, commit with message: "fix: address greptile review feedback"
5. Push to the current branch
6. Resolve addressed review threads on GitHub:
   - Get thread IDs: gh api graphql -f query='{ repository(owner: "${owner ?? "{owner}"}", name: "${repo ?? "{repo}"}") { pullRequest(number: ${prNumber}) { reviewThreads(first: 100) { nodes { id isResolved path comments(first: 1) { nodes { body } } } } } } }'
   - For each unresolved thread you fixed, resolve it: gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_ID"}) { thread { isResolved } } }'

IMPORTANT: You must ALWAYS commit and push, even if all issues are false positives. The code comments explaining false positives are valuable changes that help the reviewer on subsequent passes.

## If the comments above are incomplete
Fetch full review comments yourself:
  gh api repos/${ownerRepo}/pulls/${prNumber}/reviews --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .id'
  gh api repos/${ownerRepo}/pulls/${prNumber}/reviews/REVIEW_ID/comments --jq '.[] | {path, line, body}'
${gstackSection}`;
	} else if (prNumber) {
		prompt = `Check the latest Greptile review comments on PR #${prNumber} and fix all issues, then commit and push. Iteration ${iteration}/${MAX_FIX_ITERATIONS}, current score: ${score}/5.

Fetch review comments:
  gh api repos/${ownerRepo}/pulls/${prNumber}/reviews --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | .id'
  gh api repos/${ownerRepo}/pulls/${prNumber}/reviews/REVIEW_ID/comments --jq '.[] | {path, line, body}'

For each issue: fix real bugs, and for false positives add a brief code comment explaining why the concern doesn't apply. Always commit and push — even false-positive annotations are valuable.

Then run \`/review\` (MANDATORY) to verify changes.
${gstackSection}`;
	} else {
		prompt = `Check the latest Greptile review comments on the current PR and fix all issues, then commit and push.

For each issue: fix real bugs, and for false positives add a brief code comment explaining why the concern doesn't apply. Always commit and push.

Then run \`/review\` (MANDATORY) to verify changes.
${gstackSection}`;
	}

	// Clean up previous log tail and signal a new iteration
	if (entry.logTailCleanup) {
		entry.logTailCleanup();
		entry.logTailCleanup = null;
	}
	greptileLogEmitter.emit(`log-reset:${entry.worktreePath}`);

	const logFile = join(tmpdir(), `greptile-fix-${Date.now()}.log`);
	const fd = openSync(logFile, "w");

	// Start tailing the new log file
	entry.logTailCleanup = startLogTail(logFile, entry.worktreePath);

	const child = spawn(
		"claude",
		["--dangerously-skip-permissions", "-p", prompt],
		{
			cwd: entry.worktreePath,
			detached: true,
			stdio: ["ignore", fd, fd],
		},
	);

	entry.process = child;
	entry.phase = "fixing";
	entry.iteration = iteration;
	entry.lastTriggeredScore = score;
	entry.exitCode = null;
	entry.startedAt = Date.now();
	entry.logFile = logFile;

	// Snapshot review state NOW (before Claude pushes new code) so polling can
	// detect when Greptile posts a new review. Previously this was done in the
	// exit handler, but if Greptile reviews fast the snapshot would capture the
	// NEW review, causing polling to think nothing changed.
	entry.reviewIdAtFixStart = latestReviewId;
	entry.reviewSubmittedAtFixStart = latestReviewSubmittedAt;

	child.on("exit", (code) => {
		if (entry.process !== child) return;
		entry.exitCode = code;
		entry.phase = "waiting-for-review";
		startReviewPolling(entry);
	});

	child.on("error", () => {
		if (entry.process !== child) return;
		entry.exitCode = -1;
		entry.phase = "waiting-for-review";
		startReviewPolling(entry);
	});

	child.unref();
}

// Detection strategy:
// - "reviewing" = greptile_comment section exists in PR body but no score yet
// - "new review landed" = latestReviewId OR submitted_at changed since fix started
// - We snapshot reviewId + submitted_at at SPAWN time (before Claude pushes) so
//   polling reliably detects the new review even if Greptile reviews quickly.

async function getGreptileScore(worktreePath: string): Promise<GreptileScore> {
	const empty: GreptileScore = {
		score: null,
		maxScore: 5,
		summary: null,
		issues: [],
		reviewContent: null,
		prNumber: null,
		prTitle: null,
		prUrl: null,
		reviewing: false,
		latestReviewId: null,
		latestReviewSubmittedAt: null,
		owner: null,
		repo: null,
		error: null,
	};

	try {
		// Get current branch
		const git = simpleGit(worktreePath);
		const branch = (await git.branch()).current;
		if (!branch || branch === "main" || branch === "master") {
			return { ...empty, error: "No feature branch (on main)" };
		}

		// Find PR for this branch — get body (where Greptile embeds its review)
		let prJson: string;
		try {
			const { stdout } = await execAsync(
				"gh pr view --json number,title,url,body --jq '.' 2>/dev/null",
				{ cwd: worktreePath, timeout: 15_000 },
			);
			prJson = stdout.trim();
		} catch {
			return { ...empty, error: "No PR found for this branch" };
		}

		if (!prJson) {
			return { ...empty, error: "No PR found for this branch" };
		}

		const pr = JSON.parse(prJson) as {
			number: number;
			title: string;
			url: string;
			body: string;
		};

		// Extract owner/repo for GraphQL instructions in fix prompt
		let owner: string | null = null;
		let repo: string | null = null;
		try {
			const { stdout: repoJson } = await execAsync(
				"gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}' 2>/dev/null",
				{ cwd: worktreePath, timeout: 15_000 },
			);
			const parsed = JSON.parse(repoJson.trim()) as {
				owner: string;
				name: string;
			};
			owner = parsed.owner;
			repo = parsed.name;
		} catch {
			// non-critical — prompt will use {owner}/{repo} placeholders
		}

		// Get latest review ID + submitted_at from greptile-apps[bot] (used to detect new reviews)
		let latestReviewId: number | null = null;
		let latestReviewSubmittedAt: string | null = null;
		let reviewContent: string | null = null;
		try {
			const { stdout: reviewsJson } = await execAsync(
				`gh api repos/{owner}/{repo}/pulls/${pr.number}/reviews --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last | {id, submitted_at}' 2>/dev/null`,
				{ cwd: worktreePath, timeout: 15_000 },
			);
			const reviewMeta = JSON.parse(reviewsJson.trim() || "null") as {
				id: number;
				submitted_at: string;
			} | null;
			if (reviewMeta?.id) {
				latestReviewId = reviewMeta.id;
				latestReviewSubmittedAt = reviewMeta.submitted_at ?? null;
				// Get review comments with file/line context (not just body)
				const { stdout: commentsJson } = await execAsync(
					`gh api repos/{owner}/{repo}/pulls/${pr.number}/reviews/${latestReviewId}/comments --jq '[.[] | {path, line, body}]' 2>/dev/null`,
					{ cwd: worktreePath, timeout: 15_000 },
				);
				const comments = JSON.parse(commentsJson.trim() || "[]") as {
					path: string | null;
					line: number | null;
					body: string;
				}[];
				reviewContent = comments
					.map((c) => {
						const loc = c.path
							? `### ${c.path}${c.line ? ` (line ${c.line})` : ""}`
							: "### (general comment)";
						return `${loc}\n${c.body}`;
					})
					.join("\n\n")
					.slice(0, 15000);
			}
		} catch {
			// non-critical
		}

		// Extract the Greptile section from the PR body
		const greptileMatch = pr.body?.match(
			/<!-- greptile_comment -->([\s\S]*?)<!-- \/greptile_comment -->/,
		);

		if (!greptileMatch) {
			return {
				...empty,
				prNumber: pr.number,
				prTitle: pr.title,
				prUrl: pr.url,
				latestReviewId,
				latestReviewSubmittedAt,
				reviewing: false,
				error: "No Greptile review on this PR yet",
			};
		}

		const greptileSection = greptileMatch[1];

		// Extract score
		const scoreMatch = greptileSection.match(
			/Confidence\s+Score:\s*(\d)\s*\/\s*5/i,
		);
		const score = scoreMatch ? Number.parseInt(scoreMatch[1], 10) : null;

		// Extract summary
		let summary: string | null = null;
		const summaryMatch = greptileSection.match(
			/<h3>Greptile Summary<\/h3>\s*([\s\S]*?)(?=<h3>)/,
		);
		if (summaryMatch) {
			summary = summaryMatch[1]
				.replace(/<[^>]+>/g, "")
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0)
				.slice(0, 3)
				.join(" ")
				.slice(0, 300);
		}

		// Extract issues — bullet points between Confidence Score and Important Files
		const issuesMatch = greptileSection.match(
			/Confidence\s+Score:\s*\d\s*\/\s*5<\/h3>\s*([\s\S]*?)(?=<h3>Important\s+Files|<h3>Greptile\s+Summary|$)/i,
		);
		const issues: string[] = [];
		if (issuesMatch) {
			const raw = issuesMatch[1]
				.replace(/<[^>]+>/g, "")
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0);
			for (const line of raw) {
				if (issues.length < 10) {
					issues.push(line.slice(0, 500));
				}
			}
		}

		// Determine reviewing state: greptile section exists but no score yet.
		// Previously used fragile keyword matching ("reviewing"/"in progress"/"analyzing")
		// which false-positived on completed reviews mentioning those words in summaries.
		const reviewing = score === null;

		return {
			score,
			maxScore: 5,
			summary,
			issues,
			reviewContent,
			prNumber: pr.number,
			prTitle: pr.title,
			prUrl: pr.url,
			reviewing,
			latestReviewId,
			latestReviewSubmittedAt,
			owner,
			repo,
			error: null,
		};
	} catch (error) {
		return {
			...empty,
			error: error instanceof Error ? error.message : "Failed to fetch",
		};
	}
}

export const createGreptileRouter = () => {
	return router({
		getGreptileScore: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.query(async ({ input }): Promise<GreptileScore> => {
				return getGreptileScore(input.worktreePath);
			}),

		getFixStatus: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.query(({ input }) => {
				return getFixLoopStatus(input.worktreePath);
			}),

		fixGreptile: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					reviewContent: z.string().optional(),
					prNumber: z.number().optional(),
					owner: z.string().optional(),
					repo: z.string().optional(),
					latestReviewId: z.number().optional(),
					latestReviewSubmittedAt: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				let entry = fixLoopState.get(input.worktreePath);
				if (!entry) {
					entry = {
						process: null,
						phase: "idle",
						iteration: 0,
						lastTriggeredScore: null,
						reviewIdAtFixStart: null,
						reviewSubmittedAtFixStart: null,
						exitCode: null,
						startedAt: null,
						logFile: null,
						pollTimer: null,
						logTailCleanup: null,
						worktreePath: input.worktreePath,
					};
					fixLoopState.set(input.worktreePath, entry);
				}

				spawnFixProcess(
					entry,
					1,
					0,
					input.reviewContent ?? null,
					input.prNumber ?? null,
					input.owner ?? null,
					input.repo ?? null,
					input.latestReviewId ?? null,
					input.latestReviewSubmittedAt ?? null,
				);
				return { started: true };
			}),

		stopFix: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.mutation(({ input }) => {
				const entry = fixLoopState.get(input.worktreePath);
				if (entry) {
					if (entry.process) {
						try {
							entry.process.kill();
						} catch {
							// ignore
						}
					}
					stopPollTimer(entry);
					if (entry.logTailCleanup) {
						entry.logTailCleanup();
						entry.logTailCleanup = null;
					}
					entry.phase = "stopped";
				}
				return { stopped: true };
			}),

		streamFixLog: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.subscription(({ input }) => {
				return observable<FixLogEvent>((emit) => {
					const { worktreePath } = input;

					// Send existing log content on connect (catch-up)
					const entry = fixLoopState.get(worktreePath);
					if (entry?.logFile) {
						readFile(entry.logFile, "utf-8")
							.then((content) => {
								if (content) {
									emit.next({ type: "data", data: content });
								}
							})
							.catch(() => {
								// file may not exist yet
							});
					}

					const onData = (chunk: string) => {
						emit.next({ type: "data", data: chunk });
					};
					const onReset = () => {
						emit.next({ type: "reset" });
					};

					greptileLogEmitter.on(`log:${worktreePath}`, onData);
					greptileLogEmitter.on(`log-reset:${worktreePath}`, onReset);

					return () => {
						greptileLogEmitter.off(`log:${worktreePath}`, onData);
						greptileLogEmitter.off(`log-reset:${worktreePath}`, onReset);
					};
				});
			}),
	});
};
