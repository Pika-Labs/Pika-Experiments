const els = {
  statusPill: document.querySelector("#statusPill"),
  connectButton: document.querySelector("#connectButton"),
  stopButton: document.querySelector("#stopButton"),
  micButton: document.querySelector("#micButton"),
  auditList: document.querySelector("#auditList"),
  clearAudit: document.querySelector("#clearAudit"),
  transcript: document.querySelector("#transcript"),
  notesPanel: document.querySelector("#notesPanel"),
  closeNotes: document.querySelector("#closeNotes"),
  toggleTranscriptActivity: document.querySelector("#toggleTranscriptActivity"),
  scrim: document.querySelector("#scrim"),
  stage: document.querySelector("#stage"),
  speechLine: document.querySelector("#speechLine"),
  modelLine: document.querySelector("#modelLine"),
  remoteAudio: document.querySelector("#remoteAudio"),
  identityName: document.querySelector("#identityName"),
  profileAvatar: document.querySelector("#profileAvatar"),
  muteToggle: document.querySelector("#muteToggle"),
  chatComposer: document.querySelector("#chatComposer"),
  chatInput: document.querySelector("#chatInput"),
  referenceUpload: document.querySelector("#referenceUpload"),
  attachmentTray: document.querySelector("#attachmentTray"),
  appMenu: document.querySelector("#appMenu")
};
els.startupLoader = document.querySelector("#startupLoader");
els.connectPika = document.querySelector("#connectPika");
els.connectGoogle = document.querySelector("#connectGoogle");

let pc;
let dc;
let localStream;
let connected = false;
let autoStarted = false;
let stageRenderCount = 0;
let currentAssistantTextId = null;
let greetingFallbackTimer = null;
let aiLayoutFallbackTimer = null;
let activeWorkCount = 0;
let waitingForAiLayout = false;
let experienceRevealed = false;
let agentDisplayName = "Agent";
const pikaNames = new Map();
const pendingCalls = new Map();
const responseText = new Map();
const auditEntries = [];
let transcriptActivityVisible = false;
let assistantMuted = false;
let pendingAttachments = [];
let queuedMedia = emptyQueuedMedia();
let mediaFlushTimer = null;
let pendingSpeechLineText = "";
let pendingSpeechLineFinal = "";
let speechLineTimer = null;
let lastSpeechLineUpdateAt = 0;

init();

async function init() {
  els.connectButton.addEventListener("click", startSession);
  els.micButton.addEventListener("click", () => (connected ? stopSession() : startSession()));
  els.stopButton.addEventListener("click", stopSession);
  els.closeNotes.addEventListener("click", closeNotes);
  els.toggleTranscriptActivity.addEventListener("click", toggleTranscriptActivity);
  els.scrim.addEventListener("click", closeNotes);
  els.speechLine.addEventListener("click", openNotes);
  els.muteToggle.addEventListener("click", toggleAssistantMute);
  els.chatComposer.addEventListener("submit", sendTypedMessage);
  els.chatInput.addEventListener("input", resizeComposer);
  els.referenceUpload.addEventListener("change", handleReferenceFiles);
  window.addEventListener("focus", refreshIdentityFromConfig);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleGlobalKeydown);
  els.clearAudit.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.auditList.innerHTML = "";
  });

  try {
    const config = await fetchJson("/api/config");
    applyPikaIdentity(config.pikaIdentity);
    els.modelLine.textContent = `${config.realtimeModel} · ${config.pikaMcpUrl}`;
    if (config.hasPikaToken) {
      els.connectPika.textContent = "Pika Connected";
      els.connectPika.classList.add("connected");
    } else {
      els.connectPika.textContent = config.needsPikaReconnect ? "Reconnect Pika" : "Connect Pika";
      audit(config.needsPikaReconnect ? "Pika needs to be reconnected so it can refresh tokens." : "Pika is not connected yet. Use Connect Pika to authorize MCP tools.");
    }
    if (!config.hasGoogleConfig) {
      els.connectGoogle.textContent = "Set Up Google";
      els.connectGoogle.href = "/api/google/oauth/start";
      audit("Google needs an OAuth client ID and secret before it can redirect to Google's auth screen.");
    } else if (config.hasGoogleToken) {
      els.connectGoogle.textContent = "Google Connected";
      els.connectGoogle.classList.add("connected");
    } else {
      els.connectGoogle.textContent = config.needsGoogleReconnect ? "Reconnect Google" : "Connect Google";
      audit(config.needsGoogleReconnect ? "Google needs reconnecting for the expanded Workspace permissions." : "Google Suite is ready to connect from the menu.");
    }
    if (!config.hasOpenAIKey) {
      setStatus("Missing API key", "error");
      audit("Server needs OPENAI_API_KEY before voice can start.");
      revealExperience();
    } else {
      setAmbient("Connecting", "connecting");
      window.setTimeout(() => {
        if (!autoStarted && !connected) {
          autoStarted = true;
          startSession();
        }
      }, 450);
    }
  } catch (error) {
    els.modelLine.textContent = "Could not load server config.";
    audit(error.message);
    setAmbient("Error", "error");
    revealExperience();
  }
}

async function startSession() {
  if (connected) return;
  setAmbient("Connecting", "connecting");
  els.connectButton.disabled = true;

  try {
    audit("Starting microphone and WebRTC session.");
    const tokenPayload = await mintRealtimeToken();

    pc = new RTCPeerConnection();
    pc.addEventListener("connectionstatechange", () => {
      audit(`WebRTC connection: ${pc.connectionState}`);
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      audit(`ICE state: ${pc.iceConnectionState}`);
    });
    pc.ontrack = (event) => {
      els.remoteAudio.srcObject = event.streams[0];
      els.remoteAudio.muted = assistantMuted;
      els.remoteAudio.play().catch(() => {});
    };

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(localStream.getAudioTracks()[0], localStream);

    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("open", onDataChannelOpen);
    dc.addEventListener("message", onRealtimeMessage);
    dc.addEventListener("close", () => audit("Realtime data channel closed."));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const ephemeralKey = tokenPayload.value || tokenPayload.client_secret?.value;
    if (!ephemeralKey) {
      throw new Error("Realtime token response did not include a client secret.");
    }

    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp"
      },
      body: offer.sdp
    });

    if (!sdpResponse.ok) {
      const text = await sdpResponse.text();
      throw new Error(text);
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text()
    });

    connected = true;
    els.stopButton.disabled = false;
    els.micButton.classList.add("recording");
    setAmbient("Thinking", "thinking");
    audit("Voice session connected.");
  } catch (error) {
    audit(`Start failed: ${cleanError(error)}`);
    setStatus("Error", "error");
    setAmbient(cleanError(error), "error");
    revealExperience();
    stopSession({ preserveStatus: true });
  } finally {
    els.connectButton.disabled = connected;
  }
}

async function mintRealtimeToken() {
  audit("Minting short-lived Realtime client secret.");
  const payload = await fetchJson("/api/realtime/token", { method: "POST" });
  pikaNames.clear();
  for (const tool of payload.pikaTools || []) {
    pikaNames.set(tool.realtimeName, tool.originalName);
  }
  audit(`Registered ${pikaNames.size} Pika MCP tool${pikaNames.size === 1 ? "" : "s"} with Realtime.`);
  if (payload.pikaIdentity) {
    const assumedIdentity = payload.pikaIdentity.agentName || payload.pikaIdentity.display;
    if (assumedIdentity) audit(`Assuming Pika identity: ${assumedIdentity}`);
    applyPikaIdentity(payload.pikaIdentity);
  }
  if (payload.pikaWarning) {
    audit(`Pika warning: ${payload.pikaWarning}`);
  }
  return payload;
}

function onDataChannelOpen() {
  audit("Realtime event channel opened.");
  setAmbient("Thinking", "thinking");
  revealExperience();
  requestGreeting();
}

