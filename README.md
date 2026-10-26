# AI Shell

Tell an AI what to do in plain words and watch it do it: open websites, click, type, read pages, run commands. The agent runs in your **GitHub Codespace** and thinks with a **Hugging Face model**: one hosted by Hugging Face, a GGUF model the app runs inside the Codespace, or a model server you point it at. The only thing that runs on your own computer is a small helper that opens a browser window the AI can use.

```text
 GitHub Codespace  (the brain)                      Your computer  (the hands)
┌───────────────────────────────────┐   private    ┌──────────────────────────────┐
│ AI Shell web app (this repo)      │  port-forward│ npm run bridge               │
│  ├─ prompt box, Run / Stop        │◄────────────►│  └─ Chromium window the AI   │
│  ├─ agent loop + safety rules     │              │     clicks, types and reads  │
│  ├─ asks a Hugging Face model     │              └──────────────────────────────┘
│  └─ shell (inside the Codespace)  │
└───────────────────────────────────┘
```

Same pattern as FlipLab's Browser Agent: nothing on your computer listens for connections; the helper only calls out to the Codespace.

## What you can ask for

Plain sentences. It works out the website, the steps and the time limit from what you write.

| You write | What happens |
| --- | --- |
| `On bbc.com/weather find London's forecast for tomorrow` | Opens the site, navigates, reads, reports back. |
| `Watch example.com/status for 20 minutes and tell me if anything changes` | Works for up to 20 minutes, re-checking with pauses in between. |
| `Check the price of the Pi 5 on raspberrypi.com every 10 minutes for an hour` | Reads the time limit (1 h) and the interval (10 min), waits between checks, reports what it saw. |
| `Check if the build page says "passing"` | One-off check, short answer. |
| `Run npm --version and ls in the workspace` | Runs commands in the Codespace's `workspace/` folder. |

On the screen:

- **Run** starts the task. **Stop** is always visible while it works.
- **Improve prompt** rewrites a rough idea into a clear task. You can edit it before pressing Run (Ctrl+Z undoes it).
- **Start at** and **Time limit** are optional fields. A time limit written in the prompt ("for 20 minutes") is picked up automatically; the field overrides it. The line under the prompt shows what it understood.
- The **Live browser** panel shows what the browser looks like after every step. **Activity** lists each thought, action and result.
- **Approve / Deny** buttons appear when the AI wants to do something risky (see Safety).

## Set it up

### 1. In the Codespace (the brain)

1. Open this repo in a Codespace. It installs and starts the app on port **3000** by itself. (Or run `npm install && npm start`.)
2. Get a Hugging Face access token at <https://huggingface.co/settings/tokens>, then either add it as a Codespaces secret named `HF_TOKEN`, or paste it in **Settings** in the app. Use **Test the model** to check it.
3. Keep port 3000 **Private** (the default). Anyone who can open it can run commands in your Codespace.

### 2. On your computer (the hands)

Open two terminals.

```bash
# Terminal 1: reach the private Codespace port from your computer
gh auth login
gh codespace ports forward 3000:3000 -R elsharuf107s-ux/ai-yt-channel-
```

```bash
# Terminal 2: the browser helper
git clone https://github.com/elsharuf107s-ux/ai-yt-channel-.git
cd ai-yt-channel-
npm install
npx playwright install chromium
npm run bridge
```

A Chromium window opens. The **Browser** chip in the app turns to *connected*. It uses its own profile (`~/.ai-shell/browser-profile`), so sites you sign in to in that window stay signed in, and your everyday browser is untouched. The AI never types passwords; if a site needs a login, sign in yourself in that window and run the task again.

Bridge options: `--server URL`, `--headless`, `--profile DIR`, `--chromium-path FILE` (use a system Chromium), `--cdp URL` (attach to a Chromium started with remote debugging), `--token SECRET`.

## Models

**Settings → Brain** offers four ways to give the agent a model:

| Brain | Where the model runs | Good for |
| --- | --- | --- |
| **Hugging Face API** (default) | Hugging Face's servers, called from the Codespace with your token | Strong models on any Codespace size |
| **Built-in model** | Inside the Codespace, run by llama.cpp from a GGUF file | Private, no per-token cost, e.g. the SC117 model below |
| **Model server** | A server you run (llama-server, Ollama, LM Studio, vLLM) at any address the Codespace can reach | Models too big for the Codespace |
| **Small local model** | Inside the Codespace via transformers.js | Trying things out; weak at multi-step tasks |

The AI replies in a simple JSON format rather than relying on a model's built-in tool calling, so almost any instruct model works with any of them. Reasoning written inside `<think>…</think>` is stripped before the reply is read.

### Built-in model: `SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF`

That repository is the default for the built-in model. The weights are far too big for git, so they live on the Codespace's disk (`models/`, git-ignored) and the app starts and stops llama.cpp's `llama-server` for you.

1. One-time setup in the Codespace terminal:

   ```bash
   npm run setup:llama                               # installs llama.cpp's llama-server into bin/
   curl -LsSf https://hf.co/cli/install.sh | bash    # the hf command, if you do not have it yet
   npm run setup:model -- --include "*Q4_K_M*"       # downloads ONE quantization into models/
   ```

   Pick the quantization that fits your RAM and disk. The command refuses to download every quantization by accident and resumes if interrupted. Use `hf download` rather than `git clone`: a clone keeps two copies of the weights. If you skip this step, llama.cpp downloads the model itself the first time you press Start.

2. In the app: **Settings → Brain → Built-in model → Save and start model**. The panel shows the machine's RAM and free disk, a status line (downloading / loading / ready), warnings and the llama.cpp log. Tasks run once it says *Ready*. **Stop model** frees the memory, and the app also stops it on shutdown.

