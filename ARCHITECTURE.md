# Detailed Architecture & Module Design

This document provides the technical blueprint for the Meta-Assistant, detailing the internal modules, data flow, and the configuration-driven workflow engine that powers the agentic state machine described in `DESIGN.md`.

## 1. Core Engine: Configuration-Driven Workflow
To ensure maximum flexibility and future-proofing, Agent Roles (Analyzer, Planner, Validator) are **not hardcoded classes**. Instead, the core is a generic `WorkflowEngine` that executes a graph of `AgentNode` configurations.

### 1.1. `SessionContext` (The Source of Truth)
State is passed between nodes via a centralized context object.
```typescript
interface SessionContext {
  originalGoal: string;
  gatheredContext: Array<{ source: string; content: string }>;
  currentPlanDraft: any; // Structured JSON of the plan
  validationFeedback: string[];
  chatHistory: any[]; // Vercel AI SDK message history
  variables: Record<string, any>; // Flexible state for custom nodes
  iterationCounts: Record<string, number>; // Tracks how many times a node was visited for loop prevention
}
```

### 1.2. `AgentNode` (The Role Configuration)
Every role is defined by a configuration object.
```typescript
interface AgentNode {
  id: string;                 // e.g., "planner", "validator"
  systemPrompt: string;       // Instructions for the LLM
  tools: string[];            // Allowed tools (e.g., ['tavilySearch', 'askUser'])
  outputSchema?: ZodSchema;   // Enforces structured JSON output from the LLM
  
  // Determines the next node in the graph based on the LLM's output
  routeNext: (output: any, context: SessionContext) => string; 
}
```

### 1.3. `WorkflowEngine`
The engine that runs the graph:
1. Receives the `SessionContext` and an array of `AgentNode`s.
2. Starts at the designated initial node.
3. Invokes the LLM (via Vercel AI SDK) with the node's prompt, tools, and schema.
4. Updates the `SessionContext` with the result.
5. Calls `routeNext()` to find the next node.
6. Loops until it hits an exit node (e.g., `"synthesizer"`).

## 2. Module Breakdown

### 2.1. `src/core/`
*   `WorkflowEngine.ts`: Implements the graph execution logic.
*   `types.ts`: Defines `SessionContext`, `AgentNode`, and core interfaces.

### 2.2. `src/llm/` (Provider Abstraction)
Uses the **Vercel AI SDK** to provide a unified API across different AI models.
*   `ProviderManager.ts`: Reads local configuration to instantiate the correct model provider (e.g., `openai('gpt-4o')`, `anthropic('claude-3-5-sonnet')`, or `ollama('llama3')`).

### 2.3. `src/tools/` (The Tool Registry)
Tools are isolated plugins with strict Zod schemas.
*   `ToolRegistry.ts`: Manages available tools and provides them to the Vercel AI SDK.
*   `implementations/`
    *   `TavilySearchTool.ts`: Fetches markdown content from the web.
    *   `LocalFileReaderTool.ts`: Reads local files safely.
    *   `AskUserTool.ts`: **Critical for interactivity.** Pauses the LLM, prompts the user via the CLI, and returns the human's answer to the LLM.

### 2.4. `src/nodes/` (Default Agent Roles)
The default configurations for our core workflow.
*   `AnalyzerNode.ts`: Focuses on context gathering and user consultation.
*   `PlannerNode.ts`: Outputs structured JSON containing steps and `acceptanceCriteria`.
*   `ValidatorNode.ts`: Reviews the JSON plan AST for schema validity and outputs `{ passed: boolean, feedback: string[] }`.
*   `ReviewerNode.ts`: Reviews the formatted Markdown draft holistically against the original goal. Outputs `{ approved: boolean, critique: string }`.

### 2.5. `src/storage/`
*   `WorkspaceManager.ts`: Handles saving/loading the `SessionContext` to `.meta-assistant/session.json` (allowing paused/resumed sessions).
*   `Synthesizer.ts`: Converts the final structured JSON plan into the polished `instructions.md` output.

### 2.6. `src/config/`
*   `ConfigManager.ts`: Handles secure loading of API keys (Tavily, LLM providers) and global CLI preferences from `~/.meta-assistant/config` or local `.env` files.

### 2.7. `src/telemetry/`
*   `Logger.ts`: Captures token usage, tool call latency, and state transitions, writing to a local debug file for developer troubleshooting.

### 2.8. `src/cli/`
*   `index.ts`: The Commander.js entry point.
*   `ui.ts`: Helpers for terminal UI (spinners, prompt formatting) using libraries like `@clack/prompts` or `inquirer`.

## 3. Data Flow Example (The Planning Loop)
1.  **CLI:** User runs `assistant plan "Build a scraper"`.
2.  **Engine:** Initializes `SessionContext` and starts the `AnalyzerNode`.
3.  **Analyzer:** LLM decides it needs more info. Uses `AskUserTool` to ask "Which website?". User answers. LLM uses `TavilySearchTool`. Updates `SessionContext.gatheredContext`. `routeNext` -> `"planner"`.
4.  **Planner:** LLM generates a JSON array of tasks with acceptance criteria. Updates `SessionContext.currentPlanDraft`. `routeNext` -> `"validator"`.
5.  **Validator:** LLM reviews the draft JSON. If it finds a flaw, outputs `{ passed: false, feedback: ["Step 2 missing details"] }`. `routeNext` -> `"planner"`.
6.  **Synthesizer:** Once Validator passes, the JSON is formatted to a Markdown draft string. `routeNext` -> `"reviewer"`.
7.  **Reviewer:** LLM reads the Markdown draft holistically. If it misaligns with the goal, routes back to `"analyzer"` or `"planner"`. If good, finalizes the document.
