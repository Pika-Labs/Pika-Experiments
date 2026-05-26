import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(root, "public");
const pikaTokenPath = join(root, ".pika-token.json");
const googleTokenPath = join(root, ".google-token.json");

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
const PIKA_MCP_URL = process.env.PIKA_MCP_URL || "https://mcp.pika.me/api/mcp";
const PIKA_RESOURCE_METADATA_URL = "https://mcp.pika.me/.well-known/oauth-protected-resource";
const PIKA_AUTH_METADATA_URL = "https://mcp.pika.me/.well-known/oauth-authorization-server";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts"
];

const STAGE_LAYOUT_PROMPT = [
  "Design the Stage like a presentation canvas, not a webpage.",
  "The user is usually on a desktop browser with a large horizontal viewport. The layout should read quickly from a distance: large objects, clear hierarchy, minimal text, generous whitespace, and strong visual grouping.",
  "The host app already provides the background. Do not set a full-page or full-layout background color. Let the Stage remain transparent unless styling an individual object.",
  "Layouts should feel art-directed, as if a graphic designer composed them for this specific answer using the house style. Favor presentation-slide, editorial, bento-inspired, moodboard, dashboard, or desktop-object compositions over generic webpage layouts.",
  "Before composing the layout, analyze the content and choose a clear theme for the presentation. The theme may describe the subject, format, or intended use: recipe card, analytics dashboard, brand guidelines, weather forecast, calendar wall, product moodboard, storyboard, launch plan, inbox triage, comparison board, capability map, or something more specific to the request. Let that theme drive the structure, scale, typography, spacing, and visual rhythm of the custom HTML layout.",
  "The theme is internal art direction. Do not print it as a visible label, title, or eyebrow unless it genuinely improves the design.",
  "Use a white rounded surface only when an individual item needs visual separation.",
  "Do not wrap the entire layout in a surface. Do not nest one surface inside another. Avoid borders, outlines, dividers, and report-like header stacks.",
  "Optimize for fast visual comprehension: short text, strong hierarchy, clear grouping, generous spacing, and obvious relationships between items. The composition should fill the available Stage generously.",
  "Make objects and typography large enough to feel intentional and readable from a distance, but keep hierarchy elegant.",
  "For major visual objects, add data-stage-item when natural. If an object represents a persistent media URL or repeated entity, add a stable data-stage-key. The host app handles motion; do not add your own full-screen loading states.",
  [
    "Typography starting points:",
    "H1: 64-96px, 800-900 weight, line-height around 0.95-1.05.",
    "H2: 36-56px, 750-850 weight, line-height around 1.0-1.1.",
    "H3: 22-32px, 650-800 weight, line-height around 1.05-1.15.",
    "Body: 16-22px, 450-600 weight, line-height around 1.25-1.45.",
    "Captions/labels: 13-17px, 450-650 weight, muted ink."
  ].join("\n"),
  "These typography values are starting points, not hard limits. Adjust for content, viewport, and composition, but keep a clear hierarchy and avoid using more than four distinct type sizes in one layout."
].join("\n\n");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"]
]);

let mcpId = 1;
let mcpInitialized = false;
let mcpSessionId = null;
let cachedTools = null;
let cachedPikaIdentity = null;
let pikaOauthMetadata = null;
let pikaAuthState = null;
let pikaToken = loadPikaToken();
let googleAuthState = null;
let googleToken = loadGoogleToken();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
      const pikaIdentity = hasUsablePikaToken()
        ? await loadPikaIdentity().catch((error) => ({ warning: error.message }))
        : {};
      return json(res, {
        realtimeModel: REALTIME_MODEL,
        pikaMcpUrl: PIKA_MCP_URL,
        hasOpenAIKey: Boolean(OPENAI_API_KEY),
        hasPikaToken: hasUsablePikaToken(),
        needsPikaReconnect: Boolean(pikaToken?.access_token && !hasUsablePikaToken()),
        pikaIdentity: summarizePikaIdentity(pikaIdentity),
        hasGoogleToken: hasUsableGoogleToken() && hasGoogleScopes(),
        hasGoogleConfig: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
        needsGoogleReconnect: Boolean(googleToken?.access_token && (!hasUsableGoogleToken() || !hasGoogleScopes()))
      });
    }

    if (req.method === "POST" && url.pathname === "/api/realtime/sdp") {
      return handleRealtimeSdp(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/realtime/token") {
      return handleRealtimeToken(res);
    }

    if (req.method === "GET" && url.pathname === "/api/mcp/tools") {
      const tools = await listPikaTools();
      return json(res, { tools });
    }

    if (req.method === "GET" && url.pathname === "/api/pika/oauth/start") {
      return startPikaOAuth(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/pika/oauth/callback") {
      return finishPikaOAuth(url, res);
    }

    if (req.method === "GET" && url.pathname === "/api/pika/status") {
      return json(res, {
        connected: hasUsablePikaToken(),
        needsReconnect: Boolean(pikaToken?.access_token && !hasUsablePikaToken())
      });
    }

    if (req.method === "GET" && url.pathname === "/api/google/oauth/start") {
      return startGoogleOAuth(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/google/oauth/callback") {
      return finishGoogleOAuth(url, res);
    }

    if (req.method === "GET" && url.pathname === "/api/google/status") {
      return json(res, {
        configured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
        connected: hasUsableGoogleToken() && hasGoogleScopes(),
        needsReconnect: Boolean(googleToken?.access_token && (!hasUsableGoogleToken() || !hasGoogleScopes()))
      });
    }

    if (req.method === "POST" && url.pathname === "/api/mcp/call") {
      const body = await readJson(req);
      if (!body?.name) {
        return json(res, { error: "Missing tool name." }, 400);
      }

      const result = await callPikaTool(body.name, body.arguments || {});
      return json(res, result);
    }

    if (req.method === "POST" && url.pathname === "/api/google/call") {
      const body = await readJson(req);
      if (!body?.name) return json(res, { error: "Missing Google tool name." }, 400);
      const result = await callGoogleTool(body.name, body.arguments || {});
      return json(res, result);
    }

    if (req.method === "POST" && url.pathname === "/api/codex/ask") {
      const body = await readJson(req);
      if (!body?.question) return json(res, { error: "Missing question." }, 400);
      const result = await askCodex(body);
      return json(res, result);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    json(res, { error: "Not found." }, 404);
  } catch (error) {
    console.error(error);
    json(res, { error: error.message || "Server error." }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Voice Stage running at http://localhost:${PORT}`);
});

async function handleRealtimeToken(res) {
  if (!OPENAI_API_KEY) {
    return json(res, { error: "OPENAI_API_KEY is not set on the server." }, 500);
  }

  let pikaTools = [];
  let pikaWarning = null;
  try {
    pikaTools = await listPikaTools();
  } catch (error) {
    pikaWarning = error.message;
  }

  const pikaIdentity = await loadPikaIdentity().catch((error) => ({
    warning: error.message
  }));

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions: buildRealtimeInstructions(pikaIdentity),
        tools: [
          stageShowImagesTool(),
          stageRenderHtmlTool(),
          stageRenderSceneTool(),
          stagePresentListTool(),
          stageStyleProfileTool(),
          askCodexTool(),
          ...googleSuiteTools(),
          ...pikaTools.map(toRealtimePikaTool).filter(Boolean)
        ],
        tool_choice: "auto",
        audio: {
          input: {
            transcription: {
              model: TRANSCRIPTION_MODEL
            }
          },
          output: {
            voice: REALTIME_VOICE
          }
        }
      }
    })
  });

  const payload = await response.json().catch(() => ({ error: "Could not parse OpenAI token response." }));
  return json(res, {
    ...payload,
    error: normalizeUpstreamError(payload.error),
    pikaWarning,
    pikaIdentity: summarizePikaIdentity(pikaIdentity),
    pikaTools: pikaTools.map((tool) => ({
      originalName: tool.name,
      realtimeName: pikaRealtimeName(tool.name)
    }))
  }, response.status);
}