function revealExperience() {
  if (experienceRevealed) return;
  experienceRevealed = true;
  document.body.classList.remove("app-loading");
  document.body.classList.add("app-ready");
}

function onRealtimeMessage(event) {
  const message = JSON.parse(event.data);
  audit(compactEvent(message));

  const assistantDelta = extractAssistantDelta(message);
  if (assistantDelta) {
    setAmbient("Talking", "talking");
    const id = message.response_id || message.item_id || message.output_index || currentAssistantTextId || "assistant";
    currentAssistantTextId = id;
    responseText.set(id, (responseText.get(id) || "") + assistantDelta);
    updateAssistantMessage(id, responseText.get(id));
    queueSpeechLineUpdate(responseText.get(id));
    window.clearTimeout(greetingFallbackTimer);
  }

  const assistantDone = extractAssistantDoneText(message);
  if (assistantDone) {
    setAmbient("Talking", "talking");
    const id = message.response_id || message.item_id || currentAssistantTextId || "assistant";
    responseText.set(id, assistantDone);
    updateAssistantMessage(id, assistantDone);
    pendingSpeechLineFinal = assistantDone;
    queueSpeechLineUpdate(assistantDone);
    window.clearTimeout(greetingFallbackTimer);
  }

  if (message.type === "conversation.item.input_audio_transcription.completed") {
    addMessage("You", message.transcript);
    setAmbient("Thinking", "thinking");
  }

  if (message.type === "response.created") {
    currentAssistantTextId = message.response?.id || null;
    if (!activeWorkCount && !waitingForAiLayout) setAmbient("Thinking", "thinking");
  }

  if (message.type === "response.done") {
    if (hasQueuedMedia()) scheduleMediaFlush(450);
    if (!activeWorkCount && !waitingForAiLayout && !hasQueuedMedia()) setAmbient("Listening", "listening");
  }

  if (message.type === "output_audio_buffer.started" || message.type === "response.audio.delta") {
    setAmbient("Talking", "talking");
  }

  if (message.type === "output_audio_buffer.stopped") {
    if (pendingSpeechLineFinal) {
      const finalText = pendingSpeechLineFinal;
      pendingSpeechLineFinal = "";
      window.setTimeout(() => flushSpeechLineUpdate(finalText), 260);
    }
    if (!activeWorkCount && !waitingForAiLayout && !hasQueuedMedia()) setAmbient("Listening", "listening");
  }

  if (message.type === "response.output_item.done" && message.item?.type === "function_call") {
    handleFunctionCall(message.item);
  }

  if (message.type === "response.function_call_arguments.done") {
    const item = pendingCalls.get(message.call_id) || {};
    item.arguments = message.arguments;
    pendingCalls.set(message.call_id, item);
  }
}

async function handleFunctionCall(item) {
  const name = item.name;
  const args = safeJson(item.arguments || "{}");
  audit(`Calling tool: ${name}`);
  activeWorkCount += 1;
  setAmbient(friendlyToolLabel(name), "working");
  renderPendingStage(name, args);

  try {
    let result;
    let awaitingAiLayout = false;
    if (name === "stage_show_images") {
      clearQueuedMedia();
      clearAiLayoutFallback();
      waitingForAiLayout = false;
      result = await queueStageImages(args);
    } else if (name === "stage_render_html") {
      clearQueuedMedia();
      clearAiLayoutFallback();
      waitingForAiLayout = false;
      result = renderStageHtml(args);
    } else if (name === "ask_codex") {
      result = await fetchJson("/api/codex/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args)
      });
      renderToolResult(name, result);
    } else if (name.startsWith("google_")) {
      result = await fetchJson("/api/google/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, arguments: args })
      });
      if (shouldLetAiLayout(name, result)) {
        waitingForAiLayout = true;
        awaitingAiLayout = true;
        setAmbient("Arranging", "working");
      } else {
        renderGoogleResult(name, result);
      }
    } else {
      result = await fetchJson("/api/mcp/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pikaNames.get(name) || name, arguments: args })
      });
      if (shouldLetAiLayout(name, result)) {
        waitingForAiLayout = true;
        awaitingAiLayout = true;
        setAmbient("Arranging", "working");
      } else {
        renderToolResult(name, result);
      }
    }

    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify(result)
      }
    });
    sendEvent({ type: "response.create" });
    audit(`Tool completed: ${name}`);
    activeWorkCount = Math.max(0, activeWorkCount - 1);
    if (hasQueuedMedia()) {
      setAmbient("Arranging", "working");
      scheduleMediaFlush(900);
    } else if (!awaitingAiLayout && !waitingForAiLayout && activeWorkCount === 0) {
      setAmbient("Ready", "ready", 1400);
    }
  } catch (error) {
    const rawError = cleanError(error);
    const output = friendlyToolError(name, rawError);
    if (name.startsWith("google_")) renderGoogleError(name, output);
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify(output)
      }
    });
    sendEvent({ type: "response.create" });
    audit(`Tool failed: ${name} · ${rawError}`);
    activeWorkCount = Math.max(0, activeWorkCount - 1);
    waitingForAiLayout = false;
    els.stage.classList.remove("stage-working");
    setAmbient(errorStatusLabel(name, output.error), "error", 2600);
  }
}

function shouldLetAiLayout(name, result) {
  if (name.includes("task_status")) return false;
  if (name.startsWith("google_")) return !/create_event|gmail_send/i.test(name);
  const media = extractMediaUrls(result);
  return Boolean(media.images.length || media.videos.length || media.audio.length);
}

function scheduleAiLayoutFallback(fallback) {
  clearAiLayoutFallback();
  aiLayoutFallbackTimer = window.setTimeout(() => {
    audit("AI layout fallback used.");
    waitingForAiLayout = false;
    fallback?.();
    if (activeWorkCount === 0) setAmbient("Ready", "ready", 1400);
  }, 6500);
}

function clearAiLayoutFallback() {
  window.clearTimeout(aiLayoutFallbackTimer);
  aiLayoutFallbackTimer = null;
}

function renderPendingStage(name, args = {}) {
  const plan = pendingStagePlan(name, args);
  if (!plan) return;
  if (hasStableStageContent()) {
    els.stage.classList.add("stage-working");
    return;
  }

  transitionStage(`
    <div class="stage-content stage-content-pending">
      ${pendingAuraMarkup()}
    </div>
  `, { mode: "replace" });
}

