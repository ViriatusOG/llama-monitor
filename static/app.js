function switchTab(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('page-' + name).classList.add('active');
    document.getElementById('tab-' + name).classList.add('active');
    if (name === 'models') loadModelsTab();
    if (name === 'bench') populateBenchModels();
}

let presets = [];
let serverRunning = false;
let prevLogLen = 0;
let totalVramMb = 0;
let usedVramMb = 0;
let allModelsCache = [];

// --- Settings Persistence (backend) ---

let settingsSaveTimer = null;

function collectSettings() {
    return {
        preset_id: document.getElementById('preset-select').value,
        port: parseInt(document.getElementById('port').value) || 8080,
        llama_server_path: document.getElementById('set-server-path').value,
        llama_server_cwd: document.getElementById('set-server-cwd').value,
        models_dir: document.getElementById('set-models-dir').value,
    };
}

function saveSettings() {
    // Debounce: wait 400ms of inactivity before saving
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => {
        fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(collectSettings()),
        }).catch(() => {});
    }, 400);
}

function applySettings(s) {
    if (!s) return;
    if (s.port) document.getElementById('port').value = s.port;
    if (s.llama_server_path !== undefined) document.getElementById('set-server-path').value = s.llama_server_path;
    if (s.llama_server_cwd !== undefined) document.getElementById('set-server-cwd').value = s.llama_server_cwd;
    if (s.models_dir !== undefined) document.getElementById('set-models-dir').value = s.models_dir;
}

// Auto-save on any control bar change
document.getElementById('controls').addEventListener('input', saveSettings);
document.getElementById('controls').addEventListener('change', saveSettings);

// Load presets and populate dropdown
async function loadPresets(selectId) {
    const [presetsResp, settingsResp] = await Promise.all([
        fetch('/api/presets'),
        selectId === undefined ? fetch('/api/settings') : Promise.resolve(null),
    ]);
    presets = await presetsResp.json();
    const saved = settingsResp ? await settingsResp.json() : null;

    const sel = document.getElementById('preset-select');
    sel.innerHTML = '';
    presets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
    });

    const targetId = selectId ?? (saved?.preset_id || null);
    if (targetId && presets.find(p => p.id === targetId)) {
        sel.value = targetId;
    } else if (presets.length > 0) {
        sel.value = presets[0].id;
    }

    if (selectId === undefined && saved) applySettings(saved);
    saveSettings();
}

// Initial load
loadPresets();
loadGpuEnv();

// --- GPU Environment ---

async function loadGpuEnv() {
    try {
        const resp = await fetch('/api/gpu-env');
        const data = await resp.json();
        const env = data.env;
        const archs = data.architectures;
        const detected = data.detected;

        const sel = document.getElementById('gpu-env-arch');
        sel.innerHTML = '';
        archs.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            let label = a.name;
            if (detected && detected.arch === a.id) label += ' (detected)';
            opt.textContent = label;
            sel.appendChild(opt);
        });
        sel.value = env.arch;

        document.getElementById('gpu-env-devices').value = env.devices;
        document.getElementById('gpu-env-rocm-path').value = env.rocm_path || '/opt/rocm';

        const infoEl = document.getElementById('gpu-detected-info');
        const summaryInfo = document.getElementById('gpu-env-info');
        if (detected) {
            infoEl.textContent = 'Detected: ' + detected.count + ' GPU(s): ' + detected.names.join(', ');
            summaryInfo.textContent = '\u2014 ' + detected.count + ' GPU(s) detected';
        } else {
            infoEl.textContent = 'No GPU detected via rocminfo/nvidia-smi';
            summaryInfo.textContent = '';
        }
    } catch (err) {
        console.error('Failed to load GPU env:', err);
    }
}

// --- Config Modal ---

function openConfigModal() {
    document.getElementById('config-modal').classList.add('open');
}

function closeConfigModal() {
    document.getElementById('config-modal').classList.remove('open');
}

document.getElementById('config-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeConfigModal();
});

function saveConfig() {
    // Save server paths via settings
    clearTimeout(settingsSaveTimer);
    fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectSettings()),
    }).catch(() => {});

    // Save GPU env
    const env = {
        arch: document.getElementById('gpu-env-arch').value,
        devices: document.getElementById('gpu-env-devices').value.trim(),
        rocm_path: document.getElementById('gpu-env-rocm-path').value.trim() || '/opt/rocm',
        extra_env: [],
    };
    fetch('/api/gpu-env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(env),
    }).catch(() => {});

    closeConfigModal();
    showToast('Configuration saved', 'success');
}

// --- File Browser ---

let fbTargetId = '';
let fbFilter = '';
let fbCurrentPath = '';

function openFileBrowser(targetId, filter) {
    fbTargetId = targetId;
    fbFilter = filter === 'dir' ? '' : (filter || '');
    const modal = document.getElementById('file-browser-modal');
    // If target already has a path, start there; otherwise home
    const current = document.getElementById(targetId).value;
    let startPath = '';
    if (current) {
        // Use parent directory of current value
        const parts = current.split('/');
        parts.pop();
        startPath = parts.join('/') || '/';
    }
    // Show/hide "Select This Folder" for dir-mode
    const selectBtn = modal.querySelector('.btn-modal-save');
    selectBtn.style.display = filter === 'dir' ? '' : 'none';
    modal.classList.add('open');
    fileBrowserGo(startPath);
}

function closeFileBrowser() {
    document.getElementById('file-browser-modal').classList.remove('open');
}

document.getElementById('file-browser-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeFileBrowser();
});

