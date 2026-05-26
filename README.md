<h1 align="center">Pika Experiments</h1>

<p align="center">
  <b>A public workshop of agent prototypes from Pika Labs.</b><br/>
  Exploring the possibilities of giving agents a face, a voice, and the power of the Pika MCP.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue" alt="License"></a>
  <a href="https://mcp.pika.me/api/mcp"><img src="https://img.shields.io/badge/MCP-mcp.pika.me-green" alt="Pika MCP"></a>
  <a href="https://github.com/Pika-Labs/Pika-Plugins"><img src="https://img.shields.io/badge/sibling-Pika--Plugins-purple" alt="Pika-Plugins"></a>
  <a href="https://github.com/Pika-Labs/Pika-Skills"><img src="https://img.shields.io/badge/sibling-Pika--Skills-orange" alt="Pika-Skills"></a>
</p>

<p align="center">
  <img src="./.github/assets/pika-experiments-teaser.png" alt="A metallic Pika logo wrapped in 'work in progress' caution tape on a dark developer desk surrounded by code-themed snack wrappers, a notebook with pseudocode, a laptop, and a coffee mug" width="100%"/>
</p>

> 🧪 These projects are intentionally rough around the edges. APIs evolve, demos break, folders may come and go. The polished, production-ready experience lives in [`Pika-Plugins`](https://github.com/Pika-Labs/Pika-Plugins) and [`Pika-Skills`](https://github.com/Pika-Labs/Pika-Skills). This is the sketchpad.

## What's in here

| Experiment | What it does | Stack |
|---|---|---|
| [`generative-ui/`](./generative-ui) | **Generative UI** — talk to an agent and watch it present its thinking, visually, in real time. Powered by OpenAI Realtime + Pika MCP. | Node 18+, browser, OpenAI Realtime, Pika MCP |

More experiments land as sibling folders. Each is **self-contained** — own README, own deps, own runtime. Clone the whole repo, run only what you want.

## Quickstart

```bash
git clone https://github.com/Pika-Labs/Pika-Experiments.git
cd Pika-Experiments/<experiment>
# follow that folder's README
```

You'll typically need a [Pika account](https://www.pika.me/) (most experiments OAuth into `mcp.pika.me`; some accept a `dk_*` key from [pika.me/dev](https://www.pika.me/dev/)), provider keys for whatever model the experiment uses, and Node 18+ or Python 3.10+ depending on the folder.

## Contributing an experiment

PRs that add a new top-level folder are welcome. Keep it simple:

1. **One folder, one experiment.** Short hyphenated name.
2. **Self-contained.** Runs from its own directory — no shared deps between folders.
3. **README is mandatory.** Pitch → prerequisites → setup → env vars table → how it works → troubleshooting. See [`generative-ui/README.md`](./generative-ui/README.md).
4. **No secrets, no PII.** Use `.env.example`. The root `.gitignore` already covers `.env`, `.pika-token.json`, `.google-token.json`.
5. **Apache 2.0 inherits** from the root LICENSE unless you ship a compatible one in your folder.
6. **Add a row** to the table above.

Agent-authored PRs: read [`AGENTS.md`](./AGENTS.md) first — it has the pre-push checklist and coordination rules.

## Security

Found a vulnerability? Email **support@pika.art** with subject line tagged `[security]`. Don't open a public issue. Full scope in [`SECURITY.md`](./SECURITY.md).

## License

Apache 2.0 — see [`LICENSE`](./LICENSE). Maintained by [Pika Labs](https://www.pika.me/).
