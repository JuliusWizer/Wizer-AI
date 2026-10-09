# Wizer AI Technical Audit

**Audit date:** 2026-10-09  
**Project:** Wizer AI (`wizer-ai-website`)  
**Scope:** Existing application only; no interface rebuild

## 1. Executive summary

Wizer AI is an existing React 19 + Vite frontend backed by an Express server, tRPC procedures, Drizzle ORM, and a MySQL-compatible database. AI requests use the Manus Forge/OpenAI-compatible gateway with a custom server-side SSE proxy for streaming. The application already supports password authentication, Manus OAuth, persistent conversations for signed-in users, cross-chat memory context, generated speech, voice transcription, and multimodal uploads.

The current application is suitable for incremental hardening. The most urgent issues are:

1. **Public AI, voice, and stream endpoints have no explicit rate limiting, quotas, or abuse controls.**
2. **File and voice processing accepts large base64 JSON payloads**, creating memory and bandwidth pressure.
3. **AI request telemetry is absent**: latency, tokens, provider errors, and request identifiers are not persisted.
4. **There is no admin dashboard or backend admin procedure layer**, despite an existing `admin` role enum.
5. **Conversation messages are stored in one JSON text column**, which is simple but limits search, analytics, pagination, retention, and integrity controls.
6. **Model configuration is embedded in route logic**; there is no versioned provider/model/parameter configuration.
7. **Current document support is useful but incomplete**: text-like files, PDFs, images, and audio are covered; DOCX/XLSX/PPTX/ZIP and robust source attribution are not.

The app has a working recovery point from the latest verified feature release. Any risky database or authentication change should be introduced through additive migrations and a separate checkpoint.

## 2. Existing architecture

### Frontend

- React 19 + TypeScript + Vite.
- Main user experience is concentrated in `client/src/pages/Home.tsx`.
- `streamdown` renders markdown and partial streamed responses.
- tRPC React hooks handle account and persistent-history operations.
- Native `fetch` is used for SSE streaming, file upload payloads, and pre-send voice transcription.
- Guest history is kept in `localStorage`; signed-in history is synchronized to the database.

### Backend

- Express server entrypoint: `server/_core/index.ts`.
- tRPC endpoint: `/api/trpc`.
- Streaming endpoint: `/api/chat/stream`.
- Voice transcription endpoint: `/api/voice/transcribe`.
- Storage proxy and OAuth routes are registered by the server entrypoint.
- Authentication context checks the password-session cookie first, then Manus OAuth.

### AI/provider integration

- `server/_core/llm.ts` calls the configured Forge OpenAI-compatible chat-completions endpoint.
- Normal requests use `invokeLLM()`.
- Streamed requests use `streamLLM()` with SSE parsing and a response-close abort guard.
- Provider credentials come from server-only environment variables.
- The current system prompt is centralized for current and cross-chat continuity behavior in `server/chatPrompt.ts`.
- Voice transcription uses the built-in Whisper-compatible endpoint through `server/_core/voiceTranscription.ts`.
- Generated speech calls the configured audio speech endpoint from the chat router.

### Database and persistence

- Drizzle ORM over a MySQL-compatible database.
- `users` table includes account identity, password hash, avatar URL, role, and timestamps.
- `conversations` table stores one row per conversation with a JSON-serialized `messages` text column.
- `userId` ownership is checked in application code by conversation helpers.
- Migrations exist through the current conversation schema.

## 3. Current request flow

### Text or file chat

1. The frontend creates or selects a conversation and sends a JSON request to `/api/chat/stream`.
2. The server validates message, history, language, and attachment metadata with Zod.
3. Text-like files are decoded server-side; PDFs/images are uploaded to hosted storage and passed to the model as signed multimodal URLs.
4. Audio attachments are uploaded and transcribed before the model call.
5. For signed-in users, the server loads the active conversation and a bounded set of recent prior conversations.
6. The server writes the user message, builds the system/history/memory prompt, and starts the provider SSE request.
7. Text deltas are forwarded to the browser as SSE events.
8. The completed assistant response is written back to the conversation row.
9. Provider/storage/database failures trigger an owner notification.

### Microphone flow

