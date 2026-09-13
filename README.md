# Llama Admin Monitor

Web dashboard for managing and monitoring [llama.cpp](https://github.com/ggerganov/llama.cpp) servers — with model management, Hugging Face downloads, multi-GPU VRAM visualisation, and automated tensor-split benchmarking.

This is a fork of [arte-fact/llama-monitor](https://github.com/arte-fact/llama-monitor), extended from a monitoring dashboard into a full admin interface. See [Fork additions](#fork-additions) for what's new.

## Features

### Monitoring
- **Real-time GPU monitoring** — temperature, load, VRAM, power, and clock speeds across AMD, NVIDIA, and Intel cards simultaneously
- **VRAM usage bar** — a single segmented bar showing how the loaded model is distributed, coloured per vendor (AMD red, NVIDIA green, Intel blue) with an estimated context/KV segment and free space, labelled in GB
- **Inference metrics** — prompt/generation speed, KV cache usage, and slot status via llama-server's Prometheus endpoint
- **Server logs** — live stderr output from the running server

### Server management
- **Presets** — create, edit, copy, and delete configurations covering every llama.cpp parameter; persisted to disk
- **Start/stop toggle** — one button that reflects live server state, plus a direct link to llama-server's own web UI while running
- **Failure detection** — if llama-server exits on its own (a model that won't fit, a bad flag), the dashboard notices, resets to a stopped state, and surfaces the error rather than silently claiming the server is up

### Model management
- **Models tab** — every `.gguf` in your models directory, with quantisation type, size, source repo, download date, and the repo's last-updated date on Hugging Face
- **Hugging Face downloads** — search repos, browse their `.gguf` files with sizes, and download to your models directory with a live progress bar; downloads continue in the background if you close the dialog
- **Fits VRAM?** — each model (and each file on Hugging Face, before you download it) is checked against your combined VRAM so you can tell at a glance whether a given quant will run
- **Delete** — remove models from disk without leaving the dashboard

### Optimisation
- **Benchmark tab** — sweeps a list of tensor-split ratios through `llama-bench`, reports prompt and generation throughput for each, marks the fastest, and applies the winner to a preset in one click
- **Cancellable** — stop a running sweep at any point; results collected so far are kept

### Other
- **Integrated chat** — streaming chat UI with reasoning/thinking block support, proxied to the configured port
- **File browser** — pick binaries, directories, and models from the filesystem
- **Persistent settings** — preset, port, paths, and models directory survive reloads and restarts
- **PWA support** — installable as a standalone app on mobile and desktop

## Supported hardware

| Vendor | Metrics | Detection |
|--------|---------|-----------|
| AMD | `rocm-smi` | `rocminfo` |
| NVIDIA | `nvidia-smi` | `nvidia-smi` |
| Intel | `xpu-smi` | — |

Multiple vendors are monitored at once — a machine with both an AMD and an NVIDIA card reports all GPUs in one table. Override detection with `--gpu-backend rocm|nvidia|none`.

**RDNA 4 note:** `gfx1201` (RX 9070 / 9070 XT / 9070 GRE) requires ROCm 7.2 or newer for `rocminfo` to enumerate the GPU. The versions of `rocminfo` and `rocm-smi` in Ubuntu's default repositories predate RDNA 4 and will not detect these cards; install ROCm from AMD's repository instead.

## Installation

### From source

```bash
# Install Rust if needed: https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

git clone https://github.com/ViriatusOG/llama-monitor.git && cd llama-monitor
cargo build --release
```

The binary is at `target/release/llama-monitor`. It's a single self-contained executable — the frontend is embedded at compile time.

### Dependencies

- **llama.cpp** — `llama-server` (with `--metrics` and `--jinja` support). `llama-bench` is required for the Benchmark tab and is expected alongside `llama-server` in the same directory.
- **GPU monitoring** (optional) — `rocm-smi` / `rocminfo` (AMD) or `nvidia-smi` (NVIDIA)

## Quick start

```bash
# Configure paths in the web UI
./llama-monitor

# Or specify them up front
./llama-monitor \
  --llama-server-path /path/to/llama-server \
  --models-dir ~/models \
  --port 7778
```

Open `http://localhost:7778`. Click the gear icon to set your llama-server binary and models directory, then create a preset.

### Running as a service

```ini
# /etc/systemd/system/llama-monitor.service
[Unit]
Description=Llama Admin Monitor
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/llama-monitor
ExecStart=/home/youruser/llama-monitor/target/release/llama-monitor --port 7778
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now llama-monitor
```

## CLI reference

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--llama-server-path` | `-s` | `llama-server` | Path to the llama-server binary (uses `$PATH` if a bare name) |
| `--llama-server-cwd` | | `.` | Working directory for llama-server |
| `--models-dir` | | — | Directory scanned for `.gguf` files; also the download target |
| `--port` | `-p` | `7778` | Monitor web UI port |
| `--presets-file` | | `~/.config/llama-monitor/presets.json` | Custom presets file location |
| `--gpu-backend` | | `auto` | Force GPU backend: `auto`, `rocm`, `nvidia`, `none` |
| `--gpu-arch` | | from config | GPU architecture for ROCm (e.g. `gfx1100`, `gfx1201`, `auto`) |
| `--gpu-devices` | | from config | Visible GPU device indices (e.g. `0,1`) |

All paths can also be set from the Configuration modal. UI settings take precedence over CLI defaults and persist to `~/.config/llama-monitor/ui-settings.json`.

## Tensor split format

llama.cpp expects tensor splits **slash-separated** — `65/35` for two GPUs, `7/8/8/8` for four. A comma-separated value is parsed as a single number, which silently places the entire model on the first GPU. The Benchmark tab uses slashes throughout; if you're migrating presets from elsewhere, check this first when a split doesn't seem to be taking effect.

## Web UI

**Server** — preset selector, port, start/stop, and a link to llama-server's UI. Live inference metrics, the VRAM usage bar, and the GPU table.

**Chat** — streaming chat proxied to the running server's `/v1/chat/completions`, with reasoning blocks and Markdown rendering.

**Logs** — real-time server output.

**Models** — everything in your models directory with size, quant, VRAM fit, and Hugging Face provenance. Download new models or delete existing ones.

**Benchmark** — pick a model, list the tensor-split ratios to try, and run a sweep. Results are ranked by generation throughput; apply the winner to a preset directly.

## Preset parameters

The preset editor groups llama.cpp parameters into collapsible sections:

- **Model & memory** — model path (with file browser and HF download), GPU layers, no-mmap, mlock
- **Context & KV cache** — context size, K/V quantisation (`f16`/`q8_0`), flash attention
- **Batching & slots** — batch size, micro-batch, parallel slots
- **GPU distribution** — tensor split, split mode, main GPU
- **Threading** — generation and batch thread counts
- **Rope scaling** — YaRN/linear scaling, frequency base/scale
- **Speculative decoding** — ngram-mod, draft model, draft min/max
- **Advanced** — seed, system prompt file, extra CLI args

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/ws` | WebSocket (real-time metrics push) |
| `POST` | `/api/start` | Start llama-server with a `ServerConfig` body |
| `POST` | `/api/stop` | Stop the running server |
| `GET` | `/api/presets` | List presets |
| `POST` | `/api/presets` | Create a preset |
| `PUT` | `/api/presets/{id}` | Update a preset |
| `DELETE` | `/api/presets/{id}` | Delete a preset |
| `POST` | `/api/presets/reset` | Reset presets to defaults |
| `GET` | `/api/models` | List discovered models |
| `POST` | `/api/models/refresh` | Rescan the models directory |
| `POST` | `/api/models/delete` | Delete a model file |
| `GET` | `/api/hf/search?q=` | Search Hugging Face for GGUF repos |
| `GET` | `/api/hf/files?repo=` | List `.gguf` files in a repo |
| `POST` | `/api/hf/download` | Download a file to the models directory |
| `POST` | `/api/bench/run` | Start a tensor-split benchmark sweep |
| `POST` | `/api/bench/cancel` | Cancel a running sweep |
| `GET` | `/api/settings` | Get persisted UI settings |
| `PUT` | `/api/settings` | Save UI settings |
| `GET` | `/api/browse?path=&filter=` | Browse the filesystem |
| `GET` | `/api/gpu-env` | Get GPU environment config |
| `PUT` | `/api/gpu-env` | Save GPU environment config |
| `POST` | `/api/chat?port=` | Streaming proxy to `/v1/chat/completions` |

## Architecture

```
src/
  main.rs              -- Entry point: CLI parsing, wiring, tokio::main
  cli.rs               -- Clap argument definitions
  config.rs            -- AppConfig resolved from CLI args
  state.rs             -- Shared AppState, UiSettings persistence
  gpu/
    mod.rs             -- GpuMetrics, GpuBackend trait, multi-vendor detection
    rocm.rs            -- AMD via rocm-smi JSON
    nvidia.rs          -- NVIDIA via nvidia-smi CSV
    env.rs             -- GPU environment config, architecture table
    dummy.rs           -- No-op backend for headless/testing
  llama/
    metrics.rs         -- Prometheus text format parser
    server.rs          -- Subprocess management, exit detection
    poller.rs          -- Async polling loop for /health, /metrics, /slots
    bench.rs           -- llama-bench sweep runner with cancellation
  presets/
    mod.rs             -- ModelPreset, CRUD, file persistence
  models/
    mod.rs             -- GGUF discovery, filename parsing, metadata sidecars
    hf.rs              -- Hugging Face search, file listing, downloads
  web/
    mod.rs             -- Warp route composition
    api.rs             -- REST handlers, file browser, chat proxy
    ws.rs              -- WebSocket real-time metrics push
    static_assets.rs   -- Embedded frontend
static/
  index.html, style.css, app.js, manifest.json, sw.js, icon.svg
```

### Data flow

```
GPU (rocm-smi/nvidia-smi)  -->  GPU poller (500ms)   --> AppState
llama-server /metrics      -->  Llama poller (1s)    --> AppState
HF download / benchmark    -->  Background tasks     --> AppState
                                                          |
                                                     WebSocket (500ms)
                                                          |
                                                       Browser
```

Downloaded models get a `<filename>.meta.json` sidecar recording the source repo, the repo's download count and last-modified date, and when the file was fetched. Models without a sidecar (added by hand, or downloaded before this feature) simply show no provenance.

## Fork additions

Everything below is new in this fork relative to upstream:

**Features**
- Models tab with listing, deletion, and Hugging Face provenance
- Hugging Face search and download with background progress
- VRAM fit checks against combined GPU memory
- Segmented, labelled VRAM usage bar with per-vendor colours
- Benchmark tab: cancellable tensor-split sweeps with one-click apply
- Models directory configurable from the UI
- Merged Start/Stop toggle and a direct link to llama-server's UI

**Fixes**
- Dropped `--showclocks` from the `rocm-smi` call, which aborts on RDNA 4 ([rocm_smi_lib#182](https://github.com/ROCm/rocm_smi_lib/issues/182)) and took the whole metrics read down with it
- GPU detection merges AMD and NVIDIA results instead of reporting only whichever backend responded first
- Added the missing `gfx1201` architecture entry and corrected `gfx1200`'s label (RX 9060 XT, not 9070 XT)
- GPU names come from `rocminfo`'s marketing name rather than the raw `gfx` identifier
- Quantisation parsing recognises `IQ`-prefixed types (`IQ3_M`, `IQ2_XXS`)
- Tensor-split defaults and placeholders use slashes, not commas
- Unexpected llama-server exits reset the UI state and report the error

## Development

```bash
cargo run                    # Debug mode
cargo test                   # Run tests
cargo clippy -- -D warnings  # Lint
cargo fmt                    # Format
```

Frontend files in `static/` are embedded at compile time via `include_str!` — no Node.js or build tooling required. Rebuild after changing them.

## Credits

Based on [arte-fact/llama-monitor](https://github.com/arte-fact/llama-monitor).