Set `AI_SHELL_BACKEND=gguf` (for example as a Codespaces secret) to make it the default brain. Other knobs: `LLAMA_SERVER` (path to a llama-server of your own), `AI_SHELL_MODELS_DIR`, `AI_SHELL_MODEL_PORT`.

Before you try it:

- **Size.** The build environment could not open the SC117 repository (Hugging Face was blocked there), so its file names, sizes and licence are unconfirmed. Web search summaries describe the Qwen3.8-Flash-Next family as roughly 125B parameters with quantizations of about 70–110 GB, needing a recent llama.cpp. If that holds, a default Codespace (a few cores, 8–16 GB of RAM, about 32 GB of disk) cannot run it: you would need a much larger machine type, a smaller quantization, or the Model server option. Even then CPU-only generation is slow, and every agent step sends a page of text.
- **llama.cpp version.** The newest architectures can need a very recent llama.cpp. If the log says `unknown model architecture`, install a newer build and point `LLAMA_SERVER` at it.
- **Thinking** is off by default (faster and cheaper per step). Turn it on in Settings if you want the model to reason first.
- **Abliterated** means the model's own refusal behaviour has been removed. The approval rules in this app are enforced by the app, not the model, so they still apply, but the model will not decline instructions hidden in a web page by itself. Keep Safety on *Ask before risky actions*.

### Model server

Point **Server address** at any OpenAI-compatible endpoint, for example `http://HOST:8080/v1` for `llama-server -hf SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF --jinja`, or Ollama's `http://HOST:11434/v1`. The Codespace sends your prompts and page text to that address, so use one you trust that the Codespace can reach.

## Safety

The AI can click and run commands, so it is fenced in. **Settings → Safety** picks the level:

| Mode | Behaviour |
| --- | --- |
| **Ask before risky actions** (default) | Reading, searching, navigating and typing normal text run freely. Anything below pauses with Approve / Deny. |
| Ask before almost everything | Every action except looking, scrolling and waiting needs a click. |
| Never ask | No pauses. A wrong click could send, buy or delete things on your accounts. |

What counts as risky: shell commands (except a short read-only list like `ls`, `cat`, `git status`), opening addresses on your own or a private network, clicking buttons whose label looks like buy / pay / send / post / delete / subscribe / sign out, and typing into password or payment fields. A few catastrophic commands (`rm -rf /`, `mkfs`, `shutdown`, …) and non-web addresses (`file://`, `javascript:`) are refused in every mode.

Other protections:

- Web pages and command output are handed to the model as **untrusted data** with an instruction to ignore anything written inside them. Approval is the backstop if a page still manages to steer it.
- The Hugging Face token never reaches the model, the activity log or the shell: it is redacted from output and stripped from the environment of every command.
- The API rejects unknown Host names and any write without the app's own header, so another website open in your browser cannot drive the app. The page runs under a strict Content-Security-Policy.
- If a public page sends the browser to an address on your home or private network, the helper stops and backs out.
- Set `AI_SHELL_BRIDGE_TOKEN` in the Codespace and pass `--token` to the bridge if you want the helper to authenticate too.

## Limits to know about

- **Browser, not the whole desktop.** The AI controls the browser window the helper opens plus the Codespace shell. It does not click arbitrary desktop apps. (On a Chromebook the Linux container cannot see ChromeOS apps anyway.)
- The AI reads pages as text and numbered elements, with an optional screenshot for vision models. Content inside iframes, shadow DOM, canvas and games is mostly invisible to it.
- One task at a time. Task history lives in memory and is lost when the server restarts.
- Long watches need the Codespace to stay awake. Codespaces stop after an idle period (30 minutes by default): raise the idle timeout in your GitHub Codespaces settings and keep the app's browser tab open for long runs.
- The model decides what to click, so verify anything important. Treat results as a draft.
- The Hugging Face API connection was tested with stubbed responses, and the built-in model with a stand-in `llama-server` that speaks llama.cpp's HTTP API. Neither has been run against the live services or a real llama.cpp, so the first thing to do is press **Test the model** in Settings.

## Commands

```bash
npm start                  # the app (port 3000)
npm run dev                # restart on file changes
npm run bridge             # the browser helper, on your computer
npm run check              # syntax check
npm test                   # unit, API and real-browser end-to-end tests
npm run setup:llama        # install llama.cpp's llama-server for the built-in model
npm run setup:model -- --include "*Q4_K_M*"   # download one GGUF quantization
npm run setup:local-model  # optional: transformers.js model support
```

## Layout

```text
server.js              web app + API (guards, runs, settings, bridge endpoints)
lib/
  agent.js             the step loop: ask the model, check the rules, act, observe
  prompts.js           system prompt and how pages/command output are shown to the model
  tools.js             the actions the model can pick, and argument validation
  policy.js            safe / risky / blocked decisions and the three safety modes
  runs.js              one task at a time: events, approvals, Stop, time budget
  duration.js          "for 20 minutes" / "every 5 minutes" parsing (shared with the UI)
  shell.js             commands in the Codespace (timeouts, output caps, secret-free env)
  bridge-queue.js      hand-off between the agent and the browser helper
  browser-driver.js    what the helper does in Chromium (runs on your computer)
  config.js            saved settings, token masking
  redact.js            keeps secrets out of logs and prompts
  model-runner.js      starts/stops llama.cpp's llama-server for the built-in GGUF model
  llm/                 chat backends: Hugging Face API, built-in/server (OpenAI-compatible), transformers.js
scripts/local-bridge.js  the browser helper
scripts/setup-llama.js   installs llama-server; setup-model.js downloads a GGUF with the hf CLI
models/  bin/            downloaded weights and llama.cpp (git-ignored)
public/                the on-screen UI
test/                  unit, API and end-to-end tests
```
