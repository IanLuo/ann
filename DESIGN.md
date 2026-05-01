# Meta-Assistant Architecture & Design

## 1. Overview
The Meta-Assistant is a TypeScript/Node.js CLI tool designed to act as an AI planner, researcher, and prompt engineer. Rather than executing final code generation or writing tasks directly, its primary goal is to decompose vague human requests into highly structured, context-aware "Instruction Documents" optimized for downstream AI agents.

A critical requirement of these documents is that every actionable step must include explicit, verifiable **Acceptance Criteria**.

## 2. Core Workflow (The Configuration-Driven Engine)
To ensure maximum flexibility, the system operates as a dynamic, configuration-driven state graph (a "Workflow Engine") rather than a rigid pipeline. The process can loop between states or be exited early based on user preference.

**Agent Roles are NOT fixed classes**, but configurable nodes (`AgentNode`) that dictate the LLM's system prompt, allowed tools, and routing logic. 

The default workflow consists of five conceptual roles:

### Phase 1: The Analyzer (Consultant & Researcher Node)
*   **Trigger:** Initial user prompt or mid-loop ambiguity.
*   **Responsibility:** Clarifies the request, explores trade-offs, and gathers initial context.
*   **Actions:**
    *   Asks the user clarifying questions via the CLI (`AskUser` tool).
    *   Uses tools (Tavily for web search, local file reading) to investigate options.
    *   Presents architectural or material choices to the user.
*   **Output:** An "Approved Context & Constraints" state within the `SessionContext`.

### Phase 2: The Planner (Drafter Node)
*   **Trigger:** Once the Analyzer has established clear constraints.
*   **Responsibility:** Decomposes the goal into a step-by-step execution plan.
*   **Actions:**
    *   Outputs **Structured JSON** enforcing an array of `Task` objects, each with explicit `acceptanceCriteria`.
    *   Requests more context from the Analyzer if it hits a roadblock.

### Phase 3: The Validator (Quality Assurance Node)
*   **Trigger:** After the Planner produces a JSON draft (partial or complete).
*   **Responsibility:** Micro-level, technical verification of the structured JSON AST (Abstract Syntax Tree).
*   **Checklist Items:**
    *   *Schema Check:* Did the Planner write Acceptance Criteria for every step?
    *   *Testability:* Are the Acceptance Criteria objectively verifiable?
    *   *Dependencies:* Are prerequisite steps logically ordered? Does a step reference uncreated variables?
*   **Output:** Passes the JSON plan forward (routes to Synthesizer) OR generates targeted structural critique and routes back to the Planner for technical refinement.

### Phase 4: The Synthesizer (Draft Formatter)
*   **Trigger:** When validation passes.
*   **Responsibility:** Formats the current JSON state of the plan into a readable Markdown draft.
*   **Output:** A Markdown document string ready for final review.

### Phase 5: The Reviewer (Product Manager Node) & Flexible Exit
*   **Trigger:** After the Synthesizer generates the Markdown draft.
*   **Responsibility:** Macro-level, strategic holistic verification. It simulates a downstream agent reading the final doc.
*   **Checklist Items:**
    *   *Goal Alignment:* Does this plan actually solve the original user prompt?
    *   *Context Completeness:* Is there enough context for a coding agent to execute this without guessing?
    *   *Edge Cases:* Did the Planner forget error states, security, or deployment instructions?
*   **Output:** Finalizes the file OR generates strategic critique and routes all the way back to the Analyzer/Planner for a pivot.
*   **Flexibility:** The user can dictate an early exit at any phase, bypassing the Reviewer if a quick outline is needed.

## 3. Technical Architecture

*For detailed module breakdowns and data flow, see [ARCHITECTURE.md](ARCHITECTURE.md).*

### 3.1. Tech Stack
*   **Language:** TypeScript / Node.js
*   **Interface:** CLI (e.g., using Commander.js, `@clack/prompts`)
*   **AI SDK:** Vercel AI SDK (`ai` package) for unified provider agnosticism (OpenAI, Anthropic, Local/Ollama).

### 3.2. Extensibility & Modularity
The system is designed to be highly modular and extensible:
*   **Workflow Engine:** Allows easily swapping or adding new roles (nodes) by simply defining a new configuration object.
*   **Tool Registry:** A standardized plugin interface using Zod schemas for agent capabilities (e.g., `TavilySearchTool`, `LocalFileReaderTool`, `AskUserTool`).
*   **Structured JSON Passing:** Agents pass structured JSON payloads, making validation and routing programmatically reliable.
*   **Resilience & Loop Prevention:** The Workflow Engine implements circuit breakers (`maxIterations`) to prevent infinite LLM loops (e.g., between Planner and Validator) and utilizes automatic retry mechanisms for malformed JSON schema outputs.

### 3.3. Memory & Storage
*   **Approach:** File-based storage (No complex databases required).
*   **Format:** 
    *   Outputs are saved as `.md` files.
    *   `SessionContext` (state, gathered context, chat history) is saved in `.json` files within a local workspace directory (e.g., `.meta-assistant/`).
*   **Observability:** Alongside session state, a debug log is maintained tracking token usage, latency, and full prompt/response traces to assist in debugging non-deterministic AI behavior.
*   **Benefits:** Completely transparent, version-controllable, and privacy-preserving.

### 3.4 Testing & Quality Assurance
*   **Evals (Evaluations):** Due to the non-deterministic nature of LLMs, standard unit tests are supplemented with "Evals." The `ValidatorNode` and other critical components will be tested against a suite of known inputs to ensure consistent catching of bad plans and proper schema handling.

## 4. Example Output Structure
The final Synthesizer output handed to downstream AIs will typically follow this structure:

```markdown
# Goal: [User's original or refined request]

## Context & Constraints
* [Key findings from Tavily search]
* [Local project constraints]

## Execution Plan

### Step 1: [Task Name]
* **Task:** [Detailed description of what needs to be done]
* **Acceptance Criteria:**
  * [ ] Criterion 1 (Objectively verifiable)
  * [ ] Criterion 2
  * [ ] Criterion 3
```