async function fileBrowserGo(path) {
    const entriesEl = document.getElementById('fb-entries');
    entriesEl.innerHTML = '<div class="fb-empty">Loading...</div>';
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (fbFilter) params.set('filter', fbFilter);
    try {
        const resp = await fetch('/api/browse?' + params);
        const data = await resp.json();
        if (data.error) {
            entriesEl.innerHTML = '<div class="fb-empty">' + data.error + '</div>';
            return;
        }
        fbCurrentPath = data.path;
        document.getElementById('fb-path-input').value = data.path;
        if (data.entries.length === 0) {
            entriesEl.innerHTML = '<div class="fb-empty">Empty directory</div>';
            return;
        }
        entriesEl.innerHTML = data.entries.map(e => {
            if (e.is_dir) {
                return '<div class="fb-entry fb-entry-dir" onclick="fileBrowserGo(\'' + e.path.replace(/'/g, "\\'") + '\')">' +
                    '<span class="fb-entry-icon">\u{1F4C1}</span>' +
                    '<span class="fb-entry-name">' + e.name + '</span></div>';
            } else {
                return '<div class="fb-entry fb-entry-file fb-match" onclick="fileBrowserSelect(\'' + e.path.replace(/'/g, "\\'") + '\')">' +
                    '<span class="fb-entry-icon">\u{1F4C4}</span>' +
                    '<span class="fb-entry-name">' + e.name + '</span>' +
                    '<span class="fb-entry-size">' + e.size_display + '</span></div>';
            }
        }).join('');
    } catch (err) {
        entriesEl.innerHTML = '<div class="fb-empty">Error: ' + err.message + '</div>';
    }
}

function fileBrowserUp() {
    if (fbCurrentPath && fbCurrentPath !== '/') {
        const parts = fbCurrentPath.split('/');
        parts.pop();
        fileBrowserGo(parts.join('/') || '/');
    }
}

function fileBrowserSelect(path) {
    document.getElementById(fbTargetId).value = path || fbCurrentPath;
    document.getElementById(fbTargetId).dispatchEvent(new Event('input', { bubbles: true }));
    closeFileBrowser();
}

function onBackendChange() {
    const isCuda = document.getElementById('modal-backend').value === 'cuda';
    const ts = document.getElementById('modal-tensor-split');
    ts.disabled = isCuda;
    ts.title = isCuda ? 'Not used -- a CUDA build only sees the NVIDIA GPU' : '';
}

// --- Optimize / Benchmark ---

let benchRunning = false;
let lastServerError = null;

async function populateBenchModels() {
    const splitsEl = document.getElementById('bench-splits');
    if (splitsEl && !splitsEl.value) {
        splitsEl.value = '50/50, 55/45, 61/39, 65/35, 70/30';
    }
    const sel = document.getElementById('bench-model-select');
    if (!sel) return;
    const prev = sel.value;
    await loadModelsCache();
    if (allModelsCache.length === 0) {
        sel.innerHTML = '<option value="">No models found -- download one first</option>';
        return;
    }
    sel.innerHTML = allModelsCache.map(m =>
        '<option value="' + m.path + '">' + (m.model_name || m.filename) +
        (m.quant_type ? ' (' + m.quant_type + ')' : '') + ' \u2014 ' + m.size_display + '</option>'
    ).join('');
    if (prev) sel.value = prev;
    if (!sel.value && sel.options.length > 0) sel.selectedIndex = 0;
}

async function toggleBenchmark() {
    if (benchRunning) {
        const proceed = await showConfirm('Stop Benchmark',
            'Stop the running benchmark? Results collected so far will be kept.');
        if (!proceed) return;
        try {
            const resp = await fetch('/api/bench/cancel', { method: 'POST' });
            const data = await resp.json();
            if (!data.ok) showToast('Could not stop: ' + (data.error || 'unknown'), 'error');
            else showToast('Stopping benchmark...', 'success');
        } catch (err) {
            showToast('Could not stop: ' + err.message, 'error');
        }
        return;
    }

    if (serverRunning) {
        showToast('Stop the llama.cpp server first -- benchmarking needs the GPUs', 'error');
        return;
    }

    const modelPath = document.getElementById('bench-model-select').value;
    if (!modelPath) {
        showToast('No model selected', 'error');
        return;
    }
    const splits = document.getElementById('bench-splits').value
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    if (splits.length === 0) {
        showToast('Enter at least one tensor split ratio', 'error');
        return;
    }
    const ngl = parseInt(document.getElementById('bench-ngl').value) || 999;

    try {
        const resp = await fetch('/api/bench/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_path: modelPath, splits: splits, gpu_layers: ngl }),
        });
        const data = await resp.json();
        if (!data.ok) {
            showToast('Benchmark failed: ' + (data.error || 'unknown'), 'error');
            return;
        }
        document.getElementById('bench-panel').style.display = '';
        showToast('Benchmark started -- this will take a few minutes', 'success');
    } catch (err) {
        showToast('Benchmark failed: ' + err.message, 'error');
    }
}

async function applyBenchSplit(split) {
    const id = document.getElementById('preset-select').value;
    const p = presets.find(pr => pr.id === id);
    if (!p) {
        showToast('No preset selected to apply this to', 'error');
        return;
    }
    const proceed = await showConfirm('Apply Tensor Split',
        'Set tensor split to "' + split + '" on preset "' + p.name + '"?');
    if (!proceed) return;

    const updated = Object.assign({}, p, { tensor_split: split });
    try {
        const resp = await fetch('/api/presets/' + encodeURIComponent(p.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updated),
        });
        if (!resp.ok) {
            showToast('Failed to update preset', 'error');
            return;
        }
        showToast('Applied ' + split + ' to ' + p.name, 'success');
        loadPresets();
    } catch (err) {
        showToast('Failed to update preset: ' + err.message, 'error');
    }
}

let benchLastDone = false;