function pendingAuraMarkup() {
  return `
    <div class="pending-aura" aria-hidden="true">
      <div class="pending-aura-core">
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
}

function hasStableStageContent() {
  const current = els.stage.querySelector(".stage-content:not(.stage-content-pending):not(.stage-exit)");
  return Boolean(current);
}

function pendingStagePlan(name, args = {}) {
  if (name === "stage_show_images") {
    const images = Array.isArray(args.images) ? args.images : [];
    return {
      kind: "image",
      count: clampCount(images.length || 1),
      label: "Making image",
      labels: images.map((image, index) => image.caption || image.prompt || `Image ${index + 1}`)
    };
  }

  if (name.includes("generate_image")) {
    return {
      kind: "image",
      count: clampCount(Number(args.n || args.count || 1)),
      label: "Making image",
      labels: Array.from({ length: clampCount(Number(args.n || args.count || 1)) }, (_, index) =>
        index === 0 ? "Making image" : `Making image ${index + 1}`
      )
    };
  }

  if (name.includes("generate_video") || name.includes("video_") || name.includes("_video")) {
    return { kind: "video", count: 1, label: "Making video" };
  }

  if (name.includes("generate_music")) {
    return { kind: "audio", count: 1, label: "Composing audio" };
  }

  if (name.includes("generate_speech")) {
    return { kind: "audio", count: 1, label: "Preparing voice" };
  }

  if (name === "stage_render_html") {
    return { kind: "work", count: 1, label: "Arranging view" };
  }

  if (name === "ask_codex") {
    return { kind: "work", count: 1, label: "Working with Codex" };
  }

  if (name.includes("task_status")) {
    return { kind: "work", count: 1, label: "Checking progress" };
  }

  return { kind: "work", count: 1, label: friendlyToolLabel(name) };
}

function clampCount(value) {
  const count = Number.isFinite(value) ? value : 1;
  return Math.max(1, Math.min(10, Math.round(count)));
}

function stopSession(options = {}) {
  connected = false;
  if (dc) dc.close();
  if (pc) pc.close();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  pc = null;
  dc = null;
  localStream = null;
  els.connectButton.disabled = false;
  els.stopButton.disabled = true;
  els.micButton.classList.remove("recording");
  if (!options.preserveStatus) {
    setStatus("Idle", "");
    setAmbient("Voice paused", "idle", 1400);
  }
}

function sendEvent(payload) {
  if (dc?.readyState === "open") {
    dc.send(JSON.stringify(payload));
  }
}

async function sendTypedMessage(event) {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text && !pendingAttachments.length) return;
  if (!connected || dc?.readyState !== "open") {
    audit("Text input needs an active realtime session.");
    setAmbient("Connecting", "connecting");
    if (!connected) await startSession();
    if (dc?.readyState !== "open") return;
  }

  const attachments = pendingAttachments;
  pendingAttachments = [];
  renderAttachmentTray();
  els.chatInput.value = "";
  resizeComposer();

  const userText = [
    text,
    attachments.length ? `References: ${attachments.map((file) => file.name).join(", ")}` : ""
  ].filter(Boolean).join("\n\n");
  addMessage("You", userText);

  const content = [];
  if (text) content.push({ type: "input_text", text });
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      content.push({ type: "input_image", image_url: attachment.dataUrl });
    } else {
      content.push({
        type: "input_text",
        text: `Reference file: ${attachment.name}\n${attachment.text || `[${attachment.type || "file"} uploaded for context]`}`
      });
    }
  }

  sendEvent({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content }
  });
  sendEvent({ type: "response.create" });
  setAmbient("Thinking", "thinking");
}

async function handleReferenceFiles(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  const loaded = await Promise.all(files.slice(0, 8).map(readReferenceFile));
  pendingAttachments.push(...loaded.filter(Boolean));
  renderAttachmentTray();
  event.target.value = "";
}

function readReferenceFile(file) {
  return new Promise((resolve) => {
    const isImage = file.type.startsWith("image/");
    const reader = new FileReader();
    reader.onerror = () => resolve({ name: file.name, type: file.type, kind: "file" });
    reader.onload = () => {
      if (isImage) {
        resolve({ name: file.name, type: file.type, kind: "image", dataUrl: reader.result });
      } else {
        resolve({
          name: file.name,
          type: file.type,
          kind: "file",
          text: String(reader.result || "").slice(0, 12000)
        });
      }
    };
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

function renderAttachmentTray() {
  els.attachmentTray.hidden = pendingAttachments.length === 0;
  els.attachmentTray.innerHTML = pendingAttachments
    .map((file, index) => `
      <button type="button" data-attachment-index="${index}">
        ${file.kind === "image" ? `<img src="${escapeAttr(file.dataUrl)}" alt="" />` : ""}
        <span>${escapeHtml(file.name)}</span>
        <b>×</b>
      </button>
    `)
    .join("");
  els.attachmentTray.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      pendingAttachments.splice(Number(button.dataset.attachmentIndex), 1);
      renderAttachmentTray();
    });
  });
}

function resizeComposer() {
  els.chatInput.style.height = "auto";
  els.chatInput.style.height = `${Math.min(180, Math.max(58, els.chatInput.scrollHeight))}px`;
}

function toggleAssistantMute() {
  assistantMuted = !assistantMuted;
  els.remoteAudio.muted = assistantMuted;
  els.muteToggle.setAttribute("aria-pressed", String(assistantMuted));
  refreshIdentityLabels();
  audit(assistantMuted ? `${agentDisplayName} audio muted.` : `${agentDisplayName} audio unmuted.`);
}

function requestGreeting() {
  els.speechLine.textContent = "";
  setAmbient("Thinking", "thinking");
  sendEvent({
    type: "response.create",
    response: {
      instructions: "Greet the user in one short natural sentence. Do not mention the stage, UI, tools, or connection state."
    }
  });
  window.clearTimeout(greetingFallbackTimer);
  greetingFallbackTimer = window.setTimeout(() => {
    if (!els.speechLine?.textContent?.trim()) {
      flushSpeechLineUpdate("I’m here with you.");
      setAmbient("Listening", "listening");
    }
  }, 2400);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatPayloadError(payload.error) || `HTTP ${response.status}`);
  return payload;
}

async function queueStageImages(args) {
  const resolved = await resolveImages(args);
  if (!resolved.length) {
    renderToolResult(args.title || "Stage image request", { error: "No displayable image URL was returned.", request: args });
    return { displayed: 0 };
  }
  queueResolvedImages(args.title || "Shown on stage", resolved);
  return { displayed: resolved.length };
}

async function resolveImages(args) {
  const images = Array.isArray(args.images) ? args.images : [];
  if (!images.length) return [];
  const resolved = [];

  for (const image of images) {
    if (isHttpUrl(image.url)) {
      resolved.push(image);
      continue;
    }

    const prompt = image.prompt || image.caption || image.url || args.title;
    if (!prompt) continue;
    audit(`Stage received a prompt instead of an image URL. Generating with Pika: ${prompt}`);
    setAmbient("Creating image", "working");
    const generated = await fetchJson("/api/mcp/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "generate_image",
        arguments: {
          prompt,
          aspect_ratio: "16:9",
          n: 1
        }
      })
    });
    const media = extractMediaUrls(generated);
    for (const url of media.images) {
      resolved.push({ url, caption: image.caption || prompt });
    }
  }

  return resolved;
}

function renderImages(args) {
  const resolved = Array.isArray(args.images) ? args.images : [];
  if (!resolved.length) return { displayed: 0 };
  addAssistantMediaMessage({
    title: args.title || "Shown on stage",
    images: resolved.map((image) => ({ url: image.url, caption: image.caption }))
  });

  transitionStage(`
    <div class="stage-content">
      <div class="stage-showcase image-count-${resolved.length}">
        ${resolved
          .map(
            (image) => `
              <figure class="image-card">
                <div class="media-slot">
                  <img src="${escapeAttr(image.url)}" alt="${escapeAttr(image.caption || "Generated image")}" />
                </div>
                ${image.caption ? `<figcaption>${escapeHtml(image.caption)}</figcaption>` : ""}
              </figure>
            `
          )
          .join("")}
      </div>
    </div>
  `, { mode: "replace" });

  setAmbient("Ready", "ready", 1200);
  return { displayed: resolved.length };
}

function queueResolvedImages(title, images) {
  queuedMedia.titles.add(title);
  images.forEach((image) => {
    if (!image?.url) return;
    queuedMedia.images.set(image.url, {
      url: image.url,
      caption: image.caption || ""
    });
  });
  setAmbient("Arranging", "working");
  scheduleMediaFlush(1600);
}

function renderStageHtml(args) {
  const safeHtml = stripUnsafeHtml(args.html || "");
  const playableHtml = enhanceStageMediaHtml(safeHtml);
  const safeCss = stripUnsafeCss(args.css || "");
  const scrollableStage = /\b(stage-scroll|vs-scroll|data-stage-scroll\s*=\s*["']?true["']?)\b/i.test(playableHtml);
  const inlineAssets = extractStageHtmlAssets(args.html || "");
  if (inlineAssets.images.length || inlineAssets.videos.length || inlineAssets.audio.length || inlineAssets.links.length) {
    addAssistantMediaMessage({
      title: args.title || "Stage result",
      images: inlineAssets.images,
      videos: inlineAssets.videos,
      audio: inlineAssets.audio,
      links: inlineAssets.links
    });
  }
  const stageRuntime = `
    <script>
      (() => {
        const playVideos = () => {
          document.querySelectorAll("video").forEach((video) => {
            video.autoplay = true;
            video.muted = false;
            video.defaultMuted = false;
            video.removeAttribute("muted");
            video.playsInline = true;
            video.preload = "auto";
            if (!video.hasAttribute("controls")) video.setAttribute("controls", "");
            video.play().catch(() => {});
          });
        };
        window.addEventListener("load", playVideos);
        document.addEventListener("DOMContentLoaded", playVideos);
        setTimeout(playVideos, 80);
        setTimeout(playVideos, 500);
      })();
    </script>`;
  const doc = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root {
            --bg: #f1ebf2;
            --card: #fffaf4;
            --ink: #171717;
            --muted: #77716b;
            --shadow: 0 34px 80px rgba(38, 31, 28, .22);
            --soft: 0 14px 36px rgba(38, 31, 28, .12);
          }
          html, body {
            margin: 0;
            width: 100%;
            min-height: 100%;
            background: transparent;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
            color: var(--ink);
            overflow: visible;
          }
          body {
            min-height: 100vh;
          }
          .stage-canvas {
            box-sizing: border-box;
            width: 100%;
            min-height: 100vh;
            padding: 52px 72px 210px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: visible;
          }
          .stage-canvas.stage-scroll {
            align-items: flex-start;
          }
          .stage-canvas > * {
            flex: 0 1 auto;
            max-width: min(1480px, calc(100vw - 144px));
            margin-inline: auto;
          }
          .stage-row { display: flex; align-items: center; justify-content: center; gap: 28px; width: 100%; background: transparent; box-shadow: none; border-radius: 0; }
          *, *::before, *::after { box-sizing: border-box; }
          figure {
            display: grid;
            gap: 10px;
            justify-items: center;
            margin: 0;
          }
          img,
          video,
          .stage-card img,
          figure.stage-card img,
          .stage-card video,
          figure.stage-card video {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: cover;
            border-radius: 34px;
            box-shadow: var(--shadow);
            overflow: hidden;
          }
          figure:has(img),
          figure:has(video),
          .stage-card:has(img),
          .stage-card:has(video),
          .media-card:has(img),
          .media-card:has(video) {
            background: transparent;
            box-shadow: none;
            padding: 0;
            overflow: visible;
          }
          .vs-board,
          .vs-fill,
          .vs-row,
          .vs-grid,
          .vs-dashboard,
          .vs-calendar-strip,
          .vs-timeline,
          .vs-storyboard,
          .vs-cluster {
            box-sizing: border-box;
            background: transparent;
            box-shadow: none;
            border-radius: 0;
            overflow: visible;
          }
          .vs-board,
          .vs-fill {
            width: min(1480px, 100%);
          }
          .vs-board {
            display: grid;
            gap: clamp(22px, 2.6vw, 42px);
            justify-items: center;
          }
          .vs-header {
            display: grid;
            gap: 10px;
            justify-items: center;
            max-width: 860px;
            margin: 0 auto;
            text-align: center;
            background: transparent;
            box-shadow: none;
          }
          .vs-eyebrow {
            margin: 0;
            color: rgba(13, 13, 13, .46);
            font-size: clamp(12px, .82vw, 15px);
            font-weight: 760;
          }
          .vs-title {
            margin: 0;
            color: var(--ink);
            font-size: clamp(36px, 4.6vw, 78px);
            line-height: .96;
            letter-spacing: 0;
          }
          .vs-subtitle,
          .vs-body {
            margin: 0;
            color: rgba(13, 13, 13, .58);
            font-size: clamp(17px, 1.4vw, 24px);
            line-height: 1.28;
          }
          .vs-grid,
          .vs-dashboard {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
            gap: clamp(16px, 1.8vw, 28px);
            width: min(1320px, 100%);
            align-items: stretch;
          }
          .vs-seven {
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          }
          .vs-row,
          .vs-directions,
          .vs-ad-variants,
          .vs-concepts {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: clamp(18px, 2.4vw, 38px);
            width: min(1400px, 100%);
            flex-wrap: wrap;
          }
          .vs-card,
          .vs-tile,
          .vs-object {
            box-sizing: border-box;
            display: grid;
            align-content: start;
            gap: 12px;
            min-width: 0;
            background: transparent;
            box-shadow: none;
            border-radius: 0;
            overflow: visible;
          }
          .vs-surface,
          .vs-hero-card,
          .vs-weather-tile,
          .vs-calendar-day,
          .vs-event,
          .vs-email,
          .vs-time-block,
          .vs-visual {
            box-sizing: border-box;
            display: grid;
            align-content: start;
            gap: 12px;
            min-height: 132px;
            padding: clamp(22px, 2.3vw, 36px);
            border-radius: clamp(26px, 2.6vw, 42px);
            background: #FFFFFF;
            color: var(--ink);
            box-shadow: var(--soft);
            overflow: visible;
          }
          .vs-card.vs-surface,
          .vs-tile.vs-surface,
          .vs-object.vs-surface {
            padding: clamp(22px, 2.3vw, 36px);
            border-radius: clamp(26px, 2.6vw, 42px);
            background: #FFFFFF;
            box-shadow: var(--soft);
          }
          .vs-hero-card {
            min-height: clamp(300px, 42vh, 560px);
            align-content: end;
            padding: clamp(32px, 4vw, 62px);
          }
          .vs-media-object,
          .vs-frame {
            display: grid;
            gap: 12px;
            justify-items: center;
            background: transparent;
            box-shadow: none;
            overflow: visible;
          }
          .vs-media-object img,
          .vs-media-object video,
          .vs-frame img,
          .vs-frame video {
            min-width: min(620px, 82vw);
            aspect-ratio: 16 / 10;
          }
          .vs-wide {
            grid-column: span 2;
          }
          .vs-tall {
            min-height: clamp(260px, 36vh, 520px);
          }
          .vs-tilt-left {
            transform: rotate(-2deg);
          }
          .vs-tilt-right {
            transform: rotate(2deg);
          }
          .vs-label,
          .vs-meta,
          .vs-chip {
            color: rgba(13, 13, 13, .48);
            font-size: clamp(13px, .92vw, 16px);
            font-weight: 680;
          }
          .vs-value,
          .vs-xl {
            margin: 0;
            color: var(--ink);
            font-size: clamp(42px, 6vw, 96px);
            font-weight: 860;
            line-height: .9;
            letter-spacing: 0;
          }
          .vs-card h2,
          .vs-card h3,
          .vs-tile h2,
          .vs-tile h3,
          .vs-object h2,
          .vs-object h3,
          .vs-surface h2,
          .vs-surface h3 {
            margin: 0;
            font-size: clamp(24px, 2.2vw, 40px);
            line-height: 1;
            letter-spacing: 0;
          }
          .vs-card p,
          .vs-tile p,
          .vs-object p,
          .vs-surface p,
          .vs-email p,
          .vs-event p {
            margin: 0;
            color: rgba(13, 13, 13, .56);
            font-size: clamp(15px, 1.1vw, 20px);
            line-height: 1.28;
          }
          .vs-calendar-strip,
          .vs-storyboard,
          .vs-timeline {
            display: flex;
            align-items: stretch;
            justify-content: center;
            gap: clamp(14px, 1.5vw, 24px);
            width: min(1420px, 100%);
            overflow-x: auto;
            padding: 22px 8px 34px;
          }
          .vs-calendar-day,
          .vs-time-block,
          .vs-event {
            min-width: clamp(190px, 14vw, 260px);
          }
          .vs-code {
            box-sizing: border-box;
            width: min(1100px, 100%);
            padding: clamp(22px, 2.4vw, 38px);
            border-radius: 34px;
            background: #0D0D0D;
            color: #FCFAF7;
            box-shadow: var(--shadow);
            font: 650 clamp(15px, 1.15vw, 20px) / 1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            overflow: auto;
          }
          .vs-chart-bars,
          .vs-sparkline {
            display: flex;
            align-items: end;
            gap: 8px;
            min-height: 76px;
          }
          .vs-chart-bars i,
          .vs-sparkline i {
            display: block;
            width: 100%;
            min-width: 10px;
            border-radius: 999px;
            background: #CFC3FF;
          }
          figcaption,
          .caption,
          .label,
          .stage-caption {
            display: block;
            margin: 0;
            padding: 0;
            background: transparent;
            box-shadow: none;
            border-radius: 0;
            color: rgba(23, 23, 23, .44);
            font-size: clamp(13px, 1vw, 17px);
            font-weight: 480;
            text-align: center;
          }
          .stage-canvas > .stage-card:not(:has(img)):not(:has(video)) { background: transparent; box-shadow: none; border-radius: 0; overflow: visible; }
          p { color: var(--muted); font-size: clamp(16px, 1.3vw, 22px); }
          .stage-title { font-size: clamp(34px, 5vw, 76px); line-height: 1; letter-spacing: 0; margin: 0; }
          .stage-caption { color: var(--muted); font-size: clamp(18px, 2vw, 28px); }
          .stage-pill { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 10px 16px; background: rgba(255,255,255,.72); box-shadow: var(--soft); }
          .floating { box-shadow: var(--shadow); border-radius: 34px; }
          .stage-row.floating, .stage-canvas.floating { box-shadow: none; background: transparent; border-radius: 0; }
          ${safeCss}
        </style>
      </head>
      <body><main class="stage-canvas${scrollableStage ? " stage-scroll" : ""}">${playableHtml}</main>${stageRuntime}</body>
    </html>`;

  transitionStage(`
    <div class="stage-content stage-content-html">
      <iframe class="stage-frame" sandbox="allow-scripts" srcdoc="${escapeAttr(doc)}" title="${escapeAttr(args.title || "Stage display")}"></iframe>
    </div>
  `, { mode: "replace" });
  setAmbient("Ready", "ready", 1200);
  return { displayed: true };
}