function normalizeUpstreamError(error) {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  return error.message || JSON.stringify(error);
}

async function handleRealtimeSdp(req, res) {
  if (!OPENAI_API_KEY) {
    return json(res, { error: "OPENAI_API_KEY is not set on the server." }, 500);
  }

  const offerSdp = await readText(req);
  const realtimeUrl = new URL("https://api.openai.com/v1/realtime");
  realtimeUrl.searchParams.set("model", REALTIME_MODEL);

  const response = await fetch(realtimeUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/sdp"
    },
    body: offerSdp
  });

  const answer = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") || "application/sdp"
  });
  res.end(answer);
}

function buildRealtimeInstructions(pikaIdentity = {}) {
  return [
    "You are a voice-controlled agent inside a Presentation Stage website.",
    formatPikaIdentityPrompt(pikaIdentity),
    "Speak naturally, casually, and briefly. Usually use one short sentence, sometimes two. Keep it light and human, not robotic or repetitive.",
    "For tool work, do not speak both before and after the tool call. Choose one brief acknowledgement OR one brief completion, not both. Prefer staying quiet before the tool and giving a short natural completion when the result is ready.",
    "Do not narrate every step. Let the UI/status indicator carry progress updates unless the user asks what is happening.",
    "Do not restate, summarize, paraphrase, or repeat the user's request before acting unless clarification is needed.",
    "After tool results, do not repeat what the user asked for or explain what you did. Give at most one short natural confirmation.",
    "Do not mention the stage, UI, panel, display system, tool calls, MCP, or rendering mechanics unless the user asks how the app works.",
    "When something visual or playable is ready, keep the response short and natural. Avoid 'I made...', 'I generated...', 'you asked for...', 'it will be shown...', or similar.",
    "Assume the authenticated Pika identity when speaking. If identity files are present, they are private grounding, not text to recite.",
    "For coding, filesystem, repo, app-building, debugging, local server, or implementation work, call ask_codex. That tool delegates to the local Codex CLI agent in the shared workspace.",
    "For creation, media, search, rendering, artifact, or Pika-specific action requests, use available Pika MCP tools instead of inventing results.",
    "For Google Workspace questions about the user's calendar, availability, Gmail, or Drive, use the google_* tools. If Google is not connected, say it needs to be connected from the menu.",
    "For scheduling meetings, use google_calendar_create_event after you have the date, time, title, and attendees. For sending email, use google_gmail_send after you have recipients, subject, and body.",
    "For images, call generate_image. For videos, call generate_video or the relevant Pika video/edit tool. For music/audio/voice, call generate_music, generate_speech, or another matching Pika tool.",
    "If Pika returns image/video/audio URLs, wait for the tool result, then compose them into a custom stage_render_html layout unless the user only asked for a raw single media item.",
    "For two or more media items, decide the composition yourself: side-by-side, overlapping collage, comparison, option picker, timeline, or another layout that fits the user's intent. Strongly prefer horizontal widescreen compositions that leave generous safe space along the bottom for the voice caption, identity, and status pill.",
    "Only call stage_show_images when you have real http(s) image URLs. Never pass a prompt, caption, filename, or description as a URL.",
    "When information has an obvious visual shape, prefer stage_render_html and design a custom layout for that exact request. Visual-shaped information includes forecasts, calendars, availability, schedules, timelines, itineraries, dashboards, metrics, rankings, comparisons, roadmaps, budgets, plans with phases, capability maps, code snippets, search results, emails, documents, and anything involving dates, times, quantities, status, categories, or media.",
    "Use stage_render_html as the main Stage layout tool. The AI-authored HTML should feel bespoke and non-deterministic: write custom markup and CSS for the moment, use the provided class kit as optional building blocks, and add instance-specific CSS for the exact layout. Do not rely on the vs-* primitive classes alone. The goal is flexible generative UI, not fixed templates.",
    STAGE_LAYOUT_PROMPT,
    "Never present raw JSON, tool payloads, API result dumps, function names, or code-like metadata on the Stage unless the user explicitly asks to inspect technical details. Transform results into a visual composition first.",
    "Do not show intermediate layout attempts. After a data/media tool returns, compile the final composition in your head and call stage_render_html once with the complete layout.",
    "Available Stage primitives include: vs-board, vs-fill, vs-header, vs-title, vs-subtitle, vs-grid, vs-seven, vs-row, vs-concepts, vs-directions, vs-ad-variants, vs-cluster, vs-brand-board, vs-storyboard, vs-reel-stack, vs-dashboard, vs-surface, vs-card, vs-tile, vs-object, vs-media-object, vs-frame, vs-wide, vs-tall, vs-tilt-left, vs-tilt-right, vs-hero-card, vs-icon, vs-xl, vs-label, vs-value, vs-body, vs-list, vs-meta, vs-chip, vs-chart-bars, vs-poll, vs-poll-row, vs-code, vs-email, vs-sparkline, vs-visual, vs-weather-tile, vs-calendar-strip, vs-calendar-day, vs-timeline, vs-time-block, vs-event.",
    "Use stage_render_scene only for very quick fallback scenes or when the user explicitly asks for a simple structured scene. Use stage_present_list only for plain text-heavy notes that truly do not benefit from custom visual layout.",
    "For user style memory: use the optional stage_render_html.style object for explicit per-render preferences like typographyScale, spacingScale, shadowStrength, backgroundUsage, componentScale, composition, radiusScale, lowerStageClearance, textContrast, and accentColor. When the user says 'save this style', call stage_style_profile with command 'save'. When the user says 'reset style', call stage_style_profile with command 'reset'.",
    "For all generated Stage HTML/CSS, use this color system: background cream #FCF7F0, raised #FFFFFF, ink #0D0D0D or #222222, secondary text rgba(13,13,13,0.70), tertiary rgba(13,13,13,0.50), quaternary rgba(13,13,13,0.30), sunken surfaces rgba(13,13,13,0.04), borders only if requested using rgba(13,13,13,0.08/0.12/0.24), lavender accent #CFC3FF, hover #BDADFF, press #A999FF, soft lavender fill rgba(207,195,255,0.20), focus halo rgba(207,195,255,0.55). Avoid invented blues, greens, reds, browns, or purple approximations.",
    "Answer directly only for normal conversation or when no tool is needed. Keep direct answers compact unless the user asks for detail."
  ].filter(Boolean).join("\n\n");
}