function updateBenchProgress(b) {
    if (!b) return;
    const panel = document.getElementById('bench-panel');
    const statusEl = document.getElementById('bench-status');
    const barEl = document.getElementById('bench-bar');
    const resultsEl = document.getElementById('bench-results');

    // Button and badge state must update even when idle, so they don't
    // stay stuck showing a stale label from a previous run.
    benchRunning = b.running;
    const toggleBtn = document.getElementById('btn-bench-toggle');
    if (toggleBtn) {
        toggleBtn.textContent = b.running ? 'Stop Benchmark' : 'Start Benchmark';
        toggleBtn.className = 'btn ' + (b.running ? 'btn-stop' : 'btn-start');
    }
    const benchBadge = document.getElementById('badge-bench');
    if (benchBadge) {
        benchBadge.textContent = b.running
            ? ' ' + b.completed + '/' + b.total
            : (b.results.length > 0 ? ' ' + b.results.length : '');
    }

    if (!b.running && !b.done && b.results.length === 0) {
        return;
    }

    panel.style.display = '';

    const pct = b.total > 0 ? (b.completed / b.total) * 100 : 0;
    barEl.style.width = pct.toFixed(1) + '%';

    if (b.running) {
        statusEl.textContent = 'Benchmarking ' + (b.current_split || '...') +
            '  (' + b.completed + ' of ' + b.total + ' complete)';
        benchLastDone = false;
    } else if (b.done) {
        statusEl.textContent = b.cancelled
            ? 'Stopped. ' + b.results.length + ' of ' + b.total + ' ratios completed.'
            : (b.best_split ? 'Done. Fastest split: ' + b.best_split : 'Done.');
        if (!benchLastDone) {
            benchLastDone = true;
            if (b.error) showToast('Benchmark error: ' + b.error, 'error');
            else showToast('Benchmark complete', 'success');
        }
    }

    resultsEl.innerHTML = b.results.map(r => {
        const isBest = b.best_split === r.tensor_split;
        return '<div class="bench-grid-row' + (isBest ? ' bench-best' : '') + '">' +
            '<span>' + r.tensor_split + (isBest ? ' \u2605' : '') + '</span>' +
            '<span>' + r.prompt_tps.toFixed(1) + '</span>' +
            '<span>' + r.gen_tps.toFixed(1) + '</span>' +
            '<span>' + (b.done ? '<button class="btn-sm btn-preset" onclick="applyBenchSplit(\'' + r.tensor_split + '\')">Apply</button>' : '') + '</span>' +
            '</div>';
    }).join('');
}


// --- Generic Confirm Modal ---

let confirmResolve = null;

function showConfirm(title, message) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-modal').classList.add('open');
    return new Promise(resolve => {
        confirmResolve = resolve;
    });
}

function closeConfirmModal(result) {
    document.getElementById('confirm-modal').classList.remove('open');
    if (confirmResolve) {
        confirmResolve(result);
        confirmResolve = null;
    }
}

document.getElementById('confirm-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeConfirmModal(false);
});

// --- Hugging Face Download ---

let hfCurrentRepo = '';
let hfDownloading = false;
let hfLastHandledDone = false;

function openHfModal() {
    document.getElementById('hf-modal').classList.add('open');
    document.getElementById('hf-search-input').value = '';
    document.getElementById('hf-repo-list').innerHTML = '<div class="fb-empty">Search for a model above.</div>';
    hfShowRepos();
}

function closeHfModal() {
    document.getElementById('hf-modal').classList.remove('open');
}

document.getElementById('hf-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeHfModal();
});

function hfShowRepos() {
    document.getElementById('hf-repo-list').style.display = '';
    document.getElementById('hf-file-list').style.display = 'none';
    document.getElementById('hf-repo-header').style.display = '';
    document.getElementById('hf-file-header').style.display = 'none';
    document.getElementById('hf-back-btn').style.display = 'none';
    document.getElementById('hf-hint').textContent = 'Click a model to view its available files.';
}