function renderToolResult(name, result) {
  if (result?.method === "notifications/message") {
    renderProgress(name, result.params?.data || "Working...");
    return;
  }

  const media = extractMediaUrls(result);
  if (media.images.length || media.videos.length || media.audio.length) {
    queueMediaResult(name, media, result);
    return;
  }

  const links = extractLinks(result);
  if (links.length) {
    addAssistantMediaMessage({ title: friendlyResultTitle(name), links });
  }

  if (shouldKeepAuraOnlyResult(name, result)) {
    ensureAuraStage();
    setAmbient(friendlyToolLabel(name), "working");
    return;
  }

  if (result?.error) {
    clearPendingStage();
    setAmbient(errorStatusLabel(name, result.error), "error", 2600);
    return;
  }

  clearPendingStage();
}

function shouldKeepAuraOnlyResult(name, result) {
  return name.startsWith("pika_") && !result?.error;
}

function ensureAuraStage() {
  if (els.stage.querySelector(".stage-content-pending .pending-aura")) return;
  transitionStage(`
    <div class="stage-content stage-content-pending">
      ${pendingAuraMarkup()}
    </div>
  `, { mode: "replace" });
}

function clearPendingStage() {
  els.stage.classList.remove("stage-working");
  const pending = els.stage.querySelector(".stage-content-pending");
  if (!pending) return;
  pending.classList.add("stage-exit");
  window.setTimeout(() => pending.remove(), 260);
  const stable = els.stage.querySelector(".stage-content:not(.stage-content-pending):not(.stage-exit)");
  if (!stable) els.stage.classList.remove("has-stage-content");
}