function googleSuiteTools() {
  return [
    {
      type: "function",
      name: "google_calendar_events",
      description: "List the user's Google Calendar events for a time range.",
      parameters: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "ISO datetime. Defaults to now." },
          timeMax: { type: "string", description: "ISO datetime. Defaults to 24 hours after timeMin." },
          maxResults: { type: "number" }
        },
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "google_calendar_availability",
      description: "Find free/busy availability on the user's primary Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
          days: { type: "number", description: "Number of days to inspect, default 1." },
          workdayStart: { type: "string", description: "HH:MM, default 09:00." },
          workdayEnd: { type: "string", description: "HH:MM, default 17:00." }
        },
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "google_calendar_create_event",
      description: "Create a Google Calendar event on the user's primary calendar.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          description: { type: "string" },
          location: { type: "string" },
          start: { type: "string", description: "ISO datetime for event start." },
          end: { type: "string", description: "ISO datetime for event end." },
          attendees: { type: "array", items: { type: "string" }, description: "Email addresses to invite." }
        },
        required: ["summary", "start", "end"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "google_gmail_recent",
      description: "List recent Gmail messages with subject/from/date/snippet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional Gmail search query." },
          maxResults: { type: "number" }
        },
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "google_gmail_search",
      description: "Search Gmail messages with a Gmail query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "number" }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "google_gmail_send",
      description: "Send an email from the user's Gmail account.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          bcc: { type: "array", items: { type: "string" } },
          subject: { type: "string" },
          body: { type: "string" }
        },
        required: ["to", "subject", "body"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "google_drive_search",
      description: "Search Google Drive files by name/full text metadata.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "number" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  ];
}

function stageShowImagesTool() {
  return {
    type: "function",
    name: "stage_show_images",
    description: "Display one or more image URLs on the user's main Presentation Stage.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        images: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              prompt: { type: "string" },
              caption: { type: "string" }
            },
            additionalProperties: false
          }
        }
      },
      required: ["images"],
      additionalProperties: false
    }
  };
}

function stageRenderSceneTool() {
  return {
    type: "function",
    name: "stage_render_scene",
    description: "Render a quick deterministic Stage scene from structured items. This is a fallback for simple scenes; prefer stage_render_html when the user wants a polished, bespoke, visual layout. Do not add a big title for simple media-only scenes unless the title itself is important; captions are usually enough. Jumbo titles are opt-in via titleSize:'jumbo' and should be rare.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        eyebrow: { type: "string" },
        subtitle: { type: "string" },
        showTitle: {
          type: "boolean",
          description: "Optional. Use true only when a header improves the scene. For simple media/image scenes, omit or set false so the image can stand alone with its caption."
        },
        titleSize: {
          type: "string",
          description: "Optional title scale: quiet, normal, or jumbo. Default is normal. Use jumbo rarely for hero/editorial cover scenes only."
        },
        variant: {
          type: "string",
          description: "Optional art direction variant: balanced, compact, spread, editorial, or stacked. This influences deterministic layout without hard-coding every request."
        },
        intent: {
          type: "string",
          description: "One of hero, media_stack, comparison, dashboard, calendar, inbox, storyboard, product_board, timeline, document, confirmation, moodboard."
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: {
                type: "string",
                description: "One of image, video, audio, email, calendar, weather, metric, chart, product, document, task, code, card, text."
              },
              url: { type: "string", description: "Media URL for image/video/audio items." },
              href: { type: "string", description: "Optional click-through URL." },
              title: { type: "string" },
              caption: { type: "string" },
              body: { type: "string" },
              icon: { type: "string" },
              value: { type: "string" },
              language: { type: "string" },
              filename: { type: "string" }
            },
            additionalProperties: false
          }
        }
      },
      required: ["items"],
      additionalProperties: false
    }
  };
}

function stagePresentListTool() {
  return {
    type: "function",
    name: "stage_present_list",
    description: "Display a clean structured answer on the Stage as floating white cards. Use only for plain text-heavy notes, checklists, prose summaries, and agendas that do not need a bespoke visual layout. For capability overviews, menus, feature maps, forecasts, calendars, schedules, dashboards, metrics, timelines, visual comparisons, or anything with dates, times, quantities, status, media, or obvious visual structure, prefer stage_render_html.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        eyebrow: { type: "string", description: "Optional small label above the title." },
        subtitle: { type: "string" },
        layout: {
          type: "string",
          description: "Optional: document, grid, columns, timeline, checklist, comparison."
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              body: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    text: { type: "string" },
                    tag: { type: "string" }
                  },
                  additionalProperties: false
                }
              }
            },
            additionalProperties: false
          }
        }
      },
      required: ["title", "sections"],
      additionalProperties: false
    }
  };
}