async function hfSearch() {
    const q = document.getElementById('hf-search-input').value.trim();
    const listEl = document.getElementById('hf-repo-list');
    if (!q) return;
    listEl.innerHTML = '<div class="fb-empty">Searching...</div>';
    hfShowRepos();
    try {
        const resp = await fetch('/api/hf/search?q=' + encodeURIComponent(q));
        const data = await resp.json();
        if (data.error) {
            listEl.innerHTML = '<div class="fb-empty">' + data.error + '</div>';
            return;
        }
        if (!data.results || data.results.length === 0) {
            listEl.innerHTML = '<div class="fb-empty">No results</div>';
            return;
        }
        listEl.innerHTML = data.results.map(r =>
            '<div class="fb-entry fb-entry-file fb-match" onclick="hfShowFiles(\'' + r.id.replace(/'/g, "\\'") + '\')">' +
            '<span class="fb-entry-icon">\u{1F4E6}</span>' +
            '<span class="fb-entry-name">' + r.id + '</span>' +
            '<span class="fb-entry-size" title="Total downloads">' + r.downloads.toLocaleString() + ' downloads</span></div>'
        ).join('');
    } catch (err) {
        listEl.innerHTML = '<div class="fb-empty">Error: ' + err.message + '</div>';
    }
}

async function hfShowFiles(repoId) {
    hfCurrentRepo = repoId;
    document.getElementById('hf-repo-list').style.display = 'none';
    document.getElementById('hf-repo-header').style.display = 'none';
    document.getElementById('hf-file-header').style.display = '';
    const fileListEl = document.getElementById('hf-file-list');
    fileListEl.style.display = '';
    document.getElementById('hf-back-btn').style.display = '';
    document.getElementById('hf-hint').textContent = 'Click a file to start downloading it to your models directory.';
    fileListEl.innerHTML = '<div class="fb-empty">Loading files...</div>';
    try {
        const resp = await fetch('/api/hf/files?repo=' + encodeURIComponent(repoId));
        const data = await resp.json();
        if (data.error) {
            fileListEl.innerHTML = '<div class="fb-empty">' + data.error + '</div>';
            return;
        }
        if (!data.files || data.files.length === 0) {
            fileListEl.innerHTML = '<div class="fb-empty">No .gguf files found</div>';
            return;
        }
        fileListEl.innerHTML = data.files.map(f => {
            const fit = vramFitCheck(f.size_bytes);
            return '<div class="fb-entry fb-entry-file fb-match" onclick="hfDownload(\'' + f.filename.replace(/'/g, "\\'") + '\', \'' + f.size_display + '\')">' +
                '<span class="fb-entry-icon">\u{1F4C4}</span>' +
                '<span class="fb-entry-name">' + f.filename + '</span>' +
                '<span class="fb-entry-size ' + fit.cls + '" title="' + fit.title + '">' + fit.label + '</span>' +
                '<span class="fb-entry-size">' + f.size_display + '</span></div>';
        }).join('');
    } catch (err) {
        fileListEl.innerHTML = '<div class="fb-empty">Error: ' + err.message + '</div>';
    }
}

async function hfDownload(filename, sizeDisplay) {
    if (hfDownloading) {
        showToast('A download is already in progress', 'error');
        return;
    }
    const proceed = await showConfirm('Download Model', 'Download ' + filename + ' (' + (sizeDisplay || 'unknown size') + ') to your models directory?');
    if (!proceed) {
        return;
    }
    hfDownloading = true;
    hfLastHandledDone = false;
    document.getElementById('hf-download-progress').style.display = '';
    document.getElementById('hf-progress-filename').textContent = filename;
    document.getElementById('hf-progress-pct').textContent = '0%';
    document.getElementById('hf-progress-bar').style.width = '0%';
    try {
        const resp = await fetch('/api/hf/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: hfCurrentRepo, filename: filename }),
        });
        const data = await resp.json();
        if (!data.ok) {
            showToast('Download failed: ' + (data.error || 'unknown'), 'error');
            hfDownloading = false;
            document.getElementById('hf-download-progress').style.display = 'none';
        }
    } catch (err) {
        showToast('Download failed: ' + err.message, 'error');
        hfDownloading = false;
        document.getElementById('hf-download-progress').style.display = 'none';
    }
}

function vramFitCheck(sizeBytes) {
    if (totalVramMb <= 0) {
        return { label: '\u2014', cls: '', title: 'GPU VRAM data not yet available' };
    }
    const sizeMb = sizeBytes / 1024 / 1024;
    // Reserve headroom for compute buffers and KV cache -- this checks
    // model weights only, not a running-context estimate.
    const overheadMb = 1536;
    const usableMb = totalVramMb - overheadMb;
    const totalGb = (totalVramMb / 1024).toFixed(1);
    const sizeGb = (sizeMb / 1024).toFixed(1);
    if (sizeMb <= usableMb) {
        return {
            label: '\u2713 Fits (' + sizeGb + 'GB / ' + totalGb + 'GB)',
            cls: 'vram-fit-ok',
            title: 'Model weights fit within combined VRAM (' + totalGb + 'GB). Actual usable context depends on remaining headroom.',
        };
    }
    return {
        label: '\u2717 Too large (' + sizeGb + 'GB / ' + totalGb + 'GB)',
        cls: 'vram-fit-bad',
        title: 'Model weights exceed combined VRAM (' + totalGb + 'GB). Would need a smaller quantization or CPU offload.',
    };
}

async function refreshModels() {
    try {
        await fetch('/api/models/refresh', { method: 'POST' });
    } catch (err) {
        // Non-critical -- model discovery is best-effort
    }
    await loadModelsCache();
    if (document.getElementById('page-models').classList.contains('active')) {
        loadModelsTab();
    }
}

async function loadModelsCache() {
    try {
        const resp = await fetch('/api/models');
        allModelsCache = await resp.json();
    } catch (err) {
        // Non-critical
    }
}

function vendorColor(cardName) {
    const n = cardName.toLowerCase();
    if (n.includes('amd') || n.includes('radeon')) return { color: '#bf616a', label: 'AMD' };
    if (n.includes('nvidia') || n.includes('geforce') || n.includes('quadro') || n.includes('tesla')) return { color: '#a3be8c', label: 'NVIDIA' };
    if (n.includes('intel') || n.includes('arc')) return { color: '#5e81ac', label: 'Intel' };
    return { color: '#6a7585', label: cardName };
}

const VRAM_CONTEXT_COLOR = '#b48ead';

function renderVramBar(d) {
    const barEls = document.querySelectorAll('.vram-bar');
    const legendEls = document.querySelectorAll('.vram-legend');
    const setBars = html => barEls.forEach(el => { el.innerHTML = html; });
    const setLegends = html => legendEls.forEach(el => { el.innerHTML = html; });
    const gpuList = Object.entries(d.gpu);

    if (gpuList.length === 0 || totalVramMb <= 0) {
        setBars('');
        setLegends('<span>No GPU data yet</span>');
        return;
    }

    // Try to attribute used VRAM to model weights vs context/overhead,
    // using the loaded model's file size as an estimate of weight usage.
    // This is a proportional approximation split evenly across GPUs by
    // their share of total used VRAM -- it does not assume any specific
    // tensor-split device ordering, since that isn't reliably knowable
    // from GPU telemetry alone.
    let modelSizeMb = 0;
    if (d.server_running && d.model_path && allModelsCache.length > 0) {
        const match = allModelsCache.find(m => m.path === d.model_path);
        if (match) modelSizeMb = match.size_bytes / 1024 / 1024;
    }
    const contextMb = modelSizeMb > 0 ? Math.max(0, usedVramMb - modelSizeMb) : 0;

    const segments = [];
    const legendVendors = new Set();

    gpuList.forEach(([card, m]) => {
        const vendor = vendorColor(card);
        legendVendors.add(vendor.label + '|' + vendor.color);
        const gpuUsedMb = m.vram_used || 0;
        if (gpuUsedMb <= 0) return;

        let weightMb = gpuUsedMb;
        let ctxMb = 0;
        if (contextMb > 0 && usedVramMb > 0) {
            ctxMb = gpuUsedMb * (contextMb / usedVramMb);
            weightMb = gpuUsedMb - ctxMb;
        }

        const gpuTotalGb = ((m.vram_total || 0) / 1024).toFixed(1);

        if (weightMb > 0) {
            segments.push({
                widthPct: (weightMb / totalVramMb) * 100,
                color: vendor.color,
                label: (weightMb / 1024).toFixed(1) + ' / ' + gpuTotalGb + ' GB',
                title: card + ': ' + (weightMb / 1024).toFixed(1) + 'GB of ' + gpuTotalGb + 'GB used (weights/other)',
            });
        }
        if (ctxMb > 0.1) {
            segments.push({
                widthPct: (ctxMb / totalVramMb) * 100,
                color: VRAM_CONTEXT_COLOR,
                label: (ctxMb / 1024).toFixed(1) + ' GB',
                title: card + ': ' + (ctxMb / 1024).toFixed(1) + 'GB context (est.)',
            });
        }
    });

    const freePct = Math.max(0, 100 - segments.reduce((s, seg) => s + seg.widthPct, 0));
    const freeGb = ((totalVramMb * freePct / 100) / 1024).toFixed(1);

    // Only render text inside a segment when it is wide enough to fit,
    // otherwise the label overflows into neighbouring segments.
    const segText = (seg) => seg.widthPct >= 12 ? seg.label : '';

    setBars(segments.map(seg =>
        '<div class="vram-seg" style="width:' + seg.widthPct.toFixed(2) + '%; background:' + seg.color + ';" title="' + seg.title + '">' +
        '<span class="vram-seg-label">' + segText(seg) + '</span></div>'
    ).join('') +
        '<div class="vram-seg vram-seg-free" style="width:' + freePct.toFixed(2) + '%;" title="Free: ' + freeGb + 'GB">' +
        '<span class="vram-seg-label vram-seg-label-free">' + (freePct >= 12 ? freeGb + ' GB free' : '') + '</span></div>');

    const legendItems = Array.from(legendVendors).map(v => {
        const [label, color] = v.split('|');
        return '<span class="vram-legend-item"><span class="vram-legend-swatch" style="background:' + color + ';"></span>' + label + '</span>';
    });
    legendItems.push('<span class="vram-legend-item"><span class="vram-legend-swatch" style="background:' + VRAM_CONTEXT_COLOR + ';"></span>Context/KV (est.)</span>');
    legendItems.push('<span class="vram-legend-item"><span class="vram-legend-swatch" style="background:transparent; border:1px solid #4c566a;"></span>Free (' + ((totalVramMb - usedVramMb) / 1024).toFixed(1) + 'GB)</span>');
    setLegends(legendItems.join(''));
}

async function loadModelsTab() {
    const listEl = document.getElementById('models-list');
    listEl.innerHTML = '<div class="fb-empty">Loading...</div>';
    try {
        await fetch('/api/models/refresh', { method: 'POST' });
        const resp = await fetch('/api/models');
        const models = await resp.json();
        document.getElementById('badge-models').textContent = models.length || '';
        if (!models || models.length === 0) {
            listEl.innerHTML = '<div class="fb-empty">No models found. Download one to get started.</div>';
            return;
        }
        listEl.innerHTML = models.map(m => {
            const safeName = m.filename.replace(/'/g, "\\'");
            const downloads = m.hf_downloads ? m.hf_downloads.toLocaleString() : '\u2014';
            const downloadedOn = m.downloaded_at
                ? new Date(m.downloaded_at * 1000).toLocaleDateString()
                : '\u2014';
            const hfUpdated = m.hf_last_modified
                ? new Date(m.hf_last_modified).toLocaleDateString()
                : '\u2014';
            const fit = vramFitCheck(m.size_bytes);
            return '<div class="model-grid-row">' +
                '<span class="model-name" title="' + m.filename + '">\u{1F4C4} ' + (m.model_name || m.filename) + '</span>' +
                '<span class="model-cell">' + (m.quant_type || '\u2014') + '</span>' +
                '<span class="model-cell">' + m.size_display + '</span>' +
                '<span class="model-cell ' + fit.cls + '" title="' + fit.title + '">' + fit.label + '</span>' +
                '<span class="model-cell">' + downloads + '</span>' +
                '<span class="model-cell">' + downloadedOn + '</span>' +
                '<span class="model-cell">' + hfUpdated + '</span>' +
                '<span class="model-delete-cell"><button class="btn-sm btn-preset-delete" onclick="deleteModel(\'' + safeName + '\')">Delete</button></span>' +
                '</div>';
        }).join('');
    } catch (err) {
        listEl.innerHTML = '<div class="fb-empty">Error: ' + err.message + '</div>';
    }
}

async function deleteModel(filename) {
    const proceed = await showConfirm('Delete Model', 'Delete ' + filename + ' from disk? This cannot be undone.');
    if (!proceed) return;
    try {
        const resp = await fetch('/api/models/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: filename }),
        });
        const data = await resp.json();
        if (!data.ok) {
            showToast('Delete failed: ' + (data.error || 'unknown'), 'error');
            return;
        }
        showToast('Deleted: ' + filename, 'success');
        loadModelsTab();
    } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
    }
}