1. The browser records audio with `MediaRecorder`.
2. The recording is sent to `/api/voice/transcribe`.
3. The server uploads it to hosted storage and calls the transcription service.
4. The returned transcript is placed into the composer for user review.
5. Only the reviewed text is sent to `/api/chat/stream`.

## 4. Current functionality that should be preserved

- Password registration/login and existing Manus OAuth compatibility.
- Server-side secret handling; no AI key is exposed to the browser.
- User ownership checks for conversation list, update, and deletion.
- Streaming responses and response-close abort behavior.
- Cross-chat memory bounded to recent relevant excerpts.
- Persistent signed-in history plus guest local drafts.
- Profile avatar upload and account menu.
- Multilingual response selection and automatic language mode.
- Server-side voice-to-text before AI submission.
- Natural generated audio playback for responses.
- Owner notifications for AI and persistence failures.
- Existing dark visual system and left/right chat alignment.

## 5. Identified problems and risks

### P0 — security and abuse risk

- `/api/chat/stream` is a public route and has no explicit per-IP, per-user, or concurrency limit.
- `/api/voice/transcribe` is public and has no explicit rate limit or authentication requirement.
- Public speech generation and public tRPC chat procedures can be used to consume provider credits.
- There is no request correlation ID, abuse audit event, or quota response contract.
- File payloads are base64-encoded in JSON, multiplying request size and memory use.
- Uploaded files and audio do not have a metadata table, retention policy, or user-owned cleanup operation.
- There is no CSRF/origin policy documented for the custom POST endpoints.

### P1 — reliability and operations

- LLM retry logic has exponential backoff but no explicit request timeout or total-generation deadline.
- Streaming retries can be risky if a provider partially accepts a request; retry policy should be cancellation-aware and observable.
- There is no persisted AI request record for latency, success/failure, provider status, or usage.
- Owner notifications are useful but do not replace an application error/audit log.
- Database writes happen before and after generation, so interrupted streams can leave a user-only turn that needs an explicit status model.
- The current stream route parses conversation JSON directly instead of using one shared safe parser.

### P1 — data model and performance

- A full conversation is stored in one text column. Every update rewrites the full JSON document.
- Cross-chat memory performs recent conversation reads and includes excerpts directly in every prompt; this can increase tokens and cost as histories grow.
- There are no explicit database foreign keys or indexes visible in the schema for `conversations.userId` and common time-based access.
- Conversation search, message-level analytics, retention, pagination, and per-message status are not supported efficiently.
- Guest history is local-only and can be lost when browser storage is cleared.

### P2 — product capability

- No admin dashboard exists even though user roles include `admin`.
- No admin-only router/procedure or audit trail exists.
- No model/provider configuration table or versioned prompt configuration exists.
- No web search provider or source attribution layer exists.
- Document ingestion does not yet cover office formats or structured extraction from large documents.
- No RAG/vector retrieval is justified yet, because uploads are currently sent directly to the model and there is no document library or source-management workflow.
- No user-configurable memory controls exist.

### P2 — maintainability

- `Home.tsx` is a large page component containing account, history, recording, uploads, SSE parsing, and message rendering logic.
- Standard tRPC chat and custom stream chat duplicate some prompt/persistence concepts.
- Model, voice, and upload policy constants are distributed across route files.
- There is no dedicated service layer for chat orchestration, attachment preparation, telemetry, or quotas.

## 6. Recommended implementation plan

### Phase 0 — protect and baseline

1. Keep the latest verified checkpoint as rollback protection.
2. Add a written migration/runbook policy and a test database/staging check before schema changes.
3. Add baseline request timing and provider-error logging with redaction.
4. Add integration tests for stream completion, disconnect, malformed uploads, and user isolation.

### Phase 1 — P0 security and reliability

1. Add request limits and rate limiting for chat, voice transcription, speech, and upload payloads.
2. Add a shared origin/CSRF check for custom POST endpoints where deployment behavior permits it.
3. Add configurable request timeout and total generation deadline to LLM calls.
4. Add request IDs and a redacted `ai_events`/`audit_events` table or structured log sink.
5. Add explicit attachment validation, file-count limits, MIME sniffing, and a user-scoped upload metadata record.
6. Add graceful stream status events for provider failure, client disconnect, and persistence failure.