function stageRenderHtmlTool() {
  return {
    type: "function",
    name: "stage_render_html",
    description: "Render the final custom presentation view on the Stage using AI-authored safe HTML, CSS, and optional JavaScript. This is the preferred layout tool for most visual answers: media, forecasts, calendars, availability, inboxes, schedules, timelines, dashboards, metrics, rankings, comparisons, roadmaps, budgets, product boards, storyboards, code snippets, documents, and anything with dates, times, quantities, status, icons, categories, links, or media. Follow the Stage layout prompt from your instructions: analyze the content, choose an internal theme, and design a composed presentation canvas, not a webpage. Always include bespoke CSS for composition, sizing, overlap, hierarchy, and content-specific details. Stage primitives are optional helpers, not a substitute for layout CSS.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        html: {
          type: "string",
          description: "Body HTML. Script tags are allowed for isolated Stage behavior. Use semantic markup and class names that your css field styles directly. Stage primitives are optional helpers: vs-board, vs-fill, vs-header, vs-title, vs-subtitle, vs-grid, vs-seven, vs-row, vs-concepts, vs-directions, vs-ad-variants, vs-cluster, vs-brand-board, vs-storyboard, vs-reel-stack, vs-dashboard, vs-surface, vs-card, vs-tile, vs-object, vs-media-object, vs-frame, vs-wide, vs-tall, vs-tilt-left, vs-tilt-right, vs-hero-card, vs-icon, vs-xl, vs-label, vs-value, vs-body, vs-list, vs-meta, vs-chip, vs-chart-bars, vs-poll, vs-poll-row, vs-code, vs-email, vs-sparkline, vs-visual, vs-weather-tile, vs-calendar-strip, vs-calendar-day, vs-timeline, vs-time-block, vs-event. Use vs-surface only once per floating object. Use vs-eyebrow only rarely. Also available: stage-card, stage-row, stage-pill, stage-title, stage-caption, floating. Avoid border/outline/stroke attributes unless requested."
        },
        css: {
          type: "string",
          description: "Required CSS scoped to the rendered document. Make it bespoke for this exact response. Define the composition, sizing, hierarchy, spacing, type scale, surfaces, shadows, media sizing, and responsive behavior. Use floating elements, soft shadows, rounded corners, chunky Swiss typography, and generous spacing. Bias toward desktop widescreen compositions that fill the stage well, stay centered, and degrade cleanly at smaller sizes. Do not add borders, outlines, strokes, rules, or dividers unless requested."
        },
        style: {
          type: "object",
          description: "Optional style hints for this render. Use only when you want to tune the house style without writing every value manually.",
          properties: {
            typographyScale: { type: "number" },
            spacingScale: { type: "number" },
            shadowStrength: { type: "number" },
            backgroundUsage: { type: "string" },
            componentScale: { type: "number" },
            composition: { type: "string" },
            radiusScale: { type: "number" },
            lowerStageClearance: { type: "number" },
            textContrast: { type: "string" },
            accentColor: { type: "string" }
          },
          additionalProperties: false
        }
      },
      required: ["html", "css"],
      additionalProperties: false
    }
  };
}

function stageStyleProfileTool() {
  return {
    type: "function",
    name: "stage_style_profile",
    description: "Read, save, or reset the user's preferred Stage visual style. Use only when the user explicitly asks to save, remember, reset, or inspect the current stage style.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Use get, save, or reset."
        },
        name: {
          type: "string",
          description: "Optional profile name when saving."
        },
        style: {
          type: "object",
          description: "Optional style overrides to save with the profile.",
          properties: {
            typographyScale: { type: "number" },
            spacingScale: { type: "number" },
            shadowStrength: { type: "number" },
            backgroundUsage: { type: "string" },
            componentScale: { type: "number" },
            composition: { type: "string" },
            radiusScale: { type: "number" },
            lowerStageClearance: { type: "number" },
            textContrast: { type: "string" },
            accentColor: { type: "string" }
          },
          additionalProperties: false
        }
      },
      required: ["command"],
      additionalProperties: false
    }
  };
}

function askCodexTool() {
  return {
    type: "function",
    name: "ask_codex",
    description: "Delegate coding, local workspace, app-building, debugging, filesystem, or implementation tasks to the local Codex CLI agent.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The exact task Codex should perform or answer."
        },
        context: {
          type: "string",
          description: "Optional context from the voice conversation or current stage."
        }
      },
      required: ["question"],
      additionalProperties: false
    }
  };
}

function toRealtimePikaTool(tool) {
  if (!tool?.name) return null;
  const parameters = normalizeRealtimeToolSchema(tool.inputSchema);
  return {
    type: "function",
    name: pikaRealtimeName(tool.name),
    description: tool.description || `Pika MCP tool: ${tool.name}`,
    parameters: hasRealtimeUnsupportedSchemaShape(parameters) ? emptyRealtimeSchema() : parameters
  };
}

function normalizeRealtimeToolSchema(schema) {
  if (!schema || typeof schema !== "object") return emptyRealtimeSchema();

  const merged = {
    type: "object",
    properties: { ...(schema.properties || {}) },
    additionalProperties: schema.additionalProperties ?? true
  };
  if (Array.isArray(schema.required) && schema.required.length) {
    merged.required = schema.required.filter((key) => merged.properties[key]);
  }

  const variants = [
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.allOf) ? schema.allOf : [])
  ];

  for (const variant of variants) {
    if (!variant || typeof variant !== "object") continue;
    if (variant.properties && typeof variant.properties === "object") {
      merged.properties = { ...merged.properties, ...variant.properties };
    }
    if (!merged.description && variant.description) merged.description = variant.description;
  }

  if (schema.type === "object" || variants.length || schema.properties) {
    if (schema.description) merged.description = schema.description;
    return sanitizeRealtimeSchemaNode(stripTopLevelUnsupportedSchemaKeys(merged), true);
  }

  return sanitizeRealtimeSchemaNode({
    type: "object",
    properties: {
      input: {
        type: "string",
        description: schema.description || "Free-form input for this Pika tool."
      }
    },
    additionalProperties: true
  }, true);
}

function stripTopLevelUnsupportedSchemaKeys(schema) {
  const { $schema, oneOf, anyOf, allOf, enum: enumValue, not, ...safeSchema } = schema;
  safeSchema.type = "object";
  safeSchema.properties = safeSchema.properties || {};
  return safeSchema;
}

function sanitizeRealtimeSchemaNode(node, isRoot = false) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return {};
  const blocked = new Set(["$schema", "oneOf", "anyOf", "allOf", "not"]);
  if (isRoot) blocked.add("enum");

  const clean = {};
  for (const [key, value] of Object.entries(node)) {
    if (blocked.has(key)) continue;
    if (key === "type") {
      clean.type = Array.isArray(value) ? value.find((item) => item && item !== "null") || "string" : value;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      clean.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [propertyName, sanitizeRealtimeSchemaNode(propertySchema)])
      );
      continue;
    }
    if (key === "items") {
      clean.items = Array.isArray(value)
        ? sanitizeTupleItems(value)
        : sanitizeRealtimeSchemaNode(value);
      continue;
    }
    if (key === "additionalProperties") {
      clean.additionalProperties = typeof value === "boolean" ? value : sanitizeRealtimeSchemaNode(value);
      continue;
    }
    clean[key] = value;
  }

  if (isRoot) {
    clean.type = "object";
    clean.properties = clean.properties || {};
  }
  if (Array.isArray(clean.required) && clean.properties) {
    clean.required = clean.required.filter((key) => clean.properties[key]);
  }
  return clean;
}