function updateHfProgress(p) {
    const badge = document.getElementById('hf-badge');
    if (!p) {
        badge.style.display = 'none';
        return;
    }
    if (p.done) {
        hfDownloading = false;
        badge.style.display = 'none';
        document.getElementById('hf-download-progress').style.display = 'none';
        document.getElementById('models-hf-banner').style.display = 'none';
        if (hfLastHandledDone) return;
        hfLastHandledDone = true;
        if (p.error) {
            showToast('Download failed: ' + p.error, 'error');
        } else {
            showToast('Downloaded: ' + p.filename, 'success');
            refreshModels();
        }
        return;
    }
    if (p.total_bytes > 0) {
        const pct = ((p.downloaded_bytes / p.total_bytes) * 100).toFixed(1);
        document.getElementById('hf-progress-pct').textContent = pct + '%';
        document.getElementById('hf-progress-bar').style.width = pct + '%';
        badge.style.display = '';
        badge.textContent = '(' + pct + '%)';

        const banner = document.getElementById('models-hf-banner');
        banner.style.display = '';
        document.getElementById('models-hf-banner-name').textContent = 'Downloading: ' + p.filename;
        document.getElementById('models-hf-banner-pct').textContent = pct + '%';
        document.getElementById('models-hf-banner-bar').style.width = pct + '%';
    }
}

// Close file browser on Escape
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('file-browser-modal').classList.contains('open')) {
        closeFileBrowser();
        e.stopImmediatePropagation();
    }
}, true);

// --- Preset Selection ---

document.getElementById('preset-select').addEventListener('change', () => saveSettings());

// --- Toast Notifications ---

function showToast(message, type = 'error') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.classList.add('show'); });
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// --- Preset Modal ---

function setVal(id, v) { document.getElementById(id).value = v ?? ''; }
function setChk(id, v) { document.getElementById(id).checked = !!v; }
function setOpt(id, v) { document.getElementById(id).value = v || ''; }
function numOrEmpty(id, v) { document.getElementById(id).value = v != null ? v : ''; }

function clearFieldErrors() {
    document.querySelectorAll('#preset-form .field-error').forEach(el => el.classList.remove('field-error'));
}

