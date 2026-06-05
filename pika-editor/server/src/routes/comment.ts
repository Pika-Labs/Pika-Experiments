/**
 * Comments — the user↔agent feedback channel.
 *
 * Two kinds:
 *   • Clip comments — attached to a specific clip, live under `clip.comments[]`
 *   • Floating comments — live on the timeline at a master-time `at`, optionally
 *     bound to a ghost-clip placeholder via `ghostClipId`
 *
 * Source of truth: `timeline.json`. (The old PikaCut `comments.md` flow is
 * deprecated — all comment state lives in the timeline schema now.) Endpoints
 * mutate the JSON in place, validate, and broadcast `timeline-changed` so
 * connected clients refresh.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readTimeline, writeTimeline } from '../state.js';
import { TimelineSchema, type Timeline } from '../schema.js';
import { events } from '../events.js';

const PostBody = z.object({
  // Either clipId (attaches to clip) or no clipId (floating timeline note)
  clipId: z.string().optional(),
  trackId: z.string().default('v1'),
  at: z.number(),
  note: z.string(),
  author: z.enum(['user', 'agent']).default('user'),
  ghostClipId: z.string().nullable().optional(),
});

const PatchBody = z.object({
  note: z.string().optional(),
  resolved: z.boolean().optional(),
  agentReply: z.string().nullable().optional(),
});

function nextCommentId(): string {
  return `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  // GET /comments — flat list of every comment (clip + floating) for the UI.
  app.get('/comments', async () => {
    const { timeline } = readTimeline();
    const out: any[] = [];
    for (const tr of timeline.tracks) {
      for (const c of tr.clips) {
        for (const cm of (c.comments ?? [])) {
          out.push({ ...cm, clipId: c.id, trackId: tr.id, kind: 'clip' });
        }
      }
    }
    for (const fc of timeline.floatingComments ?? []) {
      out.push({ ...fc, kind: 'floating' });
    }
    return { comments: out };
  });

  // POST /comments — add a clip-comment OR floating comment.
  app.post('/comments', async (req, reply) => {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const { clipId, trackId, at, note, author, ghostClipId } = parsed.data;
    const { timeline } = readTimeline();
    const id = nextCommentId();
    let next: Timeline;
    if (clipId) {
      // Attach to clip
      const found = timeline.tracks.some((tr) => tr.clips.some((c) => c.id === clipId));
      if (!found) { reply.code(404); return { error: `clip not found: ${clipId}` }; }
      next = {
        ...timeline,
        tracks: timeline.tracks.map((tr) => ({
          ...tr,
          clips: tr.clips.map((c) => c.id === clipId
            ? { ...c, comments: [...(c.comments ?? []), { id, at, note, author, resolved: false, resolvedAt: null, agentReply: null }] }
            : c),
        })),
      };
    } else {
      // Floating
      next = {
        ...timeline,
        floatingComments: [
          ...(timeline.floatingComments ?? []),
          { id, at, trackId, note, author, resolved: false, resolvedAt: null, agentReply: null, ghostClipId: ghostClipId ?? null },
        ],
      };
    }
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true, id };
  });

  // PATCH /comments/:id — update (resolve, set agentReply, edit note).
  app.patch<{ Params: { id: string } }>('/comments/:id', async (req, reply) => {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'validation', issues: parsed.error.issues }; }
    const patch = parsed.data;
    const { timeline } = readTimeline();
    const id = req.params.id;
    const nowIso = new Date().toISOString();
    let touched = false;
    const apply = (cm: any) => {
      if (cm.id !== id) return cm;
      touched = true;
      const merged: any = { ...cm };
      if (patch.note !== undefined) merged.note = patch.note;
      if (patch.agentReply !== undefined) merged.agentReply = patch.agentReply;
      if (patch.resolved !== undefined) {
        merged.resolved = patch.resolved;
        merged.resolvedAt = patch.resolved ? nowIso : null;
      }
      return merged;
    };
    const next: Timeline = {
      ...timeline,
      tracks: timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => ({ ...c, comments: (c.comments ?? []).map(apply) })),
      })),
      floatingComments: (timeline.floatingComments ?? []).map(apply),
    };
    if (!touched) { reply.code(404); return { error: `comment not found: ${id}` }; }
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true };
  });

  // DELETE /comments/:id — permanently remove.
  app.delete<{ Params: { id: string } }>('/comments/:id', async (req, reply) => {
    const { timeline } = readTimeline();
    const id = req.params.id;
    let touched = false;
    const filterFn = (cm: any) => {
      if (cm.id !== id) return true;
      touched = true; return false;
    };
    const next: Timeline = {
      ...timeline,
      tracks: timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => ({ ...c, comments: (c.comments ?? []).filter(filterFn) })),
      })),
      floatingComments: (timeline.floatingComments ?? []).filter(filterFn),
    };
    if (!touched) { reply.code(404); return { error: `comment not found: ${id}` }; }
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true };
  });

  // Bulk-remove every resolved comment (clip + floating).
  app.post('/comments/clear-resolved', async () => {
    const { timeline } = readTimeline();
    const keepUnresolved = (cm: any) => !cm.resolved;
    let removed = 0;
    const count = (cm: any) => { if (cm.resolved) removed++; return true; };
    timeline.tracks.forEach((tr) => tr.clips.forEach((c) => (c.comments ?? []).forEach(count)));
    (timeline.floatingComments ?? []).forEach(count);
    const next: Timeline = {
      ...timeline,
      tracks: timeline.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => ({ ...c, comments: (c.comments ?? []).filter(keepUnresolved) })),
      })),
      floatingComments: (timeline.floatingComments ?? []).filter(keepUnresolved),
    };
    const { sha } = await writeTimeline(TimelineSchema.parse(next));
    events.broadcast({ type: 'timeline-changed', sha });
    return { ok: true, removed };
  });
}