function sanitizeTupleItems(items) {
  const sanitized = items.map((item) => sanitizeRealtimeSchemaNode(item)).filter((item) => Object.keys(item).length);
  if (!sanitized.length) return {};
  const firstType = sanitized[0].type;
  if (firstType && sanitized.every((item) => item.type === firstType)) return sanitized[0];
  return { type: "string" };
}

function emptyRealtimeSchema() {
  return {
    type: "object",
    properties: {},
    additionalProperties: true
  };
}

function hasRealtimeUnsupportedSchemaShape(node, isRoot = true) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return true;
  if (isRoot && node.type !== "object") return true;
  if (isRoot && ["oneOf", "anyOf", "allOf", "enum", "not"].some((key) => key in node)) return true;
  if (Array.isArray(node.items)) return true;
  return Object.entries(node).some(([key, value]) => {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      return Object.values(value).some((child) => hasRealtimeUnsupportedSchemaShape(child, false));
    }
    if (key === "items" || key === "additionalProperties") return hasRealtimeUnsupportedSchemaShape(value, false);
    return false;
  });
}

function pikaRealtimeName(name) {
  return `pika_${name}`.replace(/[^\w.-]/g, "_");
}

async function listPikaTools() {
  if (cachedTools) return cachedTools;
  await ensureMcpInitialized();
  const result = await mcpRequest("tools/list", {});
  cachedTools = Array.isArray(result?.tools) ? result.tools : [];
  return cachedTools;
}

async function callPikaTool(name, args) {
  await ensureMcpInitialized();
  return mcpRequest("tools/call", { name, arguments: args });
}

async function loadPikaIdentity() {
  if (!pikaToken?.access_token) return {};
  if (cachedPikaIdentity) return cachedPikaIdentity;

  const [whoami, identity, soul, style, avatar] = await Promise.allSettled([
    callPikaTool("identity_whoami", {}),
    callPikaTool("identity_persona_read", { file: "identity" }),
    callPikaTool("identity_persona_read", { file: "soul" }),
    callPikaTool("identity_persona_read", { file: "style" }),
    callPikaTool("identity_avatar_url", {})
  ]);

  cachedPikaIdentity = {
    whoami: settledValue(whoami),
    identity: extractToolText(settledValue(identity)),
    soul: extractToolText(settledValue(soul)),
    style: extractToolText(settledValue(style)),
    avatarUrl: extractToolText(settledValue(avatar))
  };
  return cachedPikaIdentity;
}