function openPresetModal(mode) {
    const modal = document.getElementById('preset-modal');
    const title = document.getElementById('modal-title');
    const form = document.getElementById('preset-form');
    form.reset();
    clearFieldErrors();

    if (mode === 'edit') {
        const id = document.getElementById('preset-select').value;
        const p = presets.find(pr => pr.id === id);
        if (!p) { showToast('No preset selected', 'warn'); return; }
        title.textContent = 'Edit Preset';
        setVal('modal-preset-id', p.id);
        // Model & Memory
        setVal('modal-name', p.name);
        setVal('modal-model-path', p.model_path);
        numOrEmpty('modal-gpu-layers', p.gpu_layers);
        setChk('modal-no-mmap', p.no_mmap);
        setChk('modal-mlock', p.mlock);
        // Context & KV
        setVal('modal-context-size', p.context_size || 128000);
        setVal('modal-ctk', p.ctk || 'q8_0');
        setVal('modal-ctv', p.ctv || 'f16');
        setOpt('modal-flash-attn', p.flash_attn);
        // Batching
        setVal('modal-batch-size', p.batch_size || 2048);
        setVal('modal-ubatch-size', p.ubatch_size || p.batch_size || 2048);
        setVal('modal-parallel-slots', p.parallel_slots || 1);
        // GPU
        setVal('modal-tensor-split', p.tensor_split);
        setVal('modal-backend', p.backend || 'vulkan');
        setOpt('modal-split-mode', p.split_mode);
        numOrEmpty('modal-main-gpu', p.main_gpu);
        // Threading
        numOrEmpty('modal-threads', p.threads);
        numOrEmpty('modal-threads-batch', p.threads_batch);
        // Rope
        setOpt('modal-rope-scaling', p.rope_scaling);
        numOrEmpty('modal-rope-freq-base', p.rope_freq_base);
        numOrEmpty('modal-rope-freq-scale', p.rope_freq_scale);
        // Spec decoding
        setChk('modal-ngram-spec', p.ngram_spec);
        numOrEmpty('modal-spec-ngram-size', p.spec_ngram_size);
        numOrEmpty('modal-draft-min', p.draft_min);
        numOrEmpty('modal-draft-max', p.draft_max);
        setVal('modal-draft-model', p.draft_model);
        // Advanced
        numOrEmpty('modal-seed', p.seed);
        setVal('modal-system-prompt-file', p.system_prompt_file);
        setVal('modal-extra-args', p.extra_args);
    } else {
        title.textContent = 'New Preset';
        setVal('modal-preset-id', '');
        setVal('modal-context-size', 128000);
        setVal('modal-ctk', 'q8_0');
        setVal('modal-ctv', 'f16');
        setVal('modal-batch-size', 2048);
        setVal('modal-ubatch-size', 2048);
        setVal('modal-parallel-slots', 1);
    }

    modal.classList.add('open');
    // Scroll modal body to top
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
}

function closePresetModal() {
    const modal = document.getElementById('preset-modal');
    modal.classList.remove('open');
}

// Close modal on overlay click
document.getElementById('preset-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePresetModal();
});

// Close modals on Escape key
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('config-modal').classList.contains('open')) {
        closeConfigModal();
    } else if (e.key === 'Escape' && document.getElementById('preset-modal').classList.contains('open')) {
        closePresetModal();
    }
});

function intOrNull(id) { const v = document.getElementById(id).value; return v !== '' ? parseInt(v) : null; }
function floatOrNull(id) { const v = document.getElementById(id).value; return v !== '' ? parseFloat(v) : null; }
function strVal(id) { return document.getElementById(id).value.trim(); }

async function savePreset(event) {
    event.preventDefault();
    clearFieldErrors();

    const id = document.getElementById('modal-preset-id').value;
    const preset = {
        // Model & Memory
        name: strVal('modal-name'),
        model_path: strVal('modal-model-path'),
        gpu_layers: intOrNull('modal-gpu-layers'),
        no_mmap: document.getElementById('modal-no-mmap').checked,
        mlock: document.getElementById('modal-mlock').checked,
        // Context & KV
        context_size: parseInt(document.getElementById('modal-context-size').value) || 128000,
        ctk: strVal('modal-ctk') || 'q8_0',
        ctv: strVal('modal-ctv') || 'f16',
        flash_attn: strVal('modal-flash-attn'),
        // Batching
        batch_size: parseInt(document.getElementById('modal-batch-size').value) || 2048,
        ubatch_size: parseInt(document.getElementById('modal-ubatch-size').value) || 2048,
        parallel_slots: parseInt(document.getElementById('modal-parallel-slots').value) || 1,
        // GPU
        tensor_split: strVal('modal-tensor-split'),
        backend: strVal('modal-backend') || 'vulkan',
        split_mode: strVal('modal-split-mode'),
        main_gpu: intOrNull('modal-main-gpu'),
        // Threading
        threads: intOrNull('modal-threads'),
        threads_batch: intOrNull('modal-threads-batch'),
        // Rope
        rope_scaling: strVal('modal-rope-scaling'),
        rope_freq_base: floatOrNull('modal-rope-freq-base'),
        rope_freq_scale: floatOrNull('modal-rope-freq-scale'),
        // Spec decoding
        ngram_spec: document.getElementById('modal-ngram-spec').checked,
        spec_ngram_size: intOrNull('modal-spec-ngram-size'),
        draft_min: intOrNull('modal-draft-min'),
        draft_max: intOrNull('modal-draft-max'),
        draft_model: strVal('modal-draft-model'),
        // Advanced
        seed: intOrNull('modal-seed'),
        system_prompt_file: strVal('modal-system-prompt-file'),
        extra_args: strVal('modal-extra-args'),
    };

    // Inline validation
    let valid = true;
    if (!preset.name) {
        document.getElementById('modal-name').classList.add('field-error');
        valid = false;
    }
    if (!preset.model_path) {
        document.getElementById('modal-model-path').classList.add('field-error');
        valid = false;
    }
    if (!valid) {
        showToast('Please fill in all required fields', 'error');
        return;
    }

    const saveBtn = document.getElementById('btn-modal-save');
    saveBtn.classList.add('saving');
    saveBtn.textContent = 'Saving...';

    try {
        let resp;
        let savedId;
        if (id) {
            resp = await fetch('/api/presets/' + encodeURIComponent(id), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(preset),
            });
            if (!resp.ok) {
                const err = await resp.text().catch(() => 'Unknown error');
                showToast('Save failed: ' + err, 'error');
                return;
            }
            savedId = id;
        } else {
            resp = await fetch('/api/presets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(preset),
            });
            if (!resp.ok) {
                const err = await resp.text().catch(() => 'Unknown error');
                showToast('Save failed: ' + err, 'error');
                return;
            }
            const data = await resp.json();
            savedId = data.id || null;
        }
        closePresetModal();
        await loadPresets(savedId);
        showToast('Preset saved', 'success');
    } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
    } finally {
        saveBtn.classList.remove('saving');
        saveBtn.textContent = 'Save';
    }
}