function queueMediaResult(name, media, result) {
  const links = extractLinks(result);
  queuedMedia.titles.add(friendlyResultTitle(name));
  media.images.forEach((url) => queuedMedia.images.set(url, { url, caption: "" }));
  media.videos.forEach((url) => queuedMedia.videos.add(url));
  media.audio.forEach((url) => queuedMedia.audio.add(url));
  links.forEach((link) => queuedMedia.links.set(link.url, link));
  setAmbient("Arranging", "working");
  scheduleMediaFlush(1600);
}

function scheduleMediaFlush(delay = 900) {
  window.clearTimeout(mediaFlushTimer);
  mediaFlushTimer = window.setTimeout(() => {
    if (activeWorkCount > 0) {
      scheduleMediaFlush(900);
      return;
    }
    flushQueuedMedia();
  }, delay);
}

function flushQueuedMedia() {
  window.clearTimeout(mediaFlushTimer);
  mediaFlushTimer = null;
  if (!hasQueuedMedia()) return;
  const batch = queuedMedia;
  queuedMedia = emptyQueuedMedia();
  const title = [...batch.titles][0] || "Done";
  const images = [...batch.images.values()];
  const videos = [...batch.videos];
  const audio = [...batch.audio];
  const links = [...batch.links.values()];

  if (images.length && !videos.length && !audio.length) {
    renderImages({ title, images });
    return;
  }

  if (videos.length || audio.length) {
    renderMedia({ title, videos, audio, result: { links, images } });
    if (images.length) addAssistantMediaMessage({ title, images });
    return;
  }

  if (links.length) addAssistantMediaMessage({ title, links });
}

function clearQueuedMedia() {
  window.clearTimeout(mediaFlushTimer);
  mediaFlushTimer = null;
  queuedMedia = emptyQueuedMedia();
}

function hasQueuedMedia() {
  return queuedMedia.images.size > 0 || queuedMedia.videos.size > 0 || queuedMedia.audio.size > 0 || queuedMedia.links.size > 0;
}

function emptyQueuedMedia() {
  return {
    images: new Map(),
    videos: new Set(),
    audio: new Set(),
    links: new Map(),
    titles: new Set()
  };
}

function friendlyResultTitle(name) {
  if (name.includes("generate_image")) return "Making image";
  if (name.includes("generate_video")) return "Making video";
  if (name.includes("generate_music")) return "Making music";
  if (name.includes("generate_speech")) return "Making voice";
  if (name.startsWith("pika_")) return "Working on it";
  if (name === "ask_codex") return "Codex update";
  return "Result";
}

function friendlyResultMessage(name, result) {
  if (name.startsWith("pika_")) return "I’m waiting on the final media. I’ll swap it in when it’s ready.";
  if (result?.error) return "Something needs attention. Check the logs for the technical detail.";
  return "Done.";
}

function renderGoogleResult(name, result) {
  const title = googleResultTitle(name, result);
  const items = googleResultItems(result);
  addAssistantMediaMessage({ title, links: googleResultLinks(result) });

  transitionStage(`
    <div class="stage-content">
      <section class="data-stage ${escapeAttr(result?.kind || name)}">
        <header>
          <p>${escapeHtml(googleResultEyebrow(name))}</p>
          <h2>${escapeHtml(title)}</h2>
        </header>
        <div class="data-grid">
          ${items.length ? items.map(renderGoogleDataItem).join("") : `<article class="data-item empty">Nothing found.</article>`}
        </div>
      </section>
    </div>
  `, { mode: "replace" });
  setAmbient("Ready", "ready", 1200);
}