function extractPikaDisplay(identity = {}) {
  const structured = identity.whoami?.structuredContent;
  if (structured && typeof structured === "object") {
    for (const key of ["agentName", "agent_name", "name", "display", "handle"]) {
      const value = structured[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return extractToolText(identity.whoami) || "";
}

function extractPikaAgentName(identity = {}) {
  const fromWhoami = extractPikaDisplay(identity);
  const fromIdentityFile = extractIdentityName(identity.identity);
  return fromIdentityFile || fromWhoami || "";
}

function extractIdentityName(text = "") {
  const source = String(text || "");
  if (!source.trim()) return "";

  const patterns = [
    /^\s*name\s*:\s*(.+)\s*$/im,
    /^\s*\*\*name\*\*\s*:\s*(.+)\s*$/im,
    /^\s*\*\*name:\*\*\s*(.+)\s*$/im,
    /^\s*[-*]\s*\*\*name\*\*\s*:\s*(.+)\s*$/im,
    /^\s*[-*]\s*\*\*name:\*\*\s*(.+)\s*$/im,
    /^\s*#\s+(.+?)\s*$/m
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      const candidate = sanitizeIdentityName(match[1]);
      if (isPlausibleAgentName(candidate)) return candidate;
    }
  }

  const firstMeaningfulLine = source
    .split("\n")
    .map((line) => line.trim())
    .map((line) => sanitizeIdentityName(line))
    .find((line) => isPlausibleAgentName(line));
  return firstMeaningfulLine || "";
}

function sanitizeIdentityName(value = "") {
  return String(value || "")
    .replace(/[`#*_>[\]]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/^[A-Z0-9_.-]+\.(md|txt|json|yaml|yml)$/i, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function isPlausibleAgentName(value = "") {
  const name = String(value || "").trim();
  if (!name) return false;
  if (/^[A-Z0-9_.-]+\.(md|txt|json|yaml|yml)$/i.test(name)) return false;
  if (/\b[a-z0-9_.-]+\.(md|txt|json|yaml|yml)\b/i.test(name)) return false;
  if (/^-{3,}$/.test(name)) return false;
  if (/^(identity|soul|style|persona|profile)$/i.test(name)) return false;
  if (name.length < 2) return false;
  return true;
}

function formatPikaIdentityPrompt(identity = {}) {
  const parts = [];
  const who = extractPikaDisplay(identity);
  if (who) parts.push(`Authenticated Pika account: ${who}`);
  if (identity.avatarUrl) parts.push(`Pika avatar URL: ${identity.avatarUrl}`);
  if (identity.identity) parts.push(`Pika IDENTITY.md:\n${truncate(identity.identity, 5000)}`);
  if (identity.soul) parts.push(`Pika SOUL.md:\n${truncate(identity.soul, 4500)}`);
  if (identity.style) parts.push(`Pika STYLE.md:\n${truncate(identity.style, 2500)}`);
  if (identity.warning) parts.push(`Pika identity warning: ${identity.warning}`);
  return parts.length ? parts.join("\n\n") : "";
}

function summarizePikaIdentity(identity = {}) {
  return {
    connected: Boolean(identity.whoami || identity.identity || identity.avatarUrl),
    display: extractPikaDisplay(identity),
    agentName: extractPikaAgentName(identity),
    avatarUrl: identity.avatarUrl || "",
    warning: identity.warning || ""
  };
}

function settledValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function extractToolText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.structuredContent?.content) return value.structuredContent.content;
  if (value.content?.[0]?.text) return value.content.map((item) => item.text || "").filter(Boolean).join("\n");
  return "";
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

async function askCodex({ question, context }) {
  const codexBin = process.env.CODEX_BIN || "/Applications/Codex.app/Contents/Resources/codex";
  const outFile = join("/private/tmp", `voice-stage-codex-${Date.now()}-${randomBytes(4).toString("hex")}.txt`);
  const prompt = [
    "You are being called from the Voice Stage app as a local Codex agent.",
    "Work in the shared workspace. Make code/file changes only when the user clearly asks for implementation.",
    "Keep the final response concise and useful for a voice agent to read back.",
    `User request:\n${question}`,
    context ? `Conversation context:\n${context}` : ""
  ].filter(Boolean).join("\n\n");

  const args = [
    "exec",
    "-C",
    root,
    "-s",
    "workspace-write",
    "--skip-git-repo-check",
    "-o",
    outFile,
    prompt
  ];

  const { stdout, stderr } = await runProcess(codexBin, args, 180000);
  let final = "";
  try {
    final = await readFile(outFile, "utf8");
  } catch {
    final = stdout || stderr || "Codex finished without a final message.";
  }

  return {
    kind: "codex",
    status: "ready",
    output: final.trim(),
    stdout: stdout.slice(-4000),
    stderr: stderr.slice(-2000)
  };
}

async function startGoogleOAuth(req, res) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return setupGoogleHtml(req, res);
  }

  const origin = `http://${req.headers.host}`;
  const redirectUri = `${origin}/api/google/oauth/callback`;
  const state = base64Url(randomBytes(32));
  googleAuthState = { state, redirectUri };

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

function setupGoogleHtml(req, res) {
  const redirectUri = `http://${req.headers.host}/api/google/oauth/callback`;
  res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
    <html>
      <head>
        <title>Set Up Google</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: #FCF7F0;
            color: #0D0D0D;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          main {
            width: min(720px, calc(100vw - 48px));
            padding: 44px;
            border-radius: 36px;
            background: #FFFFFF;
          }
          h1 { margin: 0 0 12px; font-size: 42px; line-height: 1; }
          p { color: rgba(13,13,13,.70); font-size: 18px; line-height: 1.45; }
          code {
            display: block;
            margin: 12px 0;
            padding: 14px 16px;
            border-radius: 16px;
            background: rgba(13,13,13,.04);
            color: #0D0D0D;
            overflow-wrap: anywhere;
          }
          a.button {
            display: inline-flex;
            margin-top: 12px;
            padding: 13px 18px;
            border-radius: 999px;
            background: #222222;
            color: #FFFFFF;
            text-decoration: none;
            font-weight: 700;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Set up Google</h1>
          <p>To send you to Google's authorization screen, Voice Stage first needs a Google OAuth web client.</p>
          <p>Add this authorized redirect URI in Google Cloud:</p>
          <code>${escapeHtml(redirectUri)}</code>
          <p>Then add these to your local <strong>.env</strong> and restart the server:</p>
          <code>GOOGLE_CLIENT_ID=your-client-id<br>GOOGLE_CLIENT_SECRET=your-client-secret</code>
          <a class="button" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Open Google credentials</a>
        </main>
      </body>
    </html>`);
}

async function finishGoogleOAuth(url, res) {
  if (url.searchParams.get("error")) {
    return html(res, `Google authorization failed: ${escapeHtml(url.searchParams.get("error_description") || url.searchParams.get("error"))}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !googleAuthState || state !== googleAuthState.state) {
    return html(res, "Google authorization state did not match. Please try Connect Google again.", 400);
  }

  const payload = await exchangeGoogleToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: googleAuthState.redirectUri
  });

  googleToken = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    token_type: payload.token_type,
    scope: payload.scope,
    expires_at: payload.expires_in ? Date.now() + payload.expires_in * 1000 : null
  };
  await saveGoogleToken();
  googleAuthState = null;
  return html(res, "Google connected. You can close this tab and refresh Voice Stage.");
}

async function exchangeGoogleToken(params) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    ...params
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${normalizeUpstreamError(payload.error || payload)}`);
  }
  return payload;
}

async function ensureGoogleAccessToken() {
  if (!googleToken?.access_token) throw new Error("Google is not connected.");
  const expiresAt = Number(googleToken.expires_at || 0);
  if (!expiresAt || expiresAt - Date.now() > 60000) return;
  if (!googleToken.refresh_token) throw new Error("Google access expired. Please reconnect Google.");

  const payload = await exchangeGoogleToken({
    grant_type: "refresh_token",
    refresh_token: googleToken.refresh_token
  });
  googleToken = {
    ...googleToken,
    access_token: payload.access_token || googleToken.access_token,
    token_type: payload.token_type || googleToken.token_type,
    scope: payload.scope || googleToken.scope,
    expires_at: payload.expires_in ? Date.now() + payload.expires_in * 1000 : googleToken.expires_at
  };
  await saveGoogleToken();
}

async function googleFetch(path, params = {}) {
  return googleRequest("GET", path, { params });
}

async function googleRequest(method, path, { params = {}, body } = {}) {
  await ensureGoogleAccessToken();
  const url = path.startsWith("http") ? new URL(path) : new URL(path, "https://www.googleapis.com");
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") url.searchParams.append(key, String(item));
      }
    } else if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${googleToken.access_token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google API failed: ${normalizeUpstreamError(payload.error || payload)}`);
  }
  return payload;
}

async function callGoogleTool(name, args = {}) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured on the server.");
  }
  if (name === "google_calendar_events") return googleCalendarEvents(args);
  if (name === "google_calendar_availability") return googleCalendarAvailability(args);
  if (name === "google_calendar_create_event") return googleCalendarCreateEvent(args);
  if (name === "google_gmail_recent") return googleGmailMessages(args);
  if (name === "google_gmail_search") return googleGmailMessages(args);
  if (name === "google_gmail_send") return googleGmailSend(args);
  if (name === "google_drive_search") return googleDriveSearch(args);
  throw new Error(`Unknown Google tool: ${name}`);
}

async function googleCalendarEvents({ timeMin, timeMax, maxResults = 20 } = {}) {
  const start = timeMin ? new Date(timeMin) : new Date();
  const end = timeMax ? new Date(timeMax) : new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const payload = await googleFetch("/calendar/v3/calendars/primary/events", {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: clampNumber(maxResults, 1, 50)
  });
  const events = (payload.items || []).map(summarizeCalendarEvent);
  return { kind: "google_calendar_events", timeMin: start.toISOString(), timeMax: end.toISOString(), events };
}