### Phase 2 — usage and administration

1. Add protected `adminProcedure` checking `ctx.user.role === "admin"`.
2. Add an admin overview with cached/aggregated metrics: users, active users, conversations, requests, latency, failures, and usage where provider data exists.
3. Add user search/pagination without exposing passwords, session tokens, or unnecessary private data.
4. Add controlled conversation investigation with explicit authorization and audit logging.
5. Add model/prompt configuration only after a validated configuration table and rollback strategy exist.

### Phase 3 — database and conversation scalability

1. Add indexes and foreign-key constraints additively where supported by the deployed database.
2. Introduce `conversation_messages` as a normalized table while retaining the JSON column during migration.
3. Store message status (`pending`, `complete`, `failed`), created time, attachment references, and optional provider metadata.
4. Migrate reads/writes behind a repository interface, then remove the JSON fallback only after migration verification.
5. Add retention and account deletion workflows.

### Phase 4 — AI quality and knowledge features

1. Centralize model/parameter settings and prompt versions.
2. Add context-window budgeting and summarize older messages instead of sending unbounded recent history.
3. Add explicit memory controls: remember, inspect, forget, and disable cross-chat memory.
4. Add web search only with a reputable provider, source citations, timeout handling, and a clear retrieved-information label.
5. Add document library/RAG only if users need persistent private knowledge across many documents; avoid adding a vector database prematurely.

### Phase 5 — frontend maintainability and performance

1. Split `Home.tsx` into chat composer, message list, history pane, account menu, attachment picker, and voice recorder components.
2. Move SSE parsing and request state into a reusable hook.
3. Add upload progress, cancellation, file preview, and clearer pending/error states.
4. Add lazy loading and pagination for large histories.
5. Add accessibility tests for keyboard operation, focus, status announcements, and recording permissions.

## 7. File-by-file change map

| File or area | Recommended change | Priority |
|---|---|---:|
| `server/_core/index.ts` | Register shared security middleware, rate limits, request IDs, and route deadlines | P0 |
| `server/_core/llm.ts` | Add timeout/deadline support, normalized provider errors, and optional usage/latency hooks | P0/P1 |
| `server/chatStream.ts` | Move orchestration into a service, add attachment policy, statuses, telemetry, and shared parsing | P0/P1 |
| `server/voiceTranscribe.ts` | Add limits, rate limiting, request IDs, and upload metadata | P0 |
| `server/routers.ts` | Add admin procedure, usage/admin routers, and consolidate non-stream chat orchestration | P1/P2 |
| `server/db.ts` | Add repositories for events, uploads, messages, admin metrics, and retention | P1/P2 |
| `drizzle/schema.ts` | Add additive tables/indexes for messages, uploads, AI events, and audit events | P1/P2 |
| `server/_core/context.ts` | Preserve existing auth and expose a reusable role guard | P1 |
| `client/src/pages/Home.tsx` | Extract chat/voice/file concerns into components/hooks without changing the design | P2 |
| `server/chatPrompt.ts` | Add context budgeting, prompt versions, memory controls, and source labels | P1/P2 |
| `server/*.test.ts` | Add isolation, rate-limit, timeout, upload, admin, migration, and stream-disconnect tests | P0/P1 |

## 8. Decisions and non-goals

- Do not replace the current model without an evaluation set and measured reason.
- Do not add a vector database until a persistent document-library use case justifies it.
- Do not expose an unrestricted SQL console to admins or users.
- Do not fabricate token/cost metrics if the provider does not return them.
- Do not store passwords, API keys, full signed URLs, or unnecessary private conversation content in logs.
- Do not make destructive schema changes while exploratory work is underway.

## 9. Baseline validation

The current implementation has a passing automated baseline from the latest feature work:

- TypeScript check: passing.
- Vitest suite: 13 tests passing.
- Production build: passing.
- Hosted preview diagnostics: no TypeScript/LSP errors and dev server running.

The next safe implementation milestone is **Phase 1: rate limits, request deadlines, request IDs, upload policy hardening, and AI event telemetry**, followed by a dedicated admin dashboard in Phase 2.