function renderGoogleError(name, output) {
  const title = output.actionUrl ? "Enable Google API" : "Google needs attention";
  const detail = output.error || "Google could not complete that request.";
  transitionStage(`
    <div class="stage-content">
      <section class="data-stage google-error-stage">
        <header>
          <p>${escapeHtml(googleResultEyebrow(name))}</p>
          <h2>${escapeHtml(title)}</h2>
        </header>
        <div class="data-grid">
          <article class="data-item">
            <strong>${escapeHtml(detail)}</strong>
            ${output.actionUrl ? `<p>Enable it once, then ask again.</p><a class="data-action" href="${escapeAttr(output.actionUrl)}" target="_blank" rel="noreferrer">Open Google Cloud</a>` : ""}
          </article>
        </div>
      </section>
    </div>
  `, { mode: "replace" });
}

function googleResultTitle(name, result) {
  if (name.includes("availability")) return "Availability";
  if (name.includes("calendar")) return "Calendar";
  if (name.includes("gmail")) return "Gmail";
  if (name.includes("drive")) return "Drive";
  return result?.kind || "Google";
}

function googleResultEyebrow(name) {
  if (name.includes("availability") || name.includes("calendar")) return "Google Calendar";
  if (name.includes("gmail")) return "Google Mail";
  if (name.includes("drive")) return "Google Drive";
  return "Google Workspace";
}

function googleResultItems(result = {}) {
  if (result.kind === "google_calendar_event_created") {
    return [{
      title: result.summary || "Event created",
      meta: formatTimeRange(result.start, result.end),
      body: "Calendar invite sent.",
      href: result.htmlLink
    }];
  }
  if (result.kind === "google_gmail_sent") {
    return [{
      title: result.subject || "Email sent",
      meta: result.to?.join(", ") || "",
      body: "Sent from Gmail."
    }];
  }
  if (Array.isArray(result.days)) {
    return result.days.flatMap((day) => {
      const free = day.free?.length ? day.free : [];
      return free.map((slot) => ({
        title: formatTimeRange(slot.start, slot.end),
        meta: formatDate(day.date),
        body: "Free"
      }));
    });
  }
  if (Array.isArray(result.events)) {
    return result.events.map((event) => ({
      title: event.summary || "(busy)",
      meta: formatTimeRange(event.start, event.end),
      body: event.location || ""
    }));
  }
  if (Array.isArray(result.messages)) {
    return result.messages.map((message) => ({
      title: message.subject || "(no subject)",
      meta: message.from || message.date || "",
      body: message.snippet || ""
    }));
  }
  if (Array.isArray(result.files)) {
    return result.files.map((file) => ({
      title: file.name || "Untitled",
      meta: file.mimeType || "",
      body: file.modifiedTime ? `Modified ${formatDateTime(file.modifiedTime)}` : "",
      href: file.webViewLink
    }));
  }
  return [];
}

function renderGoogleDataItem(item) {
  const content = `
    <strong>${escapeHtml(item.title)}</strong>
    ${item.meta ? `<span>${escapeHtml(item.meta)}</span>` : ""}
    ${item.body ? `<p>${escapeHtml(item.body)}</p>` : ""}
  `;
  if (item.href) {
    return `<a class="data-item" href="${escapeAttr(item.href)}" target="_blank" rel="noreferrer">${content}</a>`;
  }
  return `<article class="data-item">${content}</article>`;
}

function googleResultLinks(result = {}) {
  if (Array.isArray(result.files)) return result.files.map((file) => file.webViewLink).filter(Boolean);
  if (Array.isArray(result.events)) return result.events.map((event) => event.htmlLink).filter(Boolean);
  return [];
}