async function googleCalendarAvailability({ date, days = 1, workdayStart = "09:00", workdayEnd = "17:00" } = {}) {
  const dayCount = clampNumber(days, 1, 14);
  const base = parseDateOnly(date);
  const start = atLocalTime(base, workdayStart);
  const end = atLocalTime(addDays(base, dayCount - 1), workdayEnd);
  const eventsResult = await googleCalendarEvents({ timeMin: start.toISOString(), timeMax: end.toISOString(), maxResults: 100 });
  const byDay = [];
  for (let i = 0; i < dayCount; i += 1) {
    const day = addDays(base, i);
    const dayStart = atLocalTime(day, workdayStart);
    const dayEnd = atLocalTime(day, workdayEnd);
    const busy = eventsResult.events
      .map((event) => ({ start: new Date(event.start), end: new Date(event.end), summary: event.summary }))
      .filter((event) => event.end > dayStart && event.start < dayEnd)
      .sort((a, b) => a.start - b.start);
    byDay.push({
      date: isoDate(day),
      busy: busy.map((event) => ({ start: event.start.toISOString(), end: event.end.toISOString(), summary: event.summary })),
      free: computeFreeSlots(dayStart, dayEnd, busy)
    });
  }
  return { kind: "google_calendar_availability", days: byDay };
}

async function googleCalendarCreateEvent({ summary, description = "", location = "", start, end, attendees = [] } = {}) {
  const payload = await googleRequest("POST", "/calendar/v3/calendars/primary/events", {
    params: { sendUpdates: "all" },
    body: {
      summary,
      description,
      location,
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(end).toISOString() },
      attendees: attendees.map((email) => ({ email })).filter((item) => item.email)
    }
  });
  return {
    kind: "google_calendar_event_created",
    id: payload.id,
    summary: payload.summary,
    start: payload.start?.dateTime || payload.start?.date,
    end: payload.end?.dateTime || payload.end?.date,
    htmlLink: payload.htmlLink || ""
  };
}

async function googleGmailMessages({ query = "newer_than:14d", maxResults = 10 } = {}) {
  const list = await googleFetch("/gmail/v1/users/me/messages", {
    q: query,
    maxResults: clampNumber(maxResults, 1, 25)
  });
  const ids = (list.messages || []).slice(0, clampNumber(maxResults, 1, 25));
  const messages = await Promise.all(ids.map(async (item) => {
    const detail = await googleFetch(`/gmail/v1/users/me/messages/${item.id}`, {
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"]
    });
    const headers = Object.fromEntries((detail.payload?.headers || []).map((header) => [header.name.toLowerCase(), header.value]));
    return {
      id: detail.id,
      threadId: detail.threadId,
      from: headers.from || "",
      subject: headers.subject || "(no subject)",
      date: headers.date || "",
      snippet: detail.snippet || ""
    };
  }));
  return { kind: "google_gmail_messages", query, messages };
}

async function googleGmailSend({ to = [], cc = [], bcc = [], subject, body } = {}) {
  const raw = [
    `To: ${to.join(", ")}`,
    cc.length ? `Cc: ${cc.join(", ")}` : "",
    bcc.length ? `Bcc: ${bcc.join(", ")}` : "",
    `Subject: ${subject || ""}`,
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "",
    body || ""
  ].filter((line, index) => line || index > 4).join("\r\n");
  const payload = await googleRequest("POST", "/gmail/v1/users/me/messages/send", {
    body: { raw: base64Url(Buffer.from(raw, "utf8")) }
  });
  return {
    kind: "google_gmail_sent",
    id: payload.id,
    threadId: payload.threadId,
    to,
    subject
  };
}

async function googleDriveSearch({ query, maxResults = 10 } = {}) {
  const escaped = String(query || "").replaceAll("'", "\\'");
  const payload = await googleFetch("/drive/v3/files", {
    q: `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`,
    pageSize: clampNumber(maxResults, 1, 25),
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)"
  });
  return { kind: "google_drive_search", query, files: payload.files || [] };
}

function summarizeCalendarEvent(event) {
  return {
    id: event.id,
    summary: event.summary || "(busy)",
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    location: event.location || "",
    htmlLink: event.htmlLink || ""
  };
}

function computeFreeSlots(dayStart, dayEnd, busy) {
  const free = [];
  let cursor = new Date(dayStart);
  for (const event of busy) {
    const start = new Date(Math.max(event.start.getTime(), dayStart.getTime()));
    const end = new Date(Math.min(event.end.getTime(), dayEnd.getTime()));
    if (start > cursor) free.push({ start: cursor.toISOString(), end: start.toISOString() });
    if (end > cursor) cursor = end;
  }
  if (cursor < dayEnd) free.push({ start: cursor.toISOString(), end: dayEnd.toISOString() });
  return free;
}

function parseDateOnly(value) {
  const text = value || isoDate(new Date());
  const [year, month, day] = text.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function atLocalTime(day, time) {
  const [hour = 0, minute = 0] = String(time || "00:00").split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
}

function addDays(day, days) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

function isoDate(day) {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Codex task timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `Codex exited with code ${code}.`));
    });
  });
}

async function ensureMcpInitialized() {
  if (mcpInitialized) return;
  try {
    await ensurePikaAccessToken();
    await mcpRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "voice-stage-pika",
        version: "0.1.0"
      }
    });
    await mcpNotify("notifications/initialized", {});
    mcpInitialized = true;
  } catch (error) {
    throw new Error(`Pika MCP initialize failed: ${error.message}`);
  }
}