async function copyPreset() {
    const id = document.getElementById('preset-select').value;
    const p = presets.find(pr => pr.id === id);
    if (!p) { showToast('No preset selected', 'warn'); return; }

    const copy = Object.assign({}, p);
    delete copy.id;
    copy.name = p.name + ' (copy)';

    try {
        const resp = await fetch('/api/presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(copy),
        });
        if (!resp.ok) {
            const err = await resp.text().catch(() => 'Unknown error');
            showToast('Copy failed: ' + err, 'error');
            return;
        }
        const data = await resp.json();
        await loadPresets(data.preset?.id || null);
        showToast('Preset copied', 'success');
    } catch (err) {
        showToast('Copy failed: ' + err.message, 'error');
    }
}

async function deletePreset() {
    const id = document.getElementById('preset-select').value;
    const p = presets.find(pr => pr.id === id);
    if (!p) { showToast('No preset selected', 'warn'); return; }
    if (!confirm('Delete preset "' + p.name + '"?')) return;

    try {
        const resp = await fetch('/api/presets/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!resp.ok) {
            const err = await resp.text().catch(() => 'Unknown error');
            showToast('Delete failed: ' + err, 'error');
            return;
        }
        await loadPresets();
        showToast('Preset deleted', 'success');
    } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
    }
}

async function resetPresets() {
    if (!confirm('Reset all presets to built-in defaults? Custom presets will be removed.')) return;
    try {
        const resp = await fetch('/api/presets/reset', { method: 'POST' });
        if (!resp.ok) {
            const err = await resp.text().catch(() => 'Unknown error');
            showToast('Reset failed: ' + err, 'error');
            return;
        }
        await loadPresets();
        showToast('Presets reset to defaults', 'success');
    } catch (err) {
        showToast('Reset failed: ' + err.message, 'error');
    }
}

// Clear field errors on input
['modal-name', 'modal-model-path'].forEach(id => {
    document.getElementById(id).addEventListener('input', function() {
        this.classList.remove('field-error');
    });
});

// --- End Preset Modal ---

function getConfig() {
    const id = document.getElementById('preset-select').value;
    const p = presets.find(pr => pr.id === id) || {};
    return {
        model_path: p.model_path || '',
        context_size: p.context_size || 128000,
        ctk: p.ctk || 'q8_0',
        ctv: p.ctv || 'f16',
        tensor_split: p.tensor_split || '',
        batch_size: p.batch_size || 2048,
        ubatch_size: p.ubatch_size || p.batch_size || 2048,
        no_mmap: !!p.no_mmap,
        port: parseInt(document.getElementById('port').value) || 8080,
        ngram_spec: !!p.ngram_spec,
        parallel_slots: p.parallel_slots || 1,
        gpu_layers: p.gpu_layers ?? null,
        mlock: !!p.mlock,
        flash_attn: p.flash_attn || '',
        split_mode: p.split_mode || '',
        main_gpu: p.main_gpu ?? null,
        threads: p.threads ?? null,
        threads_batch: p.threads_batch ?? null,
        rope_scaling: p.rope_scaling || '',
        rope_freq_base: p.rope_freq_base ?? null,
        rope_freq_scale: p.rope_freq_scale ?? null,
        draft_model: p.draft_model || '',
        draft_min: p.draft_min ?? null,
        draft_max: p.draft_max ?? null,
        spec_ngram_size: p.spec_ngram_size ?? null,
        seed: p.seed ?? null,
        system_prompt_file: p.system_prompt_file || '',
        extra_args: p.extra_args || '',
    };
}

async function doToggle() {
    const btn = document.getElementById('btn-toggle');
    btn.disabled = true;
    if (serverRunning) {
        await fetch('/api/stop', { method: 'POST' });
    } else {
        const config = getConfig();
        if (!config.model_path) {
            showToast('No model path set. Edit the preset to select a model.', 'error');
            btn.disabled = false;
            return;
        }
        const resp = await fetch('/api/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(config),
        });
        const data = await resp.json();
        if (!data.ok) showToast('Start failed: ' + (data.error || 'unknown'), 'error');
    }
}

function openLlamaUi() {
    const port = document.getElementById('port').value || '8080';
    window.open('http://' + location.hostname + ':' + port, '_blank');
}

