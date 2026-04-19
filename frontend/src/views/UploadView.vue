<template>
  <section class="card panel">
    <div class="panel-head">
      <h2>Upload Center</h2>
      <div class="storage-group">
        <button
          v-for="mode in modes"
          :key="mode.value"
          class="chip"
          :class="{ active: selectedStorage === mode.value, disabled: !mode.available }"
          :disabled="!mode.available"
          :title="mode.hint"
          @click="selectedStorage = mode.value"
        >
          {{ mode.label }}
        </button>
      </div>
    </div>

    <div
      class="dropzone"
      :class="{ active: dragActive }"
      @dragover.prevent="dragActive = true"
      @dragleave.prevent="dragActive = false"
      @drop.prevent="handleDrop"
      @click="openPicker"
    >
      <input ref="picker" type="file" multiple hidden @change="handleFilePick" />
      <p class="dropzone-title">Drag files here or click to upload</p>
      <p class="muted">Current target: {{ currentStorageLabel }} · {{ formatFolderPath(targetFolderPath) }}</p>
    </div>

    <section class="target-directory card-lite">
      <div class="target-directory-head">
        <div>
          <h3>Target Directory</h3>
          <p class="muted">Choose an existing folder or type a path before the upload starts.</p>
        </div>
        <div class="target-directory-actions">
          <button class="btn btn-ghost" type="button" :disabled="folderLoading" @click="reloadFolderTree">
            {{ folderLoading ? 'Refreshing...' : 'Refresh folders' }}
          </button>
          <button class="btn btn-ghost" type="button" @click="setTargetFolder('')">Use root</button>
        </div>
      </div>

      <div class="target-directory-grid">
        <label class="target-directory-field">
          <span>Folder browser</span>
          <select
            v-model="targetFolderPathModel"
            :disabled="folderLoading || !folderBrowserAvailable"
          >
            <option
              v-for="option in folderOptions"
              :key="option.value || '__root__'"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>

        <label class="target-directory-field">
          <span>Manual path</span>
          <input
            v-model.trim="targetFolderPathModel"
            placeholder="assets/images/2026"
          />
        </label>
      </div>

      <div class="target-directory-meta">
        <span class="badge" :class="targetFolderExists ? 'badge-ok' : ''">{{ targetFolderBadge }}</span>
        <span class="muted">Current folder: {{ formatFolderPath(targetFolderPath) }}</span>
      </div>

      <p class="muted">{{ folderHint }}</p>
      <p v-if="folderLoadError" class="error">{{ folderLoadError }}</p>
    </section>

    <form class="url-row" @submit.prevent="uploadUrl">
      <input v-model.trim="urlInput" placeholder="https://example.com/file.png" />
      <button class="btn" :disabled="urlUploading || !urlInput">
        {{ urlUploading ? 'Uploading...' : 'Upload URL' }}
      </button>
    </form>

    <div v-if="queue.length" class="list-wrap">
      <h3>Queue</h3>
      <ul class="list">
        <li v-for="item in queue" :key="item.id" class="list-item">
          <div class="list-title">
            <strong>{{ item.file.name }}</strong>
            <span>{{ formatSize(item.file.size) }}</span>
          </div>
          <p class="muted queue-target">{{ item.storageLabel }} · {{ formatFolderPath(item.targetFolderPath) }}</p>
          <div class="progress-track">
            <span class="progress-fill" :style="{ width: `${item.progress}%` }"></span>
          </div>
          <div class="list-meta">
            <span>{{ item.status }}</span>
            <span v-if="item.error" class="error">{{ item.error }}</span>
          </div>
        </li>
      </ul>
    </div>

    <div v-if="results.length" class="list-wrap">
      <h3>Uploaded</h3>
      <ul class="list">
        <li v-for="item in results" :key="item.id" class="result-item">
          <div>
            <strong>{{ item.fileName }}</strong>
            <p class="muted">{{ item.link }}</p>
          </div>
          <div class="result-actions">
            <button class="btn btn-ghost" @click="copy(item.link)">Copy</button>
            <a class="btn btn-ghost" :href="item.link" target="_blank" rel="noopener">Open</a>
          </div>
        </li>
      </ul>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { apiFetch, getApiBase } from '../api/client';