async function startPikaOAuth(req, res) {
  const origin = `http://${req.headers.host}`;
  const redirectUri = `${origin}/api/pika/oauth/callback`;
  const metadata = await getPikaOauthMetadata();
  const protectedResource = await fetchJsonRemote(PIKA_RESOURCE_METADATA_URL);
  const registration = await registerPikaOAuthClient(metadata.registration_endpoint, redirectUri);
  const verifier = base64Url(randomBytes(48));
  const state = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());

  pikaAuthState = {
    state,
    verifier,
    redirectUri,
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
    tokenEndpoint: metadata.token_endpoint
  };

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", registration.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("resource", protectedResource.resource || PIKA_MCP_URL);

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function finishPikaOAuth(url, res) {
  if (url.searchParams.get("error")) {
    return html(res, `Pika authorization failed: ${escapeHtml(url.searchParams.get("error_description") || url.searchParams.get("error"))}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !pikaAuthState || state !== pikaAuthState.state) {
    return html(res, "Pika authorization state did not match. Please try Connect Pika again.", 400);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: pikaAuthState.redirectUri,
    client_id: pikaAuthState.clientId,
    code_verifier: pikaAuthState.verifier
  });

  if (pikaAuthState.clientSecret) {
    body.set("client_secret", pikaAuthState.clientSecret);
  }

  const response = await fetch(pikaAuthState.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return html(res, `Pika token exchange failed: ${escapeHtml(normalizeUpstreamError(payload.error || payload))}`, response.status);
  }

  pikaToken = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    token_type: payload.token_type,
    expires_at: payload.expires_in ? Date.now() + payload.expires_in * 1000 : null,
    client_id: pikaAuthState.clientId,
    client_secret: pikaAuthState.clientSecret,
    token_endpoint: pikaAuthState.tokenEndpoint
  };
  await savePikaToken();
  pikaAuthState = null;
  cachedTools = null;
  cachedPikaIdentity = null;
  mcpInitialized = false;
  mcpSessionId = null;

  return html(res, "Pika connected. You can close this tab and refresh Voice Stage.");
}

async function ensurePikaAccessToken() {
  if (!pikaToken?.access_token) return;
  const expiresAt = Number(pikaToken.expires_at || 0);
  if (!expiresAt || expiresAt - Date.now() > 60000) return;
  await refreshPikaAccessToken();
}

async function refreshPikaAccessToken() {
  if (!pikaToken?.refresh_token) {
    clearPikaAuthCache();
    throw new Error("Pika access token expired. Please reconnect Pika.");
  }

  const metadata = await getPikaOauthMetadata();
  const tokenEndpoint = pikaToken.token_endpoint || metadata.token_endpoint;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: pikaToken.refresh_token
  });

  if (pikaToken.client_id) body.set("client_id", pikaToken.client_id);
  if (pikaToken.client_secret) body.set("client_secret", pikaToken.client_secret);

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    clearPikaAuthCache();
    throw new Error(`Pika token refresh failed: ${normalizeUpstreamError(payload.error || payload)}. Please reconnect Pika.`);
  }

  pikaToken = {
    ...pikaToken,
    access_token: payload.access_token || pikaToken.access_token,
    refresh_token: payload.refresh_token || pikaToken.refresh_token,
    token_type: payload.token_type || pikaToken.token_type,
    expires_at: payload.expires_in ? Date.now() + payload.expires_in * 1000 : pikaToken.expires_at,
    token_endpoint: tokenEndpoint
  };
  await savePikaToken();
  clearPikaAuthCache();
}

function clearPikaAuthCache() {
  cachedTools = null;
  cachedPikaIdentity = null;
  mcpInitialized = false;
  mcpSessionId = null;
}

async function savePikaToken() {
  await writeFile(pikaTokenPath, JSON.stringify(pikaToken, null, 2), { mode: 0o600 });
}

async function getPikaOauthMetadata() {
  if (pikaOauthMetadata) return pikaOauthMetadata;
  pikaOauthMetadata = await fetchJsonRemote(PIKA_AUTH_METADATA_URL);
  return pikaOauthMetadata;
}

async function registerPikaOAuthClient(registrationEndpoint, redirectUri) {
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Voice Stage Pika",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Pika OAuth client registration failed: ${normalizeUpstreamError(payload.error || payload)}`);
  }
  return payload;
}

async function mcpRequest(method, params) {
  await ensurePikaAccessToken();
  const response = await fetch(PIKA_MCP_URL, {
    method: "POST",
    headers: mcpHeaders({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: mcpId++,
      method,
      params
    })
  });

  const text = await response.text();
  mcpSessionId = response.headers.get("mcp-session-id") || mcpSessionId;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
  }

  const payload = parseMcpPayload(text);
  if (payload?.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error));
  }

  return payload?.result ?? payload;
}

async function mcpNotify(method, params) {
  await fetch(PIKA_MCP_URL, {
    method: "POST",
    headers: mcpHeaders({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    })
  });
}

function mcpHeaders(headers) {
  return {
    ...headers,
    ...(mcpSessionId ? { "Mcp-Session-Id": mcpSessionId } : {}),
    ...(pikaToken?.access_token ? { Authorization: `Bearer ${pikaToken.access_token}` } : {})
  };
}

async function fetchJsonRemote(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${normalizeUpstreamError(payload.error || payload)}`);
  return payload;
}

function parseMcpPayload(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  const messages = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (messages.length) {
    return (
      messages.find((message) => message.id !== undefined && (message.result !== undefined || message.error)) ||
      messages.find((message) => message.result !== undefined || message.error) ||
      messages.at(-1)
    );
  }

  throw new Error(`Unexpected MCP response: ${trimmed.slice(0, 160)}`);
}

async function serveStatic(pathname, res) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicRoot, safePath);

  if (!filePath.startsWith(publicRoot)) {
    return json(res, { error: "Forbidden." }, 403);
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(extname(filePath)) || "application/octet-stream"
    });
    res.end(file);
  } catch {
    json(res, { error: "Not found." }, 404);
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function html(res, message, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>Pika OAuth</title><style>body{font-family:system-ui;margin:48px;line-height:1.5;background:#FCF7F0;color:#0D0D0D}a{color:#222222;background:rgba(207,195,255,0.20);border-radius:999px;padding:8px 12px;text-decoration:none}</style></head><body><h1>${status === 200 ? "Connected" : "Could not connect"}</h1><p>${message}</p><p><a href="/">Return to Voice Stage</a></p></body></html>`);
}

async function readText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const text = await readText(req);
  return text ? JSON.parse(text) : {};
}

function loadDotEnv() {
  try {
    const fs = fileURLToPath(new URL(".env", import.meta.url));
    const contents = readFileSyncCompat(fs);
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!match || match[1].startsWith("#")) continue;
      if (process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional.
  }
}

function loadPikaToken() {
  try {
    return JSON.parse(readFileSync(pikaTokenPath, "utf8"));
  } catch {
    return null;
  }
}

function loadGoogleToken() {
  try {
    return JSON.parse(readFileSync(googleTokenPath, "utf8"));
  } catch {
    return null;
  }
}

async function saveGoogleToken() {
  await writeFile(googleTokenPath, JSON.stringify(googleToken, null, 2), { mode: 0o600 });
}

function hasUsablePikaToken() {
  if (!pikaToken?.access_token) return false;
  if (!pikaToken.expires_at || Number(pikaToken.expires_at) - Date.now() > 60000) return true;
  return Boolean(pikaToken.refresh_token && pikaToken.client_id);
}

function hasUsableGoogleToken() {
  if (!googleToken?.access_token) return false;
  if (!googleToken.expires_at || Number(googleToken.expires_at) - Date.now() > 60000) return true;
  return Boolean(googleToken.refresh_token);
}

function hasGoogleScopes() {
  if (!googleToken?.scope) return false;
  const granted = new Set(String(googleToken.scope).split(/\s+/).filter(Boolean));
  return GOOGLE_SCOPES
    .filter((scope) => scope.startsWith("https://www.googleapis.com/auth/"))
    .every((scope) => granted.has(scope));
}

function readFileSyncCompat(path) {
  return readFileSync(path, "utf8");
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