function formatTimeRange(start, end) {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDate(value) {
  if (!value) return "";
  return new Date(`${value}T00:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderProgress(name, message) {
  setAmbient(message, "working");
}

function renderMedia({ title, videos = [], audio = [], result }) {
  addAssistantMediaMessage({ title, videos, audio, links: extractLinks(result) });
  transitionStage(`
    <div class="stage-content">
      <div class="media-stack">
        ${videos.map((url) => `<video src="${escapeAttr(url)}" autoplay controls playsinline preload="auto"></video>`).join("")}
        ${audio.map((url) => `<audio src="${escapeAttr(url)}" controls></audio>`).join("")}
      </div>
      <pre class="result-pre">${escapeHtml(JSON.stringify(result, null, 2))}</pre>
    </div>
  `, { mode: "replace" });
  setAmbient("Ready", "ready", 1200);
}

function transitionStage(html, options = {}) {
  els.stage.classList.remove("stage-working");
  const previous = els.stage.querySelector(".stage-content");
  const shell = document.createElement("div");
  shell.innerHTML = html.trim();
  const next = shell.firstElementChild;
  if (!next) return;

  stageRenderCount += 1;
  next.dataset.stageRender = String(stageRenderCount);
  next.classList.add("stage-enter");

  if (previous && options.mode === "replace") {
    previous.remove();
  } else if (previous) {
    previous.classList.add("stage-exit");
    window.setTimeout(() => previous.remove(), 260);
  } else {
    els.stage.querySelector(".empty-stage")?.classList.add("stage-exit");
    window.setTimeout(() => els.stage.querySelector(".empty-stage")?.remove(), 260);
  }

  els.stage.appendChild(next);
  [...els.stage.querySelectorAll(".stage-content")]
    .filter((node) => node !== next && !node.classList.contains("stage-exit"))
    .forEach((node) => node.remove());
  els.stage.classList.add("has-stage-content");
  ensureSpeechLine();
  requestAnimationFrame(() => {
    next.classList.add("stage-enter-active");
    autoplayStageVideos(next);
  });
}

function enhanceStageMediaHtml(html) {
  if (!html || !html.toLowerCase().includes("<video")) return html;
  const doc = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  doc.querySelectorAll("video").forEach((video) => {
    video.setAttribute("autoplay", "");
    video.removeAttribute("muted");
    video.setAttribute("playsinline", "");
    video.setAttribute("preload", "auto");
    if (!video.hasAttribute("controls")) video.setAttribute("controls", "");
  });
  return doc.body.firstElementChild?.innerHTML || html;
}

function autoplayStageVideos(root = els.stage) {
  const primeVideo = (video) => {
    video.autoplay = true;
    video.muted = false;
    video.defaultMuted = false;
    video.removeAttribute("muted");
    video.playsInline = true;
    video.preload = "auto";
    if (!video.hasAttribute("controls")) video.setAttribute("controls", "");
    const play = () => video.play().catch(() => {});
    if (video.readyState >= 2) play();
    video.addEventListener("loadeddata", play, { once: true });
    window.setTimeout(play, 80);
    window.setTimeout(play, 500);
  };

  root.querySelectorAll("video").forEach(primeVideo);
  root.querySelectorAll("iframe.stage-frame").forEach((frame) => {
    if (!frame.sandbox?.contains("allow-same-origin")) return;
    const primeFrame = () => {
      try {
        frame.contentDocument?.querySelectorAll("video").forEach(primeVideo);
      } catch {
        // Cross-origin sandboxed stage frames run their own tiny autoplay runtime.
      }
    };
    frame.addEventListener("load", primeFrame, { once: true });
    window.setTimeout(primeFrame, 80);
    window.setTimeout(primeFrame, 500);
  });
}

function ensureSpeechLine() {
  if (els.speechLine?.isConnected) {
    if (els.speechLine.parentElement !== els.stage) {
      els.stage.appendChild(els.speechLine);
    }
    return;
  }
  const line = document.createElement("p");
  line.className = "speech-line";
  line.id = "speechLine";
  line.textContent = "Here it is.";
  line.addEventListener("click", openNotes);
  els.stage.appendChild(line);
  els.speechLine = line;
}

function updateSpeechLine(text) {
  ensureSpeechLine();
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  const phrase = visibleSpeechPhrase(clean);
  if (els.speechLine.textContent === phrase) return;
  els.speechLine.textContent = phrase;
  els.speechLine.classList.remove("speech-refresh");
  void els.speechLine.offsetWidth;
  els.speechLine.classList.add("speech-refresh");
  lastSpeechLineUpdateAt = Date.now();
}

function queueSpeechLineUpdate(text) {
  pendingSpeechLineText = String(text || "");
  if (speechLineTimer) return;
  const elapsed = Date.now() - lastSpeechLineUpdateAt;
  const delay = Math.max(0, 920 - elapsed);
  speechLineTimer = window.setTimeout(() => {
    speechLineTimer = null;
    if (!pendingSpeechLineText) return;
    const nextText = pendingSpeechLineText;
    pendingSpeechLineText = "";
    updateSpeechLine(nextText);
  }, delay);
}

function flushSpeechLineUpdate(text) {
  window.clearTimeout(speechLineTimer);
  speechLineTimer = null;
  pendingSpeechLineText = "";
  updateSpeechLine(text);
}

function visibleSpeechPhrase(text) {
  const words = text.split(" ").filter(Boolean);
  const maxWords = els.stage.classList.contains("has-stage-content") ? 9 : 12;
  return words.slice(-maxWords).join(" ");
}

function extractAssistantDelta(message) {
  const deltaTypes = new Set([
    "response.audio_transcript.delta",
    "response.output_audio_transcript.delta",
    "response.text.delta",
    "response.output_text.delta",
    "response.content_part.delta"
  ]);
  if (!deltaTypes.has(message.type)) return "";
  if (typeof message.delta === "string") return message.delta;
  if (message.delta?.text) return message.delta.text;
  if (message.delta?.transcript) return message.delta.transcript;
  if (message.text) return message.text;
  if (message.transcript) return message.transcript;
  return "";
}

function extractAssistantDoneText(message) {
  const doneTypes = new Set([
    "response.audio_transcript.done",
    "response.output_audio_transcript.done",
    "response.text.done",
    "response.output_text.done"
  ]);
  if (doneTypes.has(message.type)) {
    return message.transcript || message.text || "";
  }
  if (message.type === "response.output_item.done") {
    return extractResponseItemText(message.item);
  }
  return "";
}

function extractResponseItemText(item) {
  if (!item?.content) return "";
  return item.content
    .map((part) => part.transcript || part.text || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function extractMediaUrls(value) {
  const media = { images: [], videos: [], audio: [] };
  const seen = new Set();
  const add = (kind, url) => {
    if (!seen.has(url)) {
      seen.add(url);
      media[kind].push(url);
    }
  };
  const classifyByKey = (key, text) => {
    if (!isHttpUrl(text)) return false;
    const lowerKey = String(key || "").toLowerCase();
    const lowerUrl = text.toLowerCase();
    if (/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(lowerUrl) || lowerKey.includes("image")) {
      add("images", text);
      return true;
    }
    if (/\.(mp4|mov|webm|m4v)(?:[?#]|$)/i.test(lowerUrl) || lowerKey.includes("video")) {
      add("videos", text);
      return true;
    }
    if (/\.(mp3|wav|m4a|aac|ogg)(?:[?#]|$)/i.test(lowerUrl) || lowerKey.includes("audio") || lowerKey.includes("music")) {
      add("audio", text);
      return true;
    }
    if (lowerKey === "url" || lowerKey.endsWith("url") || lowerKey === "urls") {
      add("images", text);
      return true;
    }
    return false;
  };

  const visit = (item, key = "") => {
    if (!item) return;
    if (typeof item === "string") {
      if (classifyByKey(key, item)) return;
      const images = item.match(/https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s"'<>]*)?/gi) || [];
      const videos = item.match(/https?:\/\/[^\s"'<>]+?\.(?:mp4|mov|webm|m4v)(?:\?[^\s"'<>]*)?/gi) || [];
      const audio = item.match(/https?:\/\/[^\s"'<>]+?\.(?:mp3|wav|m4a|aac|ogg)(?:\?[^\s"'<>]*)?/gi) || [];
      images.forEach((url) => add("images", url));
      videos.forEach((url) => add("videos", url));
      audio.forEach((url) => add("audio", url));
      return;
    }
    if (Array.isArray(item)) return item.forEach((child) => visit(child, key));
    if (typeof item === "object") {
      return Object.entries(item).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(value);
  return media;
}

function extractLinks(value) {
  const links = [];
  const seen = new Set();
  const add = (url, label = "") => {
    const clean = String(url || "").trim();
    if (!isHttpUrl(clean) || seen.has(clean)) return;
    seen.add(clean);
    links.push({ url: clean, label: label || clean.replace(/^https?:\/\//i, "").replace(/\/$/, "") });
  };
  const visit = (item, key = "") => {
    if (!item) return;
    if (typeof item === "string") {
      const urls = item.match(/https?:\/\/[^\s"'<>]+/gi) || [];
      urls.forEach((url) => add(url.replace(/[),.;]+$/, ""), key));
      return;
    }
    if (Array.isArray(item)) return item.forEach((child) => visit(child, key));
    if (typeof item === "object") return Object.entries(item).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(value);
  return links;
}

function extractStageHtmlAssets(html) {
  const assets = { images: [], videos: [], audio: [], links: [] };
  const seen = new Set();
  const addUrl = (kind, url, label = "") => {
    const clean = String(url || "").trim();
    if (!isHttpUrl(clean) || seen.has(`${kind}:${clean}`)) return;
    seen.add(`${kind}:${clean}`);
    if (kind === "images") assets.images.push({ url: clean, caption: label });
    else if (kind === "links") assets.links.push({ url: clean, label: label || clean.replace(/^https?:\/\//i, "").replace(/\/$/, "") });
    else assets[kind].push(clean);
  };

  const doc = new DOMParser().parseFromString(`<main>${html || ""}</main>`, "text/html");
  doc.querySelectorAll("img[src]").forEach((node) => addUrl("images", node.getAttribute("src"), node.getAttribute("alt") || node.closest("figure")?.querySelector("figcaption")?.textContent || ""));
  doc.querySelectorAll("video[src], video source[src]").forEach((node) => addUrl("videos", node.getAttribute("src")));
  doc.querySelectorAll("audio[src], audio source[src]").forEach((node) => addUrl("audio", node.getAttribute("src")));
  doc.querySelectorAll("a[href]").forEach((node) => addUrl("links", node.getAttribute("href"), node.textContent.trim()));

  const loose = extractMediaUrls(html);
  loose.images.forEach((url) => addUrl("images", url));
  loose.videos.forEach((url) => addUrl("videos", url));
  loose.audio.forEach((url) => addUrl("audio", url));
  extractLinks(html).forEach((link) => addUrl("links", link.url, link.label));
  return assets;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function stripUnsafeHtml(html) {
  return String(html || "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function stripUnsafeCss(css) {
  return String(css || "")
    .replace(/@import[^;]+;/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/expression\s*\(/gi, "");
}

function updateAssistantMessage(id, text) {
  let node = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!node) {
    node = document.createElement("div");
    node.className = "message from-ai";
    node.dataset.messageId = id;
    node.innerHTML = `<div class="bubble"><p></p></div><time>${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>`;
    els.transcript.prepend(node);
  }
  node.querySelector("p").textContent = text;
}

async function refreshIdentityFromConfig() {
  try {
    const config = await fetchJson("/api/config");
    applyPikaIdentity(config.pikaIdentity);
  } catch (error) {
    audit(`Could not refresh identity: ${cleanError(error)}`);
  }
}

function applyPikaIdentity(identity = {}) {
  const candidateName = identity.agentName || identity.display;
  const display = agentDisplayNameFromIdentity(candidateName);
  if (display) agentDisplayName = display;
  refreshIdentityLabels();

  if (identity.avatarUrl) {
    els.profileAvatar.style.backgroundImage = `url("${identity.avatarUrl}")`;
    els.profileAvatar.textContent = "";
  } else {
    els.profileAvatar.style.backgroundImage = "";
    els.profileAvatar.textContent = agentDisplayName.slice(0, 1).toUpperCase();
  }
}

function refreshIdentityLabels() {
  els.identityName.textContent = agentDisplayName;
  els.muteToggle.textContent = assistantMuted ? `Unmute ${agentDisplayName}` : `Mute ${agentDisplayName}`;
  els.chatInput.placeholder = `Type to ${agentDisplayName}...`;
}

function agentDisplayNameFromIdentity(name) {
  const cleaned = String(name || "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .slice(0, 3)
    .join(" ")
    .slice(0, 40);
}

function addMessage(role, text) {
  if (!text) return;
  const node = document.createElement("div");
  const isUser = /^you$/i.test(role);
  node.className = `message ${isUser ? "from-user" : "from-ai"}`;
  node.innerHTML = `<div class="bubble"><p>${escapeHtml(text)}</p></div><time>${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>`;
  els.transcript.prepend(node);
}

function addAssistantMediaMessage({ title = "Stage result", images = [], videos = [], audio = [], links = [] }) {
  const imageItems = images
    .map((image) => (typeof image === "string" ? { url: image } : image))
    .filter((image) => isHttpUrl(image.url));
  const videoItems = videos.filter(isHttpUrl);
  const audioItems = audio.filter(isHttpUrl);
  const mediaUrls = new Set([...imageItems.map((image) => image.url), ...videoItems, ...audioItems]);
  const linkItems = links
    .filter((link) => isHttpUrl(link.url || link) && !mediaUrls.has(link.url || link))
    .map((link) => (typeof link === "string" ? { url: link } : link));
  if (!imageItems.length && !videoItems.length && !audioItems.length && !linkItems.length) return;

  const node = document.createElement("div");
  node.className = "message from-ai media-message";
  node.innerHTML = `
    <div class="bubble media-bubble">
      <p class="media-title">${escapeHtml(title)}</p>
      ${imageItems.length ? `<div class="chat-media-grid">${imageItems.map((image) => `
        <figure>
          <img src="${escapeAttr(image.url)}" alt="${escapeAttr(image.caption || "Generated image")}" />
          ${image.caption ? `<figcaption>${escapeHtml(image.caption)}</figcaption>` : ""}
        </figure>
      `).join("")}</div>` : ""}
      ${videoItems.map((url) => `<video src="${escapeAttr(url)}" controls playsinline preload="metadata"></video>`).join("")}
      ${audioItems.map((url) => `<audio src="${escapeAttr(url)}" controls></audio>`).join("")}
      ${linkItems.length ? `<div class="chat-links">${linkItems.map((link) => `
        <a href="${escapeAttr(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label || link.url)}</a>
      `).join("")}</div>` : ""}
    </div>
    <time>${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
  `;
  els.transcript.prepend(node);
}

function audit(text) {
  const entry = { text, time: new Date() };
  auditEntries.unshift(entry);
  const item = document.createElement("li");
  item.innerHTML = `<time>${entry.time.toLocaleTimeString()}</time><p>${escapeHtml(text)}</p>`;
  els.auditList.prepend(item);
  if (transcriptActivityVisible) addActivityMessage(entry);
}

function toggleTranscriptActivity() {
  const enabled = !transcriptActivityVisible;
  transcriptActivityVisible = enabled;
  els.toggleTranscriptActivity.textContent = enabled ? "Hide Logs" : "Show Logs";
  els.toggleTranscriptActivity.setAttribute("aria-pressed", String(enabled));
  els.transcript.querySelectorAll(".activity-message").forEach((node) => node.remove());
  if (enabled) {
    auditEntries.slice(0, 40).reverse().forEach(addActivityMessage);
  }
}

function addActivityMessage(entry) {
  const node = document.createElement("div");
  node.className = "message from-ai activity-message";
  node.innerHTML = `
    <div class="bubble activity-bubble">
      <time>${entry.time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>
      <p>${escapeHtml(entry.text)}</p>
    </div>
  `;
  els.transcript.prepend(node);
}

function handleDocumentClick(event) {
  if (els.appMenu?.open && !els.appMenu.contains(event.target)) {
    els.appMenu.open = false;
  }
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape" && els.appMenu?.open) {
    els.appMenu.open = false;
  }
}

function openNotes() {
  els.notesPanel.classList.add("open");
  els.notesPanel.setAttribute("aria-hidden", "false");
  els.scrim.hidden = false;
  requestAnimationFrame(() => els.scrim.classList.add("open"));
}

function closeNotes() {
  els.notesPanel.classList.remove("open");
  els.notesPanel.setAttribute("aria-hidden", "true");
  els.scrim.classList.remove("open");
  window.setTimeout(() => {
    if (!els.scrim.classList.contains("open")) els.scrim.hidden = true;
  }, 220);
}

function setAmbient(text, mode = "", timeout = 0) {
  window.clearTimeout(setAmbient.timer);
  setStatus(text, mode);

  if (timeout) {
    setAmbient.timer = window.setTimeout(() => {
      if (mode === "ready" || mode === "idle" || mode === "listening") {
        setStatus(connected ? "Listening" : "Idle", connected ? "listening" : "idle");
      }
    }, timeout);
  }
}

function friendlyToolLabel(name) {
  if (name.includes("google_calendar_create_event")) return "Scheduling";
  if (name.includes("google_calendar_availability")) return "Checking availability";
  if (name.includes("google_calendar")) return "Checking calendar";
  if (name.includes("google_gmail_send")) return "Sending email";
  if (name.includes("google_gmail")) return "Checking mail";
  if (name.includes("google_drive")) return "Searching Drive";
  if (name.includes("generate_image")) return "Creating image";
  if (name.includes("generate_video")) return "Creating video";
  if (name.includes("generate_music")) return "Composing";
  if (name.includes("generate_speech")) return "Preparing voice";
  if (name === "ask_codex") return "Working with Codex";
  if (name === "stage_render_html") return "Arranging";
  if (name === "stage_show_images") return "Arranging";
  return "Working";
}

function friendlyToolError(name, rawError) {
  const actionUrl = extractFirstUrl(rawError);
  if (name.includes("google_calendar") && /disabled|not been used/i.test(rawError)) {
    return { error: "Calendar API is off for this app.", actionUrl };
  }
  if (name.includes("google_gmail") && /disabled|not been used/i.test(rawError)) {
    return { error: "Gmail API is off for this app.", actionUrl };
  }
  if (name.includes("google_drive") && /disabled|not been used/i.test(rawError)) {
    return { error: "Drive API is off for this app.", actionUrl };
  }
  if (name.startsWith("google_") && /not connected/i.test(rawError)) {
    return { error: "Google needs to be connected from the menu." };
  }
  return { error: rawError };
}

function errorStatusLabel(name, error) {
  if (name.includes("google_calendar") && /API is off/i.test(error)) return "Enable Calendar API";
  if (name.includes("google_gmail") && /API is off/i.test(error)) return "Enable Gmail API";
  if (name.includes("google_drive") && /API is off/i.test(error)) return "Enable Drive API";
  if (name.startsWith("google_")) return "Google setup";
  return "Error";
}

function extractFirstUrl(text) {
  return String(text || "").match(/https?:\/\/[^\s]+/)?.[0] || "";
}

function compactEvent(message) {
  if (message.type?.includes("delta")) return message.type;
  if (message.type === "error") return `Realtime error: ${message.error?.message || "Unknown"}`;
  return message.type || "Realtime event";
}

function setStatus(text, mode) {
  els.statusPill.className = `connection-pill ${mode || ""}`.trim();
  document.body.classList.toggle("is-working", mode === "working");
  els.statusPill.querySelector("strong").textContent = text;
  els.statusPill.classList.remove("status-pop");
  void els.statusPill.offsetWidth;
  els.statusPill.classList.add("status-pop");
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function cleanError(error) {
  return formatPayloadError(error?.message || error).slice(0, 500);
}

function formatPayloadError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll("`", "&#096;");
}