import { getDriveTree } from '../api/drive';
import { STORAGE_TYPES, getStorageLabel, storageEnabledFromStatus } from '../config/storage-definitions';

const picker = ref(null);
const dragActive = ref(false);
const queue = ref([]);
const results = ref([]);
const selectedStorage = ref('telegram');
const status = ref(null);
const uploading = ref(false);
const error = ref('');
const urlInput = ref('');
const urlUploading = ref(false);
const folderTree = ref([]);
const folderLoading = ref(false);
const folderLoadError = ref('');
const folderLoadNotice = ref('');
const targetFolderPath = ref('');

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const SMALL_FILE_THRESHOLD = 20 * 1024 * 1024;
const V2_ACCEPT = 'application/vnd.kvault.v2+json, application/json;q=0.9, text/plain;q=0.5, */*;q=0.1';
let folderTreeRequestId = 0;

const modes = computed(() => {
  return STORAGE_TYPES.map((item) => {
    const detail = status.value?.[item.value] || {};
    const available = storageEnabledFromStatus(status.value, item.value);
    const configured = Boolean(detail.configured);
    return {
      value: item.value,
      label: item.label,
      available,
      hint: available
        ? 'Ready'
        : (configured ? (detail.message || 'Configured but unavailable') : 'Not configured'),
    };
  });
});

const currentStorageLabel = computed(() => {
  const found = modes.value.find((x) => x.value === selectedStorage.value);
  return found ? found.label : getStorageLabel('telegram');
});

const targetFolderPathModel = computed({
  get: () => targetFolderPath.value,
  set: (value) => {
    targetFolderPath.value = normalizeFolderPath(value);
  },
});

const folderBrowserAvailable = computed(() => folderTree.value.some((node) => normalizeFolderPath(node.path) !== ''));