// WebSocket
loadModelsCache();
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
ws.onmessage = e => {
    const d = JSON.parse(e.data);

    // Server state
    serverRunning = d.server_running;
    updateHfProgress(d.hf_download);
    updateBenchProgress(d.bench);

    // Surface startup/crash failures once, rather than on every tick.
    if (d.server_error && d.server_error !== lastServerError) {
        lastServerError = d.server_error;
        showToast(d.server_error, 'error');
    } else if (!d.server_error) {
        lastServerError = null;
    }
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    dot.className = 'status-dot ' + (serverRunning ? 'running' : 'stopped');
    txt.textContent = serverRunning ? 'Running' : 'Stopped';

    const toggleBtn = document.getElementById('btn-toggle');
    toggleBtn.disabled = false;
    toggleBtn.textContent = serverRunning ? 'Stop' : 'Start';
    toggleBtn.className = 'btn ' + (serverRunning ? 'btn-stop' : 'btn-start');

    document.getElementById('btn-open-ui').style.display = serverRunning ? 'inline-block' : 'none';

    // Inference
    const l = d.llama;
    document.getElementById('m-prompt').textContent = l.prompt_tokens_per_sec > 0 ? l.prompt_tokens_per_sec.toFixed(1) + ' t/s' : '\u2014';
    document.getElementById('m-gen').textContent = l.generation_tokens_per_sec > 0 ? l.generation_tokens_per_sec.toFixed(1) + ' t/s' : '\u2014';
    if (l.kv_cache_max > 0) {
        const pct = ((l.kv_cache_tokens / l.kv_cache_max) * 100).toFixed(1);
        document.getElementById('m-ctx').textContent = l.kv_cache_tokens + ' / ' + l.kv_cache_max + ' (' + pct + '%)';
    } else {
        document.getElementById('m-ctx').textContent = '\u2014';
    }
    document.getElementById('m-slots').textContent = l.slots_idle + l.slots_processing > 0 ? l.slots_idle + ' idle / ' + l.slots_processing + ' busy' : '\u2014';

    const statusEl = document.getElementById('m-status');
    statusEl.textContent = l.status || '\u2014';
    statusEl.className = 'metric-value ' + (l.status === 'ok' ? 'status-ok' : l.status === 'no slot available' ? 'status-busy' : 'status-err');

    // GPU table
    const tbody = document.getElementById('gpu-rows');
    const gpuList = Object.entries(d.gpu);
    totalVramMb = gpuList.reduce((sum, [, m]) => sum + (m.vram_total || 0), 0);
    usedVramMb = gpuList.reduce((sum, [, m]) => sum + (m.vram_used || 0), 0);
    renderVramBar(d);
    tbody.innerHTML = gpuList.map(([card, m]) => {
        const capped = m.power_consumption >= m.power_limit && m.power_limit > 0;
        const pcls = capped ? 'value capped' : 'value power';
        const ptxt = capped ? m.power_consumption.toFixed(1) + 'W!' : m.power_consumption.toFixed(1) + 'W / ' + m.power_limit + 'W';
        const vpct = m.vram_total > 0 ? Math.round((m.vram_used / m.vram_total) * 100) : 0;
        return '<tr>' +
            '<td class="card value">' + card + '</td>' +
            '<td class="value temp">' + Math.round(m.temp) + 'C</td>' +
            '<td class="value load">' + m.load + '%</td>' +
            '<td class="value vram">' + vpct + '%</td>' +
            '<td class="' + pcls + '">' + ptxt + '</td>' +
            '<td class="value sclk">' + m.sclk_mhz + 'MHz</td>' +
            '<td class="value mclk">' + m.mclk_mhz + 'MHz</td>' +
            '</tr>';
    }).join('');

    // Logs (single panel)
    const logs = d.logs || [];
    if (logs.length !== prevLogLen) {
        const el = document.getElementById('log-panel');
        const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        el.textContent = logs.join('\n');
        if (wasAtBottom) el.scrollTop = el.scrollHeight;
        prevLogLen = logs.length;
    }

    // Tab badges
    const badgeParts = [];
    if (serverRunning) badgeParts.push('Running');
    if (l.generation_tokens_per_sec > 0) badgeParts.push(l.generation_tokens_per_sec.toFixed(1) + 't/s');
    const gpuEntries = Object.entries(d.gpu);
    if (gpuEntries.length > 0) badgeParts.push(Math.max(...gpuEntries.map(([,m]) => m.temp)).toFixed(0) + 'C');
    document.getElementById('badge-server').textContent = badgeParts.length ? ' ' + badgeParts.join(' \u00b7 ') : ' Stopped';

    document.getElementById('badge-chat').textContent = chatHistory.length > 0 ? ' ' + chatHistory.length + ' msg' : '';
    document.getElementById('badge-logs').textContent = logs.length > 0 ? ' ' + logs.length : '';
};
ws.onerror = e => console.error('WebSocket error:', e);
ws.onclose = () => { document.getElementById('status-text').textContent = 'Disconnected'; };

// Markdown
if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
}
function renderMd(src) {
    if (typeof marked !== 'undefined') {
        try { return marked.parse(src); } catch(_) {}
    }
    return src.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>');
}

// Chat
let chatHistory = [];
let chatBusy = false;

document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

function clearChat() {
    chatHistory = [];
    document.getElementById('chat-messages').innerHTML = '';
}

function chatScroll() {
    const c = document.getElementById('chat-messages');
    c.scrollTop = c.scrollHeight;
}

function appendMsg(role, text) {
    const el = document.createElement('div');
    el.className = 'msg msg-' + role;
    el.textContent = text;
    document.getElementById('chat-messages').appendChild(el);
    chatScroll();
    return el;
}

async function sendChat() {
    if (chatBusy) return;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    chatHistory.push({ role: 'user', content: text });
    appendMsg('user', text);

    const chatPort = document.getElementById('port').value || '8080';
    const url = '/api/chat?port=' + encodeURIComponent(chatPort);

    chatBusy = true;
    document.getElementById('btn-send').disabled = true;

    let thinkEl = null;
    let thinkContent = '';
    const msgEl = appendMsg('assistant', '');
    let msgContent = '';

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: chatHistory,
                stream: true,
                temperature: 1.0,
                top_p: 0.95,
                top_k: 40,
                min_p: 0.01,
                repeat_penalty: 1.0,
            }),
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') continue;
                try {
                    const obj = JSON.parse(payload);
                    const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
                    if (!delta) continue;

                    // Reasoning / thinking content
                    const rc = delta.reasoning_content || '';
                    if (rc) {
                        thinkContent += rc;
                        if (!thinkEl) {
                            thinkEl = document.createElement('details');
                            thinkEl.className = 'msg msg-thinking';
                            thinkEl.innerHTML = '<summary>thinking...</summary><span></span>';
                            document.getElementById('chat-messages').insertBefore(thinkEl, msgEl);
                        }
                        thinkEl.querySelector('span').textContent = thinkContent;
                    }

                    // Regular content
                    const c = delta.content || '';
                    if (c) {
                        msgContent += c;
                        msgEl.innerHTML = renderMd(msgContent);
                    }
                } catch (_) {}
            }
            chatScroll();
        }
    } catch (err) {
        msgEl.textContent = '[error] ' + err.message;
        msgEl.style.color = '#bf616a';
    }

    if (msgContent) {
        chatHistory.push({ role: 'assistant', content: msgContent });
    }
    chatBusy = false;
    document.getElementById('btn-send').disabled = false;
}
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}