const folderOptions = computed(() => {
  const options = [{ value: '', label: 'Root /' }];
  const seen = new Set(['']);

  const nodes = [...folderTree.value]
    .filter((node) => normalizeFolderPath(node.path))
    .sort((a, b) => {
      const pathA = normalizeFolderPath(a.path);
      const pathB = normalizeFolderPath(b.path);
      const depthA = pathA.split('/').length;
      const depthB = pathB.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return pathA.localeCompare(pathB, 'en', { sensitivity: 'base' });
    });

  for (const node of nodes) {
    const path = normalizeFolderPath(node.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    options.push({ value: path, label: `/${path}` });
  }

  if (targetFolderPath.value && !seen.has(targetFolderPath.value)) {
    options.splice(1, 0, {
      value: targetFolderPath.value,
      label: `/${targetFolderPath.value} (custom)`,
    });
  }

  return options;
});

const targetFolderExists = computed(() => {
  if (!targetFolderPath.value) return true;
  return folderTree.value.some((node) => normalizeFolderPath(node.path) === targetFolderPath.value);
});

const targetFolderBadge = computed(() => {
  if (!targetFolderPath.value) return 'Root directory';
  return targetFolderExists.value ? 'Existing folder' : 'Custom path';
});

const folderHint = computed(() => {
  if (folderLoading.value) return 'Refreshing folder tree for the selected storage.';
  if (folderLoadNotice.value) return folderLoadNotice.value;
  if (!targetFolderPath.value) return 'Leave the path empty to upload directly into the storage root.';
  if (targetFolderExists.value) return 'This folder already exists in the current storage tree.';
  return 'This path is not in the current folder list yet. It will be normalized and used as entered.';
});

onMounted(async () => {
  try {
    status.value = await apiFetch('/api/status');
    const first = modes.value.find((item) => item.available);
    if (first) selectedStorage.value = first.value;
  } catch (err) {
    error.value = err.message;
  } finally {
    await loadFolderTree();
  }
});

watch(selectedStorage, () => {
  void loadFolderTree();
});

function openPicker() {
  picker.value?.click();
}

function handleFilePick(event) {
  const files = Array.from(event.target.files || []);
  enqueueFiles(files);
  event.target.value = '';
}

function handleDrop(event) {
  dragActive.value = false;
  const files = Array.from(event.dataTransfer?.files || []);
  enqueueFiles(files);
}

function enqueueFiles(files) {
  for (const file of files) {
    queue.value.push({
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      file,
      storageMode: selectedStorage.value,
      storageLabel: currentStorageLabel.value,
      targetFolderPath: targetFolderPath.value,
      progress: 0,
      status: 'pending',
      error: '',
    });
  }
  void processQueue();
}

async function processQueue() {
  if (uploading.value) return;
  uploading.value = true;
  error.value = '';

  try {
    for (const item of queue.value) {
      if (item.status !== 'pending') continue;
      const selected = modes.value.find((mode) => mode.value === item.storageMode);
      if (!selected?.available) {
        item.status = 'error';
        item.error = 'Selected storage is unavailable. Open Storage/Status to configure it.';
        continue;
      }
      item.status = 'uploading';
      item.error = '';

      try {
        const link = item.file.size > SMALL_FILE_THRESHOLD
          ? await chunkUpload(item)
          : await directUpload(item);

        item.status = 'success';
        item.progress = 100;
        results.value.unshift({
          id: item.id,
          fileName: item.file.name,
          link,
        });
      } catch (err) {
        item.status = 'error';
        item.error = humanizeError(err.message || 'Upload failed');
      }
    }
  } finally {
    uploading.value = false;
  }
}

function apiUrl(path) {
  return `${getApiBase()}${path}`;
}

function normalizeFolderPath(value) {
  const segments = [];
  const raw = String(value || '').replace(/\\/g, '/');
  for (const piece of raw.split('/')) {
    const part = piece.trim();
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

function formatFolderPath(path) {
  const normalized = normalizeFolderPath(path);
  return normalized ? `/${normalized}` : 'Root /';
}

function setTargetFolder(path) {
  targetFolderPath.value = normalizeFolderPath(path);
}

async function reloadFolderTree() {
  await loadFolderTree();
}

async function loadFolderTree() {
  const requestId = ++folderTreeRequestId;
  folderLoading.value = true;
  folderLoadError.value = '';
  folderLoadNotice.value = '';

  try {
    const nodes = await getDriveTree(selectedStorage.value);
    if (requestId !== folderTreeRequestId) return;

    folderTree.value = Array.isArray(nodes) ? nodes : [];
    if (folderTree.value.length <= 1) {
      folderLoadNotice.value = 'No saved folders were found for the selected storage yet. Root remains available.';
    }
  } catch (err) {
    if (requestId !== folderTreeRequestId) return;

    folderTree.value = [];
    if (err?.status === 401 || err?.status === 403) {
      folderLoadNotice.value = 'Folder browser is unavailable in the current session. Manual path entry still works.';
      return;
    }
    folderLoadError.value = err.message || 'Failed to load folders for the selected storage.';
  } finally {
    if (requestId === folderTreeRequestId) {
      folderLoading.value = false;
    }
  }
}

function toAbsoluteUrl(path) {
  return new URL(path, window.location.origin).toString();
}

function truncate(text, maxLength = 220) {
  const value = String(text || '');
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveUploadErrorMessage(payload, statusCode, rawText = '') {
  if (payload && typeof payload === 'object') {
    const nestedMessage = typeof payload?.error?.message === 'string' ? payload.error.message : '';
    const message = nestedMessage
      || payload?.error
      || payload?.message
      || payload?.errorDetail
      || payload?.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }

  if (rawText) {
    return `Backend returned non-JSON response (${statusCode}): ${truncate(rawText)}`;
  }
  return `Upload failed (${statusCode})`;
}

function humanizeError(message) {
  const text = String(message || '');
  const normalized = text.toLowerCase();

  if (normalized.includes('auth_failed') || normalized.includes('unauthorized') || normalized.includes('forbidden')) {
    return `Authentication failed: ${text}`;
  }
  if (normalized.includes('rate') || normalized.includes('too many requests') || normalized.includes('flood')) {
    return `Rate limited: ${text}`;
  }
  if (normalized.includes('quota') || normalized.includes('limit exceeded') || normalized.includes('too large') || normalized.includes('413')) {
    return `File size or quota exceeded: ${text}`;
  }
  if (normalized.includes('network') || normalized.includes('timeout') || normalized.includes('fetch failed')) {
    return `Network or upstream issue: ${text}`;
  }
  if (normalized.includes('not configured')) {
    return `Storage is not configured: ${text}`;
  }
  return text || 'Upload failed';
}

function directUpload(item) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', item.file);
    formData.append('storageMode', item.storageMode);
    formData.append('folderPath', item.targetFolderPath || '');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/upload'));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', V2_ACCEPT);
    xhr.setRequestHeader('X-KVault-Client', 'app-v2');

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.max(1, Math.floor((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      const rawText = String(xhr.responseText || '');
      const body = parseJsonSafe(rawText);

      if (xhr.status < 200 || xhr.status >= 300) {
        const message = resolveUploadErrorMessage(body, xhr.status, rawText);
        reject(new Error(humanizeError(message)));
        return;
      }

      const src = Array.isArray(body)
        ? body[0]?.src
        : (body?.src || body?.data?.src || body?.data?.items?.[0]?.src || body?.items?.[0]?.src);

      if (!src) {
        if (!body) {
          reject(new Error(`Backend returned non-JSON response: ${truncate(rawText) || '<empty body>'}`));
          return;
        }
        reject(new Error('Upload response missing src'));
        return;
      }
      resolve(toAbsoluteUrl(src));
    };

    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(formData);
  });
}

async function chunkUpload(item) {
  const totalChunks = Math.ceil(item.file.size / DEFAULT_CHUNK_SIZE);

  const init = await apiFetch('/api/chunked-upload/init', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: V2_ACCEPT,
      'X-KVault-Client': 'app-v2',
    },
    body: JSON.stringify({
      fileName: item.file.name,
      fileSize: item.file.size,
      fileType: item.file.type,
      totalChunks,
      storageMode: item.storageMode,
      folderPath: item.targetFolderPath || '',
    }),
  });

  const uploadId = init.uploadId;
  const chunkSize = Number(init.chunkSize || DEFAULT_CHUNK_SIZE);

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(item.file.size, start + chunkSize);
    const chunk = item.file.slice(start, end);

    const chunkBody = new FormData();
    chunkBody.append('uploadId', uploadId);
    chunkBody.append('chunkIndex', String(index));
    chunkBody.append('chunk', chunk);

    await apiFetch('/api/chunked-upload/chunk', {
      method: 'POST',
      headers: {
        Accept: V2_ACCEPT,
        'X-KVault-Client': 'app-v2',
      },
      body: chunkBody,
    });

    item.progress = Math.min(95, Math.floor(((index + 1) / totalChunks) * 95));
  }

  const done = await apiFetch('/api/chunked-upload/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: V2_ACCEPT,
      'X-KVault-Client': 'app-v2',
    },
    body: JSON.stringify({ uploadId }),
  });

  if (!done?.src) {
    throw new Error('Chunk upload complete response missing src');
  }

  return toAbsoluteUrl(done.src);
}

async function uploadUrl() {
  if (!urlInput.value || urlUploading.value) return;
  const selected = modes.value.find((mode) => mode.value === selectedStorage.value);
  if (!selected?.available) {
    error.value = 'Selected storage is unavailable. Open Storage/Status to configure it.';
    return;
  }

  urlUploading.value = true;
  error.value = '';

  try {
    const body = await apiFetch('/api/upload-from-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: V2_ACCEPT,
        'X-KVault-Client': 'app-v2',
      },
      body: JSON.stringify({
        url: urlInput.value,
        storageMode: selectedStorage.value,
        folderPath: targetFolderPath.value,
      }),
    });

    const src = Array.isArray(body) ? body[0]?.src : body?.src;
    if (!src) {
      throw new Error('Upload response missing src');
    }

    results.value.unshift({
      id: `url_${Date.now()}`,
      fileName: urlInput.value.split('/').pop() || 'remote-file',
      link: toAbsoluteUrl(src),
    });

    urlInput.value = '';
  } catch (err) {
    error.value = humanizeError(err.message || 'URL upload failed');
  } finally {
    urlUploading.value = false;
  }
}

function formatSize(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
  }
}
</script>
